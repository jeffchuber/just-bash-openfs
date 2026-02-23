/**
 * Multi-backend OpenFS demo
 *
 * Shows the point of OpenFS: different paths route to different storage backends
 * with backend-specific behaviors, all driven by standard shell commands.
 *
 * Run:
 *   npx tsx examples/multi-backend-demo.ts
 */
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OpenFs } from "../src/openfs.js";
import { createSearchCommand } from "../src/search.js";
import { createGrepCommand } from "../src/grep.js";
import { createMultiBackendMock, run, header } from "./_mock-backends.js";

async function main() {
	header("OpenFS Multi-Backend Demo");
	console.log("Five storage backends behind one unified filesystem.\n");

	const client = createMultiBackendMock();
	const openFs = new OpenFs();
	openFs.setVfs(client);
	await openFs.init();

	const fs = new MountableFs({
		base: new InMemoryFs(),
		mounts: [{ mountPoint: "/openfs", filesystem: openFs }],
	});

	const bash = new Bash({
		fs,
		cwd: "/openfs",
		customCommands: [
			createSearchCommand(client),
			createGrepCommand(client),
		],
	});

	// ── 1. Orientation ─────────────────────────────────────────────

	header("1. Orientation — five backends, one mount");
	console.log("  /openfs/code/       Local filesystem (Rust source)");
	console.log("  /openfs/docs/       S3 object storage (Markdown docs)");
	console.log("  /openfs/db/         Postgres (structured CSV data)");
	console.log("  /openfs/knowledge/  Chroma vector store (searchable docs)");
	console.log("  /openfs/scratch/    In-memory ephemeral workspace\n");
	await run(bash, "ls /openfs");

	// ── 2. Populate all backends ────────────────────────────────────

	header("2. Populate all backends");

	console.log("  Writing Rust source to /openfs/code/ (local fs):\n");
	await run(
		bash,
		'echo "fn main() {\n    println!(\"hello openfs\");\n    authenticate();\n}" > /openfs/code/main.rs',
	);
	await run(
		bash,
		'echo "pub fn authenticate() -> bool {\n    verify_token()\n}\npub fn verify_token() -> bool { true }" > /openfs/code/lib.rs',
	);

	console.log("  Writing docs to /openfs/docs/ (S3):\n");
	await run(
		bash,
		'echo "# Getting Started\nInstall openfs with: cargo install openfs\nRun openfs mount to begin." > /openfs/docs/getting-started.md',
	);
	await run(
		bash,
		'echo "# API Reference\n## openfs_read(path)\nReads a file from any backend.\n## openfs_search(query)\nSemantic search across indexed content." > /openfs/docs/api-reference.md',
	);

	console.log("  Writing structured data to /openfs/db/ (Postgres):\n");
	await run(
		bash,
		'echo "id,name,role\n1,alice,admin\n2,bob,user\n3,carol,user" > /openfs/db/users.csv',
	);
	await run(
		bash,
		'echo "id,event,timestamp\n1,login,2025-06-15T10:00:00Z\n2,search,2025-06-15T10:05:00Z" > /openfs/db/events.csv',
	);

	console.log(
		"  Writing knowledge base to /openfs/knowledge/ (Chroma vector store):\n",
	);
	await run(
		bash,
		'echo "Authentication patterns: Use JWT tokens for stateless auth.\nAlways validate tokens server-side.\nRotate secrets every 90 days." > /openfs/knowledge/auth-patterns.md',
	);
	await run(
		bash,
		'echo "Security best practices: Never store passwords in plaintext.\nUse bcrypt or argon2 for hashing.\nImplement rate limiting on login endpoints." > /openfs/knowledge/security-best-practices.md',
	);

	console.log("  Writing temp file to /openfs/scratch/ (memory):\n");
	await run(bash, 'echo "work in progress..." > /openfs/scratch/temp.txt');

	// ── 3. Read across backends ─────────────────────────────────────

	header("3. Read across backends — cat works uniformly");
	await run(bash, "cat /openfs/code/main.rs");
	await run(bash, "cat /openfs/docs/getting-started.md");
	await run(bash, "cat /openfs/db/users.csv");

	// ── 4. Grep across all backends ─────────────────────────────────

	header("4. Grep across all backends");
	console.log('  openfsgrep finds "fn" in code, and matches in other backends:\n');
	await run(bash, "openfsgrep fn /");

	// ── 5. Semantic search ──────────────────────────────────────────

	header("5. Semantic search — only /knowledge/ is indexed");
	console.log(
		"  search returns scored results only from the Chroma backend:\n",
	);
	await run(bash, 'search "how to authenticate users"');

	console.log("  Searching for something in /code/ returns nothing:\n");
	await run(bash, 'search "println hello"');

	// ── 6. ETL pipeline ─────────────────────────────────────────────

	header("6. ETL pipeline — Postgres through unix pipes");
	await run(bash, "cat /openfs/db/users.csv | head -3");
	await run(bash, "cat /openfs/db/users.csv | wc -l");

	// ── 7. Cross-backend workflow ───────────────────────────────────

	header("7. Cross-backend workflow");
	console.log(
		"  Read from /code/, extract info, write summary to /docs/:\n",
	);
	await run(
		bash,
		'echo "# Code Summary\nMain entry point calls authenticate().\nSee lib.rs for token verification." > /openfs/docs/code-summary.md',
	);
	await run(bash, "cat /openfs/docs/code-summary.md");

	// ── 8. S3 append error ──────────────────────────────────────────

	header("8. Backend-specific error — S3 does not support append");
	try {
		await run(bash, 'echo "extra line" >> /openfs/docs/getting-started.md');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  (error) ${msg}\n`);
	}

	// ── 9. Scratch workspace ────────────────────────────────────────

	header("9. Scratch workspace — ephemeral working area");
	await run(
		bash,
		'echo "intermediate result: 42" > /openfs/scratch/step1.txt',
	);
	await run(bash, "cat /openfs/scratch/step1.txt");
	await run(bash, "rm /openfs/scratch/step1.txt");
	await run(bash, "ls /openfs/scratch");

	// ── 10. Backend-specific stat ───────────────────────────────────

	header("10. Backend-specific stat metadata");
	console.log("  Local fs (/code/) — shows modified timestamp:\n");
	await run(bash, "stat /openfs/code/main.rs");

	console.log("  S3 (/docs/) — shows byte size and modified:\n");
	await run(bash, "stat /openfs/docs/getting-started.md");

	console.log("  Postgres (/db/) — size = row count:\n");
	await run(bash, "stat /openfs/db/users.csv");

	header("Demo complete!");
}

main().catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
