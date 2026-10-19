# Spider-web agent topology

## Goal

Spider uses a central coordinator and a peer-collaboration ring. The six named provider slots are Antigravity, Codex, Copilot, Kiro, Manus, and Replit. Each node has four lateral peer links: two positions clockwise and two counter-clockwise in the ring. The coordinator is the control plane; peer links describe collaboration routes, not separate provider sessions.

## Slot assignment

- The six named provider slots are reserved even when their providers are offline.
- When a registered agent ID or name matches a known provider, the API assigns that provider's canonical slot.
- An unrecognized agent, or a second instance of a provider already occupying its canonical slot, receives the next additional slot starting at index 6.
- Re-registering the same agent ID during the current API process preserves its assigned slot.
- `GET /api/topology` returns the coordinator, the six provider slots, their registered occupants, additional agents, and the peer-offset contract.
- `POST /api/agents/register` returns the assigned slot with the registered agent. Registration emits an `agent.registered` event including slot metadata, so the dashboard refreshes its graph.
- Agent records and slot assignments currently live in the API's in-memory registry. They reset when the API restarts; durable registry persistence is a separate follow-up.

## Peer topology

For six agents ordered A, B, C, D, E, F around the ring:

- A peers with B, C, E, F.
- B peers with A, C, D, F.
- C peers with A, B, D, E.
- D peers with B, C, E, F.
- E peers with A, C, D, F.
- F peers with A, B, D, E.

The dashboard keeps empty named slots visible, places registered agents in their assigned positions, and adds additional registered agents to an outer ring. The topology graphic is not proof that vendor CLIs or hosted APIs are authenticated or running.

## Message contract for the next collaboration layer

Every peer message should include:
- `taskId`, `traceId`, `fromAgent`, `toAgent`
- `kind`: `request_review`, `question`, `artifact_ready`, `blocker`, or `handoff`
- `summary`, `artifactRefs`, `createdAt`
- optional `replyTo` and `deadlineAt`

Use references to artifacts/branches rather than copying full transcripts. Messages should be append-only and auditable.

## Execution rules

1. The coordinator decomposes objectives and assigns one owner to each task.
2. Independent tasks may run in parallel, each in an isolated branch/worktree.
3. Peer agents collaborate through scoped messages and artifacts; they must not overwrite each other's workspace.
4. A reviewer should be independent of the author where practical.
5. The coordinator reconciles conflicting recommendations and owns final acceptance.
6. Bound message fan-out, retries, wall-clock time, and model/API spend. Detect cycles and stop repeated agent debates.
7. Keep human approval before merging or executing risky commands.

## Implementation status

Implemented in this change: canonical provider slot allocation, additional slots for other agents, registration responses/events with slot metadata, a topology API endpoint, and a dashboard graph that places agents according to their assigned slots.

Still separate work: durable agent/slot storage across API restarts, real provider adapters/authentication, live peer-message transport, task/artifact exchange, and end-to-end validation. Testing was intentionally not run in this change per the current project instruction.
