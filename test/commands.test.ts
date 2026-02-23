import { describe, it, expect, vi } from "vitest";
import { createSearchCommand } from "../src/search.js";
import { createGrepCommand } from "../src/grep.js";
import type { Vfs, GrepMatch, SearchResult } from "@open-fs/core";

function mockClient(overrides: Partial<Vfs> = {}): Vfs {
	return {
		close: vi.fn(),
		read: vi.fn(),
		write: vi.fn(),
		append: vi.fn(),
		list: vi.fn(),
		stat: vi.fn(),
		delete: vi.fn(),
		exists: vi.fn(),
		rename: vi.fn(),
		grep: vi.fn(async () => []),
		search: vi.fn(async () => []),
		...overrides,
	} as Vfs;
}

/** Minimal mock fs for the grep command context. */
function mockFs(files: Record<string, string> = {}) {
	return {
		readFile: vi.fn(async (path: string) => {
			if (path in files) return files[path];
			throw new Error(`not found: ${path}`);
		}),
		readdir: vi.fn(async (path: string) => {
			const prefix = path.endsWith("/") ? path : `${path}/`;
			const names = new Set<string>();
			for (const key of Object.keys(files)) {
				if (key.startsWith(prefix)) {
					const rest = key.slice(prefix.length);
					const name = rest.split("/")[0];
					if (name) names.add(name);
				}
			}
			return [...names];
		}),
		stat: vi.fn(async (path: string) => {
			if (path in files) {
				return { isFile: true, isDirectory: false };
			}
			// Check if it's a directory prefix
			const prefix = path.endsWith("/") ? path : `${path}/`;
			for (const key of Object.keys(files)) {
				if (key.startsWith(prefix)) {
					return { isFile: false, isDirectory: true };
				}
			}
			throw new Error(`not found: ${path}`);
		}),
		resolvePath: vi.fn((base: string, rel: string) => {
			if (rel.startsWith("/")) return rel;
			const b = base.endsWith("/") ? base : `${base}/`;
			return `${b}${rel}`;
		}),
	};
}

function grepCtx(
	overrides: {
		fs?: ReturnType<typeof mockFs>;
		cwd?: string;
		stdin?: string;
	} = {},
) {
	return {
		fs: overrides.fs ?? mockFs(),
		cwd: overrides.cwd ?? "/data",
		stdin: overrides.stdin ?? "",
	};
}

// =====================================================================
// search command
// =====================================================================

