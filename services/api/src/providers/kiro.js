import {CommandProviderAdapter} from './base.js';

export function createKiroAdapter(){
  return new CommandProviderAdapter({
    id:'kiro',
    label:'Kiro',
    description:'Kiro CLI chat in non-interactive mode; tool permissions remain provider-controlled.',
    commandDefault:'kiro-cli',
    argsFor:prompt=>['chat','--no-interactive',prompt]
  });
}
