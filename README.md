![Training Job Queue — reliable work, even when workers fail](assets/banner.svg)

# Training Job Queue

A Postgres-backed queue for training jobs, designed to keep work moving
through worker crashes, retries, and cancellation races. This project is a backend
exercise; simulated jobs stand in for real model training.

> **SHIP at 100 requests/second for the tested workload.** The 10-minute load
> run passed with 60,000 successful requests and 21.57 ms p99; all ten 10,000-job,
> eight-worker chaos seeds passed. The assignment sets no p99 threshold; 200 ms is
> the project's target. This evidence does not cover database, disk, or network
> outages and does not guarantee exactly-once external effects.

## Architecture and failure timeline

### 1. Pagination bug and fix

The initial list implementation paginated by creation time. A transaction could
start first, receive an older timestamp, and commit after a later transaction.
If a client had already paged past that timestamp, the newly committed row could
be skipped. The Phase 6 fix serialized job creation through a PostgreSQL clock
row so timestamp order matched commit order. That fixed the tested late-commit
case, but introduced a single shared lock on every job insert. Phase 7 removed
that global insert lock. The API provides live keyset pagination, not a
repeatable snapshot: a job committed during a page walk can sort before the
cursor and appear only after the client starts a fresh list. The job remains in
PostgreSQL; pagination does not delete it. The task requires pagination but not
a cross-request snapshot, so this is the documented contract. The fixed-set
multi-page test checks ordering and duplicates; concurrent page walks are not a
snapshot guarantee.

### 2. Redis/outbox load failure

The prior design wrote job data and outbox events to PostgreSQL, then relied on a
relay to publish/update Redis. At 100 RPS all 60,000 HTTP requests completed,
but p99 was 1,027 ms and 60,049 outbox events were still pending after 121.7 s
of draining. This proves the end-to-end design had a severe latency/backlog
problem; it does **not** isolate Redis as the sole cause. The serialized insert
lock and relay/outbox work were also in the path, and that run did not measure
each component independently.

### 3. Current Phase 7 design

```mermaid
flowchart LR
  C[Client] -->|create + idempotency key| A[Fastify API]
  A -->|transactional insert / conflict lookup| P[(PostgreSQL jobs)]
  C -->|status, list, cancel| A
  A -->|read / cancel update| P
  W1[Worker 1] -->|poll + claim with row lock and lease| P
  W2[Worker 2] -->|poll + claim with row lock and lease| P
  WN[Workers 3..8] -->|poll + claim| P
  W1 -->|fenced terminal update + one DB effect| P
  R[Lease reaper] -->|recover expired claims| P
```

PostgreSQL is the durable queue and source of truth. Workers claim rows using
database coordination, run the simulated work, and commit the fenced result and
countable effect together. A lease lets the reaper recover jobs after a worker
dies; fencing rejects a stale worker after another worker has reclaimed its job.
Execution can repeat, while the database effect is committed once for a
successful job. Redis, BullMQ, a cache, and an outbox relay are not used.

### Bottlenecks and evidence

| Part | What can bottleneck or fail | Current evidence / remaining check |
|---|---|---|
| API + PostgreSQL writes | Connection pool, row/index contention, fsync | 60,000/60,000 requests succeeded in the seeded load run |
| Worker polling + claims | Poll query load, lock contention, queue wait | Ten 10,000-job runs passed with eight workers; 100 RPS queue drained |
| Lease recovery | Expiry delay and reaper cadence | Ten chaos seeds plus clock-skew and fence-mutation checks passed |
| Pagination | New commits can sort behind an existing cursor | Fixed-set pages pass; documented live-list behavior requires a fresh first page |
| Redis/outbox relay | Backlog and extra serialization/network hops | Removed from current runtime; old failure retained as historical evidence |

The Phase 7 10-minute run completed 60,000 requests at 100.00 RPS with no
request errors, p50 8.56 ms, p99 21.57 ms, and an empty queue after a 0.10 s
drain. It meets the project 200 ms p99 target for this seeded request mix. The
take-home asks for a verdict at 100 RPS but specifies no latency threshold. The
raw run is `runs/load-2026-11-11T08-08-50-100Z-ad8eb8/`.

Ten 10,000-job/eight-worker chaos seeds also passed. The harness verified unique
idempotency keys, terminal states, effect counts, successful cancellations,
worker restarts and stale-epoch rejection. A mutation run removed the epoch
comparison and was correctly rejected by the harness; that expected mutation
failure is retained. The latest clock and READ COMMITTED probes also passed.
Batch records are in `runs/batch-2026-11-11T08-39-58-339Z-7be870/`, and mutation
records are in `runs/mutation-2026-11-11T08-38-23-075Z-25031a/`.
## The problem

Training jobs can be slow and expensive. A worker may crash or resume after its
lease expires; a client may retry a request; cancellation can race with completion.
Without careful coordination, those cases can leave jobs stuck, create duplicates,
or let an outdated worker write a result after another worker takes over.

