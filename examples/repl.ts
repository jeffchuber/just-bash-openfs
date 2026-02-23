/**
 * Interactive REPL over the multi-backend OpenFS filesystem.
 *
 * Boots the same environment as multi-backend-demo.ts (five backends,
 * pre-populated with sample data), then drops you into a shell prompt.
 *
 * Run:
 *   npx tsx examples/repl.ts
 */
import * as readline from "node:readline";
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OpenFs } from "../src/openfs.js";
import { createSearchCommand } from "../src/search.js";
import { createGrepCommand } from "../src/grep.js";
import { createMultiBackendMock, header } from "./_mock-backends.js";

async function main() {
	header("OpenFS Multi-Backend REPL");
	console.log("Five storage backends, one shell. Type 'help' for tips, 'exit' to quit.\n");

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

	// Seed sample data so there's something to explore
	const seeds: [string, string][] = [
		['/openfs/code/main.rs', 'fn main() {\n    println!("hello openfs");\n    authenticate();\n}'],
		['/openfs/code/lib.rs', 'pub fn authenticate() -> bool {\n    verify_token()\n}\npub fn verify_token() -> bool { true }'],
		['/openfs/docs/getting-started.md', '# Getting Started\nInstall openfs with: cargo install openfs\nRun openfs mount to begin.'],
		['/openfs/docs/api-reference.md', '# API Reference\n## openfs_read(path)\nReads a file from any backend.\n## openfs_search(query)\nSemantic search across indexed content.'],
		['/openfs/db/users.csv', 'id,name,role\n1,alice,admin\n2,bob,user\n3,carol,user'],
		['/openfs/db/events.csv', 'id,event,timestamp\n1,login,2025-06-15T10:00:00Z\n2,search,2025-06-15T10:05:00Z'],
		['/openfs/knowledge/auth-patterns.md', 'Authentication patterns: Use JWT tokens for stateless auth.\nAlways validate tokens server-side.\nRotate secrets every 90 days.'],
		['/openfs/knowledge/security-best-practices.md', 'Security best practices: Never store passwords in plaintext.\nUse bcrypt or argon2 for hashing.\nImplement rate limiting on login endpoints.'],
		['/openfs/scratch/temp.txt', 'work in progress...'],
	];
	for (const [path, content] of seeds) {
		await bash.exec(`cat > ${path} << 'SEED'\n${content}\nSEED`);
	}

	console.log("  Backends:");
	console.log("    /openfs/code/       Local fs      (Rust source)");
	console.log("    /openfs/docs/       S3            (Markdown — no append!)");
	console.log("    /openfs/db/         Postgres      (CSV — stat size = rows)");
	console.log("    /openfs/knowledge/  Chroma        (search only here)");
	console.log("    /openfs/scratch/    Memory        (ephemeral)\n");
	console.log("  Commands: search, openfsgrep, plus all standard shell builtins.\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const prompt = () => {
		if (process.stdin.isTTY) process.stdout.write("openfs$ ");
	};

	prompt();

	for await (const line of rl) {
		const cmd = line.trim();
		if (!cmd) {
			prompt();
			continue;
		}

		if (cmd === "exit" || cmd === "quit") {
			console.log("bye");
			break;
		}

		if (cmd === "help") {
			console.log("\n  Try these:");
			console.log("    ls /openfs                     — see all backends");
			console.log("    cat /openfs/code/main.rs           — read from local fs");
			console.log("    cat /openfs/db/users.csv | wc -l   — pipe Postgres through unix tools");
			console.log('    openfsgrep fn /                    — grep across all backends');
			console.log('    search "JWT tokens"            — semantic search (Chroma only)');
			console.log('    echo "x" >> /openfs/docs/file.md   — S3 append error');
			console.log("    stat /openfs/db/users.csv          — Postgres row-count size");
			console.log("    stat /openfs/code/main.rs          — local fs with mtime");
			console.log("    exit                           — quit\n");
			prompt();
			continue;
		}

		try {
			const result = await bash.exec(cmd);
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`error: ${msg}`);
		}

		prompt();
	}
}

main().catch((err) => {
	console.error("REPL failed:", err);
	process.exit(1);
});
