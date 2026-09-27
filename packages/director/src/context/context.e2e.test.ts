import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PACKET_CACHE_DIR } from "./cache.js";
import { renderContextMarkdown } from "./render.js";
import { contextRegistry, makeContextRepo, type ContextRepo } from "./testing.js";
import type { ContextPacket, ContextResult, PacketItem } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;

beforeAll(async () => {
  registry = await contextRegistry();
  repo = makeContextRepo(temps, registry);
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

function packetOf(r: ContextResult): ContextPacket {
  expect(r.status).toBe("ready");
  if (r.packet === undefined) throw new Error("no packet");
  return r.packet;
}
const refs = (items: readonly PacketItem[]) => items.map((i) => i.ref);
const allItems = (p: ContextPacket) => [...p.intent.requirements, ...p.intent.constraints, ...p.decisions.active, ...p.code, ...p.tests, ...p.issues];

describe("Context Compiler on the context fixture (TASK-010)", () => {
  it("Requirement ID: Requirement → active Decision → implementing Symbol → validating Test, with the related pending proposal", async () => {
    const p = packetOf(await repo.compile({ task: "AUTH-03" }));
    expect(p.seeds).toEqual([{ id: "req:AUTH-03", ref: "AUTH-03", match: "id", term: "AUTH-03" }]);
    expect(refs(p.intent.requirements)).toEqual(["AUTH-03", "AUTH-01"]);
    expect(p.intent.requirements[0]).toMatchObject({ level: "L3", rank: 1 });
    expect(p.intent.requirements[0]?.text).toContain("Access tokens live 15 minutes and refresh tokens 14 days.");
    expect(refs(p.decisions.active)).toEqual(["D-015"]);
    expect(p.decisions.active[0]?.via.steps).toEqual([{ from: "D-015", type: "GOVERNS", to: "AUTH-03", provenance: "declared" }]);
    expect(p.decisions.history).toEqual([{ id: "D-004", title: "Long-lived JWT access tokens", state: "superseded", supersededBy: "D-015" }]);
    expect(refs(p.intent.constraints)).toEqual(["CON-001"]);
    expect(refs(p.code).slice(0, 3)).toEqual([
      "src/auth/AuthService.ts#AuthService.refresh", "src/auth/token-store.ts#TokenStore.rotate", "src/auth/AuthService.ts#AuthService.login",
    ]);
    expect(p.code[0]?.via.steps).toEqual([{ from: "src/auth/AuthService.ts#AuthService.refresh", type: "IMPLEMENTS", to: "AUTH-03", provenance: "declared" }]);
    expect(refs(p.tests)[0]).toBe("src/auth/AuthService.test.ts#AuthService > refresh returns a new access token");
    expect(refs(p.issues)).toEqual(["GAME-42", "M1"]);
    expect(p.pendingDecisions.map((d) => [d.id, d.confirmed, d.status, d.requiresHumanDecision, d.relatesTo])).toEqual([
      ["P-018", false, "PENDING / NOT CONFIRMED", true, ["AUTH-03"]],
    ]);
    expect(p.requiresHumanDecision).toBe(true);
    expect(p.signals).toEqual([{ kind: "unconfirmed-decision", ids: ["P-018"] }]);
    const md = renderContextMarkdown(p);
    expect(md).toContain("P-018 Refresh token rotation — PENDING / NOT CONFIRMED · requires human decision");
    expect(md).not.toContain("P-017");
    // The superseded Decision is history only; its body never reaches the Packet.
    expect(md).not.toContain("JWT access token valid for 30 days");
    expect(allItems(p).map((i) => i.ref)).not.toContain("D-004");
  });

  it("the proposal is never confirmed context", async () => {
    const p = packetOf(await repo.compile({ task: "AUTH-03" }));
    const confirmed = [...p.intent.requirements, ...p.intent.constraints, ...p.decisions.active].map((i) => i.text).join("\n");
    expect(confirmed).not.toContain("rotate_on_use");
    expect(p.pendingDecisions[0]?.text).toContain("proposed answer: rotate_on_use");
  });

  it("AC-010-01: every required node of the fixture scenarios is in the Packet (coverage 100%)", async () => {
    const scenarios: Record<string, readonly string[]> = {
      "AUTH-03": ["req:AUTH-03", "dec:D-015", "dec:CON-001", "sym:src/auth/AuthService.ts#AuthService.refresh", "sym:src/auth/token-store.ts#TokenStore.rotate",
        "test:src/auth/AuthService.test.ts#AuthService > refresh returns a new access token", "issue:GAME-42"],
      "GAME-42": ["issue:GAME-42", "req:AUTH-03", "dec:D-015", "sym:src/auth/AuthService.ts#AuthService.refresh"],
      "LOBBY-01": ["req:LOBBY-01", "dec:D-020", "dec:CON-002", "sym:src/lobby/matchmaker.ts#Matchmaker.fill", "test:src/lobby/matchmaker.test.ts#Matchmaker > fills a room with eight players"],
    };
    for (const [task, required] of Object.entries(scenarios)) {
      const ids = new Set(allItems(packetOf(await repo.compile({ task }))).map((i) => i.id));
      expect(required.filter((id) => !ids.has(id))).toEqual([]);
    }
  });

  it("the proposal text stays out of the confirmed sections", async () => {
    const p = packetOf(await repo.compile({ task: "AUTH-03" }));
    const confirmed = [...p.intent.requirements, ...p.intent.constraints, ...p.decisions.active].map((i) => i.text).join("\n");
    expect(confirmed).not.toContain("rotate_on_use");
    expect(p.pendingDecisions[0]?.text).toContain("proposed answer: rotate_on_use");
  });

  it("Issue ID (lower-case key and free text around it): the Issue's Requirement and Decision", async () => {
    const p = packetOf(await repo.compile({ task: "game-42 refresh token 만료 처리" }));
    expect(p.seeds[0]).toMatchObject({ ref: "GAME-42", match: "id" });
    expect(refs(p.intent.requirements)).toContain("AUTH-03");
    expect(refs(p.decisions.active)).toEqual(["D-015"]);
    expect(p.pendingDecisions.map((d) => d.id)).toEqual(["P-018"]);
    expect(p.pendingDecisions[0]?.requiresHumanDecision).toBe(true);
  });

  it("Decision ID of a superseded Decision: the successor is the active Decision, the old one history", async () => {
    const p = packetOf(await repo.compile({ task: "D-004" }));
    expect(p.seeds.map((s) => s.ref)).toEqual(["D-004"]);
    expect(refs(p.decisions.active)).toEqual(["D-015"]);
    expect(p.decisions.active[0]?.via.steps).toEqual([{ from: "D-004", type: "SUPERSEDED_BY", to: "D-015", provenance: "declared" }]);
    expect(p.decisions.history.map((h) => h.id)).toEqual(["D-004"]);
  });

  it("free-text title: keyword seeds, marked as such", async () => {
    const p = packetOf(await repo.compile({ task: "Refresh Token" }));
    expect(p.seeds.every((s) => s.match === "keyword")).toBe(true);
    expect(p.seeds.map((s) => s.ref)).toContain("AUTH-03");
    expect(refs(p.intent.requirements)).toContain("AUTH-03");
    expect(p.limitations.map((l) => l.code)).toContain("keyword-seeds");
  });

  it("symbol name: the Symbol leads the code and its Requirement follows", async () => {
    const p = packetOf(await repo.compile({ task: "AuthService.refresh" }));
    expect(p.seeds[0]).toEqual({ id: "sym:src/auth/AuthService.ts#AuthService.refresh", ref: "src/auth/AuthService.ts#AuthService.refresh", match: "symbol", term: "AuthService.refresh" });
    expect(p.code[0]?.ref).toBe("src/auth/AuthService.ts#AuthService.refresh");
    expect(refs(p.intent.requirements)[0]).toBe("AUTH-03");
  });

  it("an unrelated task gets the other proposal, not P-018", async () => {
    const p = packetOf(await repo.compile({ task: "LOBBY-01" }));
    expect(p.pendingDecisions.map((d) => d.id)).toEqual(["P-017"]);
    expect(refs(p.decisions.active)).toEqual(["D-020"]);
    expect(refs(p.intent.constraints)).toEqual(["CON-002"]);
  });

  it("CHANGED_WITH is historical and ranks after every structural relation", async () => {
    const p = packetOf(await repo.compile({ task: "src/auth/AuthService.ts", budget: 20_000 }));
    const historical = p.code.filter((i) => i.tier === "code-historical");
    expect(historical.map((i) => i.ref)).toContain("src/util/config.ts#loadConfig");
    expect(historical.every((h) => h.via.steps.some((s) => s.type === "CHANGED_WITH" && s.provenance === "git"))).toBe(true);
    const others = p.code.filter((i) => i.tier !== "code-historical");
    expect(Math.min(...historical.map((h) => h.rank))).toBeGreaterThan(Math.max(...others.map((o) => o.rank)));
  });

  it("ambiguous seed: several symbols of one name and nothing exact", async () => {
    const r = await repo.compile({ task: "fix normalize" });
    expect(r.status).toBe("ambiguous");
    expect(r.packet).toBeUndefined();
    expect(r.resolution?.ambiguities).toEqual([{
      term: "normalize", reason: "symbol-name",
      options: [
        { id: "sym:src/game/physics.ts#normalize", ref: "src/game/physics.ts#normalize", kind: "symbol", title: "normalize" },
        { id: "sym:src/util/text.ts#normalize", ref: "src/util/text.ts#normalize", kind: "symbol", title: "normalize" },
      ],
    }]);
  });

  it("no seed and unknown IDs: insufficient context with structured signals", async () => {
    const none = await repo.compile({ task: "quantum entanglement" });
    expect(none).toMatchObject({ status: "insufficient-context", signals: [{ kind: "no-seed" }] });
    const unknown = await repo.compile({ task: "AUTH-99" });
    expect(unknown).toMatchObject({ status: "insufficient-context", signals: [{ kind: "no-seed" }, { kind: "unresolved-id", ids: ["AUTH-99"] }] });
  });

  it("budget: enough → nothing omitted; short → ranked omission, never over budget", async () => {
    const full = packetOf(await repo.compile({ task: "AUTH-03", budget: 20_000 }));
    expect(full.omittedCandidates).toEqual([]);
    expect(full.truncated).toBe(false);
    const short = packetOf(await repo.compile({ task: "AUTH-03", budget: 1000 }));
    expect(short.metrics.budget.used).toBeLessThanOrEqual(1000);
    expect(short.truncated).toBe(true);
    expect(short.omittedCandidates.length).toBeGreaterThan(0);
    // Mandatory items survive: the seed, the active Decision, the matched Constraint, the pending decision.
    expect(refs(short.intent.requirements)).toContain("AUTH-03");
    expect(refs(short.decisions.active)).toEqual(["D-015"]);
    expect(refs(short.intent.constraints)).toEqual(["CON-001"]);
    expect(short.pendingDecisions.map((d) => d.id)).toEqual(["P-018"]);
    // Omitted candidates are never mandatory ones and never also included. An item that does not fit is skipped and a
    // smaller lower-ranked one may still fit (05 §5), so omission is not a strict rank cut-off.
    const included = new Set(allItems(short).map((i) => i.id));
    for (const o of short.omittedCandidates) {
      expect(included.has(o.id)).toBe(false);
      expect(o.tier).not.toBe("decision");
      expect(o.ref).not.toBe("AUTH-03");
    }
    expect(short.omittedCandidates.map((o) => o.rank)).toEqual([...short.omittedCandidates.map((o) => o.rank)].sort((a, b) => a - b));
    expect(renderContextMarkdown(short)).toContain(`omitted: ${short.omittedCandidates.length} lower-ranked candidates`);
  });

  it("AC-010-02 property: over many budgets the rendered Packet never exceeds its budget", async () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 12; i++) {
      const budget = 1000 + (next() % 5000);
      const task = ["AUTH-03", "GAME-42", "LOBBY-01", "src/auth/AuthService.ts"][i % 4] ?? "AUTH-03";
      const p = packetOf(await repo.compile({ task, budget }));
      expect(p.metrics.budget.used).toBeLessThanOrEqual(budget);
      expect(p.metrics.budget.used).toBe(p.metrics.rendered.tokens);
      expect(p.metrics.budget.remaining).toBe(budget - p.metrics.budget.used);
    }
  });

  it("node limit: the traversal stops at the limit and says so", async () => {
    const p = packetOf(await repo.compile({ task: "AUTH-03", budget: 20_000 }, { nodeLimit: 4 }));
    expect(p.limitations.map((l) => l.code)).toContain("traversal-truncated");
    expect(p.truncated).toBe(true);
  });

  it("AC-010-03: the same input gives byte-identical Packets", async () => {
    const a = packetOf(await repo.compile({ task: "GAME-42" }));
    const b = packetOf(await repo.compile({ task: "GAME-42" }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(renderContextMarkdown(b)).toBe(renderContextMarkdown(a));
  });

  it("AC-010-04 / AC-010-06: no LLM call; every token value carries the estimator and sizes", async () => {
    const r = await repo.compile({ task: "AUTH-03" });
    const p = packetOf(r);
    expect(p.metrics.llmCalls).toBe(0);
    expect(r.metrics?.llmCalls).toBe(0);
    expect(p.metrics.estimator).toBe("o200k_base");
    expect(p.metrics.rendered).toMatchObject({ estimator: "o200k_base", tokens: p.metrics.budget.used });
    expect(p.metrics.rendered.bytes).toBe(Buffer.byteLength(renderContextMarkdown(p), "utf8"));
    expect(r.metrics).toMatchObject({ estimator: "o200k_base", repository: { files: expect.any(Number), bytes: expect.any(Number), chars: expect.any(Number) } });
    expect(renderContextMarkdown(p)).toContain("(o200k_base)");
  });

  it("task text is search input only: odd characters reach no path, shell or query", async () => {
    const r = await repo.compile({ task: "../../etc/passwd; rm -rf / $(whoami) ' OR 1=1 --" });
    expect(["insufficient-context", "ready"]).toContain(r.status);
    expect(fs.existsSync(path.join(repo.root, ".duo-project", "project.yaml"))).toBe(true);
  });
});

describe("freshness, cache and redaction (TASK-010)", () => {
  let work: ContextRepo;
  beforeAll(async () => {
    work = makeContextRepo(temps, registry);
  });

  it("missing index: index-required, and the Compiler does not index", async () => {
    const r = await work.compile({ task: "AUTH-03" });
    expect(r).toMatchObject({ status: "index-required", freshness: { status: "missing", fullRebuildRequired: true } });
    expect(r.packet).toBeUndefined();
    expect(fs.existsSync(path.join(work.root, ".duo-project/generated/index-state.json"))).toBe(false);
  });

  it("stale index: index-required until the Indexer runs", async () => {
    await work.index();
    expect((await work.compile({ task: "AUTH-03" })).status).toBe("ready");
    work.edit("src/game/scoring.ts", "/** Match scoring and ranking. */", "/** Match scoring and ranking (v2). */");
    const r = await work.compile({ task: "AUTH-03" });
    expect(r).toMatchObject({ status: "index-required", freshness: { status: "stale", fullRebuildRequired: false } });
    await work.index();
  });

  it("cache: miss then hit; a hit equals a fresh compile", async () => {
    const first = await work.compile({ task: "AUTH-03" }, { cache: true });
    expect(first.cache).toEqual({ status: "miss", written: true });
    const again = await work.compile({ task: "AUTH-03" }, { cache: true });
    expect(again.cache).toEqual({ status: "hit", written: false });
    const fresh = await work.compile({ task: "AUTH-03" });
    expect(fresh.cache.status).toBe("off");
    expect(JSON.stringify(again.packet)).toBe(JSON.stringify(fresh.packet));
    expect(fs.readdirSync(path.join(work.root, PACKET_CACHE_DIR))).toEqual([`${packetOf(first).dependencyDigest.slice(7)}.json`]);
  });

  it("an unrelated file change keeps the Packet dependencies: cache reuse", async () => {
    const before = packetOf(await work.compile({ task: "AUTH-03" }, { cache: true }));
    work.edit("src/game/physics.ts", "/** Minimal 2D physics for the match simulation. */", "/** Minimal 2D physics for the match simulation (tuned). */");
    await work.index();
    const after = await work.compile({ task: "AUTH-03" }, { cache: true });
    expect(after.cache.status).toBe("hit");
    expect(packetOf(after).dependencyDigest).toBe(before.dependencyDigest);
  });

  it("a selected Requirement body change: same graph topology, new digest, cache miss", async () => {
    const before = packetOf(await work.compile({ task: "AUTH-03" }, { cache: true }));
    const edges = work.graphDump().edges;
    const revision = work.meta("graph_revision");
    work.edit(".duo-project/specs/auth.md", "Access tokens live 15 minutes", "Access tokens live 10 minutes");
    await work.index();
    expect(work.graphDump().edges).toEqual(edges);
    expect(work.meta("graph_revision")).toBe(revision);
    const after = await work.compile({ task: "AUTH-03" }, { cache: true });
    expect(after.cache.status).toBe("miss");
    expect(packetOf(after).dependencyDigest).not.toBe(before.dependencyDigest);
    expect(packetOf(after).intent.requirements[0]?.text).toContain("Access tokens live 10 minutes");
  });

  it("a selected Symbol change: new digest, cache miss", async () => {
    const before = packetOf(await work.compile({ task: "AUTH-03" }, { cache: true }));
    work.edit("src/auth/AuthService.ts", 'throw new Error("unknown refresh token");', 'throw new Error("refresh token not found");');
    await work.index();
    const after = await work.compile({ task: "AUTH-03" }, { cache: true });
    expect(after.cache.status).toBe("miss");
    expect(packetOf(after).dependencyDigest).not.toBe(before.dependencyDigest);
    expect(packetOf(after).code[0]?.text).toContain("refresh token not found");
  });

  it("a budget change: new digest", async () => {
    const a = packetOf(await work.compile({ task: "AUTH-03", budget: 6000 }, { cache: true }));
    const b = await work.compile({ task: "AUTH-03", budget: 5000 }, { cache: true });
    expect(b.cache.status).toBe("miss");
    expect(packetOf(b).dependencyDigest).not.toBe(a.dependencyDigest);
  });

  it("a corrupt cache entry is a miss and the same Packet is rebuilt", async () => {
    const p = packetOf(await work.compile({ task: "AUTH-03" }, { cache: true }));
    fs.writeFileSync(path.join(work.root, PACKET_CACHE_DIR, `${p.dependencyDigest.slice(7)}.json`), "{ broken");
    const r = await work.compile({ task: "AUTH-03" }, { cache: true });
    expect(r.cache.status).toBe("miss");
    expect(JSON.stringify(r.packet)).toBe(JSON.stringify(p));
  });

  it("AC-010-05: known secret formats are redacted before they reach a Packet", async () => {
    const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    work.edit("src/auth/AuthService.ts", "   * Unknown or revoked tokens are rejected.", `   * Unknown or revoked tokens are rejected. Example: ${secret}`);
    await work.index();
    const p = packetOf(await work.compile({ task: "AUTH-03 " + secret }));
    const md = renderContextMarkdown(p);
    expect(md).not.toContain(secret);
    expect(md).toContain("[REDACTED]");
    expect(p.request.task).toBe("AUTH-03 [REDACTED]");
    expect(p.metrics.redactions).toBeGreaterThanOrEqual(1);
  });
});
