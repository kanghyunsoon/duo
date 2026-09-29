import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { makeFixture, editGenerated, VERSION, SEED } from './fixtures.mjs';
import { measureSurfaces } from './surfaces.mjs';
import { measureReviews } from './reviews.mjs';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = path.join(WORKSPACE, 'bench', 'results', 'local');
const profile = process.argv.includes('--full') ? 'full' : 'smoke';
const runs = profile === 'full' ? [{ name: 'small', count: 100 }, { name: 'medium', count: 1000, polyglot: true }, { name: 'large', count: 5000, polyglot: true }] : [{ name: 'small', count: 100 }];
const requireValue = (r, label) => { if (r?.value === undefined) throw new Error(`${label}: ${JSON.stringify(r?.diagnostics ?? [])}`); return r.value; };
const measure = async (fn) => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
const stats = (samples) => { const a = [...samples].sort((x, y) => x - y); return { n: a.length, medianMs: a[Math.floor(a.length / 2)], minMs: a[0], maxMs: a.at(-1) }; };
const currentMemory = () => ({ rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed });
const bytes = (target) => {
  if (!fs.existsSync(target)) return 0;
  const entry = fs.lstatSync(target);
  if (!entry.isDirectory()) return entry.size;
  return fs.readdirSync(target).reduce((total, name) => total + bytes(path.join(target, name)), 0);
};
const sourceCorpus = (root, countTokens) => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(name) : /\.(?:ts|tsx|js|java|cs|cpp|py|rs)$/u.test(name) ? [name] : [];
  });
  const files = walk(path.join(root, 'src'));
  return { files: files.length, tokens: files.reduce((sum, file) => sum + countTokens(fs.readFileSync(file, 'utf8')), 0),
    definition: 'src source text only; no Truth, Markdown, binary, generated data, or excluded files' };
};
function worker(kind, root = '.', arg = '') {
  const start = performance.now();
  const p = spawnSync(process.execPath, [path.join(WORKSPACE, 'bench', 'worker.mjs'), kind, root, arg], { cwd: WORKSPACE, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, OPENAI_API_KEY: '', OPENAI_BASE_URL: '' }, windowsHide: true });
  if (p.status !== 0) throw new Error(`worker ${kind}: ${p.stderr || p.stdout}`);
  return { ...JSON.parse(p.stdout), parentElapsedMs: performance.now() - start };
}
function resetDirectory(dir) {
  const resolved = path.resolve(dir);
  const allowed = path.resolve(OUTPUT, 'fixtures') + path.sep;
  if (!resolved.startsWith(allowed)) throw new Error(`unsafe fixture reset: ${resolved}`);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}
