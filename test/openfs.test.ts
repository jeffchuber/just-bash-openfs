import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenFs } from "../src/openfs.js";
import type { Vfs, Entry } from "@open-fs/core";

function createMockVfs(
	files: Record<string, string> = {},
	dirs: Record<string, Entry[]> = {},
): Vfs {
	const storage = new Map(Object.entries(files));
	const dirEntries = new Map(Object.entries(dirs));

	return {
		close: vi.fn(async () => {}),
		read: vi.fn(async (path: string) => {
			const content = storage.get(path);
			if (content === undefined)
				throw Object.assign(new Error(`not found: ${path}`), {
					code: "ENOENT",
				});
			return content;
		}),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		append: vi.fn(async (path: string, content: string) => {
			const existing = storage.get(path) ?? "";
			storage.set(path, existing + content);
		}),
		list: vi.fn(async (path: string) => {
			return dirEntries.get(path) ?? [];
		}),
		stat: vi.fn(async (path: string) => {
			if (storage.has(path)) {
				return {
					path,
					name: path.split("/").pop()!,
					is_dir: false,
					size: storage.get(path)!.length,
					modified: "2024-01-01T00:00:00Z",
				};
			}
			if (dirEntries.has(path) || path === "/") {
				return {
					path,
					name: path === "/" ? "/" : path.split("/").pop()!,
					is_dir: true,
					size: null,
					modified: null,
				};
			}
			throw Object.assign(new Error(`not found: ${path}`), {
				code: "ENOENT",
			});
		}),
		delete: vi.fn(async (path: string) => {
			storage.delete(path);
		}),
		exists: vi.fn(async (path: string) => {
			return storage.has(path) || dirEntries.has(path) || path === "/";
		}),
		rename: vi.fn(async (from: string, to: string) => {
			const content = storage.get(from);
			if (content !== undefined) {
				storage.set(to, content);
				storage.delete(from);
			}
		}),
		grep: vi.fn(async () => []),
		search: vi.fn(async () => []),
	};
}

