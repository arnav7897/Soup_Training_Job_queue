# Agent instructions

## Project

Build the service in `prd.md`: a Postgres-backed training-job queue with Fastify
APIs, lease-based workers, fencing, a transactional outbox, Redis-derived cache
and events, and reproducible chaos evidence. Execution may repeat; a successful
job commits one database effect. There is no UI or real model training in scope.
The PRD is a draft; distinguish proposed behavior from verified behavior.

## Working conventions

- Read `prd.md` and relevant code before changes. Keep changes small and test the
  concurrency and failure behavior they affect; do not assert unmeasured results.
- Consult `plan.md`, `decision.md`, and `flow.md` locally when present. They are
  intentionally ignored by Git; update them as implementation and decisions evolve.
- Use Context7 to check current library and framework documentation when needed.
- Use the Cavecrew skill for appropriate focused investigation, edits or review,
  subject to the active session's delegation instructions.
- Use Ponytail to keep implementations minimal and complete.
- Use Understand Anything to inspect code relationships and refresh flow diagrams
  once code exists; label planned and implemented flows accurately.
- Apply an available UI/UX skill only if UI work is explicitly brought into scope;
  none is currently listed and the PRD excludes a UI.
- Preserve failed test and chaos evidence. Do not claim external side effects have
  exactly-once guarantees or treat Redis as the queue of record.

## Phase and commit workflow

- Before implementation, read `plan.md` when present; identify the current phase,
  its branch, planned microcommits, prerequisites, and completion checks. The file
  is Git-ignored and may be absent from other checkouts; do not assume it is shared.
- Work phase by phase in the listed order unless the user directs otherwise. Create
  each phase branch from the merged previous phase when the repository history and
  permissions allow; preserve existing user changes and never assume a phase merged.
- Make the listed small, reviewable commits as work is verified, where authorized and
  possible. Avoid mixing unrelated changes; do not rewrite existing history. Report
  missing branches or commits rather than claiming they exist.
- Run the phase's completion checks, record progress and blockers in `plan.md`, and
  distinguish implemented behavior from verified behavior before starting another phase.
  If the user explicitly directs work on a later phase, proceed and retain the earlier
  outstanding checks in the plan.
- Phase 1 includes GitHub Actions checks and an integration job; defer deployment
  automation until a deployment target and rollback procedure are defined.
