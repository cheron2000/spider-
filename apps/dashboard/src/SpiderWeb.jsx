import React from 'react';
import { Network, CircleDot } from 'lucide-react';

const DEFAULT_AGENTS = [
  { id: 'antigravity', label: 'Antigravity', role: 'Builder' },
  { id: 'codex', label: 'Codex', role: 'Engineer' },
  { id: 'copilot', label: 'Copilot', role: 'Pair programmer' },
  { id: 'kiro', label: 'Kiro', role: 'Spec & implementation' },
  { id: 'manus', label: 'Manus', role: 'Research & execution' },
  { id: 'replit', label: 'Replit', role: 'App builder' },
];

const POSITIONS = [
  { x: 250, y: 42 },
  { x: 382, y: 112 },
  { x: 382, y: 262 },
  { x: 250, y: 332 },
  { x: 118, y: 262 },
  { x: 118, y: 112 },
];

export default function SpiderWeb({ agents = [] }) {
  const list = DEFAULT_AGENTS.map((fallback) => {
    const actual = agents.find((a) =>
      String(a.id || '').toLowerCase().includes(fallback.id) ||
      String(a.name || '').toLowerCase().includes(fallback.id)
    );
    return { ...fallback, runtimeName: actual?.name, status: actual?.status || 'not connected' };
  });
  const edges = [];
  // A six-node ring where each provider connects to its two nearest peers in both directions.
  // Deduplicate undirected edges; every node has exactly four lateral neighbors.
  for (let i = 0; i < list.length; i += 1) {
    for (const offset of [1, 2]) {
      const j = (i + offset) % list.length;
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      if (!edges.some(([x, y]) => x === a && y === b)) edges.push([a, b]);
    }
  }
  return (
    <section className="panel spider-panel">
      <div className="panel-head">
        <div>
          <h2><Network size={16}/> Spider-web collaboration</h2>
          <p>Six provider slots · each node has four lateral peer connections.</p>
        </div>
        <span className="spider-status"><CircleDot size={12}/> Topology blueprint</span>
      </div>
      <div className="spider-canvas">
        <svg className="spider-svg" viewBox="0 0 500 375" role="img" aria-label="Six-agent spider-web graph with four peer links per agent">
          <defs>
            <radialGradient id="webGlow"><stop offset="0%" stopColor="#294b7a" stopOpacity=".5"/><stop offset="100%" stopColor="#0d1626" stopOpacity="0"/></radialGradient>
          </defs>
          <ellipse cx="250" cy="187" rx="215" ry="175" fill="url(#webGlow)" />
          {edges.map(([a, b]) => (
            <line key={a + '-' + b} x1={POSITIONS[a].x} y1={POSITIONS[a].y} x2={POSITIONS[b].x} y2={POSITIONS[b].y} className="spider-edge" />
          ))}
          {POSITIONS.map((p, i) => (
            <g key={list[i].id} transform={'translate(' + p.x + ' ' + p.y + ')'}>
              <circle r="35" className="spider-node-halo" />
              <circle r="29" className="spider-node" />
              <text y="-2" className="spider-node-label">{list[i].label}</text>
              <text y="12" className="spider-node-role">{list[i].role}</text>
              <circle cx="22" cy="-21" r="4" className={list[i].runtimeName ? 'spider-dot connected' : 'spider-dot'} />
            </g>
          ))}
          <circle cx="250" cy="187" r="44" className="spider-core" />
          <text x="250" y="182" textAnchor="middle" className="spider-core-title">SPIDER</text>
          <text x="250" y="198" textAnchor="middle" className="spider-core-subtitle">COORDINATOR</text>
        </svg>
      </div>
      <div className="spider-legend">
        <span><i className="spider-legend-dot connected"/> Registered by API</span>
        <span><i className="spider-legend-dot"/> Planned / adapter not connected</span>
      </div>
      <div className="spider-note">The four peer links describe the intended collaboration graph. Provider integrations and live agent-to-agent messaging must be configured before these links represent active sessions.</div>
    </section>
  );
}
