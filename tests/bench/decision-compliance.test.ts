/**
 * Decision Compliance Benchmark 1 tooling (bench/decision-compliance): the fixture is deterministic (same commit SHAs
 * on every OS), the DIY gate gives the recorded result, and the canonical projection of the stored DUO runs gives the
 * recorded hash. Runs no DUO and no external tool.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { canonicalReview, sha256 } from "../../bench/decision-compliance/canonical.mjs";
import { generateFixture, POLICY } from "../../bench/decision-compliance/fixture.mjs";

vi.setConfig({ testTimeout: 60_000 });
const DIR = fileURLToPath(new URL("../../bench/decision-compliance/", import.meta.url));
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(DIR, rel), "utf8"));
const manifest = read("manifest.json");
const summary = read("evidence/summary.json");
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

describe("Decision Compliance Benchmark 1", () => {
  const repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-dc01-test-"))), "repo");
  temps.push(path.dirname(repo));
  const commits = generateFixture(repo);

  it("generates the manifest's commits, with the manifest's policy and LF files", () => {
    expect(commits).toEqual(manifest.commits);
    expect(manifest.policy).toBe(POLICY);
    expect(execFileSync("git", ["ls-files", "--eol"], { cwd: repo, encoding: "utf8" })).not.toMatch(/w\/crlf/u);
  });

  it("the DIY gate gives the recorded result on the change and the control-only change", () => {
    for (const [id, head, code] of [["change", commits.change, 1], ["control-only", commits.controlOnly, 0]] as const) {
      let out: string, status = 0;
      try { out = execFileSync(process.execPath, [path.join(DIR, "diy", "session-store-gate.mjs"), "--base", commits.baseline, "--head", head], { cwd: repo, encoding: "utf8" }); }
      catch (e) { const err = e as { stdout: string; status: number }; out = err.stdout; status = err.status; }
      expect(status, id).toBe(code);
      expect(JSON.parse(out), id).toEqual(read(path.join("evidence", "diy", id + ".json")));
    }
  });

  it("every stored DUO review run projects to the recorded canonical hash", () => {
    for (const id of ["change", "control-only"]) {
      const runs = fs.readdirSync(path.join(DIR, "evidence", "duo", id)).filter((f) => /^review-\d+\.json$/u.test(f));
      expect(runs.length, id).toBe(summary.runsPerScenario);
      for (const f of runs) expect(sha256(canonicalReview(read(path.join("evidence", "duo", id, f)))), id + " " + f).toBe(summary.duo[id].canonicalHash);
    }
  });
});
