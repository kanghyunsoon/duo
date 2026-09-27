import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_DIR_NAME } from "./constants.js";
import { checkWriteBoundary, type WriteKind } from "./write-boundary.js";

const root = path.resolve("repo-under-test");
const S = STATE_DIR_NAME;
const codes = (r: ReturnType<typeof checkWriteBoundary>) => r.diagnostics.map((d) => d.code);

describe("AC-002-04 write boundary policy", () => {
  const allowed: [string, WriteKind, string][] = [
    [`${S}/project.yaml`, "project-truth", `${S}/project.yaml`],
    [`${S}/intent/vision.md`, "project-truth", `${S}/intent/`],
    [`${S}/specs/auth.md`, "project-truth", `${S}/specs/`],
    [`${S}/decisions/proposals/P-20260927-k3f9qa.yaml`, "project-truth", `${S}/decisions/`],
    [`${S}/milestones/M1.yaml`, "project-truth", `${S}/milestones/`],
    [`${S}/integrations/jira.yaml`, "project-truth", `${S}/integrations/`],
    [`${S}/reviews/R-1.json`, "human-history", `${S}/reviews/`],
    [`${S}/generated/graph.db`, "regenerable", `${S}/generated/`],
    [`${S}/cache/llm/abc.json`, "regenerable", `${S}/cache/`],
    [`${S}/runtime/metrics.jsonl`, "regenerable", `${S}/runtime/`],
  ];
  it.each(allowed)("allows %s as %s", (target, kind, area) => {
    expect(checkWriteBoundary(root, target, kind).value).toEqual({ path: target, kind, area });
  });

  it("accepts absolute host paths under the repository and Windows separators", () => {
    expect(checkWriteBoundary(root, path.join(root, S, "specs", "a.md"), "project-truth").value?.path).toBe(`${S}/specs/a.md`);
    expect(checkWriteBoundary(root, `${S}\\generated\\graph.db`, "regenerable").value?.path).toBe(`${S}/generated/graph.db`);
  });

  it.each([
    "../outside.txt",
    `${S}/specs/../../../outside.txt`,
    path.resolve(root, "..", "other-repo", S, "specs", "a.md"),
  ])("always rejects %s outside the repository", (target) => {
    expect(codes(checkWriteBoundary(root, target, "project-truth"))).toEqual(["WRITE_OUTSIDE_REPOSITORY"]);
  });

  it.each([
    "src/auth/AuthService.ts",
    "package.json",
    `${S}/specs/../../src/a.ts`,
    `${S}/unknown.txt`,
    `${S}/secrets/token`,
    `${S}/specs`,
    `${S}`,
  ])("rejects %s, which is not a write area", (target) => {
    expect(codes(checkWriteBoundary(root, target, "project-truth"))).toEqual(["WRITE_NOT_ALLOWED"]);
  });

  it("rejects a write whose kind does not match the area", () => {
    expect(codes(checkWriteBoundary(root, `${S}/specs/a.md`, "regenerable"))).toEqual(["WRITE_NOT_ALLOWED"]);
    expect(codes(checkWriteBoundary(root, `${S}/generated/graph.db`, "project-truth"))).toEqual(["WRITE_NOT_ALLOWED"]);
    expect(codes(checkWriteBoundary(root, `${S}/reviews/R-1.json`, "regenerable"))).toEqual(["WRITE_NOT_ALLOWED"]);
  });

  it("lets a caller narrow the allowed paths (e.g. an agent may only add proposals)", () => {
    const agent = { restrictTo: [`${S}/decisions/proposals/`] };
    expect(checkWriteBoundary(root, `${S}/decisions/proposals/P-1.yaml`, "project-truth", agent).value).toBeDefined();
    expect(codes(checkWriteBoundary(root, `${S}/decisions/D-004.yaml`, "project-truth", agent))).toEqual(["WRITE_NOT_ALLOWED"]);
    expect(codes(checkWriteBoundary(root, "src/a.ts", "project-truth", { restrictTo: ["src/"] }))).toEqual(["WRITE_NOT_ALLOWED"]);
  });
});