describe("search command", () => {
	it("returns formatted results", async () => {
		const client = mockClient({
			search: vi.fn(async () => [
				{ score: 0.95, source: "/docs/auth.md", snippet: "JWT auth flow" },
				{
					score: 0.82,
					source: "/docs/api.md",
					snippet: "REST endpoints",
				},
			] as SearchResult[]),
		});
		const cmd = createSearchCommand(client);
		const result = await cmd.execute(["auth tokens"], {});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("[0.9500] /docs/auth.md");
		expect(result.stdout).toContain("[0.8200] /docs/api.md");
	});

	it("passes limit with -n flag", async () => {
		const searchFn = vi.fn(async () => [] as SearchResult[]);
		const client = mockClient({ search: searchFn });
		const cmd = createSearchCommand(client);
		await cmd.execute(["-n", "5", "query"], {});

		expect(searchFn).toHaveBeenCalledWith("query", 5);
	});

	it("returns error for missing query", async () => {
		const cmd = createSearchCommand(mockClient());
		const result = await cmd.execute([], {});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("usage");
	});

	it("returns error for invalid limit", async () => {
		const cmd = createSearchCommand(mockClient());
		const result = await cmd.execute(["-n", "abc", "query"], {});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("invalid limit");
	});

	it("returns error for zero limit", async () => {
		const cmd = createSearchCommand(mockClient());
		const result = await cmd.execute(["-n", "0", "query"], {});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("invalid limit");
	});

	it("returns error for negative limit", async () => {
		const cmd = createSearchCommand(mockClient());
		const result = await cmd.execute(["-n", "-3", "query"], {});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("invalid limit");
	});

	it("returns empty stdout for no results", async () => {
		const cmd = createSearchCommand(mockClient());
		const result = await cmd.execute(["nothing"], {});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("handles -n at end of args (missing value)", async () => {
		const searchFn = vi.fn(async () => [] as SearchResult[]);
		const client = mockClient({ search: searchFn });
		const cmd = createSearchCommand(client);
		// -n is the last arg so the next arg is the query
		const result = await cmd.execute(["query", "-n"], {});
		// -n at the end means no value follows, so "query" becomes positional
		// This should still work — -n without a value is just treated as a query term
		expect(result.exitCode).toBe(0);
	});

	it("uses default limit of 10", async () => {
		const searchFn = vi.fn(async () => [] as SearchResult[]);
		const client = mockClient({ search: searchFn });
		const cmd = createSearchCommand(client);
		await cmd.execute(["my query"], {});
		expect(searchFn).toHaveBeenCalledWith("my query", 10);
	});

	it("handles client error gracefully", async () => {
		const client = mockClient({
			search: vi.fn(async () => {
				throw new Error("search engine not configured");
			}),
		});
		const cmd = createSearchCommand(client);
		const result = await cmd.execute(["query"], {});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("search engine not configured");
	});

	it("handles non-Error thrown values", async () => {
		const client = mockClient({
			search: vi.fn(async () => {
				throw "string error";
			}),
		});
		const cmd = createSearchCommand(client);
		const result = await cmd.execute(["query"], {});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("string error");
	});

	it("formats single result correctly", async () => {
		const client = mockClient({
			search: vi.fn(async () => [
				{ score: 1.0, source: "/perfect.txt", snippet: "exact match" },
			] as SearchResult[]),
		});
		const cmd = createSearchCommand(client);
		const result = await cmd.execute(["exact"], {});
		expect(result.stdout).toBe(
			"[1.0000] /perfect.txt  exact match\n",
		);
	});

	it("each result on its own line", async () => {
		const client = mockClient({
			search: vi.fn(async () => [
				{ score: 0.9, source: "/a.txt", snippet: "aaa" },
				{ score: 0.8, source: "/b.txt", snippet: "bbb" },
				{ score: 0.7, source: "/c.txt", snippet: "ccc" },
			] as SearchResult[]),
		});
		const cmd = createSearchCommand(client);
		const result = await cmd.execute(["test"], {});
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(3);
	});

	it("stdout ends with newline", async () => {
		const client = mockClient({
			search: vi.fn(async () => [
				{ score: 0.5, source: "/x.txt", snippet: "stuff" },
			] as SearchResult[]),
		});
		const cmd = createSearchCommand(client);
		const result = await cmd.execute(["stuff"], {});
		expect(result.stdout.endsWith("\n")).toBe(true);
	});

	it("handles query with spaces", async () => {
		const searchFn = vi.fn(async () => [] as SearchResult[]);
		const client = mockClient({ search: searchFn });
		const cmd = createSearchCommand(client);
		await cmd.execute(["multi word query"], {});
		expect(searchFn).toHaveBeenCalledWith("multi word query", 10);
	});

	it("handles -n before query", async () => {
		const searchFn = vi.fn(async () => [] as SearchResult[]);
		const client = mockClient({ search: searchFn });
		const cmd = createSearchCommand(client);
		await cmd.execute(["-n", "3", "my search"], {});
		expect(searchFn).toHaveBeenCalledWith("my search", 3);
	});

	it("returns stderr empty on success", async () => {
		const client = mockClient({
			search: vi.fn(async () => [
				{ score: 0.5, source: "/x.txt", snippet: "ok" },
			] as SearchResult[]),
		});
		const cmd = createSearchCommand(client);
		const result = await cmd.execute(["x"], {});
		expect(result.stderr).toBe("");
	});
});

// =====================================================================
// grep command (unified — server-side + local)
// =====================================================================

describe("grep command", () => {
	const MOUNT = "/data";

	it("returns formatted grep output (server-side)", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/src/main.rs", line_number: 10, line: "fn main() {" },
				{ path: "/src/lib.rs", line_number: 5, line: "pub mod lib;" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["main", "/data/src"], grepCtx());

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("/data/src/main.rs:fn main() {");
	});

	it("shows line numbers with -n (multi-file)", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/src/main.rs", line_number: 10, line: "fn main() {" },
				{ path: "/src/lib.rs", line_number: 3, line: "fn helper() {" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["-rn", "fn", "/data/src"], grepCtx());

		expect(result.stdout).toContain("/data/src/main.rs:10:fn main() {");
		expect(result.stdout).toContain("/data/src/lib.rs:3:fn helper() {");
	});

	it("shows line numbers with -n (single file)", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/f.txt", line_number: 42, line: "the line" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(
			["-n", "the", "/data/f.txt"],
			grepCtx(),
		);
		// Single file — no filename prefix
		expect(result.stdout).toBe("42:the line\n");
	});

	it("accepts -r flag (recursive)", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client, MOUNT);
		await cmd.execute(["-r", "pattern", "/data/src"], grepCtx());
		expect(grepFn).toHaveBeenCalled();
	});

	it("accepts --recursive flag", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client, MOUNT);
		await cmd.execute(["--recursive", "pat", "/data/dir"], grepCtx());
		expect(grepFn).toHaveBeenCalled();
	});

	it("returns exit code 1 for no matches", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(["pattern", "/data"], grepCtx());
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
	});

	it("returns error for missing pattern", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute([], grepCtx());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("usage");
	});

	it("returns error for unknown flag", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(["-z", "pattern"], grepCtx());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown option: -z");
	});

	it("returns error for unknown long flag", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(["--color", "pattern"], grepCtx());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown option: --color");
	});

	it("handles -- separator", async () => {
		const grepFn = vi.fn(async () => [
			{ path: "/-n", line_number: 1, line: "-n stuff" },
		] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(
			["--", "-n", "/data/path"],
			grepCtx(),
		);
		// After --, -n is treated as the pattern, /data/path as the path
		expect(grepFn).toHaveBeenCalledWith("-n", "/path");
		expect(result.exitCode).toBe(0);
	});

	it("passes path to server-side grep", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client, MOUNT);
		await cmd.execute(["pattern", "/data/specific/dir"], grepCtx());
		expect(grepFn).toHaveBeenCalledWith("pattern", "/specific/dir");
	});

	it("uses root path when searching mount root", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client, MOUNT);
		await cmd.execute(["pattern", "/data"], grepCtx());
		expect(grepFn).toHaveBeenCalledWith("pattern", "/");
	});

	it("combines -n and -r flags", async () => {
		const grepFn = vi.fn(async () => [
			{ path: "/a.txt", line_number: 5, line: "match" },
		] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(
			["-r", "-n", "pattern", "/data/dir"],
			grepCtx(),
		);
		expect(result.stdout).toContain("/data/a.txt:5:match");
	});

	it("handles client error gracefully", async () => {
		const client = mockClient({
			grep: vi.fn(async () => {
				throw new Error("connection lost");
			}),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["pattern", "/data"], grepCtx());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("connection lost");
	});

	it("handles non-Error thrown values", async () => {
		const client = mockClient({
			grep: vi.fn(async () => {
				throw "raw string";
			}),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["pattern", "/data"], grepCtx());
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("raw string");
	});

	it("formats multiple matches correctly", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/a.txt", line_number: 1, line: "first" },
				{ path: "/a.txt", line_number: 2, line: "second" },
				{ path: "/b.txt", line_number: 10, line: "third" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["pattern", "/data"], grepCtx());
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(3);
	});

	it("stdout ends with newline on match", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/x.txt", line_number: 1, line: "hit" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["hit", "/data"], grepCtx());
		expect(result.stdout.endsWith("\n")).toBe(true);
	});

	it("stderr empty on successful match", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/x.txt", line_number: 1, line: "hit" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["hit", "/data"], grepCtx());
		expect(result.stderr).toBe("");
	});

	it("stderr empty on no match (exit 1)", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(["nope", "/data"], grepCtx());
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
	});

	it("without -n does not include line numbers", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/f.txt", line_number: 99, line: "the content" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["the", "/data/f.txt"], grepCtx());
		// Single file — no filename prefix (standard grep behavior)
		expect(result.stdout).toBe("the content\n");
		expect(result.stdout).not.toContain("99");
	});

	it("handles empty line content in match", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/f.txt", line_number: 1, line: "" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(["x", "/data/f.txt"], grepCtx());
		// Single file, no filename prefix; server returned empty line
		expect(result.stdout).toBe("\n");
	});

	it("handles match with colons in content", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{
					path: "/config.yaml",
					line_number: 3,
					line: "host: localhost:8080",
				},
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(
			["-n", "host", "/data/config.yaml"],
			grepCtx(),
		);
		// Single file — no filename prefix
		expect(result.stdout).toBe("3:host: localhost:8080\n");
	});

	// ── Stdin grep tests ─────────────────────────────────────────────

	it("greps from stdin when no files given", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["hello"],
			grepCtx({ stdin: "hello world\ngoodbye world\nhello again\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello world\nhello again\n");
	});

	it("stdin grep with -i flag", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-i", "HELLO"],
			grepCtx({ stdin: "Hello World\ngoodbye\nhELLO\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Hello World\nhELLO\n");
	});

	it("stdin grep with -v flag (invert)", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-v", "hello"],
			grepCtx({ stdin: "hello\nworld\nhello again\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("world\n");
	});

	it("stdin grep with -c flag (count)", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-c", "hello"],
			grepCtx({ stdin: "hello\nworld\nhello again\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("2\n");
	});

	it("stdin grep with -n flag", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-n", "world"],
			grepCtx({ stdin: "hello\nworld\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("2:world\n");
	});

	// ── Local file grep tests ────────────────────────────────────────

	it("greps local files (non-OpenFS path)", async () => {
		const fs = mockFs({
			"/local/file.txt": "hello world\ngoodbye world\nhello again\n",
		});
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["hello", "/local/file.txt"],
			grepCtx({ fs }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello world");
		expect(result.stdout).toContain("hello again");
	});

	// ── Flag tests ───────────────────────────────────────────────────

	it("-E extended regexp works", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-E", "he(l)+o"],
			grepCtx({ stdin: "hello\nworld\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello\n");
	});

	it("-F fixed strings escapes regex metacharacters", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-F", "a.b"],
			grepCtx({ stdin: "a.b\naxb\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("a.b\n");
	});

	it("-w matches whole words only", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-w", "he"],
			grepCtx({ stdin: "he said hello\nshe is here\nhe\n" }),
		);
		expect(result.exitCode).toBe(0);
		// "he" as whole word should match "he said hello" and "he" but not "she" or "here"
		expect(result.stdout).toContain("he said hello");
		expect(result.stdout).toContain("he\n");
	});

	it("-o only matching parts", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-o", "[0-9]+"],
			grepCtx({ stdin: "abc 123 def 456\nno numbers\n789\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("123");
		expect(result.stdout).toContain("456");
		expect(result.stdout).toContain("789");
		expect(result.stdout).not.toContain("abc");
	});

	it("-q quiet mode returns exit code only", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const match = await cmd.execute(
			["-q", "hello"],
			grepCtx({ stdin: "hello world\n" }),
		);
		expect(match.exitCode).toBe(0);
		expect(match.stdout).toBe("");

		const noMatch = await cmd.execute(
			["-q", "missing"],
			grepCtx({ stdin: "hello world\n" }),
		);
		expect(noMatch.exitCode).toBe(1);
		expect(noMatch.stdout).toBe("");
	});

	it("-l lists files with matches", async () => {
		const fs = mockFs({
			"/local/a.txt": "hello world\n",
			"/local/b.txt": "goodbye world\n",
			"/local/c.txt": "hello again\n",
		});
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-rl", "hello", "/local"],
			grepCtx({ fs }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("/local/a.txt");
		expect(result.stdout).toContain("/local/c.txt");
		expect(result.stdout).not.toContain("/local/b.txt");
	});

	it("-m limits matches per file", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-m", "1", "hello"],
			grepCtx({ stdin: "hello one\nhello two\nhello three\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello one\n");
	});

	it("-e allows specifying pattern explicitly", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-e", "hello"],
			grepCtx({ stdin: "hello world\ngoodbye\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello world\n");
	});

	it("combined short flags -in work", async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		const result = await cmd.execute(
			["-in", "HELLO"],
			grepCtx({ stdin: "Hello World\ngoodbye\n" }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("1:Hello World\n");
	});

	// ── -v falls back to local for OpenFS paths ──────────────────────

	it("-v falls back to local grep for OpenFS paths", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const fs = mockFs({
			"/data/file.txt": "hello\nworld\nhello again\n",
		});
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client, MOUNT);
		const result = await cmd.execute(
			["-v", "hello", "/data/file.txt"],
			grepCtx({ fs }),
		);
		// Should NOT call server-side grep (because -v is incompatible)
		expect(grepFn).not.toHaveBeenCalled();
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("world\n");
	});

	// ── Command name ─────────────────────────────────────────────────

	it('command is named "grep"', async () => {
		const cmd = createGrepCommand(mockClient(), MOUNT);
		expect(cmd.name).toBe("grep");
	});
});
