// Benchmark comparison of two DUO runs (before = A, after = B). Deterministic outputs must be equal; timings are
// reported side by side and never gate. Exit: 0 equal, 1 deterministic difference, 2 not comparable.
//
// TASK-019 synthetic (bench/run.mjs):  node bench/compare.mjs <before.json> <after.json>
//   Packet dependency digests and statuses, expected-entity coverage, parse/reuse counts, Review verdicts, claims with
//   provenance and Evidence IDs.
// T23 real-world (bench/realworld-suite.mjs, duo.bench-realworld/2; /1 files compare only with /1):  node bench/compare.mjs <a.json[,a2.json…]> <b.json[,b2.json…]>
//   Every deterministic field of every repository measured on both sides. Several files per side (A/B/A/B rounds of one
//   session) must agree among themselves; timings are then medians. B/A ratios are printed only when both sides ran
//   on the same machine and Node; they are observations of that session, not a general speed-up claim.
import fs from 'node:fs';

const [beforeArg, afterArg] = process.argv.slice(2);
if (!beforeArg || !afterArg) throw new Error('usage: node bench/compare.mjs <before.json[,…]> <after.json[,…]>');
const read = (list) => list.split(',').filter(Boolean).map((f) => ({ file: f, json: JSON.parse(fs.readFileSync(f, 'utf8')) }));
const beforeDocs = read(beforeArg);
const afterDocs = read(afterArg);
const realWorldFormats = new Set([...beforeDocs, ...afterDocs].map((d) => d.json.format).filter((f) => /^duo\.bench-realworld\/\d+$/u.test(String(f))));
if (realWorldFormats.size > 1 || (realWorldFormats.size === 1 && [...beforeDocs, ...afterDocs].some((d) => !realWorldFormats.has(d.json.format)))) {
  // Different harness versions account differently (/2 counts File items, C230): not comparable.
  console.error('Not comparable: different benchmark formats ' + [...new Set([...beforeDocs, ...afterDocs].map((d) => d.json.format))].join(', '));
  process.exit(2);
}
if (realWorldFormats.size === 1) compareRealWorld(beforeDocs, afterDocs);
else compareSynthetic(beforeDocs[0].json, afterDocs[0].json);

function compareSynthetic(before, after) {
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
  console.log('Deterministic outputs identical across runs: ' + Object.keys(a).join(', '));
}

// Leaf paths where two JSON values differ (arrays compared by index).
function leafDiff(x, y, at = '', outList = []) {
  if (outList.length >= 40) return outList;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) {
    if (JSON.stringify(x) !== JSON.stringify(y)) outList.push({ path: at || '.', a: x, b: y });
    return outList;
  }
  for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) leafDiff(x[k], y[k], at + (Array.isArray(x) ? '[' + k + ']' : '.' + k), outList);
  return outList;
}
function median(xs) { const s = xs.filter((v) => typeof v === 'number').sort((p, q) => p - q); return s.length === 0 ? null : s[Math.floor(s.length / 2)]; }
// Flat timing fields of one run: name → number (the first Context call per scenario).
function timingFields(run) {
  const t = run.timings;
  const f = { initCli: t.initCliMs, import: t.importMs, grammarLoad: t.grammarLoadMs, initialIndex: t.initialIndexMs, noopFreshness: t.noopFreshnessMs.median,
    incrementalIndex: t.incrementalIndexMs, cleanFullIndex: t.cleanFullIndexMs, review: t.reviewMs, peakRssMB: run.memory.peakRssMB };
  for (const [id, ms] of Object.entries(t.contextMs)) f['context:' + id] = ms[0];
  return f;
}

function compareRealWorld(aDocs, bDocs) {
  const machineOf = (d) => JSON.stringify({ platform: d.json.machine.platform, arch: d.json.machine.arch, cpu: d.json.machine.cpu, cores: d.json.machine.cores, node: d.json.machine.node });
  const platforms = new Set([...aDocs, ...bDocs].map((d) => d.json.machine.platform));
  if (platforms.size !== 1) { console.error('not comparable: results from different platforms (' + [...platforms].join(', ') + '); symlink and path behavior differ by OS'); process.exit(2); }
  const sameMachine = new Set([...aDocs, ...bDocs].map(machineOf)).size === 1;
  const ids = [...new Set([...aDocs, ...bDocs].flatMap((d) => Object.keys(d.json.results)))].sort();
  const report = { comparable: [], skipped: [], changed: [], disagreeing: [] };
  const timingRows = [];
  for (const id of ids) {
    const side = (docs) => docs.map((d) => d.json.results[id]).filter((r) => r?.run !== undefined).map((r) => r.run);
    const a = side(aDocs), b = side(bDocs);
    if (a.length === 0 || b.length === 0) { report.skipped.push({ id, reason: 'not measured on both sides' }); continue; }
    const shas = new Set([...a, ...b].map((r) => r.repo.sha));
    if (shas.size !== 1) { console.error('not comparable: ' + id + ' measured at different commits ' + [...shas].join(', ')); process.exit(2); }
    for (const [label, runs] of [['A', a], ['B', b]]) {
      const first = JSON.stringify(runs[0].deterministic);
      runs.forEach((r, i) => { if (JSON.stringify(r.deterministic) !== first) report.disagreeing.push({ id, side: label, run: i, diff: leafDiff(runs[0].deterministic, r.deterministic) }); });
    }
    const diff = leafDiff(a[0].deterministic, b[0].deterministic);
    const buildOf = (r) => r.build.duoCommit.slice(0, 12) + (r.build.duoDirty ? '+uncommitted' : '');
    report.comparable.push({ id, builds: { A: [...new Set(a.map(buildOf))], B: [...new Set(b.map(buildOf))] },
      analyzerRegistry: a[0].build.analyzerRegistryDigest === b[0].build.analyzerRegistryDigest ? 'same' : 'different',
      failedChecks: { A: a.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => c.id)), B: b.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => c.id)) } });
    if (diff.length) report.changed.push({ id, diff });
    const ta = a.map(timingFields), tb = b.map(timingFields);
    for (const k of Object.keys(ta[0])) {
      const ma = median(ta.map((x) => x[k])), mb = median(tb.map((x) => x[k]));
      timingRows.push([id, k, ma, mb, sameMachine && ma ? (mb / ma).toFixed(2) : '-']);
    }
  }
  console.log('| repository | measure | A (median) | B (median) | B/A |');
  console.log('|---|---|---:|---:|---:|');
  for (const row of timingRows) console.log('| ' + row.join(' | ') + ' |');
  if (!sameMachine) console.log('Timings come from different machines or Node versions: no ratio.');
  console.log('');
  console.log(JSON.stringify(report, null, 1));
  const failed = report.changed.length > 0 || report.disagreeing.length > 0;
  console.log(failed
    ? 'Deterministic difference: ' + [...new Set([...report.changed, ...report.disagreeing].map((c) => c.id))].join(', ')
    : 'Deterministic outputs identical: ' + report.comparable.map((c) => c.id).join(', '));
  process.exit(failed ? 1 : 0);
}

