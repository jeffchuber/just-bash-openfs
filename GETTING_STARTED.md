# Getting Started

This guide walks you through setting up `@open-fs/just-bash` from scratch. By the end, you'll have a working shell that can read, write, and search across multiple storage backends.

## Prerequisites

- Node.js 18+
- npm or your preferred package manager
- An [OpenFS](https://github.com/nicholasgasior/open-fs) server (or use the built-in mocks for development)

## Step 1: Try the demos first

The fastest way to see what this package does — no external services needed:

```bash
git clone https://github.com/jeffchuber/just-bash-openfs.git
cd just-bash-openfs
npm install
npm run build
```

Run the multi-backend demo to see 10 scenarios across 5 storage backends:

```bash
npm run demo
```

Or drop into an interactive shell:

```bash
npm run repl
```

Try some commands in the REPL:

```bash
ls /data
cat /data/docs/report.md
cat /data/db/users.csv | grep admin | wc -l
search "authentication best practices"
grep -rn "error" /data/code
```

## Step 2: Install in your project

```bash
npm install @open-fs/just-bash just-bash
```

## Step 3: Create a basic shell

Create a file called `shell.ts`:

```typescript
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import {
  OpenFs,
  createVfs,
  createGrepCommand,
  createSearchCommand,
} from "@open-fs/just-bash";

async function main() {
  // 1. Connect to your OpenFS server
  const vfs = await createVfs({ command: "openfs", args: ["serve"] });

  // 2. Create the filesystem adapter
  const openFs = new OpenFs();
  openFs.setVfs(vfs);
  await openFs.init();

  // 3. Mount it into a just-bash MountableFs
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [{ mountPoint: "/data", filesystem: openFs }],
  });

  // 4. Create a shell with custom commands
  const bash = new Bash({
    fs,
    cwd: "/data",
    customCommands: [createGrepCommand(vfs, "/data"), createSearchCommand(vfs)],
  });

  // 5. Run commands
  const result = await bash.exec("ls /data");
  console.log(result.stdout);

  // Clean up
  await openFs.close();
}

main();
```

Run it:

```bash
npx tsx shell.ts
```

## Step 4: Add custom commands

`@open-fs/just-bash` ships two custom commands that leverage server-side capabilities:

### `grep` — regex search across backends

`grep` works transparently — it uses server-side grep for OpenFS paths and local matching for everything else.

```typescript
const result = await bash.exec('grep -rn "TODO" /data/code');
console.log(result.stdout);
// /data/code/app.ts:42:// TODO: add error handling
// /data/code/utils.ts:17:// TODO: refactor this
```

### `search` — semantic search (for vector store backends)

```typescript
const result = await bash.exec('search "how to handle auth" /data/knowledge');
console.log(result.stdout);
// Results ranked by relevance from your vector store
```

Both commands work with pipes like any other shell command:

```bash
grep "error" /data/code | wc -l
search "deployment" /data/knowledge | head -5
```

## Step 5: Use with the AI SDK

Give an AI agent access to all your storage backends:

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
  customCommands: [createGrepCommand(vfs, "/data"), createSearchCommand(vfs)],
});

const result = await generateText({
  model: "anthropic/claude-sonnet-4",
  tools: { bash: bashTool },
  prompt: "List all files in /data and summarize the database tables",
});
```

## Step 6: Mix with local filesystems

Combine remote storage with local project files using just-bash's `OverlayFs`:

```typescript
import { OverlayFs } from "just-bash/fs/overlay-fs";

const fs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [
    // Local project files (read-only)
    { mountPoint: "/project", filesystem: new OverlayFs({ root: "./my-app", readOnly: true }) },
    // Remote storage via OpenFS
    { mountPoint: "/data", filesystem: openFs },
  ],
});

const bash = new Bash({ fs, cwd: "/" });

// Read local and remote in the same session
await bash.exec("cat /project/package.json | head -5");
await bash.exec("cat /data/db/users.csv | wc -l");

// Copy between filesystems
await bash.exec("cp /project/README.md /data/docs/readme-backup.md");
```

## What's next

- Browse the [README](./README.md) for the full API reference
- Check out `examples/` for more complete demos including an incident response workflow
- Read the [just-bash docs](https://github.com/vercel-labs/just-bash) for all available builtins and filesystem options
- Read the [OpenFS docs](https://github.com/nicholasgasior/open-fs) to configure storage backends (S3, Postgres, Chroma, etc.)
