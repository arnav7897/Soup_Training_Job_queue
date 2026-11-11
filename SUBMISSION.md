# Email reply draft

Hi Soup team,

My take-home repository is https://github.com/arnav7897/Soup_Training_Job_queue.
The README links the design note, harness, raw outputs and retained failed runs.
The current verdict is **SHIP at 100 requests per second for the tested workload**.

Ten seeded chaos runs covered 100,000 jobs and their recorded invariants passed;
the harness exercised eight workers, repeated idempotent requests, cancellations,
worker kills, lease recovery and stale-worker rejection. A deterministic fence
mutation was detected. At 100 mixed requests per second for ten minutes, all
60,000 requests completed with 8.56 ms p50 and 21.57 ms p99; the queue drained
in 0.10 seconds. The earlier Redis/outbox design missed its drain target and had
1,027 ms p99 with 60,049 events still pending; that run does not isolate Redis
as the sole cause. The current design removes Redis and the relay from the path.

A late-commit pagination probe showed that a newly committed job can sort behind
an existing cursor. The current API defines pagination as a live view rather than
a snapshot; clients restart at page one to see new jobs. Under READ COMMITTED,
200 claims completed without duplicates or invariant failures. Clock skew was
tested at roughly 24 hours. Full summaries and raw logs are linked in the README,
including the historical failures and the expected failing mutation run.

What surprised me was that removing the serialized insert timestamp and relay
path changed the measured p99 from 1,027 ms to 21.57 ms, though the old run cannot
tell us which component dominated. I am still concerned about database, disk and
network failures outside the single-host harness, external side effects, and the
live-pagination behavior while new jobs commit. Pagination is documented as a
live keyset walk and the locked dependency audit reported no vulnerabilities.
