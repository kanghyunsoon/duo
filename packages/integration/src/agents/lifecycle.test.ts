/**
 * #27: one regression suite for what install, update and remove do to a person's own agent files.
 * Each case runs one repository through install → update (install again over the bridge block an
 * older DUO wrote) → remove → remove again, in temp directories only. Planning sees a fake duoctl on a
 * PATH of its own; nothing is started and the developer's ~/.codex and Claude settings are never read.
 * "byte for byte" and "value-level" in the test names say how strictly a file comes back.
 * .duo-project/ (Truth and DUO's backups) is outside the comparison.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_FILE_NAME, STATE_DIR_NAME } from "@duo-director/core";
import { afterAll, describe, expect, it } from "vitest";
import { BRIDGE_MARKERS, bridgeLines } from "./bridge.js";
import { CODEX_MARKERS, codexBlockLines } from "./codex.js";
import { applyAgentIntegration, inspectAgentIntegration, planAgentIntegration, planAgentRemoval } from "./integration.js";
import { upsertBlock } from "./managed-block.js";
import type { AgentId, AgentIntegrationPlan } from "./types.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-lifecycle-"))); temps.push(d); return d; };

const bin = tmp();
fs.writeFileSync(path.join(bin, process.platform === "win32" ? "duoctl.cmd" : "duoctl"), "", { mode: 0o755 });
const host = { env: { PATH: bin, PATHEXT: ".CMD;.EXE" }, platform: process.platform };

const TARGETS = { codex: { mcp: ".codex/config.toml", bridge: "AGENTS.md" }, "claude-code": { mcp: ".mcp.json", bridge: "CLAUDE.md" } } as const;
const current = bridgeLines("duoctl");
const block031 = [...current.slice(0, 7), BRIDGE_MARKERS.end];
/** The 0.3.2 block: the current one without the re-check line added in T76 (#8). */
const block032 = current.filter((l) => !l.startsWith("- If the duo_* tools are not in your tool list"));

const NOTES = "# Team rules\n\nUse tabs. Run the tests before a commit.\n";
const TOML = [
  "# Team Codex settings",
  "model = \"gpt-5\"",
  "approval_policy = \"on-request\"   # keep this comment",
  "",
  "[mcp_servers.docs]",
  "command = \"npx\"",
  "args = [\"-y\", \"docs-server\"]",
  "",
  "[mcp_servers.docs.env]",
  "LOG_LEVEL = \"warn\"",
  "",
].join("\n");
const SERVERS = { docs: { command: "npx", args: ["-y", "docs-server"], env: { LOG_LEVEL: "warn" } }, db: { type: "stdio", command: "db-mcp", args: [] } };
const JSON_2 = JSON.stringify({ mcpServers: SERVERS, inputs: [] }, null, 2) + "\n";
const JSON_4_CRLF = (JSON.stringify({ mcpServers: SERVERS }, null, 4) + "\n").replaceAll("\n", "\r\n");
const JSON_BY_HAND = "{ \"mcpServers\": { \"docs\": { \"command\": \"npx\", \"args\": [\"-y\", \"docs-server\"], \"env\": { \"LOG_LEVEL\": \"warn\" } }, \"db\": { \"type\": \"stdio\", \"command\": \"db-mcp\", \"args\": [] } } }\n";

type Files = Record<string, string>;

function repo(files: Files): string {
  const root = tmp();
  fs.mkdirSync(path.join(root, STATE_DIR_NAME));
  fs.writeFileSync(path.join(root, STATE_DIR_NAME, PROJECT_FILE_NAME), "name: lifecycle\n");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** Every file outside .duo-project/, with its exact text. */
function files(root: string): Files {
  const out: Files = {};
  for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
    const name = rel.replaceAll("\\", "/");
    if (name === STATE_DIR_NAME || name.startsWith(STATE_DIR_NAME + "/")) continue;
    if (fs.statSync(path.join(root, rel)).isFile()) out[name] = fs.readFileSync(path.join(root, rel), "utf8");
  }
  return out;
}

async function apply(root: string, plan: AgentIntegrationPlan): Promise<string[]> {
  expect(plan.blockers).toEqual([]);
  const applied = await applyAgentIntegration(root, plan);
  expect(applied.diagnostics).toEqual([]);
  return (applied.value?.changed ?? []).map((c) => c.action + " " + c.path);
}

