import {CommandProviderAdapter} from './base.js';

export function createCodexAdapter(){
  return new CommandProviderAdapter({
    id:'codex',
    label:'Codex',
    description:'OpenAI Codex CLI in bounded exec mode.',
    commandDefault:'codex',
    argsFor:prompt=>{
      const configured=process.env.SPIDER_CODEX_SANDBOX;
      const sandbox=configured==='workspace-write'?'workspace-write':'read-only';
      return ['exec','--sandbox',sandbox,'--json',prompt];
    }
  });
}
