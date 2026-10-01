/**
 * C219 (T24.2): Python source-root discovery and absolute-import resolution against a file set.
 * Layouts A-G, negative ambiguity cases, project metadata, relative imports, determinism.
 */
import { describe, expect, it } from "vitest";
import type { RepoPath } from "@duo-director/core";
import type { ModuleResolutionRequest } from "./module-resolver.js";
import { discoverPythonRoots, resolvePython } from "./python.js";

type Files = Record<string, string>;
const req = (fromPath: string, specifier: string): ModuleResolutionRequest => ({ fromPath: fromPath as RepoPath, specifier, kind: "import", language: "python" });
function resolve(files: Files, from: string, spec: string) {
  const set = new Set(Object.keys(files));
  return resolvePython(req(from, spec), set, discoverPythonRoots(set, (p) => files[p]));
}
const target = (files: Files, from: string, spec: string) => {
  const r = resolve(files, from, spec);
  return r.status === "resolved" ? r.path : r.status === "ambiguous" ? `ambiguous: ${r.candidates.join(" ")}` : r.status;
};
const roots = (files: Files) => discoverPythonRoots(new Set(Object.keys(files)), (p) => files[p]).roots.map((r) => `${r.basis}:${r.path}@${r.scope}`);
const empty = (...paths: string[]): Files => Object.fromEntries(paths.map((p) => [p, ""]));

