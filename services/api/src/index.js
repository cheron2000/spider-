import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import {Octokit} from '@octokit/rest';
import {z} from 'zod';
import {AgentRegistryStore,AgentMessageStore,CoordinationStore} from './agentRegistry.js';
import {createProviderAdapters} from './providers/index.js';
import {ProviderRuntimeManager} from './providers/runtime.js';
import {redactSecrets} from './providers/base.js';

const app=express(),server=createServer(app),origin=process.env.DASHBOARD_ORIGIN||'http://localhost:5173';
const io=new Server(server,{cors:{origin,methods:['GET','POST']}});
app.use(cors({origin}));
app.use('/api/webhooks/github',express.raw({type:'application/json'}));
app.use(express.json({limit:'1mb'}));
const [owner,repo]=(process.env.GITHUB_REPOSITORY||'').split('/');
const octokit=process.env.GITHUB_TOKEN?new Octokit({auth:process.env.GITHUB_TOKEN}):null;
const agentStore=new AgentRegistryStore();
const messageStore=new AgentMessageStore();
const coordinationStore=new CoordinationStore();
const tasks=new Map();
const agents=new Map(agentStore.list().map(agent=>[agent.id,{...agent,status:'offline',currentTasks:[]}]));
const events=[];
const providerRuns=new Set();
const providerRuntime=new ProviderRuntimeManager(createProviderAdapters(),{
 onStateChange:handleProviderStateChange,
 pollIntervalMs:Math.max(10000,Math.min(120000,Number.parseInt(process.env.SPIDER_PROVIDER_POLL_INTERVAL_MS||'30000',10)||30000))
});
// Persist offline state after restart while keeping every recorded slot assignment.
for(const agent of agents.values())agentStore.save(agent);
function emit(type,payload){const e={id:crypto.randomUUID(),type,payload,at:new Date().toISOString()};events.push(e);if(events.length>300)events.shift();io.to('coordinator').emit('framework:event',e);}
function secureEqual(candidate,expected){
 if(typeof candidate!=='string'||!candidate||typeof expected!=='string'||!expected)return false;
 const a=Buffer.from(candidate),b=Buffer.from(expected);
 return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function configuredSecret(value){
 if(typeof value!=='string')return false;
 const secret=value.trim();
 return secret.length>=32&&!/^(?:replace[-_ ]?me|change[-_ ]?me|your[-_ ]|example|placeholder)/i.test(secret);
}
function requireMessageAgent(req,res,next){
 const expected=process.env.SPIDER_AGENT_API_KEY;
 if(!configuredSecret(expected))return res.status(503).json({error:'Agent messaging is disabled until SPIDER_AGENT_API_KEY is set to a non-placeholder secret of at least 32 characters.'});
 if(!secureEqual(req.get('x-spider-agent-key')||'',expected))return res.status(401).json({error:'Invalid agent API key.'});
 const agentId=req.get('x-agent-id');
 const agent=agents.get(agentId);
 if(!agent)return res.status(401).json({error:'x-agent-id must identify a registered agent.'});
 req.spiderAgent=agent;
 next();
}
function requireCoordinator(req,res,next){
 const expected=process.env.SPIDER_COORDINATOR_API_KEY;
 if(!configuredSecret(expected))return res.status(503).json({error:'Coordinator actions are disabled until SPIDER_COORDINATOR_API_KEY is set to a non-placeholder secret of at least 32 characters.'});
 if(!secureEqual(req.get('x-spider-coordinator-key')||'',expected))return res.status(401).json({error:'Invalid coordinator API key.'});
 next();
}
function issueTask(i){const labels=(i.labels||[]).map(x=>typeof x==='string'?x:x.name);return{id:'issue-'+i.number,number:i.number,title:i.title,body:i.body||'',url:i.html_url,state:i.state,status:i.state==='closed'?'done':labels.find(x=>x.startsWith('status:'))?.slice(7)||'todo',labels,assigneeAgent:labels.find(x=>x.startsWith('agent:'))?.slice(6)||null,priority:labels.find(x=>x.startsWith('priority:'))?.slice(9)||'medium',updatedAt:i.updated_at};}
function githubRequired(_q,r,next){if(!octokit||!owner||!repo)return r.status(503).json({error:'Set GITHUB_TOKEN and GITHUB_REPOSITORY in .env.'});next();}
async function sync(){const issues=await octokit.paginate(octokit.issues.listForRepo,{owner,repo,state:'all',per_page:100});for(const i of issues)if(!i.pull_request)tasks.set('issue-'+i.number,issueTask(i));emit('github.synced',{repository:owner+'/'+repo,count:tasks.size});return [...tasks.values()];}
async function ensureLabel(name){try{await octokit.issues.getLabel({owner,repo,name});}catch(e){if(e.status!==404)throw e;await octokit.issues.createLabel({owner,repo,name,color:name==='type:epic'?'6f42c1':name==='priority:high'?'d93f0b':'1f6feb',description:'Managed by Universal Agent Framework'});}}
async function createIssue(title,body,labels=['agent-task']){for(const label of labels)await ensureLabel(label);const {data}=await octokit.issues.create({owner,repo,title,body,labels});const t=issueTask(data);tasks.set(t.id,t);emit('task.created',t);return t;}
app.get('/api/health',(_q,r)=>r.json({ok:true,repository:owner&&repo?owner+'/'+repo:null,githubConfigured:!!octokit,agentPersistence:'sqlite',messagePersistence:'sqlite',agentMessaging:configuredSecret(process.env.SPIDER_AGENT_API_KEY),coordinatorEnabled:configuredSecret(process.env.SPIDER_COORDINATOR_API_KEY),taskCount:tasks.size,agentCount:agents.size,providers:providerRuntime.list()}));
app.get('/api/providers',requireCoordinator,(_q,r)=>r.json({providers:providerRuntime.list()}));
app.post('/api/coordinator/providers/:id/refresh',requireCoordinator,async(req,res)=>{
 if(!providerRuntime.adapter(req.params.id))return res.status(404).json({error:'Unknown provider adapter.'});
 res.json({provider:await providerRuntime.refresh(req.params.id,{reset:true})});
});
app.get('/api/tasks',requireCoordinator,(_q,r)=>r.json({tasks:[...tasks.values()]}));
app.get('/api/agents',requireCoordinator,(_q,r)=>r.json({agents:[...agents.values()]}));
app.get('/api/events',requireCoordinator,(_q,r)=>r.json({events}));
app.post('/api/github/sync',requireCoordinator,githubRequired,async(_q,r)=>{try{r.json({tasks:await sync()});}catch(e){r.status(502).json({error:e.message});}});
app.post('/api/ceo/plan',requireCoordinator,githubRequired,async(req,res)=>{
 const p=z.object({objective:z.string().min(8).max(5000),maxTasks:z.number().int().min(2).max(12).optional()}).safeParse(req.body);
 if(!p.success)return res.status(400).json({error:p.error.flatten()});
 try{const {objective,maxTasks=6}=p.data;emit('ceo.planning.started',{objective});
 const plan=[['Discovery and requirements','Clarify scope, users, constraints, risks and acceptance criteria.'],['Architecture and interfaces','Define modules, data contracts and integration boundaries.'],['Core implementation','Implement the minimum end-to-end product flow.'],['Testing and validation','Add tests and validate acceptance criteria.'],['Integration and documentation','Integrate modules and document setup.'],['Security and reliability review','Review secrets, permissions, failures, logs and recovery.'],['Performance review','Identify bottlenecks and validate responsiveness.'],['Deployment and release','Prepare deployment and rollback checklist.'],['Observability','Add logs, health checks and diagnostics.'],['Final acceptance','Run end-to-end acceptance checks.'],['Data model','Define durable data structures.'],['Accessibility and UX','Review usability and accessibility.']].slice(0,maxTasks);
 const root=await createIssue('PROJECT OBJECTIVE: '+objective.slice(0,100),'## Objective\n'+objective+'\n\n## Managed by\nUniversal Agent Framework CEO\n\nReview child issues before assigning workers.',['agent-task','type:epic','priority:high']);
 const children=[];for(const [title,desc] of plan)children.push(await createIssue(title,'## Parent objective\n#'+root.number+'\n\n## Description\n'+desc+'\n\n## Acceptance criteria\n- [ ] Expected output documented\n- [ ] Evidence or implementation attached\n- [ ] Relevant checks pass\n- [ ] Outcome summarized',['agent-task','status:todo','priority:medium']));
 emit('ceo.planning.completed',{root,taskCount:children.length});res.status(201).json({root,tasks:children,note:'Deterministic starter plan; review before autonomous execution.'});
 }catch(e){res.status(502).json({error:e.message});}
});
const PROVIDER_SLOTS = [
 {id:'antigravity',label:'Antigravity',aliases:['antigravity']},
 {id:'codex',label:'Codex',aliases:['codex','openai codex']},
 {id:'copilot',label:'Copilot',aliases:['copilot','github copilot']},
 {id:'kiro',label:'Kiro',aliases:['kiro']},
 {id:'manus',label:'Manus',aliases:['manus']},
 {id:'replit',label:'Replit',aliases:['replit']},
];

function handleProviderStateChange(runtime){
 const agent=[...agents.values()].find(item=>item.providerId===runtime.id);
 if(!agent)return;
 const previous=agent.providerRuntime||{};
 agent.providerRuntime={
  status:runtime.status,reason:runtime.reason||null,checkedAt:runtime.checkedAt||null,
  authState:runtime.authState||'unknown',activeTasks:runtime.activeTasks||0,
  maxConcurrentTasks:runtime.maxConcurrentTasks||agent.maxConcurrentTasks
 };
 if(['ready','busy'].includes(runtime.status)){
  agent.status=agent.currentTasks.length>=agent.maxConcurrentTasks?'busy':'available';
 }else agent.status='offline';
 if(runtime.checkedAt)agent.lastHeartbeat=runtime.checkedAt;
 agentStore.save(agent);
 if(previous.status!==runtime.status||previous.reason!==runtime.reason){
  emit('provider.runtime.state',{
   providerId:runtime.id,agentId:agent.id,label:runtime.label,status:runtime.status,
   reason:runtime.reason||null,authState:runtime.authState||'unknown',
   activeTasks:runtime.activeTasks||0,maxConcurrentTasks:runtime.maxConcurrentTasks||agent.maxConcurrentTasks,
   checkedAt:runtime.checkedAt||new Date().toISOString()
  });
 }
 if(['ready','busy'].includes(runtime.status)&&previous.status!==runtime.status){
  queueMicrotask(()=>advanceOtherCoordinationPlans(null));
 }
}

function ensureProviderAgents(){
 const now=new Date().toISOString();
 // Older databases may have assigned these indices to generic workers before
 // provider slots became reserved. Move unrelated occupants instead of silently
 // turning their identities into a different provider.
 let nextExtraSlot=Math.max(PROVIDER_SLOTS.length-1,...[...agents.values()].map(agent=>Number.isInteger(agent.slotIndex)?agent.slotIndex:-1))+1;
 for(const agent of [...agents.values()]){
  if(agent.slotIndex<0||agent.slotIndex>=PROVIDER_SLOTS.length)continue;
  const slot=PROVIDER_SLOTS[agent.slotIndex];
  const matchesSlot=agent.id==='provider-'+slot.id
   ||agent.slotId===slot.id
   ||slot.aliases.some(alias=>normalizedAgentName(agent.name)===normalizedAgentName(alias));
  if(!matchesSlot){
   agent.slotIndex=nextExtraSlot;
   agent.slotId='agent-'+(nextExtraSlot+1);
   agent.slotLabel='Agent '+(nextExtraSlot+1);
   nextExtraSlot++;
   agentStore.save(agent);
  }
 }
 for(const [slotIndex,slot] of PROVIDER_SLOTS.entries()){
  let agent=[...agents.values()].find(item=>item.slotIndex===slotIndex);
  const adapter=providerRuntime.adapter(slot.id);
  if(!agent){
   const id='provider-'+slot.id;
   agent={
    id,name:slot.label,runtime:['manus','replit'].includes(slot.id)?'remote':'local',
    capabilities:['coding','review','research','security-review','documentation'],
    maxConcurrentTasks:adapter?.maxConcurrentTasks||1,
    slotIndex,slotId:slot.id,slotLabel:slot.label,status:'offline',currentTasks:[],
    registeredAt:now,lastHeartbeat:now,providerId:slot.id,
    providerRuntime:providerRuntime.snapshot(slot.id)
   };
   agents.set(id,agent);
  }else{
   agent.providerId=slot.id;
   agent.slotId=slot.id;
   agent.slotLabel=slot.label;
   agent.maxConcurrentTasks=adapter?.maxConcurrentTasks||agent.maxConcurrentTasks||1;
   agent.currentTasks=Array.isArray(agent.currentTasks)?agent.currentTasks:[];
   agent.providerRuntime=providerRuntime.snapshot(slot.id);
   agent.status='offline';
  }
  agentStore.save(agent);
 }
}
ensureProviderAgents();
function normalizedAgentName(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function assignAgentSlot(id,name){
 const existing=agents.get(id);
 if(existing?.slotIndex!==undefined)return {slotIndex:existing.slotIndex,slotId:existing.slotId,slotLabel:existing.slotLabel};
 const identity=normalizedAgentName(id+' '+name);
 const known=PROVIDER_SLOTS.findIndex(slot=>slot.aliases.some(alias=>identity.includes(normalizedAgentName(alias))));
 const occupied=new Set([...agents.values()].filter(a=>a.id!==id).map(a=>a.slotIndex));
 if(known>=0&&!occupied.has(known))return {slotIndex:known,slotId:PROVIDER_SLOTS[known].id,slotLabel:PROVIDER_SLOTS[known].label};
 // Reserve the six named provider slots even when their adapters are offline.
 // Unrecognized agents and duplicate provider instances receive additional slots.
 let slotIndex=PROVIDER_SLOTS.length;
 while(occupied.has(slotIndex))slotIndex++;
 return {slotIndex,slotId:'agent-'+(slotIndex+1),slotLabel:'Agent '+(slotIndex+1)};
}
function topologyRing(){
 const registered=[...agents.values()];
 const primary=PROVIDER_SLOTS.map((slot,slotIndex)=>({
  ringIndex:slotIndex,slotIndex,slotId:slot.id,label:slot.label,
  agent:registered.find(a=>a.slotIndex===slotIndex)||null
 }));
 const extras=registered.filter(a=>a.slotIndex>=PROVIDER_SLOTS.length).sort((a,b)=>a.slotIndex-b.slotIndex);
 return [...primary,...extras.map((agent,index)=>({
  ringIndex:PROVIDER_SLOTS.length+index,slotIndex:agent.slotIndex,
  slotId:agent.slotId,label:agent.slotLabel,agent
 }))];
}
function peerAgentIds(agentId){
 const ring=topologyRing();
 const index=ring.findIndex(node=>node.agent?.id===agentId);
 if(index<0||ring.length<5)return [];
 return [...new Set([1,2,ring.length-2,ring.length-1])]
  .map(offset=>ring[(index+offset)%ring.length]?.agent?.id)
  .filter(id=>id&&id!==agentId);
}
function agentsArePeers(fromAgent,toAgent){
 return peerAgentIds(fromAgent).includes(toAgent);
}
function normalizeCapability(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'').trim();}
function draftCoordinationSteps(objective){
 return [
  {key:'discovery',title:'Discovery and acceptance criteria',description:'Clarify scope, constraints, risks, users, and measurable acceptance criteria for: '+objective,dependsOn:[],requiredCapabilities:[],maxAttempts:2},
  {key:'architecture',title:'Architecture and interfaces',description:'Produce a coherent architecture, module boundaries, data contracts, and implementation sequence.',dependsOn:['discovery'],requiredCapabilities:[],maxAttempts:2},
  {key:'implementation',title:'Core implementation',description:'Implement the primary end-to-end behavior against the agreed architecture and acceptance criteria.',dependsOn:['architecture'],requiredCapabilities:[],maxAttempts:3},
  {key:'validation',title:'Validation and regression review',description:'Review the implementation against acceptance criteria and record reproducible validation evidence. Do not merge or release.',dependsOn:['implementation'],requiredCapabilities:[],maxAttempts:2},
  {key:'security-review',title:'Security and failure-mode review',description:'Review permissions, secret handling, failure paths, recovery behavior, and operational risks.',dependsOn:['implementation'],requiredCapabilities:[],maxAttempts:2},
  {key:'integration',title:'Integration and documentation',description:'Resolve review findings, integrate work safely, and document setup and known limitations.',dependsOn:['validation','security-review'],requiredCapabilities:[],maxAttempts:2},
  {key:'final-review',title:'Final acceptance review',description:'Check deliverables against the objective, summarize evidence and unresolved issues, and recommend next action. Do not perform a production release.',dependsOn:['integration'],requiredCapabilities:[],maxAttempts:2}
 ];
}
function validateDependencyGraph(steps){
 const byKey=new Map();
 for(const step of steps){
  if(byKey.has(step.key))return 'Step keys must be unique.';
  byKey.set(step.key,step);
 }
 for(const step of steps){
  if(new Set(step.dependsOn||[]).size!==(step.dependsOn||[]).length)return 'Step '+step.key+' has duplicate dependencies.';
  for(const dependency of step.dependsOn||[]){
   if(dependency===step.key)return 'Step '+step.key+' cannot depend on itself.';
   if(!byKey.has(dependency))return 'Step '+step.key+' depends on unknown step '+dependency+'.';
  }
 }
 const visiting=new Set(),visited=new Set();
 function visit(key){
  if(visiting.has(key))return false;
  if(visited.has(key))return true;
  visiting.add(key);
  for(const dependency of byKey.get(key).dependsOn||[])if(!visit(dependency))return false;
  visiting.delete(key);visited.add(key);return true;
 }
 for(const key of byKey.keys())if(!visit(key))return 'Step dependencies contain a cycle.';
 return null;
}
function createCoordinationPlan(objective,stepSpecs){
 const now=new Date().toISOString();
 const plan=coordinationStore.createPlan({
  id:crypto.randomUUID(),objective,createdAt:now,updatedAt:now,
  steps:stepSpecs.map(step=>({...step,id:crypto.randomUUID()}))
 });
 emit('coordination.plan.created',{planId:plan.id,objective:plan.objective,stepCount:plan.steps.length});
 return plan;
}
function refreshCoordinationPlanStatus(planId){
 const plan=coordinationStore.getPlan(planId);
 if(!plan)return null;
 const states=plan.steps.map(step=>step.status);
 let status='planned';
 if(states.length&&states.every(state=>state==='done'))status='completed';
 else if(states.length&&states.every(state=>state==='done'||state==='failed'))status='failed';
 else if(states.some(state=>['assigned','in_progress','review','done'].includes(state)))status='active';
 else if(states.some(state=>state==='failed')&&states.some(state=>['ready','blocked'].includes(state)))status='active';
 coordinationStore.updatePlanStatus(planId,status);
 return coordinationStore.getPlan(planId);
}

function serializeCoordinationPlan(plan){
 if(!plan)return plan;
 return {
  ...plan,
  steps:plan.steps.map(step=>({
   ...step,
   assignedAgentName:agents.get(step.assignedAgent)?.name||null,
   peerReviews:coordinationStore.listPeerReviews(step.id).map(review=>({
    ...review,reviewerName:agents.get(review.reviewerAgent)?.name||review.reviewerAgent
   }))
  }))
 };
}
function availableAgentForStep(step){
 const required=(step.requiredCapabilities||[]).map(normalizeCapability);
 const candidates=[...agents.values()]
  .filter(agent=>agent.status!=='offline'&&agent.status!=='disconnected'&&agent.currentTasks.length<agent.maxConcurrentTasks)
  .filter(agent=>!agent.providerId||providerRuntime.canAcceptWork(agent.providerId))
  .filter(agent=>{
   const available=(agent.capabilities||[]).map(normalizeCapability);
   return required.every(capability=>available.includes(capability));
  });
 // Prefer an owner distinct from direct dependency owners for independent review
 // and reduced single-agent bias. Fall back only when no alternative can run.
 const plan=coordinationStore.getPlan(step.planId);
 const dependencyOwners=new Set((plan?.steps||[])
  .filter(parent=>(step.dependsOn||[]).includes(parent.key))
  .map(parent=>parent.assignedAgent).filter(Boolean));
 const independent=candidates.filter(agent=>!dependencyOwners.has(agent.id));
 return (independent.length?independent:candidates)
  .sort((a,b)=>(a.currentTasks.length/a.maxConcurrentTasks)-(b.currentTasks.length/b.maxConcurrentTasks)||a.slotIndex-b.slotIndex)[0]||null;
}
function advanceCoordinationPlan(planId){
 let plan=coordinationStore.getPlan(planId);
 if(!plan)return {error:'Coordination plan not found.'};
 if(['completed','failed'].includes(plan.status))return {plan,assigned:[],unassigned:[],terminal:true};
 let modified=true;
 while(modified){
  modified=false;
  plan=coordinationStore.getPlan(planId);
  const states=new Map(plan.steps.map(step=>[step.key,step.status]));
  for(const step of plan.steps){
   if(step.status!=='blocked')continue;
   const failedDependency=step.dependsOn.find(dependency=>states.get(dependency)==='failed');
   if(failedDependency){
    coordinationStore.updateStep({...step,status:'failed',reviewFeedback:'Dependency '+failedDependency+' failed.',updatedAt:new Date().toISOString()});
    emit('coordination.step.blocked',{planId,stepId:step.id,key:step.key,failedDependency});
    modified=true;
   }else if(step.dependsOn.every(dependency=>states.get(dependency)==='done')){
    coordinationStore.updateStep({...step,status:'ready',updatedAt:new Date().toISOString()});
    modified=true;
   }
  }
 }
 plan=coordinationStore.getPlan(planId);
 const assigned=[];
 const unassigned=[];
 for(const step of plan.steps.filter(item=>item.status==='ready')){
  const agent=availableAgentForStep(step);
  if(!agent){unassigned.push(step.key);continue;}
  const now=new Date().toISOString();
  const updatedStep=coordinationStore.updateStep({
   ...step,status:'assigned',assignedAgent:agent.id,attempts:step.attempts+1,
   resultSummary:null,evidence:[],updatedAt:now,startedAt:null,submittedAt:null,reviewedAt:null
  });
  const workloadId='coord:'+step.id;
  if(!agent.currentTasks.includes(workloadId))agent.currentTasks.push(workloadId);
  agent.status=agent.currentTasks.length>=agent.maxConcurrentTasks?'busy':'available';
  agentStore.save(agent);
  const assignment={kind:'coordination_step',planId,stepId:updatedStep.id,key:updatedStep.key,title:updatedStep.title,description:updatedStep.description,dependsOn:updatedStep.dependsOn,attempt:updatedStep.attempts,maxAttempts:updatedStep.maxAttempts};
  io.to('agent:'+agent.id).emit('agent:work',assignment);
  emit('coordination.step.assigned',{planId,stepId:updatedStep.id,key:updatedStep.key,title:updatedStep.title,agentId:agent.id,agentName:agent.name,attempt:updatedStep.attempts});
  assigned.push({stepId:updatedStep.id,key:updatedStep.key,agentId:agent.id,agentName:agent.name});
  if(agent.providerId&&providerRuntime.canAcceptWork(agent.providerId)){
   const runtimeWork={...assignment,planObjective:plan.objective};
   queueMicrotask(()=>{void executeProviderAssignment(agent.id,runtimeWork);});
  }
  plan=coordinationStore.getPlan(planId);
 }
 plan=refreshCoordinationPlanStatus(planId)||plan;
 return {plan,assigned,unassigned,terminal:plan.status==='completed'||plan.status==='failed'};
}

// Reconcile interrupted leases at startup. Restored agents are offline, so work
// returns to the ready queue and is reassigned only after an agent reconnects.
function advanceOtherCoordinationPlans(excludedPlanId){
 const plans=coordinationStore.listPlans(1000)
  .filter(plan=>(excludedPlanId===null||plan.id!==excludedPlanId)&&!['completed','failed'].includes(plan.status))
  .sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 for(const plan of plans)advanceCoordinationPlan(plan.id);
}

function releaseProviderWork(agentId,stepId){
 const agent=agents.get(agentId);
 if(!agent)return;
 agent.currentTasks=agent.currentTasks.filter(id=>id!=='coord:'+stepId);
 const runtime=agent.providerId?providerRuntime.snapshot(agent.providerId):null;
 const ready=runtime&&['ready','busy'].includes(runtime.status);
 agent.status=ready?(agent.currentTasks.length>=agent.maxConcurrentTasks?'busy':'available'):'offline';
 agent.lastHeartbeat=new Date().toISOString();
 agentStore.save(agent);
}

async function executeProviderAssignment(agentId,assignment){
 const runKey=assignment.stepId;
 if(providerRuns.has(runKey))return;
 providerRuns.add(runKey);
 try{
  let step=coordinationStore.getStep(assignment.stepId);
  const agent=agents.get(agentId);
  if(!step||!agent||!agent.providerId||step.status!=='assigned'||step.assignedAgent!==agentId)return;
  const startedAt=new Date().toISOString();
  step=coordinationStore.updateStep({...step,status:'in_progress',startedAt,updatedAt:startedAt});
  refreshCoordinationPlanStatus(step.planId);
  emit('coordination.step.started',{planId:step.planId,stepId:step.id,key:step.key,agentId,providerId:agent.providerId});
  const plan=coordinationStore.getPlan(step.planId);
  const result=await providerRuntime.dispatch(agent.providerId,{...assignment,planObjective:plan?.objective||''});
  const latest=coordinationStore.getStep(step.id);
  if(!latest||latest.status!=='in_progress'||latest.assignedAgent!==agentId)return;
  const submittedAt=new Date().toISOString();
  const summary=result.success?result.summary:'Provider returned an incomplete, blocked, or unsuccessful result. Coordinator must inspect it before approval.\n\n'+result.summary;
  const evidence=[...result.evidence,result.success?'provider-result:success':'provider-result:needs-review'];
  coordinationStore.addReport({
   id:crypto.randomUUID(),stepId:latest.id,attempt:latest.attempts,agentId,
   summary,evidence:evidence.slice(0,30),submittedAt
  });
  const submitted=coordinationStore.updateStep({
   ...latest,status:'review',resultSummary:summary,evidence:evidence.slice(0,30),
   submittedAt,updatedAt:submittedAt,reviewFeedback:null
  });
  releaseProviderWork(agentId,latest.id);
  emit('coordination.step.submitted',{
   planId:latest.planId,stepId:latest.id,key:latest.key,agentId,title:latest.title,
   providerId:agent.providerId,providerSuccess:result.success
  });
  return submitted;
 }catch(error){
  const latest=coordinationStore.getStep(assignment.stepId);
  if(latest&&latest.assignedAgent===agentId&&['assigned','in_progress'].includes(latest.status)){
   const now=new Date().toISOString();
   const exhausted=latest.attempts>=latest.maxAttempts;
   const feedback='Provider runtime failed; work was not accepted. '+redactSecrets(error?.message||'Unknown adapter failure').slice(0,500);
   coordinationStore.updateStep({
    ...latest,status:exhausted?'failed':'ready',assignedAgent:null,
    reviewFeedback:feedback,startedAt:null,submittedAt:null,updatedAt:now
   });
   releaseProviderWork(agentId,latest.id);
   emit('coordination.step.runtime_failed',{
    planId:latest.planId,stepId:latest.id,key:latest.key,agentId,
    providerId:agents.get(agentId)?.providerId||null,attempt:latest.attempts,
    exhausted,reason:feedback
   });
  }
 }finally{
  providerRuns.delete(runKey);
  const latest=coordinationStore.getStep(assignment.stepId);
  if(latest){
   advanceCoordinationPlan(latest.planId);
   advanceOtherCoordinationPlans(latest.planId);
  }
 }
}

const recoveredCoordinationSteps=coordinationStore.recoverInFlightSteps();
if(recoveredCoordinationSteps)emit('coordination.recovered',{stepCount:recoveredCoordinationSteps});
for(const savedPlan of coordinationStore.listPlans(1000).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)))advanceCoordinationPlan(savedPlan.id);

