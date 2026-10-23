# Spider Framework — Context Window / Engineering Handoff

**Audit date:** 2026-10-23  
**Repository:** https://github.com/cheron2000/spider-  
**Branch:** `main`  
**Tree SHA inspected:** `a3c0ac45da8e83c5981d1b9afdf3009a0fcb64fa`  
**Latest commit inspected:** `a3c0ac4` — Capture structured provider execution provenance (2026-10-21)  
**Purpose:** Carry-forward context for continued implementation and review.  
**Validation PR:** https://github.com/cheron2000/spider-/pull/4 (`codex/api-test-baseline`, draft PR).

## 1. Executive summary

Spider is a multi-agent orchestration framework. A central coordinator turns an objective into a dependency-aware directed acyclic graph (DAG), assigns ready steps to available provider/worker identities, persists results and evidence, and gates downstream execution on explicit coordinator approval.

Six canonical provider slots are reserved: Antigravity, Codex, Copilot, Kiro, Manus, and Replit. The system contains a Node.js/Express API, SQLite persistence, provider adapters/runtime management, worker APIs and peer messaging, Socket.IO events, and a React/Vite dashboard.

**Important maturity caveat:** Code and docs are present for the workflows described below, but they are not proof of successful runtime behavior. The checked-in execution audit explicitly says tests/builds were not run as part of that audit. No application build, test suite, live provider call, or deployment test was run in this review.

## 2. Repository map

- `README.md`: capabilities, quick start, security/maturity warnings.
- `.env.example`: runtime configuration and secrets template.
- `.github/workflows/ci.yml`: Node 20 CI runs `npm install`, `npm test`, and `npm run build`; the dashboard build is separate from the API tests.
- `package.json`: ESM Node package, scripts, API dependencies, dashboard workspace.
- `services/api/src/index.js` (~969 lines): API server, authorization, GitHub issue mirror, coordinator, provider dispatch, peer messaging, socket events, lease sweeper, startup recovery.
- `services/api/src/agentRegistry.js` (~662 lines): SQLite schema/migrations and stores for agents, credentials, messages, coordination plans/steps/reports/reviews, execution journal, leases and recovery.
- `services/api/src/providers/base.js` (~265 lines): provider-neutral CLI adapter base, safe child environment, prompt builder, bounded output, secret redaction, process execution, workspace inspection, CLI result/error parsing.
- `services/api/src/providers/runtime.js` (~154 lines): provider health/refresh loop, active-call accounting, workspace-collision prevention, dispatch, result provenance.
- `services/api/src/providers/index.js`: assembles six adapters.
- `services/api/src/providers/antigravity.js`, `codex.js`, `copilot.js`, `kiro.js`: local CLI adapters using the common command adapter.
- `services/api/src/providers/manus.js`: Manus API v2 task creation and polling with final-task-state checks.
- `services/api/src/providers/replit.js`: authenticated external HTTPS bridge contract.
- `apps/dashboard/src/App.jsx`: dashboard state, coordinator auth, plan create/advance, review/retry, journal and GitHub mirror.
- `apps/dashboard/src/SpiderWeb.jsx`: six-slot topology and additional registered workers.
- `apps/dashboard/src/styles.css`: dashboard styling and responsive rules.
- `apps/dashboard/src/main.jsx`, `apps/dashboard/index.html`, `apps/dashboard/vite.config.js`: React bootstrap, entry HTML, Vite proxy.
- `schemas/task.schema.json`: generic/legacy task JSON schema.
- `agents/python_worker.py`: old/simple external-worker prototype that registers and heartbeats.
- `agents/requirements.txt`: Python requests dependency.
- `docs/EXECUTION_AUDIT.md`: latest source-level security/execution audit; best high-level risk reference.
- `docs/PROVIDER_ADAPTERS.md`: provider setup, lifecycle, runtime/security boundaries; contains one older dashboard-workflow statement that conflicts with current source/newer audit.
- `docs/SPIDER_WEB_TOPOLOGY.md`: topology, messaging, coordination endpoints, peer review, lifecycle.

The recursive tree response was not truncated. Principal implementation and docs were directly inspected; this was not a line-by-line verification of every file and no runtime tests were performed.

## 3. Current architecture and data flow

