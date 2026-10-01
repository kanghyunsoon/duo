/**
 * T24.1 (C217): Java, C# and C++ overloads that the analyzer merges into one Symbol. The Symbol ID
 * stays as it was; every overload location reaches the Context Packet, Evidence and Review diff
 * seeds, while the repository adds, removes, replaces, edits and reorders overloads. C++ header
 * declarations and source definitions stay separate Symbols (C218 is not part of this change).
 */
import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { nodeId, sha256Text, symbolRef, type RepoPath } from "@duo-director/core";
import { nodeLocations, openProjectGraphStore, type GraphNode } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { repositoryEvidence } from "../evidence/sources.js";
import { EvidenceStore } from "../evidence/store.js";
import { reviewChanges } from "../review/review.js";
import { SourceReader } from "./retrieve.js";
import { contextRegistry, HISTORY, makeContextRepo, REVIEW_FIXTURE, type ContextRepo } from "./testing.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

interface Lang {
  readonly name: string;
  readonly file: string;
  readonly owner: string;
  readonly symbol: string;
  readonly task: string;
  /** Text of the first overload's body and of the second one's. */
  readonly first: string;
  readonly second: string;
  readonly eol: string;
  readonly bom: boolean;
  readonly text: (parts: readonly ("one" | "two" | "twoEdited" | "twoOther")[]) => string;
}

function lang(name: string, file: string, owner: string, symbol: string, task: string, eol: string, bom: boolean, pre: string[], post: string[], m: Record<"one" | "two" | "twoEdited" | "twoOther", string[]>, first: string, second: string): Lang {
  return {
    name, file, owner, symbol, task, first, second, eol, bom,
    text: (parts) => (bom ? "\uFEFF" : "") + [...pre, ...parts.flatMap((p, i) => (i === 0 ? m[p] : ["", ...m[p]])), ...post, ""].join(eol),
  };
}

const LANGS: readonly Lang[] = [
  lang("Java", "src/main/java/app/Svc.java", "Svc", "Svc.foo", "Svc foo count", "\n", false,
    ["package app;", "", "public class Svc {"], ["}"], {
      one: ["  public int foo() {", "    return 1;", "  }"],
      two: ["  public int foo(int count) {", "    return count;", "  }"],
      twoEdited: ["  public int foo(int count) {", "    return count + 1;", "  }"],
      twoOther: ["  public int foo(String count) {", "    return count.length();", "  }"],
    }, "return 1;", "return count"),
  lang("C#", "Game/Player.cs", "Game.Player", "Game.Player.Move", "Player Move speed", "\r\n", true,
    ["namespace Game", "{", "    public class Player", "    {"], ["    }", "}"], {
      one: ["        public int Move()", "        {", "            return 1;", "        }"],
      two: ["        public int Move(int speed)", "        {", "            return speed;", "        }"],
      twoEdited: ["        public int Move(int speed)", "        {", "            return speed + 1;", "        }"],
      twoOther: ["        public int Move(string speed)", "        {", "            return speed.Length;", "        }"],
    }, "return 1;", "return speed"),
  lang("C++", "src/weapon.cpp", "AWeapon", "AWeapon.Fire", "AWeapon Fire count", "\n", false,
    ["class AWeapon {", "public:"], ["};"], {
      one: ["  int Fire() {", "    return 1;", "  }"],
      two: ["  int Fire(int count) {", "    return count;", "  }"],
      twoEdited: ["  int Fire(int count) {", "    return count + 1;", "  }"],
      twoOther: ["  int Fire(const char* count) {", "    return count[0];", "  }"],
    }, "return 1;", "return count"),
];

const temps: string[] = [];
let registry: AnalyzerRegistry;
beforeAll(async () => { registry = await contextRegistry(); });
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const W = { from: "HEAD" as const, to: "WORKTREE" as const };

async function packetOf(r: ContextRepo, task: string) {
  const packet = (await r.compile({ task })).packet;
  if (packet === undefined) throw new Error(`no Packet for ${task}`);
  return packet;
}

