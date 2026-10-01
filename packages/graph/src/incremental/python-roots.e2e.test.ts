/**
 * C219 (T24.2): Python source roots through the real Indexer. IMPORTS edges in a backend layout, no edge
 * for an ambiguous module, and incremental index == clean full rebuild while packages, __init__.py,
 * roots, file names, imports and project metadata change (metadata content invalidates stored results).
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { baseRegistry, cleanRebuild, edge, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const temps: string[] = [];
let base: AnalyzerRegistry;
beforeAll(async () => { base = await baseRegistry(); });
afterAll(() => {
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const FILES: Record<string, string> = {
  ".duo-project/project.yaml": "schema_version: 1\nname: fullstack\n",
  "frontend/src/client.ts": "export const base = \"/api\";\n",
  "backend/pyproject.toml": "[project]\nname = \"app\"\n\n[build-system]\nrequires = [\"hatchling\"]\nbuild-backend = \"hatchling.build\"\n",
  "backend/app/__init__.py": "",
  "backend/app/models.py": "class Item:\n    pass\n",
  "backend/app/crud.py": "from app.models import Item\n\ndef create_item():\n    return Item()\n",
  "backend/app/api/__init__.py": "",
  "backend/app/api/routes/__init__.py": "",
  "backend/app/api/routes/items.py": "from app import crud\nfrom app.crud import create_item\nfrom app.models import Item\n\ndef read_items():\n    return [create_item()]\n",
  "ns/pyproject.toml": "[project]\nname = \"acme\"\n",
  "ns/src/acme/core.py": "from acme.util import helper\n",
  "ns/src/acme/util.py": "def helper():\n    return 1\n",
};

async function index(repo: TestRepo, store: GraphStore) {
  const r = await indexRepository(repo.root, { store, registry: base });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
const equalsClean = async (repo: TestRepo, store: GraphStore, label: string) =>
  expect(dumpGraph(store), label).toEqual(await cleanRebuild(repo.root, base, 500));

describe("Python source roots through the Indexer (C219)", () => {
  it("a backend layout gets IMPORTS edges for absolute imports; the same package in two projects is not linked from outside", async () => {
    const repo = makeRepo(temps, {
      ...FILES,
      "one/app/__init__.py": "", "one/app/models.py": "", "two/app/__init__.py": "", "two/app/models.py": "",
      "main.py": "from app.models import Item\n",
    });
    const store = memoryStore();
    try {
      await index(repo, store);
      expect(edge(store, "file:backend/app/api/routes/items.py", "IMPORTS", "file:backend/app/crud.py")).toBeDefined();
      expect(edge(store, "file:backend/app/api/routes/items.py", "IMPORTS", "file:backend/app/models.py")).toBeDefined();
      expect(edge(store, "file:backend/app/api/routes/items.py", "IMPORTS", "file:backend/app/__init__.py")).toBeDefined();
      expect(edge(store, "file:backend/app/crud.py", "IMPORTS", "file:backend/app/models.py")).toBeDefined();
      expect(edge(store, "file:ns/src/acme/core.py", "IMPORTS", "file:ns/src/acme/util.py")).toBeDefined();
      // main.py (repository root) may use neither one/ nor two/: no edge.
      for (const t of ["one", "two"]) expect(edge(store, "file:main.py", "IMPORTS", `file:${t}/app/models.py`)).toBeUndefined();
      await equalsClean(repo, store, "initial");
    } finally {
      store.close();
    }
  });

  it("a module under two roots a file may use is ambiguous: no edge to either", async () => {
    const repo = makeRepo(temps, { ...FILES, "app/__init__.py": "", "app/models.py": "", "main.py": "from app.models import Item\n" });
    const store = memoryStore();
    try {
      await index(repo, store);
      // main.py may use only the repository root: app/models.py.
      expect(edge(store, "file:main.py", "IMPORTS", "file:app/models.py")).toBeDefined();
      // backend files may use the repository root and backend/: app.models is under both.
      for (const t of ["app/models.py", "backend/app/models.py"]) expect(edge(store, "file:backend/app/crud.py", "IMPORTS", `file:${t}`)).toBeUndefined();
      await equalsClean(repo, store, "ambiguous");
    } finally {
      store.close();
    }
  });

  it("incremental index equals a clean full rebuild while the Python layout changes", async () => {
    const repo = makeRepo(temps, FILES);
    const store = memoryStore();
    try {
      await index(repo, store);
      const steps: [string, () => void][] = [
        ["add a package", () => { repo.write("worker/worker_app/__init__.py", ""); repo.write("worker/worker_app/jobs.py", ""); repo.write("worker/worker_app/tasks.py", "from worker_app.jobs import run\n"); }],
        ["remove __init__.py", () => repo.remove("backend/app/__init__.py")],
        ["add __init__.py back", () => repo.write("backend/app/__init__.py", "")],
        ["move the source root", () => { fs.renameSync(`${repo.root}/backend`, `${repo.root}/server`); }],
        ["rename a Python file", () => { repo.rename("server/app/crud.py", "server/app/crud_ops.py"); repo.edit("server/app/api/routes/items.py", "from app.crud import", "from app.crud_ops import"); }],
        ["change an import", () => repo.edit("server/app/api/routes/items.py", "from app.models import Item", "import app.models")],
        ["metadata moves packages", () => repo.write("ns/pyproject.toml", "[project]\nname = \"acme\"\n[tool.setuptools]\npackage-dir = {\"\" = \"lib\"}\n")],
        ["metadata back", () => repo.write("ns/pyproject.toml", "[project]\nname = \"acme\"\n")],
      ];
      for (const [label, change] of steps) {
        change();
        const r = await index(repo, store);
        expect(r.mode, label).toBe("incremental");
        await equalsClean(repo, store, label);
      }
      expect(edge(store, "file:worker/worker_app/tasks.py", "IMPORTS", "file:worker/worker_app/jobs.py")).toBeDefined();
      expect(edge(store, "file:server/app/api/routes/items.py", "IMPORTS", "file:server/app/crud_ops.py")).toBeDefined();
      expect(edge(store, "file:server/app/api/routes/items.py", "IMPORTS", "file:server/app/models.py")).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("a metadata change alone (same Python bytes) re-resolves stored imports: no stale edge", async () => {
    const repo = makeRepo(temps, FILES);
    const store = memoryStore();
    try {
      await index(repo, store);
      const e = () => edge(store, "file:ns/src/acme/core.py", "IMPORTS", "file:ns/src/acme/util.py");
      expect(e()).toBeDefined();
      repo.write("ns/pyproject.toml", "[project]\nname = \"acme\"\n[tool.setuptools.packages.find]\nwhere = [\"lib\"]\n");
      await index(repo, store);
      expect(e()).toBeUndefined();
      await equalsClean(repo, store, "moved");
      repo.write("ns/pyproject.toml", "[tool.ruff]\nline-length = 100\n");
      await index(repo, store);
      expect(e()).toBeUndefined();
      repo.write("ns/pyproject.toml", "[project]\nname = \"acme\"\n");
      await index(repo, store);
      expect(e()).toBeDefined();
      await equalsClean(repo, store, "restored");
    } finally {
      store.close();
    }
  });
});

