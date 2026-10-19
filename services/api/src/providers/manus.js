import {boundedText,cliPrompt,redactSecrets} from './base.js';

const BASE_URL='https://api.manus.ai/v2';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function requestJson(url,{method='GET',headers={},body,timeoutMs=20000}={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{
      method,headers:{accept:'application/json',...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal
    });
    const text=await response.text();
    let payload;
    try{payload=JSON.parse(text);}catch{payload={raw:text.slice(0,1000)};}
    if(!response.ok)throw new Error('Manus API returned HTTP '+response.status+': '+redactSecrets(payload?.error?.message||payload?.message||response.statusText).slice(0,300));
    if(payload?.ok===false)throw new Error('Manus API rejected the request: '+redactSecrets(payload?.error?.message||payload?.error?.code||'unknown error').slice(0,300));
    return payload;
  }finally{clearTimeout(timer);}
}

function collectText(value,out=[],depth=0){
  if(depth>7||value==null)return out;
  if(typeof value==='string'){const text=value.trim();if(text)out.push(text);return out;}
  if(Array.isArray(value)){for(const item of value)collectText(item,out,depth+1);return out;}
  if(typeof value==='object'){
    if(typeof value.text==='string')collectText(value.text,out,depth+1);
    else if(typeof value.content==='string')collectText(value.content,out,depth+1);
    else if(Array.isArray(value.content))collectText(value.content,out,depth+1);
    else if(Array.isArray(value.messages))collectText(value.messages,out,depth+1);
  }
  return out;
}

function statusOf(message){
  const events=Array.isArray(message)?message:[];
  for(const event of events){
    const candidate=event?.status_update?.agent_status||event?.agent_status||event?.status;
    if(['running','stopped','waiting','error'].includes(String(candidate||'').toLowerCase()))return String(candidate).toLowerCase();
    const nested=event?.content;
    if(Array.isArray(nested))for(const part of nested){
      const status=part?.status_update?.agent_status||part?.agent_status;
      if(['running','stopped','waiting','error'].includes(String(status||'').toLowerCase()))return String(status).toLowerCase();
    }
  }
  return 'running';
}

export class ManusAdapter{
  constructor(){
    this.id='manus';this.label='Manus';this.description='Manus task API with asynchronous task polling.';
    this.authenticationBlocked=false;
    this.healthState={status:'offline',reason:'Not checked yet.',checkedAt:null,authState:'unknown'};
  }
  get enabled(){return process.env.SPIDER_MANUS_ENABLED==='true';}
  get maxConcurrentTasks(){const n=Number.parseInt(process.env.SPIDER_MANUS_MAX_CONCURRENT_TASKS||'1',10);return Number.isFinite(n)?Math.max(1,Math.min(3,n)):1;}
  async reset(){this.authenticationBlocked=false;return this.health();}
  async health(){
    const checkedAt=new Date().toISOString();
    if(this.authenticationBlocked)return this.healthState={status:'offline',reason:'Manus API authentication failed. Correct MANUS_API_KEY, then explicitly refresh this adapter.',checkedAt,authState:'failed'};
    if(!this.enabled)return this.healthState={status:'offline',reason:'Adapter is not enabled; set SPIDER_MANUS_ENABLED=true.',checkedAt,authState:'unknown'};
    if(!process.env.MANUS_API_KEY)return this.healthState={status:'offline',reason:'MANUS_API_KEY is not configured.',checkedAt,authState:'missing'};
    return this.healthState={status:'ready',reason:null,checkedAt,authState:'not-probed'};
  }
  async runTask(work){
    const apiKey=process.env.MANUS_API_KEY;
    if(!apiKey)throw new Error('MANUS_API_KEY is not configured.');
    try{
    const prompt=cliPrompt(work);
    const created=await requestJson(BASE_URL+'/task.create',{
      method:'POST',headers:{'content-type':'application/json','x-manus-api-key':apiKey},
      body:{message:{content:[{type:'text',text:prompt,visibility:'visible'}]},title:boundedText(work.title,180),interactive_mode:false,share_visibility:'private'},
      timeoutMs:30000
    });
    const taskId=created.task_id;
    if(!taskId)throw new Error('Manus did not return a task_id.');
    const timeoutMs=Math.max(30000,Math.min(900000,Number.parseInt(process.env.SPIDER_MANUS_TIMEOUT_MS||'300000',10)||300000));
    const endAt=Date.now()+timeoutMs;
    let lastMessages=[],state='running';
    while(Date.now()<endAt){
      const query=new URLSearchParams({task_id:taskId,order:'desc',limit:'50'});
      const result=await requestJson(BASE_URL+'/task.listMessages?'+query.toString(),{
        headers:{'x-manus-api-key':apiKey},timeoutMs:20000
      });
      lastMessages=Array.isArray(result.messages)?result.messages:[];
      state=statusOf(lastMessages);
      if(state==='stopped'||state==='waiting'||state==='error')break;
      await wait(Math.max(1500,Math.min(15000,Number.parseInt(process.env.SPIDER_MANUS_POLL_MS||'5000',10)||5000)));
    }
    if(state==='running')throw new Error('Manus task exceeded Spider’s configured timeout.');
    const snippets=collectText(lastMessages).filter(text=>text.length>15);
    const summary=redactSecrets(snippets.slice(-6).join('\n\n')).slice(-5000);
    const taskUrl=typeof created.task_url==='string'?created.task_url:'';
    const evidence=['provider:manus','manus-task-id:'+taskId];
    if(taskUrl)evidence.push('manus-task-url:'+taskUrl.slice(0,500));
    if(state==='waiting')return {summary:'Manus is waiting for user confirmation or additional input. Do not treat this as completed work.\n\n'+summary,evidence,success:false,providerStatus:'ready'};
    if(state==='error')return {summary:'Manus reported an execution error.\n\n'+summary,evidence,success:false,providerStatus:'ready'};
    return {summary:summary||'Manus marked the task stopped but returned no readable text; inspect the task URL.',evidence,success:true,providerStatus:'ready'};
    }catch(error){
      if(/HTTP (401|403)|unauthenticated|invalid.*(key|token)|authentication|unauthorized|forbidden/i.test(String(error?.message||''))){
        this.authenticationBlocked=true;
        this.healthState={status:'offline',reason:'Manus API authentication failed. Correct MANUS_API_KEY, then explicitly refresh this adapter.',checkedAt:new Date().toISOString(),authState:'failed'};
        throw new Error('Manus API authentication failed; correct MANUS_API_KEY, then refresh the adapter.');
      }
      throw error;
    }
  }
}