### Durable coordination path (primary orchestration)

1. Coordinator creates a standard plan with `POST /api/coordinator/plans/draft` or a custom DAG with `POST /api/coordinator/plans`.
2. Request validation checks keys, dependency references, duplicates, self-dependencies, and cycles.
3. Scheduler marks dependency-ready steps and assigns them to currently available agents/providers that satisfy capability/capacity rules.
4. Assignment has a unique token, attempt number, assignment timestamps, lease expiry, and last-activity time.
5. Provider-backed assignments go through `executeProviderAssignment` and `ProviderRuntimeManager`; external workers poll their authenticated work queue.
6. Workers/providers start and submit using identity + current assignment token. Step submission and report insertion are stored atomically in SQLite.
7. A submission transitions the step to `review`, not `done`. Downstream dependencies remain blocked.
8. Optional lateral peer reviews are advisory. A coordinator approves or rejects through `POST /api/coordinator/steps/:id/review`.
9. Approval marks a step `done` and can unblock dependants. Rejection returns work to `ready` when attempts remain, otherwise `failed`.
10. A failed step can only be explicitly retried through `POST /api/coordinator/steps/:id/retry`, with a reconciliation reason, and only if all dependencies are done.

### Durable state vs in-memory state

SQLite uses `better-sqlite3`, WAL mode, a busy timeout and foreign keys. Default database path is `services/api/data/spider.db`; `SPIDER_DB_PATH` overrides it.

Persisted records include:
- Agent identity and stable slot allocation.
- Per-agent credential hashes.
- Peer messages, delivery and acknowledgement state.
- Coordination plans and steps, assignment leases/tokens, attempt reports and review feedback.
- Peer-review records.
- Append-only execution journal.

The execution journal has database triggers rejecting updates and deletes. Journal API endpoints support plan/step filters and pagination.

Still in memory:
- Legacy GitHub issue task cache (`Map`), including claim/progress/completion state.
- API activity event array (bounded to last 300 events).
- Provider in-flight calls and pending assignments.

GitHub issue sync reconstructs task snapshots from GitHub issue metadata. Local progress/completion state is not independently persisted and is not reliably written back to GitHub. GitHub issue sync is separate from provider DAG execution; syncing issues does not launch provider work.

## 4. Provider integrations

| Slot | Adapter/runtime | Current source behavior | External setup required |
|---|---|---|---|
| Antigravity | Local CLI | `agy -p ... --output-format json --sandbox` | Install/login CLI; enable env; dedicated existing workspace |
| Codex | Local CLI | `codex exec --sandbox ... --json ...` | Install/login CLI; workspace; choose safe sandbox |
| Copilot | Local CLI | `copilot -p ... --output-format json --no-ask-user` | Install/login CLI; workspace |
| Kiro | Local CLI | `kiro-cli chat --no-interactive ...` | Install/login CLI; workspace |
| Manus | API v2 | Creates private task and polls messages/detail; checks background-job state on stop | `MANUS_API_KEY`; enable adapter |
| Replit | Remote bridge | Authenticated `GET /health`, `POST /execute`; bearer token | Build, deploy and secure a separate bridge; URL/token |

All providers are offline by default. Local CLI health checks validate enablement, workspace directory, and executable availability; `authState: not-probed` is not proof of successful authenticated execution. The first real task call is the functional auth check. Remote providers also require real credentials or a valid bridge.

Safety controls in source:
- Local child process environment is an allowlist; only explicitly selected passthrough variables are added.
- Output is bounded and common API key/token formats are redacted.
- CLI calls use `cross-spawn` with `shell:false`, process timeout, and termination handling.
- Local providers allow one task at a time each.
- Enabled local providers resolving to the same canonical workspace are blocked.
- Codex sandbox accepts `read-only` or `workspace-write`, defaulting to read-only for invalid/omitted config; example env opts into workspace-write for implementation work.
- Provider prompts explicitly disallow commit/push/merge/deploy/release.
- An adapter's successful exit/report does not approve the DAG step.
- Provider provenance includes adapter ID, invocation time range, local canonical workspace when available, adapter-reported success, evidence count, process exit code/signal and parsed CLI result status where available. `changedFileRefs` remains empty unless adapters provide verified references; this metadata is not independent proof of file changes.

