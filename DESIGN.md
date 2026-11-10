# Design: training-job queue

Postgres owns job state, idempotency, leases, effects, execution records and the
transactional outbox. Redis provides derived cache entries and a stream doorbell;
workers fall back to polling when Redis is unavailable. Eight simulated workers
are configured in Compose.

A claim uses `FOR UPDATE SKIP LOCKED`, increments the lease epoch and records the
execution in the same transaction as its outbox event. A heartbeat renews only a
live lease. Completion requires the current owner, epoch, running state and an
unexpired database-clock lease; it commits a unique effect and state transition
together. Cancellation increments the epoch; the reaper requeues expired jobs or
fails them after the attempt limit. Execution can repeat. Exactly-once effects are
limited to the effect row inside Postgres, not external side effects.

A relay publishes outbox events to Redis Streams at least once. An interrupted
relay can publish duplicates; versioned invalidation tolerates repeats and out-of-
order events. Status cache hits still check the current Postgres version, so a
lost or delayed invalidation cannot make cached state authoritative. The stream
and cache may be lost without losing jobs.

`/health` is process liveness. `/metrics` uses Postgres to expose job counts,
committed claims, rejected completions, recovered expired leases, unpublished
outbox count and the oldest unpublished event age. Counters added in phase 5
start at zero on upgrade; claims are derived from execution records. Counter
updates add database write contention. Metrics fail with 503 if Postgres is down.

Local integration tests exercise concurrency, cancellation races, stale workers,
Redis failures and duplicate relay delivery. The required full seeded chaos runs,
mutation check and 100-rps load evidence remain phase 6 work. No ship verdict is
claimed. Postgres availability, network partitions, disk loss, external side
effects and unbounded outbox/execution growth remain limitations.