describe("Python source roots (C219)", () => {
  it("A. flat layout: the repository root (as before)", () => {
    const f = empty("app/__init__.py", "app/models.py", "app/views.py", "main.py");
    expect(target(f, "main.py", "app.models")).toBe("app/models.py");
    expect(target(f, "app/views.py", "app.models")).toBe("app/models.py");
    expect(roots(f)).toEqual(["repository:@", "src:src@"]);
  });

  it("B. src layout: src/ for every file, tests outside src included (as before)", () => {
    const f = empty("src/app/__init__.py", "src/app/models.py", "tests/test_models.py");
    expect(target(f, "tests/test_models.py", "app.models")).toBe("src/app/models.py");
    expect(target(f, "src/app/__init__.py", "app.models")).toBe("src/app/models.py");
  });

  it("C. backend layout: the parent of the top-level package, for files under it; no directory name is special", () => {
    const f = empty("backend/app/__init__.py", "backend/app/models.py", "backend/app/api/__init__.py", "backend/app/api/routes/__init__.py", "backend/app/api/routes/items.py", "backend/tests/__init__.py", "backend/tests/test_items.py", "backend/scripts/seed.py", "tools/report.py");
    expect(target(f, "backend/app/api/routes/items.py", "app.models")).toBe("backend/app/models.py");
    expect(target(f, "backend/tests/test_items.py", "app.api.routes.items")).toBe("backend/app/api/routes/items.py");
    // A plain script under the root directory (no package of its own) uses it too.
    expect(target(f, "backend/scripts/seed.py", "app.models")).toBe("backend/app/models.py");
    // A file outside backend/ does not: no guess across project directories.
    expect(target(f, "tools/report.py", "app.models")).toBe("external");
    expect(roots(f)).toEqual(["repository:@", "package:backend@backend", "src:src@"]);
    // The same tree under any other name resolves the same way.
    const g = empty("zz9/app/__init__.py", "zz9/app/models.py", "zz9/app/main.py");
    expect(target(g, "zz9/app/main.py", "app.models")).toBe("zz9/app/models.py");
  });

  it("D. nested service layout", () => {
    const f = empty("services/api/app/__init__.py", "services/api/app/models.py", "services/api/app/main.py", "services/api/main.py");
    expect(target(f, "services/api/app/main.py", "app.models")).toBe("services/api/app/models.py");
    expect(target(f, "services/api/main.py", "app.main")).toBe("services/api/app/main.py");
  });

  it("E. multiple roots: each project resolves its own packages, in a deterministic order", () => {
    const f = empty("backend/app/__init__.py", "backend/app/models.py", "backend/app/main.py", "worker/worker_app/__init__.py", "worker/worker_app/tasks.py", "worker/worker_app/jobs.py");
    expect(target(f, "backend/app/main.py", "app.models")).toBe("backend/app/models.py");
    expect(target(f, "worker/worker_app/tasks.py", "worker_app.jobs")).toBe("worker/worker_app/jobs.py");
    expect(target(f, "backend/app/main.py", "worker_app.jobs")).toBe("external");
    const shuffled = Object.fromEntries(Object.entries(f).reverse());
    expect(discoverPythonRoots(new Set(Object.keys(shuffled)))).toEqual(discoverPythonRoots(new Set(Object.keys(f))));
    expect(roots(f)).toEqual(["repository:@", "package:backend@backend", "src:src@", "package:worker@worker"]);
  });

  it("F. monorepo with a frontend: TypeScript or generated directories are never Python roots", () => {
    const f = empty("frontend/src/app/models.ts", "frontend/generated/app/models.py", "frontend/generated/app/client.ts", "backend/app/__init__.py", "backend/app/models.py", "backend/app/main.py");
    expect(target(f, "backend/app/main.py", "app.models")).toBe("backend/app/models.py");
    expect(target(f, "frontend/generated/app/models.py", "app.models")).toBe("external");
  });

  it("G. namespace packages (no __init__.py): only project metadata makes a root; otherwise UNKNOWN", () => {
    const code = empty("proj/src/acme/core.py", "proj/src/acme/util.py", "proj/tests/test_core.py");
    expect(target(code, "proj/src/acme/core.py", "acme.util")).toBe("external");
    const meta = { ...code, "proj/pyproject.toml": "[project]\nname = \"acme\"\n\n[build-system]\nrequires = [\"hatchling\"]\n" };
    expect(target(meta, "proj/src/acme/core.py", "acme.util")).toBe("proj/src/acme/util.py");
    expect(target(meta, "proj/tests/test_core.py", "acme.core")).toBe("proj/src/acme/core.py");
    expect(roots(meta)).toEqual(["repository:@", "metadata:proj@proj", "metadata:proj/src@proj", "src:src@"]);
    const flat = { "tool/pyproject.toml": "[tool.poetry]\nname = \"t\"\n", "tool/t/cli.py": "", "tool/t/io.py": "" };
    expect(target(flat, "tool/t/cli.py", "t.io")).toBe("tool/t/io.py");
  });

  it("metadata that is tool configuration only, or moves packages, or comes with setup.py is not interpreted", () => {
    const code = empty("proj/lib/acme/core.py", "proj/lib/acme/util.py", "proj/acme/util.py");
    const toolOnly = { ...code, "proj/pyproject.toml": "[tool.ruff]\nline-length = 100\n" };
    expect(target(toolOnly, "proj/lib/acme/core.py", "acme.util")).toBe("external");
    for (const moved of [
      "[project]\nname = \"acme\"\n[tool.setuptools]\npackage-dir = {\"\" = \"lib\"}\n",
      "[project]\nname = \"acme\"\n[tool.setuptools.packages.find]\nwhere = [\"lib\"]\n",
      "[tool.poetry]\nname = \"acme\"\npackages = [{ include = \"acme\", from = \"lib\" }]\n",
      "[project]\nname = \"acme\"\n[tool.hatch.build.targets.wheel]\npackages = [\"lib/acme\"]\n",
    ]) {
      // UNKNOWN: neither proj/ nor proj/src/ is assumed (proj/acme/util.py would be a wrong guess).
      expect(target({ ...code, "proj/pyproject.toml": moved }, "proj/lib/acme/core.py", "acme.util")).toBe("external");
    }
    const cfg = { ...code, "proj/setup.cfg": "[options]\npackage_dir =\n    = lib\n" };
    expect(target(cfg, "proj/lib/acme/core.py", "acme.util")).toBe("external");
    const withSetupPy = { ...code, "proj/pyproject.toml": "[project]\nname = \"acme\"\n", "proj/setup.py": "from setuptools import setup\nsetup(package_dir={'': 'lib'})\n" };
    expect(target(withSetupPy, "proj/lib/acme/core.py", "acme.util")).toBe("external");
    // The metadata files read are reported (a change to them re-resolves Python imports); setup.py is not read.
    expect(discoverPythonRoots(new Set(Object.keys(withSetupPy)), (p) => withSetupPy[p as keyof typeof withSetupPy]).metadata).toEqual(["proj/pyproject.toml"]);
  });

  it("negative: the same package in two projects is never linked across them or from outside", () => {
    const f = empty("one/app/__init__.py", "one/app/models.py", "one/app/main.py", "two/app/__init__.py", "two/app/models.py", "main.py");
    expect(target(f, "main.py", "app.models")).toBe("external");
    expect(target(f, "one/app/main.py", "app.models")).toBe("one/app/models.py");
    // Two roots a file may use that both hold the module: ambiguous, no edge.
    const g = empty("app/__init__.py", "app/models.py", "backend/app/__init__.py", "backend/app/models.py", "backend/app/main.py");
    expect(target(g, "backend/app/main.py", "app.models")).toBe("ambiguous: app/models.py backend/app/models.py");
  });

  it("a directory whose name is not a Python identifier is not a package root", () => {
    const f = empty("Assets/10. Feature/__init__.py", "Assets/10. Feature/x.py", "my-lib/__init__.py", "my-lib/y.py");
    expect(roots(f)).toEqual(["repository:@", "src:src@"]);
  });

  it("relative imports resolve as before", () => {
    const f = empty("backend/app/__init__.py", "backend/app/models.py", "backend/app/api/__init__.py", "backend/app/api/routes.py", "backend/app/api/deps.py");
    expect(target(f, "backend/app/api/routes.py", ".deps")).toBe("backend/app/api/deps.py");
    expect(target(f, "backend/app/api/routes.py", "..models")).toBe("backend/app/models.py");
    expect(target(f, "backend/app/api/routes.py", ".")).toBe("backend/app/api/__init__.py");
    expect(target(f, "backend/app/api/routes.py", ".missing")).toBe("unresolved");
  });
});

