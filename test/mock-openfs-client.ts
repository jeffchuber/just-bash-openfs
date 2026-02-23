/**
 * In-memory mock of Vfs that behaves like a real OpenFS VFS.
 * Supports directories, files, grep (regex), and search (substring match).
 * Used to run Bash integration tests without a real OpenFS process.
 */
import { vi } from "vitest";
import type { Vfs, Entry, GrepMatch, SearchResult } from "@open-fs/core";

export function createMockOpenFsClient(): Vfs {
	// In-memory file storage
	const files = new Map<string, string>();

	function normalizePath(p: string): string {
		// Simple path normalization
		const parts = p.split("/").filter(Boolean);
		const resolved: string[] = [];
		for (const part of parts) {
			if (part === "..") resolved.pop();
			else if (part !== ".") resolved.push(part);
		}
		return `/${resolved.join("/")}`;
	}

	function isDir(path: string): boolean {
		const norm = normalizePath(path);
		if (norm === "/") return true;
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
				entries.push({
					path: normalizePath(childPath),
					name: childName,
					is_dir: false,
					size: content.length,
					modified: "2024-01-01T00:00:00Z",
				});
			}
		}

		return entries.sort((a, b) => a.name.localeCompare(b.name));
	}

	const client: Vfs = {
		close: vi.fn(async () => {}),

		read: vi.fn(async (path: string) => {
			const norm = normalizePath(path);
			if (isDir(norm) && !files.has(norm)) {
				const err = new Error(`illegal operation on a directory: ${norm}`);
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
		}),

		write: vi.fn(async (path: string, content: string) => {
			files.set(normalizePath(path), content);
		}),

		append: vi.fn(async (path: string, content: string) => {
			const norm = normalizePath(path);
			const existing = files.get(norm) ?? "";
			files.set(norm, existing + content);
		}),

		list: vi.fn(async (path: string) => {
			return listDir(path);
		}),

		stat: vi.fn(async (path: string) => {
			const norm = normalizePath(path);
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
				return {
					path: norm,
					name: norm.split("/").pop()!,
					is_dir: false,
					size: files.get(norm)!.length,
					modified: "2024-01-01T00:00:00Z",
				};
			}
			if (isDir(norm)) {
				return {
					path: norm,
					name: norm.split("/").pop()!,
					is_dir: true,
					size: null,
					modified: null,
				};
			}
			const err = new Error(`not found: ${norm}`);
			(err as any).code = "ENOENT";
			throw err;
		}),

		delete: vi.fn(async (path: string) => {
			const norm = normalizePath(path);
			// Delete the exact file
			files.delete(norm);
			// Also delete children (recursive)
			const prefix = `${norm}/`;
			for (const key of [...files.keys()]) {
				if (key.startsWith(prefix)) {
					files.delete(key);
				}
			}
		}),

		exists: vi.fn(async (path: string) => {
			const norm = normalizePath(path);
			if (norm === "/") return true;
			if (files.has(norm)) return true;
			return isDir(norm);
		}),

		rename: vi.fn(async (from: string, to: string) => {
			const normFrom = normalizePath(from);
			const normTo = normalizePath(to);
			const content = files.get(normFrom);
			if (content !== undefined) {
				files.set(normTo, content);
				files.delete(normFrom);
			}
		}),

		grep: vi.fn(async (pattern: string, path?: string) => {
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
		}),

		search: vi.fn(
			async (query: string, limit?: number) => {
				// Simple substring-distance search for testing
				const results: SearchResult[] = [];
				const words = query.toLowerCase().split(/\s+/);

				for (const [filePath, content] of files) {
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
		),
	};

	return client;
}