const analyzer = await import('@duo-director/analyzer');
const graph = await import('@duo-director/graph');
const director = await import('@duo-director/director');
const registry = requireValue(await analyzer.createDefaultAnalyzerRegistry(), 'registry');
const makeStore = (root) => requireValue(graph.openProjectGraphStore(root), 'store');
const withStore = async (root, fn) => { const store = makeStore(root); try { return await fn(store); } finally { store.close(); } };
const runIndex = (root) => withStore(root, (store) => graph.indexRepository(root, { store, registry }));
const runContext = (root, task, budget) => withStore(root, (store) => director.compileContext(root, { task, ...(budget === undefined ? {} : { budget }) }, { graph: store, registry, cache: true }));
const runReview = (root) => withStore(root, (store) => director.reviewChanges(root, { task: 'AUTH-03', diff: { from: 'HEAD', to: 'WORKTREE' } }, { graph: store, registry }));
const samples = async (fn, n = profile === 'full' ? 5 : 2) => { await fn(); const values = []; for (let i = 0; i < n; i++) values.push((await measure(fn)).ms); return stats(values); };
const result = {
  format: 'duo.benchmark/1', profile, environment: {
    os: process.platform, architecture: process.arch, node: process.version,
    duoVersion: JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'apps/cli/package.json'), 'utf8')).version,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
    filesystem: OUTPUT, git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
    fixtureVersion: VERSION, seed: SEED, timestamp: new Date().toISOString(),
  }, grammars: {}, fixtures: {}, correctness: [], limitations: [],
};
fs.mkdirSync(path.join(OUTPUT, 'fixtures'), { recursive: true });
try {
  const grammarIds = ['typescript', 'tsx', 'javascript', 'java', 'csharp', 'cpp', 'python'];
  for (const id of grammarIds) result.grammars[id] = worker('grammar', '.', id);
  result.grammars.all = worker('grammars-all');
  for (const config of runs) {
    const root = path.join(OUTPUT, 'fixtures', config.name);
    resetDirectory(root);
    const fixture = makeFixture(root, config.count, { polyglot: config.polyglot });
    const row = result.fixtures[config.name] = { fixture, root, initPlanning: worker('init-plan', root), index: {}, context: {}, review: {}, graph: {}, memory: {}, disk: {} };
    row.index.initial = worker('index', root);
    row.sourceCorpus = sourceCorpus(root, director.countTokens);
    const parsedInitially = Object.entries(row.index.initial.metrics.languages).filter(([name]) => name !== 'file-only').reduce((sum, [, value]) => sum + value.files, 0);
    if (row.index.initial.metrics.files.analyzed !== parsedInitially) throw new Error(`initial parse count ${config.name}`);
    row.index.noopCold = worker('index', root);
    if (row.index.noopCold.metrics.files.analyzed !== 0) throw new Error(`no-op reparsed ${config.name}`);
    row.index.noopWarm = await samples(async () => requireValue(await runIndex(root), 'noop index'));
    row.status = await samples(async () => requireValue(await withStore(root, (store) => graph.inspectIndex(root, { graph: store, registry })), 'status'));
    row.coverage = worker('status', root).coverage;
    const tasks = [
      { id: 'requirement', task: 'AUTH-03', expected: ['req:AUTH-03', 'dec:D-015', 'sym:src/auth/AuthService.ts#AuthService.refresh', 'test:src/auth/AuthService.test.ts#AuthService > refresh returns a new access token'] },
      { id: 'symbol', task: 'AuthService.refresh', expected: ['sym:src/auth/AuthService.ts#AuthService.refresh', 'req:AUTH-03'] },
      { id: 'issue', task: 'GAME-42', expected: ['issue:GAME-42', 'req:AUTH-03'] },
      { id: 'natural', task: 'Refresh Token', expected: ['req:AUTH-03'] },
      { id: 'ambiguous', task: 'fix normalize', expectedStatus: 'ambiguous' },
      { id: 'file-only', task: 'src/bench/rs/Bench00005.rs', expectedStatus: 'ready' },
    ];
    for (const task of tasks.filter((t) => t.id !== 'file-only' || config.polyglot)) {
      const first = requireValue(await runContext(root, task.task), 'context');
      const second = requireValue(await runContext(root, task.task), 'context hit');
      const packet = first.packet;
      const included = new Set(packet === undefined ? [] : [
        ...packet.intent.requirements, ...packet.intent.constraints, ...packet.decisions.active, ...packet.code, ...packet.tests, ...packet.issues,
      ].map((v) => v.id));
      const missing = (task.expected ?? []).filter((id) => !included.has(id));
      if (missing.length || (task.expectedStatus && task.expectedStatus !== first.status)) throw new Error(`${config.name} ${task.id}: status ${first.status}, missing ${missing}`);
      if (first.status === 'ready' && second.cache.status !== 'hit') throw new Error(`context cache miss: ${task.id}`);
      row.context[task.id] = { status: first.status, firstMs: first.performance.totalMs, cacheHitMs: second.performance.totalMs,
        cache: [first.cache.status, second.cache.status], digest: packet?.dependencyDigest,
        seeds: packet?.seeds.length ?? 0, candidates: packet?.metrics.candidates ?? 0, omitted: packet?.metrics.omitted ?? 0,
        tokens: first.metrics === undefined ? null : { indexedText: first.metrics.repository.tokens, sourceCorpus: row.sourceCorpus.tokens,
          rawCandidates: first.metrics.rawCandidateTokens, candidates: first.metrics.candidateTokens, packet: first.metrics.selectedTokens,
          reduction: { sourceToPacket: row.sourceCorpus.tokens === 0 ? null : Math.round((1 - first.metrics.selectedTokens / row.sourceCorpus.tokens) * 10000) / 100,
            candidateToPacket: first.metrics.candidateTokens === 0 ? null : Math.round((1 - first.metrics.selectedTokens / first.metrics.candidateTokens) * 10000) / 100,
            rawCandidateToPacket: first.metrics.reduction.vsRawCandidates } },
        quality: { expected: task.expected?.length ?? 0, included: (task.expected?.length ?? 0) - missing.length, missing },
        performance: first.performance, warm: await samples(async () => requireValue(await runContext(root, task.task), 'warm context')) };
      if (packet && packet.metrics.budget.used > packet.metrics.budget.total) throw new Error('packet over budget');
      if (first.metrics?.llmCalls !== undefined && first.metrics.llmCalls !== 0) throw new Error('LLM invoked');
    }
    const store = makeStore(root);
    try {
      const seed = { type: 'requirement', id: 'AUTH-03' };
      row.graph.trace1 = await samples(() => graph.trace(store, seed, { maxDepth: 1, nodeLimit: 200 }));
      row.graph.trace3 = await samples(() => graph.trace(store, seed, { maxDepth: 3, nodeLimit: 200 }));
      row.graph.impact = await samples(() => graph.impact(store, [{ type: 'file', path: 'src/auth/AuthService.ts' }], { maxDepth: 3, nodeLimit: 200 }));
    } finally { store.close(); }
    row.review.clean = worker('review', root);
    row.review.warm = await samples(async () => requireValue(await runReview(root), 'review'));
    if (config.name === 'small') {
      row.surfaces = await measureSurfaces(root, registry);
      const reviewRoot = path.join(OUTPUT, 'fixtures', 'review-scenarios');
      resetDirectory(reviewRoot);
      row.review.scenarios = await measureReviews(reviewRoot, registry, profile === 'full' ? 5 : 2);
    }
    if (config.polyglot) {
      row.index.single = {};
      for (const language of ['ts', 'java', 'cs', 'cpp', 'py']) {
        editGenerated(root, language);
        const r = requireValue(await runIndex(root), `${language} incremental`);
        row.index.single[language] = r.metrics;
        if (r.metrics.files.analyzed !== 1) throw new Error(`${language} parsed ${r.metrics.files.analyzed} files`);
      }
      for (const language of ['ts', 'java', 'cs']) editGenerated(root, language, 1);
      row.index.multi = requireValue(await runIndex(root), 'multi incremental').metrics;
    } else {
      editGenerated(root, 'ts');
      row.index.single = { ts: requireValue(await runIndex(root), 'ts incremental').metrics };
    }
    row.memory.after = currentMemory();
    row.disk = {
      generated: bytes(path.join(root, '.duo-project', 'generated')),
      graphDb: bytes(path.join(root, '.duo-project', 'generated', 'graph.db')),
      indexState: bytes(path.join(root, '.duo-project', 'generated', 'index-state.json')),
      cache: bytes(path.join(root, '.duo-project', 'cache')),
      truth: bytes(path.join(root, '.duo-project')) - bytes(path.join(root, '.duo-project', 'generated')) - bytes(path.join(root, '.duo-project', 'cache')),
    };
    result.correctness.push(`${config.name}: initial ${config.count} parses, no-op zero, context entities and cache verified`);
    console.log(`${config.name}: initial ${Math.round(row.index.initial.operationMs)}ms, no-op cold ${Math.round(row.index.noopCold.totalMs)}ms, context ${Math.round(row.context.requirement.firstMs)}ms`);
  }
} finally { registry.dispose(); }
const summary = [
  '# TASK-019 benchmark baseline', '', `Profile: ${profile}; generated ${result.environment.timestamp}.`,
  `Environment: ${result.environment.os}/${result.environment.architecture}, ${result.environment.node}, ${result.environment.cpu}, ${result.environment.logicalCpus} logical CPUs.`,
  `Fixture ${VERSION}, seed ${SEED}; JSON contains raw samples and phase data.`, '',
  '| Fixture | Source files | Initial index (ms) | No-op cold total (ms) | No-op warm median (ms) | AUTH-03 packet / corpus tokens |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...Object.entries(result.fixtures).map(([name, r]) => `| ${name} | ${r.fixture.sourceFiles} | ${Math.round(r.index.initial.operationMs)} | ${Math.round(r.index.noopCold.totalMs)} | ${Math.round(r.index.noopWarm.medianMs)} | ${r.context.requirement.tokens?.packet ?? 'n/a'} / ${r.context.requirement.tokens?.sourceCorpus ?? 'n/a'} |`),
  '', 'Timings are wall-clock measurements, not thresholds. Corpus denominator is src source text only, measured with o200k_base; no Truth, binary, generated or excluded files.',
];
const filename = profile === 'full' ? 'full' : 'smoke';
fs.writeFileSync(path.join(OUTPUT, `${filename}.json`), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(OUTPUT, `${filename}.md`), `${summary.join('\n')}\n`);
console.log(`Wrote ${path.join(OUTPUT, `${filename}.json`)}`);
