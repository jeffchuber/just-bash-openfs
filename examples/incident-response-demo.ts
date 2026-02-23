/**
 * Incident Response Demo
 *
 * An SRE triages a production incident using shell commands routed to
 * different storage backends: Postgres for structured data, S3 for logs,
 * Chroma for searchable runbooks, and memory for scratch notes.
 *
 * Run:
 *   npx tsx examples/incident-response-demo.ts
 */
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { OpenFs } from "../src/openfs.js";
import { createSearchCommand } from "../src/search.js";
import { createGrepCommand } from "../src/grep.js";
import { createConfigurableMock, run, header } from "./_mock-backends.js";

async function main() {
	header("OpenFS Incident Response Demo");
	console.log("  Scenario: Redis OOM alert fires at 09:45 UTC.");
	console.log("  You're the on-call SRE. Triage using shell commands.\n");

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

	// ── 1. Orientation ─────────────────────────────────────────────

	header("1. Orientation — incident response workspace");
	console.log("  /openfs/incidents/  Postgres   Structured incident records (CSV)");
	console.log("  /openfs/oncall/     Postgres   On-call rotation schedule");
	console.log("  /openfs/logs/       S3         Raw log dumps (no append)");
	console.log("  /openfs/runbooks/   Chroma     Searchable runbooks & postmortems");
	console.log("  /openfs/scratch/    Memory     Ephemeral triage workspace\n");
	await run(bash, "ls /openfs");

	// ── 2. Seed data ───────────────────────────────────────────────

	header("2. Seed data — populating all backends");

	await bash.exec(`cat > /openfs/incidents/open.csv << 'EOF'
id,severity,status,assignee,title,created_at
INC-001,P1,open,,Redis OOM on prod-redis-3,2025-06-15T09:45:00Z
INC-002,P2,investigating,alice,API latency spike p99 > 2s,2025-06-15T08:30:00Z
INC-003,P3,open,,Stale cache entries in CDN,2025-06-14T16:00:00Z
EOF`);
	await bash.exec(`cat > /openfs/incidents/closed.csv << 'EOF'
id,severity,status,assignee,title,created_at,resolved_at
INC-098,P2,resolved,bob,Database connection pool exhaustion,2025-06-10T14:00:00Z,2025-06-10T15:30:00Z
INC-099,P1,resolved,carol,Redis OOM on prod-redis-1,2025-05-28T03:00:00Z,2025-05-28T04:45:00Z
EOF`);
	await bash.exec(`cat > /openfs/oncall/schedule.csv << 'EOF'
team,primary,secondary,start,end
infra,bob,carol,2025-06-15,2025-06-22
platform,alice,dave,2025-06-15,2025-06-22
data,eve,frank,2025-06-15,2025-06-22
EOF`);
	await bash.exec(`cat > /openfs/logs/redis-2025-06-15.log << 'EOF'
2025-06-15T09:30:01Z INFO  prod-redis-3 connected_clients=142 used_memory=6.1G maxmemory=8G
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
2025-06-15T09:45:05Z INFO  pagerduty incident created for on-call team=infra
EOF`);
	await bash.exec(`cat > /openfs/logs/api-gateway-2025-06-15.log << 'EOF'
2025-06-15T09:40:12Z INFO  api-gw request_id=a1b2 POST /api/login 200 45ms
2025-06-15T09:41:00Z INFO  api-gw request_id=c3d4 GET /api/profile 200 12ms
2025-06-15T09:42:02Z ERROR api-gw request_id=e5f6 POST /api/login 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:42:10Z ERROR api-gw request_id=g7h8 POST /api/login 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:42:30Z ERROR api-gw request_id=i9j0 GET /api/session 503 timeout=5000ms upstream=prod-redis-3
2025-06-15T09:43:00Z WARN  api-gw circuit_breaker=open for upstream=prod-redis-3 failures=15/20
2025-06-15T09:43:01Z ERROR api-gw request_id=k1l2 POST /api/login 503 circuit_breaker=open
2025-06-15T09:44:00Z ERROR api-gw error_rate=34% for path=/api/login in last 5m
EOF`);
	await bash.exec(`cat > /openfs/runbooks/redis-oom.md << 'EOF'
# Runbook: Redis OOM Recovery

## Symptoms
- Redis returns OOM errors on write commands
- Clients receive connection refused or timeout
- Alert: redis_oom_critical

## Diagnosis
1. Check current memory: redis-cli INFO memory | grep used_memory_human
2. Identify hot keys: redis-cli --hotkeys (requires latency-monitor-threshold > 0)
3. Check eviction policy: redis-cli CONFIG GET maxmemory-policy

## Immediate Mitigation
1. If eviction=noeviction, set volatile-lru: redis-cli CONFIG SET maxmemory-policy volatile-lru
2. Flush expired keys: redis-cli --scan --pattern 'session:*' | head -100
3. If session cache is unbounded, add TTL: ensure all SET commands include EX/PX

## Scaling
1. Increase maxmemory if headroom allows: redis-cli CONFIG SET maxmemory 12G
2. For persistent fix, update redis.conf and restart during maintenance window
3. Consider adding a replica for read offload

## Prevention
- Set maxmemory-policy to allkeys-lru or volatile-lru
- Monitor used_memory_rss with alerting at 75% threshold
- Enforce TTL on all session/cache keys in application code
EOF`);
	await bash.exec(`cat > /openfs/runbooks/latency-troubleshooting.md << 'EOF'
# Runbook: API Latency Investigation

## Symptoms
- p99 latency exceeds SLO (e.g., > 2 seconds)
- Elevated error rates on upstream dependencies

## Investigation Steps
1. Check p99/p50 in Grafana: dashboard/api-latency
2. Identify slow endpoints: sort by p99 descending
3. Trace a slow request: find trace_id in logs, follow through spans
4. Check upstream dependencies: Redis, Postgres, external APIs
5. Look for connection pool exhaustion or GC pauses

## Common Causes
- Database slow queries (missing index, lock contention)
- Redis OOM or network partition
- Upstream API degradation
- DNS resolution delays
- Thread pool exhaustion in application server
EOF`);
	await bash.exec(`cat > /openfs/runbooks/postmortem-2025-05-redis.md << 'EOF'
# Postmortem: Redis OOM — 2025-05-28

## Summary
prod-redis-1 ran out of memory at 03:00 UTC due to unbounded session cache.
User-facing login failures for 1h45m until resolved.

## Root Cause
Session keys were being stored without TTL. Over 2 weeks the session store grew
from 2GB to 7.8GB, exceeding the 8GB maxmemory limit. The eviction policy was
set to noeviction, so Redis refused all write commands once memory was full.

## Resolution
1. Immediately set maxmemory-policy to volatile-lru
2. Added 24h TTL to all existing session keys via batch script
3. Patched application code to include EX 86400 on all session SET commands
4. Increased maxmemory to 12GB as buffer

## Action Items
- [DONE] Add TTL to all session writes in auth service
- [DONE] Change default eviction policy to volatile-lru in redis.conf
- [DONE] Add memory usage alerting at 75% threshold
- [TODO] Implement session store migration to dedicated Redis cluster
EOF`);

	console.log("  All backends populated with incident data.\n");

	// ── 3. Alert fires: triage ─────────────────────────────────────

	header("3. Alert fires — identify the P1 incident");
	await run(bash, "cat /openfs/incidents/open.csv | grep P1");

	// ── 4. Who's on call? ──────────────────────────────────────────

	header("4. Who's on call? — find the infra team primary");
	await run(bash, "cat /openfs/oncall/schedule.csv | grep infra");

	// ── 5. Search for a runbook ────────────────────────────────────

	header("5. Search for a runbook — semantic search across /runbooks/");
	await run(bash, 'search "redis memory OOM"');

	// ── 6. Read the runbook ────────────────────────────────────────

	header("6. Read the runbook — step-by-step recovery");
	await run(bash, "cat /openfs/runbooks/redis-oom.md");

	// ── 7. Dig into logs ───────────────────────────────────────────

	header("7. Dig into logs — grep for errors in Redis log");
	await run(bash, "grep ERROR /openfs/logs/redis-2025-06-15.log");
	console.log("  Count OOM occurrences:\n");
	await run(bash, "cat /openfs/logs/redis-2025-06-15.log | grep OOM | wc -l");

	// ── 8. Correlate across backends ───────────────────────────────

	header("8. Correlate across backends — API gateway impact");
	await run(bash, "grep prod-redis-3 /openfs/logs/api-gateway-2025-06-15.log");
	console.log("  Cross-reference: has this happened before?\n");
	await run(bash, "cat /openfs/incidents/closed.csv | grep Redis");

	// ── 9. Write triage notes ──────────────────────────────────────

	header("9. Write triage notes — scratch workspace");
	await run(bash, `echo "# INC-001 Triage Notes
Timeline:
- 09:38 memory warning at 85%
- 09:42 first OOM errors
- 09:43 API gateway circuit breaker opens
- 09:45 alert fires, pagerduty triggered

Impact: login failures, 34% error rate on /api/login
Root cause: likely unbounded session keys (same as INC-099)
Action: set volatile-lru eviction, add TTL to sessions" > /openfs/scratch/triage-INC-001.md`);
	await run(bash, "cat /openfs/scratch/triage-INC-001.md");

	// ── 10. Write postmortem to S3 ─────────────────────────────────

	header("10. Write postmortem to S3 — persist findings");
	await run(bash, `echo "# Postmortem: INC-001 Redis OOM — 2025-06-15
Same root cause as INC-099: unbounded session cache.
Resolved by setting volatile-lru and adding TTL." > /openfs/logs/postmortem-INC-001.md`);
	await run(bash, "cat /openfs/logs/postmortem-INC-001.md");

	// ── 11. S3 append error ────────────────────────────────────────

	header("11. S3 limitation — append not supported");
	console.log("  S3 is object storage — you must rewrite the whole object:\n");
	try {
		await run(bash, 'echo "addendum: confirmed fix deployed" >> /openfs/logs/postmortem-INC-001.md');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  (error) ${msg}\n`);
	}

	// ── 12. Backend-specific stat ──────────────────────────────────

	header("12. Backend-specific stat metadata");
	console.log("  Postgres (/incidents/) — size = row count:\n");
	await run(bash, "stat /openfs/incidents/open.csv");

	console.log("  S3 (/logs/) — size = byte count, has mtime:\n");
	await run(bash, "stat /openfs/logs/redis-2025-06-15.log");

	console.log("  Chroma (/runbooks/) — no mtime (vector store):\n");
	await run(bash, "stat /openfs/runbooks/redis-oom.md");

	header("Incident triaged!");
	console.log("  INC-001 assigned to bob (infra primary on-call).");
	console.log("  Runbook followed, logs analyzed, postmortem written.\n");
}

main().catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
