import {access,stat} from 'node:fs/promises';
import spawn from 'cross-spawn';
import path from 'node:path';

const SAFE_ENV = [
  'PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SYSTEMROOT','WINDIR',
  'TMP','TEMP','TMPDIR','TERM','LANG','LC_ALL','SHELL'
];

export function envPrefix(providerId) {
  return 'SPIDER_'+providerId.replace(/-/g,'_').toUpperCase();
}

export function boundedText(value, limit=5000) {
  return String(value ?? '').replace(/\u0000/g,'').trim().slice(0,limit);
}

export function redactSecrets(value) {
  return boundedText(value, 5000)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{10,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

export function boundedTimeout(value,fallback=300000){
  const parsed=Number.parseInt(String(value??''),10);
  return Number.isFinite(parsed)?Math.max(10000,Math.min(900000,parsed)):fallback;
}

export function safeChildEnv(passthrough='') {
  const allowed = new Set([...SAFE_ENV, ...String(passthrough).split(',').map(x=>x.trim()).filter(x=>/^[A-Z_][A-Z0-9_]*$/i.test(x))]);
  const result = {};
  for (const key of allowed) if (process.env[key] !== undefined) result[key] = process.env[key];
  return result;
}

export function cliPrompt(work) {
  return [
    'You are executing one assigned work item inside Spider.',
    'Do not commit, push, merge, deploy, publish, or change repository remotes.',
    'Do not bypass tool permissions or access secrets outside the assigned workspace.',
    'Do not perform destructive operations unrelated to the task.',
    'Work only in the current working directory/workspace. Keep changes focused.',
    'Do not claim checks passed unless you actually ran them and saw the result.',
    '',
    'Project objective:',
    boundedText(work.planObjective, 5000),
    '',
    'Work item:',
    boundedText(work.title, 300),
    '',
    'Instructions:',
    boundedText(work.description, 8000),
    '',
    'Step key: '+boundedText(work.key, 100),
    'Attempt: '+Number(work.attempt||1)+' of '+Number(work.maxAttempts||1),
    'Dependencies already accepted by the coordinator: '+(Array.isArray(work.dependsOn)?work.dependsOn.join(', '):'none'),
    '',
    'Return a concise completion report with: outcome, important files/artifacts, decisions, commands/checks actually executed, and unresolved blockers.'
  ].join('\n');
}

export function extractCliText(stdout) {
  const raw = boundedText(stdout, 50000);
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item?.type === 'item.completed' && item?.item?.type === 'agent_message' && item.item.text) records.push(item.item.text);
      else if (item?.type === 'workflow.result' && item?.data?.run?.result) records.push(typeof item.data.run.result === 'string' ? item.data.run.result : JSON.stringify(item.data.run.result));
      else if (item?.type === 'result' && item?.result) records.push(typeof item.result === 'string' ? item.result : JSON.stringify(item.result));
      else if (item?.type === 'assistant' && typeof item?.content === 'string') records.push(item.content);
      else if (item?.response && typeof item.response === 'string') records.push(item.response);
    } catch {
      // Plain-text CLIs and mixed diagnostic output are retained as-is below.
    }
  }
  const normalized = records.length ? records.join('\n\n') : raw;
  return redactSecrets(normalized).slice(-5000);
}

export function runProcess(command, args, options={}) {
  const {
    cwd, env={}, timeoutMs=300000, maxOutputChars=50000
  } = options;
  return new Promise((resolve,reject)=>{
    let child;
    try {
      child = spawn(command, args, {cwd, env, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe']});
    } catch (error) {
      reject(new Error('Could not start provider CLI: '+(error?.code||'spawn error')));
      return;
    }
    let stdout='',stderr='',settled=false,timedOut=false;
    const append = (current,chunk) => (current+chunk.toString()).slice(-maxOutputChars);
    const timer=setTimeout(()=>{
      timedOut=true;
      child.kill('SIGTERM');
      setTimeout(()=>{ if(child.exitCode===null) child.kill('SIGKILL'); },1500).unref?.();
    },timeoutMs);
    const finish=(error,result)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(error)reject(error);else resolve(result);
    };
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk);});
    child.stderr.on('data',chunk=>{stderr=append(stderr,chunk);});
    child.on('error',error=>{
      if(error?.code==='ENOENT')finish(new Error('Provider CLI executable is not installed or is not on PATH.'));
      else finish(new Error('Provider CLI could not start: '+(error?.code||'spawn error')));
    });
    child.on('close',(code,signal)=>{
      if(timedOut){finish(new Error('Provider CLI timed out and was terminated.'));return;}
      const normalizedStdout=redactSecrets(stdout);
      const normalizedStderr=redactSecrets(stderr);
      finish(null,{
        exitCode:Number.isInteger(code)?code:null,
        signal:signal||null,
        stdout:normalizedStdout,
        stderr:normalizedStderr
      });
    });
  });
}

export async function inspectWorkspace(workspace) {
  if (!workspace) return {ok:false,reason:'A dedicated SPIDER_<PROVIDER>_WORKSPACE path is required.'};
  const resolved=path.resolve(workspace);
  try {
    await access(resolved);
    const info=await stat(resolved);
    if(!info.isDirectory())return {ok:false,reason:'Configured workspace path is not a directory.'};
    return {ok:true,path:resolved};
  } catch {
    return {ok:false,reason:'Configured workspace directory does not exist or is not accessible.'};
  }
}

