import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectTruth, STATE_DIR_NAME } from "@duo/core";
import { afterAll, describe, expect, it } from "vitest";
import { validateDocs } from "../../scripts/validate-docs.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

/** Copies this repository's SDD definition files into a temporary .duo/ (ADR-014 self fixture). */
function selfFixture(): string {
  const repo = tempDir("duo-self-");
  const duo = path.join(repo, STATE_DIR_NAME);
  const copy = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(path.join(duo, to)), { recursive: true });
    fs.copyFileSync(path.join(root, from), path.join(duo, to));
  };
  copy("docs/01-requirements.md", "specs/01-requirements.md");
  copy("docs/tasks/TASKS.md", "milestones/TASKS.md");
  copy("docs/12-roadmap.md", "milestones/12-roadmap.md");
  for (const f of fs.readdirSync(path.join(root, "docs", "adr")).filter((f) => /^ADR-\d+/.test(f))) copy(`docs/adr/${f}`, `decisions/${f}`);
  fs.writeFileSync(path.join(duo, "project.yaml"), "schema_version: 1\nname: duo\ncurrent_milestone: M1\n");
  return repo;
}

describe("AC-002-03 DUO reads its own SDD documents", () => {
  const loaded = loadProjectTruth(selfFixture(), { tracePolicy: { requireTrackedRequirements: true } });
  const validator = validateDocs(root);

  it("loads the self fixture through the Project Truth loader without errors or warnings", () => {
    expect(loaded.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("gives the same result as the CI docs validator", () => {
    const truth = loaded.value?.truth;
    expect(validator.problems).toEqual([]);
    expect(validator.report).toMatchObject({
      requirements: truth?.requirements.length,
      decisions: truth?.decisions.length,
      issues: truth?.issues.length,
      milestones: truth?.milestones.length,
      acceptanceCriteria: loaded.value?.trace.acceptance.size,
      links: loaded.value?.trace.links.length,
    });
  });

  it("traces REQ-CONTEXT-001 → ADR-005 → TASK-010", () => {
    const links = loaded.value?.trace.links.map((l) => `${l.from.id} ${l.relation} ${l.to.id}`);
    expect(links).toEqual(expect.arrayContaining([
      "ADR-005 GOVERNS REQ-CONTEXT-001",
      "ADR-005 GOVERNS TASK-010",
      "REQ-CONTEXT-001 TRACKED_BY TASK-010",
    ]));
    expect(loaded.value?.trace.acceptance.get("AC-010-02")).toBe("TASK-010");
  });
});

describe("validate-docs reports problems found by @duo/core", () => {
  function docsCopy(edit: (file: string, text: string) => string): string {
    const dir = tempDir("duo-docs-");
    fs.cpSync(path.join(root, "docs"), path.join(dir, "docs"), { recursive: true });
    for (const f of ["README.md", "Duo 기획서.md"]) fs.copyFileSync(path.join(root, f), path.join(dir, f));
    for (const file of ["docs/tasks/TASKS.md", "README.md"]) {
      const p = path.join(dir, file);
      fs.writeFileSync(p, edit(file, fs.readFileSync(p, "utf8")));
    }
    return dir;
  }

  it("reports a broken trace reference", () => {
    const dir = docsCopy((f, t) => (f === "docs/tasks/TASKS.md" ? t.replace("requirements: [REQ-CONTEXT-001", "requirements: [REQ-CONTEXT-999") : t));
    const { problems } = validateDocs(dir);
    expect(problems.some((p) => p.includes("BROKEN_REFERENCE") && p.includes("REQ-CONTEXT-999"))).toBe(true);
  });

  it("reports a broken link", () => {
    const dir = docsCopy((f, t) => (f === "README.md" ? t + "\n[missing](docs/nope.md)\n" : t));
    const { problems } = validateDocs(dir);
    expect(problems.some((p) => p.startsWith("README.md:") && p.includes("broken link docs/nope.md"))).toBe(true);
  });
});