app.get('/api/coordinator/plans',requireCoordinator,(req,res)=>{
 const limit=Math.max(1,Math.min(100,Number.parseInt(String(req.query.limit||'20'),10)||20));
 const plans=coordinationStore.listPlans(limit).map(serializeCoordinationPlan);
 res.json({plans});
});
app.get('/api/coordinator/plans/:id',requireCoordinator,(req,res)=>{
 const plan=coordinationStore.getPlan(req.params.id);
 if(!plan)return res.status(404).json({error:'Coordination plan not found.'});
 res.json({plan:serializeCoordinationPlan(plan)});
});
app.get('/api/coordinator/reviews',requireCoordinator,(req,res)=>{
 const limit=Math.max(1,Math.min(100,Number.parseInt(String(req.query.limit||'50'),10)||50));
 const reviews=coordinationStore.listPlans(1000).flatMap(plan=>plan.steps
  .filter(step=>step.status==='review')
  .map(step=>({
   planId:plan.id,objective:plan.objective,
   step:{...step,assignedAgentName:agents.get(step.assignedAgent)?.name||null},
   peerReviews:coordinationStore.listPeerReviews(step.id).filter(review=>review.attempt===step.attempts)
    .map(review=>({...review,reviewerName:agents.get(review.reviewerAgent)?.name||review.reviewerAgent}))
  }))
 ).slice(0,limit);
 res.json({reviews});
});
app.post('/api/coordinator/plans/draft',requireCoordinator,(req,res)=>{
 const parsed=z.object({objective:z.string().trim().min(8).max(5000)}).safeParse(req.body);
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 const created=createCoordinationPlan(parsed.data.objective,draftCoordinationSteps(parsed.data.objective));
 const scheduling=advanceCoordinationPlan(created.id);
 res.status(201).json({plan:scheduling.plan,assigned:scheduling.assigned,unassigned:scheduling.unassigned});
});
app.post('/api/coordinator/plans',requireCoordinator,(req,res)=>{
 const stepSchema=z.object({
  key:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  title:z.string().trim().min(1).max(200),
  description:z.string().trim().min(1).max(5000),
  dependsOn:z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(20).default([]),
  requiredCapabilities:z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  maxAttempts:z.number().int().min(1).max(5).default(2)
 });
 const parsed=z.object({
  objective:z.string().trim().min(8).max(5000),
  steps:z.array(stepSchema).min(2).max(20)
 }).safeParse(req.body);
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 const graphError=validateDependencyGraph(parsed.data.steps);
 if(graphError)return res.status(400).json({error:graphError});
 const created=createCoordinationPlan(parsed.data.objective,parsed.data.steps);
 const scheduling=advanceCoordinationPlan(created.id);
 res.status(201).json({plan:scheduling.plan,assigned:scheduling.assigned,unassigned:scheduling.unassigned});
});
app.post('/api/coordinator/plans/:id/advance',requireCoordinator,(req,res)=>{
 const result=advanceCoordinationPlan(req.params.id);
 if(result.error)return res.status(404).json({error:result.error});
 res.json(result);
});
app.get('/api/agents/:id/work',requireMessageAgent,(req,res)=>{
 if(req.params.id!==req.spiderAgent.id)return res.status(403).json({error:'Agents may only retrieve their own assigned work.'});
 res.json({work:coordinationStore.listAgentWork(req.spiderAgent.id).map(step=>({
  ...step,planObjective:coordinationStore.getPlan(step.planId)?.objective||''
 }))});
});
app.get('/api/agents/:id/reviews',requireMessageAgent,(req,res)=>{
 if(req.params.id!==req.spiderAgent.id)return res.status(403).json({error:'Agents may only retrieve their own peer-review queue.'});
 const reviews=coordinationStore.listPlans(1000).flatMap(plan=>plan.steps
  .filter(step=>step.status==='review'&&step.assignedAgent&&step.assignedAgent!==req.spiderAgent.id&&agentsArePeers(req.spiderAgent.id,step.assignedAgent))
  .filter(step=>!coordinationStore.getPeerReviewForAgent(step.id,step.attempts,req.spiderAgent.id))
  .map(step=>({
   planId:plan.id,objective:plan.objective,step,
   authorName:agents.get(step.assignedAgent)?.name||step.assignedAgent,
   report:step.reports?.find(report=>report.attempt===step.attempts)||null,
   peerReviews:coordinationStore.listPeerReviews(step.id).filter(review=>review.attempt===step.attempts)
  }))
 );
 res.json({reviews});
});
app.post('/api/coordinator/steps/:id/peer-review',requireMessageAgent,(req,res)=>{
 const parsed=z.object({
  decision:z.enum(['approve','request_changes','comment']),
  feedback:z.string().trim().min(1).max(2000),
  evidence:z.array(z.string().trim().min(1).max(500)).max(20).default([])
 }).safeParse(req.body);
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 const step=coordinationStore.getStep(req.params.id);
 if(!step)return res.status(404).json({error:'Coordination step not found.'});
 if(step.status!=='review')return res.status(409).json({error:'Peer reviews are only accepted for submitted steps awaiting coordinator review.',status:step.status});
 if(!step.assignedAgent||step.assignedAgent===req.spiderAgent.id)return res.status(403).json({error:'The author cannot review their own step.'});
 if(!agentsArePeers(req.spiderAgent.id,step.assignedAgent))return res.status(403).json({error:'Only a lateral peer of the author may submit this review.',peerAgentIds:peerAgentIds(req.spiderAgent.id)});
 if(coordinationStore.getPeerReviewForAgent(step.id,step.attempts,req.spiderAgent.id))return res.status(409).json({error:'This agent has already reviewed the current attempt.'});
 const review=coordinationStore.addPeerReview({
  id:crypto.randomUUID(),stepId:step.id,attempt:step.attempts,
  reviewerAgent:req.spiderAgent.id,decision:parsed.data.decision,
  feedback:parsed.data.feedback,evidence:parsed.data.evidence,
  createdAt:new Date().toISOString()
 });
 emit('coordination.peer_review.submitted',{planId:step.planId,stepId:step.id,key:step.key,reviewerAgent:req.spiderAgent.id,authorAgent:step.assignedAgent,decision:review.decision});
 res.status(201).json({review,note:'Peer feedback is advisory; the coordinator retains final approval authority.'});
});
app.post('/api/coordinator/steps/:id/start',requireMessageAgent,(req,res)=>{
 const step=coordinationStore.getStep(req.params.id);
 if(!step)return res.status(404).json({error:'Coordination step not found.'});
 if(step.assignedAgent!==req.spiderAgent.id)return res.status(403).json({error:'Step is assigned to another agent.'});
 if(step.status==='in_progress')return res.json({step,note:'Step is already in progress.'});
 if(step.status!=='assigned')return res.status(409).json({error:'Only assigned steps can be started.',status:step.status});
 const now=new Date().toISOString();
 const updated=coordinationStore.updateStep({...step,status:'in_progress',startedAt:now,updatedAt:now});
 refreshCoordinationPlanStatus(step.planId);
 emit('coordination.step.started',{planId:step.planId,stepId:step.id,key:step.key,agentId:req.spiderAgent.id});
 res.json({step:updated});
});
app.post('/api/coordinator/steps/:id/submit',requireMessageAgent,(req,res)=>{
 const parsed=z.object({
  summary:z.string().trim().min(1).max(5000),
  evidence:z.array(z.string().trim().min(1).max(500)).max(30).default([])
 }).safeParse(req.body);
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 const step=coordinationStore.getStep(req.params.id);
 if(!step)return res.status(404).json({error:'Coordination step not found.'});
 if(step.assignedAgent!==req.spiderAgent.id)return res.status(403).json({error:'Step is assigned to another agent.'});
 if(!['assigned','in_progress'].includes(step.status))return res.status(409).json({error:'Step is not accepting a submission.',status:step.status});
 const now=new Date().toISOString();
 coordinationStore.addReport({id:crypto.randomUUID(),stepId:step.id,attempt:step.attempts,agentId:req.spiderAgent.id,summary:parsed.data.summary,evidence:parsed.data.evidence,submittedAt:now});
 const updated=coordinationStore.updateStep({...step,status:'review',resultSummary:parsed.data.summary,evidence:parsed.data.evidence,submittedAt:now,updatedAt:now,reviewFeedback:null});
 const agent=agents.get(req.spiderAgent.id);
 if(agent){
  agent.currentTasks=agent.currentTasks.filter(id=>id!=='coord:'+step.id);
  agent.status=agent.currentTasks.length>=agent.maxConcurrentTasks?'busy':'available';
  agentStore.save(agent);
 }
 emit('coordination.step.submitted',{planId:step.planId,stepId:step.id,key:step.key,agentId:req.spiderAgent.id,title:step.title});
 const scheduling=advanceCoordinationPlan(step.planId);
 advanceOtherCoordinationPlans(step.planId);
 res.status(202).json({step:updated,plan:scheduling.plan,assigned:scheduling.assigned,unassigned:scheduling.unassigned,note:'Submission saved for coordinator review; dependencies remain blocked until approval.'});
});
app.post('/api/coordinator/steps/:id/review',requireCoordinator,(req,res)=>{
 const parsed=z.object({
  decision:z.enum(['approve','reject']),
  feedback:z.string().trim().max(2000).default('')
 }).safeParse(req.body);
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 if(parsed.data.decision==='reject'&&!parsed.data.feedback)return res.status(400).json({error:'Feedback is required when rejecting a submission.'});
 const step=coordinationStore.getStep(req.params.id);
 if(!step)return res.status(404).json({error:'Coordination step not found.'});
 if(step.status!=='review')return res.status(409).json({error:'Step is not awaiting review.',status:step.status});
 const currentPlan=coordinationStore.getPlan(step.planId);
 const currentReport=currentPlan?.steps.find(item=>item.id===step.id)?.reports.find(report=>report.attempt===step.attempts);
 if(!currentReport||currentReport.reviewDecision)return res.status(409).json({error:'The current attempt has already been reviewed or has no report.'});
 const now=new Date().toISOString();
 coordinationStore.reviewReport(step.id,step.attempts,parsed.data.decision,parsed.data.feedback,now);
 const approved=parsed.data.decision==='approve';
 const exhausted=!approved&&step.attempts>=step.maxAttempts;
 const status=approved?'done':exhausted?'failed':'ready';
 const reviewedStep=coordinationStore.updateStep({
  ...step,status,assignedAgent:approved?step.assignedAgent:null,
  reviewFeedback:parsed.data.feedback,reviewedAt:now,updatedAt:now
 });
 emit('coordination.step.reviewed',{planId:step.planId,stepId:step.id,key:step.key,decision:parsed.data.decision,agentId:step.assignedAgent,attempt:step.attempts});
 const scheduling=advanceCoordinationPlan(step.planId);
 advanceOtherCoordinationPlans(step.planId);
 res.json({step:reviewedStep,plan:scheduling.plan,assigned:scheduling.assigned,unassigned:scheduling.unassigned});
});
app.get('/api/topology',requireCoordinator,(_q,r)=>{
 const registered=[...agents.values()].map(a=>({...a}));
 const slots=PROVIDER_SLOTS.map((slot,slotIndex)=>({ ...slot,slotIndex,agent:registered.find(a=>a.slotIndex===slotIndex)||null }));
 const extras=registered.filter(a=>a.slotIndex>=PROVIDER_SLOTS.length).sort((a,b)=>a.slotIndex-b.slotIndex);
 const ring=topologyRing().map(({agent,...node})=>({...node,agentId:agent?.id||null}));
 const peerMap=Object.fromEntries(registered.map(agent=>[agent.id,peerAgentIds(agent.id)]));
 r.json({coordinator:{id:'spider',label:'Spider'},slots,additionalAgents:extras,ring,peerOffsets:[1,2],peerMap,registeredCount:registered.length});
});
app.post('/api/messages',requireMessageAgent,(req,res)=>{
 const schema=z.object({
  taskId:z.string().min(1).max(100),
  traceId:z.string().min(1).max(100),
  fromAgent:z.string().min(2).max(100),
  toAgent:z.string().min(2).max(100),
  kind:z.enum(['request_review','question','artifact_ready','blocker','handoff']),
  summary:z.string().trim().min(1).max(4000),
  artifactRefs:z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  replyTo:z.string().uuid().nullable().optional(),
  deadlineAt:z.string().datetime({offset:true}).optional()
 }).safeParse(req.body);
 if(!schema.success)return res.status(400).json({error:schema.error.flatten()});
 const data=schema.data;
 if(data.fromAgent!==req.spiderAgent.id)return res.status(403).json({error:'fromAgent must match the authenticated x-agent-id.'});
 if(data.fromAgent===data.toAgent)return res.status(400).json({error:'Agents cannot send peer messages to themselves.'});
 if(!agents.has(data.toAgent))return res.status(404).json({error:'Recipient agent is not registered.'});
 if(data.taskId!=='general'&&!tasks.has(data.taskId))return res.status(404).json({error:'Task not found. Use taskId "general" for task-independent coordination.'});
 if(!agentsArePeers(data.fromAgent,data.toAgent)){
  return res.status(409).json({error:'Recipient is not one of the sender’s four lateral peers.',peerAgentIds:peerAgentIds(data.fromAgent)});
 }
 if(data.replyTo){
  const parent=messageStore.get(data.replyTo);
  if(!parent)return res.status(400).json({error:'replyTo message was not found.'});
  if(parent.fromAgent!==data.toAgent||parent.toAgent!==data.fromAgent)return res.status(400).json({error:'Replies must go back to the original sender.'});
  if(parent.taskId!==data.taskId||parent.traceId!==data.traceId)return res.status(400).json({error:'Replies must retain the original taskId and traceId.'});
 }
 const createdAt=new Date().toISOString();
 const queued=messageStore.create({...data,id:crypto.randomUUID(),createdAt,status:'queued'});
 const room='agent:'+queued.toAgent;
 const connected=Boolean(io.sockets.adapter.rooms.get(room)?.size);
 const message=connected?(messageStore.markDelivered(queued.id,queued.toAgent)||queued):queued;
 io.to(room).emit('agent:message',message);
 const fromName=agents.get(message.fromAgent).name;
 const toName=agents.get(message.toAgent).name;
 const eventType=message.status==='delivered'?'agent.message.delivered':'agent.message.queued';
 emit(eventType,{
  id:message.id,taskId:message.taskId,traceId:message.traceId,
  fromAgent:message.fromAgent,toAgent:message.toAgent,kind:message.kind,
  title:fromName+' → '+toName+(message.status==='delivered'?' · delivered':''),
  createdAt:message.createdAt,deliveredAt:message.deliveredAt
 });
 res.status(201).json({message});
});
app.get('/api/agents/:id/messages',requireMessageAgent,(req,res)=>{
 if(req.params.id!==req.spiderAgent.id)return res.status(403).json({error:'Agents may only read their own inbox.'});
 const limit=Math.max(1,Math.min(100,Number.parseInt(String(req.query.limit||'20'),10)||20));
 const inbox=messageStore.inbox(req.spiderAgent.id,limit);
 emitMessageDeliveryEvents(inbox.newlyDelivered);
 res.json({messages:inbox.messages});
});
function emitMessageDeliveryEvents(messages){
 for(const message of messages){
  const fromName=agents.get(message.fromAgent)?.name||message.fromAgent;
  const toName=agents.get(message.toAgent)?.name||message.toAgent;
  emit('agent.message.delivered',{id:message.id,taskId:message.taskId,fromAgent:message.fromAgent,toAgent:message.toAgent,kind:message.kind,title:fromName+' → '+toName+' · delivered',deliveredAt:message.deliveredAt});
 }
}
app.post('/api/messages/:id/ack',requireMessageAgent,(req,res)=>{
 const existing=messageStore.get(req.params.id);
 if(!existing)return res.status(404).json({error:'Message not found.'});
 if(existing.toAgent!==req.spiderAgent.id)return res.status(403).json({error:'Only the recipient agent may acknowledge a message.'});
 const message=messageStore.acknowledge(existing.id,req.spiderAgent.id);
 if(!message&&existing.status!=='acknowledged')return res.status(409).json({error:'Message is not in an acknowledgeable state.'});
 const acknowledged=message||existing;
 emit('agent.message.acknowledged',{id:acknowledged.id,taskId:acknowledged.taskId,fromAgent:acknowledged.fromAgent,toAgent:acknowledged.toAgent,kind:acknowledged.kind,title:(agents.get(acknowledged.fromAgent)?.name||acknowledged.fromAgent)+' → '+(agents.get(acknowledged.toAgent)?.name||acknowledged.toAgent)+' · acknowledged',acknowledgedAt:acknowledged.acknowledgedAt});
 res.json({message:acknowledged});
});
app.post('/api/agents/register',requireCoordinator,(req,res)=>{
 const p=z.object({id:z.string().min(2).max(100),name:z.string().trim().min(1).max(100),runtime:z.enum(['local','remote']),capabilities:z.array(z.string().trim().min(1).max(100)).max(50).default([]),maxConcurrentTasks:z.number().int().min(1).max(20).default(1)}).safeParse(req.body);
 if(!p.success)return res.status(400).json({error:p.error.flatten()});
 if(agents.get(p.data.id)?.providerId)return res.status(409).json({error:'This identity is managed by its configured provider adapter; configure the adapter environment instead of registering it as an external worker.'});
 const prior=agents.get(p.data.id),slot=assignAgentSlot(p.data.id,p.data.name),now=new Date().toISOString();
 const a={...prior,...p.data,...slot,status:prior?.currentTasks?.length?'busy':'available',currentTasks:prior?.currentTasks||[],registeredAt:prior?.registeredAt||now,lastHeartbeat:now};
 agentStore.save(a);agents.set(a.id,a);emit('agent.registered',{agent:a,slot:{id:a.slotId,index:a.slotIndex,label:a.slotLabel}});
 advanceOtherCoordinationPlans(null);
 res.status(prior?200:201).json({agent:a,slot:{id:a.slotId,index:a.slotIndex,label:a.slotLabel},topology:'/api/topology'});
});
app.delete('/api/agents/:id',requireCoordinator,(req,res)=>{
 const a=agents.get(req.params.id);
 if(!a)return res.status(404).json({error:'Agent not registered'});
 if(a.providerId)return res.status(409).json({error:'Provider-backed identities are reserved; disable the adapter instead of deleting the slot.'});
 if(a.currentTasks.length)return res.status(409).json({error:'Agent has active tasks; complete or release them before removal.',activeTasks:a.currentTasks});
 agentStore.delete(a.id);agents.delete(a.id);
 const slot={id:a.slotId,index:a.slotIndex,label:a.slotLabel};
 emit('agent.removed',{id:a.id,name:a.name,slot});
 res.json({removed:true,agentId:a.id,freedSlot:slot});
});
app.post('/api/agents/:id/heartbeat',requireMessageAgent,(req,res)=>{
 if(req.params.id!==req.spiderAgent.id)return res.status(403).json({error:'Agents may only heartbeat their own identity.'});
 const parsed=z.object({status:z.enum(['available','busy','offline']).optional()}).safeParse(req.body||{});
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 const a=req.spiderAgent;
 if(a.providerId)return res.status(409).json({error:'Provider-backed runtime health is managed by the provider adapter, not external heartbeat posts.'});
 a.lastHeartbeat=new Date().toISOString();
 if(parsed.data.status==='offline')a.status='offline';
 else if(parsed.data.status==='busy'||a.currentTasks.length>=a.maxConcurrentTasks)a.status='busy';
 else a.status='available';
 agentStore.save(a);
 emit('agent.heartbeat',{id:a.id,status:a.status});
 advanceOtherCoordinationPlans(null);
 res.json({agent:a});
});
app.post('/api/tasks/:id/claim',requireMessageAgent,(req,res)=>{
 const t=tasks.get(req.params.id),a=req.spiderAgent;
 if(!t)return res.status(404).json({error:'Task not found; sync GitHub first.'});
 if(req.body?.agentId&&req.body.agentId!==a.id)return res.status(403).json({error:'agentId must match the authenticated x-agent-id.'});
 if(a.providerId)return res.status(409).json({error:'Provider-backed agents receive dependency-aware work through the coordinator, not manual GitHub task claims.'});
 if(['done','review','in_progress'].includes(t.status)||t.state==='closed')return res.status(409).json({error:'Task not claimable',status:t.status});
 if(a.currentTasks.length>=a.maxConcurrentTasks)return res.status(409).json({error:'Concurrency limit reached'});
 t.status='in_progress';t.assigneeAgent=a.id;t.claimedAt=new Date().toISOString();
 a.currentTasks.push(t.id);a.status=a.currentTasks.length>=a.maxConcurrentTasks?'busy':'available';
 a.lastHeartbeat=new Date().toISOString();agentStore.save(a);
 emit('task.claimed',{task:t,agentId:a.id});
 res.json({task:t,agent:a});
});
app.post('/api/tasks/:id/progress',requireMessageAgent,(req,res)=>{
 const parsed=z.object({agentId:z.string().optional(),message:z.string().max(2000).default(''),percent:z.number().finite().min(0).max(100).default(0)}).safeParse(req.body||{});
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 const t=tasks.get(req.params.id),agent=req.spiderAgent;
 if(!t)return res.status(404).json({error:'Task not found'});
 if(parsed.data.agentId&&parsed.data.agentId!==agent.id)return res.status(403).json({error:'agentId must match the authenticated x-agent-id.'});
 if(t.assigneeAgent!==agent.id)return res.status(403).json({error:'Task is assigned to another agent or has not been claimed by this agent.'});
 if(t.status!=='in_progress')return res.status(409).json({error:'Progress is only accepted for an in-progress task.',status:t.status});
 t.progress={message:parsed.data.message,percent:parsed.data.percent,at:new Date().toISOString()};
 agent.lastHeartbeat=t.progress.at;agentStore.save(agent);
 emit('task.progress',{taskId:t.id,progress:t.progress});
 res.json({task:t});
});
app.post('/api/tasks/:id/complete',requireMessageAgent,(req,res)=>{
 const parsed=z.object({agentId:z.string().optional(),summary:z.string().trim().min(1).max(5000),evidence:z.array(z.string().trim().min(1).max(500)).max(30).default([])}).safeParse(req.body||{});
 if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
 const t=tasks.get(req.params.id),agent=req.spiderAgent;
 if(!t)return res.status(404).json({error:'Task not found'});
 if(parsed.data.agentId&&parsed.data.agentId!==agent.id)return res.status(403).json({error:'agentId must match the authenticated x-agent-id.'});
 if(t.assigneeAgent!==agent.id)return res.status(403).json({error:'Task is assigned to another agent or has not been claimed by this agent.'});
 if(t.status!=='in_progress')return res.status(409).json({error:'Task is not accepting a completion report.',status:t.status});
 const now=new Date().toISOString();
 t.completionReport={summary:parsed.data.summary,evidence:parsed.data.evidence,at:now};
 t.status='review';
 agent.currentTasks=agent.currentTasks.filter(id=>id!==t.id);
 agent.status=agent.currentTasks.length>=agent.maxConcurrentTasks?'busy':'available';
 agent.lastHeartbeat=now;agentStore.save(agent);
 emit('task.completion_submitted',{task:t,agentId:agent.id});
 res.json({task:t,note:'Submitted for verification; GitHub issue is not automatically closed.'});
});
function validSignature(req){const secret=process.env.GITHUB_WEBHOOK_SECRET;if(!configuredSecret(secret))return false;const sig=req.get('x-hub-signature-256');if(!sig||!Buffer.isBuffer(req.body))return false;const expected='sha256='+crypto.createHmac('sha256',secret).update(req.body).digest('hex');const a=Buffer.from(sig),b=Buffer.from(expected);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
app.post('/api/webhooks/github',async(req,res)=>{if(!configuredSecret(process.env.GITHUB_WEBHOOK_SECRET))return res.status(503).json({error:'GitHub webhooks are disabled until GITHUB_WEBHOOK_SECRET is set to a non-placeholder secret of at least 32 characters.'});if(!validSignature(req))return res.status(401).json({error:'Invalid webhook signature'});let p;try{p=JSON.parse(req.body.toString());}catch{return res.status(400).json({error:'Invalid JSON'});}const event=req.get('x-github-event')||'unknown';emit('github.webhook',{event,action:p.action,repository:p.repository?.full_name});if(octokit&&['issues','issue_comment','pull_request','push','check_run','workflow_run'].includes(event))try{await sync();}catch(e){emit('github.sync.error',{message:e.message});}res.status(202).json({accepted:true});});
io.on('connection',s=>{
 const auth=s.handshake.auth||{};
 const coordinatorAuthorized=configuredSecret(process.env.SPIDER_COORDINATOR_API_KEY)&&secureEqual(auth.coordinatorKey,process.env.SPIDER_COORDINATOR_API_KEY);
 if(coordinatorAuthorized)s.join('coordinator');
 const agentId=auth.agentId;
 if(configuredSecret(process.env.SPIDER_AGENT_API_KEY)&&secureEqual(auth.agentApiKey,process.env.SPIDER_AGENT_API_KEY)&&agents.has(agentId)){
  s.join('agent:'+agentId);
  const inbox=messageStore.inbox(agentId,20);
  s.emit('agent:inbox',{messages:inbox.messages});
  emitMessageDeliveryEvents(inbox.newlyDelivered);
 }
 if(coordinatorAuthorized)s.emit('framework:snapshot',{tasks:[...tasks.values()],agents:[...agents.values()],events});
 });
if(octokit)sync().catch(e=>console.error('Initial GitHub sync failed:',e.message));
const port=Number(process.env.PORT||4000);server.listen(port,()=>{
 console.log('Universal Agent API listening at http://localhost:'+port);
 providerRuntime.start().then(()=>console.log('Provider runtime lifecycle initialized.')).catch(error=>console.error('Provider runtime initialization failed:',redactSecrets(error?.message||'unknown error')));
});
