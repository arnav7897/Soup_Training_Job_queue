# AI usage

Codex assisted with planning, code edits, test harnesses, documentation and
review. Context7 was used to check PostgreSQL locking behavior. Ponytail was
used to keep changes small and review the finished implementation; Understand
Anything was used to update the current architecture flow. No UI work was in
scope. AI output was treated as a proposal, not evidence.

Accepted: PostgreSQL remains the durable queue, workers claim with row locks and
leases, and completion uses a fence plus one database effect. Redis-first
buffering and BullMQ were excluded because they were not required and would add
another coordination layer. The Phase 6 pagination lock was removed to avoid
serializing every insert; its concurrent-page behavior is now explicitly
documented as live pagination rather than a cross-request snapshot.

Verified or changed by hand: migration ordering and upgrade behavior, API and
worker call paths, CI workflow services, test setup, the chaos harness queries,
the fence mutation probe, and every final run summary. The initial pagination
probe and Phase 6 load failure were preserved. The current ten-seed chaos batch,
100 RPS load test, clock-skew probe, READ COMMITTED probe, lint, typecheck,
build, unit tests, integration tests, and offline dependency audit passed.
The verdict is **SHIP at 100 RPS for the tested workload**, with the limits in
`DESIGN.md` and the README.

The 85% CI coverage gate measures `dist/queue.js` only; it is not a claim about
whole-application coverage. AI-assisted changes received the same local checks
as hand-written changes.
