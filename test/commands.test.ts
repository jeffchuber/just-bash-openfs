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
// openfsgrep command
// =====================================================================

describe("openfsgrep command", () => {
	it("returns formatted grep output", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/src/main.rs", line_number: 10, line: "fn main() {" },
				{ path: "/src/lib.rs", line_number: 5, line: "pub mod lib;" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["main"], {});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("/src/main.rs:fn main() {");
		expect(result.stdout).toContain("/src/lib.rs:pub mod lib;");
	});

	it("shows line numbers with -n", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/src/main.rs", line_number: 10, line: "fn main() {" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["-n", "main"], {});

		expect(result.stdout).toContain("/src/main.rs:10:fn main() {");
	});

	it("shows line numbers with --line-number", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/f.txt", line_number: 42, line: "the line" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["--line-number", "the"], {});
		expect(result.stdout).toContain("/f.txt:42:the line");
	});

	it("accepts -r flag silently (always recursive)", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client);
		await cmd.execute(["-r", "pattern", "/src"], {});
		expect(grepFn).toHaveBeenCalledWith("pattern", "/src");
	});

	it("accepts --recursive flag silently", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client);
		await cmd.execute(["--recursive", "pat", "/dir"], {});
		expect(grepFn).toHaveBeenCalledWith("pat", "/dir");
	});

	it("returns exit code 1 for no matches", async () => {
		const cmd = createGrepCommand(mockClient());
		const result = await cmd.execute(["pattern"], {});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
	});

	it("returns error for missing pattern", async () => {
		const cmd = createGrepCommand(mockClient());
		const result = await cmd.execute([], {});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("usage");
	});

	it("returns error for unknown flag", async () => {
		const cmd = createGrepCommand(mockClient());
		const result = await cmd.execute(["-z", "pattern"], {});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown option: -z");
	});

	it("returns error for unknown long flag", async () => {
		const cmd = createGrepCommand(mockClient());
		const result = await cmd.execute(["--color", "pattern"], {});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown option: --color");
	});

	it("handles -- separator", async () => {
		const grepFn = vi.fn(async () => [
			{ path: "/f.txt", line_number: 1, line: "-n stuff" },
		] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["--", "-n", "/path"], {});
		// After --, -n is treated as the pattern, /path as the path
		expect(grepFn).toHaveBeenCalledWith("-n", "/path");
		expect(result.exitCode).toBe(0);
	});

	it("passes path when provided", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client);
		await cmd.execute(["pattern", "/specific/dir"], {});
		expect(grepFn).toHaveBeenCalledWith("pattern", "/specific/dir");
	});

	it("omits path when not provided", async () => {
		const grepFn = vi.fn(async () => [] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client);
		await cmd.execute(["pattern"], {});
		expect(grepFn).toHaveBeenCalledWith("pattern", undefined);
	});

	it("combines -n and -r flags", async () => {
		const grepFn = vi.fn(async () => [
			{ path: "/a.txt", line_number: 5, line: "match" },
		] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(
			["-r", "-n", "pattern", "/dir"],
			{},
		);
		expect(result.stdout).toContain("/a.txt:5:match");
	});

	it("handles client error gracefully", async () => {
		const client = mockClient({
			grep: vi.fn(async () => {
				throw new Error("connection lost");
			}),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["pattern"], {});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("connection lost");
	});

	it("handles non-Error thrown values", async () => {
		const client = mockClient({
			grep: vi.fn(async () => {
				throw "raw string";
			}),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["pattern"], {});
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
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["pattern"], {});
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(3);
	});

	it("stdout ends with newline on match", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/x.txt", line_number: 1, line: "hit" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["hit"], {});
		expect(result.stdout.endsWith("\n")).toBe(true);
	});

	it("stderr empty on successful match", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/x.txt", line_number: 1, line: "hit" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["hit"], {});
		expect(result.stderr).toBe("");
	});

	it("stderr empty on no match (exit 1)", async () => {
		const cmd = createGrepCommand(mockClient());
		const result = await cmd.execute(["nope"], {});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
	});

	it("without -n does not include line numbers", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/f.txt", line_number: 99, line: "the content" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["the"], {});
		expect(result.stdout).toBe("/f.txt:the content\n");
		expect(result.stdout).not.toContain("99");
	});

	it("handles empty line content in match", async () => {
		const client = mockClient({
			grep: vi.fn(async () => [
				{ path: "/f.txt", line_number: 1, line: "" },
			] as GrepMatch[]),
		});
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["x"], {});
		expect(result.stdout).toBe("/f.txt:\n");
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
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["-n", "host"], {});
		expect(result.stdout).toBe(
			"/config.yaml:3:host: localhost:8080\n",
		);
	});

	it("-n after pattern is still parsed as a flag", async () => {
		// The grep command processes all flags regardless of position
		const grepFn = vi.fn(async () => [
			{ path: "/f.txt", line_number: 1, line: "hit" },
		] as GrepMatch[]);
		const client = mockClient({ grep: grepFn });
		const cmd = createGrepCommand(client);
		const result = await cmd.execute(["pattern", "-n"], {});
		// -n is treated as the line-number flag, not as a path
		expect(grepFn).toHaveBeenCalledWith("pattern", undefined);
		expect(result.stdout).toContain("/f.txt:1:hit");
	});
});
