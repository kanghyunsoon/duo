import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = 'duo-bench-fixture/1';
export const SEED = 19019;
const BASE = fileURLToPath(new URL('../fixtures/context/app/', import.meta.url));
const LANGUAGES = ['ts', 'java', 'cs', 'cpp', 'py', 'rs'];

function generated(language, n) {
  const name = `Bench${String(n).padStart(5, '0')}`;
  const stride = n % 6 === 0 && n > 0 ? 6 : 1;
  const prev = `Bench${String(n - stride).padStart(5, '0')}`;
  const hubIndex = stride === 6 ? Math.floor(n / 120) * 120 : Math.floor(n / 20) * 20;
  const hub = `Bench${String(hubIndex).padStart(5, '0')}`;
  switch (language) {
    case 'ts': return `// ${name}: chain and hub\n${n > 0 ? `import { value as parent } from './${prev}.js';\n` : ''}${hubIndex !== n && n > 0 ? `import { value as shared } from './${hub}.js';\n` : ''}export function value${name}(): number { return ${n > 0 ? 'parent() + ' : ''}${hubIndex !== n && n > 0 ? 'shared() + ' : ''}${n}; }\nexport const value = value${name};\n`;
    case 'java': return `package bench;\npublic class ${name} { public int value() { return ${n}; } }\n`;
    case 'cs': return `namespace Bench { public class ${name} { public int Value() { return ${n}; } } }\n`;
    case 'cpp': return `#include <cstdint>\nnamespace bench { int value${name}() { return ${n}; } }\n`;
    case 'py': return `def value_${n}():\n    return ${n}\n`;
    default: return `// file-only ${name}\nfn value_${n}() -> i32 { ${n} }\n`;
  }
}

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'DUO Benchmark', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'DUO Benchmark', GIT_COMMITTER_EMAIL: 'bench@example.invalid' } });
}

/** target is source files only; .duo-project, package metadata and Markdown do not count. */
export function makeFixture(root, count, { polyglot = false } = {}) {
  if (!Number.isInteger(count) || count < 20) throw new Error('fixture count must be >=20');
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`refusing to overwrite nonempty fixture: ${root}`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(BASE, root, { recursive: true });
  const existing = 14; // source files in the checked-in context fixture; verified below
  const actual = fs.readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(?:ts|tsx|js|java|cs|cpp|py|rs)$/.test(e.name)).length;
  if (actual !== existing) throw new Error(`context fixture source count changed: expected ${existing}, got ${actual}`);
  for (let i = 0; i < count - actual; i++) {
    const lang = polyglot ? LANGUAGES[i % LANGUAGES.length] : 'ts';
    const dir = path.join(root, 'src', 'bench', lang);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `Bench${String(i).padStart(5, '0')}.${lang}`), generated(lang, i));
  }
  fs.writeFileSync(path.join(root, '.gitignore'), '.duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n');
  git(root, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'deterministic benchmark fixture');
  return { version: VERSION, seed: SEED, sourceFiles: count, polyglot, languages: polyglot ? LANGUAGES : ['ts'], topology: ['chain', 'fan-out/fan-in', 'hubs', 'imports', 'fixture requirement/test/CALLS'] };
}

export function editGenerated(root, language, ordinal = 0) {
  const polyglot = fs.existsSync(path.join(root, 'src', 'bench', 'java'));
  const index = polyglot ? ordinal * LANGUAGES.length + LANGUAGES.indexOf(language) : ordinal;
  const file = path.join(root, 'src', 'bench', language, `Bench${String(index).padStart(5, '0')}.${language}`);
  if (!fs.existsSync(file)) throw new Error(`no fixture file for ${language}: ${file}`);
  fs.appendFileSync(file, `\n// benchmark mutation ${ordinal}\n`);
  return file;
}
