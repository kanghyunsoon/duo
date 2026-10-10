/**
 * H-80 (C239), end to end with the built duoctl and its MCP server on the Decision Compliance Benchmark 1 fixture
 * (T31). The valid control-only change used to be WARN only because of a missing-intent gap (20/20 controls in T31
 * and T32). It is now PASS and the gap is still shown in the CLI, the payload and the MCP text. The violation stays
 * BLOCK, a real WARN still fails --strict, an unresolved explicit ID still asks, and old Review Records are kept.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Text, stableJson } from "@duo-director/core";
import { listReviewRecords, reviewRecordBody } from "@duo-director/director";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateFixture } from "../../bench/decision-compliance/fixture.mjs";
import { startMcp, type McpSession } from "../mcp/support.js";
import { duoctl } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
const sessions: McpSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.close().catch(() => undefined);
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed CLI JSON
type Json = any;
const TASK = "Add a token signer and trim token values before verification";
const NOTE = "No confirmed Requirement or Decision is linked to this task.";
const UNRESOLVED = "REQ-999 is not in the Project Truth. Which Requirement or Issue do you mean?";
const recordId = (body: unknown) => "review-" + sha256Text(stableJson(body)).slice(7, 23);
const shown = (r: Json) => (r.gaps?.gaps ?? []).filter((g: Json) => g.action !== "ignore");

describe("H-80: missing-intent is surfaced, not a WARN by itself (Benchmark 1 fixture)", () => {
  let repo: string;
  let commits: { baseline: string; change: string; controlOnly: string };
  let branch = "";
  const on = (b: "control-only" | "main") => {
    if (branch === b) return;
    execFileSync("git", ["checkout", "-q", b], { cwd: repo, windowsHide: true });
    expect(duoctl(repo, ["index"]).code).toBe(0);
    branch = b;
  };
  const control = () => ["review", "--from", commits.baseline, "--to", commits.controlOnly];
  const change = () => ["review", "--from", commits.baseline, "--to", commits.change];
  const exits = (args: readonly string[]) => Object.fromEntries((
    [["default", []], ["block", ["--fail-on", "block"]], ["ask", ["--fail-on", "ask"]], ["warn", ["--fail-on", "warn"]], ["strict", ["--strict"]]] as const
  ).map(([k, extra]) => [k, duoctl(repo, [...args, ...extra]).code]));

  beforeAll(() => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-h80-")));
    temps.push(root);
    repo = path.join(root, "repo");
    commits = generateFixture(repo) as typeof commits;
    execFileSync("git", ["checkout", "-q", "baseline"], { cwd: repo, windowsHide: true });
    expect(duoctl(repo, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
  });

  it("control-only, no task: PASS with 0 claims, the missing-intent gap kept, every gate exits 0", () => {
    on("control-only");
    const r = duoctl(repo, [...control(), "--json"]).json().result;
    expect(r.claims).toEqual([]);
    expect(shown(r).map((g: Json) => [g.kind, g.relevance, g.action, g.reasons])).toEqual([["missing-intent", "direct", "surface", [{ code: "no-confirmed-intent" }]]]);
    expect(r.gaps.requiresHumanInput).toBe(false);
    expect(r.gaps.primary).toBeUndefined();
    expect(r.verdict).toBe("PASS");
    expect(r.verdictBasis).toEqual({ blocking: [], ask: [], warn: [] });
    const out = duoctl(repo, control()).stdout.split("\n");
    expect(out[0]).toMatch(/^PASS {2}0 claims/u);
    expect(out.slice(out.indexOf("Knowledge gaps:"), out.indexOf("Knowledge gaps:") + 2)).toEqual(["Knowledge gaps:", "  - " + NOTE]);
    expect(exits(control())).toEqual({ default: 0, block: 0, ask: 0, warn: 0, strict: 0 });
  });

  it("control-only with a natural-language task: the ALIGNED scope claims and the gap stay, PASS", () => {
    on("control-only");
    const r = duoctl(repo, [...control(), "--task", TASK, "--json"]).json().result;
    expect(r.claims.map((c: Json) => [c.rule, c.alignment])).toEqual([["scope-relevance", "ALIGNED"], ["scope-relevance", "ALIGNED"]]);
    expect(shown(r).map((g: Json) => [g.kind, g.action])).toEqual([["missing-intent", "surface"]]);
    expect(r.verdict).toBe("PASS");
    expect(exits([...control(), "--task", TASK])).toMatchObject({ warn: 0, strict: 0 });
  });

  it("an unresolved explicit ID still asks; the missing-intent gap is no WARN basis", () => {
    on("control-only");
    const args = [...control(), "--task", "Implement REQ-999 token signing"];
    const r = duoctl(repo, [...args, "--json"]).json().result;
    const ask = shown(r).find((g: Json) => g.kind === "unresolved-target");
    expect(ask).toMatchObject({ action: "ask", target: "REQ-999" });
    expect(shown(r).map((g: Json) => [g.kind, g.action])).toEqual([["unresolved-target", "ask"], ["missing-intent", "surface"]]);
    expect(r.gaps.requiresHumanInput).toBe(true);
    expect(r.gaps.primary).toBe(ask.id);
    expect(r.verdict).toBe("ASK");
    expect(r.verdictBasis).toEqual({ blocking: [], ask: [ask.id], warn: [] });
    expect(exits(args)).toEqual({ default: 0, block: 0, ask: 3, warn: 3, strict: 3 });
  });

  it("a task naming D-001 has no missing-intent gap and stays PASS", () => {
    on("control-only");
    const r = duoctl(repo, [...control(), "--task", "Follow D-001 while adding the token signer", "--json"]).json().result;
    expect(shown(r)).toEqual([]);
    expect(r.verdict).toBe("PASS");
    expect(r.verdictBasis).toEqual({ blocking: [], ask: [], warn: [] });
  });

  it("MCP: same payload gaps as the CLI, the PASS and ASK text summaries show the gap wording, still 9 tools", async () => {
    on("control-only");
    const s = await startMcp(repo);
    sessions.push(s);
    expect((await s.client.listTools()).tools).toHaveLength(9);
    const pass = await s.call("duo_review_changes", { from: commits.baseline, to: commits.controlOnly });
    const cli = duoctl(repo, [...control(), "--json"]).json().result;
    expect(pass.structuredContent.verdict).toBe("PASS");
    expect(pass.structuredContent.gaps).toEqual(cli.gaps);
    expect(pass.content.map((c) => c.text ?? "").join("\n")).toBe(["Verdict PASS · 0 claims · llm calls 0", "Knowledge gaps:", "- " + NOTE].join("\n"));
    const ask = await s.call("duo_review_changes", { from: commits.baseline, to: commits.controlOnly, task: "Implement REQ-999 token signing" });
    expect(ask.structuredContent.verdict).toBe("ASK");
    expect(ask.content.map((c) => c.text ?? "").join("\n")).toContain(["Knowledge gaps:", "Question for the human: " + UNRESOLVED, "- " + NOTE].join("\n"));
    const linked = await s.call("duo_review_changes", { from: commits.baseline, to: commits.controlOnly, task: "Follow D-001 while adding the token signer" });
    expect(linked.content.map((c) => c.text ?? "").join("\n")).not.toContain("Knowledge gaps:");
  });

  it("Review Record: the new PASS body gets a new ID; a record written by the WARN policy is kept byte for byte and still readable", async () => {
    on("control-only");
    const r = duoctl(repo, [...control(), "--json"]).json().result;
    const gapId = shown(r)[0].id as string;
    const oldBody = reviewRecordBody({ ...r, verdict: "WARN", verdictBasis: { ...r.verdictBasis, warn: [gapId] } }) as Record<string, unknown>;
    const oldId = recordId(oldBody);
    const oldFile = path.join(repo, ".duo-project", "reviews", oldId + ".json");
    const oldText = JSON.stringify({ id: oldId, recorded: { by: "benchmark-maintainer", at: "2026-10-09T00:00:00.000Z" }, ...oldBody }, null, 2) + "\n";
    fs.writeFileSync(oldFile, oldText);
    const out = duoctl(repo, [...control(), "--record", "--json"]).json();
    expect(out.meta.record.id).toBe(recordId(reviewRecordBody(out.result)));
    expect(out.meta.record.id).not.toBe(oldId);
    expect(fs.readFileSync(oldFile, "utf8")).toBe(oldText);
    const listed = await listReviewRecords(repo);
    expect(listed.diagnostics).toEqual([]);
    const byId = new Map((listed.value ?? []).map((e) => [e.id, e.body] as const));
    expect((byId.get(oldId)?.review as Json).verdict).toBe("WARN");
    expect((byId.get(out.meta.record.id)?.review as Json).verdict).toBe("PASS");
    expect(byId.get(out.meta.record.id)?.format).toBe("duo.review-record/1");
    expect(byId.get(out.meta.record.id)?.gaps).toEqual(byId.get(oldId)?.gaps);
  });

  it("the violation stays BLOCK on the same claims; only the gap ID leaves verdictBasis.warn, so the Record ID changes", () => {
    on("main");
    const r = duoctl(repo, [...change(), "--json"]).json().result;
    const introduced = r.claims.find((c: Json) => c.provenance === "introduced");
    const touched = r.claims.find((c: Json) => c.provenance === "pre-existing-touched");
    expect(r.claims.map((c: Json) => [c.rule, c.alignment, c.provenance, c.blockEligible])).toEqual([
      ["decision-forbids", "CONFLICT", "pre-existing-touched", false], ["decision-forbids", "CONFLICT", "introduced", true],
    ]);
    expect(shown(r).map((g: Json) => [g.kind, g.action])).toEqual([["missing-intent", "surface"]]);
    expect(r.verdict).toBe("BLOCK");
    expect(r.verdictBasis).toEqual({ blocking: [introduced.id], ask: [], warn: [touched.id] });
    expect(exits(change())).toEqual({ default: 0, block: 4, ask: 4, warn: 4, strict: 4 });
    const before = reviewRecordBody({ ...r, verdictBasis: { ...r.verdictBasis, warn: [touched.id, shown(r)[0].id] } });
    expect((before?.review as Json).verdict).toBe("BLOCK");
    expect(recordId(reviewRecordBody(r))).not.toBe(recordId(before));
  });

  it("a real WARN (a touched pre-existing violation) with the gap is still WARN and still fails --fail-on warn and --strict", () => {
    on("main");
    const args = [...change(), "--files", "src/legacy/cookie-session-store.ts"];
    const r = duoctl(repo, [...args, "--json"]).json().result;
    expect(r.claims.map((c: Json) => c.provenance)).toEqual(["pre-existing-touched"]);
    expect(shown(r).map((g: Json) => g.kind)).toEqual(["missing-intent"]);
    expect(r.verdict).toBe("WARN");
    expect(r.verdictBasis).toEqual({ blocking: [], ask: [], warn: [r.claims[0].id] });
    expect(exits(args)).toEqual({ default: 0, block: 0, ask: 0, warn: 2, strict: 2 });
  });
});
