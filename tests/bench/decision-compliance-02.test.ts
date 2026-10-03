/**
 * Decision Compliance Benchmark 2 tooling (bench/decision-compliance-02): the timeline is deterministic (same commit
 * SHAs on every OS), DIY-0/1/2 give the recorded results, and every stored DUO run projects to the recorded hash.
 * Runs no DUO and no external tool.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { canonicalReview, sha256 } from "../../bench/decision-compliance/canonical.mjs";
import { D001_SUPERSEDED, D002_CONFIRMED, generateFixture } from "../../bench/decision-compliance-02/fixture.mjs";

vi.setConfig({ testTimeout: 120_000 });
const DIR = fileURLToPath(new URL("../../bench/decision-compliance-02/", import.meta.url));
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(DIR, rel), "utf8"));
const manifest = read("manifest.json");
const summary = read("evidence/summary.json");
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

describe("Decision Compliance Benchmark 2", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-dc02-test-")));
  temps.push(root);
  const repo = path.join(root, "repo");
  const commits = generateFixture(repo) as Record<string, string>;
  const sha = (step: string) => { const v = commits[step]; if (v === undefined) throw new Error("no commit for " + step); return v; };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  const run = (script: string, args: string[]) => {
    try { return { out: execFileSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" }), status: 0 }; }
    catch (e) { const err = e as { stdout: string; status: number }; return { out: err.stdout, status: err.status }; }
  };

  it("generates the manifest's timeline with the supersession written by the public flow", () => {
    expect(commits).toEqual(manifest.commits);
    expect(git("show", "t3-supersede:.duo-project/decisions/D-001.yaml")).toBe(D001_SUPERSEDED);
    expect(git("show", "t3-supersede:.duo-project/decisions/D-002.yaml")).toBe(D002_CONFIRMED);
    expect(git("ls-files", "--eol")).not.toMatch(/w\/crlf/u);
  });

  it("DIY-0, DIY-1 and DIY-2 give the recorded result for every scenario", () => {
    const state1 = path.join(root, "adoption.json");
    const state2 = path.join(root, "decision-adoption.json");
    const diy0 = path.join(DIR, "..", "decision-compliance", "diy", "session-store-gate.mjs");
    const diy1 = path.join(DIR, "diy", "adoption-gate.mjs");
    const diy2 = path.join(DIR, "diy", "decision-gate.mjs");
    run(diy1, ["adopt", "--at", sha("T0"), "--state", state1]);
    run(diy2, ["adopt", "--at", sha("T0"), "--registry", path.join(DIR, "diy", "registry-t0.json"), "--state", state2]);
    expect(JSON.parse(fs.readFileSync(state1, "utf8"))).toEqual(read("evidence/diy-1/adoption-state.json"));
    expect(JSON.parse(fs.readFileSync(state2, "utf8"))).toEqual(read("evidence/diy-2/adoption-state.json"));
    for (const s of summary.scenarios as { id: string; from: string; to: string; registry: string }[]) {
      const [base, head] = [sha(s.from), sha(s.to)];
      const results = {
        "diy-0": run(diy0, ["--base", base, "--head", head]),
        "diy-1": run(diy1, ["check", "--base", base, "--head", head, "--state", state1]),
        "diy-2": run(diy2, ["check", "--base", base, "--head", head, "--registry", path.join(DIR, "diy", s.registry), "--state", state2]),
      };
      for (const [name, r] of Object.entries(results)) {
        expect(JSON.parse(r.out), name + " " + s.id).toEqual(read(path.join("evidence", name, s.id + ".json")));
        expect(r.status, name + " " + s.id).toBe(summary.diy[name][s.id].exitCode);
      }
    }
  });

  it("every stored DUO review run projects to the recorded canonical hash", () => {
    for (const s of summary.scenarios as { id: string }[]) {
      const runs = fs.readdirSync(path.join(DIR, "evidence", "duo", s.id)).filter((f) => /^review-\d+\.json$/u.test(f));
      expect(runs.length, s.id).toBe(summary.runsPerScenario);
      for (const f of runs) expect(sha256(canonicalReview(read(path.join("evidence", "duo", s.id, f)))), s.id + " " + f).toBe(summary.duo[s.id].canonicalHash);
    }
  });
});
