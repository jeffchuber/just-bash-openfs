/**
 * Web-based Incident Response REPL + File Browser
 *
 * Serves a self-contained web UI with:
 *   - Left panel: interactive file/folder tree
 *   - Right panel: live REPL terminal
 *
 * Zero external dependencies — uses Node built-in http module.
 *
 * Run:
 *   npx tsx examples/incident-web.ts
 */
import * as http from "node:http";
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OpenFs } from "../src/openfs.js";
import { createSearchCommand } from "../src/search.js";
import { createGrepCommand } from "../src/grep.js";
import { createConfigurableMock } from "./_mock-backends.js";
import type { Entry } from "@open-fs/core";

const PORT = Number(process.env.PORT) || 3000;

// ── Backend setup (same as incident-repl.ts) ──────────────────────

const client = createConfigurableMock([
	{ prefix: "/incidents", backend: "postgres" },
	{ prefix: "/oncall", backend: "postgres" },
	{ prefix: "/logs", backend: "s3" },
	{ prefix: "/runbooks", backend: "chroma" },
	{ prefix: "/scratch", backend: "memory" },
]);

const openFs = new OpenFs();
openFs.setVfs(client);

const fs = new MountableFs({
	base: new InMemoryFs(),
	mounts: [{ mountPoint: "/openfs", filesystem: openFs }],
});

const bash = new Bash({
	fs,
	cwd: "/openfs",
	customCommands: [createSearchCommand(client), createGrepCommand(client)],
});

// ── Seed data ─────────────────────────────────────────────────────

