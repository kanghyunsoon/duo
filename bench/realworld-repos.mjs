// T23 real-world benchmark manifest (internal, not a DUO public contract). Public repositories pinned to exact
// commits; bench/realworld-suite.mjs fetches each commit into the OS temp directory at run time. No source of these
// repositories is copied into DUO or its npm package.
//
// Per repository:
//   id, url, sha        stable ID, clone URL, exact commit (never a branch or tag)
//   shape               project type
//   levels              expected analysis level per language that must appear in coverage (current public contract)
//   edit                one-file incremental target: a deterministic append of a new top-level declaration
//   ci                  measured by the manual 3 OS workflow (small, representative repositories)
//   scenarios           Context tasks; expect = file suffixes; t22 = what T22 observed (historical, not a gate)

export const MANIFEST_FORMAT = "duo.bench-realworld-manifest/1";

export const REPOS = [
  {
    id: "spring-petclinic", url: "https://github.com/spring-projects/spring-petclinic.git", sha: "500158f732419217507c7656904b8e6aa1bcc0d6",
    shape: "Spring Boot / Java", levels: { java: "L1" }, ci: true,
    edit: { path: "src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java", kind: "java" },
    scenarios: [
      { id: "owner-find", task: "OwnerController processFindForm find owners by last name",
        expect: ["owner/OwnerController.java", "owner/OwnerRepository.java", "owner/Owner.java"], t22: { status: "ready", missing: ["owner/Owner.java"] } },
    ],
  },
  {
    id: "bulletproof-react", url: "https://github.com/alan2207/bulletproof-react.git", sha: "9506629ed003a561c6627735480cce4994244bb4",
    shape: "React / TypeScript", levels: { typescript: "L2" }, ci: true,
    edit: { path: "apps/react-vite/src/features/discussions/api/get-discussions.ts", kind: "ts" },
    scenarios: [
      { id: "discussions", task: "discussions list useDiscussions getDiscussions",
        expect: ["features/discussions/components/discussions-list.tsx", "features/discussions/api/get-discussions.ts"], t22: { status: "ambiguous" } },
      { id: "discussions-path", task: "apps/react-vite/src/features/discussions/components/discussions-list.tsx useDiscussions",
        expect: ["react-vite/src/features/discussions/components/discussions-list.tsx", "react-vite/src/features/discussions/api/get-discussions.ts"], t22: { status: "ready", missing: [] } },
    ],
  },
  {
    id: "full-stack-fastapi-template", url: "https://github.com/fastapi/full-stack-fastapi-template.git", sha: "cb740b656d7a0a6c5e12c7bf8e50343ec94ee9c7",
    shape: "FastAPI / Python + React (polyglot)", levels: { python: "L1", typescript: "L2" }, ci: true,
    edit: { path: "backend/app/api/routes/items.py", kind: "py" },
    scenarios: [
      { id: "items", task: "items route create_item read_items",
        expect: ["backend/app/api/routes/items.py", "backend/app/crud.py", "backend/app/models.py"], t22: { status: "ready", missing: ["backend/app/crud.py", "backend/app/models.py"] } },
      { id: "items-path", task: "backend/app/api/routes/items.py create_item crud models Item",
        expect: ["backend/app/api/routes/items.py", "backend/app/crud.py", "backend/app/models.py"], t22: { status: "ready", missing: [] } },
    ],
  },
  {
    id: "ActionRoguelike", url: "https://github.com/tomlooman/ActionRoguelike.git", sha: "9e4ee5ff3d8dc8674316f3729871a267e0480d9a",
    shape: "Unreal / C++", levels: { cpp: "L1" }, ci: false,
    edit: { path: "Source/ActionRoguelike/ActionSystem/RogueActionComponent.cpp", kind: "cpp" },
    scenarios: [
      { id: "start-action", task: "RogueActionComponent StartActionByName RogueAction",
        expect: ["ActionSystem/RogueActionComponent.h", "ActionSystem/RogueActionComponent.cpp", "ActionSystem/RogueAction.h"], t22: { status: "ambiguous" } },
      { id: "start-action-path", task: "Source/ActionRoguelike/ActionSystem/RogueActionComponent.cpp StartActionByName",
        expect: ["ActionSystem/RogueActionComponent.h", "ActionSystem/RogueActionComponent.cpp", "ActionSystem/RogueAction.h"], t22: { status: "ready", missing: ["ActionSystem/RogueAction.h"] } },
    ],
  },
  {
    id: "ecs-samples", url: "https://github.com/Unity-Technologies/EntityComponentSystemSamples.git", sha: "6786a741ee1f118ed14cecfa02beae8e926937b0",
    shape: "Unity / C#", levels: { csharp: "L1" }, ci: false,
    edit: { path: "Dots101/Entities101/Assets/HelloCube/10. FirstPersonController/ControllerSystem.cs", kind: "cs" },
    scenarios: [
      { id: "first-person", task: "FirstPersonController ControllerSystem ControllerAuthoring CameraSystem",
        expect: ["10. FirstPersonController/ControllerSystem.cs", "10. FirstPersonController/ControllerAuthoring.cs", "10. FirstPersonController/CameraSystem.cs"], t22: { status: "ready", missing: [] } },
    ],
  },
];

// The appended declaration per language: a new top-level declaration that each analyzer reports as a Symbol,
// valid at the end of the file (a second top-level class in Java, a top-level class in C#, a static function in C++).
export const EDITS = {
  java: ["", "class DuoBenchProbe {", "  int duoBenchValue() { return 1; }", "}"],
  ts: ["", "export function duoBenchProbe(): number {", "  return 1;", "}"],
  py: ["", "", "def duo_bench_probe():", "    return 1"],
  cpp: ["", "static int DuoBenchProbe() { return 1; }"],
  cs: ["", "internal static class DuoBenchProbe", "{", "    internal static int Value() => 1;", "}"],
};

