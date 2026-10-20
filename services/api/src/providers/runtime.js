import path from 'node:path';
import {redactSecrets} from './base.js';

export class ProviderRuntimeManager {
  constructor(adapters,{onStateChange=()=>{},pollIntervalMs=30000}={}) {
    this.adapters=new Map(adapters.map(adapter=>[adapter.id,adapter]));
    this.onStateChange=onStateChange;
    this.pollIntervalMs=pollIntervalMs;
    this.inFlight=new Map();
    this.probing=new Set();
    this.timer=null;
    this.stopped=false;
  }

  adapter(id){return this.adapters.get(id)||null;}
  activeCount(id){return this.inFlight.get(id)||0;}

  workspaceConflict(id){
    const adapter=this.adapter(id);
    if(!adapter||adapter.enabled!==true||typeof adapter.workspace!=='string'||!adapter.workspace.trim())return null;
    const target=normalizeWorkspacePath(adapter.healthState?.workspaceCanonicalPath||path.resolve(adapter.workspace));
    for(const other of this.adapters.values()){
      if(other.id===id||other.enabled!==true||typeof other.workspace!=='string'||!other.workspace.trim())continue;
      const otherPath=normalizeWorkspacePath(other.healthState?.workspaceCanonicalPath||path.resolve(other.workspace));
      if(target===otherPath){
        return 'Configured workspace is shared with enabled provider '+other.label+'; assign each provider a separate workspace directory.';
      }
    }
    return null;
  }

  canAcceptWork(id){
    const adapter=this.adapter(id);
    return Boolean(adapter&&!this.workspaceConflict(id)&&adapter.healthState?.status==='ready'&&this.activeCount(id)<adapter.maxConcurrentTasks);
  }

  snapshot(id){
    const adapter=this.adapter(id);
    if(!adapter)return null;
    const active=this.activeCount(id),capacity=adapter.maxConcurrentTasks;
    const health=adapter.healthState||{};
    const conflict=this.workspaceConflict(id);
    const status=conflict?'offline':health.status==='ready'&&active>=capacity?'busy':health.status||'offline';
    return {
      id:adapter.id,label:adapter.label,description:adapter.description,
      status,reason:conflict||health.reason||null,checkedAt:health.checkedAt||null,
      authState:health.authState||'unknown',workspaceConfigured:Boolean(health.workspaceConfigured),
      activeTasks:active,maxConcurrentTasks:capacity
    };
  }

  list(){return [...this.adapters.keys()].map(id=>this.snapshot(id));}

  async refresh(id,{reset=false}={}){
    const adapter=this.adapter(id);
    if(!adapter||this.probing.has(id))return this.snapshot(id);
    this.probing.add(id);
    try{
      if(reset&&typeof adapter.reset==='function')await adapter.reset();
      else await adapter.health();
      this.onStateChange(this.snapshot(id));
      return this.snapshot(id);
    }catch(error){
      adapter.healthState={
        status:'offline',
        reason:redactSecrets(error?.message||'Provider health check failed.').slice(0,300),
        checkedAt:new Date().toISOString(),
        authState:'unknown'
      };
      this.onStateChange(this.snapshot(id));
      return this.snapshot(id);
    }finally{this.probing.delete(id);}
  }

  async refreshAll(){
    return Promise.all([...this.adapters.keys()].map(id=>this.refresh(id)));
  }

  async start(){
    this.stopped=false;
    await this.refreshAll();
    if(!this.timer){
      this.timer=setInterval(()=>{if(!this.stopped)this.refreshAll().catch(()=>{});},this.pollIntervalMs);
      this.timer.unref?.();
    }
    return this.list();
  }

  stop(){
    this.stopped=true;
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
  }

  async dispatch(id,work){
    const adapter=this.adapter(id);
    if(!adapter)throw new Error('No provider adapter is registered for this agent.');
    const workspaceConflict=this.workspaceConflict(id);
    if(workspaceConflict)throw new Error(workspaceConflict);
    const active=this.activeCount(id);
    if(active>=adapter.maxConcurrentTasks)throw new Error('Provider runtime concurrency limit reached.');
    this.inFlight.set(id,active+1);
    this.onStateChange(this.snapshot(id));
    try{
      const health=await adapter.health();
      this.onStateChange(this.snapshot(id));
      if(health.status!=='ready')throw new Error(health.reason||'Provider runtime is offline.');
      const result=await adapter.runTask(work);
      if(!result||typeof result.summary!=='string'||!result.summary.trim())throw new Error('Provider returned an empty or invalid completion report.');
      return {
        summary:redactSecrets(result.summary).slice(0,5000),
        evidence:Array.isArray(result.evidence)?result.evidence.filter(item=>typeof item==='string').slice(0,30).map(item=>redactSecrets(item).slice(0,500)):[],
        success:result.success!==false
      };
    }catch(error){
      // Failure to invoke a configured runtime takes it offline until the next health probe.
      const previousHealth=adapter.healthState||{};
      const authenticationFailed=previousHealth.authState==='failed';
      adapter.healthState={
        status:'offline',
        reason:authenticationFailed
          ? redactSecrets(previousHealth.reason||'Provider authentication failed.').slice(0,300)
          : redactSecrets(error?.message||'Provider runtime invocation failed.').slice(0,300),
        checkedAt:new Date().toISOString(),
        authState:authenticationFailed?'failed':'unknown'
      };
      throw new Error(adapter.healthState.reason);
    }finally{
      const count=this.activeCount(id);
      if(count<=1)this.inFlight.delete(id);else this.inFlight.set(id,count-1);
      this.onStateChange(this.snapshot(id));
    }
  }
}

function normalizeWorkspacePath(value){
  const normalized=path.normalize(path.resolve(value));
  return process.platform==='win32'?normalized.toLocaleLowerCase('en-US'):normalized;
}