Runtime limits:
- CLI/provider flags, output schemas, authentication and tool permission semantics are not end-to-end verified across all provider versions.
- Replit bridge is only a contract/adapter; it is not deployed by Spider.
- Local workspace path checks are not an OS sandbox: provider tools can potentially access paths allowed by host/container and native provider permissions.

## 5. API and authorization

### Coordinator auth
`SPIDER_COORDINATOR_API_KEY` must be a non-placeholder secret of at least 32 characters. Coordinator routes expect `x-spider-coordinator-key`; absent/invalid configuration disables actions. The dashboard stores the key in browser local storage and sends it with API requests and socket handshake. Use only a trusted browser profile.

Coordinator-protected read surfaces include tasks, agents, events, providers, topology, health/diagnostics, plans, reviews, execution journal, and step history. Coordinator actions include planning, scheduling, approve/reject, retry, worker registration/credential rotation/removal and provider refresh.

### External worker auth
Worker routes require `x-agent-id` and a matching `x-spider-agent-key`. Registration/rotation returns a random credential once and stores only its SHA-256 hash. Hash comparison is constant-time. Identity/ownership checks follow authentication. Provider-managed identities cannot be treated as ordinary external workers.

### GitHub webhook
Webhook handler validates HMAC SHA-256 with a configured non-placeholder `GITHUB_WEBHOOK_SECRET` (minimum 32 chars); payload uses raw body parsing for validation. GitHub API integration requires `GITHUB_TOKEN` and `GITHUB_REPOSITORY=owner/repo`.

### Socket.IO
Authenticated coordinator sockets receive the framework snapshot and coordinator activity events. Agent sockets require a registered identity and correct per-agent credential and receive private inbox/message notifications. Unauthenticated sockets should not receive framework snapshots/events.

### Security limitations
- CORS is not an authorization boundary.
- Do not expose the API directly to an untrusted network; use a trusted local network or authenticated gateway.
- Browser local storage is unsuitable for shared/untrusted profiles.
- API and local provider CLI run on the same host/container; OS/container isolation is needed before multi-tenant operation.
- Secrets must not be committed, embedded in dashboard source, placed in task prompts, or broadly passed to provider processes.

## 6. Key endpoints

### Primary coordinator/DAG endpoints
- `GET /api/coordinator/health`
- `GET /api/providers`
- `POST /api/coordinator/providers/:id/refresh`
- `GET /api/coordinator/plans?limit=20`
- `GET /api/coordinator/plans/:id`
- `POST /api/coordinator/plans/draft`
- `POST /api/coordinator/plans` (custom plan)
- `POST /api/coordinator/plans/:id/advance`
- `GET /api/coordinator/reviews`
- `POST /api/coordinator/steps/:id/review`
- `POST /api/coordinator/steps/:id/retry`
- `GET /api/coordinator/execution-journal?planId=&stepId=&limit=&offset=`
- `GET /api/coordinator/steps/:id/execution-history`

### Worker and peer routes
- `POST /api/agents/register` (coordinator-authenticated)
- `POST /api/agents/:id/credential` (rotate credential)
- `DELETE /api/agents/:id`
- `POST /api/agents/:id/heartbeat`
- `GET /api/agents/:id/work`
- `POST /api/coordinator/steps/:id/start`
- `POST /api/coordinator/steps/:id/submit`
- `POST /api/coordinator/steps/:id/heartbeat` (lease renewal)
- `GET /api/agents/:id/reviews`
- `POST /api/coordinator/steps/:id/peer-review`
- `POST /api/messages`
- `GET /api/agents/:id/messages?limit=20`
- `POST /api/messages/:id/ack`

### GitHub issue mirror / legacy task endpoints
- `POST /api/github/sync`
- `POST /api/ceo/plan` (creates deterministic starter issues/epic; not DAG provider execution)
- `GET /api/tasks`
- `POST /api/tasks/:id/claim`
- `POST /api/tasks/:id/progress`
- `POST /api/tasks/:id/complete` (submits for review; does not close the GitHub issue)
- `POST /api/webhooks/github`

`GET /api/health` is intentionally minimal and public. It is not a detailed operational diagnostic endpoint.

## 7. Dashboard state

