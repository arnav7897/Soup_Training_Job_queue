![Training Job Queue — reliable work, even when workers fail](assets/banner.svg)

# Training Job Queue

A Postgres-backed queue for training jobs, designed to keep work moving
through worker crashes, retries, and cancellation races. This project is a backend
exercise; simulated jobs stand in for real model training.

> **Status: DON'T SHIP at 100 requests/second.** The current checkout is the
> earlier PostgreSQL + Redis implementation. Its latest load run missed latency
> and outbox-drain checks. The refreshed target design in `prd.md` is PostgreSQL
> only; that architecture change is planned, not implemented yet.

## The problem

Training jobs can be slow and expensive. A worker may crash or resume after its
lease expires; a client may retry a request; cancellation can race with completion.
Without careful coordination, those cases can leave jobs stuck, create duplicates,
or let an outdated worker write a result after another worker takes over.

## The proposed solution

The target design keeps accepted jobs, leases, attempts, and the countable effect
in PostgreSQL. Workers claim work from the database, recover expired leases, and
cannot commit a stale result. Redis, BullMQ, a cache, and an event relay are outside
the supplied task; they add no required behavior here.

The target is **at-least-once execution with exactly one committed database effect
for a successful job**. That guarantee does not extend to external side effects.
A seeded chaos harness and load tests are planned to check the design rather than
assume it works. See [the PRD](prd.md) for requirements and limitations.

## Target user flow

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
| Database and queue | PostgreSQL | Durable jobs, leases, attempts and effects |
| Testing | Jest + failure harnesses | Unit, integration, chaos and load evidence |
| Operations | Docker Compose, GitHub Actions | Local services and automated checks |

The current checkout still runs Redis for its historical cache and event relay.
Phase 7 plans to remove those pieces after preserving their run evidence, because
they are not part of the refreshed requirements.

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

The next phase removes the unnecessary Redis/outbox path and the global insert
serialization while keeping the required job, worker, retry, cancellation, and
effect guarantees. See `plan.md` for the phase plan and `prd.md` for the refreshed
acceptance criteria.

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
not deterministic. The load runner records every request and periodic queue and
outbox samples. Its 20 ms simulated jobs are a synthetic workload; inspect the
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
initial verdict was **DON'T SHIP** because pagination could skip a late-committing
job. The follow-up below records the fix and rerun evidence; it also records the
remaining latency, outbox, and probe failures.

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
The partial index was subsequently added; see the post-fix rerun below. These
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

**Initial pagination failure (fixed and regression-tested in the follow-up):** A [retained pagination probe](runs/pagination-probe-2026-11-10/output.log)
shows that a transaction can insert a job, remain uncommitted while a later job
appears on the first page, and then commit behind the issued cursor. The next
page missed the late-committing job. The probe uses an isolated schema and its
[source is retained](runs/pagination-probe-2026-11-10/probe.cjs). The migration
and delayed-commit integration regression now address this case. The added global
creation timestamp serialization has a measured latency cost in the latest load
rerun, so its design still needs improvement.

**Surprises and remaining concerns:** A row-lock experiment showed that Postgres
`now()` can remain fixed while a completion waits past its lease; the lease checks
now acquire the lock before consulting the database clock, with regression tests.
The first chaos and mutation rehearsals also exposed weaknesses in the test setup
itself. Remaining concerns include the pagination fix's measured latency cost and
the outbox backlog under sustained load, the cost of a Postgres version read on
cache hits, database and network failures outside this
single-host harness, and unbounded event and execution history. Do not infer a
production guarantee from a small smoke run.

A production dependency audit reports one high-severity Zod advisory
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)) for
the installed Zod 3 release; the reported fix requires a major-version upgrade.
That upgrade has not been tested, and the finding remains open.
# Reliability follow-up (2026-11-11)

The first reliability runs exposed two problems: pagination could skip a job when
an older transaction committed after a page had been read, and the outbox relay fell
behind during sustained load. We corrected pagination with migration
`003_commit_order_and_outbox_index.sql`, which serializes job creation timestamps,
and added a partial index for unpublished outbox rows.

After those changes, lint, typecheck, build, unit tests, the full Postgres/Redis
integration suite, and the 500-job chaos smoke passed. The epoch-fence mutation
check also detected its deliberately weakened completion check. The integration
suite includes a delayed-commit regression test for pagination. The post-fix
10-minute load rerun
completed all 60,000 requests at 100 RPS with no request errors, but **failed** its
performance and drain checks: p99 was 1,027 ms (200 ms target), and 60,049 outbox
rows remained after 121.7 seconds of draining. The outbox backlog therefore
persists. The global serialized timestamp update may also be contributing to the
latency regression; this needs investigation before another ship claim.

Two additional probes failed and their outputs are retained: the clock-skew probe
ended with `TypeError: fetch failed` before checks ran, and the isolation probe
passed READ COMMITTED but failed SERIALIZABLE on a concurrent-update serialization
error. These failures are not evidence that the pagination or worker invariants
failed, but they remain unresolved test/probe failures.

Original failed runs and raw output remain in `runs/`; they have not been edited or
removed. The earlier 500-job chaos rehearsal failed before its container-restart
fix, and both the failure and later successful chaos runs remain available. Treat
the project as not ready for a positive reliability claim until the outbox drain
and latency regressions are addressed and the failed probes are understood.
