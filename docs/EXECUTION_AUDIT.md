# Spider source-level execution audit

**Date:** 2026-10-20  
**Repository:** `cheron2000/spider-`  
**Branch:** `main`  
**Audited base:** `9903f37b0a4e2fa433ef653f3bf86f381bcf0128` (`Protect dashboard read APIs and live events`)  
**Scope:** HTTP authorization, Socket.IO delivery, durable coordination, worker lifecycle, provider dispatch, and dashboard integration.  
**Verification boundary:** source inspection only. No tests or builds were run.

## Access-control review

The current source protects coordinator-facing data and action surfaces. The dashboard sends its coordinator key in the `x-spider-coordinator-key` header and the Socket.IO handshake. The key is stored in browser local storage, so the dashboard should only be used from a trusted browser profile. Do not embed a real key in source or expose the API directly to an untrusted network.

| Surface | Current control | Assessment |
| --- | --- | --- |
| `GET /api/tasks`, `/api/agents`, `/api/events`, `/api/providers`, `/api/topology` | `requireCoordinator` | Protected by a configured coordinator secret of at least 32 characters. |
| Coordinator plan, review, provider-refresh, GitHub-sync, issue-planning, registration, and removal actions | `requireCoordinator` | Protected by coordinator authorization. |
| Worker work/review queues, step start/submit/peer review, messages, acknowledgements, heartbeat, and legacy task claim/progress/completion | `requireMessageAgent`, followed by route-specific identity and ownership checks | Requires the registered agent's per-agent credential in `x-spider-agent-key`; the credential hash must match the registered `x-agent-id`. |
| `GET /api/health` | Public minimal liveness response | Returns only `ok` and a fixed service identifier. Detailed diagnostics are not exposed here. |
| `GET /api/coordinator/health` | `requireCoordinator` | Serves the dashboard's operational details only to an authenticated coordinator. |
| `POST /api/webhooks/github` | HMAC SHA-256 webhook signature validation | Rejects requests when the webhook secret is missing/placeholder or the signature is invalid. |
| Socket.IO framework snapshots/events | Coordinator sockets join the `coordinator` room; framework broadcasts target that room | Unauthenticated sockets do not receive the framework snapshot or general framework events. Agent sockets receive only their agent inbox/messages when a valid per-agent credential and registered identity are supplied. |

### Remaining access-control limitation

**Mitigated at source level — per-agent credential binding.** External worker credentials are generated per identity, stored in SQLite only as SHA-256 hashes, verified with constant-time comparison, and returned only once by registration or explicit credential rotation. HTTP worker routes and agent Socket.IO rooms validate the credential against the claimed registered identity. Existing agents without individual credentials must be provisioned or rotated by a coordinator before worker authentication succeeds. This change has not been runtime-tested.

CORS is not an authorization boundary. Coordinator authentication depends on keeping `SPIDER_COORDINATOR_API_KEY` secret; the current dashboard local-storage design is not suitable for shared or untrusted browser profiles.

## Execution path reviewed

1. `POST /api/coordinator/plans/draft` or `POST /api/coordinator/plans` creates a SQLite-backed dependency graph.
2. `advanceCoordinationPlan` marks dependency-ready steps and assigns available agents.
3. Provider-backed agents dispatch through `executeProviderAssignment` and `ProviderRuntimeManager`.
4. A provider report is persisted and the step enters `review`; downstream dependencies wait for coordinator approval.
5. External workers retrieve assigned work, start steps, submit evidence, and may provide lateral peer reviews. Peer feedback is advisory; coordinator review is authoritative.
6. Startup reconciliation revokes all in-flight assignment tokens; during runtime, persisted leases can be renewed only with the current token. Startup now writes one journal event per recovered step, retaining the previous agent/provider identity, attempt, resulting state, and reconciliation reason, plus an aggregate recovery count. Expired work is requeued within the attempt limit or failed when exhausted. Coordinator approval remains required.

## Findings that remain open

### Phase 5 hardening — coordinator response redaction and recovery visibility

Coordinator-facing plan serialization now omits per-assignment lease tokens from step objects, including plan lists/details, plan creation/advance responses, report submissions, review queues, and retry/review responses. Agent work retrieval remains token-bearing because workers need the token to prove lease ownership. The dashboard refreshes coordinator state periodically as a fallback to live events, shows per-attempt report summaries/evidence and review outcomes, and exposes a retry dialog requiring a reconciliation note and explicit confirmation before calling the existing guarded retry endpoint. The server continues to enforce failed-state and dependency checks. Source-level review only; tests and builds were not run.

