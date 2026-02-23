/**
 * Side-by-side comparison tests.
 *
 * Runs the EXACT SAME bash commands through both just-bash-chroma (ChromaFs)
 * and just-bash-openfs (OpenFs), then asserts the outputs are identical.
 *
 * This is the definitive proof that just-bash-openfs produces the same behavior
 * as just-bash-chroma for every demo pattern.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Bash, InMemoryFs, MountableFs } from "just-bash";

// --- just-bash-chroma imports ---
import {
	ChromaFs,
	ChromaClient,
	createSemanticGrepCommand as createChromaSgrep,
	createGrepCommand as createChromaGrep,
} from "just-bash-chroma";

// --- just-bash-openfs imports ---
import { OpenFs } from "../src/openfs.js";
import { createSearchCommand as createOpenFsSearch } from "../src/search.js";
import { createGrepCommand as createOpenFsGrep } from "../src/grep.js";
import { createMockOpenFsClient } from "./mock-openfs-client.js";

// ---- Mock ChromaDB server (inline, adapted from _mock-server.ts) ----

function createMockChromaServer() {
	const collections = new Map<
		string,
		{
			col: {
				id: string;
				name: string;
				metadata: null;
				tenant: string;
				database: string;
			};
			docs: {
				ids: string[];
				embeddings: null;
				metadatas: (Record<string, unknown> | null)[];
				documents: (string | null)[];
			};
		}
	>();
	let idCounter = 0;
	const nextId = () => `mock-id-${++idCounter}`;

	const server = {
		handleRequest(
			url: string,
			method: string,
			body?: string,
		): { status: number; body: unknown } {
			const parsedUrl = new URL(url);
			const path = parsedUrl.pathname.replace(
				/\/api\/v\d+\/tenants\/[^/]+\/databases\/[^/]+/,
				"",
			);

			if (method === "GET" && path === "/collections") {
				return {
					status: 200,
					body: [...collections.values()].map((c) => c.col),
				};
			}

			if (method === "POST" && path === "/collections") {
				const req = JSON.parse(body!);
				if (collections.has(req.name) && !req.get_or_create) {
					return { status: 409, body: { error: "already exists" } };
				}
				const col = {
					id: nextId(),
					name: req.name,
					metadata: null as null,
					tenant: "default_tenant",
					database: "default_database",
				};
				if (!collections.has(req.name)) {
					collections.set(req.name, {
						col,
						docs: {
							ids: [],
							embeddings: null,
							metadatas: [],
							documents: [],
						},
					});
				}
				return {
					status: 200,
					body: collections.get(req.name)!.col,
				};
			}

			const getColMatch = path.match(/^\/collections\/([^/]+)$/);
			if (method === "GET" && getColMatch) {
				const name = decodeURIComponent(getColMatch[1]);
				const entry = collections.get(name);
				if (!entry)
					return { status: 404, body: { error: "not found" } };
				return { status: 200, body: entry.col };
			}

			if (method === "DELETE" && getColMatch) {
				const name = decodeURIComponent(getColMatch[1]);
				collections.delete(name);
				return { status: 200, body: null };
			}

			const colIdMatch = path.match(
				/^\/collections\/([^/]+)\/(.+)$/,
			);
			if (colIdMatch) {
				const colId = decodeURIComponent(colIdMatch[1]);
				const action = colIdMatch[2];
				const entry = [...collections.values()].find(
					(c) => c.col.id === colId || c.col.name === colId,
				);
				if (!entry)
					return { status: 404, body: { error: "not found" } };
				const docs = entry.docs;

				if (method === "GET" && action === "count") {
					return { status: 200, body: docs.ids.length };
				}

				if (method === "POST" && action === "get") {
					const req = JSON.parse(body!);
					// Handle where: { path: "..." } or { path: { $in: [...] } }
					if (req.where?.path) {
						const pathFilter = req.where.path;
						const matchPaths: string[] =
							typeof pathFilter === "string"
								? [pathFilter]
								: pathFilter.$in ?? [];
						const filtered = {
							ids: [] as string[],
							embeddings: null,
							metadatas: [] as (Record<string, unknown> | null)[],
							documents: [] as (string | null)[],
						};
						const offset = req.offset ?? 0;
						const limit = req.limit ?? 300;
						let count = 0;
						for (let i = 0; i < docs.ids.length; i++) {
							const meta = docs.metadatas[i] as Record<string, unknown> | null;
							if (meta && matchPaths.includes(meta.path as string)) {
								if (count >= offset && filtered.ids.length < limit) {
									filtered.ids.push(docs.ids[i]);
									filtered.metadatas.push(docs.metadatas[i]);
									filtered.documents.push(docs.documents[i]);
								}
								count++;
							}
						}
						return { status: 200, body: filtered };
					}
					if (req.ids) {
						const filtered = {
							ids: [] as string[],
							embeddings: null,
							metadatas: [] as (Record<string, unknown> | null)[],
							documents: [] as (string | null)[],
						};
						for (let i = 0; i < docs.ids.length; i++) {
							if (req.ids.includes(docs.ids[i])) {
								filtered.ids.push(docs.ids[i]);
								filtered.metadatas.push(docs.metadatas[i]);
								filtered.documents.push(docs.documents[i]);
							}
						}
						return { status: 200, body: filtered };
					}
					const offset = req.offset ?? 0;
					const limit = req.limit ?? 300;
					return {
						status: 200,
						body: {
							ids: docs.ids.slice(offset, offset + limit),
							embeddings: null,
							metadatas: docs.metadatas.slice(
								offset,
								offset + limit,
							),
							documents: docs.documents.slice(
								offset,
								offset + limit,
							),
						},
					};
				}

				if (method === "POST" && action === "upsert") {
					const req = JSON.parse(body!);
					for (let i = 0; i < req.ids.length; i++) {
						const existing = docs.ids.indexOf(req.ids[i]);
						if (existing >= 0) {
							docs.metadatas[existing] =
								req.metadatas?.[i] ?? null;
							docs.documents[existing] =
								req.documents?.[i] ?? null;
						} else {
							docs.ids.push(req.ids[i]);
							docs.metadatas.push(req.metadatas?.[i] ?? null);
							docs.documents.push(req.documents?.[i] ?? null);
						}
					}
					return { status: 200, body: true };
				}

				if (method === "POST" && action === "delete") {
					const req = JSON.parse(body!);
					if (req.ids) {
						for (const id of req.ids) {
							const idx = docs.ids.indexOf(id);
							if (idx >= 0) {
								docs.ids.splice(idx, 1);
								docs.metadatas.splice(idx, 1);
								docs.documents.splice(idx, 1);
							}
						}
					}
					return { status: 200, body: null };
				}

				if (method === "POST" && action === "query") {
					const req = JSON.parse(body!);
					const n = req.n_results ?? 5;
					const ids = docs.ids.slice(0, n);
					const metas = docs.metadatas.slice(0, n);
					const docTexts = docs.documents.slice(0, n);
					const distances = ids.map(
						(_: unknown, i: number) => i * 0.1 + 0.05,
					);
					return {
						status: 200,
						body: {
							ids: [ids],
							distances: [distances],
							metadatas: [metas],
							documents: [docTexts],
						},
					};
				}
			}

			return {
				status: 404,
				body: { error: `unknown route: ${method} ${path}` },
			};
		},
	};

	const mockFetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url =
			typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const body = init?.body as string | undefined;
		const result = server.handleRequest(url, method, body);
		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			text: async () =>
				result.body === null || result.body === undefined
					? ""
					: JSON.stringify(result.body),
		} as Response;
	};

	return mockFetch;
}

async function createMockChromaFs() {
	const mockFetch = createMockChromaServer();
	const chromaFs = new ChromaFs({ url: "http://mock:8000" });
	(chromaFs.client as any).fetchFn = mockFetch;
	await chromaFs.init();
	return chromaFs;
}

// ---- Factories ----

async function makeChromaBash(mountPoint: string) {
	const chromaFs = await createMockChromaFs();
	const fs = new MountableFs({
		base: new InMemoryFs(),
		mounts: [{ mountPoint, filesystem: chromaFs }],
	});
	return new Bash({
		fs,
		cwd: mountPoint,
		customCommands: [createChromaGrep(chromaFs.client)],
	});
}

async function makeOpenFsBash(mountPoint: string) {
	const client = createMockOpenFsClient();
	const openFs = new OpenFs();
	openFs.setVfs(client);
	await openFs.init();
	const fs = new MountableFs({
		base: new InMemoryFs(),
		mounts: [{ mountPoint, filesystem: openFs }],
	});
	return new Bash({
		fs,
		cwd: mountPoint,
		customCommands: [createOpenFsGrep(client, mountPoint)],
	});
}

// ---- Helpers ----

/** Normalize output for comparison: trim, collapse whitespace variations */
function norm(s: string): string {
	return s
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")
		.trim();
}

