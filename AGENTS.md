# Agent instructions

## Project source of truth

Follow `prd.md`, which is based on the supplied training-job queue take-home. The service uses PostgreSQL as the durable job store and queue, Fastify APIs, at least four lease-based workers (target eight), fenced completion, and a database side effect that can be counted. Execution may repeat; a successful job commits one PostgreSQL effect. There is no UI, real model training, Redis-first job intake, BullMQ, or required cache/event relay in this scope.

The previous Redis/outbox implementation and its run evidence are historical artifacts. Keep all failed evidence. Distinguish verified behavior from planned behavior. Do not claim exactly-once behavior for external side effects.

## Working conventions

- Read `prd.md`, `DESIGN.md`, relevant code, and local `plan.md` / `decision.md` before changes.
- Keep changes small; test the failure and concurrency behavior they affect. Do not assert unmeasured results.
- Use Context7 for current library documentation when library behavior matters.
- Use Cavecrew for appropriate focused investigation, edits, or review, subject to active delegation rules.
- Use Ponytail to keep implementations minimal. Use Understand Anything to refresh architecture/flow after code changes.
- Preserve failed test and chaos output; never edit it to imply success.

## Phase and commit workflow

- Read `plan.md` before implementation. Work in phase order unless the user directs otherwise.
- Each phase gets its own branch from the reviewed/merged previous phase where possible. The current phase-06 checkout has local uncommitted work; preserve and reconcile it before creating phase 07. Never assume it merged.
- Make listed microcommits when authorized and possible. Run completion checks and record blockers/results in ignored `plan.md`.
- Phase 6 evidence is not a ship verdict. Phase 7 must address the measured latency and avoid losing the pagination regression proof.
- CI runs install, lint, typecheck, build, unit, and Postgres integration checks. Long chaos/load evidence runs separately and retains all artifacts. No CD until a deployment target and rollback procedure exist.
