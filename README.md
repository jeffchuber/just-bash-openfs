# @open-fs/just-bash

Shell into any storage backend. `ls` your Postgres tables, `cat` files from S3, `grep` across a vector store — all through familiar bash commands.

```
/data/code/       → Local filesystem
/data/docs/       → S3
/data/db/         → Postgres
/data/knowledge/  → Chroma vector store
/data/scratch/    → In-memory
```

`@open-fs/just-bash` is an [IFileSystem](https://github.com/nicholasgasior/just-bash) adapter for [OpenFS](https://github.com/nicholasgasior/open-fs) virtual filesystems. It lets you mount any combination of storage backends into a unified directory tree and drive them all with standard shell commands.

## Install

```bash
npm install @open-fs/just-bash
```

Peer dependency: `just-bash >= 2.10.0`

## Quick start

```typescript
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OpenFs, createVfs, createGrepCommand, createSearchCommand } from "@open-fs/just-bash";

// Create the VFS client (connects to your OpenFS server)
const vfs = await createVfs({ command: "openfs", args: ["serve"] });

// Wrap it as an IFileSystem for just-bash
const openFs = new OpenFs();
openFs.setVfs(vfs);
await openFs.init();

const fs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [{ mountPoint: "/data", filesystem: openFs }],
});

const bash = new Bash({
  fs,
  cwd: "/data",
  customCommands: [createGrepCommand(vfs), createSearchCommand(vfs)],
});

await bash.exec("ls /data");
await bash.exec("cat /data/docs/report.md");
await bash.exec("cat /data/db/users.csv | grep admin | wc -l");
await bash.exec('search "authentication best practices"');
```

## How it works

`OpenFs` wraps an OpenFS [Vfs](https://github.com/nicholasgasior/open-fs) — a virtual filesystem that routes paths to different storage backends. Each backend (S3, Postgres, Chroma, local disk, in-memory) handles reads, writes, listings, and deletions in its own way, but they all present the same interface. `OpenFs` translates that interface into the `IFileSystem` contract that just-bash expects, so every shell builtin (`cat`, `ls`, `cp`, `mv`, `rm`, `stat`, pipes, redirects, heredocs) works across all backends.

Directories are created automatically on write — `mkdir` is a no-op. Symlinks are not supported. Backend-specific behaviors (e.g., S3 rejecting `>>` append, Postgres reporting row count as file size) surface naturally through the shell.

## Custom commands

### `openfsgrep` — server-side regex search

```bash
openfsgrep [-n] <pattern> [path]
```

Runs regex grep on the backend. Results stream back as `path:line` pairs (or `path:line_number:line` with `-n`). Exit code 1 if no matches.

### `search` — semantic search

```bash
search [-n limit] <query> [path]
```

Semantic/vector search against backends that support it (e.g., Chroma). Returns scored results. Default limit is 10.

## API

### `OpenFs`

```typescript
const openFs = new OpenFs(options?: SubprocessVfsOptions);
```

| Method | Description |
|--------|-------------|
| `init()` | Connect to the VFS backend |
| `close()` | Disconnect and clean up |
| `setVfs(vfs)` | Inject a pre-built `Vfs` (useful for testing) |
| `readFile(path)` | Read file as string |
| `writeFile(path, content)` | Write or overwrite |
| `appendFile(path, content)` | Append (not supported by all backends) |
| `exists(path)` | Check if path exists |
| `stat(path)` | File metadata (size, mtime, isDirectory) |
| `readdir(path)` | List directory entries |
| `rm(path, opts?)` | Delete file or directory |
| `cp(src, dest)` | Copy |
| `mv(src, dest)` | Move/rename |

### Factory functions

```typescript
import { createGrepCommand, createSearchCommand } from "@open-fs/just-bash";

// Pass a Vfs instance to create shell commands
const grep = createGrepCommand(vfs);    // → openfsgrep
const search = createSearchCommand(vfs); // → search
```

## Try the demos

The repo includes runnable demos with mock backends — no external services needed.

```bash
npm run demo             # Multi-backend walkthrough (5 backends, 10 scenarios)
npm run demo:incident    # SRE incident triage workflow
npm run repl             # Interactive shell with all backends
npm run repl:incident    # Interactive incident response shell
npm run web:incident     # Web UI with file browser + terminal
```

## Development

```bash
npm run build       # Compile TypeScript → dist/
npm run test        # Run tests (244 tests via Vitest)
npm run check       # Typecheck + lint + test
```

## License

MIT
