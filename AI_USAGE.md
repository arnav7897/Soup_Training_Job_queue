# AI usage

Codex helped draft the design and implement the API, worker leases, event relay,
cache and observability. Changes were iterated after local checks exposed issues,
including test database interference and a metrics error response. AI-generated
code and documentation should be reviewed as project code, not treated as proof.

Verified locally: TypeScript, lint, unit tests and Postgres/Redis integration tests;
worker concurrency and cancellation races; and Compose job completion and event
publication. Earlier phase 3 and 4 pull requests passed GitHub Actions. Phase 5
remote CI passed. Phase 6 fixed a lock-wait lease bug found during review; its
seeded chaos batch, mutation checks and load evidence are recorded under `runs/`.
A late-commit pagination probe exposed a missed-row failure; the load run also
failed the outbox drain check. The verdict is DON'T SHIP. Ten full chaos runs,
both mutation outcomes, the clock check and isolation comparisons are retained
under `runs/`; read their summaries and logs for their scope and limitations.

The 85% CI coverage gate currently measures `dist/queue.js` only. It is not a
coverage claim for the entire application or for separate `domain/` and `repo/`
directories, which do not exist in the present layout. Expand it as those areas
and their tests are established.
