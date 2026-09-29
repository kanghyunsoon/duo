// Summarizes bench/results/local/first-run.json and its CPU profile: where the first installed run spends time.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../results/local/first-run.json', import.meta.url)), 'utf8'));
const round = (x) => (x === undefined ? null : Math.round(x));
const rows = [];
for (const [i, rd] of r.rounds.entries()) for (const s of ['A', 'B', 'D']) rd[s].runs.forEach((x, n) => rows.push({ round: i + 1, scenario: s, run: n + 1, wall: round(x.wallMs), bootstrap: round(x.bootstrapMs), inProcess: round(x.exitMs - x.bootstrapMs), outside: round(x.outsideProcessMs) }));
console.log(JSON.stringify({ emptyNode: r.emptyNodeMs.map(round), installs: r.rounds.map((rd) => ['A', 'B', 'D'].map((s) => round(rd[s].installMs))), prewarm: r.rounds.map((rd) => ({ ms: round(rd.D.prewarm.ms), files: rd.D.prewarm.files, mb: +(rd.D.prewarm.bytes / 1048576).toFixed(1) })) }));
for (const x of rows) console.log(JSON.stringify(x));
const p = r.profiled;
console.log('profiled', JSON.stringify({ wall: round(p.wallMs), bootstrap: round(p.bootstrapMs), inProcess: round(p.exitMs - p.bootstrapMs), outside: round(p.outsideProcessMs) }));
const prof = JSON.parse(fs.readFileSync(r.profile[0], 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const cat = (url, fn) => {
  if (fn === '(idle)') return 'idle (waiting: I/O, child processes)';
  if (fn === '(garbage collector)') return 'gc';
  if (/node_modules[\\/](?:\.pnpm[\\/])?.*?(typescript)[\\/]/.test(url)) return 'module: typescript';
  if (/node_modules[\\/]/.test(url)) return 'module: other npm dependencies';
  if (/@duo-director[\\/]cli[\\/]dist/.test(url)) return 'DUO bundle';
  if (url.startsWith('node:') || url === '') return fn === '(program)' ? 'program (native)' : 'node internals / native (' + fn + ')';
  return 'other';
};
const self = new Map();
for (let i = 0; i < prof.samples.length; i++) {
  const n = byId.get(prof.samples[i]);
  const key = cat(n.callFrame.url, n.callFrame.functionName);
  self.set(key, (self.get(key) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
}
console.log('profile span', round((prof.endTime - prof.startTime) / 1000), 'ms');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String(round(v)).padStart(7), 'ms', k);
// Inclusive time of DUO phases by function name found on the stack.
const phases = ['loadProjectTruth', 'scanRepository', 'fingerprintRepositoryFiles', 'createDefaultAnalyzerRegistry', 'openNodeSqliteGraphStore', 'inspectIndex', 'openGitProvider', 'getAdoptionBaselineStatus', 'projectStatus'];
const inclusive = Object.fromEntries(phases.map((p) => [p, 0]));
for (let i = 0; i < prof.samples.length; i++) {
  const seen = new Set();
  for (let id = prof.samples[i]; id !== undefined; id = parent.get(id)) {
    const fn = byId.get(id).callFrame.functionName;
    if (fn in inclusive && !seen.has(fn)) { inclusive[fn] += (prof.timeDeltas[i] ?? 0) / 1000; seen.add(fn); }
  }
}
console.log('inclusive CPU on stack (async waits excluded):', JSON.stringify(Object.fromEntries(Object.entries(inclusive).map(([k, v]) => [k, round(v)]))));
