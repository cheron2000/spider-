import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleDirectory=dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath=resolve(moduleDirectory,'../data/spider.db');
const databasePath=resolve(process.env.SPIDER_DB_PATH||defaultDatabasePath);
mkdirSync(dirname(databasePath),{recursive:true});

const db=new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK (runtime IN ('local', 'remote')),
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
    slot_index INTEGER NOT NULL UNIQUE CHECK (slot_index >= 0),
    slot_id TEXT NOT NULL,
    slot_label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offline',
    current_tasks_json TEXT NOT NULL DEFAULT '[]',
    registered_at TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('request_review','question','artifact_ready','blocker','handoff')),
    summary TEXT NOT NULL,
    artifact_refs_json TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    deadline_at TEXT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','acknowledged')),
    delivered_at TEXT,
    acknowledged_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
    ON agent_messages(to_agent, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_trace
    ON agent_messages(trace_id, created_at);
`);

function parseJson(value,fallback){
  try{return JSON.parse(value);}catch{return fallback;}
}

function fromRow(row){
  return {
    id:row.id,
    name:row.name,
    runtime:row.runtime,
    capabilities:parseJson(row.capabilities_json,[]),
    maxConcurrentTasks:row.max_concurrent_tasks,
    slotIndex:row.slot_index,
    slotId:row.slot_id,
    slotLabel:row.slot_label,
    status:row.status,
    currentTasks:parseJson(row.current_tasks_json,[]),
    registeredAt:row.registered_at,
    lastHeartbeat:row.last_heartbeat,
  };
}

const listStatement=db.prepare('SELECT * FROM agent_registry ORDER BY slot_index ASC');
const saveStatement=db.prepare(`
  INSERT INTO agent_registry (
    id,name,runtime,capabilities_json,max_concurrent_tasks,
    slot_index,slot_id,slot_label,status,current_tasks_json,registered_at,last_heartbeat
  ) VALUES (
    @id,@name,@runtime,@capabilitiesJson,@maxConcurrentTasks,
    @slotIndex,@slotId,@slotLabel,@status,@currentTasksJson,@registeredAt,@lastHeartbeat
  )
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,
    runtime=excluded.runtime,
    capabilities_json=excluded.capabilities_json,
    max_concurrent_tasks=excluded.max_concurrent_tasks,
    slot_index=excluded.slot_index,
    slot_id=excluded.slot_id,
    slot_label=excluded.slot_label,
    status=excluded.status,
    current_tasks_json=excluded.current_tasks_json,
    registered_at=excluded.registered_at,
    last_heartbeat=excluded.last_heartbeat
`);
const deleteStatement=db.prepare('DELETE FROM agent_registry WHERE id = ?');

export class AgentRegistryStore {
  list(){
    return listStatement.all().map(fromRow);
  }

  save(agent){
    saveStatement.run({
      id:agent.id,
      name:agent.name,
      runtime:agent.runtime,
      capabilitiesJson:JSON.stringify(agent.capabilities||[]),
      maxConcurrentTasks:agent.maxConcurrentTasks||1,
      slotIndex:agent.slotIndex,
      slotId:agent.slotId,
      slotLabel:agent.slotLabel,
      status:agent.status||'offline',
      currentTasksJson:JSON.stringify(agent.currentTasks||[]),
      registeredAt:agent.registeredAt,
      lastHeartbeat:agent.lastHeartbeat,
    });
  }

  delete(id){
    return deleteStatement.run(id).changes>0;
  }
}

function fromMessageRow(row){
  if(!row)return null;
  return {
    id:row.id,
    taskId:row.task_id,
    traceId:row.trace_id,
    fromAgent:row.from_agent,
    toAgent:row.to_agent,
    kind:row.kind,
    summary:row.summary,
    artifactRefs:parseJson(row.artifact_refs_json,[]),
    replyTo:row.reply_to,
    deadlineAt:row.deadline_at,
    createdAt:row.created_at,
    status:row.status,
    deliveredAt:row.delivered_at,
    acknowledgedAt:row.acknowledged_at,
  };
}

const insertMessageStatement=db.prepare(`
  INSERT INTO agent_messages (
    id,task_id,trace_id,from_agent,to_agent,kind,summary,
    artifact_refs_json,reply_to,deadline_at,created_at,status
  ) VALUES (
    @id,@taskId,@traceId,@fromAgent,@toAgent,@kind,@summary,
    @artifactRefsJson,@replyTo,@deadlineAt,@createdAt,'queued'
  )
`);
const findMessageStatement=db.prepare('SELECT * FROM agent_messages WHERE id = ?');
const pendingMessagesStatement=db.prepare(`
  SELECT * FROM agent_messages
  WHERE to_agent = ? AND status IN ('queued','delivered')
  ORDER BY created_at ASC LIMIT ?
`);
const markDeliveredStatement=db.prepare(`
  UPDATE agent_messages SET status='delivered', delivered_at=?
  WHERE id=? AND to_agent=? AND status='queued'
`);
const acknowledgeMessageStatement=db.prepare(`
  UPDATE agent_messages SET status='acknowledged', acknowledged_at=?
  WHERE id=? AND to_agent=? AND status IN ('queued','delivered')
`);
const markInboxDelivered=db.transaction((agentId,limit)=>{
  const messages=pendingMessagesStatement.all(agentId,limit);
  const now=new Date().toISOString();
  for(const message of messages){
    if(message.status==='queued')markDeliveredStatement.run(now,message.id,agentId);
  }
  return pendingMessagesStatement.all(agentId,limit).map(fromMessageRow);
});

export class AgentMessageStore {
  create(message){
    insertMessageStatement.run({
      id:message.id,
      taskId:message.taskId,
      traceId:message.traceId,
      fromAgent:message.fromAgent,
      toAgent:message.toAgent,
      kind:message.kind,
      summary:message.summary,
      artifactRefsJson:JSON.stringify(message.artifactRefs||[]),
      replyTo:message.replyTo||null,
      deadlineAt:message.deadlineAt||null,
      createdAt:message.createdAt,
    });
    return this.get(message.id);
  }

  get(id){
    return fromMessageRow(findMessageStatement.get(id));
  }

  inbox(agentId,limit=20){
    return markInboxDelivered(agentId,limit);
  }

  acknowledge(id,agentId){
    const result=acknowledgeMessageStatement.run(new Date().toISOString(),id,agentId);
    return result.changes>0?this.get(id):null;
  }
}

