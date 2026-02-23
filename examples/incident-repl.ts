/**
 * Interactive Incident Response REPL
 *
 * Boots the incident-response environment (five backends with realistic
 * seed data), then drops you into an SRE triage shell.
 *
 * Run:
 *   npx tsx examples/incident-repl.ts
 */
import * as readline from "node:readline";
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OpenFs } from "../src/openfs.js";
import { createSearchCommand } from "../src/search.js";
import { createGrepCommand } from "../src/grep.js";
import { createConfigurableMock, header, c } from "./_mock-backends.js";

/** Colorize a sample command: bold white command, dim gray description after — */
function cmd(text: string): string {
	const dashIdx = text.indexOf(" — ");
	if (dashIdx !== -1) {
		return `${c.white}${c.bold}${text.slice(0, dashIdx)}${c.reset}${c.dim} — ${text.slice(dashIdx + 3)}${c.reset}`;
	}
	return `${c.white}${c.bold}${text}${c.reset}`;
}

/** Dim comment line */
function comment(text: string): string {
	return `${c.dim}${text}${c.reset}`;
}

/** Backend label: colored name + dim description */
function backend(path: string, type: string, desc: string): string {
	return `    ${c.cyan}${c.bold}${path}${c.reset}  ${c.yellow}${type}${c.reset}   ${c.dim}${desc}${c.reset}`;
}

