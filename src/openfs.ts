import { posix as path } from "node:path";
import {
	type SubprocessVfsOptions,
	type Vfs,
	createVfs,
	enotsup,
} from "@open-fs/core";

interface FsStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	mode: number;
	size: number;
	mtime: Date;
}

interface DirentEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export class OpenFs {
	private vfs: Vfs | null = null;
	private options: SubprocessVfsOptions;

	constructor(options: SubprocessVfsOptions = {}) {
		this.options = options;
	}

	/**
	 * Inject a pre-built Vfs (for testing or dev mode with MemoryVfs).
	 */
	setVfs(vfs: Vfs): void {
		this.vfs = vfs;
	}

	private getVfs(): Vfs {
		if (!this.vfs) {
			throw new Error("OpenFs not initialized — call init() first");
		}
		return this.vfs;
	}

	async init(): Promise<void> {
		if (!this.vfs) {
			this.vfs = await createVfs(this.options);
		}
	}

	async close(): Promise<void> {
		if (this.vfs) {
			await this.vfs.close();
			this.vfs = null;
		}
	}

	// --- IFileSystem implementation ---

	async readFile(
		filePath: string,
		_options?: { encoding?: string | null } | string,
	): Promise<string> {
		return this.getVfs().read(normalizePath(filePath));
	}

	async readFileBuffer(filePath: string): Promise<Uint8Array> {
		const content = await this.getVfs().read(normalizePath(filePath));
		return new TextEncoder().encode(content);
	}

	async writeFile(
		filePath: string,
		content: string | Uint8Array,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const p = normalizePath(filePath);
		const text =
			typeof content === "string" ? content : new TextDecoder().decode(content);
		await this.getVfs().write(p, text);
	}

	async appendFile(
		filePath: string,
		content: string | Uint8Array,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const p = normalizePath(filePath);
		const text =
			typeof content === "string" ? content : new TextDecoder().decode(content);
		await this.getVfs().append(p, text);
	}

	async exists(filePath: string): Promise<boolean> {
		return this.getVfs().exists(normalizePath(filePath));
	}

	async stat(filePath: string): Promise<FsStat> {
		const p = normalizePath(filePath);
		const entry = await this.getVfs().stat(p);
		return {
			isFile: !entry.is_dir,
			isDirectory: entry.is_dir,
			isSymbolicLink: false,
			mode: entry.is_dir ? 0o755 : 0o644,
			size: entry.size ?? 0,
			mtime: entry.modified ? new Date(entry.modified) : new Date(0),
		};
	}

	async lstat(filePath: string): Promise<FsStat> {
		// No symlinks in OpenFS
		return this.stat(filePath);
	}

	async mkdir(
		_dirPath: string,
		_options?: { recursive?: boolean },
	): Promise<void> {
		// OpenFS auto-creates directories on write — no-op
	}

	async readdir(dirPath: string): Promise<string[]> {
		const p = normalizePath(dirPath);
		const entries = await this.getVfs().list(p);
		return entries.map((e) => e.name);
	}

	async readdirWithFileTypes(dirPath: string): Promise<DirentEntry[]> {
		const p = normalizePath(dirPath);
		const entries = await this.getVfs().list(p);
		return entries.map((e) => ({
			name: e.name,
			isFile: !e.is_dir,
			isDirectory: e.is_dir,
			isSymbolicLink: false,
		}));
	}

	async rm(
		filePath: string,
		_options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		const p = normalizePath(filePath);
		await this.getVfs().delete(p);
	}

	async cp(
		src: string,
		dest: string,
		_options?: { recursive?: boolean },
	): Promise<void> {
		const content = await this.getVfs().read(normalizePath(src));
		await this.getVfs().write(normalizePath(dest), content);
	}

	async mv(src: string, dest: string): Promise<void> {
		const s = normalizePath(src);
		const d = normalizePath(dest);
		await this.getVfs().rename(s, d);
	}

	resolvePath(base: string, p: string): string {
		return path.resolve(base, p);
	}

	async realpath(filePath: string): Promise<string> {
		return normalizePath(filePath);
	}

	async chmod(_path: string, _mode: number): Promise<void> {
		// No-op — OpenFS doesn't support permissions
	}

	async symlink(_target: string, _linkPath: string): Promise<void> {
		throw enotsup("symlink");
	}

	async link(_existingPath: string, _newPath: string): Promise<void> {
		throw enotsup("link");
	}

	async readlink(_path: string): Promise<string> {
		throw enotsup("readlink");
	}

	async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
		// No-op — OpenFS doesn't support setting timestamps
	}

	getAllPaths(): string[] {
		// Synchronous — returns empty since OpenFS is async-only.
		// just-bash uses this for tab completion; the empty return is acceptable
		// because OpenFs-backed paths are not used for glob/completion.
		return [];
	}
}

function normalizePath(p: string): string {
	// Ensure leading slash, resolve ../ etc, remove trailing slash
	const resolved = path.resolve("/", p);
	return resolved === "/" ? "/" : resolved.replace(/\/$/, "");
}
