import type { RepoPath } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { buildOutputMatcher } from "./build-output.js";

const outputs = (paths: string[]) => {
  const m = buildOutputMatcher(paths as RepoPath[]);
  return paths.filter((p) => m(p as RepoPath));
};

describe("build output directories (T18.0)", () => {
  it("excludes build outputs only next to their build manifest", () => {
    expect(outputs([
      "api/pom.xml", "api/target/classes/App.class", "api/src/main/java/App.java",
      "lib/build.gradle.kts", "lib/build/libs/lib.jar", "lib/.gradle/8.5/x.lock",
      "Game/Game.csproj", "Game/bin/Debug/Game.dll", "Game/obj/project.assets.json",
      "Shooter.uproject", "Intermediate/Build/x.h", "Saved/Logs/x.log", "Source/Shooter/Shooter.cpp",
      "unity/ProjectSettings/ProjectVersion.txt", "unity/Library/x.asset", "unity/Assets/Player.cs",
      "svc/.venv/pyvenv.cfg", "svc/.venv/lib/site.py", "svc/app/__pycache__/main.cpython-312.pyc", "svc/app/main.py",
      "native/build/CMakeCache.txt", "native/build/out.o",
    ])).toEqual([
      "api/target/classes/App.class", "lib/build/libs/lib.jar", "lib/.gradle/8.5/x.lock", "Game/bin/Debug/Game.dll", "Game/obj/project.assets.json",
      "Intermediate/Build/x.h", "Saved/Logs/x.log", "unity/Library/x.asset", "svc/.venv/pyvenv.cfg", "svc/.venv/lib/site.py",
      "svc/app/__pycache__/main.cpython-312.pyc", "native/build/CMakeCache.txt", "native/build/out.o",
    ]);
  });

  it("keeps same-named source directories without evidence", () => {
    expect(outputs(["web/build/index.ts", "src/target/aim.ts", "tools/bin/cli.js", "Library/Code.cs", "Saved/notes.md", "package.json"])).toEqual([]);
  });
});

