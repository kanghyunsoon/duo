// Which caller spends the native `open` time in the profiled first installed run.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const r = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../results/local/first-run.json', import.meta.url)), 'utf8'));
const prof = JSON.parse(fs.readFileSync(r.profile[0], 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const by = new Map();
for (let i = 0; i < prof.samples.length; i++) {
  const n = byId.get(prof.samples[i]);
  if (n.callFrame.functionName !== 'open') continue;
  const chain = [];
  for (let id = parent.get(n.id); id !== undefined && chain.length < 6; id = parent.get(id)) {
    const f = byId.get(id).callFrame;
    chain.push(`${f.functionName || '(anon)'}@${(f.url || '').replace(/^.*node_modules[\\/]/, 'nm/').replace(/^.*@duo-director[\\/]cli[\\/]/, 'cli/')}`);
  }
  const key = chain.join(' < ');
  by.set(key, (by.get(key) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
}
for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(String(Math.round(v)).padStart(7), 'ms', k);
