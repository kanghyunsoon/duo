// Benchmark-only experiment (TASK-019): cold ESM import cost per workspace package, each in a new
// process, and whether the optional OpenAI SDK is loaded when the LLM provider is off.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const probe = (spec) => {
  const code = `const t=performance.now(); await import('${spec}'); const ms=performance.now()-t;`
    + `const { createRequire } = await import('node:module'); const loaded = Object.keys((await import('node:module')).default._cache ?? {}).length;`
    + `console.log(JSON.stringify({ spec: '${spec}', importMs: ms }));`;
  const start = performance.now();
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8', windowsHide: true });
  if (p.status !== 0) throw new Error(p.stderr);
  return { ...JSON.parse(p.stdout), processMs: performance.now() - start };
};
const empty = (() => { const s = performance.now(); spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); return performance.now() - s; })();
const rows = ['@duo-director/core', '@duo-director/analyzer', '@duo-director/graph', '@duo-director/director', '@duo-director/integration'].map(probe);
// OpenAI SDK: loaded only when a provider is created? Check the module graph of a status call with provider none.
const sdk = spawnSync(process.execPath, ['--input-type=module', '-e',
  "const hooks=[]; const { registerHooks } = await import('node:module'); registerHooks({ resolve(s, c, n) { const r = n(s, c); if (/node_modules[\\/](?:\\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?openai[\\/]/.test(decodeURIComponent(r.url))) hooks.push(r.url); return r; } });"
  + "const i = await import('@duo-director/integration'); const r = await i.projectStatus(process.argv[1]); console.log(JSON.stringify({ kind: r.kind, openaiModulesLoaded: hooks.length }));",
  fileURLToPath(new URL('../results/local/fixtures/small/', import.meta.url))], { cwd, encoding: 'utf8', windowsHide: true });
console.log(JSON.stringify({ emptyNodeProcessMs: empty, packages: rows, providerNone: sdk.status === 0 ? JSON.parse(sdk.stdout.trim().split('\n').at(-1)) : { error: sdk.stderr.slice(0, 400) } }));
