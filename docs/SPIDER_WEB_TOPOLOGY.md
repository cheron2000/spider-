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

Peer messages are persisted in the same SQLite database as the agent registry. The body of a message is immutable after creation; delivery and acknowledgement timestamps are recorded as state changes. Message status progresses from `queued` to `delivered` to `acknowledged`.

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

## Execution rules

1. The coordinator decomposes objectives and assigns one owner to each task.
2. Independent tasks may run in parallel, each in an isolated branch/worktree.
3. Peer agents collaborate through scoped messages and artifacts; they must not overwrite each other's workspace.
4. A reviewer should be independent of the author where practical.
5. The coordinator reconciles conflicting recommendations and owns final acceptance.
6. Bound message fan-out, retries, wall-clock time, and model/API spend. Detect cycles and stop repeated agent debates.
7. Keep human approval before merging or executing risky commands.

## Implementation status

Implemented: canonical provider slot allocation, SQLite-backed agent/slot persistence, a durable peer message queue, authenticated HTTP inbox/send/ack endpoints, four-peer routing validation, authenticated Socket.IO agent rooms, redacted dashboard activity events, idle-agent removal, and topology responses with peer maps.

Still separate work: real provider adapters/authentication, per-agent credentials, durable task/event state, artifact storage, task orchestration, and end-to-end validation. Testing and builds were intentionally not run per the current project instruction.