const seeds: [string, string][] = [
	[
		"/openfs/incidents/open.csv",
		`id,severity,status,assignee,title,created_at
INC-001,P1,open,,Redis OOM on prod-redis-3,2025-06-15T09:45:00Z
INC-002,P2,investigating,alice,API latency spike p99 > 2s,2025-06-15T08:30:00Z
INC-003,P3,open,,Stale cache entries in CDN,2025-06-14T16:00:00Z`,
	],
	[
		"/openfs/incidents/closed.csv",
		`id,severity,status,assignee,title,created_at,resolved_at
INC-098,P2,resolved,bob,Database connection pool exhaustion,2025-06-10T14:00:00Z,2025-06-10T15:30:00Z
INC-099,P1,resolved,carol,Redis OOM on prod-redis-1,2025-05-28T03:00:00Z,2025-05-28T04:45:00Z`,
	],
	[
		"/openfs/oncall/schedule.csv",
		`team,primary,secondary,start,end
infra,bob,carol,2025-06-15,2025-06-22
platform,alice,dave,2025-06-15,2025-06-22
data,eve,frank,2025-06-15,2025-06-22`,
	],
	[
		"/openfs/logs/redis-2025-06-15.log",
		`2025-06-15T09:30:01Z INFO  prod-redis-3 connected_clients=142 used_memory=6.1G maxmemory=8G
2025-06-15T09:35:00Z INFO  prod-redis-3 connected_clients=158 used_memory=6.8G maxmemory=8G
2025-06-15T09:38:00Z WARN  prod-redis-3 used_memory approaching maxmemory threshold (85%)
2025-06-15T09:40:00Z WARN  prod-redis-3 eviction policy=noeviction, cannot free memory
2025-06-15T09:42:00Z ERROR prod-redis-3 OOM command not allowed when used memory > maxmemory
2025-06-15T09:42:01Z ERROR prod-redis-3 OOM command not allowed: SET session:usr_48291
2025-06-15T09:42:05Z ERROR prod-redis-3 OOM command not allowed: SET session:usr_10382
2025-06-15T09:43:00Z WARN  prod-redis-3 client connection refused: max memory reached
2025-06-15T09:44:00Z ERROR prod-redis-3 OOM command not allowed: SET session:usr_77412
2025-06-15T09:44:30Z ERROR prod-redis-3 OOM command not allowed: LPUSH queue:notifications
2025-06-15T09:45:00Z ERROR prod-redis-3 ALERT triggered: memory_usage_critical
2025-06-15T09:45:01Z INFO  alertmanager firing alert redis_oom_critical for prod-redis-3
2025-06-15T09:45:05Z INFO  pagerduty incident created for on-call team=infra`,
	],
	[
		"/openfs/logs/api-gateway-2025-06-15.log",
		`2025-06-15T09:40:12Z INFO  api-gw request_id=a1b2 POST /api/login 200 45ms
2025-06-15T09:41:00Z INFO  api-gw request_id=c3d4 GET /api/profile 200 12ms
2025-06-15T09:42:02Z ERROR api-gw request_id=e5f6 POST /api/login 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:42:10Z ERROR api-gw request_id=g7h8 POST /api/login 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:42:30Z ERROR api-gw request_id=i9j0 GET /api/session 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:43:00Z WARN  api-gw circuit_breaker=open for upstream=prod-redis-3 failures=15/20
2025-06-15T09:43:01Z ERROR api-gw request_id=k1l2 POST /api/login 503 circuit_breaker=open
2025-06-15T09:44:00Z ERROR api-gw error_rate=34% for path=/api/login in last 5m`,
	],
	[
		"/openfs/runbooks/redis-oom.md",
		`# Runbook: Redis OOM Recovery

## Symptoms
- Redis returns OOM errors on write commands
- Clients receive connection refused or timeout
- Alert: redis_oom_critical

## Diagnosis
1. Check current memory: redis-cli INFO memory | grep used_memory_human
2. Identify hot keys: redis-cli --hotkeys
3. Check eviction policy: redis-cli CONFIG GET maxmemory-policy

## Immediate Mitigation
1. Set volatile-lru: redis-cli CONFIG SET maxmemory-policy volatile-lru
2. Flush expired keys: redis-cli --scan --pattern 'session:*' | head -100
3. Add TTL to session keys: ensure all SET commands include EX/PX

## Scaling
1. Increase maxmemory: redis-cli CONFIG SET maxmemory 12G
2. Update redis.conf for persistence
3. Consider adding a replica for read offload`,
	],
	[
		"/openfs/runbooks/latency-troubleshooting.md",
		`# Runbook: API Latency Investigation

## Symptoms
- p99 latency exceeds SLO (e.g., > 2 seconds)
- Elevated error rates on upstream dependencies

## Investigation Steps
1. Check p99/p50 in Grafana
2. Identify slow endpoints
3. Trace slow requests via trace_id
4. Check upstream dependencies: Redis, Postgres, external APIs
5. Look for connection pool exhaustion or GC pauses`,
	],
	[
		"/openfs/runbooks/postmortem-2025-05-redis.md",
		`# Postmortem: Redis OOM -- 2025-05-28

## Summary
prod-redis-1 ran out of memory due to unbounded session cache.
Login failures for 1h45m.

## Root Cause
Session keys stored without TTL. Session store grew from 2GB to 7.8GB.
Eviction policy was noeviction, so Redis refused all writes.

## Resolution
1. Set maxmemory-policy to volatile-lru
2. Added 24h TTL to all session keys
3. Patched auth service to include EX 86400 on session SET
4. Increased maxmemory to 12GB`,
	],
];

// ── Recursive tree builder ────────────────────────────────────────

interface TreeNode {
	name: string;
	path: string;
	is_dir: boolean;
	size: number | null;
	modified: string | null;
	backend: string | null;
	children?: TreeNode[];
}

const backendMap: Record<string, string> = {
	"/openfs/incidents": "postgres",
	"/openfs/oncall": "postgres",
	"/openfs/logs": "s3",
	"/openfs/runbooks": "chroma",
	"/openfs/scratch": "memory",
};

function getBackend(path: string): string | null {
	for (const [prefix, backend] of Object.entries(backendMap)) {
		if (path === prefix || path.startsWith(prefix + "/")) return backend;
	}
	return null;
}

