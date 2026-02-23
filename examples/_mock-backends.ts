/**
 * Multi-backend mock of Vfs for demos.
 *
 * Partitions paths by prefix, each simulating a real OpenFS backend:
 *
 *   /code/       Local fs     — modified timestamps, full grep
 *   /docs/       S3           — no append (object storage), byte sizes
 *   /db/         Postgres     — stat size = row count (newlines)
 *   /knowledge/  Chroma       — only backend where search() returns results
 *   /scratch/    Memory       — ephemeral, everything works
 */
import type { Vfs, Entry, GrepMatch, SearchResult } from "@open-fs/core";
import { Bash } from "just-bash";

// ── types ──────────────────────────────────────────────────────────

export interface BackendMapping {
	prefix: string; // e.g. "/incidents"
	backend: "s3" | "postgres" | "chroma" | "memory" | "local";
}

// ── helpers ────────────────────────────────────────────────────────

function normalizePath(p: string): string {
	const parts = p.split("/").filter(Boolean);
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "..") resolved.pop();
		else if (part !== ".") resolved.push(part);
	}
	return `/${resolved.join("/")}`;
}

// ── configurable factory ───────────────────────────────────────────

export function createConfigurableMock(mappings: BackendMapping[]): Vfs {
	const files = new Map<string, string>();

	const topDirs = mappings.map((m) => {
		const p = m.prefix.startsWith("/") ? m.prefix : `/${m.prefix}`;
		return p.endsWith("/") ? p.slice(0, -1) : p;
	});

	const chromaPrefixes = mappings
		.filter((m) => m.backend === "chroma")
		.map((m) => {
			const p = m.prefix.startsWith("/") ? m.prefix : `/${m.prefix}`;
			return (p.endsWith("/") ? p.slice(0, -1) : p) + "/";
		});

	function backendFor(path: string): string {
		const norm = normalizePath(path);
		for (const m of mappings) {
			const p = m.prefix.startsWith("/") ? m.prefix : `/${m.prefix}`;
			const prefix = p.endsWith("/") ? p.slice(0, -1) : p;
			if (norm.startsWith(prefix + "/") || norm === prefix) return m.backend;
		}
		return "memory";
	}

	function isDir(path: string): boolean {
		const norm = normalizePath(path);
		if (norm === "/") return true;
		if (topDirs.includes(norm)) return true;
		const prefix = norm.endsWith("/") ? norm : `${norm}/`;
		for (const key of files.keys()) {
			if (key.startsWith(prefix)) return true;
		}
		return false;
	}

	function listDir(path: string): Entry[] {
		const norm = normalizePath(path);
		const prefix = norm === "/" ? "/" : `${norm}/`;
		const seen = new Set<string>();
		const entries: Entry[] = [];

		if (norm === "/") {
			for (const d of topDirs) {
				const name = d.slice(1);
				if (seen.has(name)) continue;
				seen.add(name);
				entries.push({
					path: d,
					name,
					is_dir: true,
					size: null,
					modified: null,
				});
			}
		}

		for (const key of files.keys()) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const slashIdx = rest.indexOf("/");
			const childName = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
			if (!childName || seen.has(childName)) continue;
			seen.add(childName);

			const childPath = `${prefix}${childName}`;
			const childIsDir = slashIdx !== -1 || isDir(childPath);
			if (childIsDir) {
				entries.push({
					path: normalizePath(childPath),
					name: childName,
					is_dir: true,
					size: null,
					modified: null,
				});
			} else {
				const content = files.get(key)!;
				const backend = backendFor(key);
				entries.push({
					path: normalizePath(childPath),
					name: childName,
					is_dir: false,
					size:
						backend === "postgres"
							? content.split("\n").filter(Boolean).length
							: content.length,
					modified:
						backend === "local" || backend === "s3"
							? "2025-06-15T10:30:00Z"
							: null,
				});
			}
		}

		return entries.sort((a, b) => a.name.localeCompare(b.name));
	}

	function makeStat(norm: string): Entry {
		if (norm === "/") {
			return {
				path: "/",
				name: "/",
				is_dir: true,
				size: null,
				modified: null,
			};
		}
		if (files.has(norm)) {
			const content = files.get(norm)!;
			const backend = backendFor(norm);
			return {
				path: norm,
				name: norm.split("/").pop()!,
				is_dir: false,
				size:
					backend === "postgres"
						? content.split("\n").filter(Boolean).length
						: content.length,
				modified:
					backend === "local" || backend === "s3"
						? "2025-06-15T10:30:00Z"
						: null,
			};
		}
		if (isDir(norm)) {
			return {
				path: norm,
				name: norm.split("/").pop()!,
				is_dir: true,
				size: null,
				modified:
					backendFor(norm) === "local"
						? "2025-06-15T10:30:00Z"
						: null,
			};
		}
		const err = new Error(`not found: ${norm}`);
		(err as any).code = "ENOENT";
		throw err;
	}

	const client: Vfs = {
		close: async () => {},

		read: async (path: string) => {
			const norm = normalizePath(path);
			if (isDir(norm) && !files.has(norm)) {
				const err = new Error(
					`illegal operation on a directory: ${norm}`,
				);
				(err as any).code = "EISDIR";
				throw err;
			}
			const content = files.get(norm);
			if (content === undefined) {
				const err = new Error(`not found: ${norm}`);
				(err as any).code = "ENOENT";
				throw err;
			}
			return content;
		},

		write: async (path: string, content: string) => {
			files.set(normalizePath(path), content);
		},

		append: async (path: string, content: string) => {
			const backend = backendFor(path);
			if (backend === "s3") {
				const err = new Error(
					"S3 backend does not support append — use write to replace the object",
				);
				(err as any).code = "ENOTSUP";
				throw err;
			}
			const norm = normalizePath(path);
			const existing = files.get(norm) ?? "";
			files.set(norm, existing + content);
		},

		list: async (path: string) => listDir(path),
		stat: async (path: string) => makeStat(normalizePath(path)),

		delete: async (path: string) => {
			const norm = normalizePath(path);
			files.delete(norm);
			const prefix = `${norm}/`;
			for (const key of [...files.keys()]) {
				if (key.startsWith(prefix)) files.delete(key);
			}
		},

		exists: async (path: string) => {
			const norm = normalizePath(path);
			if (norm === "/") return true;
			if (files.has(norm)) return true;
			return isDir(norm);
		},

		rename: async (from: string, to: string) => {
			const normFrom = normalizePath(from);
			const normTo = normalizePath(to);
			const content = files.get(normFrom);
			if (content !== undefined) {
				files.set(normTo, content);
				files.delete(normFrom);
			}
		},

		grep: async (pattern: string, path?: string) => {
			const re = new RegExp(pattern);
			const matches: GrepMatch[] = [];
			const searchPrefix = path ? normalizePath(path) : "/";

			for (const [filePath, content] of files) {
				if (
					!filePath.startsWith(searchPrefix) &&
					filePath !== searchPrefix
				)
					continue;
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (re.test(lines[i])) {
						matches.push({
							path: filePath,
							line_number: i + 1,
							line: lines[i],
						});
					}
				}
			}
			return matches;
		},

		search: async (query: string, limit?: number) => {
			const results: SearchResult[] = [];
			const words = query.toLowerCase().split(/\s+/);

			for (const [filePath, content] of files) {
				const isChroma = chromaPrefixes.some((cp) =>
					filePath.startsWith(cp),
				);
				if (!isChroma) continue;

				const lower = content.toLowerCase();
				let matchCount = 0;
				for (const word of words) {
					if (lower.includes(word)) matchCount++;
				}
				if (matchCount > 0) {
					const score = matchCount / words.length;
					const snippet =
						content.length > 80
							? `${content.slice(0, 80)}...`
							: content;
					results.push({
						score,
						source: filePath,
						snippet: snippet.replace(/\n/g, " "),
					});
				}
			}

			results.sort((a, b) => b.score - a.score);
			return results.slice(0, limit ?? 10);
		},
	};

	return client;
}

