/**
 * C241 (T49), end to end with the built duoctl and its MCP server on the Decision Compliance Benchmark 2 timeline
 * (D-002 supersedes D-001 at T3; T4 violates D-002). A Decision claim shows its lifecycle in the CLI, the MCP text
 * summary and the payload; the verdict, the claims and the Review Record are what they were.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Text, stableJson } from "@duo-director/core";
import { reviewRecordBody } from "@duo-director/director";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateFixture } from "../../bench/decision-compliance-02/fixture.mjs";
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
type Claim = any;
const strip = (claims: readonly Claim[]) => claims.map((c: Claim) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "decisionAuthority")));

describe("C241: Review shows the lifecycle of the Decisions it applied", () => {
  let repo: string;
  let commits: Record<string, string>;
  let range: string[];
  beforeAll(() => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-c241-")));
    temps.push(root);
    repo = path.join(root, "repo");
    commits = generateFixture(repo) as Record<string, string>;
    range = ["--from", commits.T3 ?? "", "--to", commits.T4 ?? ""];
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", windowsHide: true });
    git("checkout", "-q", "t0-adoption");
    expect(duoctl(repo, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    git("checkout", "-q", "main");
    expect(duoctl(repo, ["index"]).code).toBe(0);
  });

  it("Scenario B: D-002 is applied as current authority that supersedes D-001; D-001 makes no claim; the verdict is the benchmark's", () => {
    const r = duoctl(repo, ["review", ...range, "--json"]).json().result;
    expect(r.verdict).toBe("BLOCK");
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({ rule: "decision-forbids", subject: { kind: "decision", id: "D-002" }, reason: "forbidden-symbol", provenance: "introduced", blockEligible: true });
    expect(r.claims[0].decisionAuthority).toEqual({ state: "confirmed", active: true, supersedes: "D-001", supersededBy: null });
    expect(r.verdictBasis.blocking).toEqual([r.claims[0].id]);
    expect(r.claims.some((c: Claim) => c.subject.id === "D-001")).toBe(false);

    const en = duoctl(repo, ["review", ...range]).stdout.split("\n");
    const head = en.findIndex((l) => l.includes("decision-forbids") && l.includes("D-002"));
    expect(en[head + 1]?.trim()).toBe("authority: current authority · supersedes D-001");
    expect(en.filter((l) => l.includes("authority:"))).toHaveLength(1);
    expect(duoctl(repo, ["review", ...range, "--locale", "ko"]).stdout).toContain("Decision 상태: 현재 authority · 대체 대상 D-001");
    expect(duoctl(repo, ["review", ...range, "--locale", "ko"]).stdout).not.toContain("authority: current");
  });

  it("the supersession commit: D-001 claims say superseded by D-002, shown with --verbose and hidden with its ALIGNED claim otherwise", () => {
    const from = execFileSync("git", ["rev-parse", (commits.T3 ?? "") + "^"], { cwd: repo, encoding: "utf8" }).trim();
    const args = ["review", "--from", from, "--to", commits.T3 ?? ""];
    const r = duoctl(repo, [...args, "--json"]).json().result;
    expect(r.verdict).toBe("PASS");
    const d001 = r.claims.filter((c: Claim) => c.subject.id === "D-001");
    expect(d001.length).toBeGreaterThan(0);
    for (const c of d001) expect(c.decisionAuthority).toEqual({ state: "superseded", active: false, supersedes: null, supersededBy: "D-002" });
    expect(duoctl(repo, [...args, "--verbose"]).stdout).toContain("authority: superseded · superseded by D-002");
    expect(duoctl(repo, args).stdout).not.toContain("authority:");
  });

  it("the Review Record body and ID are the same with or without the lifecycle facts, and the record does not hold them", () => {
    const out = duoctl(repo, ["review", ...range, "--record", "--json"]).json();
    const r = out.result;
    const id = (body: unknown) => "review-" + sha256Text(stableJson(body)).slice(7, 23);
    expect(stableJson(reviewRecordBody(r))).toBe(stableJson(reviewRecordBody({ ...r, claims: strip(r.claims) })));
    expect(out.meta.record.id).toBe(id(reviewRecordBody(r)));
    expect(out.meta.record.id).toBe(id(reviewRecordBody({ ...r, claims: strip(r.claims) })));
    expect(fs.readFileSync(path.join(repo, out.meta.record.path), "utf8")).not.toContain("decisionAuthority");
  });

  it("MCP: the payload carries the lifecycle, the text summary names it next to the finding, and there are still 9 tools", async () => {
    const s = await startMcp(repo);
    sessions.push(s);
    expect((await s.client.listTools()).tools).toHaveLength(9);
    const rv = await s.call("duo_review_changes", { from: commits.T3, to: commits.T4 });
    expect(rv.structuredContent.verdict).toBe("BLOCK");
    expect(rv.structuredContent.claims.map((c: Claim) => c.decisionAuthority)).toEqual([{ state: "confirmed", active: true, supersedes: "D-001", supersededBy: null }]);
    const text = rv.content.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("- CONFLICT decision-forbids D-002: forbidden-symbol (not-in-adoption-baseline) [blocking; current authority; supersedes D-001]");
    const cli = duoctl(repo, ["review", ...range, "--json"]).json().result;
    expect(strip(rv.structuredContent.claims)).toEqual(strip(cli.claims));
  });
});
