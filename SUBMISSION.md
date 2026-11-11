# Email reply draft

Hi Soup team,

My take-home repository is https://github.com/arnav7897/Soup_Training_Job_queue.
The README links the design note, harness, raw outputs and retained failed runs.
The current verdict is **DON'T SHIP**.

Ten seeded chaos runs covered 100,000 jobs and their recorded invariants passed;
the 500-job smoke test passed, and a deterministic probe detected removal of the
epoch fence. The first mutation rehearsal survived and is retained. At 100 mixed
requests per second for ten minutes, all 60,000 requests completed with 9.37 ms
p50 and 24.19 ms p99, but the outbox grew to 90,644 pending events and still had
85,865 after a 121-second drain. The captured query plan shows the relay scanning
past 39,844 published rows to find one pending row; the first fix to test is a
partial index on unpublished events, followed by another load run.

A separate late-commit pagination probe found that a job can be skipped behind an
issued cursor, so the no-skips acceptance criterion is not met. Under SERIALIZABLE,
the probe observed no state/effect invariant failures but needed many probe-side
serialization retries and received 50 unexpected cancellation responses; the
service is designed for READ COMMITTED. A worker-clock probe with a 24-hour offset
passed. Full summaries and raw logs are linked in the README, including failures.

What surprised me was that Postgres `now()` stayed fixed while a completion waited
past its lease, and that an initial epoch-fence mutation survived because other
checks masked it. I added a lock-wait regression and a deterministic fence probe.
I remain concerned about commit-order pagination, the measured outbox backlog,
the unresolved high-severity production dependency advisory, and failures outside the single-host
harness such as database loss, partitions and external effects.
