// T22-D: Context quality with path-qualified tasks: which expected files the Packet contains, which were omitted.
// Runs on the clones that bench/experiments/realworld-suite.mjs left in the OS temp directory (run it first).
//   node bench/experiments/context-quality.mjs      (needs pnpm build)
import { spawnSync } from "node:child_process";
import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const base = path.join(os.tmpdir(), "duo-t22-repos");
const cases = [
  ["bulletproof-react", "apps/react-vite/src/features/discussions/components/discussions-list.tsx useDiscussions", ["react-vite/src/features/discussions/components/discussions-list.tsx", "react-vite/src/features/discussions/api/get-discussions.ts"]],
  ["ActionRoguelike", "Source/ActionRoguelike/ActionSystem/RogueActionComponent.cpp StartActionByName", ["ActionSystem/RogueActionComponent.h", "ActionSystem/RogueActionComponent.cpp", "ActionSystem/RogueAction.h"]],
  ["spring-petclinic", "OwnerController processFindForm find owners by last name", ["owner/OwnerController.java", "owner/OwnerRepository.java", "owner/Owner.java"]],
  ["full-stack-fastapi-template", "items route create_item read_items", ["backend/app/api/routes/items.py", "backend/app/crud.py", "backend/app/models.py"]],
  ["full-stack-fastapi-template", "backend/app/api/routes/items.py create_item crud models Item", ["backend/app/api/routes/items.py", "backend/app/crud.py", "backend/app/models.py"]],
];
for (const [repo, task, expect] of cases) {
  const r = spawnSync(process.execPath, [CLI, "context", task, "--json"], { cwd: path.join(base, repo), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const res = JSON.parse(r.stdout).result;
  const p = res.context?.packet;
  const items = p ? [...p.code, ...p.tests] : [];
  const files = [...new Set(items.map((x) => x.source?.path).filter(Boolean))];
  const omittedFiles = [...new Set((p?.omittedCandidates ?? []).map((o) => (o.ref ?? o.id ?? "").replace(/^[a-z]+:/u, "").split("#")[0]))];
  console.log(JSON.stringify({ repo, task, status: res.context?.status, files, found: expect.filter((e) => files.some((f) => f.endsWith(e))), missing: expect.filter((e) => !files.some((f) => f.endsWith(e))), missingButOmitted: expect.filter((e) => !files.some((f) => f.endsWith(e)) && omittedFiles.some((f) => f.endsWith(e))), omitted: p?.omittedCandidates?.length ?? null, truncated: p?.truncated ?? null, budget: p?.budget ?? null, languages: [...new Set(files.map((f) => path.extname(f)))] }));
}