### P1 — Dashboard and durable provider DAG are separate workflows

The dashboard's primary New Execution Plan flow now calls authenticated `POST /api/coordinator/plans/draft`, lists and inspects durable coordinator plans, visualizes dependency edges and step states, surfaces pending reports, provides approve/reject controls through `POST /api/coordinator/steps/:id/review`, and displays the plan-scoped execution journal. A manual Advance Plan action calls the coordinator scheduler. The legacy GitHub issue cache remains visible as a separate mirror; syncing issues does not launch provider work. This is source-level implementation only and has not been runtime-tested.

### P1 — Lease expiry cannot cancel external side effects

Coordination steps persist assignment time, last activity, lease expiry, and a unique assignment token. Start and submission are token-fenced, and reports are saved atomically. An expired assignment that never started may be requeued within the attempt budget. Once a step entered `in_progress`, lease expiry or API restart marks it failed instead of automatically retrying, because work may already have changed files or external systems. A coordinator must explicitly retry a failed step using `POST /api/coordinator/steps/:id/retry` with a reconciliation reason; that route requires all dependencies to be done and adds one attempt to the allowed budget.

The lease sweeper defers an expired step while its provider invocation is still active in the current process. After that invocation exits, the lease is reconciled before any retry can be scheduled. Provider adapter exceptions after a step enters `in_progress` now also mark the step `failed` regardless of remaining attempt budget: an exception does not prove the adapter did not perform external side effects. The failure feedback requires coordinator reconciliation before an explicit retry. Assignment-token fencing still cannot undo external side effects. A retry is safe only after the coordinator reconciles those effects or applies task-specific compensation.

### P1 — Legacy GitHub task state is in memory

The GitHub task cache is an in-memory `Map`. Sync reconstructs it from GitHub issue metadata, while claims, progress, and completion reports are not independently journaled to SQLite or reliably written back to GitHub. Persist this path or retire it in favor of the durable coordinator DAG.

### P2 — Provider end-to-end compatibility remains unverified

CLI adapters depend on installed versions, flags, native login state, permissions, and output formats. Manus output parsing and bridge-health checks exist in source, but live authenticated execution has not been demonstrated for all providers. Replit still requires a separately deployed bridge. A configuration/executable readiness signal is not proof of authentication or successful work execution.

### P1 — Execution journal and provenance

Coordination lifecycle events are written to an append-only SQLite execution journal and exposed through coordinator-authenticated, paginated read endpoints. Each event stores a stable event ID, type, timestamp, plan/step/attempt/agent/provider identity where available, and a small allowlisted set of redacted details. Database triggers reject updates and deletes. Provider submissions now attach a versioned `spider.provider-provenance.v1` JSON record to report evidence and the submission journal event. It records provider identity, adapter-reported success, invocation start/completion times, canonical local workspace path when available, process exit code/signal and parsed status for local CLI adapters, evidence count, and an explicit empty `changedFileRefs` list until adapters can provide verified file/revision references. These are adapter-reported/coordinator-observed metadata, not independent proof that files changed as claimed; Replit bridge responses currently do not supply process exit details. A zero exit code alone must not auto-approve work. Peer reviews remain advisory; coordinator approval is the gating decision.

## Previously applied controls retained

- Coordinator authentication for external agent registration/removal/credential rotation and coordinator-only operations.
- Per-agent credential hashes in SQLite, constant-time credential verification, and route-level ownership validation for worker operations.
- Protection against provider-backed identities using the legacy manual GitHub claim path.
- Validation of legacy task progress/completion payloads and in-progress ownership checks.
- Coordinator-only API data reads and framework Socket.IO delivery.
- GitHub webhook HMAC verification.
- Replit bridge readiness checks and improved CLI/Manus failure handling.

## Audit conclusion

The source places coordinator-facing data behind coordinator authentication and reduces the public health endpoint to a minimal liveness response. Per-agent credential binding, local workspace collision blocking, and explicit recovery of expired in-progress steps are implemented at source level but not runtime-tested. The dashboard/DAG split, in-memory legacy task state, provider compatibility, and the limits of containing external side effects remain open risks.

This is a source-level audit, not a claim that endpoints or provider integrations passed runtime validation. No tests or builds were run, per the project instruction.
