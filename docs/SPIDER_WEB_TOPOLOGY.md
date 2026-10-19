# Spider-web agent topology

## Goal

Spider uses a central coordinator and a peer-collaboration ring. The six named provider slots are Antigravity, Codex, Copilot, Kiro, Manus, and Replit. Each node has four lateral peer links: two positions clockwise and two counter-clockwise in the ring. The coordinator is the control plane; peer links describe collaboration routes, not separate provider sessions.

## Slot assignment

- The six named provider slots are reserved even when their providers are offline.
- When a registered agent ID or name matches a known provider, the API assigns that provider's canonical slot.
- An unrecognized agent, or a second instance of a provider already occupying its canonical slot, receives the next additional slot starting at index 6.
- Re-registering the same agent ID preserves its assigned slot across API restarts.
- The API stores agent identity, runtime, capabilities, concurrency limit, slot assignment, status, and heartbeat timestamp in SQLite. The default file is `services/api/data/spider.db` (ignored by Git); set `SPIDER_DB_PATH` to override it.
- On hosts with ephemeral filesystems, mount persistent storage and point `SPIDER_DB_PATH` into that mount. This SQLite registry is intended for a single API instance; local container storage alone does not guarantee persistence across redeploys.
- `GET /api/topology` returns the coordinator, the six provider slots, their registered occupants, additional agents, and the peer-offset contract.
- `POST /api/agents/register` returns the assigned slot with the registered agent. Registration emits an `agent.registered` event including slot metadata, so the dashboard refreshes its graph.
- `DELETE /api/agents/:id` removes an idle agent and frees its slot. Agents with active tasks cannot be removed until those tasks are released or completed.
- On API startup, previously registered agents load with status `offline` and an empty active-task list. A successful registration marks the agent available again; the slot remains unchanged.
- Agent records and slot assignments survive API restarts. Task state and the event stream remain in memory and are not made durable by this registry change.

## Peer topology

For six agents ordered A, B, C, D, E, F around the ring:

- A peers with B, C, E, F.
- B peers with A, C, D, F.
- C peers with A, B, D, E.
- D peers with B, C, E, F.
- E peers with A, C, D, F.
- F peers with A, B, D, E.

The dashboard keeps empty named slots visible, places registered agents in their assigned positions, and adds additional registered agents to an outer ring. The topology graphic is not proof that vendor CLIs or hosted APIs are authenticated or running.

## Peer messaging API

Peer messages are persisted in the same SQLite database as the agent registry. The body of a message is immutable after creation; delivery and acknowledgement timestamps are recorded as state changes. Message status progresses from `queued` to `delivered` to `acknowledged`. Delivery is at-least-once: a pushed message may also appear in the inbox until acknowledged, so agents should deduplicate processing by message `id`.

### Configure access

Set `SPIDER_AGENT_API_KEY` to a long random secret in the API environment, then provide the same secret only to trusted agent runtimes. Messaging endpoints return `503` when the key is not configured. Do not commit the secret to Git or expose it in browser code.

Every HTTP request to the peer-messaging endpoints must include:
- `x-spider-agent-key: <shared secret>`
- `x-agent-id: <registered agent id>`

The shared key authenticates a trusted agent runtime group, while `x-agent-id` scopes inbox reads and acknowledgements. This is a single-trust-domain design, not separate per-agent credentials; do not give the key to untrusted users. Existing non-messaging API routes are not protected by this key, so keep the API on a trusted network or behind an authenticated gateway until the wider API receives unified authentication.

### Endpoints

- `GET /api/topology`: includes the ordered ring and `peerMap` with each registered agent's currently registered lateral peers.
- `POST /api/messages`: enqueue a message to a registered agent that is one of the sender's four lateral peers.
- `GET /api/agents/:id/messages?limit=20`: retrieve the authenticated agent's pending inbox. Limit is clamped to 1–100; retrieved queued messages are marked delivered.
- `POST /api/messages/:id/ack`: acknowledge a message in the caller's inbox. Acknowledgement is idempotent.

### Message payload

```json
{
  "taskId": "general",
  "traceId": "trace-unique-id",
  "fromAgent": "registered-sender-id",
  "toAgent": "registered-peer-id",
  "kind": "request_review",
  "summary": "Review the API error-handling change.",
  "artifactRefs": ["branch:feature/api-errors"],
  "replyTo": null,
  "deadlineAt": "2026-10-19T18:00:00Z"
}
```

`taskId` must be an existing task ID, or `general` for task-independent coordination. `replyTo` is optional; replies must target the original sender and preserve the original `taskId` and `traceId`. `deadlineAt` is optional ISO-8601 time. Artifacts should be references to branches, files, or other stored outputs rather than full transcripts.

When an authenticated agent connects to Socket.IO with `auth: { agentId, agentApiKey }`, it joins its private `agent:<id>` room and receives the `agent:message` event for new messages, plus an initial `agent:inbox` batch. Polling the HTTP inbox remains available for reconnect/recovery. The dashboard receives redacted `agent.message.queued`, `agent.message.delivered`, and `agent.message.acknowledged` activity events; full message bodies are sent only to the intended agent room or returned to that agent's authenticated inbox.

