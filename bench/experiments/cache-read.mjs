// Benchmark-only experiment (TASK-019): decomposes the per-file analysis cache read that
// indexRepository (no-op) and inspectIndex perform. It reads the real cache of a benchmark fixture.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const name = process.argv[2] ?? 'large';
const root = fileURLToPath(new URL(`../results/local/fixtures/${name}/`, import.meta.url));
const dir = path.join(root, '.duo-project', 'cache', 'analysis');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const rel = ['.duo-project', 'cache', 'analysis'];
const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
const lstatMs = time(() => { for (const f of files) for (let i = 1; i <= 4; i++) fs.lstatSync(path.join(root, ...[...rel, f].slice(0, i))); });
const texts = [];
const readMs = time(() => { for (const f of files) texts.push(fs.readFileSync(path.join(dir, f), 'utf8')); });
const parseMs = time(() => { for (const t of texts) JSON.parse(t); });
const statMs = time(() => { for (const f of files) fs.statSync(path.join(dir, f)); });
const bytes = texts.reduce((n, t) => n + t.length, 0);
console.log(JSON.stringify({ fixture: name, entries: files.length, bytes, lstatPathChecksMs: lstatMs, readMs, jsonParseMs: parseMs, singleStatMs: statMs }));