// ── original factory (thin wrapper) ────────────────────────────────

export function createMultiBackendMock(): Vfs {
	return createConfigurableMock([
		{ prefix: "/code", backend: "local" },
		{ prefix: "/docs", backend: "s3" },
		{ prefix: "/db", backend: "postgres" },
		{ prefix: "/knowledge", backend: "chroma" },
		{ prefix: "/scratch", backend: "memory" },
	]);
}

// ── ANSI colors ────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;

export const c = {
	reset: isTTY ? "\x1b[0m" : "",
	bold: isTTY ? "\x1b[1m" : "",
	dim: isTTY ? "\x1b[2m" : "",
	red: isTTY ? "\x1b[31m" : "",
	green: isTTY ? "\x1b[32m" : "",
	yellow: isTTY ? "\x1b[33m" : "",
	blue: isTTY ? "\x1b[34m" : "",
	magenta: isTTY ? "\x1b[35m" : "",
	cyan: isTTY ? "\x1b[36m" : "",
	white: isTTY ? "\x1b[37m" : "",
	gray: isTTY ? "\x1b[90m" : "",
};

// ── output helpers (matches just-bash-chroma examples style) ───────

export async function run(bash: Bash, cmd: string) {
	console.log(`  ${c.green}$${c.reset} ${c.bold}${cmd}${c.reset}`);
	const result = await bash.exec(cmd);
	if (result.stdout) {
		for (const line of result.stdout.split("\n")) {
			if (line) console.log(`  ${line}`);
		}
	}
	if (result.stderr) {
		for (const line of result.stderr.split("\n")) {
			if (line) console.log(`  ${c.red}(stderr) ${line}${c.reset}`);
		}
	}
	console.log();
	return result;
}

export function header(title: string) {
	console.log(`\n${c.dim}${"─".repeat(60)}${c.reset}`);
	console.log(`  ${c.bold}${c.cyan}${title}${c.reset}`);
	console.log(`${c.dim}${"─".repeat(60)}${c.reset}\n`);
}
