// Benchmark-only: top self-time functions of a V8 .cpuprofile (node --cpu-prof).
import fs from 'node:fs';
const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = prof.timeDeltas;
for (let i = 0; i < prof.samples.length; i++) {
  const n = byId.get(prof.samples[i]);
  const f = n.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${(f.url || '').replace(/^.*[\\/](node_modules|packages)[\\/]/, '$1/')}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`total ${Math.round(total)}ms`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[3] ?? 25))) console.log(`${Math.round(v).toString().padStart(6)}ms  ${k}`);
