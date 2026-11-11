![Training Job Queue](assets/banner.svg)

# Training Job Queue

A PostgreSQL-backed queue for training jobs. Work is simulated; a database effect records whether it really ran.

## Problem

Clients create jobs, check status, list jobs, and cancel work. Requests can be retried; workers can crash or return late; cancellation can race with completion. The service must keep acknowledged jobs, reject stale results, and avoid duplicate committed effects.

## Verdict

**SHIP at 100 requests per second for the tested workload.** In the 10-minute run, all 60,000 requests completed at 100 RPS, p99 was 21.57 ms, and the queue drained. All ten 10,000-job chaos runs passed with eight workers.

The assessment gives no latency threshold. **200 ms p99 is our project target.** This is a test verdict, not approval to deploy: tests used one host and simulated work.

## Solution

PostgreSQL stores jobs and serves as the durable queue. The API commits each job and its idempotency key before acknowledging it. Eight workers claim jobs with time-limited leases. A reaper recovers expired leases; a fencing check rejects stale workers. Success and the countable database effect commit in one transaction.

Execution may repeat after a crash. A successful job commits one database effect. This does not promise exactly-once effects in external systems.

### Current flow

```mermaid
flowchart LR
  C[Client] -->|Create + key, status, list, cancel| A[Fastify API]
  A -->|Commit job or read/update state| DB[(PostgreSQL)]
  W1[Worker 1] -->|Poll and claim with lease| DB
  W2[Worker 2] -->|Poll and claim with lease| DB
  WN[Workers 3–8] -->|Poll and claim with lease| DB
  W1 -->|Fenced completion + one DB effect| DB
  R[Lease reaper] -->|Recover expired jobs| DB
```

Redis, BullMQ, the cache, and the event relay are not in the current runtime.

## Three problems and their fixes

### 1. Pagination missed a late commit — Phase 6 / Phase 7

A transaction could start first, receive an earlier creation time, and commit after a later job. If a client had already paged past that position, the late job could be missed in that page walk. The [original probe](runs/pagination-probe-2026-11-10/output.log) reproduces it.

**Phase 6 fix:** serialize inserts through one PostgreSQL clock row. This prevented the tested ordering, but made every insert wait for the same lock.

**Phase 7 fix:** remove the shared lock and define pagination as a live keyset listing. Pages do not share a database snapshot. Jobs committed during a page walk may appear after the client starts a fresh listing; they remain in PostgreSQL. The task requires pagination, not a cross-request snapshot.

### 2. High latency and growing outbox — Phase 6 / Phase 7

The old Redis/outbox design completed 60,000 requests at 100 RPS but had **1,027 ms p99**. After 121.7 seconds of draining, **60,049 events remained**. The [raw failure](runs/load-2026-11-11T06-20-47-486Z-f8bda9/summary.json) shows an end-to-end bottleneck; it does not prove Redis alone caused it because the insert lock and relay were also in the path.

**Phase 7 fix:** remove Redis cache/events, relay, outbox writes, and the shared insert lock. PostgreSQL now handles the queue directly. The new 10-minute run completed 60,000/60,000 requests with **8.56 ms p50**, **21.57 ms p99**, no errors, and a **0.10-second drain**. [Raw run](runs/load-2026-11-11T08-08-50-100Z-ad8eb8/).

### 3. Failure tests had blind spots — early phases / Phase 7

An early chaos rehearsal left killed workers stopped. An early fence mutation survived because random timing did not reliably create a stale-worker case. The first clock probe failed during startup, before testing the clock.

**Fix:** restart killed workers, add a deterministic stale-fence probe, and wait for API health before the clock check. The fence mutation is now detected; the updated clock and READ COMMITTED probes pass. SERIALIZABLE is not an application-supported mode. The [ten-seed chaos batch](runs/batch-2026-11-11T08-39-58-339Z-7be870/batch-summary.json), [expected fence-mutation failure](runs/mutation-2026-11-11T08-38-23-075Z-25031a/summary.json), and [original failed clock probe](runs/clock-2026-11-11T06-19-09-182Z-dd133f/summary.json) are retained.

## Evidence

| Check | Result |
|---|---|
| Load | 100 RPS for 10 minutes; 60,000 requests; p99 21.57 ms; queue drained |
| Chaos | Ten runs of 10,000 jobs each; eight workers; all passed |
| Worker clock | About 24-hour offset; one successful database effect |
| Isolation | READ COMMITTED; 200 claims; no duplicate claims or unfinished work |
| Fence mutation | Removing the epoch check was detected |
| CI | Lint, typecheck, build, unit tests, PostgreSQL integration passed |
| Dependency audit | `npm audit --offline`: zero known vulnerabilities |

Raw successful and failed runs are under [`runs/`](runs/). The tests do not cover database, disk, or network outages, every possible schedule, or real external effects. See [DESIGN.md](DESIGN.md) for guarantees and limits, and [AI_USAGE.md](AI_USAGE.md) for AI tools and verification notes.

## Run locally

Requires Docker Compose, or Node.js 20+ and PostgreSQL.

```sh
docker compose up --build
```

Compose starts PostgreSQL, migrations, the API, and eight workers.

```sh
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

Run checks locally:

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm test
DATABASE_URL=postgres://queue:queue@localhost:55432/queue npm run test:integration
npm run chaos:batch
npm run load
```

Chaos and load runs take several minutes and write raw output under `runs/`. Failures are retained unchanged.

## Stack

- **API/workers:** Node.js 20, TypeScript, Fastify
- **Database/queue:** PostgreSQL
- **Validation:** Zod
- **Tests:** Jest, integration and chaos harnesses
- **Local/CI:** Docker Compose, GitHub Actions

**What surprised us:** p99 fell from 1,027 ms to 21.57 ms after simplifying the write path, but the old run combined the insert lock and relay, so it cannot tell us which dominated. We remain concerned about infrastructure failures outside the single-host tests and about clients expecting snapshot pagination.
