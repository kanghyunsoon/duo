import { describe, expect, it } from "vitest";
import { parseYaml } from "./yaml.js";

const parse = (text: string, startLine?: number) =>
  parseYaml(startLine === undefined ? { path: "a.yaml", text } : { path: "a.yaml", text, startLine });
const codes = (r: ReturnType<typeof parse>) => r.diagnostics.map((d) => d.code);

describe("parseYaml", () => {
  it("returns plain data and locates keys and values", () => {
    const r = parse("id: D-004\ngoverns:\n  requirements: [AUTH-01, AUTH-03]\n");
    expect(r.value?.data).toEqual({ id: "D-004", governs: { requirements: ["AUTH-01", "AUTH-03"] } });
    expect(r.value?.locate(["governs", "requirements", 1])).toMatchObject({ path: "a.yaml", startLine: 3, startColumn: 27 });
    expect(r.value?.locate(["governs"], "key")).toMatchObject({ startLine: 2, startColumn: 1 });
  });

  it("offsets lines for YAML embedded in another file", () => {
    expect(parse("a: 1\nb: 2\n", 10).value?.locate(["b"])).toMatchObject({ startLine: 11 });
  });

  it("reports syntax errors with a location instead of throwing", () => {
    const r = parse("a: [1\nb: 2\n");
    expect(r.value).toBeUndefined();
    expect(codes(r)).toContain("YAML_SYNTAX_ERROR");
    expect(r.diagnostics[0]?.source?.startLine).toBeGreaterThan(0);
  });

  it("rejects duplicate keys", () => {
    const r = parse("a: 1\na: 2\n");
    expect(codes(r)).toEqual(["YAML_SYNTAX_ERROR"]);
    expect(r.diagnostics[0]?.message).toContain("DUPLICATE_KEY");
    expect(r.diagnostics[0]?.source?.startLine).toBe(2);
  });

  it("rejects anchors and aliases", () => {
    const r = parse("a: &x [1]\nb: *x\n");
    expect(r.value).toBeUndefined();
    expect(r.diagnostics.map((d) => [d.code, d.source?.startLine])).toEqual([
      ["YAML_ALIAS_NOT_ALLOWED", 1],
      ["YAML_ALIAS_NOT_ALLOWED", 2],
    ]);
  });

  it.each(["!!js/function 'function () {}'", "!custom x", "!!str 1"])("rejects explicit tag %s", (value) => {
    const r = parse(`a: ${value}\n`);
    expect(r.value).toBeUndefined();
    expect(codes(r)).toEqual(["YAML_TAG_NOT_ALLOWED"]);
  });

  it("does not treat << as a merge key", () => {
    expect(parse("base: 1\n<<: {a: 1}\n").value?.data).toEqual({ base: 1, "<<": { a: 1 } });
  });
});