async function buildTree(path: string): Promise<TreeNode[]> {
	let entries: Entry[];
	try {
		entries = await client.list(path);
	} catch {
		return [];
	}
	const nodes: TreeNode[] = [];
	for (const entry of entries) {
		const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
		const openfsPath = `/openfs${fullPath}`;
		const node: TreeNode = {
			name: entry.name,
			path: openfsPath,
			is_dir: entry.is_dir,
			size: entry.size,
			modified: entry.modified,
			backend: getBackend(openfsPath),
		};
		if (entry.is_dir) {
			node.children = await buildTree(fullPath);
		}
		nodes.push(node);
	}
	return nodes;
}

// ── HTTP handlers ─────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: Buffer) => (data += chunk));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

async function handleExec(
	req: http.IncomingMessage,
	res: http.ServerResponse,
) {
	const body = JSON.parse(await readBody(req));
	const cmd: string = body.cmd;
	try {
		const result = await bash.exec(cmd);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ stdout: "", stderr: msg }));
	}
}

async function handleTree(
	_req: http.IncomingMessage,
	res: http.ServerResponse,
) {
	const tree = await buildTree("/");
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(tree));
}

async function handleRead(
	req: http.IncomingMessage,
	res: http.ServerResponse,
) {
	const url = new URL(req.url!, `http://localhost:${PORT}`);
	const filePath = url.searchParams.get("path") ?? "";
	// Strip /openfs prefix for the client
	const openfsPath = filePath.startsWith("/openfs/") ? filePath.slice(7) : filePath;
	try {
		const content = await client.read(openfsPath);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ content }));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: msg }));
	}
}

