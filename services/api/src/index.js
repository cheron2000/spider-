import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import {Octokit} from '@octokit/rest';
import {z} from 'zod';

const app=express(),server=createServer(app),origin=process.env.DASHBOARD_ORIGIN||'http://localhost:5173';
const io=new Server(server,{cors:{origin,methods:['GET','POST']}});
app.use(cors({origin}));
app.use('/api/webhooks/github',express.raw({type:'application/json'}));
app.use(express.json({limit:'1mb'}));
const [owner,repo]=(process.env.GITHUB_REPOSITORY||'').split('/');
const octokit=process.env.GITHUB_TOKEN?new Octokit({auth:process.env.GITHUB_TOKEN}):null;
const tasks=new Map(),agents=new Map(),events=[];
function emit(type,payload){const e={id:crypto.randomUUID(),type,payload,at:new Date().toISOString()};events.push(e);if(events.length>300)events.shift();io.emit('framework:event',e);}
function issueTask(i){const labels=(i.labels||[]).map(x=>typeof x==='string'?x:x.name);return{id:'issue-'+i.number,number:i.number,title:i.title,body:i.body||'',url:i.html_url,state:i.state,status:i.state==='closed'?'done':labels.find(x=>x.startsWith('status:'))?.slice(7)||'todo',labels,assigneeAgent:labels.find(x=>x.startsWith('agent:'))?.slice(6)||null,priority:labels.find(x=>x.startsWith('priority:'))?.slice(9)||'medium',updatedAt:i.updated_at};}
function githubRequired(_q,r,next){if(!octokit||!owner||!repo)return r.status(503).json({error:'Set GITHUB_TOKEN and GITHUB_REPOSITORY in .env.'});next();}
async function sync(){const issues=await octokit.paginate(octokit.issues.listForRepo,{owner,repo,state:'all',per_page:100});for(const i of issues)if(!i.pull_request)tasks.set('issue-'+i.number,issueTask(i));emit('github.synced',{repository:owner+'/'+repo,count:tasks.size});return [...tasks.values()];}
async function ensureLabel(name){try{await octokit.issues.getLabel({owner,repo,name});}catch(e){if(e.status!==404)throw e;await octokit.issues.createLabel({owner,repo,name,color:name==='type:epic'?'6f42c1':name==='priority:high'?'d93f0b':'1f6feb',description:'Managed by Universal Agent Framework'});}}
async function createIssue(title,body,labels=['agent-task']){for(const label of labels)await ensureLabel(label);const {data}=await octokit.issues.create({owner,repo,title,body,labels});const t=issueTask(data);tasks.set(t.id,t);emit('task.created',t);return t;}
app.get('/api/health',(_q,r)=>r.json({ok:true,repository:owner&&repo?owner+'/'+repo:null,githubConfigured:!!octokit,taskCount:tasks.size,agentCount:agents.size}));
app.get('/api/tasks',(_q,r)=>r.json({tasks:[...tasks.values()]}));
app.get('/api/agents',(_q,r)=>r.json({agents:[...agents.values()]}));
app.get('/api/events',(_q,r)=>r.json({events}));
app.post('/api/github/sync',githubRequired,async(_q,r)=>{try{r.json({tasks:await sync()});}catch(e){r.status(502).json({error:e.message});}});
app.post('/api/ceo/plan',githubRequired,async(req,res)=>{
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
function normalizedAgentName(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function assignAgentSlot(id,name){
 const existing=agents.get(id);
 if(existing?.slotIndex!==undefined)return {slotIndex:existing.slotIndex,slotId:existing.slotId,slotLabel:existing.slotLabel};
 const identity=normalizedAgentName(id+' '+name);
 const known=PROVIDER_SLOTS.findIndex(slot=>slot.aliases.some(alias=>identity.includes(normalizedAgentName(alias))));
 if(known>=0){
  const occupied=[...agents.values()].some(a=>a.id!==id&&a.slotIndex===known);
  if(!occupied)return {slotIndex:known,slotId:PROVIDER_SLOTS[known].id,slotLabel:PROVIDER_SLOTS[known].label};
 }
 const occupied=new Set([...agents.values()].filter(a=>a.id!==id).map(a=>a.slotIndex));
 let slotIndex=0;while(occupied.has(slotIndex))slotIndex++;
 const slot=PROVIDER_SLOTS[slotIndex];
 return {slotIndex,slotId:slot?.id||('agent-'+(slotIndex+1)),slotLabel:slot?.label||('Agent '+(slotIndex+1))};
}
app.get('/api/topology',(_q,r)=>{
 const registered=[...agents.values()].map(a=>({...a}));
 const slots=PROVIDER_SLOTS.map((slot,slotIndex)=>({ ...slot,slotIndex,agent:registered.find(a=>a.slotIndex===slotIndex)||null }));
 const extras=registered.filter(a=>a.slotIndex>=PROVIDER_SLOTS.length).sort((a,b)=>a.slotIndex-b.slotIndex);
 r.json({coordinator:{id:'spider',label:'Spider'},slots,additionalAgents:extras,peerOffsets:[1,2],registeredCount:registered.length});
});
app.post('/api/agents/register',(req,res)=>{
 const p=z.object({id:z.string().min(2).max(100),name:z.string().min(1).max(100),runtime:z.enum(['local','remote']),capabilities:z.array(z.string().max(100)).max(50).default([]),maxConcurrentTasks:z.number().int().min(1).max(20).default(1)}).safeParse(req.body);
 if(!p.success)return res.status(400).json({error:p.error.flatten()});
 const prior=agents.get(p.data.id),slot=assignAgentSlot(p.data.id,p.data.name),now=new Date().toISOString();
 const a={...prior,...p.data,...slot,status:prior?.status||'available',currentTasks:prior?.currentTasks||[],registeredAt:prior?.registeredAt||now,lastHeartbeat:now};
 agents.set(a.id,a);emit('agent.registered',{agent:a,slot:{id:a.slotId,index:a.slotIndex,label:a.slotLabel}});res.status(prior?200:201).json({agent:a,slot:{id:a.slotId,index:a.slotIndex,label:a.slotLabel},topology:'/api/topology'});
});
app.post('/api/agents/:id/heartbeat',(req,res)=>{const a=agents.get(req.params.id);if(!a)return res.status(404).json({error:'Agent not registered'});a.lastHeartbeat=new Date().toISOString();if(req.body?.status)a.status=req.body.status;emit('agent.heartbeat',{id:a.id,status:a.status});res.json({agent:a});});
app.post('/api/tasks/:id/claim',(req,res)=>{const t=tasks.get(req.params.id),a=agents.get(req.body?.agentId);if(!t)return res.status(404).json({error:'Task not found; sync GitHub first.'});if(!a)return res.status(400).json({error:'Register agent first.'});if(['done','in_progress'].includes(t.status))return res.status(409).json({error:'Task not claimable',status:t.status});if(a.currentTasks.length>=a.maxConcurrentTasks)return res.status(409).json({error:'Concurrency limit reached'});t.status='in_progress';t.assigneeAgent=a.id;t.claimedAt=new Date().toISOString();a.currentTasks.push(t.id);a.status=a.currentTasks.length>=a.maxConcurrentTasks?'busy':'available';emit('task.claimed',{task:t,agentId:a.id});res.json({task:t,agent:a});});
app.post('/api/tasks/:id/progress',(req,res)=>{const t=tasks.get(req.params.id);if(!t)return res.status(404).json({error:'Task not found'});if(t.assigneeAgent&&req.body?.agentId!==t.assigneeAgent)return res.status(403).json({error:'Task assigned to another agent'});t.progress={message:String(req.body?.message||'').slice(0,2000),percent:Math.max(0,Math.min(100,Number(req.body?.percent||0))),at:new Date().toISOString()};emit('task.progress',{taskId:t.id,progress:t.progress});res.json({task:t});});
app.post('/api/tasks/:id/complete',(req,res)=>{const t=tasks.get(req.params.id);if(!t)return res.status(404).json({error:'Task not found'});const {agentId,summary,evidence=[]}=req.body||{};if(t.assigneeAgent&&agentId!==t.assigneeAgent)return res.status(403).json({error:'Task assigned to another agent'});t.completionReport={summary:String(summary||'').slice(0,5000),evidence,at:new Date().toISOString()};t.status='review';const a=agents.get(agentId);if(a){a.currentTasks=a.currentTasks.filter(x=>x!==t.id);a.status='available';}emit('task.completion_submitted',{task:t,agentId});res.json({task:t,note:'Submitted for verification; GitHub issue is not automatically closed.'});});
function validSignature(req){const secret=process.env.GITHUB_WEBHOOK_SECRET;if(!secret)return true;const sig=req.get('x-hub-signature-256');if(!sig||!Buffer.isBuffer(req.body))return false;const expected='sha256='+crypto.createHmac('sha256',secret).update(req.body).digest('hex');const a=Buffer.from(sig),b=Buffer.from(expected);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
app.post('/api/webhooks/github',async(req,res)=>{if(!validSignature(req))return res.status(401).json({error:'Invalid webhook signature'});let p;try{p=JSON.parse(req.body.toString());}catch{return res.status(400).json({error:'Invalid JSON'});}const event=req.get('x-github-event')||'unknown';emit('github.webhook',{event,action:p.action,repository:p.repository?.full_name});if(octokit&&['issues','issue_comment','pull_request','push','check_run','workflow_run'].includes(event))try{await sync();}catch(e){emit('github.sync.error',{message:e.message});}res.status(202).json({accepted:true});});
io.on('connection',s=>s.emit('framework:snapshot',{tasks:[...tasks.values()],agents:[...agents.values()],events}));
if(octokit)sync().catch(e=>console.error('Initial GitHub sync failed:',e.message));
const port=Number(process.env.PORT||4000);server.listen(port,()=>console.log('Universal Agent API listening at http://localhost:'+port));
