import { runProcess, extractCliText } from './services/api/src/providers/base.js';

async function test() {
  console.log('Testing Copilot adapter execution in workspaces/copilot...');
  const res = await runProcess('copilot', ['-p', 'Respond with: Copilot is fully ready and tested for Spider', '--output-format', 'json', '--no-ask-user'], {
    cwd: 'F:\\Shreyash DOC\\shreyash\\Spyder\\workspaces\\copilot',
    env: process.env
  });
  console.log('Exit Code:', res.exitCode);
  console.log('Extracted Completion Summary:\n', extractCliText(res.stdout));
}

test().catch(console.error);
