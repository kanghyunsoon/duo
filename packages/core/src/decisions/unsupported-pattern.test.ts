/**
 * Repository patterns accept only "*" and "?" within a segment, "**" as a whole segment and a trailing "/" (docs
 * 03-data-model). Anything else is matched literally, so a forbids.paths rule with a brace list such as
 * "*.{png,webp}" matches no file: it is proposed, confirmed and loaded without a word, and the rule silently never
 * fires (0.3.5 and next).
 *
 * These cases pin that unsupported syntax is not accepted silently: a proposal is refused, and a Decision already in
 * Project Truth is reported with the pattern. They fail on next 4ab480f. Whether a confirmed Decision with such a
 * pattern is an error or a warning, and what "[" means, are open decisions on the issue; these cases do not assume
 * either.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadProjectTruth } from "../loader/project.js";
import type { DecisionActor } from "./files.js";
import { createDecisionService } from "./service.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const agent: DecisionActor = { kind: "agent", name: "codex" };
let root: string;
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); };
const svc = () => createDecisionService({ root, clock: () => new Date("2026-11-04T00:00:00.000Z") });

/** Unsupported glob syntax that is matched literally today. */
const UNSUPPORTED = ["src/pikachu/**/*.{png,PNG,webp}", "src/{a,b}/legacy.ts", "!src/pikachu/keep.png", "src/pikachu/**.png", "src/a**/x.ts"];
/** Supported syntax keeps working. */
const SUPPORTED = ["src/pikachu/**/*.png", "src/pikachu/sprite?.png", "public/pikachu/", "src/**", "docs/*.md"];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-glob-")));
  temps.push(root);
  write(".duo-project/project.yaml", "schema_version: 1\nname: glob\n");
});

describe("unsupported glob syntax in Decision patterns is not accepted silently", () => {
  it.each(UNSUPPORTED)("a proposal with forbids.paths %s is refused", async (pattern) => {
    const r = await svc().propose(agent, { title: "No assets", question: "assets", answer: "none", forbids: { paths: [pattern] } });
    expect(r.value, "proposal was written").toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain("PROPOSAL_INVALID");
    expect(r.diagnostics.map((d) => d.message).join("\n")).toContain(pattern);
  });

  it.each(SUPPORTED)("a proposal with forbids.paths %s is still accepted", async (pattern) => {
    const r = await svc().propose(agent, { title: "No assets", question: "assets", answer: "none", forbids: { paths: [pattern] } });
    expect(r.value?.proposalId).toBe("P-001");
  });

  it.each(UNSUPPORTED)("a Decision in Project Truth with forbids.paths %s is reported, naming the pattern", (pattern) => {
    write(".duo-project/decisions/D-001.yaml", [
      "id: D-001", "title: No assets", "kind: decision", "state: confirmed", "question: assets", "answer: none", "owner: human",
      "forbids:", "  paths: [" + JSON.stringify(pattern) + "]", "enforcement: block", 'confirmed_at: "2026-11-04T00:00:00Z"', "confirmed_by: tester", "",
    ].join("\n"));
    const loaded = loadProjectTruth(root);
    expect(loaded.diagnostics.map((d) => d.message).join("\n")).toContain(pattern);
  });
});

