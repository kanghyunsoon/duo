// TASK-019 correctness regression: the deterministic outputs of two benchmark runs must be equal
// (Packet dependency digests and statuses, expected-entity coverage, parse/reuse counts, Review
// verdicts, claims with provenance and Evidence IDs). Timings are reported side by side, never compared.
import fs from 'node:fs';

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) throw new Error('usage: node bench/compare.mjs <before.json> <after.json>');
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
const deterministic = (r) => Object.fromEntries(Object.entries(r.fixtures).map(([name, f]) => [name, {
  coverage: f.coverage.files,
  initialParsed: f.index.initial.metrics.files.analyzed,
  noopParsed: f.index.noopCold.metrics.files.analyzed,
  single: Object.fromEntries(Object.entries(f.index.single ?? {}).map(([k, m]) => [k, [m.files.analyzed, m.graph.scopesChanged]])),
  context: Object.fromEntries(Object.entries(f.context).map(([k, c]) => [k, { status: c.status, digest: c.digest, seeds: c.seeds, candidates: c.candidates, packet: c.tokens?.packet, missing: c.quality.missing }])),
  review: f.review.scenarios === undefined ? undefined : Object.fromEntries(Object.entries(f.review.scenarios).map(([k, v]) => [k, { verdict: v.verdict, claims: v.claims, evidenceIds: v.evidenceIds }])),
  cleanVerdict: f.review.clean.verdict,
}]));
const a = deterministic(before);
const b = deterministic(after);
const diffs = [];
for (const name of Object.keys(a)) if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) diffs.push(name);
if (diffs.length) {
  console.error(JSON.stringify({ changed: diffs, before: Object.fromEntries(diffs.map((d) => [d, a[d]])), after: Object.fromEntries(diffs.map((d) => [d, b[d]])) }, null, 1));
  process.exit(1);
}
console.log(`Deterministic outputs identical across runs: ${Object.keys(a).join(', ')}`);