## The implemented solution

The implemented design keeps accepted jobs, leases, attempts, and the countable effect
in PostgreSQL. Workers claim work from the database, recover expired leases, and
cannot commit a stale result. Redis, BullMQ, a cache, and an event relay are outside
the supplied task; they add no required behavior here.

The guarantee is **at-least-once execution with exactly one committed database effect
for a successful job**. That guarantee does not extend to external side effects.
Ten chaos seeds and a 10-minute load test check the design rather than assume it
works. See [the PRD](prd.md) for requirements and limitations.

## Current user flow

These Mermaid diagrams describe the implemented PostgreSQL-only system.

```mermaid
sequenceDiagram
    actor Client
    participant API
    participant DB as Postgres
    participant Worker
    Client->>API: Submit job with idempotency key
    API->>DB: Validate and create or find existing job
    DB-->>API: Job record
    API-->>Client: Job ID and status
    Worker->>DB: Claim job and acquire lease
    Client->>API: Request status or cancel
    API->>DB: Read status or cancel conditionally
    Worker->>DB: Commit result if lease is still valid
    API-->>Client: Current status or cancellation result
```

```mermaid
stateDiagram-v2
    [*] --> queued: submit
    queued --> running: worker claims
    queued --> cancelled: cancel
    running --> succeeded: fenced completion
    running --> cancelled: cancel
    running --> queued: lease expires, retry available
    running --> failed: lease expires, retries exhausted
    succeeded --> [*]
    cancelled --> [*]
    failed --> [*]
```

## Tech stack

| Component | Technology | Role |
| --- | --- | --- |
| Runtime and API | Node.js 20, TypeScript, Fastify | HTTP service and workers |
| Validation | Zod | Request and configuration validation |
| Database and queue | PostgreSQL | Durable jobs, leases, attempts and effects |
| Testing | Jest + failure harnesses | Unit, integration, chaos and load evidence |
| Operations | Docker Compose, GitHub Actions | Local services and automated checks |

The current runtime uses PostgreSQL as its source of truth and queue. Historical
Redis and outbox evidence remains available in `runs/`.

## Run locally

**Prerequisites:** Docker with Compose, or Node.js 20 and npm for local development.

```sh
docker compose up --build
```

Once the API starts, check its liveness:

```sh
curl http://localhost:3000/health
```

Inspect queue metrics and structured service logs:

```sh
curl http://localhost:3000/metrics
docker compose logs -f worker
```

Metrics include job states, claims, rejected heartbeats and completions, and expired
leases. Claims come from execution records; the
rejection and expiry counters begin at zero when the metrics migration is applied.
`/health` only checks process liveness; `/metrics` returns 503 if Postgres is down.
See [DESIGN.md](DESIGN.md) for guarantees and limitations.

Stop the services with `docker compose down`. Postgres data persists in a Docker
volume; `docker compose down -v` also deletes that data.

For development without containers, start Postgres separately, then:

```sh
npm ci
npm run build
export DATABASE_URL=postgres://queue:queue@localhost:5432/queue
npm run migrate
npm start
```

Run `npm run typecheck`, `npm run lint`, and `npm test` after building. With Postgres running and `DATABASE_URL` set, run
`npm run test:integration` for the service and race tests. This enforces 85%
coverage for the current queue module, not the entire application.

## What's next

Phase 7's PostgreSQL-only design is implemented and its load and chaos gates pass.
The batch harness does not simulate database, disk, or network outages, and only
the database side effect is protected against duplicate execution. See `plan.md`
for local phase records and `prd.md` for the acceptance criteria.

## Evidence, evaluation and submission

