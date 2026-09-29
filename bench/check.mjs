import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const full = process.argv.includes('--full');
const file = fileURLToPath(new URL(`./results/local/${full ? 'full' : 'smoke'}.json`, import.meta.url));
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (yes, message) => { if (!yes) throw new Error(message); };
assert(report.format === 'duo.benchmark/1', 'report format');
for (const field of ['os', 'architecture', 'node', 'duoVersion', 'cpu', 'logicalCpus', 'memoryBytes', 'filesystem', 'git', 'fixtureVersion']) {
  assert(report.environment[field], `missing environment.${field}`);
}
assert(Object.keys(report.grammars).length === 8, 'seven grammars and all-grammar timing');
const names = full ? ['small', 'medium', 'large'] : ['small'];
for (const name of names) {
  const row = report.fixtures[name];
  assert(row?.fixture.sourceFiles >= (name === 'large' ? 4900 : name === 'medium' ? 900 : 90), `${name}: file scale`);
  const structural = Object.entries(row.index.initial.metrics.languages).filter(([language]) => language !== 'file-only').reduce((sum, [, value]) => sum + value.files, 0);
  assert(row.index.initial.metrics.files.analyzed === structural, `${name}: initial index parse count`);
  assert(row.index.noopCold.metrics.files.analyzed === 0, `${name}: no-op reparsed`);
  assert(row.index.noopWarm.n >= 2 && row.status.n >= 2, `${name}: repeated samples`);
  assert(row.coverage.files.structural + row.coverage.files.fileOnly === row.coverage.files.total, `${name}: coverage accounting`);
  for (const phase of ['truth', 'scan', 'fingerprint', 'analysis', 'git', 'graph-plan', 'write']) assert(Number.isFinite(row.index.initial.phases[phase]), `${name}: ${phase} phase`);
  for (const task of ['requirement', 'symbol', 'issue', 'natural', 'ambiguous']) {
    assert(row.context[task]?.quality.missing.length === 0, `${name}: ${task} expected entity`);
    if (task !== 'ambiguous') assert(row.context[task].cache[1] === 'hit', `${name}: ${task} cache`);
  }
  assert(row.context.ambiguous.status === 'ambiguous', `${name}: ambiguous task`);
  assert(row.context.requirement.tokens.sourceCorpus > 0, `${name}: source corpus tokens`);
  assert(row.review.clean.metrics.llmCalls === 0, `${name}: deterministic review`);
  assert(row.graph.trace1.n >= 2 && row.graph.trace3.n >= 2 && row.graph.impact.n >= 2, `${name}: graph samples`);
}
assert(report.fixtures.small.surfaces.mcp.firstStatus > 0, 'MCP first status');
assert(report.fixtures.small.surfaces.ui.overviewMs > 0, 'UI overview');
if (full) for (const language of ['ts', 'java', 'cs', 'cpp', 'py']) {
  assert(report.fixtures.medium.index.single[language].files.analyzed === 1, `single-file ${language}`);
}
console.log(`Benchmark ${full ? 'full' : 'smoke'} schema and correctness: OK`);