// ── HTML ──────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenFS Incident Response</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-panel: #161b22;
    --bg-hover: #1c2333;
    --bg-selected: #1f2a3d;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #7d8590;
    --text-bright: #f0f6fc;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --blue: #58a6ff;
    --cyan: #56d4dd;
    --magenta: #bc8cff;
    --orange: #f0883e;
    --font-mono: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body { height: 100%; overflow: hidden; }

  body {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
  }

  /* ── Top bar ──────────────────────────── */

  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .topbar h1 {
    font-size: 14px;
    font-weight: 600;
    color: var(--cyan);
  }
  .topbar .scenario {
    font-size: 12px;
    color: var(--text-dim);
  }
  .topbar .scenario b { color: var(--red); font-weight: 600; }
  .topbar .badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
  }
  .badge-p1 { background: #f851493a; color: var(--red); }

  /* ── Main layout ──────────────────────── */

  .main {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  /* ── File tree (left) ─────────────────── */

  .sidebar {
    width: 300px;
    min-width: 240px;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .tree-container {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .tree-node {
    user-select: none;
  }

  .tree-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px 3px calc(8px + var(--depth, 0) * 16px);
    cursor: pointer;
    white-space: nowrap;
    border-radius: 4px;
    margin: 0 4px;
  }
  .tree-row:hover { background: var(--bg-hover); }
  .tree-row.selected { background: var(--bg-selected); }

  .tree-icon {
    width: 16px;
    text-align: center;
    flex-shrink: 0;
    font-size: 12px;
  }
  .tree-icon.dir { color: var(--blue); }
  .tree-icon.file { color: var(--text-dim); }

  .tree-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tree-name.dir { color: var(--text-bright); font-weight: 500; }

  .tree-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    font-weight: 500;
    flex-shrink: 0;
  }
  .badge-postgres { background: #58a6ff22; color: var(--blue); }
  .badge-s3 { background: #f0883e22; color: var(--orange); }
  .badge-chroma { background: #bc8cff22; color: var(--magenta); }
  .badge-memory { background: #3fb95022; color: var(--green); }

  .tree-meta {
    font-size: 11px;
    color: var(--text-dim);
    flex-shrink: 0;
    margin-left: 4px;
  }

  /* ── Right panel ──────────────────────── */

  .right {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* ── File viewer ──────────────────────── */

  .file-viewer {
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    display: none;
    flex-direction: column;
    max-height: 40%;
  }
  .file-viewer.open { display: flex; }

  .file-viewer-header {
    display: flex;
    align-items: center;
    padding: 6px 14px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    gap: 8px;
    flex-shrink: 0;
  }
  .file-viewer-header .path {
    flex: 1;
    font-size: 12px;
    color: var(--cyan);
  }
  .file-viewer-header .close-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 16px;
    padding: 0 4px;
    line-height: 1;
  }
  .file-viewer-header .close-btn:hover { color: var(--text); }
  .file-viewer-header .cat-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .file-viewer-header .cat-btn:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }

  .file-content {
    flex: 1;
    overflow: auto;
    padding: 10px 14px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    background: var(--bg);
  }
  .file-content .line-num {
    display: inline-block;
    width: 3ch;
    text-align: right;
    margin-right: 12px;
    color: var(--text-dim);
    user-select: none;
  }

  /* ── Terminal ─────────────────────────── */

  .terminal {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .terminal-header {
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .terminal-output {
    flex: 1;
    overflow-y: auto;
    padding: 8px 14px;
    font-size: 13px;
    line-height: 1.55;
  }

  .term-line { white-space: pre-wrap; word-break: break-all; }
  .term-cmd { color: var(--text-bright); }
  .term-cmd .prompt { color: var(--green); font-weight: 700; }
  .term-cmd .cmd-text { font-weight: 500; }
  .term-stdout { color: var(--text); }
  .term-stderr { color: var(--red); }
  .term-info { color: var(--text-dim); font-style: italic; }

  /* log-level highlighting in output */
  .log-error { color: var(--red); }
  .log-warn { color: var(--yellow); }
  .log-info { color: var(--text-dim); }

  .terminal-input-row {
    display: flex;
    align-items: center;
    padding: 6px 14px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    gap: 6px;
    flex-shrink: 0;
  }
  .terminal-input-row .prompt-label {
    color: var(--green);
    font-weight: 700;
    flex-shrink: 0;
  }
  .terminal-input-row input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-bright);
    font-family: var(--font-mono);
    font-size: 13px;
    caret-color: var(--green);
  }
  .terminal-input-row .spinner {
    display: none;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--cyan);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  .terminal-input-row .spinner.active { display: block; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Sample commands bar ──────────────── */

  .samples-bar {
    padding: 6px 14px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .sample-btn {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .sample-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
    border-color: var(--text-dim);
  }

  /* ── Scrollbar ────────────────────────── */

  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
</style>
</head>
<body>

<div class="topbar">
  <h1>OpenFS Incident Response</h1>
  <span class="badge badge-p1">P1</span>
  <span class="scenario">Redis OOM on <b>prod-redis-3</b> &mdash; 2025-06-15 09:45 UTC</span>
</div>

<div class="main">
  <!-- File tree -->
  <div class="sidebar">
    <div class="sidebar-header">File Explorer</div>
    <div class="tree-container" id="tree"></div>
  </div>

  <!-- Right: file viewer + terminal -->
  <div class="right">
    <div class="file-viewer" id="fileViewer">
      <div class="file-viewer-header">
        <span class="path" id="viewerPath"></span>
        <button class="cat-btn" id="catBtn" title="Run in terminal">cat</button>
        <button class="close-btn" id="closeViewer">&times;</button>
      </div>
      <div class="file-content" id="viewerContent"></div>
    </div>

    <div class="terminal">
      <div class="terminal-header">Terminal</div>
      <div class="terminal-output" id="output"></div>
      <div class="samples-bar" id="samplesBar"></div>
      <div class="terminal-input-row">
        <span class="prompt-label">incident$</span>
        <input type="text" id="cmdInput" autofocus spellcheck="false" placeholder="type a command...">
        <div class="spinner" id="spinner"></div>
      </div>
    </div>
  </div>
</div>

<script>
const output = document.getElementById('output');
const cmdInput = document.getElementById('cmdInput');
const spinner = document.getElementById('spinner');
const tree = document.getElementById('tree');
const fileViewer = document.getElementById('fileViewer');
const viewerPath = document.getElementById('viewerPath');
const viewerContent = document.getElementById('viewerContent');
const closeViewer = document.getElementById('closeViewer');
const catBtn = document.getElementById('catBtn');
const samplesBar = document.getElementById('samplesBar');

let history = [];
let historyIdx = -1;
let currentViewerPath = '';
let running = false;

// ── Sample commands ─────────────────────────────────

const samples = [
  'cat /openfs/incidents/open.csv | grep P1',
  'cat /openfs/oncall/schedule.csv | grep infra',
  'search "redis memory OOM"',
  'openfsgrep ERROR /logs/redis-2025-06-15.log',
  'cat /openfs/logs/redis-2025-06-15.log | grep OOM | wc -l',
  'openfsgrep prod-redis-3 /logs/api-gateway-2025-06-15.log',
  'stat /openfs/incidents/open.csv',
];

for (const s of samples) {
  const btn = document.createElement('button');
  btn.className = 'sample-btn';
  btn.textContent = s;
  btn.onclick = () => runCmd(s);
  samplesBar.appendChild(btn);
}

// ── Terminal ────────────────────────────────────────

function appendLine(html, cls) {
  const div = document.createElement('div');
  div.className = 'term-line ' + (cls || '');
  div.innerHTML = html;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function highlightOutput(text) {
  return text.split('\\n').map(line => {
    const escaped = escapeHtml(line);
    if (/\\bERROR\\b/.test(line)) return '<span class="log-error">' + escaped + '</span>';
    if (/\\bWARN\\b/.test(line)) return '<span class="log-warn">' + escaped + '</span>';
    return escaped;
  }).join('\\n');
}

async function runCmd(cmd) {
  if (running) return;
  if (!cmd.trim()) return;
  running = true;

  history.push(cmd);
  historyIdx = history.length;

  appendLine('<span class="prompt">incident$ </span><span class="cmd-text">' + escapeHtml(cmd) + '</span>', 'term-cmd');
  spinner.classList.add('active');
  cmdInput.disabled = true;

  try {
    const res = await fetch('/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
    const data = await res.json();
    if (data.stdout && data.stdout.trim()) {
      appendLine(highlightOutput(data.stdout.trimEnd()), 'term-stdout');
    }
    if (data.stderr && data.stderr.trim()) {
      appendLine(escapeHtml(data.stderr.trimEnd()), 'term-stderr');
    }
  } catch (err) {
    appendLine('fetch error: ' + escapeHtml(err.message), 'term-stderr');
  }

  spinner.classList.remove('active');
  cmdInput.disabled = false;
  cmdInput.value = '';
  cmdInput.focus();
  running = false;

  // Refresh tree in case files were created/deleted
  loadTree();
}

cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    runCmd(cmdInput.value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (historyIdx > 0) {
      historyIdx--;
      cmdInput.value = history[historyIdx];
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIdx < history.length - 1) {
      historyIdx++;
      cmdInput.value = history[historyIdx];
    } else {
      historyIdx = history.length;
      cmdInput.value = '';
    }
  }
});

// ── File tree ───────────────────────────────────────

const backendColors = {
  postgres: 'badge-postgres',
  s3: 'badge-s3',
  chroma: 'badge-chroma',
  memory: 'badge-memory',
};

const fileIcons = {
  csv: '\u{1F4CA}',
  log: '\u{1F4C4}',
  md:  '\u{1F4DD}',
};

function getIcon(name, isDir) {
  if (isDir) return '\u{1F4C1}';
  const ext = name.split('.').pop();
  return fileIcons[ext] || '\u{1F4C4}';
}

function formatSize(size, backend) {
  if (size == null) return '';
  if (backend === 'postgres') return size + ' rows';
  if (size < 1024) return size + ' B';
  return (size / 1024).toFixed(1) + ' KB';
}

function renderTree(nodes, container, depth) {
  for (const node of nodes) {
    const el = document.createElement('div');
    el.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.setProperty('--depth', depth);

    const icon = document.createElement('span');
    icon.className = 'tree-icon ' + (node.is_dir ? 'dir' : 'file');
    icon.textContent = getIcon(node.name, node.is_dir);
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'tree-name' + (node.is_dir ? ' dir' : '');
    name.textContent = node.name;
    row.appendChild(name);

    if (node.backend && depth === 0) {
      const badge = document.createElement('span');
      badge.className = 'tree-badge ' + (backendColors[node.backend] || '');
      badge.textContent = node.backend;
      row.appendChild(badge);
    }

    if (!node.is_dir && node.size != null) {
      const meta = document.createElement('span');
      meta.className = 'tree-meta';
      meta.textContent = formatSize(node.size, node.backend);
      row.appendChild(meta);
    }

    el.appendChild(row);

    if (node.is_dir && node.children) {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      renderTree(node.children, childContainer, depth + 1);
      el.appendChild(childContainer);

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        childContainer.style.display = childContainer.style.display === 'none' ? '' : 'none';
        icon.textContent = childContainer.style.display === 'none' ? '\u{1F4C1}' : '\u{1F4C2}';
      });
      // Start expanded
      icon.textContent = '\u{1F4C2}';
    } else if (!node.is_dir) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        openFile(node.path, node.backend);
        // highlight
        document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
      });
    }

    container.appendChild(el);
  }
}

async function loadTree() {
  try {
    const res = await fetch('/tree');
    const nodes = await res.json();
    tree.innerHTML = '';
    renderTree(nodes, tree, 0);
  } catch (err) {
    tree.innerHTML = '<div style="padding:14px;color:var(--red)">Failed to load tree</div>';
  }
}

// ── File viewer ─────────────────────────────────────

async function openFile(path, backend) {
  currentViewerPath = path;
  viewerPath.textContent = path;
  if (backend) {
    viewerPath.innerHTML = escapeHtml(path) + ' <span style="color:var(--text-dim);font-size:11px">(' + backend + ')</span>';
  }
  viewerContent.textContent = 'Loading...';
  fileViewer.classList.add('open');

  try {
    const res = await fetch('/read?path=' + encodeURIComponent(path));
    const data = await res.json();
    if (data.error) {
      viewerContent.innerHTML = '<span style="color:var(--red)">' + escapeHtml(data.error) + '</span>';
    } else {
      const lines = data.content.split('\\n');
      viewerContent.innerHTML = lines.map((line, i) =>
        '<span class="line-num">' + (i + 1) + '</span>' + highlightOutput(line)
      ).join('\\n');
    }
  } catch (err) {
    viewerContent.innerHTML = '<span style="color:var(--red)">fetch error: ' + escapeHtml(err.message) + '</span>';
  }
}

closeViewer.addEventListener('click', () => {
  fileViewer.classList.remove('open');
  currentViewerPath = '';
  document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
});

catBtn.addEventListener('click', () => {
  if (currentViewerPath) runCmd('cat ' + currentViewerPath);
});

// ── Init ────────────────────────────────────────────

loadTree();
appendLine('<span class="term-info">Incident response environment ready. Click files or type commands below.</span>', 'term-info');

cmdInput.focus();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────

async function main() {
	await openFs.init();
	for (const [path, content] of seeds) {
		await bash.exec(`cat > ${path} << 'SEED'\n${content}\nSEED`);
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url!, `http://localhost:${PORT}`);

		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(HTML);
		} else if (req.method === "POST" && url.pathname === "/exec") {
			await handleExec(req, res);
		} else if (req.method === "GET" && url.pathname === "/tree") {
			await handleTree(req, res);
		} else if (req.method === "GET" && url.pathname === "/read") {
			await handleRead(req, res);
		} else {
			res.writeHead(404);
			res.end("Not found");
		}
	});

	// Find an open port, starting from PORT
	await new Promise<void>((resolve, reject) => {
		let port = PORT;
		const tryListen = () => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE" && port < PORT + 20) {
					port++;
					tryListen();
				} else {
					reject(err);
				}
			});
			server.listen(port, () => {
				console.log(`\n  OpenFS Incident Response Web UI`);
				console.log(`  http://localhost:${port}\n`);
				resolve();
			});
		};
		tryListen();
	});
}

main().catch((err) => {
	console.error("Server failed:", err);
	process.exit(1);
});
