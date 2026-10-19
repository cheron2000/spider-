import {CommandProviderAdapter} from './base.js';

export function createCopilotAdapter(){
  return new CommandProviderAdapter({
    id:'copilot',
    label:'Copilot',
    description:'GitHub Copilot CLI in non-interactive prompt mode.',
    commandDefault:'copilot',
    argsFor:prompt=>['-p',prompt,'--output-format','json','--no-ask-user']
  });
}
