// Benchmark-only experiment (TASK-019): steady-state cost of the shared operations that MCP and the
// UI call, in one long-lived process, with and without a reused analyzer registry.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createDefaultAnalyzerRegistry } from '@duo-director/analyzer';
import { projectContext, projectReview, projectStatus } from '@duo-director/integration';

const name = process.argv[2] ?? 'large';
const root = fileURLToPath(new URL(`../results/local/fixtures/${name}/`, import.meta.url));
const registry = (await createDefaultAnalyzerRegistry()).value;
// --memo: a long-lived surface's token-count memo (TASK-019 optimization); without it: the pre-optimization path.
const tokenCounts = process.argv.includes('--memo') ? new Map() : undefined;
const extra = tokenCounts === undefined ? {} : { tokenCounts };
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, medianMs: Math.round(s[Math.floor(s.length / 2)]), minMs: Math.round(s[0]), maxMs: Math.round(s.at(-1)) }; };
async function sample(label, fn, n = 4) {
  await fn();
  const t = []; let last;
  for (let i = 0; i < n; i++) { const s = performance.now(); last = await fn(); t.push(performance.now() - s); }
  return [label, { ...stats(t), perf: last?.performance }];
}
const rows = Object.fromEntries([
  await sample('status (registry per call, current MCP)', () => projectStatus(root)),
  await sample('status (shared registry)', () => projectStatus(root, { registry })),
  await sample('context AUTH-03 (shared registry)', () => projectContext(root, { task: 'AUTH-03' }, { registry, ...extra })),
  await sample('review HEAD..WORKTREE AUTH-03 (shared registry)', () => projectReview(root, { task: 'AUTH-03', diff: { from: 'HEAD', to: 'WORKTREE' } }, { registry, ...extra })),
]);
registry.dispose();
console.log(JSON.stringify({ fixture: name, memo: tokenCounts !== undefined, rows }, null, 1));
