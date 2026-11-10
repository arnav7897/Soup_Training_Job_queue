![Training Job Queue — reliable work, even when workers fail](assets/banner.svg)

# Training Job Queue

A planned Postgres-backed queue for training jobs, designed to keep work moving
through worker crashes, retries, and cancellation races. This project is a backend
exercise; simulated jobs stand in for real model training.

> **Status: in development.** The API supports job creation, lookup, listing and
> cancellation backed by Postgres. Eight workers execute simulated jobs with
> leases, fenced completion and recovery. `GET /health` reports process liveness
> only. Event relay, chaos testing and load-test guarantees remain in progress.

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

Postgres backs the job API. Redis is configured in Compose; its application
integration remains planned.

## Run locally

**Prerequisites:** Docker with Compose, or Node.js 20 and npm for local development.

```sh
docker compose up --build
```

Once the API starts, check its liveness:

```sh
curl http://localhost:3000/health
```

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
`npm run test:integration` to check connectivity to both services.

## What's next

The next milestones complete job API verification, event delivery and caching,
observability, and reproducible failure testing. The goal is a queue whose behavior
under failure can be explained and measured, not just a happy-path demo.