/** install → update → remove → remove again. Returns what each step changed. */
async function lifecycle(root: string, agent: AgentId) {
  const install = await apply(root, planAgentIntegration(root, agent, { host }));
  expect(inspectAgentIntegration(root, agent).status).toBe("configured");
  expect(planAgentIntegration(root, agent, { host }).noop).toBe(true);

  const bridge = path.join(root, TARGETS[agent].bridge);
  fs.writeFileSync(bridge, upsertBlock(fs.readFileSync(bridge, "utf8"), block032, BRIDGE_MARKERS));
  const updatePlan = planAgentIntegration(root, agent, { host });
  expect(updatePlan).toMatchObject({ mcp: { action: "none" }, bridge: { status: "outdated", action: "modify" } });
  const update = await apply(root, updatePlan);

  const remove = await apply(root, planAgentRemoval(root, agent));
  expect(inspectAgentIntegration(root, agent).status).toBe("not-configured");

  const afterRemove = files(root);
  const againPlan = planAgentRemoval(root, agent);
  expect(againPlan.noop).toBe(true);
  const removeAgain = await apply(root, againPlan);
  expect(files(root)).toEqual(afterRemove);
  return { install, update, remove, removeAgain };
}

describe("agent files across install → update → remove → remove again (#27)", () => {
  for (const agent of ["codex", "claude-code"] as const) {
    const t = TARGETS[agent];
    it(agent + ", empty repository: the files DUO created alone are deleted, and so is an empty .codex/", async () => {
      const root = repo({});
      expect(await lifecycle(root, agent)).toEqual({
        install: ["create " + t.mcp, "create " + t.bridge], update: ["modify " + t.bridge], remove: ["delete " + t.mcp, "delete " + t.bridge], removeAgain: [],
      });
      expect(files(root)).toEqual({});
      expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
    });
  }

  it("codex, existing user files: TOML with comments and other servers, an AGENTS.md with CRLF and other files come back byte for byte", async () => {
    const user = { ".codex/config.toml": TOML, "AGENTS.md": NOTES.replaceAll("\n", "\r\n"), "README.md": "# App\n" };
    const root = repo(user);
    expect(await lifecycle(root, "codex")).toEqual({
      install: ["modify .codex/config.toml", "modify AGENTS.md"], update: ["modify AGENTS.md"], remove: ["modify .codex/config.toml", "modify AGENTS.md"], removeAgain: [],
    });
    expect(files(root)).toEqual(user);
  });

  for (const [style, json] of [["2-space LF", JSON_2], ["4-space CRLF", JSON_4_CRLF]] as const) {
    it("claude-code, existing user files: a " + style + " .mcp.json with other servers and keys, and CLAUDE.md, come back byte for byte", async () => {
      const user = { ".mcp.json": json, "CLAUDE.md": NOTES };
      const root = repo(user);
      expect(await lifecycle(root, "claude-code")).toEqual({
        install: ["modify .mcp.json", "modify CLAUDE.md"], update: ["modify CLAUDE.md"], remove: ["modify .mcp.json", "modify CLAUDE.md"], removeAgain: [],
      });
      expect(files(root)).toEqual(user);
    });
  }

  it("claude-code, hand-formatted .mcp.json: restored byte for byte from the verified pre-install backup when untouched; falls back to value-level when backup is absent (H-94)", async () => {
    const user = { ".mcp.json": JSON_BY_HAND, "CLAUDE.md": NOTES };
    const root = repo(user);
    await lifecycle(root, "claude-code");
    expect(files(root)).toEqual(user);

    // Without the backup, value-level preservation still holds.
    const rootNoBackup = repo(user);
    await apply(rootNoBackup, planAgentIntegration(rootNoBackup, "claude-code", { host }));
    fs.rmSync(path.join(rootNoBackup, STATE_DIR_NAME, "runtime/backup"), { recursive: true, force: true });
    await apply(rootNoBackup, planAgentRemoval(rootNoBackup, "claude-code"));
    const after = files(rootNoBackup);
    expect(after[".mcp.json"]).not.toBe(JSON_BY_HAND);
    expect(JSON.stringify(JSON.parse(after[".mcp.json"] as string))).toBe(JSON.stringify(JSON.parse(JSON_BY_HAND)));
    expect(after["CLAUDE.md"]).toBe(NOTES);
  });

  it("codex, an older DUO install (drifted entry, 0.3.1 bridge): install updates both, and remove leaves the user's TOML and AGENTS.md byte for byte", async () => {
    const root = repo({
      ".codex/config.toml": upsertBlock(TOML, codexBlockLines({ command: "duoctl", args: ["mcp", "--root-from", "git-cwd"] }), CODEX_MARKERS),
      "AGENTS.md": upsertBlock(NOTES, block031, BRIDGE_MARKERS),
    });
    expect(inspectAgentIntegration(root, "codex")).toMatchObject({ mcp: { status: "drifted" }, bridge: { status: "outdated" } });
    expect(await lifecycle(root, "codex")).toEqual({
      install: ["modify .codex/config.toml", "modify AGENTS.md"], update: ["modify AGENTS.md"], remove: ["modify .codex/config.toml", "modify AGENTS.md"], removeAgain: [],
    });
    expect(files(root)).toEqual({ ".codex/config.toml": TOML, "AGENTS.md": NOTES });
  });

  it("claude-code, an older DUO install (older launch, 0.3.1 bridge): install updates both, and remove leaves the other servers and CLAUDE.md byte for byte", async () => {
    const older = { mcpServers: { ...SERVERS, "duo-director": { command: "duoctl", args: ["mcp", "--root", "/abs/repo"] } }, inputs: [] };
    const root = repo({ ".mcp.json": JSON.stringify(older, null, 2) + "\n", "CLAUDE.md": upsertBlock(NOTES, block031, BRIDGE_MARKERS) });
    expect(inspectAgentIntegration(root, "claude-code")).toMatchObject({ mcp: { status: "compatible-different-format" }, bridge: { status: "outdated" } });
    expect(await lifecycle(root, "claude-code")).toEqual({
      install: ["modify .mcp.json", "modify CLAUDE.md"], update: ["modify CLAUDE.md"], remove: ["modify .mcp.json", "modify CLAUDE.md"], removeAgain: [],
    });
    expect(files(root)).toEqual({ ".mcp.json": JSON_2, "CLAUDE.md": NOTES });
  });

  it("codex, text-level: a file without a final newline gets one when edited after install; text a person adds below the DUO block stays, after DUO's blank line", async () => {
    const root = repo({ ".codex/config.toml": "model = \"x\"", "AGENTS.md": "Use tabs." });
    await apply(root, planAgentIntegration(root, "codex", { host }));
    fs.appendFileSync(path.join(root, "AGENTS.md"), "Added later by a person.\n");
    await apply(root, planAgentRemoval(root, "codex"));
    expect(files(root)).toEqual({ ".codex/config.toml": "model = \"x\"", "AGENTS.md": "Use tabs.\n\nAdded later by a person.\n" });
  });

  it("claude-code, #104 (H-94): remove preserves a user .mcp.json that had no other servers; CLAUDE.md comes back byte for byte", async () => {
    const user = { ".mcp.json": "{\n  \"mcpServers\": {}\n}\n", "CLAUDE.md": NOTES };
    const root = repo(user);
    expect((await lifecycle(root, "claude-code")).remove).toEqual(["modify .mcp.json", "modify CLAUDE.md"]);
    expect(files(root)).toEqual(user);
  });

  it("fix for #104 (H-94): remove brings back pre-existing empty .mcp.json, CLAUDE.md, AGENTS.md and .codex/config.toml byte for byte", async () => {
    for (const [agent, user] of [
      ["claude-code", { ".mcp.json": "{\"mcpServers\":{}}", "CLAUDE.md": "" }],
      ["codex", { ".codex/config.toml": "", "AGENTS.md": "" }],
    ] as const) {
      const root = repo(user);
      const t = TARGETS[agent];
      expect((await lifecycle(root, agent)).remove).toEqual(["modify " + t.mcp, "modify " + t.bridge]);
      expect(files(root)).toEqual(user);
    }
  });
});
