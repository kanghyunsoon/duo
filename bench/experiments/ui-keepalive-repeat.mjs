// T21-A (C213): runs the RC UI conformance block N times with the undici trace preload and summarizes every
// request to the UI server: how many reused a pooled socket, the longest idle time of a reused socket, and every
// failure. Not part of CI or pnpm test; used locally and by a one-off Windows probe workflow.
//
//   node bench/experiments/ui-keepalive-repeat.mjs --runs 30 [--label after]      (needs pnpm build)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name, fallback) => { const i = process.argv.indexOf("--" + name); return i < 0 ? fallback : process.argv[i + 1]; };
const runs = Number(arg("runs", "10"));
const label = arg("label", "local");
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const vitest = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const trace = pathToFileURL(fileURLToPath(new URL("./undici-trace.mjs", import.meta.url))).href;

const summary = { label, platform: process.platform, node: process.version, runs, passedRuns: 0, failedRuns: 0, requests: 0, reused: 0, maxReusedIdleMs: 0, errors: {}, failures: [] };
for (let run = 1; run <= runs; run++) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [vitest, "run", "tests/conformance/rc.conformance.test.ts", "-t", "RC: local UI"], {
    cwd: REPO, encoding: "utf8", windowsHide: true, env: { ...process.env, NODE_OPTIONS: "--import=" + trace, FORCE_COLOR: "0" }, maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  for (const line of out.split(/\r?\n/u)) {
    const i = line.indexOf("[undici-trace] ");
    if (i < 0) continue;
    const t = JSON.parse(line.slice(i + "[undici-trace] ".length));
    summary.requests++;
    if (t.reused) { summary.reused++; summary.maxReusedIdleMs = Math.max(summary.maxReusedIdleMs, t.idleMs ?? 0); }
    if (!t.ok) { summary.errors[t.error] = (summary.errors[t.error] ?? 0) + 1; summary.failures.push({ run, method: t.method, path: t.path.replace(/session=[\w-]+/u, "session=…"), reused: t.reused, idleMs: t.idleMs, error: t.error }); }
  }
  const passed = r.status === 0 && /Tests\s+4 passed/u.test(out);
  if (passed) summary.passedRuns++; else summary.failedRuns++;
  console.error("run " + run + "/" + runs + ": " + (passed ? "passed" : "FAILED (exit " + r.status + ")") + " in " + Math.round((Date.now() - started) / 1000) + " s");
}
const json = JSON.stringify(summary, null, 1);
console.log(json);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### UI keep-alive probe (" + label + ")\n\n~~~json\n" + json + "\n~~~\n");

