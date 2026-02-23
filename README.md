# @open-fs/just-bash

Shell into any storage backend. `ls` your Postgres tables, `cat` files from S3, `grep` across a vector store — all through familiar bash commands.

```
/data/code/       → Local filesystem
/data/docs/       → S3
/data/db/         → Postgres
/data/knowledge/  → Chroma vector store
/data/scratch/    → In-memory
```

This package is a pluggable filesystem for [just-bash](https://github.com/vercel-labs/just-bash) — Vercel's sandboxed bash environment for AI agents. It implements the `IFileSystem` interface, letting you mount [OpenFS](https://github.com/nicholasgasior/open-fs) virtual filesystems alongside just-bash's built-in `InMemoryFs`, `OverlayFs`, and `ReadWriteFs`.

## Install

```bash
npm install @open-fs/just-bash just-bash
```

## Using with just-bash

[just-bash](https://github.com/vercel-labs/just-bash) provides a sandboxed bash environment with 60+ built-in commands, pipes, redirects, heredocs, and a pluggable filesystem architecture via `MountableFs`. This package adds OpenFS backends as a mount target.

### Basic setup

```typescript
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OpenFs, createVfs, createGrepCommand, createSearchCommand } from "@open-fs/just-bash";

// Connect to your OpenFS server
const vfs = await createVfs({ command: "openfs", args: ["serve"] });

// Wrap as an IFileSystem for just-bash
const openFs = new OpenFs();
openFs.setVfs(vfs);
await openFs.init();

// Mount OpenFS alongside other just-bash filesystems
const fs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [{ mountPoint: "/data", filesystem: openFs }],
});

const bash = new Bash({
  fs,
  cwd: "/data",
  customCommands: [createGrepCommand(vfs), createSearchCommand(vfs)],
});

// Standard shell commands work across all backends
await bash.exec("ls /data");
await bash.exec("cat /data/docs/report.md");
await bash.exec("cat /data/db/users.csv | grep admin | wc -l");
await bash.exec('search "authentication best practices"');
```

### Mixing with other just-bash filesystems

`MountableFs` lets you combine OpenFS with any other `IFileSystem` — local project files via `OverlayFs`, a working directory via `ReadWriteFs`, and remote storage via `OpenFs`:

```typescript
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OverlayFs } from "just-bash/fs/overlay-fs";
import { OpenFs, createVfs, createGrepCommand, createSearchCommand } from "@open-fs/just-bash";

const vfs = await createVfs({ command: "openfs", args: ["serve"] });
const openFs = new OpenFs();
openFs.setVfs(vfs);
await openFs.init();

const fs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [
    // Read-only view of a local project
    { mountPoint: "/project", filesystem: new OverlayFs({ root: "./my-app", readOnly: true }) },
    // Remote storage backends via OpenFS
    { mountPoint: "/data", filesystem: openFs },
  ],
});

const bash = new Bash({
  fs,
  cwd: "/",
  customCommands: [createGrepCommand(vfs), createSearchCommand(vfs)],
});

// Read local files and remote data in the same shell session
await bash.exec("cat /project/package.json | head -5");
await bash.exec("cat /data/db/users.csv | wc -l");

// Copy between filesystems
await bash.exec("cp /project/README.md /data/docs/readme-backup.md");
```

### Using with the AI SDK

Combine with just-bash's [AI SDK tool](https://github.com/vercel-labs/just-bash) to give AI agents access to multi-backend storage:

```typescript
import { createBashTool } from "bash-tool";
import { generateText } from "ai";
import { OpenFs, createVfs, createGrepCommand, createSearchCommand } from "@open-fs/just-bash";
import { MountableFs, InMemoryFs } from "just-bash";

const vfs = await createVfs({ command: "openfs", args: ["serve"] });
const openFs = new OpenFs();
openFs.setVfs(vfs);
await openFs.init();

const bashTool = createBashTool({
  fs: new MountableFs({
    base: new InMemoryFs(),
    mounts: [{ mountPoint: "/data", filesystem: openFs }],
  }),
  customCommands: [createGrepCommand(vfs), createSearchCommand(vfs)],
});

const result = await generateText({
  model: "anthropic/claude-sonnet-4",
  tools: { bash: bashTool },
  prompt: "Search the knowledge base for authentication best practices and summarize them",
});
```

## How it works

`OpenFs` implements the `IFileSystem` interface that just-bash uses for all file operations. Under the hood, it delegates to an OpenFS [Vfs](https://github.com/nicholasgasior/open-fs) — a virtual filesystem that routes different paths to different storage backends. Each backend (S3, Postgres, Chroma, local disk, in-memory) handles reads, writes, and listings in its own way, but they all present the same interface to the shell.

Every just-bash builtin (`cat`, `ls`, `cp`, `mv`, `rm`, `stat`, `wc`, `head`, `tail`, `sort`, pipes, redirects, heredocs) works across all backends. Backend-specific behaviors surface naturally — S3 rejects `>>` append, Postgres reports row count as file size, only Chroma supports semantic `search`.

Directories are created automatically on write — `mkdir` is a no-op. Symlinks are not supported.

## Custom commands

### `openfsgrep` — server-side regex search

```bash
openfsgrep [-n] <pattern> [path]
```

Runs regex grep on the backend. Results come back as `path:line` pairs (or `path:line_number:line` with `-n`). Exit code 1 if no matches.

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
