/**
 * #220: the run() catch-all. An exception a command did not anticipate is CLI_INTERNAL_ERROR, never
 * CLI_USAGE_INVALID; a CliFailure keeps its own diagnostics; real usage errors keep CLI_USAGE_INVALID.
 * stats is replaced so the test controls what the command throws.
 */
import { createDiagnostic } from "@duo-director/core";
import { describe, expect, it, vi } from "vitest";
import { CliFailure } from "./commands/shared.js";

const stats = vi.hoisted(() => ({ throws: (): unknown => new Error("unset") }));
vi.mock("./commands/stats.js", () => ({ statsCommand: () => { throw stats.throws(); } }));

const { run } = await import("./cli.js");

async function capture(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (l) => out.push(l), err: (l) => err.push(l), isTTY: false,
    prompt: () => Promise.resolve(undefined), readStdin: () => Promise.resolve(""), cwd: () => "/nonexistent-duo-root", now: () => new Date(0), env: {},
  });
  return { code, out, err };
}

const SECRET = "ghp_" + "a".repeat(36);

describe("CLI catch-all (#220)", () => {
  it("reports an unexpected exception as CLI_INTERNAL_ERROR in the --json envelope, exit 1", async () => {
    stats.throws = () => new TypeError("a.statements is not iterable");
    const { code, out, err } = await capture(["stats", "--json"]);
    expect(code).toBe(1);
    expect(err).toEqual([]);
    expect(JSON.parse(out.join("\n"))).toEqual({
      format: "duo.cli.stats/1", command: "stats", ok: false, exitCode: 1, result: null,
      diagnostics: [expect.objectContaining({ code: "CLI_INTERNAL_ERROR", severity: "error", message: "a.statements is not iterable" })],
    });
  });

  it("tells a human it is a DUO bug to report, in the chosen locale, without a stack", async () => {
    stats.throws = () => new Error("Debug Failure. Expected C:/repo/tsconfig.json");
    const en = await capture(["stats"]);
    expect(en.code).toBe(1);
    expect(en.out).toEqual([]);
    expect(en.err[0]).toBe("CLI_INTERNAL_ERROR: Debug Failure. Expected C:/repo/tsconfig.json");
    expect(en.err[1]).toContain("internal DUO error, not a problem with your command line");
    expect(en.err.join("\n")).not.toMatch(/CLI_USAGE_INVALID|\n\s+at /u);
    const ko = await capture(["stats", "--locale", "ko"]);
    expect(ko.err[1]).toContain("DUO 내부 오류");
  });

  it("keeps a thrown non-Error value and redacts known credential formats", async () => {
    stats.throws = () => "token " + SECRET + " rejected";
    const { out } = await capture(["stats", "--json"]);
    const [diagnostic] = (JSON.parse(out.join("\n")) as { diagnostics: { code: string; message: string }[] }).diagnostics;
    expect(diagnostic).toMatchObject({ code: "CLI_INTERNAL_ERROR", message: "token [REDACTED] rejected" });
    expect(out.join("\n")).not.toContain(SECRET);
  });

  it("passes a CliFailure through with its own codes and messages", async () => {
    stats.throws = () => new CliFailure([createDiagnostic("GRAPH_WRITE_REFUSED", "graph is locked by another writer")]);
    const json = await capture(["stats", "--json"]);
    expect(json.code).toBe(1);
    expect((JSON.parse(json.out.join("\n")) as { diagnostics: unknown[] }).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_WRITE_REFUSED", message: "graph is locked by another writer" }),
    ]);
    const human = await capture(["stats"]);
    expect(human.err).toEqual(["GRAPH_WRITE_REFUSED: graph is locked by another writer"]);
  });

  it("keeps CLI_USAGE_INVALID for a command line that does not fit the command", async () => {
    const { code, out } = await capture(["context", "--json"]);
    expect(code).toBe(1);
    expect((JSON.parse(out.join("\n")) as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code)).toEqual(["CLI_USAGE_INVALID"]);
  });
});
