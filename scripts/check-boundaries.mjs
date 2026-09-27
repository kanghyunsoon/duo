#!/usr/bin/env node
// ADR-010 의존 방향을 package.json과 tsconfig references 수준에서 검사한다.
// 사용: node scripts/check-boundaries.mjs [--root <workspace>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const boundaries = JSON.parse(fs.readFileSync(path.join(here, "boundaries.json"), "utf8"));
const rootArg = process.argv.indexOf("--root");
const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1] ?? ".") : path.resolve(here, "..");
const errors = [];
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const byDir = new Map(Object.entries(boundaries.packages).map(([name, spec]) => [spec.dir, name]));

// 1. 등록되지 않은 workspace 패키지가 없어야 한다.
for (const group of ["packages", "apps"]) {
  const base = path.join(root, group);
  if (!fs.existsSync(base)) continue;
  for (const d of fs.readdirSync(base, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(base, d.name, "package.json")) && !byDir.has(`${group}/${d.name}`)) {
      errors.push(`${group}/${d.name}: not registered in scripts/boundaries.json`);
    }
  }
}

for (const [name, spec] of Object.entries(boundaries.packages)) {
  const dir = path.join(root, spec.dir);
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) { errors.push(`${spec.dir}: package.json missing`); continue; }
  const pkg = readJson(pkgPath);
  if (pkg.name !== name) errors.push(`${spec.dir}: name is ${pkg.name}, expected ${name}`);
  if (pkg.type !== "module") errors.push(`${name}: "type" must be "module" (ADR-001)`);

  // 2. @duo-director/* 의존은 허용 목록 안에 있어야 하고, typeOnly 대상은 devDependencies에만 둔다.
  const declared = new Set();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (!dep.startsWith("@duo-director/")) continue;
      declared.add(dep);
      const ok = spec.allow.includes(dep) || (field === "devDependencies" && spec.typeOnly.includes(dep));
      if (!ok) errors.push(`${name}: ${field} -> ${dep} violates ADR-010 dependency direction`);
    }
  }

  // 3. tsconfig references는 선언된 @duo-director/* 의존과 정확히 같아야 한다(빌드 순서 = 의존 그래프).
  const tsPath = path.join(dir, "tsconfig.json");
  if (!fs.existsSync(tsPath)) { errors.push(`${spec.dir}: tsconfig.json missing`); continue; }
  const refs = new Set((readJson(tsPath).references ?? []).map((r) => {
    const target = path.relative(root, path.resolve(dir, r.path)).split(path.sep).join("/");
    return byDir.get(target) ?? `<unknown:${target}>`;
  }));
  for (const r of refs) if (!declared.has(r)) errors.push(`${name}: tsconfig references ${r} but package.json does not depend on it`);
  for (const d of declared) if (!refs.has(d)) errors.push(`${name}: depends on ${d} but tsconfig.json has no reference to it`);
}

if (errors.length > 0) {
  for (const e of errors) console.error("check-boundaries: " + e);
  process.exitCode = 1;
} else {
  console.log(`check-boundaries: OK (${byDir.size} packages)`);
}
