/**
 * H-79 (T55, C257): a root File written without a separator is an exact path seed when the word looks like a file name
 * (a leading dot, or a dot inside) and the File is indexed. A leading dot wins over a Symbol reading of the same word;
 * a dot inside applies only when no Symbol matches. Names without a dot ("LICENSE") need "./".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isPathSignal } from "./seeds.js";
import { contextRegistry, makeContextRepo, type ContextRepo } from "./testing.js";
import type { ContextResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const decision = (id: string, title: string, answer: string, paths: string[]) =>
  `id: ${id}\ntitle: ${title}\nkind: decision\nstate: proposed\nquestion: ${id.toLowerCase()}_rule\nanswer: ${answer}\ngoverns:\n  paths: [${paths.map((p) => JSON.stringify(p)).join(", ")}]\nenforcement: warn\n`;

function writeFixture(dir: string): void {
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w("package.json", JSON.stringify({ name: "c257", version: "1.0.0", type: "module" }) + "\n");
  w("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "nodenext" } }) + "\n");
  w("tsconfig.base.json", "{}\n");
  w("README.md", "# c257\n\nRoot file fixture.\n");
  w(".env", "PORT=3000\n");
  w(".gitignore", "node_modules/\n");
  w(".editorconfig", "root = true\n");
  w("LICENSE", "Apache-2.0\n");
  w("Dockerfile", "FROM node:24\n");
  w("config", "mode=dev\n");
  w("Session.open", "a root file named like a symbol\n");
  w("Foo.bar", "a root file named like an ambiguous symbol\n");
  w(".duo-project/project.yaml", "schema_version: 1\nname: c257\n");
  w(".duo-project/specs/tasks.md", ["# Tasks", "", "## TASK-001 Pin dependencies", "", "```duo", "type: issue", "status: todo", "```", "", "Pin every dependency.", ""].join("\n"));
  w(".duo-project/decisions/D-001.yaml", decision("D-001", "Package manifest is pinned", "dependencies use exact versions", ["package.json"]));
  w(".duo-project/decisions/D-002.yaml", decision("D-002", "Package json loader caches reads", "the package json loader and readme parser cache files", ["src/other/**"]));
  w(".duo-project/decisions/D-003.yaml", decision("D-003", "Sessions use opaque tokens", "opaque server-side tokens", ["src/auth/**"]));
  w("src/other/package-json-loader.ts", "export function packageJsonLoader(): string {\n  return \"package.json\";\n}\n");
  w("src/other/readme-parser.ts", "export function readmeParser(): string {\n  return \"README.md\";\n}\n");
  w("src/auth/session.ts", "export class Session {\n  open(user: string): string {\n    return user;\n  }\n}\n");
  w("src/env.ts", "export const env = (): string => \"dev\";\n");
  w("src/gitignore.ts", "export const gitignore = (): string => \"node_modules\";\n");
  w("src/a/foo.ts", "export class Foo {\n  bar(): number {\n    return 1;\n  }\n}\n");
  w("src/b/foo.ts", "export class Foo {\n  bar(): number {\n    return 2;\n  }\n}\n");
}

const seeds = (r: ContextResult) => r.packet?.seeds.map((s) => [s.ref, s.match]) ?? [];
const exact = (r: ContextResult) => r.packet?.seeds.filter((s) => s.match !== "keyword").map((s) => [s.ref, s.match]) ?? [];
const active = (r: ContextResult) => r.packet?.decisions.active.map((d) => d.ref).sort() ?? [];

describe("root files named without a separator (H-79, T55, C257)", () => {
  let registry: AnalyzerRegistry;
  let repo: ContextRepo;
  const compile = (task: string) => repo.compile({ task, budget: 6000 });
  beforeAll(async () => {
    registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-c257-"));
    temps.push(fixture);
    writeFixture(fixture);
    repo = makeContextRepo(temps, registry, fixture);
    const s = createDecisionService({ root: repo.root, clock: () => new Date("2026-10-10T00:00:00Z") });
    for (const id of ["D-001", "D-002", "D-003"]) expect((await s.confirm({ kind: "human", name: "Ada" }, id)).value?.decisionId).toBe(id);
    repo.git("add", "-A");
    repo.git("commit", "-qm", "decisions");
    await repo.index();
  });
  afterAll(() => registry?.dispose());

  it("1-2 a dotted root file name is the exact File; package.json reaches D-001 only (before: keyword seeds and D-002)", async () => {
    const pkg = await compile("package.json");
    expect(seeds(pkg)).toEqual([["package.json", "path"]]);
    expect(pkg.packet?.seeds[0]?.term).toBe("package.json");
    expect(active(pkg)).toEqual(["D-001"]);
    for (const f of ["README.md", "tsconfig.base.json"]) expect(seeds(await compile(f)), f).toEqual([[f, "path"]]);
  });

  it("3-4 a leading-dot root file name is the exact File, before a Symbol of the same word; .env is never indexed (security policy)", async () => {
    for (const f of [".gitignore", ".editorconfig"]) expect(seeds(await compile(f)), f).toEqual([[f, "path"]]);
    expect(seeds(await compile("gitignore"))).toEqual([["src/gitignore.ts#gitignore", "symbol"]]);
    expect(seeds(await compile(".env"))).toEqual([["src/env.ts#env", "symbol"]]);
    expect((await compile("./.env")).packet?.seeds.some((s) => s.match === "path")).toBe(false);
  });

  it("5 a sentence-ending period is not part of the name", async () => {
    for (const [task, f] of [["Update package.json.", "package.json"], ["Check README.md.", "README.md"], ["Load .gitignore.", ".gitignore"]]) {
      expect(exact(await compile(task as string)), task).toEqual([[f, "path"]]);
    }
  });

  it("6 a missing or differently cased root file keeps the previous fallback", async () => {
    for (const task of ["missing.json", "readme.md", ".missing"]) expect((await compile(task)).packet?.seeds.some((s) => s.match === "path") ?? false, task).toBe(false);
  });

  it("7-9 a Symbol reading of a dotted word stays: exact Symbol, ambiguity; ./ names the File", async () => {
    expect(seeds(await compile("Session.open"))).toEqual([["src/auth/session.ts#Session.open", "symbol"]]);
    const foo = await compile("Foo.bar");
    expect(foo.status).toBe("ambiguous");
    expect(foo.resolution?.ambiguities.map((a) => a.reason)).toEqual(["qualified-name"]);
    for (const f of ["Session.open", "Foo.bar"]) expect(seeds(await compile("./" + f)), f).toEqual([[f, "path"]]);
  });

  it("10-12 names without a dot are not path signals; ./ names the File", async () => {
    for (const f of ["LICENSE", "Dockerfile", "config"]) {
      expect((await compile(f)).packet?.seeds.some((s) => s.match === "path"), f).toBe(false);
      expect(seeds(await compile("./" + f)), "./" + f).toEqual([[f, "path"]]);
    }
    expect((await compile("update config handling")).packet?.seeds.some((s) => s.match === "path")).toBe(false);
  });

  it("13-14 the exact root file is not BM25 input; the user's other words are; an ID comes first", async () => {
    const r = await compile("Update package.json dependency loader");
    expect(exact(r)).toEqual([["package.json", "path"]]);
    expect(r.packet?.seeds.some((s) => s.ref === "src/other/package-json-loader.ts#packageJsonLoader" && s.match === "keyword")).toBe(true);
    expect(seeds(await compile("TASK-001 package.json"))).toEqual([["package.json", "path"], ["TASK-001", "id"]]);
  });

  it("15-17 separator paths and Symbols resolve as before", async () => {
    for (const task of ["./package.json", ".\\package.json"]) expect(seeds(await compile(task)), task).toEqual([["package.json", "path"]]);
    expect(seeds(await compile("src/auth/session.ts"))).toEqual([["src/auth/session.ts", "path"]]);
    expect(seeds(await compile("src\\auth\\session.ts"))).toEqual([["src/auth/session.ts", "path"]]);
    expect(seeds(await compile("Session.open payment"))[0]).toEqual(["src/auth/session.ts#Session.open", "symbol"]);
  });

  it("isPathSignal keeps its separator syntax contract", () => {
    for (const p of ["package.json", ".gitignore", "README.md", "LICENSE"]) expect(isPathSignal(p), p).toBe(false);
    for (const p of ["./package.json", "./LICENSE", ".github/workflows/ci.yml"]) expect(isPathSignal(p), p).toBe(true);
  });

  it("18 cache: policy 8 packets miss first, then hit with the same bytes", async () => {
    const a = await repo.compile({ task: "package.json", budget: 6000 }, { cache: true });
    const b = await repo.compile({ task: "package.json", budget: 6000 }, { cache: true });
    expect(a.cache.status).toBe("miss");
    expect(b.cache.status).toBe("hit");
    expect(JSON.stringify(b.packet)).toBe(JSON.stringify(a.packet));
  });
});
