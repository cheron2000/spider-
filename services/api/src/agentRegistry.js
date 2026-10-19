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
