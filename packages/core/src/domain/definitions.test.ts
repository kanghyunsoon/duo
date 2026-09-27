import { describe, expect, it } from "vitest";
import { parseDefinitionMarkdown } from "./definitions.js";

const parse = (...lines: string[]) => parseDefinitionMarkdown(".duo-project/specs/x.md", lines.join("\n"));
const codes = (r: ReturnType<typeof parse>) => r.diagnostics.map((d) => [d.code, d.source?.startLine]);
const block = (...yaml: string[]) => ["```duo", ...yaml, "```"];

describe("parseDefinitionMarkdown", () => {
  it("reads a requirement with its section, location and references", () => {
    const r = parse(
      "# Spec", "",
      "## AUTH-01 Login", "", ...block("status: done", "milestone: M1", "depends_on: [AUTH-00]"), "",
      "Users log in.", "", "### Notes", "", "More.", "",
      "## AUTH-02 Logout", "", ...block("priority: should"),
    );
    expect(r.diagnostics).toEqual([]);
    const [first, second] = r.value?.requirements ?? [];
    expect(first).toMatchObject({
      id: "AUTH-01", title: "Login", status: "done", milestone: "M1", dependsOn: ["AUTH-00"],
      location: { path: ".duo-project/specs/x.md", startLine: 3, endLine: 16 },
    });
    expect(first?.description).toContain("Users log in.");
    expect(first?.description).toContain("More.");
    expect(first?.references.map((ref) => [ref.field, ref.target, ref.location.startLine, ref.relation?.type])).toEqual([
      ["milestone", "M1", 7, "REQUIRES"],
      ["depends_on", "AUTH-00", 8, "REQUIRES"],
    ]);
    expect(second).toMatchObject({ id: "AUTH-02", status: "planned", milestone: null, priority: "should" });
  });

  it("reads an issue and its acceptance criteria", () => {
    const r = parse(
      "## TASK-001 Skeleton", "", ...block("type: issue", "status: todo", "requirements: [REQ-A-001]"), "",
      "- **AC-001-01** builds", "- **AC-001-02** tests pass", "- plain item", "- **AC-1** malformed",
    );
    const issue = r.value?.issues[0];
    expect(issue?.acceptance.map((a) => [a.id, a.text, a.location.startLine])).toEqual([
      ["AC-001-01", "builds", 9],
      ["AC-001-02", "tests pass", 10],
    ]);
    expect(codes(r)).toEqual([["INVALID_ID", 12]]);
  });

  it("reads milestones and ADR-style frontmatter decisions", () => {
    const r = parseDefinitionMarkdown("docs/adr/ADR-001.md", [
      "---", "id: ADR-001", "type: decision", "title: Runtime", "state: confirmed", "question: runtime", "answer: node",
      "governs:", "  requirements: [REQ-A-001]", "---", "", "# ADR-001: Runtime", "",
      "## M1 First", "", ...block("type: milestone", "title: First", "state: active"),
    ].join("\n"));
    expect(r.diagnostics).toEqual([]);
    expect(r.value?.decisions[0]).toMatchObject({ id: "ADR-001", state: "confirmed", governs: { requirements: ["REQ-A-001"] } });
    expect(r.value?.milestones[0]).toMatchObject({ id: "M1", title: "First", state: "active" });
  });

  it("reports a metadata block that does not follow a definition heading", () => {
    expect(codes(parse("Some text", "", ...block("status: planned")))).toEqual([["METADATA_BLOCK_WITHOUT_HEADING", 3]]);
  });

  it("reports an invalid heading ID", () => {
    expect(codes(parse("## auth-01 Login", "", ...block("status: planned")))).toEqual([["INVALID_ID", 1]]);
  });

  it("warns about an ID heading without a metadata block and ignores other fence languages", () => {
    const r = parse("## AUTH-01 Login", "", "```yaml", "status: planned", "```");
    expect(r.value?.requirements).toEqual([]);
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([["METADATA_BLOCK_MISSING", "warning"]]);
  });

  it("locates schema errors on the file line inside the block", () => {
    expect(codes(parse("## AUTH-01 Login", "", ...block("status: started", "milstone: M1")))).toEqual([
      ["SCHEMA_UNKNOWN_PROPERTY", 5],
      ["SCHEMA_INVALID_VALUE", 4],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(codes(parse("## AUTH-01 Login", "", ...block("type: epic")))).toEqual([["SCHEMA_INVALID_VALUE", 4]]);
    expect(codes(parse("## AUTH-01 Login", "", ...block("depends_on: [auth-0]")))).toEqual([["INVALID_ID", 4]]);
  });

  it("keeps custom data only under extensions", () => {
    const r = parse("## AUTH-01 Login", "", ...block("extensions:", "  team: auth"));
    expect(r.value?.requirements[0]?.extensions).toEqual({ team: "auth" });
  });
});