Messages are rejected if the sender does not match the authenticated agent ID, the recipient is not registered, the task ID is invalid, or the recipient is outside the sender's four-peer neighborhood. Peer adjacency is calculated from the six reserved slots followed by additional registered slots in order.

## Coordinated task execution

Coordination plans, step assignments, and step reports are durable in SQLite. Plan creation validates unique step keys, dependency references, and acyclic dependency graphs before saving. The built-in draft plan includes discovery, architecture, implementation, parallel validation/security review, integration, and final acceptance. Custom plans can supply their own DAG.

### Coordinator authentication

Set `SPIDER_COORDINATOR_API_KEY` to a separate long random secret (32+ random bytes). Coordinator endpoints require:

- `x-spider-coordinator-key: <coordinator secret>`

Keep this key server-side. Do not embed it in the browser/dashboard bundle. `GET /api/health` reports whether coordinator actions are enabled, without revealing any secret.

### Lifecycle endpoints

- `POST /api/coordinator/plans/draft` with `{"objective":"..." }` creates and schedules the standard seven-step plan.
- `POST /api/coordinator/plans` accepts `objective` and a `steps` array. Each step has `key`, `title`, `description`, optional `dependsOn`, optional `requiredCapabilities`, and optional `maxAttempts` (1–5). The dependency graph is validated before a plan is persisted.
- `GET /api/coordinator/plans` and `GET /api/coordinator/plans/:id` return durable plan state and reports. `POST /api/coordinator/plans/:id/advance` retries scheduling when agents become available.
- `GET /api/agents/:id/work` returns work assigned to the authenticated agent. Agent routes require the shared `x-spider-agent-key` and `x-agent-id` headers.
- `POST /api/coordinator/steps/:id/start` records that the assigned owner started a step. `POST /api/coordinator/steps/:id/submit` stores a summary and evidence and moves the step into coordinator review.
- `GET /api/agents/:id/reviews` returns submitted steps authored by a neighboring agent that are available for independent peer review.
- `POST /api/coordinator/steps/:id/peer-review` accepts `decision` (`approve`, `request_changes`, or `comment`), required `feedback`, and optional evidence. One peer review per reviewer per attempt is recorded durably. Only a lateral peer of the author may submit; the author cannot review their own work.
- `GET /api/coordinator/reviews` gives the coordinator a pending-review queue with the author's report and current-attempt peer feedback.
- `POST /api/coordinator/steps/:id/review` is the final coordinator decision (`approve` or `reject`). Approval marks the step done and unlocks dependent steps. Rejection requires feedback; it returns the step to the ready queue while attempts remain, otherwise marks it failed.

The coordinator, not a peer reviewer, remains the final authority. Peer feedback is advisory input for reconciling outputs; downstream steps stay blocked until the coordinator approves the submitted report. Each step has a single accountable owner, attempts are bounded, and failed dependencies prevent dependent work from running.

### Recovery and boundaries

On API startup, assigned/in-progress steps left behind by a crash are recovered: steps with attempts remaining return to the ready queue; exhausted steps become failed. Previously registered agents start offline, so recovered work is not reassigned until an agent reconnects. Registering an agent triggers scheduling across incomplete plans. A step in review remains in review across restart, preserving the submitted report and its peer feedback.

This provides durable coordination and review workflow, not a vendor tool adapter. The named Antigravity, Codex, Copilot, Kiro, Manus, and Replit slots are still registry identities. Their actual runtimes must be integrated to poll/receive work, invoke authorized provider tools, store artifact references, submit evidence, and report heartbeat/capabilities. No provider CLI, browser-control tool, or hosted model API is implicitly connected by registering an agent.

## Execution rules

1. The coordinator decomposes objectives and assigns one owner to each task.
2. Independent tasks may run in parallel, each in an isolated branch/worktree.
3. Peer agents collaborate through scoped messages and artifacts; they must not overwrite each other's workspace.
4. A reviewer should be independent of the author where practical.
5. The coordinator reconciles conflicting recommendations and owns final acceptance.
6. Bound message fan-out, retries, wall-clock time, and model/API spend. Detect cycles and stop repeated agent debates.
7. Keep human approval before merging or executing risky commands.

## Implementation status

Implemented: canonical provider slot allocation, SQLite-backed agent/slot persistence, a durable peer message queue, authenticated inbox/send/ack endpoints, four-peer routing validation, private Socket.IO agent rooms, redacted activity events, idle-agent removal, durable dependency-aware coordination plans, capability-aware assignment, crash recovery for in-flight steps, durable submission reports, a neighboring-agent review queue, persistent peer-review feedback, coordinator approval/rejection with bounded retries, and topology responses with peer maps.

Still separate work: real provider adapters/authentication, per-agent credentials, artifact storage beyond recorded references, richer dashboard presentation for coordination plans/reviews, unified authentication for legacy non-messaging routes, and end-to-end validation. Tests and builds were not run per the project instruction.
