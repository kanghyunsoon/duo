// T22-C probe: same-name overloads (Java run()/run(int)) and TypeScript overload signatures in the Project Graph,
// what checkGraph reports, and whether the Context Packet contains each overload body.
//   node bench/experiments/overload-probe.mjs      (needs pnpm build)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkGraph, dumpGraph, openProjectGraphReader } from "@duo-director/graph";
const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const files = {
  "src/main/java/app/ServiceImpl.java": "package app;\n\npublic class ServiceImpl {\n  public void run() {\n    System.out.println(1);\n  }\n\n  public void run(int times) {\n    System.out.println(times);\n  }\n}\n",
  "src/ts/over.ts": "export function parse(x: string): number;\nexport function parse(x: number): number;\nexport function parse(x: string | number): number {\n  return Number(x);\n}\n",
};
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-overload-")));
for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", ...a], { cwd: root, stdio: "pipe" });
git("-c", "init.defaultBranch=main", "init", "-q"); git("add", "-A"); git("commit", "-qm", "p");
spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--json"], { cwd: root, input: "[]" });
const g = openProjectGraphReader(root).value;
const nodes = dumpGraph(g).nodes.map((n) => JSON.parse(n)).filter((n) => n.id.startsWith("sym:"));
const diags = checkGraph(g);
g.close();
const ctx = spawnSync(process.execPath, [CLI, "context", "ServiceImpl run times", "--json"], { cwd: root, encoding: "utf8" });
const packet = JSON.parse(ctx.stdout).result.context.packet;
console.log(JSON.stringify({ symbols: nodes.map((n) => ({ id: n.id, lines: n.source ? n.source.startLine + "-" + n.source.endLine : null, overloads: n.payload?.overloads ?? null })), graphCheck: diags.map((d) => d.code), contextCode: packet.code.map((c) => ({ id: c.id, lines: c.source ? c.source.startLine + "-" + c.source.endLine : null, hasTimes: c.text.includes("times") })) }, null, 1));
fs.rmSync(root, { recursive: true, force: true });

