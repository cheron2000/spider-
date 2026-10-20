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
| Worker work/review queues, step start/submit/peer review, messages, acknowledgements, heartbeat, and legacy task claim/progress/completion | `requireMessageAgent`, followed by route-specific identity and ownership checks | Requires the configured shared agent key and a registered `x-agent-id`; route handlers check assigned ownership or sender/recipient identity where applicable. |
| `GET /api/health` | Public minimal liveness response | Returns only `ok` and a fixed service identifier. Detailed diagnostics are not exposed here. |
| `GET /api/coordinator/health` | `requireCoordinator` | Serves the dashboard's operational details only to an authenticated coordinator. |
| `POST /api/webhooks/github` | HMAC SHA-256 webhook signature validation | Rejects requests when the webhook secret is missing/placeholder or the signature is invalid. |
| Socket.IO framework snapshots/events | Coordinator sockets join the `coordinator` room; framework broadcasts target that room | Unauthenticated sockets do not receive the framework snapshot or general framework events. Agent sockets receive only their agent inbox/messages when the shared agent key and registered identity are supplied. |

### Remaining access-control limitation

**P1 — Agent identities are not cryptographically distinct.** All workers use the same `SPIDER_AGENT_API_KEY`, while `x-agent-id` identifies the requested worker. Route-level ownership checks prevent many cross-agent actions, but any party that possesses the shared agent key can assert another registered agent ID. Before treating workers as mutually untrusted, introduce per-agent credentials (stored safely, rotatable, and never returned by read APIs) or another mechanism that cryptographically binds each credential to exactly one identity.

CORS is not an authorization boundary. Coordinator authentication depends on keeping `SPIDER_COORDINATOR_API_KEY` secret; the current dashboard local-storage design is not suitable for shared or untrusted browser profiles.

## Execution path reviewed

1. `POST /api/coordinator/plans/draft` or `POST /api/coordinator/plans` creates a SQLite-backed dependency graph.
2. `advanceCoordinationPlan` marks dependency-ready steps and assigns available agents.
3. Provider-backed agents dispatch through `executeProviderAssignment` and `ProviderRuntimeManager`.
4. A provider report is persisted and the step enters `review`; downstream dependencies wait for coordinator approval.
5. External workers retrieve assigned work, start steps, submit evidence, and may provide lateral peer reviews. Peer feedback is advisory; coordinator review is authoritative.
6. Startup reconciliation resets in-flight coordination steps for recovery. It is not a heartbeat-driven lease and cannot safely detect all stale external workers.

## Findings that remain open

### P1 — Dashboard and durable provider DAG are separate workflows

The dashboard's New Objective UI calls `POST /api/ceo/plan`, which creates GitHub issues. Provider execution uses the separate authenticated `/api/coordinator/plans` and `/api/coordinator/plans/draft` endpoints. The visible dashboard does not yet provide a complete create-plan → provider execution → report review workflow. GitHub issue creation must not be described as automatically launching provider work.

### P1 — No stale-worker assignment lease

An external worker can disappear after assignment or start, leaving a step in `assigned` or `in_progress` until another recovery event or API restart. Heartbeats update agent status but do not expire step leases. A robust fix needs persisted assignment/lease timestamps, a timeout policy, safe reassignment, and rejection of results from revoked attempts. Retries also need defined idempotency rules for work that may already have changed files or external state.

### P1 — Legacy GitHub task state is in memory

The GitHub task cache is an in-memory `Map`. Sync reconstructs it from GitHub issue metadata, while claims, progress, and completion reports are not independently journaled to SQLite or reliably written back to GitHub. Persist this path or retire it in favor of the durable coordinator DAG.

### P2 — Provider end-to-end compatibility remains unverified

CLI adapters depend on installed versions, flags, native login state, permissions, and output formats. Manus output parsing and bridge-health checks exist in source, but live authenticated execution has not been demonstrated for all providers. Replit still requires a separately deployed bridge. A configuration/executable readiness signal is not proof of authentication or successful work execution.

### P2 — Execution evidence and review policy need further definition

Keep provider ID, step ID, attempt, workspace/revision identity, timestamps, exit status, bounded output, and changed-file references where available. A zero exit code alone must not auto-approve work. Peer reviews are currently advisory; coordinator approval remains the gating decision.

## Previously applied controls retained

- Coordinator authentication for external agent registration/removal and coordinator-only operations.
- Registered-agent checks and route-level ownership validation for worker operations.
- Protection against provider-backed identities using the legacy manual GitHub claim path.
- Validation of legacy task progress/completion payloads and in-progress ownership checks.
- Coordinator-only API data reads and framework Socket.IO delivery.
- GitHub webhook HMAC verification.
- Replit bridge readiness checks and improved CLI/Manus failure handling.

## Audit conclusion

The source now places coordinator-facing data behind coordinator authentication and reduces the public health endpoint to a minimal liveness response. The access-control boundary still has a shared-agent-key limitation: workers are not individually authenticated. The dashboard/DAG split, stale-worker lease handling, in-memory legacy task state, and provider compatibility remain open implementation risks.

This is a source-level audit, not a claim that endpoints or provider integrations passed runtime validation. No tests or builds were run, per the project instruction.
