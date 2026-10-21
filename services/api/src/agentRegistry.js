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
db.pragma('foreign_keys = ON');
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
  CREATE TABLE IF NOT EXISTS coordination_plans (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS coordination_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES coordination_plans(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    required_capabilities_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('blocked','ready','assigned','in_progress','review','done','failed')),
    assigned_agent TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 2,
    result_summary TEXT,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    review_feedback TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    submitted_at TEXT,
    reviewed_at TEXT,
    assigned_at TEXT,
    lease_expires_at TEXT,
    last_activity_at TEXT,
    assignment_token TEXT,
    UNIQUE(plan_id, step_key)
  );
  CREATE INDEX IF NOT EXISTS idx_coordination_steps_plan
    ON coordination_steps(plan_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_coordination_steps_agent
    ON coordination_steps(assigned_agent, status);
  CREATE TABLE IF NOT EXISTS coordination_step_reports (
    id TEXT PRIMARY KEY,
    step_id TEXT NOT NULL REFERENCES coordination_steps(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    submitted_at TEXT NOT NULL,
    review_decision TEXT CHECK (review_decision IN ('approve','reject')),
    review_feedback TEXT,
    reviewed_at TEXT,
    UNIQUE(step_id, attempt)
  );
  CREATE INDEX IF NOT EXISTS idx_coordination_reports_step
    ON coordination_step_reports(step_id, attempt);
  CREATE TABLE IF NOT EXISTS coordination_peer_reviews (
    id TEXT PRIMARY KEY,
    step_id TEXT NOT NULL REFERENCES coordination_steps(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    reviewer_agent TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve','request_changes','comment')),
    feedback TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE(step_id, attempt, reviewer_agent)
  );
  CREATE INDEX IF NOT EXISTS idx_coordination_peer_reviews_step
    ON coordination_peer_reviews(step_id, attempt);
  CREATE TABLE IF NOT EXISTS execution_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    plan_id TEXT, step_id TEXT, attempt INTEGER, agent_id TEXT, provider_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_execution_journal_step ON execution_journal(step_id, sequence DESC);
  CREATE INDEX IF NOT EXISTS idx_execution_journal_plan ON execution_journal(plan_id, sequence DESC);
  CREATE TRIGGER IF NOT EXISTS execution_journal_no_update BEFORE UPDATE ON execution_journal BEGIN
    SELECT RAISE(ABORT, 'execution_journal is append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS execution_journal_no_delete BEFORE DELETE ON execution_journal BEGIN
    SELECT RAISE(ABORT, 'execution_journal is append-only');
  END;
`);

const agentRegistryColumns=new Set(db.prepare('PRAGMA table_info(agent_registry)').all().map(column=>column.name));
if(!agentRegistryColumns.has('credential_hash'))db.exec('ALTER TABLE agent_registry ADD COLUMN credential_hash TEXT');
const coordinationStepColumns=new Set(db.prepare('PRAGMA table_info(coordination_steps)').all().map(column=>column.name));
for(const [name,type] of [
  ['assigned_at','TEXT'],
  ['lease_expires_at','TEXT'],
  ['last_activity_at','TEXT'],
  ['assignment_token','TEXT'],
]){
  if(!coordinationStepColumns.has(name))db.exec('ALTER TABLE coordination_steps ADD COLUMN '+name+' '+type);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_coordination_steps_lease ON coordination_steps(status, lease_expires_at)');

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
const getCredentialHashStatement=db.prepare('SELECT credential_hash FROM agent_registry WHERE id = ?');
const setCredentialHashStatement=db.prepare('UPDATE agent_registry SET credential_hash = ? WHERE id = ?');

export class AgentRegistryStore {
  list(){
    return listStatement.all().map(fromRow);
  }

  getCredentialHash(id){
    return getCredentialHashStatement.get(id)?.credential_hash||null;
  }

  setCredentialHash(id,hash){
    return setCredentialHashStatement.run(hash,id).changes>0;
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
  ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_at ASC LIMIT ?
`);
const markDeliveredStatement=db.prepare(`
  UPDATE agent_messages SET status='delivered', delivered_at=?
  WHERE id=? AND to_agent=? AND status='queued'
`);
const acknowledgeMessageStatement=db.prepare(`
  UPDATE agent_messages SET status='acknowledged', acknowledged_at=?
  WHERE id=? AND to_agent=? AND status='delivered'
`);
const markInboxDelivered=db.transaction((agentId,limit)=>{
  const messages=pendingMessagesStatement.all(agentId,limit);
  const newlyDelivered=[];
  const now=new Date().toISOString();
  for(const message of messages){
    if(message.status==='queued'){
      markDeliveredStatement.run(now,message.id,agentId);
      message.status='delivered';
      message.delivered_at=now;
      newlyDelivered.push({...message});
    }
  }
  return {messages:messages.map(fromMessageRow),newlyDelivered:newlyDelivered.map(fromMessageRow)};
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

  markDelivered(id,agentId){
    const result=markDeliveredStatement.run(new Date().toISOString(),id,agentId);
    return result.changes>0?this.get(id):null;
  }

  inbox(agentId,limit=20){
    return markInboxDelivered(agentId,limit);
  }

  acknowledge(id,agentId){
    const result=acknowledgeMessageStatement.run(new Date().toISOString(),id,agentId);
    return result.changes>0?this.get(id):null;
  }
}

function fromCoordinationStep(row){
  if(!row)return null;
  return {
    id:row.id,
    planId:row.plan_id,
    key:row.step_key,
    title:row.title,
    description:row.description,
    dependsOn:parseJson(row.depends_on_json,[]),
    requiredCapabilities:parseJson(row.required_capabilities_json,[]),
    status:row.status,
    assignedAgent:row.assigned_agent,
    attempts:row.attempts,
    maxAttempts:row.max_attempts,
    resultSummary:row.result_summary,
    evidence:parseJson(row.evidence_json,[]),
    reviewFeedback:row.review_feedback,
    createdAt:row.created_at,
    updatedAt:row.updated_at,
    startedAt:row.started_at,
    submittedAt:row.submitted_at,
    reviewedAt:row.reviewed_at,
    assignedAt:row.assigned_at,
    leaseExpiresAt:row.lease_expires_at,
    lastActivityAt:row.last_activity_at,
    assignmentToken:row.assignment_token,
  };
}

function fromCoordinationReport(row){
  return {
    id:row.id,
    stepId:row.step_id,
    attempt:row.attempt,
    agentId:row.agent_id,
    summary:row.summary,
    evidence:parseJson(row.evidence_json,[]),
    submittedAt:row.submitted_at,
    reviewDecision:row.review_decision,
    reviewFeedback:row.review_feedback,
    reviewedAt:row.reviewed_at,
  };
}

function fromPeerReview(row){
  if(!row)return null;
  return {
    id:row.id,
    stepId:row.step_id,
    attempt:row.attempt,
    reviewerAgent:row.reviewer_agent,
    decision:row.decision,
    feedback:row.feedback,
    evidence:parseJson(row.evidence_json,[]),
    createdAt:row.created_at,
  };
}

const findPlanStatement=db.prepare('SELECT * FROM coordination_plans WHERE id = ?');
const listPlansStatement=db.prepare('SELECT id FROM coordination_plans ORDER BY updated_at DESC LIMIT ?');
const insertPlanStatement=db.prepare('INSERT INTO coordination_plans (id,objective,status,created_at,updated_at) VALUES (@id,@objective,\'planned\',@createdAt,@updatedAt)');
const updatePlanStatement=db.prepare('UPDATE coordination_plans SET status=@status,updated_at=@updatedAt WHERE id=@id');
const insertStepStatement=db.prepare(`
  INSERT INTO coordination_steps (
    id,plan_id,step_key,title,description,depends_on_json,required_capabilities_json,
    status,assigned_agent,attempts,max_attempts,created_at,updated_at
  ) VALUES (
    @id,@planId,@key,@title,@description,@dependsOnJson,@requiredCapabilitiesJson,
    @status,NULL,0,@maxAttempts,@createdAt,@updatedAt
  )
`);
const findStepStatement=db.prepare('SELECT * FROM coordination_steps WHERE id = ?');
const findStepsForPlanStatement=db.prepare('SELECT * FROM coordination_steps WHERE plan_id = ? ORDER BY created_at, step_key');
const listWorkStatement=db.prepare("SELECT * FROM coordination_steps WHERE assigned_agent = ? AND status IN ('assigned','in_progress') ORDER BY created_at");
const updateStepStatement=db.prepare(`
  UPDATE coordination_steps SET
    status=@status,assigned_agent=@assignedAgent,attempts=@attempts,max_attempts=@maxAttempts,
    result_summary=@resultSummary,evidence_json=@evidenceJson,review_feedback=@reviewFeedback,
    updated_at=@updatedAt,started_at=@startedAt,submitted_at=@submittedAt,reviewed_at=@reviewedAt,
    assigned_at=@assignedAt,lease_expires_at=@leaseExpiresAt,last_activity_at=@lastActivityAt,
    assignment_token=@assignmentToken
  WHERE id=@id
`);
const insertReportStatement=db.prepare(`
  INSERT INTO coordination_step_reports
    (id,step_id,attempt,agent_id,summary,evidence_json,submitted_at)
  VALUES (@id,@stepId,@attempt,@agentId,@summary,@evidenceJson,@submittedAt)
`);
const submitStepWithLeaseTransaction=db.transaction(data=>{
  const changed=submitStepLeaseStatement.run({
    id:data.stepId,agentId:data.agentId,assignmentToken:data.assignmentToken,
    now:data.now,summary:data.summary,evidenceJson:JSON.stringify(data.evidence||[])
  });
  if(!changed.changes)return null;
  insertReportStatement.run({
    id:data.reportId,stepId:data.stepId,attempt:data.attempt,agentId:data.agentId,
    summary:data.summary,evidenceJson:JSON.stringify(data.evidence||[]),submittedAt:data.now
  });
  return fromCoordinationStep(findStepStatement.get(data.stepId));
});
const findReportForAttemptStatement=db.prepare('SELECT * FROM coordination_step_reports WHERE step_id = ? AND attempt = ?');
const listReportsForStepStatement=db.prepare('SELECT * FROM coordination_step_reports WHERE step_id = ? ORDER BY attempt');
const insertPeerReviewStatement=db.prepare(`
 INSERT INTO coordination_peer_reviews
  (id,step_id,attempt,reviewer_agent,decision,feedback,evidence_json,created_at)
 VALUES (@id,@stepId,@attempt,@reviewerAgent,@decision,@feedback,@evidenceJson,@createdAt)
`);
const findPeerReviewStatement=db.prepare('SELECT * FROM coordination_peer_reviews WHERE id = ?');
const listPeerReviewsStatement=db.prepare('SELECT * FROM coordination_peer_reviews WHERE step_id = ? ORDER BY attempt, created_at');
const findPeerReviewForAgentStatement=db.prepare('SELECT * FROM coordination_peer_reviews WHERE step_id = ? AND attempt = ? AND reviewer_agent = ?');
const insertExecutionEventStatement=db.prepare(`
 INSERT INTO execution_journal
  (event_id,event_type,occurred_at,plan_id,step_id,attempt,agent_id,provider_id,details_json)
 VALUES (@eventId,@eventType,@occurredAt,@planId,@stepId,@attempt,@agentId,@providerId,@detailsJson)
`);
const listExecutionEventsStatement=db.prepare(`
 SELECT sequence,event_id,event_type,occurred_at,plan_id,step_id,attempt,agent_id,provider_id,details_json
 FROM execution_journal
 WHERE (@planId IS NULL OR plan_id=@planId) AND (@stepId IS NULL OR step_id=@stepId)
 ORDER BY sequence DESC LIMIT @limit OFFSET @offset
`);
const countExecutionEventsStatement=db.prepare(`
 SELECT COUNT(*) AS count FROM execution_journal
 WHERE (@planId IS NULL OR plan_id=@planId) AND (@stepId IS NULL OR step_id=@stepId)
`);
const reviewReportStatement=db.prepare(`
 UPDATE coordination_step_reports SET review_decision=@decision,review_feedback=@feedback,reviewed_at=@reviewedAt
 WHERE step_id=@stepId AND attempt=@attempt AND review_decision IS NULL
`);
const listRecoverableStepsStatement=db.prepare(`
 SELECT id,assigned_agent FROM coordination_steps
 WHERE status IN ('assigned','in_progress') ORDER BY created_at,id
`);
const recoverStepsStatement=db.prepare(`
 UPDATE coordination_steps SET
  status=CASE WHEN status='in_progress' OR attempts >= max_attempts THEN 'failed' ELSE 'ready' END,
  assigned_agent=NULL,assignment_token=NULL,lease_expires_at=NULL,
  last_activity_at=@now,
  review_feedback=CASE
   WHEN status='in_progress' THEN 'Recovered after API restart during execution; automatic retry blocked until coordinator reconciles possible external side effects.'
   ELSE 'Recovered after API restart before execution; assignment revoked and safe to requeue.'
  END,
  updated_at=@now,started_at=NULL,submitted_at=NULL
 WHERE status IN ('assigned','in_progress')
`);
const renewStepLeaseStatement=db.prepare(`
 UPDATE coordination_steps SET lease_expires_at=@leaseExpiresAt,last_activity_at=@now,updated_at=@now
 WHERE id=@id AND assigned_agent=@agentId AND assignment_token=@assignmentToken
  AND status IN ('assigned','in_progress') AND lease_expires_at>@now
`);
const startStepLeaseStatement=db.prepare(`
 UPDATE coordination_steps SET status='in_progress',
  started_at=COALESCE(started_at,@now),lease_expires_at=@leaseExpiresAt,
  last_activity_at=@now,updated_at=@now
 WHERE id=@id AND assigned_agent=@agentId AND assignment_token=@assignmentToken
  AND status IN ('assigned','in_progress') AND lease_expires_at>@now
`);
const submitStepLeaseStatement=db.prepare(`
 UPDATE coordination_steps SET status='review',result_summary=@summary,evidence_json=@evidenceJson,
  review_feedback=NULL,updated_at=@now,submitted_at=@now,last_activity_at=@now,
  lease_expires_at=NULL,assignment_token=NULL
 WHERE id=@id AND assigned_agent=@agentId AND assignment_token=@assignmentToken
  AND status IN ('assigned','in_progress') AND lease_expires_at>@now
`);
const findExpiredStepsStatement=db.prepare(`
 SELECT id,assigned_agent FROM coordination_steps
 WHERE status IN ('assigned','in_progress') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?
 ORDER BY lease_expires_at
`);
const expireStepStatement=db.prepare(`
 UPDATE coordination_steps SET
  status=CASE WHEN status='in_progress' OR attempts>=max_attempts THEN 'failed' ELSE 'ready' END,
  assigned_agent=NULL,assignment_token=NULL,lease_expires_at=NULL,last_activity_at=@now,
  review_feedback=CASE
   WHEN status='in_progress' THEN 'Assignment lease expired during execution; automatic retry blocked until coordinator reconciles possible external side effects.'
   ELSE 'Assignment lease expired before execution; assignment revoked and safe to requeue.'
  END,
  updated_at=@now,started_at=NULL,submitted_at=NULL
 WHERE id=@id AND status IN ('assigned','in_progress')
  AND lease_expires_at IS NOT NULL AND lease_expires_at<=@now
`);

export class CoordinationStore {
  appendExecutionEvent(event){
    insertExecutionEventStatement.run({
      eventId:event.eventId,eventType:event.eventType,occurredAt:event.occurredAt,
      planId:event.planId||null,stepId:event.stepId||null,
      attempt:Number.isInteger(event.attempt)?event.attempt:null,
      agentId:event.agentId||null,providerId:event.providerId||null,
      detailsJson:JSON.stringify(event.details||{})
    });
    return event.eventId;
  }

  listExecutionEvents({planId=null,stepId=null,limit=50,offset=0}={}){
    const rows=listExecutionEventsStatement.all({planId,stepId,limit,offset});
    return {
      total:countExecutionEventsStatement.get({planId,stepId}).count,
      events:rows.map(row=>({
        sequence:row.sequence,eventId:row.event_id,eventType:row.event_type,occurredAt:row.occurred_at,
        planId:row.plan_id,stepId:row.step_id,attempt:row.attempt,agentId:row.agent_id,
        providerId:row.provider_id,details:parseJson(row.details_json,{})
      }))
    };
  }

  createPlan(plan){
    const create=db.transaction(()=>{
      insertPlanStatement.run({
        id:plan.id,objective:plan.objective,createdAt:plan.createdAt,updatedAt:plan.updatedAt
      });
      for(const step of plan.steps){
        insertStepStatement.run({
          id:step.id,planId:plan.id,key:step.key,title:step.title,description:step.description,
          dependsOnJson:JSON.stringify(step.dependsOn||[]),
          requiredCapabilitiesJson:JSON.stringify(step.requiredCapabilities||[]),
          status:step.dependsOn?.length?'blocked':'ready',
          maxAttempts:step.maxAttempts||2,createdAt:plan.createdAt,updatedAt:plan.updatedAt
        });
      }
    });
    create();
    return this.getPlan(plan.id);
  }

  getPlan(id){
    const row=findPlanStatement.get(id);
    if(!row)return null;
    const steps=findStepsForPlanStatement.all(id).map(fromCoordinationStep);
    return {
      id:row.id,objective:row.objective,status:row.status,
      createdAt:row.created_at,updatedAt:row.updated_at,
      steps:steps.map(step=>({...step,reports:listReportsForStepStatement.all(step.id).map(fromCoordinationReport)}))
    };
  }

  listPlans(limit=20){
    return listPlansStatement.all(limit).map(row=>this.getPlan(row.id));
  }

  getStep(id){
    return fromCoordinationStep(findStepStatement.get(id));
  }

  listAgentWork(agentId){
    return listWorkStatement.all(agentId).map(fromCoordinationStep);
  }

  updateStep(step){
    updateStepStatement.run({
      id:step.id,status:step.status,assignedAgent:step.assignedAgent||null,attempts:step.attempts,
      maxAttempts:step.maxAttempts,resultSummary:step.resultSummary||null,
      evidenceJson:JSON.stringify(step.evidence||[]),reviewFeedback:step.reviewFeedback||null,
      updatedAt:step.updatedAt,startedAt:step.startedAt||null,
      submittedAt:step.submittedAt||null,reviewedAt:step.reviewedAt||null,
      assignedAt:step.assignedAt||null,leaseExpiresAt:step.leaseExpiresAt||null,
      lastActivityAt:step.lastActivityAt||null,assignmentToken:step.assignmentToken||null
    });
    return this.getStep(step.id);
  }

  renewLease({stepId,agentId,assignmentToken,now=new Date().toISOString(),leaseExpiresAt}) {
    const changed=renewStepLeaseStatement.run({id:stepId,agentId,assignmentToken,now,leaseExpiresAt});
    return changed.changes?this.getStep(stepId):null;
  }

  startWithLease({stepId,agentId,assignmentToken,now=new Date().toISOString(),leaseExpiresAt}) {
    const changed=startStepLeaseStatement.run({id:stepId,agentId,assignmentToken,now,leaseExpiresAt});
    return changed.changes?this.getStep(stepId):null;
  }

  submitWithLease({stepId,agentId,assignmentToken,attempt,summary,evidence,reportId,now=new Date().toISOString()}) {
    return submitStepWithLeaseTransaction({stepId,agentId,assignmentToken,attempt,summary,evidence,reportId,now});
  }

  recoverExpiredLeases(now=new Date().toISOString(),{excludeStepIds=new Set()}={}) {
    const recover=db.transaction(()=>{
      const expired=findExpiredStepsStatement.all(now);
      const recovered=[];
      for(const row of expired){
        if(excludeStepIds.has(row.id))continue;
        if(expireStepStatement.run({id:row.id,now}).changes){
          recovered.push({agentId:row.assigned_agent,step:this.getStep(row.id)});
        }
      }
      return recovered;
    });
    return recover();
  }

  updatePlanStatus(id,status,updatedAt=new Date().toISOString()){
    updatePlanStatement.run({id,status,updatedAt});
  }

  addReport(report){
    insertReportStatement.run({
      id:report.id,stepId:report.stepId,attempt:report.attempt,agentId:report.agentId,
      summary:report.summary,evidenceJson:JSON.stringify(report.evidence||[]),
      submittedAt:report.submittedAt
    });
    return fromCoordinationReport(findReportForAttemptStatement.get(report.stepId,report.attempt));
  }

  reviewReport(stepId,attempt,decision,feedback,reviewedAt){
    reviewReportStatement.run({stepId,attempt,decision,feedback:feedback||null,reviewedAt});
    return fromCoordinationReport(findReportForAttemptStatement.get(stepId,attempt));
  }

  addPeerReview(review){
    insertPeerReviewStatement.run({
      id:review.id,stepId:review.stepId,attempt:review.attempt,
      reviewerAgent:review.reviewerAgent,decision:review.decision,
      feedback:review.feedback,evidenceJson:JSON.stringify(review.evidence||[]),
      createdAt:review.createdAt
    });
    return fromPeerReview(findPeerReviewStatement.get(review.id));
  }

  listPeerReviews(stepId){
    return listPeerReviewsStatement.all(stepId).map(fromPeerReview);
  }

  getPeerReviewForAgent(stepId,attempt,agentId){
    return fromPeerReview(findPeerReviewForAgentStatement.get(stepId,attempt,agentId));
  }

  recoverInFlightSteps(now=new Date().toISOString()){
    const recover=db.transaction(()=>{
      const rows=listRecoverableStepsStatement.all();
      recoverStepsStatement.run({now});
      return rows.map(row=>({
        previousAgentId:row.assigned_agent,
        step:this.getStep(row.id)
      }));
    });
    return recover();
  }
}