async function main() {
	header("OpenFS Incident Response REPL");
	console.log(`  Scenario: ${c.bold}Redis OOM alert${c.reset} on ${c.red}prod-redis-3${c.reset}. You're on-call.`);
	console.log(`  Type ${c.bold}'help'${c.reset} for example commands, ${c.bold}'exit'${c.reset} to quit.\n`);

	const client = createConfigurableMock([
		{ prefix: "/incidents", backend: "postgres" },
		{ prefix: "/oncall", backend: "postgres" },
		{ prefix: "/logs", backend: "s3" },
		{ prefix: "/runbooks", backend: "chroma" },
		{ prefix: "/scratch", backend: "memory" },
	]);

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
			createGrepCommand(client, "/openfs"),
		],
	});

	// Seed all incident data
	const seeds: [string, string][] = [
		["/openfs/incidents/open.csv", `id,severity,status,assignee,title,created_at
INC-001,P1,open,,Redis OOM on prod-redis-3,2025-06-15T09:45:00Z
INC-002,P2,investigating,alice,API latency spike p99 > 2s,2025-06-15T08:30:00Z
INC-003,P3,open,,Stale cache entries in CDN,2025-06-14T16:00:00Z`],
		["/openfs/incidents/closed.csv", `id,severity,status,assignee,title,created_at,resolved_at
INC-098,P2,resolved,bob,Database connection pool exhaustion,2025-06-10T14:00:00Z,2025-06-10T15:30:00Z
INC-099,P1,resolved,carol,Redis OOM on prod-redis-1,2025-05-28T03:00:00Z,2025-05-28T04:45:00Z`],
		["/openfs/oncall/schedule.csv", `team,primary,secondary,start,end
infra,bob,carol,2025-06-15,2025-06-22
platform,alice,dave,2025-06-15,2025-06-22
data,eve,frank,2025-06-15,2025-06-22`],
		["/openfs/logs/redis-2025-06-15.log", `2025-06-15T09:30:01Z INFO  prod-redis-3 connected_clients=142 used_memory=6.1G maxmemory=8G
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
2025-06-15T09:45:05Z INFO  pagerduty incident created for on-call team=infra`],
		["/openfs/logs/api-gateway-2025-06-15.log", `2025-06-15T09:40:12Z INFO  api-gw request_id=a1b2 POST /api/login 200 45ms
2025-06-15T09:41:00Z INFO  api-gw request_id=c3d4 GET /api/profile 200 12ms
2025-06-15T09:42:02Z ERROR api-gw request_id=e5f6 POST /api/login 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:42:10Z ERROR api-gw request_id=g7h8 POST /api/login 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:42:30Z ERROR api-gw request_id=i9j0 GET /api/session 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:43:00Z WARN  api-gw circuit_breaker=open for upstream=prod-redis-3 failures=15/20
2025-06-15T09:43:01Z ERROR api-gw request_id=k1l2 POST /api/login 503 circuit_breaker=open
2025-06-15T09:44:00Z ERROR api-gw error_rate=34% for path=/api/login in last 5m`],
		["/openfs/runbooks/redis-oom.md", `# Runbook: Redis OOM Recovery

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
3. Consider adding a replica for read offload`],
		["/openfs/runbooks/latency-troubleshooting.md", `# Runbook: API Latency Investigation

## Symptoms
- p99 latency exceeds SLO (e.g., > 2 seconds)
- Elevated error rates on upstream dependencies

## Investigation Steps
1. Check p99/p50 in Grafana
2. Identify slow endpoints
3. Trace slow requests via trace_id
4. Check upstream dependencies: Redis, Postgres, external APIs
5. Look for connection pool exhaustion or GC pauses`],
		["/openfs/runbooks/postmortem-2025-05-redis.md", `# Postmortem: Redis OOM — 2025-05-28

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
4. Increased maxmemory to 12GB`],
	];

	for (const [path, content] of seeds) {
		await bash.exec(`cat > ${path} << 'SEED'\n${content}\nSEED`);
	}

	console.log("  Backends:");
	console.log(backend("/openfs/incidents/", "Postgres", "(incident records)"));
	console.log(backend("/openfs/oncall/    ", "Postgres", "(on-call schedule)"));
	console.log(backend("/openfs/logs/      ", "S3      ", "(log dumps — no append!)"));
	console.log(backend("/openfs/runbooks/  ", "Chroma  ", "(searchable runbooks)"));
	console.log(backend("/openfs/scratch/   ", "Memory  ", "(triage workspace)"));
	console.log();
	console.log(`  ${c.bold}Try these${c.reset} ${c.dim}(copy-paste any line):${c.reset}`);
	console.log(`  ${c.dim}${"─".repeat(55)}${c.reset}`);
	console.log();
	console.log(`  ${comment("# Orient yourself")}`);
	console.log(`  ${cmd("ls /openfs")}`);
	console.log(`  ${cmd("ls /openfs/incidents")}`);
	console.log(`  ${cmd("ls /openfs/logs")}`);
	console.log(`  ${cmd("ls /openfs/runbooks")}`);
	console.log();
	console.log(`  ${comment("# Find the P1 incident")}`);
	console.log(`  ${cmd("cat /openfs/incidents/open.csv")}`);
	console.log(`  ${cmd("cat /openfs/incidents/open.csv | grep P1")}`);
	console.log();
	console.log(`  ${comment("# Who's on call for infra?")}`);
	console.log(`  ${cmd("cat /openfs/oncall/schedule.csv")}`);
	console.log(`  ${cmd("cat /openfs/oncall/schedule.csv | grep infra")}`);
	console.log();
	console.log(`  ${comment("# Search for a runbook (semantic search — Chroma only)")}`);
	console.log(`  ${cmd('search "redis memory OOM"')}`);
	console.log(`  ${cmd('search "latency troubleshooting"')}`);
	console.log();
	console.log(`  ${comment("# Read the runbook")}`);
	console.log(`  ${cmd("cat /openfs/runbooks/redis-oom.md")}`);
	console.log(`  ${cmd("cat /openfs/runbooks/postmortem-2025-05-redis.md")}`);
	console.log();
	console.log(`  ${comment("# Dig into logs")}`);
	console.log(`  ${cmd("grep ERROR /openfs/logs/redis-2025-06-15.log")}`);
	console.log(`  ${cmd("cat /openfs/logs/redis-2025-06-15.log | grep OOM | wc -l")}`);
	console.log(`  ${cmd("cat /openfs/logs/redis-2025-06-15.log | grep WARN")}`);
	console.log();
	console.log(`  ${comment("# Correlate — API gateway impact from Redis OOM")}`);
	console.log(`  ${cmd("grep prod-redis-3 /openfs/logs/api-gateway-2025-06-15.log")}`);
	console.log(`  ${cmd("grep 503 /openfs/logs/api-gateway-2025-06-15.log")}`);
	console.log(`  ${cmd("cat /openfs/logs/api-gateway-2025-06-15.log | grep error_rate")}`);
	console.log();
	console.log(`  ${comment("# Check past incidents")}`);
	console.log(`  ${cmd("cat /openfs/incidents/closed.csv")}`);
	console.log(`  ${cmd("cat /openfs/incidents/closed.csv | grep Redis")}`);
	console.log();
	console.log(`  ${comment("# Write triage notes to scratch (memory — ephemeral)")}`);
	console.log(`  ${cmd('echo "Root cause: unbounded session keys, same as INC-099" > /openfs/scratch/notes.md')}`);
	console.log(`  ${cmd("cat /openfs/scratch/notes.md")}`);
	console.log();
	console.log(`  ${comment("# Write postmortem to S3")}`);
	console.log(`  ${cmd('echo "# Postmortem INC-001: Redis OOM" > /openfs/logs/postmortem-INC-001.md')}`);
	console.log(`  ${cmd("cat /openfs/logs/postmortem-INC-001.md")}`);
	console.log();
	console.log(`  ${comment("# S3 doesn't support append — try it:")}`);
	console.log(`  ${cmd('echo "addendum" >> /openfs/logs/postmortem-INC-001.md')}`);
	console.log();
	console.log(`  ${comment("# Backend-specific stat (row count vs byte size vs no mtime)")}`);
	console.log(`  ${cmd("stat /openfs/incidents/open.csv")}`);
	console.log(`  ${cmd("stat /openfs/logs/redis-2025-06-15.log")}`);
	console.log(`  ${cmd("stat /openfs/runbooks/redis-oom.md")}`);
	console.log();
	console.log(`  ${c.dim}${"─".repeat(55)}${c.reset}`);
	console.log(`  Type ${c.bold}'help'${c.reset} for a compact cheat sheet, ${c.bold}'exit'${c.reset} to quit.\n`);

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const prompt = () => {
		if (process.stdin.isTTY) process.stdout.write(`${c.green}${c.bold}incident$${c.reset} `);
	};

	prompt();

	for await (const line of rl) {
		const cmd = line.trim();
		if (!cmd) {
			prompt();
			continue;
		}

		if (cmd === "exit" || cmd === "quit") {
			console.log(`${c.dim}bye${c.reset}`);
			break;
		}

		if (cmd === "help") {
			console.log(`\n  ${c.bold}${c.cyan}Triage workflow:${c.reset}`);
			console.log(`    ${c.white}${c.bold}cat /openfs/incidents/open.csv | grep P1${c.reset}    ${c.dim}— find the critical incident${c.reset}`);
			console.log(`    ${c.white}${c.bold}cat /openfs/oncall/schedule.csv | grep infra${c.reset} ${c.dim}— who's on call?${c.reset}`);
			console.log(`    ${c.white}${c.bold}search "redis memory OOM"${c.reset}               ${c.dim}— find relevant runbooks${c.reset}`);
			console.log(`    ${c.white}${c.bold}cat /openfs/runbooks/redis-oom.md${c.reset}           ${c.dim}— read the runbook${c.reset}`);
			console.log(`    ${c.white}${c.bold}grep ERROR /openfs/logs/redis-2025-06-15.log${c.reset} ${c.dim}— grep log errors${c.reset}`);
			console.log(`    ${c.white}${c.bold}cat /openfs/logs/redis-2025-06-15.log | grep OOM | wc -l${c.reset}`);
			console.log(`    ${c.white}${c.bold}grep prod-redis-3 /openfs/logs/api-gateway-2025-06-15.log${c.reset}`);
			console.log(`    ${c.white}${c.bold}echo "notes..." > /openfs/scratch/triage.md${c.reset} ${c.dim}— write scratch notes${c.reset}`);
			console.log(`    ${c.white}${c.bold}stat /openfs/incidents/open.csv${c.reset}             ${c.dim}— Postgres row-count size${c.reset}`);
			console.log(`    ${c.white}${c.bold}stat /openfs/logs/redis-2025-06-15.log${c.reset}     ${c.dim}— S3 byte size${c.reset}`);
			console.log(`    ${c.white}${c.bold}exit${c.reset}                                    ${c.dim}— quit${c.reset}\n`);
			prompt();
			continue;
		}

		try {
			const result = await bash.exec(cmd);
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(`${c.red}${result.stderr}${c.reset}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`${c.red}error: ${msg}${c.reset}`);
		}

		prompt();
	}
}

main().catch((err) => {
	console.error("REPL failed:", err);
	process.exit(1);
});