describe("OpenFs", () => {
	let fs: OpenFs;
	let mockClient: Vfs;

	beforeEach(async () => {
		mockClient = createMockVfs(
			{
				"/hello.txt": "hello world",
				"/src/main.rs": 'fn main() { println!("hi"); }',
				"/src/lib.rs": "pub mod utils;",
				"/deep/a/b/c.txt": "deep content",
			},
			{
				"/": [
					{
						path: "/hello.txt",
						name: "hello.txt",
						is_dir: false,
						size: 11,
						modified: null,
					},
					{
						path: "/src",
						name: "src",
						is_dir: true,
						size: null,
						modified: null,
					},
					{
						path: "/deep",
						name: "deep",
						is_dir: true,
						size: null,
						modified: null,
					},
				],
				"/src": [
					{
						path: "/src/main.rs",
						name: "main.rs",
						is_dir: false,
						size: 29,
						modified: null,
					},
					{
						path: "/src/lib.rs",
						name: "lib.rs",
						is_dir: false,
						size: 14,
						modified: null,
					},
				],
				"/deep": [
					{
						path: "/deep/a",
						name: "a",
						is_dir: true,
						size: null,
						modified: null,
					},
				],
				"/deep/a": [
					{
						path: "/deep/a/b",
						name: "b",
						is_dir: true,
						size: null,
						modified: null,
					},
				],
				"/deep/a/b": [
					{
						path: "/deep/a/b/c.txt",
						name: "c.txt",
						is_dir: false,
						size: 12,
						modified: null,
					},
				],
			},
		);

		fs = new OpenFs();
		fs.setVfs(mockClient);
		await fs.init();
	});

	// --- init / lifecycle ---

	describe("init", () => {
		it("works with injected vfs via setVfs", async () => {
			const injectedVfs = createMockVfs(
				{ "/x.txt": "x" },
				{
					"/": [
						{
							path: "/x.txt",
							name: "x.txt",
							is_dir: false,
							size: 1,
							modified: null,
						},
					],
				},
			);
			const openfs = new OpenFs();
			openfs.setVfs(injectedVfs);
			await openfs.init();
			const content = await openfs.readFile("/x.txt");
			expect(content).toBe("x");
		});

		it("handles empty VFS gracefully", async () => {
			const emptyClient = createMockVfs({}, {});
			const emptyFs = new OpenFs();
			emptyFs.setVfs(emptyClient);
			await emptyFs.init();
			// No path cache to check — just verify no errors
		});

		it("does not eagerly list files on init", async () => {
			const client = createMockVfs({}, { "/": [] });
			const openfs = new OpenFs();
			openfs.setVfs(client);
			await openfs.init();
			// list should NOT be called during init (no eager population)
			expect(client.list).not.toHaveBeenCalled();
		});
	});

	describe("close", () => {
		it("calls client.close", async () => {
			await fs.close();
			expect(mockClient.close).toHaveBeenCalled();
		});

		it("can be called multiple times without error", async () => {
			await fs.close();
			await fs.close();
		});

		it("throws on operations after close", async () => {
			await fs.close();
			await expect(fs.readFile("/hello.txt")).rejects.toThrow(
				"not initialized",
			);
		});
	});

	describe("getClient guard", () => {
		it("throws before init", async () => {
			const uninitFs = new OpenFs();
			await expect(uninitFs.readFile("/x")).rejects.toThrow(
				"not initialized",
			);
		});
	});

	// --- readFile ---

	describe("readFile", () => {
		it("reads file content as string", async () => {
			expect(await fs.readFile("/hello.txt")).toBe("hello world");
		});

		it("reads nested file", async () => {
			const content = await fs.readFile("/src/main.rs");
			expect(content).toContain("fn main()");
		});

		it("reads deeply nested file", async () => {
			expect(await fs.readFile("/deep/a/b/c.txt")).toBe("deep content");
		});

		it("throws for missing file", async () => {
			await expect(fs.readFile("/nope.txt")).rejects.toThrow("not found");
		});

		it("accepts encoding options parameter (ignored)", async () => {
			expect(await fs.readFile("/hello.txt", "utf-8")).toBe(
				"hello world",
			);
			expect(
				await fs.readFile("/hello.txt", { encoding: "utf-8" }),
			).toBe("hello world");
		});

		it("normalizes path before reading", async () => {
			expect(await fs.readFile("/src/../hello.txt")).toBe("hello world");
		});
	});

	// --- readFileBuffer ---

	describe("readFileBuffer", () => {
		it("returns Uint8Array", async () => {
			const buf = await fs.readFileBuffer("/hello.txt");
			expect(buf).toBeInstanceOf(Uint8Array);
			expect(new TextDecoder().decode(buf)).toBe("hello world");
		});

		it("returns correct byte length for ASCII", async () => {
			const buf = await fs.readFileBuffer("/hello.txt");
			expect(buf.length).toBe(11);
		});

		it("throws for missing file", async () => {
			await expect(fs.readFileBuffer("/missing")).rejects.toThrow();
		});
	});

	// --- writeFile ---

	describe("writeFile", () => {
		it("writes string content", async () => {
			await fs.writeFile("/new.txt", "new content");
			expect(mockClient.write).toHaveBeenCalledWith(
				"/new.txt",
				"new content",
			);
		});

		it("writes Uint8Array content", async () => {
			const data = new TextEncoder().encode("binary");
			await fs.writeFile("/bin.txt", data);
			expect(mockClient.write).toHaveBeenCalledWith("/bin.txt", "binary");
		});

		it("writes empty string", async () => {
			await fs.writeFile("/empty.txt", "");
			expect(mockClient.write).toHaveBeenCalledWith("/empty.txt", "");
		});

		it("accepts encoding option (ignored)", async () => {
			await fs.writeFile("/f.txt", "data", "utf-8");
			expect(mockClient.write).toHaveBeenCalled();
		});

		it("normalizes path", async () => {
			await fs.writeFile("/a/../b.txt", "data");
			expect(mockClient.write).toHaveBeenCalledWith("/b.txt", "data");
		});

		it("overwrites existing file", async () => {
			await fs.writeFile("/hello.txt", "overwritten");
			expect(mockClient.write).toHaveBeenCalledWith(
				"/hello.txt",
				"overwritten",
			);
		});
	});

	// --- appendFile ---

	describe("appendFile", () => {
		it("appends string content", async () => {
			await fs.appendFile("/hello.txt", " more");
			expect(mockClient.append).toHaveBeenCalledWith(
				"/hello.txt",
				" more",
			);
		});

		it("appends Uint8Array content", async () => {
			const data = new TextEncoder().encode(" appended");
			await fs.appendFile("/hello.txt", data);
			expect(mockClient.append).toHaveBeenCalledWith(
				"/hello.txt",
				" appended",
			);
		});

		it("normalizes path", async () => {
			await fs.appendFile("/src/../file.txt", "x");
			expect(mockClient.append).toHaveBeenCalledWith("/file.txt", "x");
		});
	});

	// --- exists ---

	describe("exists", () => {
		it("returns true for existing file", async () => {
			expect(await fs.exists("/hello.txt")).toBe(true);
		});

		it("returns true for root", async () => {
			expect(await fs.exists("/")).toBe(true);
		});

		it("returns true for directory", async () => {
			expect(await fs.exists("/src")).toBe(true);
		});

		it("returns false for non-existent path", async () => {
			expect(await fs.exists("/no-such-thing")).toBe(false);
		});

		it("normalizes path", async () => {
			expect(await fs.exists("/src/../hello.txt")).toBe(true);
		});

		it("delegates to vfs.exists directly", async () => {
			await fs.exists("/hello.txt");
			expect(mockClient.exists).toHaveBeenCalledWith("/hello.txt");
		});
	});

	// --- stat ---

	describe("stat", () => {
		it("returns file stat with correct fields", async () => {
			const stat = await fs.stat("/hello.txt");
			expect(stat.isFile).toBe(true);
			expect(stat.isDirectory).toBe(false);
			expect(stat.isSymbolicLink).toBe(false);
			expect(stat.size).toBe(11);
			expect(stat.mode).toBe(0o644);
		});

		it("returns directory stat", async () => {
			const stat = await fs.stat("/src");
			expect(stat.isFile).toBe(false);
			expect(stat.isDirectory).toBe(true);
			expect(stat.mode).toBe(0o755);
		});

		it("returns mtime as Date from modified string", async () => {
			const stat = await fs.stat("/hello.txt");
			expect(stat.mtime).toBeInstanceOf(Date);
			expect(stat.mtime.toISOString()).toBe("2024-01-01T00:00:00.000Z");
		});

		it("returns epoch Date when modified is null", async () => {
			const stat = await fs.stat("/src");
			expect(stat.mtime.getTime()).toBe(0);
		});

		it("returns size 0 when size is null", async () => {
			const stat = await fs.stat("/src");
			expect(stat.size).toBe(0);
		});

		it("throws for missing path", async () => {
			await expect(fs.stat("/missing")).rejects.toThrow("not found");
		});

		it("normalizes path", async () => {
			const stat = await fs.stat("/src/../hello.txt");
			expect(stat.isFile).toBe(true);
		});
	});

	// --- lstat ---

	describe("lstat", () => {
		it("delegates to stat for files", async () => {
			const stat = await fs.lstat("/hello.txt");
			expect(stat.isFile).toBe(true);
			expect(stat.isSymbolicLink).toBe(false);
		});

		it("delegates to stat for directories", async () => {
			const stat = await fs.lstat("/src");
			expect(stat.isDirectory).toBe(true);
		});
	});

	// --- mkdir ---

	describe("mkdir", () => {
		it("is a no-op and does not throw", async () => {
			await fs.mkdir("/newdir");
		});

		it("accepts recursive option without error", async () => {
			await fs.mkdir("/a/b/c", { recursive: true });
		});
	});

	// --- readdir ---

	describe("readdir", () => {
		it("returns child names for root", async () => {
			const names = await fs.readdir("/");
			expect(names).toContain("hello.txt");
			expect(names).toContain("src");
			expect(names).toContain("deep");
		});

		it("returns subdirectory contents", async () => {
			const names = await fs.readdir("/src");
			expect(names).toEqual(["main.rs", "lib.rs"]);
		});

		it("returns empty for empty directory", async () => {
			const emptyClient = createMockVfs(
				{},
				{ "/": [], "/empty": [] },
			);
			const emptyFs = new OpenFs();
			emptyFs.setVfs(emptyClient);
			await emptyFs.init();
			expect(await emptyFs.readdir("/empty")).toEqual([]);
		});

		it("normalizes path", async () => {
			const names = await fs.readdir("/deep/../src");
			expect(names).toEqual(["main.rs", "lib.rs"]);
		});
	});

	// --- readdirWithFileTypes ---

	describe("readdirWithFileTypes", () => {
		it("returns DirentEntry array", async () => {
			const entries = await fs.readdirWithFileTypes("/");
			const helloEntry = entries.find((e) => e.name === "hello.txt");
			expect(helloEntry).toEqual({
				name: "hello.txt",
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
			});
		});

		it("distinguishes files and directories", async () => {
			const entries = await fs.readdirWithFileTypes("/");
			const srcEntry = entries.find((e) => e.name === "src");
			expect(srcEntry?.isDirectory).toBe(true);
			expect(srcEntry?.isFile).toBe(false);
		});

		it("returns empty for empty directory", async () => {
			const client = createMockVfs({}, { "/": [], "/e": [] });
			const testFs = new OpenFs();
			testFs.setVfs(client);
			await testFs.init();
			expect(await testFs.readdirWithFileTypes("/e")).toEqual([]);
		});

		it("never has isSymbolicLink true", async () => {
			const entries = await fs.readdirWithFileTypes("/");
			for (const e of entries) {
				expect(e.isSymbolicLink).toBe(false);
			}
		});
	});

	// --- rm ---

	describe("rm", () => {
		it("deletes a file", async () => {
			await fs.rm("/hello.txt");
			expect(mockClient.delete).toHaveBeenCalledWith("/hello.txt");
		});

		it("accepts options without error", async () => {
			await fs.rm("/hello.txt", { recursive: true, force: true });
			expect(mockClient.delete).toHaveBeenCalled();
		});

		it("normalizes path", async () => {
			await fs.rm("/src/../hello.txt");
			expect(mockClient.delete).toHaveBeenCalledWith("/hello.txt");
		});
	});

	// --- cp ---

	describe("cp", () => {
		it("copies via read + write", async () => {
			await fs.cp("/hello.txt", "/copy.txt");
			expect(mockClient.read).toHaveBeenCalledWith("/hello.txt");
			expect(mockClient.write).toHaveBeenCalledWith(
				"/copy.txt",
				"hello world",
			);
		});

		it("propagates error when source missing", async () => {
			await expect(fs.cp("/nope.txt", "/dest.txt")).rejects.toThrow(
				"not found",
			);
		});

		it("normalizes both paths", async () => {
			await fs.cp("/src/../hello.txt", "/a/../copy.txt");
			expect(mockClient.read).toHaveBeenCalledWith("/hello.txt");
			expect(mockClient.write).toHaveBeenCalledWith(
				"/copy.txt",
				"hello world",
			);
		});

		it("accepts options (ignored)", async () => {
			await fs.cp("/hello.txt", "/cp2.txt", { recursive: true });
			expect(mockClient.write).toHaveBeenCalled();
		});
	});

	// --- mv ---

	describe("mv", () => {
		it("renames via client.rename", async () => {
			await fs.mv("/hello.txt", "/moved.txt");
			expect(mockClient.rename).toHaveBeenCalledWith(
				"/hello.txt",
				"/moved.txt",
			);
		});

		it("normalizes paths", async () => {
			await fs.mv("/src/../hello.txt", "/a/../moved.txt");
			expect(mockClient.rename).toHaveBeenCalledWith(
				"/hello.txt",
				"/moved.txt",
			);
		});
	});

	// --- resolvePath ---

	describe("resolvePath", () => {
		it("resolves relative to base", () => {
			expect(fs.resolvePath("/src", "main.rs")).toBe("/src/main.rs");
		});

		it("resolves .. traversal", () => {
			expect(fs.resolvePath("/src/sub", "../main.rs")).toBe(
				"/src/main.rs",
			);
		});

		it("handles absolute path as second arg", () => {
			expect(fs.resolvePath("/src", "/hello.txt")).toBe("/hello.txt");
		});

		it("resolves ./ in path", () => {
			expect(fs.resolvePath("/src", "./main.rs")).toBe("/src/main.rs");
		});

		it("handles root base", () => {
			expect(fs.resolvePath("/", "file.txt")).toBe("/file.txt");
		});

		it("resolves multiple .. traversals", () => {
			expect(fs.resolvePath("/a/b/c", "../../d.txt")).toBe("/a/d.txt");
		});
	});

	// --- realpath ---

	describe("realpath", () => {
		it("returns normalized path", async () => {
			expect(await fs.realpath("/src/../hello.txt")).toBe("/hello.txt");
		});

		it("returns root as-is", async () => {
			expect(await fs.realpath("/")).toBe("/");
		});

		it("removes trailing slash", async () => {
			expect(await fs.realpath("/src/")).toBe("/src");
		});

		it("resolves double dots", async () => {
			expect(await fs.realpath("/a/b/../c")).toBe("/a/c");
		});

		it("resolves double slashes", async () => {
			expect(await fs.realpath("/src//main.rs")).toBe("/src/main.rs");
		});
	});

	// --- no-op and unsupported operations ---

	describe("chmod", () => {
		it("is a no-op", async () => {
			await fs.chmod("/hello.txt", 0o777);
			await fs.chmod("/hello.txt", 0o000);
		});
	});

	describe("utimes", () => {
		it("is a no-op", async () => {
			await fs.utimes("/hello.txt", new Date(), new Date());
		});
	});

	describe("symlink", () => {
		it("throws ENOTSUP", async () => {
			await expect(fs.symlink("/a", "/b")).rejects.toThrow(
				"not supported",
			);
			try {
				await fs.symlink("/a", "/b");
			} catch (e: any) {
				expect(e.code).toBe("ENOTSUP");
			}
		});
	});

	describe("link", () => {
		it("throws ENOTSUP", async () => {
			await expect(fs.link("/a", "/b")).rejects.toThrow("not supported");
			try {
				await fs.link("/a", "/b");
			} catch (e: any) {
				expect(e.code).toBe("ENOTSUP");
			}
		});
	});

	describe("readlink", () => {
		it("throws ENOTSUP", async () => {
			await expect(fs.readlink("/a")).rejects.toThrow("not supported");
			try {
				await fs.readlink("/a");
			} catch (e: any) {
				expect(e.code).toBe("ENOTSUP");
			}
		});
	});
});

// --- Path normalization ---

describe("OpenFs path normalization", () => {
	let openfs: OpenFs;
	let client: Vfs;

	beforeEach(async () => {
		client = createMockVfs(
			{ "/file.txt": "content" },
			{
				"/": [
					{
						path: "/file.txt",
						name: "file.txt",
						is_dir: false,
						size: 7,
						modified: null,
					},
				],
			},
		);
		openfs = new OpenFs();
		openfs.setVfs(client);
		await openfs.init();
	});

	it("resolves double dots", async () => {
		const content = await openfs.readFile("/a/../file.txt");
		expect(content).toBe("content");
	});

	it("resolves double slashes", async () => {
		expect(await openfs.realpath("//file.txt")).toBe("/file.txt");
	});

	it("handles just /", async () => {
		expect(await openfs.realpath("/")).toBe("/");
	});

	it("strips trailing slash", async () => {
		expect(await openfs.realpath("/file.txt/")).toBe("/file.txt");
	});

	it("resolves relative-like path under root", async () => {
		expect(await openfs.realpath("/./file.txt")).toBe("/file.txt");
	});
});
