const fetch = globalThis.fetch;
const KEY = 'uoYIDt8UmbcOJaW2M745fhNB90LqAFVskprnKGXxPgl6v31w';
const headers = { 'Content-Type': 'application/json', 'x-spider-coordinator-key': KEY };

async function monitorTask() {
  console.log('================================================================');
  console.log('   SPIDER LIVE AGENT WORKFLOW & TASK MONITORING TEST');
  console.log('================================================================\n');

  console.log('[1/4] Submitting New Autonomous Task Plan to Spider Coordinator...');
  const objective = 'Develop a resilient event-driven Notification Dispatch Engine in Python with exponential backoff retry, dead-letter queue handling, unit tests, and metrics';
  
  const createRes = await fetch('http://localhost:4000/api/coordinator/plans/draft', {
    method: 'POST',
    headers,
    body: JSON.stringify({ objective })
  });
  
  if (!createRes.ok) {
    console.error('Failed to create plan:', await createRes.text());
    return;
  }
  
  const created = await createRes.json();
  const planId = created.plan.id;
  console.log(`Plan Created: [${planId}]`);
  console.log(`Objective: "${objective}"`);
  console.log(`Initial Step Assignments:`, created.assigned);
  
  console.log('\n[2/4] Live Monitoring Step Transitions across 7-Step DAG:');
  console.log('----------------------------------------------------------------');
  const startTime = Date.now();
  const lastState = {};

  while (Date.now() - startTime < 60000) {
    const planRes = await fetch('http://localhost:4000/api/coordinator/plans/' + planId, { headers });
    const { plan } = await planRes.json();
    
    for (const step of plan.steps) {
      const stateKey = `${step.status}|${step.assignedAgentName || ''}|${step.attempts}|${Boolean(step.resultSummary)}`;
      if (lastState[step.key] !== stateKey) {
        lastState[step.key] = stateKey;
        const icon = step.status === 'done' ? '✅' : step.status === 'in_progress' ? '⚙️ ' : step.status === 'assigned' ? '📥' : step.status === 'ready' ? '⏳' : step.status === 'failed' ? '❌' : '🔒';
        console.log(`${icon} [${step.key.padEnd(16)}] Status: ${step.status.padEnd(12)} | Worker: ${(step.assignedAgentName || 'unassigned').padEnd(10)} | Attempt: ${step.attempts}`);
        
        if (step.resultSummary && (step.status === 'done' || step.status === 'review')) {
          const firstLine = step.resultSummary.split('\n')[0];
          console.log(`   📝 Output: ${firstLine}`);
          const nonProvEvidence = (step.evidence || []).filter(e => !e.startsWith('provider-provenance-json:'));
          console.log(`   🔎 Evidence: ${JSON.stringify(nonProvEvidence)}`);
        }
      }
    }
    
    if (plan.status === 'completed' || plan.status === 'failed') {
      console.log('----------------------------------------------------------------');
      console.log(`🏁 Plan Finished with Status: [${plan.status.toUpperCase()}] in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      break;
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n[3/4] Querying Provenance & SQLite Execution Journal...');
  const journalRes = await fetch('http://localhost:4000/api/coordinator/execution-journal?planId=' + planId + '&limit=50', { headers });
  const journal = await journalRes.json();
  console.log(`Total coordination lifecycle events logged: ${journal.total}`);
  journal.events.slice(-6).forEach(e => {
    console.log(`   • [${e.occurredAt.slice(11, 19)}] ${e.eventType} (step: ${e.stepId || 'plan'}, agent: ${e.agentId || 'system'})`);
  });

  console.log('\n[4/4] Verifying Workspace Output Artifacts in "workspaces/replit"...');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const wsDir = path.resolve('workspaces/replit');
  if (fs.existsSync(wsDir)) {
    const files = fs.readdirSync(wsDir).filter(f => f.endsWith('.json')).slice(-7);
    console.log(`Found ${files.length} recent task artifacts:`);
    for (const f of files) {
      const stats = fs.statSync(path.join(wsDir, f));
      console.log(`   📁 ${f} (${stats.size} bytes, modified ${stats.mtime.toLocaleTimeString()})`);
    }
  }
}

monitorTask().catch(console.error);