export async function probeExecutable(command, env) {
  return new Promise(resolve=>{
    let child,finished=false;
    const done=result=>{if(finished)return;finished=true;clearTimeout(timer);resolve(result);};
    let timer;
    try {
      child=spawn(command,['--version'],{shell:false,windowsHide:true,stdio:'ignore',env});
    } catch {
      resolve({ok:false,reason:'Could not start the configured executable.'});
      return;
    }
    timer=setTimeout(()=>{
      // A process that starts but does not implement --version is still installed.
      child.kill('SIGTERM');done({ok:true,reason:'Executable launched; version probe timed out.'});
    },2500);
    child.once('error',error=>{
      done({ok:false,reason:error?.code==='ENOENT'?'CLI executable not found on PATH.':'CLI executable failed to start.'});
    });
    child.once('close',()=>done({ok:true,reason:null}));
  });
}

const AUTH_FAILURE = /(authentication required|not authenticated|not logged in|please log in|please login|invalid api key|invalid token|token expired|credentials missing|sign[- ]?in required|unauthenticated|authorization failed|no active session)/i;

export class CommandProviderAdapter {
  constructor({id,label,commandDefault,argsFor,workspaceEnv,enabledEnv,commandEnv,timeoutEnv,passthroughEnv,description}) {
    this.id=id;this.label=label;this.description=description||'';
    this.prefix=envPrefix(id);
    this.enabledEnv=enabledEnv||this.prefix+'_ENABLED';
    this.commandEnv=commandEnv||this.prefix+'_COMMAND';
    this.workspaceEnv=workspaceEnv||this.prefix+'_WORKSPACE';
    this.timeoutEnv=timeoutEnv||this.prefix+'_TIMEOUT_MS';
    this.passthroughEnv=passthroughEnv||this.prefix+'_PASSTHROUGH_ENV';
    this.commandDefault=commandDefault;
    this.argsFor=argsFor;
    this.authenticationBlocked=false;
    this.healthState={status:'offline',reason:'Not checked yet.',checkedAt:null,authState:'unknown'};
  }
  get enabled(){return process.env[this.enabledEnv]==='true';}
  get command(){return (process.env[this.commandEnv]||this.commandDefault).trim();}
  get workspace(){return process.env[this.workspaceEnv]||'';}
  // One CLI adapter maps to one workspace; never run concurrent writes in it.
  get maxConcurrentTasks(){return 1;}
  childEnv(){return safeChildEnv(process.env[this.passthroughEnv]||'');}
  async reset(){this.authenticationBlocked=false;return this.health();}
  async health(){
    const checkedAt=new Date().toISOString();
    if(this.authenticationBlocked)return this.healthState={status:'offline',reason:'Provider authentication failed. Sign in with the native CLI, then explicitly refresh this adapter.',checkedAt,authState:'failed'};
    if(!this.enabled)return this.healthState={status:'offline',reason:'Adapter is not enabled; set '+this.enabledEnv+'=true.',checkedAt,authState:'unknown'};
    const workspace=await inspectWorkspace(this.workspace);
    if(!workspace.ok)return this.healthState={status:'offline',reason:workspace.reason,checkedAt,authState:'unknown'};
    if(!this.command)return this.healthState={status:'offline',reason:'No CLI executable is configured.',checkedAt,authState:'unknown'};
    const executable=await probeExecutable(this.command,this.childEnv());
    if(!executable.ok)return this.healthState={status:'offline',reason:executable.reason,checkedAt,authState:'unknown'};
    return this.healthState={status:'ready',reason:null,checkedAt,authState:'not-probed',workspaceConfigured:true};
  }
  async runTask(work){
    const workspace=await inspectWorkspace(this.workspace);
    if(!workspace.ok)throw new Error('Provider workspace is no longer available. '+workspace.reason);
    const prompt=cliPrompt(work);
    const result=await runProcess(this.command,this.argsFor(prompt),{
      cwd:workspace.path,
      env:this.childEnv(),
      timeoutMs:boundedTimeout(process.env[this.timeoutEnv]),
    });
    const body=extractCliText(result.stdout);
    if(result.exitCode!==0&&AUTH_FAILURE.test(result.stderr+'\n'+result.stdout)){
      this.authenticationBlocked=true;
      this.healthState={status:'offline',reason:'Provider authentication failed. Sign in with the native CLI, then explicitly refresh this adapter.',checkedAt:new Date().toISOString(),authState:'failed'};
      throw new Error('Provider authentication failed; sign in with the native CLI, then refresh the adapter.');
    }
    const summary=body||('Provider CLI exited '+String(result.exitCode)+'. '+result.stderr).slice(0,5000);
    const evidence=['provider:'+this.id,'process-exit-code:'+String(result.exitCode)];
    if(result.signal)evidence.push('process-signal:'+result.signal);
    if(result.stderr)evidence.push('stderr-summary:'+result.stderr.slice(-350,500));
    return {summary:summary.slice(0,5000),evidence,success:result.exitCode===0,providerStatus:'ready'};
  }
}