The current `apps/dashboard/src/App.jsx` primary flow:
- Reads coordinator key from local storage, sends it via authenticated `apiFetch`, and connects Socket.IO using `coordinatorKey`.
- Refreshes coordinator state and plans periodically, currently every 15 seconds, as a fallback to live events.
- Creates durable plans with `POST /api/coordinator/plans/draft`.
- Displays DAG nodes and dependency edges with React Flow.
- Shows review queue, report/evidence history, approve/reject actions, retry dialog requiring reconciliation notes + confirmation, and persisted execution journal.
- Shows provider spider-web topology and a GitHub issue mirror.
- Dashboard explicitly indicates GitHub sync does not launch provider work.

**Documentation drift:** Some older wording in `docs/PROVIDER_ADAPTERS.md` says its dashboard objective action calls `POST /api/ceo/plan`. That conflicts with current `App.jsx` and the newer `docs/EXECUTION_AUDIT.md`, which describe the durable DAG as the primary flow. Treat source + newer audit as authoritative; update stale documentation in a cleanup task.

## 8. Recovery and execution semantics

- Assignment leases are token-fenced. A worker can renew/start/submit only while the current token is valid and the lease is unexpired.
- The default lease duration is 120 seconds, clamped to 30 seconds–1 hour by `SPIDER_ASSIGNMENT_LEASE_MS`.
- API startup reconciles in-flight assignments, revokes old assignment tokens and journals recovery for each step, retaining prior agent/provider identity and reason.
- Expired assignments that never started may be returned to ready if attempt budget permits; exhausted attempts fail.
- Expired work that started (`in_progress`) fails closed rather than auto-retrying because a provider may already have changed files or external systems.
- An active provider invocation in the current process is excluded from the lease sweeper until the invocation exits.
- Provider adapter exceptions after execution starts fail the step even if attempt budget remains; an exception cannot prove that the external action did not occur.
- Explicit retry requires coordinator-supplied reconciliation explanation and all dependencies done. Dashboard also requires the user to confirm side-effect reconciliation.
- Assignment-token fencing prevents stale results from being accepted, but it cannot undo side effects.

## 9. Build, tests and verification

Root scripts:
- `npm run dev`: concurrently launches API and dashboard.
- `npm run dev:api`: `node --watch services/api/src/index.js`.
- `npm run dev:web`: dashboard Vite development server.
- `npm test`: built-in Node test runner for API integration and provider utility tests.
- `npm run build`: dashboard build only.
- `npm start`: API start.
- Node.js 20+ is specified.

**Validation baseline added in draft PR #4:** `services/api/test/coordinator.test.js` covers coordinator auth, graph-cycle rejection, worker credentials/identity, lease-token fencing, atomic report submission, dependency approval gating, retry guards, journal events, and in-progress restart recovery. `services/api/test/provider-base.test.js` covers secret redaction, structured CLI output parsing, provider-reported failure detection, transient reconnect handling, and child environment allowlisting.