The deliverable is the [repository](https://github.com/arnav7897/Soup_Training_Job_queue),
[design note](DESIGN.md), [AI usage record](AI_USAGE.md), and the harness and raw
run artifacts in [`runs/`](runs/). Each run has an append-only event log, a
summary and, when the stack starts, timestamped Compose logs. Docker volumes
are retained after runs for investigation; remove them only after retaining the
needed evidence. Failed runs stay alongside successful runs.

Run the focused smoke and full evidence separately:

```sh
npm run build
npm run test:chaos                 # 500 jobs, 4 workers, 3 kills; slow
npm run chaos:batch                # 10 seeded runs, 10,000 jobs each
npm run chaos:mutation             # isolated completion epoch-fence mutation
npm run load                       # 100 mixed requests/s for 10 minutes
npm run test:clock                 # isolated worker clock shifted by 24 hours
```

Each chaos run uses a separate Compose project and database. The seed controls
input and fault choices; operating-system scheduling and race interleavings are
not deterministic. The load runner records every request and periodic queue
samples. Its 20 ms simulated jobs are a synthetic workload; inspect the
retained lag samples and actual throughput before drawing conclusions. The
scripts retain results on failed checks; a killed host process or host crash may
prevent the final summary from being written.

**Initial results (before reliability fixes):** the [500-job smoke run](runs/chaos-2026-11-10T11-58-06-699Z-59975e/summary.json)
passed its recorded checks. The [first rehearsal](runs/chaos-2026-11-10T11-55-20-095Z-95ddf7/summary.json)
failed because `docker kill` left workers stopped and the injector later selected
one again; the harness now explicitly restarts killed workers. An [initial mutation
run](runs/mutation-2026-11-10T12-02-29-369Z-65ab57/summary.json) survived removal
of the epoch predicate: the sampled races were also protected by owner and lease
checks. A deterministic stale-epoch probe was added to test the epoch fence
itself. A [second mutation run](runs/mutation-2026-11-10T12-05-29-917Z-907ace/summary.json)
detected the removed epoch predicate with that probe. Full chaos runs and the
ten-minute load results must be read from their recorded summaries. The current
initial verdict was **DON'T SHIP** because the prior design could skip a late-committing
job and the earlier load/outbox checks failed. The current results are at the top
of this README; all historical failure records below remain unchanged.

The assessment weights are **correctness under failure 30%**, **silent failures
20%**, **design and code quality 15%**, and **live discussion 35%**. The first
three are supported by the design, checks and raw evidence above; live discussion
requires explaining the actual results, assumptions, failures and tradeoffs rather
than treating passing metrics as proof. The requested submission is an email reply
to `team@trysoup.dev` with the repository and evidence; it has not been sent.
A ready-to-review [email reply draft](SUBMISSION.md) is included.

**Historical pre-fix results:** The [ten-seed chaos batch](runs/batch-2026-11-10T12-08-56-204Z-f788d9/batch-summary.json)
completed all ten 10,000-job runs with their recorded checks passing: 100,000
jobs, 191 worker kills, 121 recovered expiries, 11 fence rejections and 118
extra execution records in aggregate. The
[100-rps load run](runs/load-2026-11-10T12-24-25-133Z-a211f6/summary.json)
completed all 60,000 requests at 100.0 rps with 9.37 ms p50 and 24.19 ms p99,
but **failed** the outbox drain requirement: 90,644 events were pending at the
end of traffic and 85,865 remained after 121 seconds. The oldest pending event
aged from 430 to 527 seconds during that drain. A [captured query plan](runs/load-2026-11-10T12-24-25-133Z-a211f6/relay-explain.txt)
shows the relay scanning past 39,844 published rows to find one unpublished row.
The partial index was subsequently added; a later Phase 6 rerun still failed,
as described in the failure timeline above. These
measurements use 20 ms simulated jobs and do not establish performance for real
training workloads.

The [worker-clock probe](runs/clock-2026-11-10T12-40-46-542Z-188d94/summary.json)
passed with a roughly 24-hour worker clock offset: the lease remained tied to
Postgres time and the job committed one effect. The follow-up clock-probe failure
is recorded below; the earlier pass does not erase that failed rerun.

The [isolation comparison](runs/isolation-2026-11-10T12-38-28-452Z-86f84353/summary.json)
passed its checks at READ COMMITTED. Under SERIALIZABLE, the probe retried 6,447
serialization conflicts in 6,997 attempts and observed 50 unexpected cancellation
responses; it found no state/effect invariant failures in those races. The probe
retries database errors itself; the application does not currently implement such
retries, and READ COMMITTED remains the intended isolation level. The [earlier
comparison](runs/isolation-2026-11-10T12-37-34-009Z-f541a058/summary.json) is
also retained, with its coarser combined failure count.

## Current findings and remaining concerns

The original pagination probe demonstrated a late-commit row appearing behind an
already-issued cursor. Phase 6 prevented that behavior by serializing inserts,
but the shared lock was removed in Phase 7 to meet throughput goals. The current
API explicitly provides live keyset pagination rather than a multi-request
snapshot; a fresh first-page request sees newly committed rows. The retained
[original probe](runs/pagination-probe-2026-11-10/output.log) is evidence of that
concurrency boundary, not a claim that jobs disappear from PostgreSQL.

The old Redis/outbox design missed its drain target and reached 1,027 ms p99.
The Phase 7 PostgreSQL-only design removed that relay path and passed the 100 RPS
load check. The earlier `fetch failed`, SERIALIZABLE, and mutation rehearsals
remain in `runs/`; later clock, READ COMMITTED and deterministic fence-mutation
checks passed. `npm audit --offline` reports zero known vulnerabilities in the
locked dependency tree.

**Surprise and concern:** the largest improvement came from simplifying the write
path, but the earlier slow run cannot attribute the 1,027 ms p99 to Redis alone;
the serialized insert lock and relay were both active. Ten 10,000-job chaos seeds
and the seeded 100 RPS run now pass, yet they run on one host with simulated
20 ms jobs and do not test PostgreSQL, disk or network outages or real external
effects. The live-pagination contract also does not give a client a frozen view
across pages; clients should restart their listing to include new jobs.
