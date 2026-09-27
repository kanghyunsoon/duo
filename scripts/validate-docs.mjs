#!/usr/bin/env node
// DUO docs trace validator (T00). docs/의 Markdown 정의 형식을 DUO와 같은 규칙으로 파싱해
// 링크, 앵커, ID 중복, 참조 타입, ADR-Task 정합, MVP Requirement 연결, 문서 내 ID 언급을 검사한다.
import fs from 'node:fs';
import path from 'node:path';
const F = '\x60\x60\x60';
const SKIP = new Set(['.git', 'tmp', '.worklog', 'node_modules', 'dist', 'coverage']);
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.md')) files.push(p); } })('.');
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const errors = [], brokenLinks = [], brokenAnchors = [], dup = [], unknownRefs = new Set();
const slug = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const anchors = {};
for (const f of files) { const set = new Set(); let inF = false; for (const l of read(f).split('\n')) { if (l.startsWith(F) || l.startsWith('~~~')) inF = !inF; if (!inF) { const m = l.match(/^#{1,6}\s+(.*)$/); if (m) set.add(slug(m[1])); } } anchors[path.resolve(f)] = set; }
for (const f of files) { for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) { const t = m[1]; if (/^https?:/.test(t)) continue; const [p, a] = t.split('#'); const tgt = p ? path.resolve(path.dirname(f), decodeURIComponent(p)) : path.resolve(f); if (!fs.existsSync(tgt)) { brokenLinks.push(f + ' -> ' + t); continue; } if (a && anchors[tgt] && !anchors[tgt].has(decodeURIComponent(a))) brokenAnchors.push(f + ' -> ' + t); } }
const ID = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z]?|M\d+)$/;
const defs = {};
const add = (id, type, f, data) => { if (defs[id]) dup.push(id + ' ' + f + ' & ' + defs[id].f); defs[id] = { type, f, data }; };
const flat = (b) => { const o = {}; for (const l of b.split('\n')) { const m = l.match(/^(\w+):\s*(.*)$/); if (!m) continue; let v = m[2].replace(/\s+#.*$/, '').trim(); if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean); o[m[1]] = v; } return o; };
const src = ['docs/01-requirements.md', 'docs/tasks/TASKS.md', 'docs/12-roadmap.md', ...fs.readdirSync('docs/adr').filter((x) => /^ADR-\d+/.test(x)).map((x) => 'docs/adr/' + x)];
for (const f of src) {
  const s = read(f);
  const fm = s.match(/^---\n([\s\S]*?)\n---/);
  if (fm) { const d = flat(fm[1]); const g = fm[1].match(/requirements:\s*\[(.*)\]/); d.governs = g ? g[1].split(',').map((x) => x.trim()) : []; if (d.type !== 'decision' || !ID.test(d.id)) errors.push('bad frontmatter ' + f); add(d.id, 'decision', f, d); continue; }
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{2,4}\s+(\S+)\s+(.+)$/); if (!m || !ID.test(m[1])) continue;
    let j = i + 1; while (j < lines.length && lines[j].trim() === '') j++;
    if (lines[j] !== F + 'duo') { errors.push('no duo block ' + m[1] + ' ' + f); continue; }
    let k = j + 1; const b = []; while (k < lines.length && lines[k] !== F) { b.push(lines[k]); k++; }
    const d = flat(b.join('\n')); d.type = d.type || 'requirement';
    if (d.type === 'issue') { d.ac = []; for (let q = k + 1; q < lines.length && !/^#{2,4}\s/.test(lines[q]); q++) { const a = lines[q].match(/^- \*\*(AC-\d{3}[A-Z]?-\d{2})\*\*/); if (a) d.ac.push(a[1]); } }
    add(m[1], d.type, f, d);
  }
}
const ids = new Set(Object.keys(defs));
const acs = new Set(Object.values(defs).flatMap((d) => d.data.ac || []));
const chk = (from, list, type) => { for (const x of list || []) { if (!defs[x]) errors.push(from + ' -> missing ' + x); else if (type && defs[x].type !== type) errors.push(from + ' -> ' + x + ' is ' + defs[x].type + ', expected ' + type); } };
const covered = new Set();
for (const [id, d] of Object.entries(defs)) {
  const x = d.data;
  if (d.type === 'decision') chk(id, x.governs, 'requirement');
  if (d.type === 'issue') {
    chk(id, x.requirements, 'requirement'); chk(id, x.decisions, 'decision'); chk(id, x.depends_on, 'issue'); if (x.milestone) chk(id, [x.milestone], 'milestone');
    (x.requirements || []).forEach((r) => covered.add(r));
    for (const a of x.decisions || []) { const g = (defs[a] && defs[a].data.governs) || []; if (!g.some((r) => (x.requirements || []).includes(r))) errors.push(id + ' decision ' + a + ' governs none of its requirements'); }
  }
  if (d.type === 'requirement' && x.milestone && x.milestone !== 'null') chk(id, [x.milestone], 'milestone');
}
for (const [id, d] of Object.entries(defs)) if (d.type === 'requirement' && d.data.status !== 'deferred' && !covered.has(id)) errors.push(id + ' has no task');
for (const f of files) { if (f.includes(path.join('docs', 'references'))) continue; for (const m of read(f).matchAll(/\b(REQ-[A-Z]+-\d{3}|ADR-\d{3}|TASK-\d{3}[A-Z]?|AC-\d{3}[A-Z]?-\d{2})\b/g)) { const t = m[1]; if (t.startsWith('AC-') ? !acs.has(t) : !ids.has(t)) unknownRefs.add(t + ' @ ' + f); } }
const count = (t) => Object.values(defs).filter((d) => d.type === t).length;
const report = { files: files.length, requirements: count('requirement'), decisions: count('decision'), issues: count('issue'), milestones: count('milestone'), acceptanceCriteria: acs.size, errors, duplicates: dup, brokenLinks, brokenAnchors, unknownRefs: [...unknownRefs] };
console.log(JSON.stringify(report, null, 1));
const n = errors.length + dup.length + brokenLinks.length + brokenAnchors.length + unknownRefs.size;
if (n > 0) { console.error('validate-docs: ' + n + ' problem(s)'); process.exitCode = 1; } else console.error('validate-docs: OK');