GitHub Actions run [39987558952](https://github.com/cheron2000/spider-/actions/runs/39987558952) completed successfully: 6 tests passed, 0 failed, and the dashboard build passed. This proves the new test suite and dashboard build passed on GitHub's Node 20 runner; it does not prove live provider execution, deployment security, or full production readiness.

## 10. Findings and priorities

### P0 — Establish reproducible validation (baseline implemented; expand coverage)
- Completed in draft PR #4: Node's built-in test runner, isolated SQLite/API integration test, provider utility tests, and CI job that runs tests plus dashboard build.
- Verified in GitHub Actions run 39987558952: 6 tests passed, 0 failed; dashboard build passed.
- Remaining: expand coverage for peer messaging/peer-review authorization, lease expiration before start, malformed provider responses, adapter timeout/termination, workspace collision behavior, and GitHub webhook signature validation.
- Do not claim live provider execution or end-to-end deployment readiness from this CI result.

### P1 — Complete durability and simplify dual task systems
- Either persist the legacy GitHub task cache's progress/ownership/completion in SQLite or explicitly retire that path in favor of the durable DAG.
- Clarify how GitHub issues map to plan steps if that integration is desired; today these are separate workflows.
- Update `docs/PROVIDER_ADAPTERS.md` outdated dashboard statement.

### P1 — Provider end-to-end compatibility
- For each CLI, pin/document supported CLI versions and test argument/output parsing against representative real CLI output.
- Validate authenticated calls individually in dedicated, isolated workspaces; test timeout, process termination, auth failure and malformed output.
- Deploy and security-test the Replit bridge contract independently.
- Keep provider adapters offline until the intended local and remote execution paths have passed real acceptance tests.

### P1 — Deployment security and isolation
- Review API access from untrusted networks; put it behind trusted ingress/authentication/TLS and set CORS appropriately.
- Avoid dashboard access on shared browsers because coordinator key is stored in local storage.
- Run local providers in per-provider OS/container sandboxes and dedicated worktrees; canonical-path collision guard alone is not isolation.
- Ensure persistent volume for SQLite when deployed on ephemeral compute.
- Apply request rate limits, bounded concurrency, and resource controls before public/tenant use.

### P2 — Improve observability and artifacts
- Store verifiable file/revision/artifact references instead of relying on provider prose.
- Add artifact diff/status capture, immutable identifiers, and provider-specific provenance schemas.
- Add coordinator dashboards for provider-auth state, failure reason trends, stuck plans, lease expiry and reconciliation outcomes.

## 11. Suggested next implementation sequence

1. **Review and merge validation PR #4** after inspecting the diff; its first CI run is green.
2. **Extend validation coverage** for peer review/messaging, lease sweeps, provider timeout and workspace collision paths.
3. **Durable task model:** decide whether GitHub issues are inputs/mirrors for DAG steps or a retired parallel task path.
3. **Provider integration tests:** one provider at a time, fake adapters first then authenticated smoke tests in isolated workspaces.
4. **Recovery correctness:** cover every lease/restart/late-report/adapter-exception edge case with tests.
5. **Security hardening:** isolate local CLIs at OS/container level; add deployment gateway/rate limits and improve secret/session handling.
6. **Artifact provenance:** attach verifiable git diff/commit/tree/artifact references after successful execution, without auto-approving any provider result.

## 12. Environment and launch notes

1. Install Node.js 20 or newer.
2. Clone repo and run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set a high-entropy `SPIDER_COORDINATOR_API_KEY` of at least 32 characters.
5. Configure `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `GITHUB_WEBHOOK_SECRET` only if GitHub integration/webhooks are needed.
6. Start with all providers offline. Enable a provider only after installing/authenticating its CLI or service, setting its dedicated workspace/config, and verifying it independently.
7. Run `npm run dev`; dashboard is expected at `http://localhost:5173` and API at `http://localhost:4000`.

Never place real secrets in source or prompts, and never assume that a provider is authenticated solely because the executable is present.

## 13. Source references

- Repository: https://github.com/cheron2000/spider-
- README: https://github.com/cheron2000/spider-/blob/main/README.md
- Execution audit: https://github.com/cheron2000/spider-/blob/main/docs/EXECUTION_AUDIT.md
- Provider guide: https://github.com/cheron2000/spider-/blob/main/docs/PROVIDER_ADAPTERS.md
- Topology doc: https://github.com/cheron2000/spider-/blob/main/docs/SPIDER_WEB_TOPOLOGY.md
- API coordinator: https://github.com/cheron2000/spider-/blob/main/services/api/src/index.js
- SQLite stores: https://github.com/cheron2000/spider-/blob/main/services/api/src/agentRegistry.js
- Provider runtime: https://github.com/cheron2000/spider-/blob/main/services/api/src/providers/runtime.js
- Provider base: https://github.com/cheron2000/spider-/blob/main/services/api/src/providers/base.js
- Dashboard: https://github.com/cheron2000/spider-/blob/main/apps/dashboard/src/App.jsx

## Continuation instruction for the next session

Use `cheron2000/spider-` as the source of truth. Review draft PR #4 (`codex/api-test-baseline`) and its green CI run, then merge when the diff is acceptable. The P0 validation baseline is now present on that branch. Next, extend security/recovery coverage and proceed to the durable GitHub task-model decision. Do not modify provider execution/retry semantics without regression tests for leases, stale assignment tokens and potentially non-idempotent external side effects. Keep coordinator approval as the final gate. Do not claim production readiness or provider end-to-end compatibility without reproducible evidence.
