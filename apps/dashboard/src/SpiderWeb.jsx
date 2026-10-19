import React, { useMemo } from 'react';
import { Network, CircleDot } from 'lucide-react';

const PROVIDERS = [
  { id: 'antigravity', label: 'Antigravity', role: 'Builder' },
  { id: 'codex', label: 'Codex', role: 'Engineer' },
  { id: 'copilot', label: 'Copilot', role: 'Pair programmer' },
  { id: 'kiro', label: 'Kiro', role: 'Spec & implementation' },
  { id: 'manus', label: 'Manus', role: 'Research & execution' },
  { id: 'replit', label: 'Replit', role: 'App builder' },
];

const CORE = { x: 350, y: 260 };
const BASE_RADIUS = 166;
const EXTRA_RADIUS = 228;

function anglePosition(index, count, radius, center = CORE) {
  const angle = (-Math.PI / 2) + (index * 2 * Math.PI / count);
  return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
}

function providerMatch(agent, provider) {
  const identity = (String(agent?.id || '') + ' ' + String(agent?.name || '')).toLowerCase();
  return provider.id === 'copilot'
    ? identity.includes('copilot')
    : identity.includes(provider.id);
}

export default function SpiderWeb({ agents = [] }) {
  const { nodes, edges } = useMemo(() => {
    const registered = [...agents].sort((a, b) =>
      (Number(a.slotIndex ?? 9999) - Number(b.slotIndex ?? 9999)) ||
      String(a.id).localeCompare(String(b.id))
    );
    const used = new Set();
    const primary = PROVIDERS.map((provider, slotIndex) => {
      let agent = registered.find(a => Number(a.slotIndex) === slotIndex);
      if (!agent) agent = registered.find(a => !used.has(a.id) && providerMatch(a, provider));
      if (agent) used.add(agent.id);
      return {
        id: provider.id,
        label: agent?.name || provider.label,
        role: agent ? (agent.runtime === 'remote' ? 'Remote agent' : 'Local agent') : provider.role,
        status: agent?.status || 'not connected',
        registered: Boolean(agent),
        slotIndex,
        position: anglePosition(slotIndex, PROVIDERS.length, BASE_RADIUS),
      };
    });
    const extraAgents = registered.filter(agent => !used.has(agent.id));
    const extras = extraAgents.map((agent, index) => {
      const slotIndex = Number.isInteger(agent.slotIndex) && agent.slotIndex >= PROVIDERS.length
        ? agent.slotIndex
        : PROVIDERS.length + index;
      return {
        id: 'agent-' + agent.id,
        label: agent.name || agent.id,
        role: agent.runtime === 'remote' ? 'Remote agent' : 'Local agent',
        status: agent.status || 'available',
        registered: true,
        slotIndex,
        position: anglePosition(index, Math.max(1, extraAgents.length), EXTRA_RADIUS),
      };
    });
    const all = [...primary, ...extras];
    const links = [];
    // The six primary provider slots always form the planned web. Extra registered agents
    // join the ring; every ring member receives four lateral links when the ring has >= 5 nodes.
    if (all.length >= 5) {
      for (let i = 0; i < all.length; i += 1) {
        for (const offset of [1, 2]) {
          const j = (i + offset) % all.length;
          const a = Math.min(i, j);
          const b = Math.max(i, j);
          if (!links.some(([x, y]) => x === a && y === b)) links.push([a, b]);
        }
      }
    }
    return { nodes: all, edges: links };
  }, [agents]);

  return (
    <section className="panel spider-panel">
      <div className="panel-head">
        <div>
          <h2><Network size={16}/> Spider-web collaboration</h2>
          <p>Each registered agent receives a stable slot and four lateral peer links.</p>
        </div>
        <span className="spider-status"><CircleDot size={12}/> {agents.length} registered</span>
      </div>
      <div className="spider-canvas">
        <svg className="spider-svg" viewBox="0 0 700 520" role="img" aria-label="Spider coordinator connected to six provider slots and registered agent positions">
          <defs>
            <radialGradient id="webGlow"><stop offset="0%" stopColor="#294b7a" stopOpacity=".5"/><stop offset="100%" stopColor="#0d1626" stopOpacity="0"/></radialGradient>
          </defs>
          <ellipse cx={CORE.x} cy={CORE.y} rx="300" ry="240" fill="url(#webGlow)" />
          {edges.map(([a, b]) => (
            <line key={nodes[a].id + '-' + nodes[b].id}
              x1={nodes[a].position.x} y1={nodes[a].position.y}
              x2={nodes[b].position.x} y2={nodes[b].position.y}
              className="spider-edge" />
          ))}
          {nodes.map(node => (
            <g key={node.id} transform={'translate(' + node.position.x + ' ' + node.position.y + ')'}>
              <circle r="36" className="spider-node-halo" />
              <circle r="29" className="spider-node" />
              <text y="-2" className="spider-node-label">{node.label.length > 15 ? node.label.slice(0, 13) + '…' : node.label}</text>
              <text y="12" className="spider-node-role">{node.role.length > 19 ? node.role.slice(0, 17) + '…' : node.role}</text>
              <circle cx="22" cy="-21" r="4" className={node.registered ? 'spider-dot connected' : 'spider-dot'} />
              <title>{node.label} · slot {node.slotIndex + 1} · {node.status}</title>
            </g>
          ))}
          <circle cx={CORE.x} cy={CORE.y} r="44" className="spider-core" />
          <text x={CORE.x} y={CORE.y - 5} textAnchor="middle" className="spider-core-title">SPIDER</text>
          <text x={CORE.x} y={CORE.y + 11} textAnchor="middle" className="spider-core-subtitle">COORDINATOR</text>
        </svg>
      </div>
      <div className="spider-legend">
        <span><i className="spider-legend-dot connected"/> Registered agent occupies slot</span>
        <span><i className="spider-legend-dot"/> Available provider slot</span>
      </div>
      <div className="spider-note">Known providers map to their named slots. Other agents receive the next available stable slot. Slot assignments persist in the API's SQLite registry across restarts; agents appear offline until they reconnect.</div>
    </section>
  );
}