// =====================================================================
// Side-by-side: run exact same commands through both backends
// =====================================================================

describe("side-by-side: ChromaFs vs OpenFs produce identical IFileSystem behavior", () => {
	let chromaBash: Bash;
	let openfsBash: Bash;

	beforeEach(async () => {
		chromaBash = await makeChromaBash("/vfs");
		openfsBash = await makeOpenFsBash("/vfs");
	});

	// ------------------------------------------------------------------
	// DEMO: mock-demo.ts pattern — full CRUD cycle
	// ------------------------------------------------------------------

	describe("mock-demo.ts: full CRUD cycle", () => {
		async function seedBoth() {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/knowledge");
				await bash.exec(
					"echo 'Photosynthesis converts sunlight into chemical energy in plants.' > /vfs/knowledge/biology.txt",
				);
				await bash.exec(
					"echo 'The speed of light is approximately 299792458 meters per second.' > /vfs/knowledge/physics.txt",
				);
				await bash.exec(
					"echo 'JavaScript was created by Brendan Eich in 1995.' > /vfs/knowledge/javascript.txt",
				);
				await bash.exec(
					"echo 'Python was created by Guido van Rossum in 1991.' > /vfs/knowledge/python.txt",
				);
			}
		}

		it("ls lists the same files in same order", async () => {
			await seedBoth();
			const chromaLs = await chromaBash.exec("ls /vfs/knowledge");
			const openfsLs = await openfsBash.exec("ls /vfs/knowledge");
			expect(norm(openfsLs.stdout)).toBe(norm(chromaLs.stdout));
			expect(openfsLs.exitCode).toBe(chromaLs.exitCode);
		});

		it("cat returns identical content", async () => {
			await seedBoth();
			const chromaCat = await chromaBash.exec(
				"cat /vfs/knowledge/physics.txt",
			);
			const openfsCat = await openfsBash.exec("cat /vfs/knowledge/physics.txt");
			expect(norm(openfsCat.stdout)).toBe(norm(chromaCat.stdout));
			expect(openfsCat.exitCode).toBe(chromaCat.exitCode);
		});

		it("cat | wc -w returns same word count", async () => {
			await seedBoth();
			const chromaWc = await chromaBash.exec(
				"cat /vfs/knowledge/biology.txt | wc -w",
			);
			const openfsWc = await openfsBash.exec(
				"cat /vfs/knowledge/biology.txt | wc -w",
			);
			expect(norm(openfsWc.stdout)).toBe(norm(chromaWc.stdout));
		});

		it("ls | sort returns same sorted listing", async () => {
			await seedBoth();
			const chromaSort = await chromaBash.exec("ls /vfs/knowledge | sort");
			const openfsSort = await openfsBash.exec("ls /vfs/knowledge | sort");
			expect(norm(openfsSort.stdout)).toBe(norm(chromaSort.stdout));
		});

		it("overwrite + cat returns same updated content", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec(
					"echo 'JavaScript ES2024 is the language of the web.' > /vfs/knowledge/javascript.txt",
				);
			}
			const chromaCat = await chromaBash.exec(
				"cat /vfs/knowledge/javascript.txt",
			);
			const openfsCat = await openfsBash.exec(
				"cat /vfs/knowledge/javascript.txt",
			);
			expect(norm(openfsCat.stdout)).toBe(norm(chromaCat.stdout));
		});

		it("rm + ls shows same remaining files", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("rm /vfs/knowledge/python.txt");
			}
			const chromaLs = await chromaBash.exec("ls /vfs/knowledge");
			const openfsLs = await openfsBash.exec("ls /vfs/knowledge");
			expect(norm(openfsLs.stdout)).toBe(norm(chromaLs.stdout));
		});

		it("rm -r then ls shows same empty state", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("rm -r /vfs/knowledge");
			}
			const chromaLs = await chromaBash.exec("ls /vfs");
			const openfsLs = await openfsBash.exec("ls /vfs");
			expect(norm(openfsLs.stdout)).toBe(norm(chromaLs.stdout));
		});
	});

	// ------------------------------------------------------------------
	// DEMO: error-handling.ts — error codes and conditionals
	// ------------------------------------------------------------------

	describe("error-handling.ts: POSIX error behavior", () => {
		async function seedBoth() {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/notes");
				await bash.exec(
					"echo 'Hello world' > /vfs/notes/greeting.txt",
				);
			}
		}

		it("ENOENT: cat nonexistent file same exit code", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				"cat /vfs/notes/nonexistent.txt",
			);
			const ax = await openfsBash.exec("cat /vfs/notes/nonexistent.txt");
			expect(ax.exitCode).toBe(chroma.exitCode);
			expect(ax.exitCode).not.toBe(0);
		});

		it("conditional: existing file says 'File exists'", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				'cat /vfs/notes/greeting.txt > /dev/null 2>&1 && echo "File exists" || echo "File not found"',
			);
			const ax = await openfsBash.exec(
				'cat /vfs/notes/greeting.txt > /dev/null 2>&1 && echo "File exists" || echo "File not found"',
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
			expect(norm(ax.stdout)).toBe("File exists");
		});

		it("conditional: missing file says 'File not found'", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				'cat /vfs/notes/missing.txt > /dev/null 2>&1 && echo "File exists" || echo "File not found"',
			);
			const ax = await openfsBash.exec(
				'cat /vfs/notes/missing.txt > /dev/null 2>&1 && echo "File exists" || echo "File not found"',
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
			expect(ax.stdout).toContain("File not found");
		});

		it("pipeline error: cat missing | wc -l same output", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				"cat /vfs/notes/missing.txt 2>/dev/null | wc -l",
			);
			const ax = await openfsBash.exec(
				"cat /vfs/notes/missing.txt 2>/dev/null | wc -l",
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("successful cat returns same content", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				"cat /vfs/notes/greeting.txt",
			);
			const ax = await openfsBash.exec("cat /vfs/notes/greeting.txt");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("overwrite then cat returns same updated content", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec(
					"echo 'Updated content' > /vfs/notes/greeting.txt",
				);
			}
			const chroma = await chromaBash.exec(
				"cat /vfs/notes/greeting.txt",
			);
			const ax = await openfsBash.exec("cat /vfs/notes/greeting.txt");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});
	});

	// ------------------------------------------------------------------
	// DEMO: multi-collection.ts — multiple dirs, CRUD, deletion
	// ------------------------------------------------------------------

	describe("multi-collection.ts: independent collections", () => {
		async function seedBoth() {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/docs");
				await bash.exec("mkdir /vfs/snippets");
				await bash.exec("mkdir /vfs/changelogs");
				await bash.exec(
					"echo 'React uses a virtual DOM for efficient rendering.' > /vfs/docs/react.md",
				);
				await bash.exec(
					"echo 'PostgreSQL supports JSON columns.' > /vfs/docs/postgres.md",
				);
				await bash.exec(
					"echo 'const app = express();' > /vfs/snippets/express.js",
				);
				await bash.exec(
					"echo 'v2.0: Added JWT authentication.' > /vfs/changelogs/v2.0.txt",
				);
			}
		}

		it("ls collection returns same files", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec("ls /vfs/docs");
			const ax = await openfsBash.exec("ls /vfs/docs");
			expect(norm(openfsBash ? ax.stdout : "")).toBe(
				norm(chroma.stdout),
			);
		});

		it("cat across collections returns same content", async () => {
			await seedBoth();
			for (const path of [
				"/vfs/docs/react.md",
				"/vfs/snippets/express.js",
				"/vfs/changelogs/v2.0.txt",
			]) {
				const chroma = await chromaBash.exec(`cat ${path}`);
				const ax = await openfsBash.exec(`cat ${path}`);
				expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
			}
		});

		it("rm -r one collection, ls shows same remaining", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("rm -r /vfs/changelogs");
			}
			const chromaLs = await chromaBash.exec("ls /vfs");
			const openfsLs = await openfsBash.exec("ls /vfs");
			expect(norm(openfsLs.stdout)).toBe(norm(chromaLs.stdout));
		});

		it("surviving collection still readable", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("rm -r /vfs/changelogs");
			}
			const chroma = await chromaBash.exec("cat /vfs/docs/react.md");
			const ax = await openfsBash.exec("cat /vfs/docs/react.md");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});
	});

	// ------------------------------------------------------------------
	// Piping & composition
	// ------------------------------------------------------------------

	describe("piping and composition", () => {
		async function seedBoth() {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/data");
				await bash.exec(
					"echo 'line one\nline two\nline three\nline four\nline five' > /vfs/data/lines.txt",
				);
				await bash.exec(
					"echo 'hello world from test' > /vfs/data/hello.txt",
				);
			}
		}

		it("cat | wc -l same line count", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				"cat /vfs/data/lines.txt | wc -l",
			);
			const ax = await openfsBash.exec("cat /vfs/data/lines.txt | wc -l");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("cat | wc -w same word count", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				"cat /vfs/data/hello.txt | wc -w",
			);
			const ax = await openfsBash.exec("cat /vfs/data/hello.txt | wc -w");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("cat | head -3 same output", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				"cat /vfs/data/lines.txt | head -3",
			);
			const ax = await openfsBash.exec(
				"cat /vfs/data/lines.txt | head -3",
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("cat | tail -2 same output", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				"cat /vfs/data/lines.txt | tail -2",
			);
			const ax = await openfsBash.exec(
				"cat /vfs/data/lines.txt | tail -2",
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("ls | sort same output", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec("ls /vfs/data | sort");
			const ax = await openfsBash.exec("ls /vfs/data | sort");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("ls | wc -l same file count", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec("ls /vfs/data | wc -l");
			const ax = await openfsBash.exec("ls /vfs/data | wc -l");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("heredoc write + cat same output", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/tmp");
				await bash.exec(`cat > /vfs/tmp/heredoc.txt << 'EOF'
first line
second line
third line
EOF`);
			}
			const chroma = await chromaBash.exec("cat /vfs/tmp/heredoc.txt");
			const ax = await openfsBash.exec("cat /vfs/tmp/heredoc.txt");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});
	});

	// ------------------------------------------------------------------
	// Copy and move
	// ------------------------------------------------------------------

	describe("copy and move operations", () => {
		async function seedBoth() {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/project");
				await bash.exec(
					"echo 'original content here' > /vfs/project/readme.md",
				);
			}
		}

		it("cp produces same copy", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec(
					"cp /vfs/project/readme.md /vfs/project/backup.md",
				);
			}
			const chroma = await chromaBash.exec(
				"cat /vfs/project/backup.md",
			);
			const ax = await openfsBash.exec("cat /vfs/project/backup.md");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("mv moves to same destination", async () => {
			await seedBoth();
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec(
					"mv /vfs/project/readme.md /vfs/project/moved.md",
				);
			}
			const chromaCat = await chromaBash.exec(
				"cat /vfs/project/moved.md",
			);
			const openfsCat = await openfsBash.exec("cat /vfs/project/moved.md");
			expect(norm(openfsCat.stdout)).toBe(norm(chromaCat.stdout));

			// Original gone in both
			const chromaOld = await chromaBash.exec(
				"cat /vfs/project/readme.md",
			);
			const openfsOld = await openfsBash.exec("cat /vfs/project/readme.md");
			expect(openfsOld.exitCode).toBe(chromaOld.exitCode);
			expect(openfsOld.exitCode).not.toBe(0);
		});
	});

	// ------------------------------------------------------------------
	// Append operations
	// ------------------------------------------------------------------

	describe("append operations", () => {
		it(">> appends identically", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/log");
				await bash.exec("echo 'line 1' > /vfs/log/app.log");
				await bash.exec("echo 'line 2' >> /vfs/log/app.log");
				await bash.exec("echo 'line 3' >> /vfs/log/app.log");
			}
			const chroma = await chromaBash.exec("cat /vfs/log/app.log");
			const ax = await openfsBash.exec("cat /vfs/log/app.log");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it(">> to new file same as fresh write", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/log");
				await bash.exec("echo 'first' >> /vfs/log/new.log");
			}
			const chroma = await chromaBash.exec("cat /vfs/log/new.log");
			const ax = await openfsBash.exec("cat /vfs/log/new.log");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});
	});

	// ------------------------------------------------------------------
	// Multi-line scripts (bash-script-automation.ts)
	// ------------------------------------------------------------------

	describe("multi-line scripts", () => {
		it("inline script creates files and lists them identically", async () => {
			const script = `
mkdir /vfs/articles
echo "TypeScript adds static typing" > /vfs/articles/typescript.txt
echo "React is a UI library" > /vfs/articles/react.txt
ls /vfs/articles
`;
			const chroma = await chromaBash.exec(script.trim());
			const ax = await openfsBash.exec(script.trim());
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
			expect(ax.exitCode).toBe(chroma.exitCode);
		});

		it("variable + wc same count", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/items");
				await bash.exec("echo 'a' > /vfs/items/a.txt");
				await bash.exec("echo 'b' > /vfs/items/b.txt");
				await bash.exec("echo 'c' > /vfs/items/c.txt");
			}
			const cmd =
				'count=$(ls /vfs/items | wc -l); echo "Items: $count"';
			const chroma = await chromaBash.exec(cmd);
			const ax = await openfsBash.exec(cmd);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("for loop over ls same output", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/data");
				await bash.exec("echo 'AAA' > /vfs/data/a.txt");
				await bash.exec("echo 'BBB' > /vfs/data/b.txt");
			}
			const cmd = `for f in $(ls /vfs/data); do echo "file: $f"; done`;
			const chroma = await chromaBash.exec(cmd);
			const ax = await openfsBash.exec(cmd);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});
	});

	// ------------------------------------------------------------------
	// Overlay filesystem (overlay-chromafs.ts pattern)
	// ------------------------------------------------------------------

	describe("overlay filesystem: local + VFS", () => {
		let chromaOverlay: Bash;
		let openfsOverlay: Bash;

		beforeEach(async () => {
			const localFiles = {
				"/project/src/server.ts":
					"import express from 'express';\nconst app = express();\n",
				"/project/README.md": "# My Web App\nA cool project.\n",
			};

			const chromaFs = await createMockChromaFs();
			chromaOverlay = new Bash({
				fs: new MountableFs({
					base: new InMemoryFs(localFiles),
					mounts: [
						{ mountPoint: "/index", filesystem: chromaFs },
					],
				}),
				cwd: "/project",
				customCommands: [],
			});

			const openfsClient = createMockOpenFsClient();
			const openFs = new OpenFs();
			openFs.setVfs(openfsClient);
			await openFs.init();
			openfsOverlay = new Bash({
				fs: new MountableFs({
					base: new InMemoryFs(localFiles),
					mounts: [{ mountPoint: "/index", filesystem: openFs }],
				}),
				cwd: "/project",
				customCommands: [],
			});
		});

		it("local file reads are identical", async () => {
			const chroma = await chromaOverlay.exec("cat /project/README.md");
			const ax = await openfsOverlay.exec("cat /project/README.md");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("write to VFS then read back identical", async () => {
			for (const bash of [chromaOverlay, openfsOverlay]) {
				await bash.exec("mkdir /index/code");
				await bash.exec(
					"echo 'indexed content' > /index/code/main.ts",
				);
			}
			const chroma = await chromaOverlay.exec(
				"cat /index/code/main.ts",
			);
			const ax = await openfsOverlay.exec("cat /index/code/main.ts");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("local and VFS reads independent", async () => {
			for (const bash of [chromaOverlay, openfsOverlay]) {
				await bash.exec("mkdir /index/code");
				await bash.exec(
					"echo 'indexed' > /index/code/file.ts",
				);
			}
			const chromaLocal = await chromaOverlay.exec(
				"cat /project/src/server.ts",
			);
			const openfsLocal = await openfsOverlay.exec(
				"cat /project/src/server.ts",
			);
			expect(norm(openfsLocal.stdout)).toBe(norm(chromaLocal.stdout));

			const chromaIdx = await chromaOverlay.exec(
				"cat /index/code/file.ts",
			);
			const openfsIdx = await openfsOverlay.exec("cat /index/code/file.ts");
			expect(norm(openfsIdx.stdout)).toBe(norm(chromaIdx.stdout));
		});
	});

	// ------------------------------------------------------------------
	// Stat / exists behavior
	// ------------------------------------------------------------------

	describe("stat and exists: same behavior", () => {
		async function seedBoth() {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/proj");
				await bash.exec(
					"echo 'test content' > /vfs/proj/file.txt",
				);
			}
		}

		it("test -f on file same result", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				'test -f /vfs/proj/file.txt && echo "yes" || echo "no"',
			);
			const ax = await openfsBash.exec(
				'test -f /vfs/proj/file.txt && echo "yes" || echo "no"',
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("test -d on directory same result", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				'test -d /vfs/proj && echo "yes" || echo "no"',
			);
			const ax = await openfsBash.exec(
				'test -d /vfs/proj && echo "yes" || echo "no"',
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("test -f on missing file same result", async () => {
			await seedBoth();
			const chroma = await chromaBash.exec(
				'test -f /vfs/proj/missing.txt && echo "yes" || echo "no"',
			);
			const ax = await openfsBash.exec(
				'test -f /vfs/proj/missing.txt && echo "yes" || echo "no"',
			);
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});
	});

	// ------------------------------------------------------------------
	// Edge cases
	// ------------------------------------------------------------------

	describe("edge cases: same behavior", () => {
		it("empty file cat returns same empty output", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/edge");
			}
			// Write empty via API-level writeFile to both
			// Use echo -n to write near-empty file
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec(
					"printf '' > /vfs/edge/empty.txt",
				);
			}
			const chroma = await chromaBash.exec("cat /vfs/edge/empty.txt");
			const ax = await openfsBash.exec("cat /vfs/edge/empty.txt");
			expect(ax.stdout).toBe(chroma.stdout);
			expect(ax.exitCode).toBe(chroma.exitCode);
		});

		it("file with special characters same content", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir /vfs/edge");
				await bash.exec(
					"echo 'var x = 42; // comment' > /vfs/edge/special.txt",
				);
			}
			const chroma = await chromaBash.exec(
				"cat /vfs/edge/special.txt",
			);
			const ax = await openfsBash.exec("cat /vfs/edge/special.txt");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});

		it("deeply nested path same content", async () => {
			for (const bash of [chromaBash, openfsBash]) {
				await bash.exec("mkdir -p /vfs/a/b/c/d");
				await bash.exec(
					"echo 'deep' > /vfs/a/b/c/d/file.txt",
				);
			}
			const chroma = await chromaBash.exec(
				"cat /vfs/a/b/c/d/file.txt",
			);
			const ax = await openfsBash.exec("cat /vfs/a/b/c/d/file.txt");
			expect(norm(ax.stdout)).toBe(norm(chroma.stdout));
		});
	});
});
