# DUO 0.2.0 release notes

Correctness, freshness, onboarding and an explicitly configured OpenAI-compatible provider on top of 0.1.2. Existing projects need no re-initialization, no re-adoption and no Truth migration: run `duoctl index` once after upgrading.

## Highlights

- **Overload evidence is complete for Java, C# and C++.** Context, Evidence and Review read every overload body behind a Symbol, so no overload is silently left out.
- **Better Python source-root discovery.** Absolute imports resolve under source roots found from the package structure and project metadata (for example `pyproject.toml`, `setup.cfg`), not only the repository root and `src/`.
- **Fewer false ambiguities for C++ declarations and definitions.** A header declaration and its out-of-line `.cpp` definition that are proven to be the same callable are treated as one Context target.
- **Decision references to C++ declaration/definition pairs resolve.** A Decision or Requirement that names such a pair by qualified name now governs both locations.
- **Faster freshness checks.** The same answers with less work: analysis cache verification runs with bounded concurrency and each operation asks Git for the work-tree prefix once.
- **`duoctl doctor`**: one read-only check of the whole setup with the next one to three steps.
- **Clearer guidance when a Context request is ambiguous**, for coding agents (MCP) and in the CLI.
- **Explicit OpenAI-compatible endpoint support** (`llm.provider: openai-compatible`), alongside the unchanged official OpenAI provider.

## Correctness

