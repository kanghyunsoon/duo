/**
 * MCP Registry metadata (T178). server.json is what `mcp-publisher publish` would send to the official registry;
 * the registry checks that the published npm package.json carries the same name in `mcpName`. Publishing is a
 * separate maintainer approval (docs/release/mcp-registry.md); this test only keeps the files in step.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
interface Arg { readonly type: string; readonly value: string }
interface Pkg { readonly registryType: string; readonly registryBaseUrl: string; readonly identifier: string; readonly version: string; readonly runtimeHint: string; readonly transport: { readonly type: string }; readonly packageArguments: readonly Arg[] }
interface Server { readonly $schema: string; readonly name: string; readonly version: string; readonly description: string; readonly repository: { readonly url: string; readonly source: string }; readonly packages: readonly Pkg[] }
interface Cli { readonly name: string; readonly version: string; readonly mcpName?: string; readonly repository: { readonly url: string } }
const read = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")) as T;

describe("MCP Registry metadata (server.json)", () => {
  const server = read<Server>("server.json");
  const cli = read<Cli>("apps/cli/package.json");

  it("uses the 2025-12-11 schema and a GitHub namespace the maintainer owns", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe("io.github.kanghyunsoon/duo");
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/u);
  });

  it("names the same server as the CLI package's mcpName (registry ownership check)", () => {
    expect(cli.mcpName).toBe(server.name);
  });

  it("follows the CLI version, so a release bump must update server.json too", () => {
    expect(server.version).toBe(cli.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", registryBaseUrl: "https://registry.npmjs.org", identifier: cli.name, version: cli.version, runtimeHint: "npx", transport: { type: "stdio" } });
  });

  it("starts the server the way duoctl install configures Codex: duoctl mcp --root-from git-cwd", () => {
    expect(server.packages[0]?.packageArguments.map((a) => [a.type, a.value])).toEqual([["positional", "mcp"], ["positional", "--root-from"], ["positional", "git-cwd"]]);
  });

  it("keeps the registry limits and points at this repository", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.repository).toEqual({ url: "https://github.com/kanghyunsoon/duo", source: "github" });
    expect(cli.repository.url).toContain("github.com/kanghyunsoon/duo");
  });
});
