/**
 * End-to-end behavioral tests that mirror every just-bash-chroma demo.
 *
 * Each section replicates a specific demo from just-bash-chroma/examples/
 * using just-bash-openfs instead, verifying identical behavior and output.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Bash, InMemoryFs, MountableFs } from "just-bash";
import { OpenFs } from "../src/openfs.js";
import { createSearchCommand } from "../src/search.js";
import { createGrepCommand } from "../src/grep.js";
import { createMockOpenFsClient } from "./mock-openfs-client.js";
import type { Vfs } from "@open-fs/core";

// Helper: create an initialized OpenFs with mock client
async function createTestFs(): Promise<{
	openFs: OpenFs;
	client: Vfs;
}> {
	const client = createMockOpenFsClient();
	const openFs = new OpenFs();
	openFs.setVfs(client);
	await openFs.init();
	return { openFs, client };
}

// Helper: create a Bash instance with OpenFs mounted
async function createTestBash(mountPoint = "/openfs"): Promise<{
	bash: Bash;
	openFs: OpenFs;
	client: Vfs;
}> {
	const { openFs, client } = await createTestFs();
	const fs = new MountableFs({
		base: new InMemoryFs(),
		mounts: [{ mountPoint, filesystem: openFs }],
	});
	const bash = new Bash({
		fs,
		cwd: mountPoint,
		customCommands: [
			createSearchCommand(client),
			createGrepCommand(client, mountPoint),
		],
	});
	return { bash, openFs, client };
}

// Helper: run and capture
async function run(
	bash: Bash,
	cmd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return bash.exec(cmd);
}

// =====================================================================
// 1. BASIC CRUD CYCLE (mirrors demo.ts)
// =====================================================================

describe("basic CRUD cycle (demo.ts pattern)", () => {
	let bash: Bash;
	let openFs: OpenFs;

	beforeEach(async () => {
		({ bash, openFs } = await createTestBash("/openfs"));
	});

	it("creates a directory (collection)", async () => {
		const result = await run(bash, "mkdir /openfs/docs");
		expect(result.exitCode).toBe(0);
	});

	it("writes a file with echo", async () => {
		await run(bash, "mkdir /openfs/docs");
		const result = await run(
			bash,
			'echo "Rust focuses on safety and performance" > /openfs/docs/rust.md',
		);
		expect(result.exitCode).toBe(0);
	});

	it("reads back with cat", async () => {
		await run(bash, "mkdir /openfs/docs");
		await run(
			bash,
			'echo "Rust focuses on safety and performance" > /openfs/docs/rust.md',
		);
		const result = await run(bash, "cat /openfs/docs/rust.md");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Rust focuses on safety and performance",
		);
	});

	it("lists files with ls", async () => {
		await run(bash, "mkdir /openfs/docs");
		await run(bash, 'echo "content1" > /openfs/docs/rust.md');
		await run(bash, 'echo "content2" > /openfs/docs/go.md');
		const result = await run(bash, "ls /openfs/docs");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("rust.md");
		expect(result.stdout).toContain("go.md");
	});

	it("overwrites a file", async () => {
		await run(bash, "mkdir /openfs/docs");
		await run(bash, 'echo "original" > /openfs/docs/file.md');
		await run(bash, 'echo "updated" > /openfs/docs/file.md');
		const result = await run(bash, "cat /openfs/docs/file.md");
		expect(result.stdout).toContain("updated");
		expect(result.stdout).not.toContain("original");
	});

	it("deletes a file with rm", async () => {
		await run(bash, "mkdir /openfs/docs");
		await run(bash, 'echo "bye" > /openfs/docs/temp.md');
		await run(bash, "rm /openfs/docs/temp.md");
		const result = await run(bash, "cat /openfs/docs/temp.md");
		expect(result.exitCode).not.toBe(0);
	});

	it("deletes a directory with rm -r", async () => {
		await run(bash, "mkdir /openfs/docs");
		await run(bash, 'echo "data" > /openfs/docs/file.md');
		await run(bash, "rm -r /openfs/docs");
		const result = await run(bash, "ls /openfs/docs");
		// Should be empty or error
		expect(result.stdout.trim()).toBe("");
	});

	it("full CRUD cycle in sequence", async () => {
		// Create
		await run(bash, "mkdir /openfs/knowledge");

		// Write multiple files
		await run(
			bash,
			'echo "Machine learning uses statistical methods" > /openfs/knowledge/ml.md',
		);
		await run(
			bash,
			'echo "Deep learning uses neural networks" > /openfs/knowledge/dl.md',
		);
		await run(
			bash,
			'echo "Natural language processing handles text" > /openfs/knowledge/nlp.md',
		);

		// List
		const ls = await run(bash, "ls /openfs/knowledge");
		expect(ls.stdout).toContain("ml.md");
		expect(ls.stdout).toContain("dl.md");
		expect(ls.stdout).toContain("nlp.md");

		// Read
		const cat = await run(bash, "cat /openfs/knowledge/ml.md");
		expect(cat.stdout).toContain("Machine learning");

		// Update
		await run(
			bash,
			'echo "Updated ML content" > /openfs/knowledge/ml.md',
		);
		const updated = await run(bash, "cat /openfs/knowledge/ml.md");
		expect(updated.stdout).toContain("Updated ML content");

		// Delete one file
		await run(bash, "rm /openfs/knowledge/dl.md");
		const afterDelete = await run(bash, "ls /openfs/knowledge");
		expect(afterDelete.stdout).not.toContain("dl.md");
		expect(afterDelete.stdout).toContain("ml.md");

		// Delete entire collection
		await run(bash, "rm -r /openfs/knowledge");
	});
});

// =====================================================================
// 2. PIPING AND COMPOSITION (mirrors demo.ts + bash-script-automation.ts)
// =====================================================================

describe("piping and composition", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
		// Seed data
		await run(bash, "mkdir /openfs/docs");
		await run(
			bash,
			'echo "line one\nline two\nline three\nline four\nline five" > /openfs/docs/lines.txt',
		);
		await run(
			bash,
			'echo "hello world from test file" > /openfs/docs/hello.txt',
		);
	});

	it("cat | wc -l counts lines", async () => {
		const result = await run(bash, "cat /openfs/docs/lines.txt | wc -l");
		expect(result.exitCode).toBe(0);
		const count = Number.parseInt(result.stdout.trim(), 10);
		expect(count).toBe(5);
	});

	it("cat | wc -w counts words", async () => {
		const result = await run(bash, "cat /openfs/docs/hello.txt | wc -w");
		expect(result.exitCode).toBe(0);
		const count = Number.parseInt(result.stdout.trim(), 10);
		expect(count).toBe(5);
	});

	it("cat | head -N shows first N lines", async () => {
		const result = await run(bash, "cat /openfs/docs/lines.txt | head -3");
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("line one");
		expect(lines[2]).toBe("line three");
	});

	it("cat | tail -N shows last N lines", async () => {
		const result = await run(bash, "cat /openfs/docs/lines.txt | tail -2");
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("line four");
		expect(lines[1]).toBe("line five");
	});

	it("ls | sort sorts file listing", async () => {
		const result = await run(bash, "ls /openfs/docs | sort");
		expect(result.exitCode).toBe(0);
		const names = result.stdout.trim().split("\n");
		expect(names).toEqual([...names].sort());
	});

	it("ls | wc -l counts files", async () => {
		const result = await run(bash, "ls /openfs/docs | wc -l");
		expect(result.exitCode).toBe(0);
		expect(Number.parseInt(result.stdout.trim(), 10)).toBe(2);
	});

	it("echo into file with heredoc", async () => {
		await run(
			bash,
			`cat > /openfs/docs/heredoc.txt << 'EOF'
first line
second line
third line
EOF`,
		);
		const result = await run(bash, "cat /openfs/docs/heredoc.txt");
		expect(result.stdout).toContain("first line");
		expect(result.stdout).toContain("third line");
	});
});

// =====================================================================
// 3. GREP COMMAND (mirrors chroma-grep patterns)
// =====================================================================

describe("grep command via bash", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
		await run(bash, "mkdir /openfs/code");
		await run(
			bash,
			'echo "fn main() {\n    println!(\"hello\");\n}" > /openfs/code/main.rs',
		);
		await run(
			bash,
			'echo "pub mod utils;\npub mod auth;\npub mod db;" > /openfs/code/lib.rs',
		);
		await run(
			bash,
			'echo "pub fn connect() {\n    // database connection\n}" > /openfs/code/db.rs',
		);
	});

	it("finds pattern in files", async () => {
		// grep uses mount paths — transparently routes to server-side grep
		const result = await run(bash, "grep -r pub /openfs/code");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("pub");
	});

	it("shows line numbers with -n", async () => {
		const result = await run(bash, "grep -rn pub /openfs/code");
		expect(result.exitCode).toBe(0);
		// Should contain path:linenum:content format
		expect(result.stdout).toMatch(/\/openfs\/code\/[^:]+:\d+:.*pub/);
	});

	it("returns exit code 1 for no matches", async () => {
		const result = await run(bash, "grep -r nonexistent_pattern /openfs/code");
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
	});

	it("can be piped", async () => {
		const result = await run(
			bash,
			"grep -r pub /openfs/code | wc -l",
		);
		expect(result.exitCode).toBe(0);
		const count = Number.parseInt(result.stdout.trim(), 10);
		expect(count).toBeGreaterThan(0);
	});
});

// =====================================================================
// 4. SEARCH COMMAND (mirrors sgrep / semantic search patterns)
// =====================================================================

describe("search command via bash", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
		await run(bash, "mkdir /openfs/research");
		await run(
			bash,
			'echo "Neural networks learn patterns from data through training" > /openfs/research/neural.txt',
		);
		await run(
			bash,
			'echo "Database systems optimize query execution plans" > /openfs/research/database.txt',
		);
		await run(
			bash,
			'echo "Rust focuses on memory safety and zero-cost abstractions" > /openfs/research/rust.txt',
		);
	});

	it("finds semantically related documents", async () => {
		const result = await run(bash, "search 'neural networks'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("neural");
	});

	it("respects -n limit", async () => {
		const result = await run(bash, "search -n 1 'neural'");
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeLessThanOrEqual(1);
	});

	it("returns empty for no matches", async () => {
		const result = await run(
			bash,
			"search 'quantum_entanglement_xyz'",
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("");
	});

	it("formats output with score and path", async () => {
		const result = await run(bash, "search 'database query'");
		expect(result.exitCode).toBe(0);
		// Output format: [score] /path  snippet
		expect(result.stdout).toMatch(/\[\d+\.\d+\]/);
	});

	it("can be piped", async () => {
		const result = await run(
			bash,
			"search 'neural' | wc -l",
		);
		expect(result.exitCode).toBe(0);
	});
});

// =====================================================================
// 5. MULTI-COLLECTION PATTERN (mirrors multi-collection.ts)
// =====================================================================

describe("multi-collection pattern", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
	});

	it("creates multiple collections (dirs appear when they have files)", async () => {
		// In OpenFS, mkdir is a no-op — dirs are auto-created on write.
		// Dirs only show in ls when they contain files.
		await run(bash, 'echo "d" > /openfs/docs/placeholder.txt');
		await run(bash, 'echo "s" > /openfs/snippets/placeholder.txt');
		await run(bash, 'echo "c" > /openfs/changelogs/placeholder.txt');

		const result = await run(bash, "ls /openfs");
		expect(result.stdout).toContain("docs");
		expect(result.stdout).toContain("snippets");
		expect(result.stdout).toContain("changelogs");
	});

	it("populates and lists each collection", async () => {
		await run(bash, "mkdir /openfs/docs");
		await run(bash, "mkdir /openfs/snippets");

		await run(
			bash,
			'echo "React uses a virtual DOM" > /openfs/docs/react.md',
		);
		await run(
			bash,
			'echo "PostgreSQL supports JSON" > /openfs/docs/postgres.md',
		);
		await run(
			bash,
			'echo "const app = express();" > /openfs/snippets/express.js',
		);

		const docs = await run(bash, "ls /openfs/docs");
		expect(docs.stdout).toContain("react.md");
		expect(docs.stdout).toContain("postgres.md");

		const snippets = await run(bash, "ls /openfs/snippets");
		expect(snippets.stdout).toContain("express.js");
	});

	it("deletes one collection leaving others intact", async () => {
		await run(bash, "mkdir /openfs/docs");
		await run(bash, "mkdir /openfs/logs");
		await run(bash, 'echo "doc" > /openfs/docs/file.md');
		await run(bash, 'echo "log" > /openfs/logs/entry.txt');

		await run(bash, "rm -r /openfs/logs");

		const ls = await run(bash, "ls /openfs");
		expect(ls.stdout).toContain("docs");
		expect(ls.stdout).not.toContain("logs");

		// docs still accessible
		const cat = await run(bash, "cat /openfs/docs/file.md");
		expect(cat.stdout).toContain("doc");
	});
});

// =====================================================================
// 6. ERROR HANDLING (mirrors error-handling.ts)
// =====================================================================

describe("error handling", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
		await run(bash, "mkdir /openfs/notes");
		await run(bash, 'echo "Hello world" > /openfs/notes/greeting.txt');
	});

	it("ENOENT — file not found", async () => {
		const result = await run(bash, "cat /openfs/notes/nonexistent.txt");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toBeTruthy();
	});

	it("exit codes in conditionals", async () => {
		const exists = await run(
			bash,
			'cat /openfs/notes/greeting.txt > /dev/null 2>&1 && echo "exists" || echo "missing"',
		);
		expect(exists.stdout.trim()).toBe("exists");

		const missing = await run(
			bash,
			'cat /openfs/notes/gone.txt > /dev/null 2>&1 && echo "exists" || echo "missing"',
		);
		expect(missing.stdout).toContain("missing");
	});

	it("errors in pipelines", async () => {
		const result = await run(
			bash,
			"cat /openfs/notes/missing.txt 2>/dev/null | wc -l",
		);
		// wc -l should still run, getting empty stdin
		expect(result.stdout.trim()).toBe("0");
	});

	it("successful operations for contrast", async () => {
		const cat = await run(bash, "cat /openfs/notes/greeting.txt");
		expect(cat.exitCode).toBe(0);
		expect(cat.stdout).toContain("Hello world");

		const ls = await run(bash, "ls /openfs/notes");
		expect(ls.exitCode).toBe(0);
		expect(ls.stdout).toContain("greeting.txt");
	});

	it("overwrite and re-read", async () => {
		await run(bash, 'echo "Updated" > /openfs/notes/greeting.txt');
		const result = await run(bash, "cat /openfs/notes/greeting.txt");
		expect(result.stdout).toContain("Updated");
	});
});

// =====================================================================
// 7. COPY AND MOVE (mirrors filesystem operations)
// =====================================================================

describe("copy and move operations", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
		await run(bash, "mkdir /openfs/project");
		await run(
			bash,
			'echo "original content" > /openfs/project/readme.md',
		);
	});

	it("cp copies a file", async () => {
		await run(bash, "cp /openfs/project/readme.md /openfs/project/readme-backup.md");
		const original = await run(bash, "cat /openfs/project/readme.md");
		const backup = await run(bash, "cat /openfs/project/readme-backup.md");
		expect(original.stdout).toBe(backup.stdout);
	});

	it("mv moves a file", async () => {
		await run(bash, "mv /openfs/project/readme.md /openfs/project/moved.md");
		const moved = await run(bash, "cat /openfs/project/moved.md");
		expect(moved.stdout).toContain("original content");

		const original = await run(bash, "cat /openfs/project/readme.md");
		expect(original.exitCode).not.toBe(0);
	});

	it("cp then modify original leaves copy unchanged", async () => {
		await run(bash, "cp /openfs/project/readme.md /openfs/project/copy.md");
		await run(bash, 'echo "modified" > /openfs/project/readme.md');

		const original = await run(bash, "cat /openfs/project/readme.md");
		const copy = await run(bash, "cat /openfs/project/copy.md");
		expect(original.stdout).toContain("modified");
		expect(copy.stdout).toContain("original content");
	});
});

// =====================================================================
// 8. APPEND OPERATIONS
// =====================================================================

describe("append operations", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
		await run(bash, "mkdir /openfs/log");
	});

	it(">> appends to existing file", async () => {
		await run(bash, 'echo "line 1" > /openfs/log/app.log');
		await run(bash, 'echo "line 2" >> /openfs/log/app.log');
		await run(bash, 'echo "line 3" >> /openfs/log/app.log');

		const result = await run(bash, "cat /openfs/log/app.log");
		expect(result.stdout).toContain("line 1");
		expect(result.stdout).toContain("line 2");
		expect(result.stdout).toContain("line 3");
	});

	it(">> creates file if it does not exist", async () => {
		await run(bash, 'echo "first" >> /openfs/log/new.log');
		const result = await run(bash, "cat /openfs/log/new.log");
		expect(result.stdout).toContain("first");
	});

	it("append preserves existing content", async () => {
		await run(bash, 'echo "alpha" > /openfs/log/data.txt');
		await run(bash, 'echo "beta" >> /openfs/log/data.txt');
		const result = await run(bash, "cat /openfs/log/data.txt");
		expect(result.stdout).toContain("alpha");
		expect(result.stdout).toContain("beta");
	});
});

// =====================================================================
// 9. INLINE MULTI-LINE SCRIPTS (mirrors bash-script-automation.ts)
// =====================================================================

describe("multi-line scripts", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
	});

	it("runs setup script creating multiple files", async () => {
		const script = `
mkdir /openfs/articles
echo "TypeScript adds static typing" > /openfs/articles/typescript.txt
echo "React is a UI library" > /openfs/articles/react.txt
ls /openfs/articles
`;
		const result = await run(bash, script.trim());
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("typescript.txt");
		expect(result.stdout).toContain("react.txt");
	});

	it("counts files with wc", async () => {
		await run(bash, "mkdir /openfs/items");
		await run(bash, 'echo "a" > /openfs/items/a.txt');
		await run(bash, 'echo "b" > /openfs/items/b.txt');
		await run(bash, 'echo "c" > /openfs/items/c.txt');

		const result = await run(
			bash,
			"article_count=$(ls /openfs/items | wc -l); echo \"Items: $article_count\"",
		);
		expect(result.stdout.trim()).toBe("Items: 3");
	});

	it("for loop over files", async () => {
		await run(bash, "mkdir /openfs/data");
		await run(bash, 'echo "AAA" > /openfs/data/a.txt');
		await run(bash, 'echo "BBB" > /openfs/data/b.txt');

		const result = await run(
			bash,
			`for f in $(ls /openfs/data); do echo "file: $f"; done`,
		);
		expect(result.stdout).toContain("file: a.txt");
		expect(result.stdout).toContain("file: b.txt");
	});
});

// =====================================================================
// 10. OVERLAY FILESYSTEM (mirrors overlay-chromafs.ts)
// =====================================================================

describe("overlay filesystem (local + openfs)", () => {
	let bash: Bash;

	beforeEach(async () => {
		const { openFs, client } = await createTestFs();
		const fs = new MountableFs({
			base: new InMemoryFs({
				"/project/src/server.ts":
					"import express from 'express';\nconst app = express();\n",
				"/project/README.md": "# My Web App\nA cool project.\n",
			}),
			mounts: [{ mountPoint: "/index", filesystem: openFs }],
		});
		bash = new Bash({
			fs,
			cwd: "/project",
			customCommands: [
				createSearchCommand(client),
				createGrepCommand(client, "/index"),
			],
		});
	});

	it("reads local files normally", async () => {
		const result = await run(bash, "cat /project/README.md");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("My Web App");
	});

	it("reads mounted openfs files", async () => {
		await run(bash, "mkdir /index/code");
		await run(
			bash,
			'echo "indexed content" > /index/code/main.ts',
		);
		const result = await run(bash, "cat /index/code/main.ts");
		expect(result.stdout).toContain("indexed content");
	});

	it("local and mounted coexist", async () => {
		await run(bash, "mkdir /index/code");
		await run(
			bash,
			'echo "indexed" > /index/code/file.ts',
		);

		const local = await run(bash, "cat /project/src/server.ts");
		const indexed = await run(bash, "cat /index/code/file.ts");
		expect(local.stdout).toContain("express");
		expect(indexed.stdout).toContain("indexed");
	});

	it("can index local files into openfs", async () => {
		await run(bash, "mkdir /index/code");
		// Read local file, write to index
		const src = await run(bash, "cat /project/src/server.ts");
		await run(
			bash,
			`echo '${src.stdout.trim()}' > /index/code/server.ts`,
		);
		const indexed = await run(bash, "cat /index/code/server.ts");
		expect(indexed.stdout).toContain("express");
	});
});

// =====================================================================
// 11. PROGRAMMATIC + BASH MIXED ACCESS (mirrors programmatic-access.ts)
// =====================================================================

describe("programmatic + bash mixed access", () => {
	let bash: Bash;
	let openFs: OpenFs;

	beforeEach(async () => {
		({ bash, openFs } = await createTestBash("/openfs"));
	});

	it("writes via bash, reads via programmatic API", async () => {
		await run(bash, "mkdir /openfs/research");
		await run(
			bash,
			'echo "Neural networks learn patterns" > /openfs/research/neural.txt',
		);

		// Read directly via OpenFs
		const content = await openFs.readFile("/research/neural.txt");
		expect(content).toContain("Neural networks");
	});

	it("writes via API, reads via bash", async () => {
		await openFs.writeFile("/data/test.txt", "API written content");

		const result = await run(bash, "cat /openfs/data/test.txt");
		expect(result.stdout).toContain("API written content");
	});

	it("lists via bash after API writes", async () => {
		await openFs.writeFile("/mixed/a.txt", "aaa");
		await openFs.writeFile("/mixed/b.txt", "bbb");

		const result = await run(bash, "ls /openfs/mixed");
		expect(result.stdout).toContain("a.txt");
		expect(result.stdout).toContain("b.txt");
	});

	it("deletes via API, verified via bash", async () => {
		await openFs.writeFile("/temp/file.txt", "temp data");
		await openFs.rm("/temp/file.txt");

		const result = await run(bash, "cat /openfs/temp/file.txt");
		expect(result.exitCode).not.toBe(0);
	});
});

// =====================================================================
// 12. STAT AND EXISTS BEHAVIOR
// =====================================================================

describe("stat and exists behavior", () => {
	let bash: Bash;
	let openFs: OpenFs;

	beforeEach(async () => {
		({ bash, openFs } = await createTestBash("/openfs"));
		await run(bash, "mkdir /openfs/project");
		await run(bash, 'echo "test content" > /openfs/project/file.txt');
	});

	it("stat on file returns correct info", async () => {
		const stat = await openFs.stat("/project/file.txt");
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.isSymbolicLink).toBe(false);
		expect(stat.size).toBeGreaterThan(0);
	});

	it("stat on directory returns correct info", async () => {
		const stat = await openFs.stat("/project");
		expect(stat.isFile).toBe(false);
		expect(stat.isDirectory).toBe(true);
	});

	it("exists returns true for file", async () => {
		expect(await openFs.exists("/project/file.txt")).toBe(true);
	});

	it("exists returns true for directory", async () => {
		expect(await openFs.exists("/project")).toBe(true);
	});

	it("exists returns false for missing path", async () => {
		expect(await openFs.exists("/project/missing.txt")).toBe(false);
	});

	it("test -f in bash for file", async () => {
		const result = await run(
			bash,
			'test -f /openfs/project/file.txt && echo "is file" || echo "not file"',
		);
		expect(result.stdout.trim()).toBe("is file");
	});

	it("test -d in bash for directory", async () => {
		const result = await run(
			bash,
			'test -d /openfs/project && echo "is dir" || echo "not dir"',
		);
		expect(result.stdout.trim()).toBe("is dir");
	});
});

// =====================================================================
// 13. EDGE CASES
// =====================================================================

describe("edge cases", () => {
	let bash: Bash;
	let openFs: OpenFs;

	beforeEach(async () => {
		({ bash, openFs } = await createTestBash("/openfs"));
	});

	it("handles empty file", async () => {
		await openFs.writeFile("/empty.txt", "");
		const result = await run(bash, "cat /openfs/empty.txt");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("handles file with only newlines", async () => {
		await openFs.writeFile("/newlines.txt", "\n\n\n");
		const result = await run(bash, "cat /openfs/newlines.txt | wc -l");
		expect(Number.parseInt(result.stdout.trim(), 10)).toBe(3);
	});

	it("handles special characters in content", async () => {
		const content = 'var x = "hello"; // comment\n\ttab\n$variable';
		await openFs.writeFile("/special.txt", content);
		const result = await run(bash, "cat /openfs/special.txt");
		expect(result.stdout).toContain("var x");
	});

	it("deeply nested paths work", async () => {
		await openFs.writeFile("/a/b/c/d/e/deep.txt", "deep");
		const result = await run(bash, "cat /openfs/a/b/c/d/e/deep.txt");
		expect(result.stdout).toContain("deep");
	});

	it("unsupported operations don't crash bash", async () => {
		// chmod is a no-op
		const result = await run(bash, "chmod 777 /openfs/test.txt 2>&1");
		// Should not crash the shell
		expect(typeof result.exitCode).toBe("number");
	});
});

// =====================================================================
// 14. READDIR WITH FILE TYPES
// =====================================================================

describe("readdirWithFileTypes", () => {
	let openFs: OpenFs;

	beforeEach(async () => {
		({ openFs } = await createTestFs());
		await openFs.writeFile("/mixed/file.txt", "content");
		await openFs.writeFile("/mixed/sub/nested.txt", "nested");
	});

	it("returns correct types for files and dirs", async () => {
		const entries = await openFs.readdirWithFileTypes("/mixed");
		const file = entries.find((e) => e.name === "file.txt");
		const dir = entries.find((e) => e.name === "sub");

		expect(file?.isFile).toBe(true);
		expect(file?.isDirectory).toBe(false);
		expect(dir?.isFile).toBe(false);
		expect(dir?.isDirectory).toBe(true);
	});

	it("never returns symbolic links", async () => {
		const entries = await openFs.readdirWithFileTypes("/mixed");
		for (const e of entries) {
			expect(e.isSymbolicLink).toBe(false);
		}
	});
});

// =====================================================================
// 15. REAL PATH AND PATH RESOLUTION
// =====================================================================

describe("path resolution in bash context", () => {
	let bash: Bash;

	beforeEach(async () => {
		({ bash } = await createTestBash("/openfs"));
		await run(bash, "mkdir /openfs/src");
		await run(bash, 'echo "main content" > /openfs/src/main.rs');
	});

	it("relative cat from cwd", async () => {
		const result = await run(bash, "cat src/main.rs");
		expect(result.stdout).toContain("main content");
	});

	it("absolute path works", async () => {
		const result = await run(bash, "cat /openfs/src/main.rs");
		expect(result.stdout).toContain("main content");
	});
});
