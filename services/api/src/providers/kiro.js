import {CommandProviderAdapter} from './base.js';

export function createKiroAdapter(){
  return new CommandProviderAdapter({
    id:'kiro',
    label:'Kiro',
    description:'Kiro CLI chat in agent mode; tool permissions remain provider-controlled.',
    commandDefault:process.platform==='win32'?'kiro':'kiro-cli',
    argsFor:prompt=>['chat',prompt]
  });
}
