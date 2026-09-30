// T22-B/D: runs bench/experiments/realworld.mjs on public repositories of the six project shapes, one process each.
// Clones into the OS temp directory (never into this repository); results name the commit measured.
//   node bench/experiments/realworld-suite.mjs [name ...]      → bench/results/local/t22-realworld.json
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOS = [
  { name: "spring-petclinic", shape: "Spring Boot / Java", url: "https://github.com/spring-projects/spring-petclinic.git",
    task: "OwnerController processFindForm find owners by last name", expect: ["owner/OwnerController.java", "owner/OwnerRepository.java", "owner/Owner.java"],
    edit: "src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java" },
  { name: "bulletproof-react", shape: "React / TypeScript", url: "https://github.com/alan2207/bulletproof-react.git",
    task: "discussions list useDiscussions getDiscussions", expect: ["features/discussions/components/discussions-list.tsx", "features/discussions/api/get-discussions.ts"],
    edit: "apps/react-vite/src/features/discussions/api/get-discussions.ts" },
  { name: "full-stack-fastapi-template", shape: "FastAPI / Python + React (polyglot)", url: "https://github.com/fastapi/full-stack-fastapi-template.git",
    task: "items route create_item read_items", expect: ["backend/app/api/routes/items.py", "backend/app/crud.py", "backend/app/models.py"],
    edit: "backend/app/api/routes/items.py" },
  { name: "ActionRoguelike", shape: "Unreal / C++", url: "https://github.com/tomlooman/ActionRoguelike.git",
    task: "RogueActionComponent StartActionByName RogueAction", expect: ["ActionSystem/RogueActionComponent.h", "ActionSystem/RogueActionComponent.cpp", "ActionSystem/RogueAction.h"],
    edit: "Source/ActionRoguelike/ActionSystem/RogueActionComponent.cpp" },
  { name: "ecs-samples", shape: "Unity / C#", url: "https://github.com/Unity-Technologies/EntityComponentSystemSamples.git",
    task: "FirstPersonController ControllerSystem ControllerAuthoring CameraSystem", expect: ["10. FirstPersonController/ControllerSystem.cs", "10. FirstPersonController/ControllerAuthoring.cs", "10. FirstPersonController/CameraSystem.cs"],
    edit: "Dots101/Entities101/Assets/HelloCube/10. FirstPersonController/ControllerSystem.cs" },
];
const only = process.argv.slice(2);
const base = path.join(os.tmpdir(), "duo-t22-repos");
fs.mkdirSync(base, { recursive: true });
const script = fileURLToPath(new URL("./realworld.mjs", import.meta.url));
const out = fileURLToPath(new URL("../results/local/t22-realworld.json", import.meta.url));
const results = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")).results : {};
for (const r of REPOS.filter((x) => only.length === 0 || only.includes(x.name))) {
  const dir = path.join(base, r.name);
  if (!fs.existsSync(dir)) execFileSync("git", ["-c", "core.autocrlf=false", "clone", "-q", "--depth", "1", r.url, dir], { stdio: "inherit" });
  execFileSync("git", ["checkout", "-q", "--", "."], { cwd: dir }); // undo a previous run's edit
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  console.error("measuring " + r.name + " @ " + commit.slice(0, 12));
  const p = spawnSync(process.execPath, [script, "--repo", dir, "--task", r.task, "--expect", r.expect.join(","), "--edit", r.edit], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let measured;
  try { measured = JSON.parse(p.stdout); } catch { measured = { error: (p.stderr || p.stdout).slice(-2000) }; }
  results[r.name] = { shape: r.shape, url: r.url, commit, task: r.task, ...measured };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ format: "duo.t22-realworld/1", machine: { platform: process.platform, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version }, results }, null, 1) + "\n");
  console.error("  done: noop " + measured.noopFreshness?.medianMs + " ms, initial " + measured.initialIndex?.ms + " ms, context " + measured.context?.medianMs + " ms");
}

