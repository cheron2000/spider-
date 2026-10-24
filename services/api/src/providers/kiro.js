import {CommandProviderAdapter} from './base.js';

export function createKiroAdapter(){
  return new CommandProviderAdapter({
    id:'kiro',
    label:'Kiro',
    description:'Kiro CLI chat in non-interactive mode; tool permissions remain provider-controlled.',
    commandDefault:'F:\\\\Kiro\\\\bin\\\\kiro.cmd',
    argsFor:prompt=>['chat',prompt]
  });
}
