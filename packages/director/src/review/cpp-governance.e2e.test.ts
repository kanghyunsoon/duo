/**
 * C231 (T24.5) end to end: a Decision whose governs.symbols names a C++ callable declared in a header
 * and defined in a .cpp (one proven declaration group) governs both. An edit to the header declaration
 * or to the definition keeps the Decision's governance, both together give one claim, and a Symbol with
 * the same name and another qualified name is not governed. The Context shows the group once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { reviewChanges } from "./review.js";
import type { ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;

const FILES: Record<string, string> = {
  ".duo-project/project.yaml": "schema_version: 1\nname: cpp-governance\n",
  ".duo-project/decisions/D-301.yaml": [
    "id: D-301", "title: Weapon firing stays server side", "kind: decision", "state: confirmed", "question: fire", "answer: server", "owner: human",
    "governs:", '  symbols: ["AWeapon.Fire"]', 'confirmed_at: "2026-09-27T00:00:00Z"', "confirmed_by: tester", "",
  ].join("\n"),
  "Source/Game/Public/Weapon.h": "class AWeapon {\npublic:\n  void Fire(int Shots);\n};\n",
  "Source/Game/Private/Weapon.cpp": '#include "Weapon.h"\n\nvoid AWeapon::Fire(int Shots) {\n  (void)Shots;\n}\n',
  // The same member name on another class: another qualified name, never governed by D-301.
  "Source/Game/Public/Turret.h": "class ATurret {\npublic:\n  void Fire(int Shots);\n};\n",
  "Source/Game/Private/Turret.cpp": '#include "Turret.h"\n\nvoid ATurret::Fire(int Shots) {\n  (void)Shots;\n}\n',
};

beforeAll(async () => {
  registry = await contextRegistry();
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-cpp-gov-")));
  temps.push(fixture);
  for (const [f, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(fixture, f)), { recursive: true });
    fs.writeFileSync(path.join(fixture, f), text);
  }
  repo = makeContextRepo(temps, registry, fixture);
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

async function review(): Promise<ReviewResult> {
  const opened = openProjectGraphStore(repo.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const out = await reviewChanges(repo.root, { diff: { from: "HEAD", to: "WORKTREE" } }, { graph: opened.value, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  } finally {
    opened.value.close();
  }
}
async function scenario(mutate: () => void): Promise<ReviewResult> {
  repo.git("reset", "-q", "--hard");
  repo.git("clean", "-fdq");
  mutate();
  await repo.index();
  return review();
}
const governance = (r: ReviewResult) => r.claims.filter((c) => c.rule === "decision-governance").map((c) => `${c.subject.id} ${c.alignment}: ${c.observed}`);
const declared = (r: ReviewResult) => r.claims.filter((c) => c.rule === "declared-reference");

// The parameter name is not part of the signature (T24.3): the pair stays proven.
const headerEdit = () => repo.edit("Source/Game/Public/Weapon.h", "  void Fire(int Shots);\n", "  void Fire(int Count);\n");
const sourceEdit = () => repo.edit("Source/Game/Private/Weapon.cpp", "  (void)Shots;\n", "  (void)Shots;\n  (void)0;\n");

describe("Decision governance of a C++ declaration group (C231)", () => {
  it("an edit to the header declaration keeps the Decision's governance", async () => {
    const r = await scenario(headerEdit);
    expect(r.seeds.map((s) => s.ref)).toEqual(["Source/Game/Public/Weapon.h#AWeapon.Fire"]);
    expect(governance(r)).toEqual(["D-301 ALIGNED: Source/Game/Public/Weapon.h#AWeapon.Fire governed by D-301; no forbidden path, symbol or dependency"]);
    expect(declared(r)).toEqual([]);
  });

  it("an edit to the cpp definition keeps the Decision's governance", async () => {
    const r = await scenario(sourceEdit);
    expect(r.seeds.map((s) => s.ref)).toEqual(["Source/Game/Private/Weapon.cpp#AWeapon.Fire"]);
    expect(governance(r)).toEqual(["D-301 ALIGNED: Source/Game/Private/Weapon.cpp#AWeapon.Fire governed by D-301; no forbidden path, symbol or dependency"]);
  });

  it("both edits give one claim, not one per Symbol", async () => {
    const r = await scenario(() => { headerEdit(); sourceEdit(); });
    expect(governance(r)).toEqual(["D-301 ALIGNED: Source/Game/Private/Weapon.cpp#AWeapon.Fire, Source/Game/Public/Weapon.h#AWeapon.Fire governed by D-301; no forbidden path, symbol or dependency"]);
  });

  it("a Symbol with the same member name and another qualified name is not governed", async () => {
    const r = await scenario(() => repo.edit("Source/Game/Private/Turret.cpp", "  (void)Shots;\n", "  (void)Shots;\n  (void)0;\n"));
    expect(r.seeds.map((s) => s.ref)).toEqual(["Source/Game/Private/Turret.cpp#ATurret.Fire"]);
    expect(governance(r)).toEqual([]);
  });

  it("the Context for the Decision shows the group as one item", async () => {
    repo.git("reset", "-q", "--hard");
    await repo.index();
    const c = await repo.compile({ task: "D-301" });
    const items = (c.packet?.code ?? []).filter((i) => i.id.endsWith("#AWeapon.Fire"));
    expect(items.map((i) => i.id)).toHaveLength(1);
    expect(items[0]?.text.split("\n")[0]).toContain("Source/Game/Private/Weapon.cpp:3-5 + Source/Game/Public/Weapon.h:3");
  });
});

