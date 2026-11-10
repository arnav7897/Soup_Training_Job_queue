# PRD: Training-Job Queue Service

**Status:** Draft v1 · **Context:** Soup Backend Engineer take-home · **Run:** `docker compose up`
**Pitch:** A Postgres-backed job queue with lease-based workers, event-driven wake-ups and an *exactly-once effect*, proven by a chaos harness instead of happy-path tests.

---

## 1. Problem
Training jobs are slow and expensive, so losing one or running it twice costs real money. In production, workers get `kill -9`'d, freeze, return after their lease expired, and clients retry POSTs. A naive queue then fails **silently**:
- **Double claim:** two workers take the same job.
- **Zombie write:** a resumed worker overwrites a newer result after its lease expired.
- **Cancel/complete race:** the user is told `cancelled`, the job later reports `succeeded`.
- **Duplicate create:** a retried POST creates a second job.
- **Stuck `running`:** a dead worker's job is never recovered.

Green tests expose none of this. We need a service whose failure behaviour is designed, tested and measured.

## 2. Goals and Non-Goals
**Goals**
1. No job lost, none stuck in `running`, none with more than one committed side effect, under random SIGKILLs.
2. Event-driven: every state change emits an event; workers, cache and metrics react to events.
3. Strict validation at every boundary (HTTP input, env config, event payloads).
4. Honest evidence: raw output of every chaos run is kept, including failed ones.

**Non-goals:** real ML training, auth, multi-region, job priorities, DAG dependencies, UI.

## 3. Solution
**Stack:** Node 20 + TypeScript · Fastify · `pg` (raw SQL) · `ioredis` · `zod` · Jest + supertest · Docker Compose.

```text
client ─► API ──────────► Postgres ◄──────── Workers ×8 (claim, heartbeat, complete)
           │      (jobs, effects, outbox,          ▲
           │       idempotency keys)               │ wake-up doorbell
           ▼                 ▲                     │
         Redis ◄─ invalidate ┴─ Relay ─ XADD ─► Redis Streams `jobs.events`
       (cache-aside)        (polls outbox)
```

**Why Postgres:** state transition, side effect and outbox event must commit atomically. SQLite is rejected (single writer across containers, no `SKIP LOCKED`). Redis is *not* the queue of record: async replication can lose acknowledged writes, so it only holds derived data (cache, event stream).

| Concern | Decision |
|---|---|
| Claim | One atomic `UPDATE … WHERE id=(SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`; bumps `lease_epoch` (fencing token) |
| Dead worker | Lease renewed by heartbeat every lease/3; reaper requeues `running` rows past `lease_expires_at`; `max_attempts` reached → `failed` |
| Zombie | Completion is `UPDATE … WHERE id=$1 AND lease_epoch=$2 AND status='running'` in the same txn as the effect insert; 0 rows → rollback |
| Cancel | `queued` → `cancelled` directly; `running` → `cancelled` + epoch bump, so the worker's fence fails and its effect never commits |
| Guarantee | At-least-once *execution*, exactly-once *effect* (`effects.job_id UNIQUE` + fence, one txn). Not exactly-once for external effects; documented |
| Clock | All lease math uses Postgres `now()`; workers never compare their own clocks |
| Isolation | `READ COMMITTED`; every transition is one conditional UPDATE, no read-modify-write in app code |
| Idempotency | `UNIQUE(idempotency_key)` + `request_hash`; Redis is only a fast path, never the arbiter |

**State machine:** `queued → running → succeeded | failed | cancelled`; `running → queued` only via lease expiry; terminal states are immutable.

## 4. Features
| ID | Feature | Acceptance criteria |
|---|---|---|
| F1 | Create job | `Idempotency-Key` required; 201 new, 200 + `Idempotent-Replayed: true` on replay; 422 if key reused with different body |
| F2 | Get status | Cache-aside; returns state, attempts, timestamps; 404 for unknown id |
| F3 | List + pagination | Keyset on `(created_at, id)`, `limit` 1–100, opaque `cursor`, `status` filter; no skips or dupes under concurrent inserts |
| F4 | Cancel | Idempotent (already `cancelled` → 200); `succeeded`/`failed` → 409; race with completion has exactly one winner |
| F5 | Worker pool | ≥8 processes; claim, heartbeat, simulated execution, fenced completion with effect row |
| F6 | Reaper | Recovers expired leases; counts recoveries; poison jobs end `failed` |
| F7 | Outbox + relay | Events written in the state-change txn, relayed to Redis Streams at-least-once; consumers idempotent |
| F8 | Redis cache | See section 7; Redis outage degrades to DB reads, never to wrong answers |
| F9 | Validation | See section 6; unknown fields rejected; env validated at boot (fail fast) |
| F10 | Observability | `/health`, `/metrics` (jobs by state, claims, fence rejections, lease expiries, outbox lag), structured logs |
| F11 | Chaos harness | See section 9; `npm run chaos`, seeded, reproducible |
| F12 | Load test | 100 rps mixed traffic for 10 min; p50/p99 latency, queue depth, outbox lag |

## 5. Data Model
- `jobs(id uuid pk, idempotency_key text unique, request_hash text, name, model, params jsonb, status, attempts int, max_attempts int, lease_owner, lease_expires_at, lease_epoch int, version int, created_at, updated_at, finished_at)`
- `effects(job_id uuid pk references jobs, worker_id, lease_epoch, written_at)`: the countable side effect.
- `executions(id bigserial, job_id, worker_id, lease_epoch, started_at)`: append-only, un-fenced; measures wasted duplicate runs.
- `outbox(id bigserial, type, job_id, payload jsonb, created_at, published_at)`.
- Indexes: partial on `status='queued'` by `created_at`; partial on `status='running'` by `lease_expires_at`.

