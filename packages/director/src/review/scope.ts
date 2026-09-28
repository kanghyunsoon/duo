/**
 * R-SCOPE for new files (T13.1, ADR-007). With a task, an added application source file that is
 * neither in the task's context nor linked to any Requirement by an IMPLEMENTS edge is a scope
 * drift signal: UNKNOWN, a semantic candidate, never blockEligible. It counts toward WARN unless
 * project.yaml review.warn_on_unlinked_addition is false. Only files DUO knows to be application
 * source qualify: an analyzed language, and none of the test, configuration, tooling, generated,
 * documentation or Project Truth patterns below. Being unlinked alone is not a finding for those.
 */
import { fileRef, STATE_DIR_NAME, type EntityRef, type RepoPath } from "@duo-director/core";
import { makeClaim, nodeEvidence, type RuleContext } from "./claims.js";
import type { ReviewClaim } from "./types.js";

export type NonApplicationReason = "project-truth" | "test" | "configuration" | "tooling" | "generated" | "documentation" | "declaration";

const TEST_NAME = /(?:\.|^)(?:test|spec|e2e|stories|story|bench)\.[cm]?[jt]sx?$/u;
/**
 * Test file names in Java, C#, C++ and Python (T18.0): FooTest.java, FooTests.cs, FooIT.java,
 * foo_test.cpp, foo_unittest.cc, test_foo.py, foo_test.py, conftest.py.
 */
const OTHER_TEST_NAME = /^(?:\w+(?:Tests?|IT)\.(?:java|cs|cpp|cc|cxx)|\w+_(?:test|unittest)\.(?:cpp|cc|cxx|py)|test_\w+\.py|conftest\.py)$/u;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "spec", "specs", "e2e", "fixtures", "__fixtures__", "testing"]);
const SETUP_NAME = /^(?:setup-?tests?|test-?setup|[a-z]+\.setup)\.[cm]?[jt]sx?$/iu;
const CONFIG_NAME = /(?:^|\.)config\.[cm]?[jt]sx?$|^\.[^/]*rc\.[cm]?[jt]sx?$|^(?:gulpfile|gruntfile|jakefile|webpack\.[a-z]+)\.[cm]?[jt]s$|^setup\.py$|^noxfile\.py$|\.(?:Build|Target)\.cs$/iu;
const TOOLING_DIRS = new Set(["scripts", "script", "tools", "tooling", ".github", ".husky", ".vscode", ".storybook", ".devcontainer"]);
const GENERATED_DIRS = new Set([
  "dist", "build", "out", "coverage", "node_modules", "generated", "__generated__", ".next", ".turbo", "vendor",
  "target", "obj", "__pycache__", ".venv", "venv", "site-packages", "intermediate", "binaries",
]);
const GENERATED_NAME = /\.(?:generated|gen|min)\.[cm]?[jt]sx?$|\.(?:g|g\.i|designer)\.cs$|\.generated\.h$|_pb2(?:_grpc)?\.py$|\.pb\.(?:h|cc)$/iu;
const DOC_DIRS = new Set(["docs", "doc", "examples", "example"]);

/** Why a path is not application source for R-SCOPE, or undefined when it may be. */
export function nonApplicationReason(path: RepoPath): NonApplicationReason | undefined {
  if (path === STATE_DIR_NAME || path.startsWith(`${STATE_DIR_NAME}/`)) return "project-truth";
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  const dirs = segments.slice(0, -1).map((s) => s.toLowerCase());
  if (TEST_NAME.test(name) || OTHER_TEST_NAME.test(name) || SETUP_NAME.test(name) || dirs.some((d) => TEST_DIRS.has(d))) return "test";
  if (dirs.some((d) => GENERATED_DIRS.has(d)) || GENERATED_NAME.test(name)) return "generated";
  if (CONFIG_NAME.test(name)) return "configuration";
  if (dirs.some((d) => TOOLING_DIRS.has(d))) return "tooling";
  if (dirs.some((d) => DOC_DIRS.has(d))) return "documentation";
  if (/\.d\.[cm]?ts$/u.test(name)) return "declaration";
  return undefined;
}

const ADDED = new Set(["added", "untracked", "copied"]);

/** Claims for unlinked added application files, and the paths they cover (scope-relevance skips them). */
export function unlinkedAdditions(ctx: RuleContext): { readonly claims: ReviewClaim[]; readonly covered: ReadonlySet<string> } {
  const scope = ctx.taskScope;
  const claims: ReviewClaim[] = [];
  const covered = new Set<string>();
  if (scope === undefined) return { claims, covered };
  const warn = ctx.truth.config.review.warnOnUnlinkedAddition;
  for (const f of ctx.files) {
    if (!ADDED.has(f.kind) || nonApplicationReason(f.path) !== undefined) continue;
    const node = ctx.graph.getNode(fileRef(f.path));
    if (node === undefined || typeof node.payload.language !== "string") continue;
    const seeds = ctx.seeds.filter((s) => s.path === f.path);
    if (scope.has(node.id) || seeds.some((s) => scope.has(s.id))) continue;
    // The file, and every symbol and test it owns: a "duo:" annotation links the symbol it documents, not the file.
    const owned = ctx.graph.listNodes({ ownerFile: f.path, limit: 10_000 }).map((n) => n.ref);
    const from: EntityRef[] = [fileRef(f.path), ...seeds.map((s) => s.entity), ...owned];
    if (ctx.graph.adjacentEdges(from, { direction: "outgoing", types: ["IMPLEMENTS"], limit: 1 }).edges.length > 0) continue;
    const c = makeClaim(ctx, {
      rule: "unlinked-addition", subject: { kind: "file", id: f.path }, alignment: "UNKNOWN", reason: "added-file-unlinked", drift: warn, semantic: true,
      expected: "a new application file serves the task or implements a Requirement",
      observed: `${f.path} was added outside the task's context and no Requirement links to it (a scope drift signal, not a conflict)`,
      evidence: [nodeEvidence(ctx, node), ...f.evidenceIds],
    });
    if (c === undefined) continue;
    claims.push(c);
    covered.add(f.path);
  }
  return { claims, covered };
}
