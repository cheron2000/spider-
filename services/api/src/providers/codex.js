import {CommandProviderAdapter} from './base.js';

export function createCodexAdapter(){
  return new CommandProviderAdapter({
    id:'codex',
    label:'Codex',
    description:'OpenAI Codex CLI in bounded exec mode.',
    commandDefault:'codex',
    argsFor:prompt=>{
      const sandbox=process.env.SPIDER_CODEX_SANDBOX==='read-only'?'read-only':'workspace-write';
      return ['exec','--sandbox',sandbox,'--json',prompt];
    }
  });
}
