import {createAntigravityAdapter} from './antigravity.js';
import {createCodexAdapter} from './codex.js';
import {createCopilotAdapter} from './copilot.js';
import {createKiroAdapter} from './kiro.js';
import {ManusAdapter} from './manus.js';
import {ReplitAdapter} from './replit.js';

export function createProviderAdapters(){
  return [
    createAntigravityAdapter(),
    createCodexAdapter(),
    createCopilotAdapter(),
    createKiroAdapter(),
    new ManusAdapter(),
    new ReplitAdapter()
  ];
}