- **Overloads (Java, C#, C++).** An overload set stays one Symbol, as before. Context, Evidence and the Review diff seeds now read all of its locations (the primary source and the additional locations). Symbol IDs, Graph schema, public formats, Truth and baseline interpretation are unchanged. Telling individual overloads apart (member identity) is not part of this release.
- **Python source roots.** Roots are discovered from package structure and project metadata. Directory names alone are not used. When a module exists under two roots a file could use, DUO creates no import edge rather than guessing. Results are recomputed when files are added or removed and when metadata content changes.
- **Python effective definition.** When the same name is defined more than once in one scope, the Symbol's primary location is now the definition that takes effect where syntax shows it: the last plain redefinition in the same suite, or the implementation behind recognized `typing.overload` stubs. Other cases (properties, conditional definitions, unknown decorators) keep the first definition as primary. Evidence pointers, search locations, Context items and the UI's "Show lines" point to that definition. Evidence IDs and hashes still cover every definition.
- **C++ declaration/definition pairs.** When syntax proves that a header declaration and an out-of-line definition are the same callable, the pair is recorded as index metadata. Context shows both ranges in one item and uses the pair as the seed instead of reporting ambiguity. Symbol IDs, Graph nodes, edges, Evidence and Review seeds are unchanged.
- **Truth references to C++ pairs.** A qualified-name reference (`governs.symbols`, `implements.symbols`) that matches several C++ Symbols resolves only when all matches form exactly one proven declaration/definition group. Every other case (overload groups, a pair plus another Symbol, other languages) behaves as before. This does not mean DUO understands C++ declarations in general.
- **Indexes from older DUO versions are reported stale.** The index now records the version of its relation rules. After an upgrade the first check reports the index as `stale`, never silently `current`, and one `duoctl index` brings it up to date.

Python and C++ remain L1, and TypeScript/JavaScript remain the only L2 languages.

## Freshness & Performance

- Analysis cache verification reads entries with bounded concurrency (16) and keeps the same per-entry checks and result order. The Indexer and the status check share one validity check.
- One work-tree prefix query per freshness or index operation, shared by the file scan and the Git provider.
- Freshness decisions are unchanged. Inspect results, diagnostics, incremental and clean full Graphs were byte-identical across builds in the regression scenarios, and incremental results equal a clean full rebuild.
- Measured on the reference Windows machine, the median no-op freshness check got 138–536 ms faster on five pinned real-world repositories and about 1.6 s faster on the synthetic 5,000-file fixture. Context and Review times did not change beyond sample noise. These numbers are measurements, not guarantees ([performance benchmark](../performance-benchmark.md)).
- Scan and fingerprint costs were audited. The remaining cost is reading and hashing every byte (required for correct content hashes) and Git process time, so no further change was made.

## Doctor & Onboarding

- **`duoctl doctor`** checks Git (repository, first commit, working tree), Project Truth, the index, the analysis level per language (L0/L1/L2), connected agents (it starts their MCP server) and the optional LLM settings, then lists the first one to three things to do. It is read-only: it never initializes, indexes, installs or changes a file. An agent you have not connected and a disabled LLM are reported as normal, and DUO does not recommend Codex over Claude Code or the other way round. Exit code 6 only when a check is an error. `--json` returns `duo.cli.doctor/1` with the result `duo.doctor/1`.
- `duoctl init` ends with the next steps, and `duoctl context` gives a hint when the request is ambiguous.
- `duoctl install <agent>` verification now checks the MCP tool list against DUO's tool table and redacts the server's launch output.
- **Ambiguity remediation.** When `duo_get_context` or `duoctl context` returns `ambiguous`, the text names only handles that actually tell the candidates apart: a file path when they are in different files, a qualified name in the same file, or a Requirement or Decision ID. When no safe handle exists, it says so. Only wording changed. Resolver results, candidates, ranking and the structured payload are unchanged, and no absolute paths are shown.

## OpenAI-Compatible Providers

LLM use stays optional and off by default (`llm.provider: none`: no provider client, no network, no semantic request).

- **New: `openai-compatible`** for an endpoint you configure explicitly. All five settings are required, with no defaults: `model`, `base_url`, `transport` (`responses` or `chat-completions`), `api_key_env` (the name of the environment variable that holds the key) and `structured_output` (`json-schema`, `json-object` or `prompt-only`).
- DUO sends one request with the configured transport and mode. There is no fallback to another transport or mode, no retry (DUO owns the timeout), no redirect following, no `/models` discovery and no tools. Every response passes DUO's final schema and evidence validation. The `responses` transport always sends `store: false`.
- `base_url` must be https, or http on a strict loopback host (`localhost`, `127.x`, `[::1]`). User info, query and fragment are rejected, and a path prefix is kept. The official OpenAI API host is rejected here: it is used through `openai-responses` only. There is no environment variable override.
- No implicit key: DUO reads only the variable named in `api_key_env` and never falls back to `OPENAI_API_KEY` or another name. Keys are never written to Truth, configuration, caches or logs.
- Requests use the same secret redaction boundary as 0.1.2. `duoctl status` and `duoctl doctor` show only the endpoint origin (`scheme://host[:port]`).
- Compatibility means: endpoints that support the transport and output mode you chose. DUO's tests use a local loopback endpoint. No specific external gateway (including GMS) has been verified by this release, and not every OpenAI-compatible API is expected to work.
- **Unchanged: `openai-responses`** connects only to the official OpenAI API with the Responses API, `store: false` and no retries, and rejects custom base URLs. A real OpenAI smoke test remains optional and is not a release gate.

## Compatibility

- **Additive public surfaces:** `duoctl doctor` (`duo.cli.doctor/1`, `duo.doctor/1`), and in `project.yaml` the provider value `openai-compatible` with `llm.base_url`, `llm.transport`, `llm.api_key_env`, `llm.structured_output`.
- **Unchanged:** all `/1` CLI and MCP formats, the nine MCP tools, the UI API, Review Records (`duo.review-record/1`), the adoption baseline (`duo.adoption-baseline/2`), `project.yaml` `schema_version: 1`, commands, options and exit codes. 0.1.x `project.yaml` files stay valid with the same meaning: no `llm` block, `provider: none` and `provider: openai-responses`.
- Internal, regenerable data changed (index state, analysis cache identities, index metadata). DUO reports it as stale and rebuilds it. It is not a public format.
- Runtime: Node.js `>=24.15.0` (Node 22 is not supported). The runtime dependency tree is the same as in 0.1.2.

Details: [compatibility.md](compatibility.md).

## Upgrade Notes

From 0.1.2 (verified by installing the published 0.1.2, adopting TypeScript, Python, C++ and sparse-Truth repositories, then switching to the 0.2.0 package):

1. `npm install -g @duo-director/cli@0.2.0`
2. In each project, `duoctl status` shows the index as `stale`. This is expected.
3. Run `duoctl index` once. It is an incremental update that reuses valid analysis, and the index becomes `current`.
4. Optionally run `duoctl doctor` to check the whole setup.

Your `.duo-project/` Truth files are not changed, Requirements and Decisions keep their state, and the adoption baseline is read as before. There is no re-initialization, no re-adoption and no migration step. Agents connected with 0.1.x keep working: their configuration starts `duoctl` from your PATH, which is now 0.2.0.

If you used semantic assist with an LLM provider on 0.1.1 or earlier, see the precaution in [SECURITY.md](../../SECURITY.md).

## Known Limitations

- Individual overloads are not separate identities (member identity is deferred).
- Context ranking in polyglot repositories is unchanged. In a mixed repository, generated files in one language can dominate a Packet. This is deferred to a later 0.2.x Context quality release.
- C++ import edges cover quoted includes of neighbouring files only. Module-relative, Public/Private and `-I` include paths have no import edge (a documented L1 limitation).
- L2 module and call resolution exists for TypeScript/JavaScript only. Java, C#, C++ and Python are L1, and other languages are file-level L0.
- OpenAI-compatible support is verified against a local loopback endpoint only (see above).
- On Windows the first command after installation can take much longer than later ones, because Windows opens the newly installed files for the first time.
- Transitive dependency fixes reach users only with a new DUO release, because the dependency tree is pinned with `npm-shrinkwrap.json`.