## 6. API and Validation
`POST /jobs` · `GET /jobs/:id` · `GET /jobs?status&limit&cursor` · `POST /jobs/:id/cancel` · `GET /health` · `GET /metrics`

| Field | Rule |
|---|---|
| `Idempotency-Key` | Required, 8–128 chars, `^[A-Za-z0-9_.:-]+$` |
| `name` | String, trimmed, 1–100 chars |
| `model` | Enum: `resnet50`, `bert-base`, `gpt2-small`, `custom` |
| `params` | Strict object: `epochs` int 1–10000, `batchSize` int 1–4096, `learningRate` number in (0, 1], `durationMs` int 0–60000 |
| Body | JSON only, max 16 KB, unknown keys rejected |
| `:id` / `limit` / `cursor` | UUID / int 1–100 (default 20) / base64url blob that decodes to a valid `(created_at, id)` |

Errors share one shape: `{ "error": { "code", "message", "details" } }` with 400 (validation), 404, 409 (illegal transition), 422 (key reuse).

## 7. Redis Caching
- Cache-aside for `GET /jobs/:id`; terminal states are immutable, so TTL 1 h; non-terminal TTL 2 s.
- The cache-invalidator consumes `jobs.events` and deletes the key; TTL is the safety net for lost events.
- **Stale-set race** (reader loads old row, writer commits, reader sets old value): cached value carries `version`, and a Lua compare-and-set only overwrites with a higher version.
- Lists are not cached (consistency over speed). Redis is never used to decide claim, idempotency or cancel outcomes.

## 8. Testing (Jest)
- **Unit:** validators (valid, boundary and hostile inputs), full transition matrix (every legal/illegal pair), cursor codec, version-guarded cache, config loader, retry/backoff math.
- **Integration (real Postgres + Redis):** 50 concurrent claimers over 200 jobs, each claimed once; zombie completion rejected with exactly one effect; cancel-vs-complete race looped 500×; 100 concurrent identical POSTs create one row; key reuse with a different body gives 422; reaper requeue and `max_attempts` → `failed`; relay crash between `XADD` and mark-published tolerated; Redis down still serves correct data.
- **API (supertest):** contract test for every status code and error shape; pagination stability while inserting.
- **Chaos smoke:** 500 jobs, 4 workers, 3 kills, tagged `slow`; the full 10k harness is a script, not a Jest test.
- **Gate:** coverage ≥85% on `domain/` and `repo/`; mutation check below.

## 9. Chaos Harness
Seeded script: 10,000 jobs, 8 worker containers, one random `docker kill -s KILL` every ~2 s (restart policy revives them), repeated POSTs with ~30% reused keys, ~5% random cancels, plus `SIGSTOP`/`SIGCONT` freezes longer than the lease to create real zombies. Runs until quiescent, then checks via SQL:
1. Each distinct key maps to exactly one job; none lost.
2. No job in `running` or `queued` after quiescence.
3. `effects` per job ≤1; `succeeded` ⇔ exactly 1 effect; `cancelled`/`failed` ⇒ 0 effects.
4. No illegal transition in the outbox event log.
5. Every client-acknowledged cancel (200) ended `cancelled`.
6. Report wasted duplicate executions and fence rejections (evidence the races actually happened).

**Mutation check:** delete the epoch fence, then run; the harness must fail. A harness that cannot fail proves nothing.
**Runs:** ≥10 seeded runs; raw logs and `summary.json` per run in `runs/`, failed runs kept untouched.
**Does NOT catch:** Postgres or Redis crashes, disk/fsync loss, network partitions, clock skew (single host, single clock), external-effect duplication (the effect shares the DB), checker bugs, and interleavings that never occurred in 10k jobs.

## 10. Silent-Failure Checks
| Failure | How we check |
|---|---|
| Double claim | 50-claimer integration test; `executions` rows per `(job_id, lease_epoch)` must be unique |
| Zombie stale write | `SIGSTOP` past lease in harness; fence-rejection counter > 0, effects still ≤1 |
| Cancel/complete race | 500× `Promise.all` loop; final state and effect count must agree |
| Request-retry duplicate | Concurrent identical POSTs; one row, replay header set |
| Isolation level | Re-run races under `READ COMMITTED` and `SERIALIZABLE`; compare anomalies and retry rate |
| Clock skew | Offset a worker clock (`libfaketime`); leases must not change since only DB time is used |
| Stale cache | Version-CAS test plus event-loss test (drop relay, TTL must heal) |

## 11. Deliverables and Success Criteria
Repo with design note (`DESIGN.md`, one page), harness plus raw output of all runs, `AI_USAGE.md` (what was accepted, verified, redone), and one paragraph on surprises and remaining concerns.
**Verdict (SHIP / DON'T SHIP at 100 rps) is decided from evidence, not written in advance:** all invariants hold across all runs, p99 < 200 ms at 100 rps for 10 min, queue drains faster than it fills, outbox lag stays flat. If not, name the first fix.

## 12. Risks and Open Questions
- Lease length trades recovery speed against false expiry for slow jobs; tune per job duration.
- Postgres is a single point of failure; HA is out of scope but stated in the verdict.
- Outbox and `executions` grow unbounded; need pruning.
- At 10× load the claim hot spot and `outbox` polling are the first suspects; measure, don't assume.
