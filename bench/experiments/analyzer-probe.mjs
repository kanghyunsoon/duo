// T22-C probe: what the current analyzers put into the Project Graph for constructs that decide L2 feasibility.
// Small repositories per language, indexed through the CLI (workspace build); prints nodes and edges per file.
//   node bench/experiments/analyzer-probe.mjs      (needs pnpm build)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpGraph, openProjectGraphReader } from "@duo-director/graph";

const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const PROBES = {
  java: {
    "src/main/java/app/core/Service.java": "package app.core;\n\npublic interface Service {\n  void run();\n}\n",
    "src/main/java/app/core/ServiceImpl.java": "package app.core;\n\nimport org.springframework.stereotype.Service;\n\n@org.springframework.stereotype.Service\npublic class ServiceImpl implements app.core.Service {\n  public void run() { run(1); }\n  public void run(int times) { helper(); }\n  private static void helper() {}\n}\n",
    "src/main/java/app/web/Controller.java": "package app.web;\n\nimport app.core.Service;\nimport app.util.*;\nimport static app.util.Strings.trim;\nimport org.springframework.web.bind.annotation.GetMapping;\n\n@RestController\npublic class Controller {\n  private final Service service;\n  public Controller(Service service) { this.service = service; }\n  @GetMapping(\"/run\")\n  public String run() { service.run(); Strings.upper(\"x\"); return trim(\" a \"); }\n}\n",
    "src/main/java/app/util/Strings.java": "package app.util;\n\npublic final class Strings {\n  public static String upper(String s) { return s.toUpperCase(); }\n  public static String trim(String s) { return s.trim(); }\n}\n",
    "src/test/java/app/web/ControllerTest.java": "package app.web;\n\nimport org.junit.jupiter.api.Test;\n\nclass ControllerTest {\n  @Test\n  void runs() {}\n}\n",
  },
  python: {
    "app/__init__.py": "",
    "app/models.py": "def make():\n    return 1\n\ndef other():\n    return make()\n",
    "app/service.py": "import importlib\nfrom .models import make\nfrom . import models as m\nfrom app.models import other\nimport app.models\n\ndef handle():\n    make()\n    m.make()\n    other()\n    app.models.make()\n    return importlib.import_module('app.models')\n\ndef local():\n    return handle()\n",
    "tests/test_service.py": "from app.service import handle\n\ndef test_handle():\n    assert handle()\n",
  },
  csharp: {
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 2022.3.0f1\n",
    "Assets/Scripts/Player.cs": "using UnityEngine;\nusing Game.Util;\n\nnamespace Game\n{\n    public partial class Player : MonoBehaviour\n    {\n        void Update() { Move(); Helpers.Clamp(1); }\n    }\n}\n",
    "Assets/Scripts/Player.Movement.cs": "namespace Game\n{\n    public partial class Player\n    {\n        void Move() {}\n        void Move(int speed) {}\n    }\n}\n",
    "Assets/Scripts/Util/Helpers.cs": "namespace Game.Util;\n\npublic static class Helpers\n{\n    public static int Clamp(int v) => v;\n}\n",
    "Assets/Tests/PlayerTests.cs": "using NUnit.Framework;\n\npublic class PlayerTests\n{\n    [Test]\n    public void Moves() {}\n}\n",
  },
  cpp: {
    "Game.uproject": "{ \"EngineAssociation\": \"5.4\" }\n",
    "Source/Game/Public/Weapon.h": "#pragma once\n#include \"CoreMinimal.h\"\n#include \"Weapon.generated.h\"\n\nnamespace game {\nUCLASS()\nclass GAME_API AWeapon {\n  GENERATED_BODY()\npublic:\n  UFUNCTION(BlueprintCallable)\n  void Fire();\n  void Fire(int Count);\n  template <typename T> T Get() const { return T(); }\n};\n}\n",
    "Source/Game/Private/Weapon.cpp": "#include \"Weapon.h\"\n#include \"Public/Weapon.h\"\n#define CALL(x) x()\n\nstatic void Helper() {}\nstatic void Other() { Helper(); }\n\nnamespace game {\nvoid AWeapon::Fire() { Fire(1); CALL(Helper); }\nvoid AWeapon::Fire(int Count) { Helper(); }\n}\n",
    "Source/Game/Private/Shooter.cpp": "#include \"Game/Public/Weapon.h\"\n#include <vector>\n\nvoid Shoot() { game::AWeapon w; w.Fire(); }\n",
  },
};
const out = {};
for (const [lang, files] of Object.entries(PROBES)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-probe-" + lang + "-")));
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", "-c", "core.autocrlf=false", ...a], { cwd: root, stdio: "pipe" });
  git("-c", "init.defaultBranch=main", "init", "-q"); git("add", "-A"); git("commit", "-qm", "probe");
  const init = spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--json"], { cwd: root, input: "[]", encoding: "utf8" });
  if (init.status !== 0) throw new Error(lang + " init failed: " + init.stdout.slice(0, 500));
  const g = openProjectGraphReader(root).value;
  const dump = dumpGraph(g);
  g.close();
  // dumpGraph rows are canonical JSON strings.
  const parse = (x) => (typeof x === "string" ? JSON.parse(x) : x);
  const nodes = dump.nodes.map(parse).filter((n) => /^(sym|test):/u.test(n.id)).map((n) => n.id + (n.payload?.kind ? " (" + n.payload.kind + ")" : ""));
  const edges = dump.edges.map(parse).filter((e) => e.type !== "CONTAINS").map((e) => e.type + " " + e.from + " -> " + e.to + (e.metadata?.provenance ? " [" + e.metadata.provenance + "]" : ""));
  out[lang] = { nodes, edges };
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 1));

