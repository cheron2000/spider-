# Spider source-level execution audit

**Date:** 2026-10-20  
**Repository:** `cheron2000/spider-`  
**Scope:** task planning, DAG scheduling, local/remote provider dispatch, completion reporting, recovery, worker endpoints, and dashboard integration.  
**Verification boundary:** source inspection only. No tests or builds were run.

## Execution path reviewed

1. `POST /api/coordinator/plans/draft` or `POST /api/coordinator/plans` creates a SQLite-backed dependency graph.
2. `advanceCoordinationPlan` marks dependency-ready steps and assigns available agents.
3. Provider-backed agents are sent to `executeProviderAssignment`, which calls `ProviderRuntimeManager.dispatch`.
4. A returned provider report is persisted and the step enters `review`; the coordinator must approve it before downstream dependencies become ready.
5. External workers retrieve assigned work, start it, submit reports, and may provide lateral peer reviews.
6. On API startup, assigned/in-progress steps are reconciled for retry. This does not currently provide a heartbeat-driven stale-worker lease.

## Fixes applied in this audit

- Added coordinator authentication to external agent registration and deletion.
- Added agent authentication and identity matching to heartbeat and legacy GitHub task claim/progress/completion routes.
- Prevented provider-backed identities from using the separate legacy manual-claim path.
- Added validation for legacy task progress and completion payloads and prevented updates to tasks not owned by the caller or not currently in progress.
- Recalculate agent status after completion, and trigger scheduling after worker registration/heartbeat.
- Tightened Replit bridge health so a generic HTTP 200 response cannot be mistaken for a ready provider.
- Expanded CLI authentication-failure detection to cover common 401/403/unauthorized messages.
- Parse Manus v2 assistant output from its documented event shape and verify task detail/background-job state before considering stopped tasks complete.
- Documented the remaining boundaries in the provider guide.

## Findings that remain open

### P1 — Read-side API and Socket.IO are not authenticated

`GET /api/tasks`, `GET /api/agents`, `GET /api/events`, `GET /api/topology`, and `GET /api/health` are public; every Socket.IO connection receives the full framework snapshot. Task objects can include private GitHub issue bodies and URLs. CORS does not prevent direct API requests. Keep Spider on loopback/trusted networking or put it behind a properly authenticated gateway before network exposure.

### P1 — The dashboard does not drive the provider DAG

The dashboard's New Objective UI calls `POST /api/ceo/plan`, which creates GitHub issues. Provider execution uses the separate authenticated `/api/coordinator/plans` and `/api/coordinator/plans/draft` endpoints. Therefore the visible dashboard flow does not yet offer a complete create-plan → execute-with-providers → review flow.

### P1 — No stale-worker lease timeout

An external worker can be assigned or start a step and disappear without submitting. The step remains assigned/in-progress until manual repair or API process restart. Heartbeats trigger scheduling but do not currently expire stale leases. A robust fix needs lease timestamps, configurable timeout policy, and worker progress updates so valid long-running work is not incorrectly reassigned.

### P1 — GitHub task runtime changes are not durable

The GitHub task cache is an in-memory Map. Sync reconstructs tasks from GitHub issue metadata; claims, progress, and completion reports are not independently journaled to SQLite or written back to GitHub. Use the durable coordinator DAG for current persisted step execution, or implement task-state persistence before relying on the legacy issue-worker flow.

### P2 — Provider-specific end-to-end compatibility remains unverified

The CLI adapters depend on installed tool versions, flags, native login state, permissions, and output formats. Manus now parses its documented event shape and checks background-job state, but API calls and the custom Replit bridge still need real authenticated execution. Do not enable all adapters at once or treat CLI presence as proof of usable authentication.

## Audit conclusion

The source has a working architectural path for creating a durable plan, dispatching provider work, recording reports, and enforcing coordinator approval. It is not yet production-ready: unauthenticated read surfaces, dashboard workflow separation, missing stale-worker leases, in-memory GitHub task state, and unverified provider compatibility remain material blockers.

No tests or builds were run, per the project instruction.
