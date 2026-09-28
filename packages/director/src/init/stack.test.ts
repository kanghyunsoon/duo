import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoPath } from "@duo-director/core";
import { afterAll, describe, expect, it } from "vitest";
import { observeStack } from "./stack.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

function repo(files: Record<string, string>): { root: string; paths: RepoPath[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stack-"));
  temps.push(root);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return { root, paths: Object.keys(files).sort() as RepoPath[] };
}

describe("project stack profile (T18.0)", () => {
  it("observes Spring Boot, Unity, Unreal and FastAPI from manifests only", () => {
    const r = repo({
      "api/pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>",
      "api/src/main/java/App.java": "@SpringBootApplication class App {}",
      "game/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 2022.3.10f1\nm_EditorVersionWithRevision: x\n",
      "game/Packages/manifest.json": JSON.stringify({ dependencies: { "com.unity.test-framework": "1.1.33" } }),
      "engine/Shooter.uproject": JSON.stringify({ EngineAssociation: "5.3", Modules: [] }),
      "engine/Source/Shooter/Shooter.Build.cs": "public class Shooter : ModuleRules {}",
      "svc/pyproject.toml": "[project]\ndependencies = [\"fastapi>=0.110\", \"uvicorn\"]\n",
      "svc/requirements-dev.txt": "pytest\n",
      "web/package.json": "{}",
    });
    const s = observeStack(r.root, r.paths);
    expect(s.provenance).toBe("observed");
    expect(s.ecosystems.map((e) => e.ecosystem)).toEqual(["maven", "npm", "python", "unity", "unreal"]);
    expect(s.frameworks).toEqual([
      { framework: "fastapi", evidence: [{ path: "svc/pyproject.toml", detail: "fastapi dependency" }] },
      { framework: "spring-boot", evidence: [{ path: "api/pom.xml", detail: "spring-boot-starter" }] },
      { framework: "unity", version: "2022.3.10f1", evidence: [{ path: "game/Packages/manifest.json", detail: "com.unity packages" }, { path: "game/ProjectSettings/ProjectVersion.txt", detail: "m_EditorVersion" }] },
      { framework: "unreal", version: "5.3", evidence: [{ path: "engine/Shooter.uproject", detail: "EngineAssociation" }, { path: "engine/Source/Shooter/Shooter.Build.cs", detail: "module rules" }] },
    ]);
  });

  it("does not guess a framework from source code or near-miss names", () => {
    const r = repo({
      "src/main/java/App.java": "@SpringBootApplication class App {}",
      "requirements.txt": "fastapi-users==12\nflask\n",
      "build.gradle": "plugins { id 'java' }",
    });
    const s = observeStack(r.root, r.paths);
    expect(s.frameworks).toEqual([]);
    expect(s.ecosystems.map((e) => e.ecosystem)).toEqual(["gradle", "python"]);
  });
});

