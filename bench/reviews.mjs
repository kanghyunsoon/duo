import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { indexRepository, openProjectGraphStore } from '@duo-director/graph';
import { reviewChanges } from '@duo-director/director';

const FIXTURE = fileURLToPath(new URL('../fixtures/review/app/', import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: 'DUO Benchmark', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'DUO Benchmark', GIT_COMMITTER_EMAIL: 'bench@example.invalid' };
const git = (root, ...args) => execFileSync('git', args, { cwd: root, env, windowsHide: true, stdio: 'pipe' });
const edit = (root, file, before, after) => {
  const target = path.join(root, file);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(before)) throw new Error(`review fixture changed: ${file}`);
  fs.writeFileSync(target, text.replace(before, after));
};
const cases = [
  { name: 'PASS', expected: 'PASS', task: 'AUTH-03', mutate: (root) => edit(root, 'src/auth/token-service.ts', 'throw new Error("expired refresh token");', 'throw new Error("refresh token expired");') },
  { name: 'WARN', expected: 'WARN', task: 'AUTH-03', mutate: (root) => edit(root, 'src/admin/metrics-export.ts', '.join("\\n")', '.sort().join("\\n")') },
  { name: 'BLOCK', expected: 'BLOCK', task: 'AUTH-03', mutate: (root) => fs.writeFileSync(path.join(root, 'src/auth/session-store.ts'), 'export class ServerSessionStore { save() {} }\n') },
  { name: 'ASK', expected: 'ASK', mutate: (root) => edit(root, 'src/presence/presence-service.ts', 'members.add(userId);', 'members.add(userId.trim());') },
  { name: 'unknown-language', mutate: (root) => fs.writeFileSync(path.join(root, 'src/report/notes.rs'), 'fn report() -> i32 { 1 }\n') },
];
export async function measureReviews(root, registry, repetitions = 2) {
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`refusing to overwrite review fixture: ${root}`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'benchmark review fixture');
  const store = openProjectGraphStore(root).value;
  if (!store) throw new Error('review graph unavailable');
  try {
    const measured = {};
    const index = async () => { const r = await indexRepository(root, { store, registry }); if (!r.value) throw new Error(JSON.stringify(r.diagnostics)); };
    await index();
    for (const scenario of cases) {
      git(root, 'reset', '-q', '--hard');
      git(root, 'clean', '-fdq');
      scenario.mutate(root);
      await index();
      const first = await reviewChanges(root, { ...(scenario.task ? { task: scenario.task } : {}), diff: { from: 'HEAD', to: 'WORKTREE' } }, { graph: store, registry });
      const second = await reviewChanges(root, { ...(scenario.task ? { task: scenario.task } : {}), diff: { from: 'HEAD', to: 'WORKTREE' } }, { graph: store, registry });
      if (!first.value || !second.value) throw new Error(`review ${scenario.name}: ${JSON.stringify(first.diagnostics)}`);
      const { result, performance } = first.value;
      if (scenario.expected && result.verdict !== scenario.expected) throw new Error(`${scenario.name}: got ${result.verdict}`);
      if (JSON.stringify(result) !== JSON.stringify(second.value.result)) throw new Error(`${scenario.name}: nondeterministic review`);
      if (result.metrics.llmCalls !== 0) throw new Error(`${scenario.name}: LLM invoked`);
      const timings = [performance.totalMs, second.value.performance.totalMs];
      for (let i = 2; i < repetitions; i++) {
        const sample = await reviewChanges(root, { ...(scenario.task ? { task: scenario.task } : {}), diff: { from: 'HEAD', to: 'WORKTREE' } }, { graph: store, registry });
        if (!sample.value || JSON.stringify(sample.value.result) !== JSON.stringify(result)) throw new Error(`${scenario.name}: repeated review changed`);
        timings.push(sample.value.performance.totalMs);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      const known = (performance.freshnessMs ?? 0) + performance.diffMs + performance.contextMs + (performance.gapMs ?? 0) + performance.rulesMs + performance.semanticMs;
      measured[scenario.name] = { verdict: result.verdict, status: result.status, metrics: result.metrics, phaseMs: {
        freshness: performance.freshnessMs ?? null, gitDiff: performance.diffMs, context: performance.contextMs, gap: performance.gapMs ?? null,
        rulesEvidence: performance.rulesMs, semantic: performance.semanticMs, truthBaselineAggregate: performance.totalMs - known, total: performance.totalMs },
        timing: { n: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) },
        claims: result.claims.map((c) => ({ rule: c.rule, reason: c.reason, provenance: c.provenance, alignment: c.alignment })),
        evidenceIds: result.evidence.map((e) => e.id) };
    }
    return measured;
  } finally { store.close(); }
}
