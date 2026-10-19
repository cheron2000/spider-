import {CommandProviderAdapter} from './base.js';

export function createAntigravityAdapter(){
  return new CommandProviderAdapter({
    id:'antigravity',
    label:'Antigravity',
    description:'Local Antigravity CLI in headless print mode.',
    commandDefault:'agy',
    argsFor:prompt=>['-p',prompt,'--output-format','json','--sandbox']
  });
}
