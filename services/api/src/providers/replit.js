import {boundedText,cliPrompt,redactSecrets} from './base.js';

function bridgeUrl(){
  const value=process.env.SPIDER_REPLIT_BRIDGE_URL;
  if(!value)return null;
  try{
    const url=new URL(value);
    const local=['localhost','127.0.0.1','::1'].includes(url.hostname);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))return null;
    if(url.username||url.password||url.search||url.hash)return null;
    return url.toString().replace(/\/$/,'');
  }catch{return null;}
}

async function callBridge(url,{method='GET',body,timeoutMs=15000}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const token=process.env.SPIDER_REPLIT_BRIDGE_TOKEN;
    const response=await fetch(url,{
      method,headers:{
        accept:'application/json',
        ...(body===undefined?{}:{'content-type':'application/json'}),
        ...(token?{authorization:'Bearer '+token}:{})
      },
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal
    });
    const text=await response.text();let payload;
    try{payload=JSON.parse(text);}catch{payload={message:text.slice(0,1000)};}
    if(!response.ok)throw new Error('Replit bridge returned HTTP '+response.status+'.');
    return payload;
  }finally{clearTimeout(timer);}
}

export class ReplitAdapter{
  constructor(){
    this.id='replit';this.label='Replit';this.description='Authenticated, explicitly configured Replit runtime bridge.';
    this.healthState={status:'offline',reason:'Not checked yet.',checkedAt:null,authState:'unknown'};
  }
  get enabled(){return process.env.SPIDER_REPLIT_ENABLED==='true';}
  get maxConcurrentTasks(){const n=Number.parseInt(process.env.SPIDER_REPLIT_MAX_CONCURRENT_TASKS||'1',10);return Number.isFinite(n)?Math.max(1,Math.min(3,n)):1;}
  async health(){
    const checkedAt=new Date().toISOString();
    if(!this.enabled)return this.healthState={status:'offline',reason:'Adapter is not enabled; set SPIDER_REPLIT_ENABLED=true.',checkedAt,authState:'unknown'};
    const url=bridgeUrl();
    if(!url)return this.healthState={status:'offline',reason:'SPIDER_REPLIT_BRIDGE_URL must be an HTTPS URL (HTTP is allowed only for localhost).',checkedAt,authState:'missing'};
    if(!process.env.SPIDER_REPLIT_BRIDGE_TOKEN)return this.healthState={status:'offline',reason:'SPIDER_REPLIT_BRIDGE_TOKEN is required to authenticate the bridge.',checkedAt,authState:'missing'};
    try{
      const result=await callBridge(url+'/health',{timeoutMs:5000});
      if(result?.ok===false||result?.ready===false)throw new Error('Bridge reports not ready.');
      return this.healthState={status:'ready',reason:null,checkedAt,authState:process.env.SPIDER_REPLIT_BRIDGE_TOKEN?'configured':'not-configured'};
    }catch(error){
      return this.healthState={status:'offline',reason:redactSecrets(error.message||'Bridge health check failed.').slice(0,300),checkedAt,authState:'unknown'};
    }
  }
  async runTask(work){
    const url=bridgeUrl();
    if(!url)throw new Error('Replit bridge URL is missing or unsafe.');
    const timeoutMs=Math.max(10000,Math.min(900000,Number.parseInt(process.env.SPIDER_REPLIT_TIMEOUT_MS||'300000',10)||300000));
    const result=await callBridge(url+'/execute',{
      method:'POST',timeoutMs,
      body:{task:{id:work.stepId,planId:work.planId,key:work.key,title:work.title,description:work.description,objective:work.planObjective,attempt:work.attempt,maxAttempts:work.maxAttempts,dependsOn:work.dependsOn||[]},prompt:cliPrompt(work)}
    });
    const summary=redactSecrets(boundedText(result?.summary||result?.output||result?.message,5000));
    if(!summary)throw new Error('Replit bridge response must include a non-empty summary or output.');
    const evidence=Array.isArray(result.evidence)?result.evidence.filter(x=>typeof x==='string').slice(0,20).map(x=>redactSecrets(boundedText(x,500))):[];
    evidence.unshift('provider:replit-bridge');
    return {summary,evidence,success:result.success!==false,providerStatus:'ready'};
  }
}