function withStore<T>(root: string, fn: (s: NonNullable<ReturnType<typeof openProjectGraphStore>["value"]>) => T): T {
  const opened = openProjectGraphStore(root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try { return fn(opened.value); } finally { opened.value.close(); }
}

const symbolNode = (r: ContextRepo, l: Lang): GraphNode | undefined => withStore(r.root, (s) => s.getNode(symbolRef(l.file as RepoPath, l.symbol)));
const symbolIds = (r: ContextRepo) => r.graphDump().nodes.map((n) => JSON.parse(n).id as string).filter((id) => id.startsWith("sym:")).sort();
const lines = (n: GraphNode | undefined) => (n === undefined ? [] : nodeLocations(n).map((x) => `${x.startLine}-${x.endLine}`));

async function cleanFull(r: ContextRepo): Promise<string> {
  for (const d of ["generated", "cache"]) fs.rmSync(path.join(r.root, ".duo-project", d), { recursive: true, force: true });
  await r.index();
  return JSON.stringify(r.graphDump());
}

async function seedsOf(r: ContextRepo): Promise<string[]> {
  const opened = openProjectGraphStore(r.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const out = await reviewChanges(r.root, { diff: W }, { graph: opened.value, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result.seeds.map((s) => `${s.ref} ${s.reason}`);
  } finally {
    opened.value.close();
  }
}

function evidenceHash(r: ContextRepo, l: Lang): string | undefined {
  const node = symbolNode(r, l);
  if (node === undefined) return undefined;
  const store = new EvidenceStore();
  const id = repositoryEvidence(store, new SourceReader(r.root), node, "WORKTREE");
  return id === undefined ? undefined : store.get(id)?.contentHash;
}

describe.each(LANGS)("$name overloads (T24.1, C217)", (l) => {
  let repo: ContextRepo;
  /** "before" is committed and indexed, "after" is written and indexed incrementally. */
  async function evolve(before: Parameters<Lang["text"]>[0], after: Parameters<Lang["text"]>[0]): Promise<void> {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq", "-e", ".duo-project");
    repo.write(l.file, l.text(before));
    repo.git("add", "-A");
    repo.git("commit", "-q", "--allow-empty", "-m", "before");
    await repo.index();
    repo.write(l.file, l.text(after));
    await repo.index();
  }

  beforeAll(async () => {
    repo = makeContextRepo(temps, registry, REVIEW_FIXTURE);
    repo.write(l.file, l.text(["one"]));
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "one overload");
    await repo.index();
  });

  it("both overload bodies reach the Context Packet, in source order, and the Symbol ID is unchanged", async () => {
    const idsBefore = symbolIds(repo);
    await evolve(["one"], ["one", "two"]);
    expect(symbolIds(repo)).toEqual(idsBefore);
    expect(lines(symbolNode(repo, l))).toHaveLength(2);
    const packet = await packetOf(repo, l.task);
    const item = packet.code.find((c) => c.id === nodeId(symbolRef(l.file as RepoPath, l.symbol)));
    expect(item?.level).toBe("L3");
    const t = item?.text ?? "";
    expect(t).toContain(l.first);
    expect(t).toContain(l.second);
    expect(t.indexOf(l.first)).toBeLessThan(t.indexOf(l.second));
    expect(t).toContain(`${l.file}:${lines(symbolNode(repo, l)).join(",")}`);
    expect(t).not.toContain("\r");
    expect(t).not.toContain("\uFEFF");
    // The public item keeps one primary source (format unchanged).
    expect(Object.keys(item ?? {}).sort()).toEqual(Object.keys(packet.code[0] ?? {}).sort());
    // Deterministic: the same request gives the same Packet.
    expect(JSON.stringify(await packetOf(repo, l.task))).toBe(JSON.stringify(packet));
  });

  it("reordering keeps both bodies (the first declaration is no longer the one dropped)", async () => {
    await evolve(["one", "two"], ["two", "one"]);
    const t = (await packetOf(repo, l.task)).code.find((c) => c.id.endsWith(`#${l.symbol}`))?.text ?? "";
    expect(t).toContain(l.first);
    expect(t).toContain(l.second);
    expect(t.indexOf(l.second)).toBeLessThan(t.indexOf(l.first));
  });

  it("incremental index equals a clean full rebuild after add, remove, replace, body edit and reorder", async () => {
    const cases: [Parameters<Lang["text"]>[0], Parameters<Lang["text"]>[0]][] = [
      [["one"], ["one", "two"]], [["one", "two"], ["one"]], [["one", "two"], ["one", "twoOther"]], [["one", "two"], ["one", "twoEdited"]], [["one", "two"], ["two", "one"]],
    ];
    for (const [before, after] of cases) {
      await evolve(before, after);
      const incremental = JSON.stringify(repo.graphDump());
      expect(await cleanFull(repo), `${before.join("+")} -> ${after.join("+")}`).toBe(incremental);
    }
  });

  it("Review: a hunk in the second overload seeds the Symbol, not the enclosing type", async () => {
    await evolve(["one", "two"], ["one", "twoEdited"]);
    expect(await seedsOf(repo)).toEqual([`${l.file}#${l.symbol} hunk-overlap`]);
    await evolve(["one"], ["one", "two"]);
    expect(await seedsOf(repo)).toEqual([`${l.file}#${l.symbol} hunk-overlap`]);
    await evolve(["one", "two"], ["one"]);
    expect(await seedsOf(repo)).toEqual([`${l.file}#${l.symbol} hunk-overlap`]);
  });

  it("Evidence: the Symbol's content hash covers every overload body", async () => {
    await evolve(["one", "two"], ["one", "two"]);
    const unchanged = evidenceHash(repo, l);
    await evolve(["one", "two"], ["one", "twoEdited"]);
    const edited = evidenceHash(repo, l);
    expect(unchanged).toBeDefined();
    expect(edited).toBeDefined();
    expect(edited).not.toBe(unchanged);
  });

  it("Evidence invariant (T24.2, C227): the hash is the Symbol aggregate, the pointer is the primary range", async () => {
    await evolve(["one", "two"], ["one", "two"]);
    const node = symbolNode(repo, l) as GraphNode;
    const store = new EvidenceStore();
    const reader = new SourceReader(repo.root);
    const e = store.get(repositoryEvidence(store, reader, node, "WORKTREE") as string);
    const locs = nodeLocations(node);
    expect(locs).toHaveLength(2);
    // contentHash: sha256 of every location's exact slice, in source order, joined by "\n".
    expect(e?.contentHash).toBe(sha256Text(locs.map((x) => reader.slice(x).value).join("\n")));
    // The pointer shows where the Symbol is (its primary range); re-reading it alone does not reproduce the hash.
    expect(e?.pointer.lines).toEqual([node.source?.startLine, node.source?.endLine]);
    expect(e?.contentHash).not.toBe(sha256Text(reader.slice(node.source as NonNullable<GraphNode["source"]>).value ?? ""));
    // One location: the pointer slice reproduces the hash (unchanged since T24.1).
    await evolve(["one"], ["one"]);
    const single = symbolNode(repo, l) as GraphNode;
    const s = new EvidenceStore();
    const se = s.get(repositoryEvidence(s, new SourceReader(repo.root), single, "WORKTREE") as string);
    expect(se?.contentHash).toBe(sha256Text(new SourceReader(repo.root).slice(single.source as NonNullable<GraphNode["source"]>).value ?? ""));
  });

  it("a Symbol without overloads keeps its text and hash; the enclosing type is unchanged", async () => {
    await evolve(["one"], ["one"]);
    const node = symbolNode(repo, l);
    expect(lines(node)).toHaveLength(1);
    const store = new EvidenceStore();
    const id = repositoryEvidence(store, new SourceReader(repo.root), node as GraphNode, "WORKTREE");
    const reader = new SourceReader(repo.root);
    expect(store.excerpt(id as string)).toBe(reader.slice((node as GraphNode).source as NonNullable<GraphNode["source"]>).value);
    const loc = (node as GraphNode).source;
    const t = (await packetOf(repo, l.task)).code.find((c) => c.id.endsWith(`#${l.symbol}`))?.text ?? "";
    expect(t).toContain(`${l.file}:${loc?.startLine}-${loc?.endLine}\n`);
    expect(symbolIds(repo)).toContain(nodeId(symbolRef(l.file as RepoPath, l.owner)));
  });
});

describe("C++ header declarations and source definitions stay separate Symbols (C218 not in T24.1)", () => {
  it("each file keeps its own Symbol; both carry both overloads", async () => {
    const repo = makeContextRepo(temps, registry, REVIEW_FIXTURE);
    repo.write("src/gun.h", ["#pragma once", "class AGun {", "public:", "  int Fire();", "  int Fire(int count);", "};", ""].join("\n"));
    repo.write("src/gun.cpp", ["#include \"gun.h\"", "", "int AGun::Fire() {", "  return 1;", "}", "", "int AGun::Fire(int count) {", "  return count;", "}", ""].join("\n"));
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "gun");
    await repo.index();
    const ids = symbolIds(repo).filter((id) => id.endsWith("#AGun.Fire"));
    expect(ids).toEqual(["sym:src/gun.cpp#AGun.Fire", "sym:src/gun.h#AGun.Fire"]);
    const t = (await packetOf(repo, "AGun Fire count")).code.find((c) => c.id === "sym:src/gun.cpp#AGun.Fire")?.text ?? "";
    expect(t).toContain("return 1;");
    expect(t).toContain("return count;");
  });
});

