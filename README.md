![Training Job Queue — reliable work, even when workers fail](assets/banner.svg)

# Training Job Queue

A Postgres-backed queue for training jobs, designed to keep work moving
through worker crashes, retries, and cancellation races. This project is a backend
exercise; simulated jobs stand in for real model training.

> **Status: in development.** The API supports job creation, lookup, listing and
> cancellation backed by Postgres. Eight workers execute simulated jobs with
> leases, fenced completion and recovery. `GET /health` reports process liveness
> only; `/metrics` reports database-backed queue metrics. The outbox relay
> publishes Redis Stream events and status reads use a
> version-checked cache. Chaos and load-test guarantees remain unverified.

## The problem

Training jobs can be slow and expensive. A worker may crash or resume after its
lease expires; a client may retry a request; cancellation can race with completion.
Without careful coordination, those cases can leave jobs stuck, create duplicates,
or let an outdated worker write a result after another worker takes over.

## The proposed solution

Postgres will be the source of truth for jobs and their transitions. Workers will
claim jobs using leases and fencing tokens; expired leases can be recovered, while
stale workers cannot commit a result. A transactional outbox will carry state
changes to Redis Streams, and Redis will provide a derived cache and wake-ups.

The target is **at-least-once execution with exactly one committed database effect
for a successful job**. That guarantee does not extend to external side effects.
A seeded chaos harness and load tests are planned to check the design rather than
assume it works. See [the PRD](prd.md) for requirements and limitations.

## Planned user flow

These Mermaid diagrams describe the intended system, not the current scaffold.

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
| Database | PostgreSQL | Durable jobs, leases, effects and outbox |
| Events and cache | Redis | Streams, worker wake-ups and derived cache |
| Testing | Jest | Unit, integration and planned failure tests |
| Operations | Docker Compose, GitHub Actions | Local services and automated checks |

Postgres backs the job API. Redis Streams provide worker wake-ups, with polling
fallback; Redis also stores a version-checked cache. Status reads check the current
Postgres version, including when a cached value exists.

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
docker compose logs -f worker relay
```

Metrics include job states, claims, rejected heartbeats and completions, expired leases,
and unpublished outbox count and age. Claims come from execution records; the
rejection and expiry counters begin at zero when the metrics migration is applied.
`/health` only checks process liveness; `/metrics` returns 503 if Postgres is down.
See [DESIGN.md](DESIGN.md) for guarantees and limitations.

Stop the services with `docker compose down`. Postgres data persists in a Docker
volume; `docker compose down -v` also deletes that data.

For development without containers, start Postgres and Redis separately, then:

```sh
npm ci
npm run build
export DATABASE_URL=postgres://queue:queue@localhost:5432/queue
export REDIS_URL=redis://localhost:6379
npm run migrate
npm start
```

Run `npm run typecheck`, `npm run lint`, and `npm test` after building. With Postgres and Redis running and the same environment variables set, run
`npm run test:integration` for the service and race tests. This enforces 85%
coverage for the current queue module, not the entire application.

## What's next

The next milestones complete job API verification and reproducible failure testing. The goal is a queue whose behavior
under failure can be explained and measured, not just a happy-path demo.

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
```

Each chaos run uses a separate Compose project and database. The seed controls
input and fault choices; operating-system scheduling and race interleavings are
not deterministic. The load runner records every request and periodic queue and
outbox samples. Its 20 ms simulated jobs are a synthetic workload; inspect the
retained lag samples and actual throughput before drawing conclusions. The
scripts retain results on failed checks; a killed host process or host crash may
prevent the final summary from being written.

**Results so far:** the [500-job smoke run](runs/chaos-2026-11-10T11-58-06-699Z-59975e/summary.json)
passed its recorded checks. The [first rehearsal](runs/chaos-2026-11-10T11-55-20-095Z-95ddf7/summary.json)
failed because `docker kill` left workers stopped and the injector later selected
one again; the harness now explicitly restarts killed workers. An [initial mutation
run](runs/mutation-2026-11-10T12-02-29-369Z-65ab57/summary.json) survived removal
of the epoch predicate: the sampled races were also protected by owner and lease
checks. A deterministic stale-epoch probe was added to test the epoch fence
itself. A [second mutation run](runs/mutation-2026-11-10T12-05-29-917Z-907ace/summary.json)
detected the removed epoch predicate with that probe. Full chaos runs and the
ten-minute load results must be read from their recorded summaries. The current
verdict is **DON'T SHIP** because the pagination acceptance criterion fails;
completion of the remaining evidence cannot erase that failure.

The assessment weights are **correctness under failure 30%**, **silent failures
20%**, **design and code quality 15%**, and **live discussion 35%**. The first
three are supported by the design, checks and raw evidence above; live discussion
requires explaining the actual results, assumptions, failures and tradeoffs rather
than treating passing metrics as proof. The requested submission is an email reply
to `team@trysoup.dev` with the repository and evidence; it has not been sent.

**Known failing requirement:** A [retained pagination probe](runs/pagination-probe-2026-11-10/output.log)
shows that a transaction can insert a job, remain uncommitted while a later job
appears on the first page, and then commit behind the issued cursor. The next
page misses the late-committing job. The probe uses an isolated schema and its
[source is retained](runs/pagination-probe-2026-11-10/probe.cjs). This violates
the PRD's no-skips-under-concurrent-inserts criterion and is not fixed. A safe
fix needs a commit-ordered pagination strategy and a regression test; measure its
impact on write throughput before declaring the service ready.

**Surprises and remaining concerns:** A row-lock experiment showed that Postgres
`now()` can remain fixed while a completion waits past its lease; the lease checks
now acquire the lock before consulting the database clock, with regression tests.
The first chaos and mutation rehearsals also exposed weaknesses in the test setup
itself. Remaining concerns include the confirmed pagination skip, whether the full fault and load runs satisfy
all invariants, whether outbox lag stays flat at sustained load, the cost of a
Postgres version read on cache hits, database and network failures outside this
single-host harness, and unbounded event and execution history. Do not infer a
production guarantee from a small smoke run.

A production dependency audit reports one high-severity Zod advisory
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)) for
the installed Zod 3 release; the reported fix requires a major-version upgrade.
That upgrade has not been tested, and the finding remains open.
