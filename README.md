# DUO

[![npm](https://img.shields.io/npm/v/@duo-director/cli)](https://www.npmjs.com/package/@duo-director/cli)
[![CI](https://github.com/kanghyunsoon/duo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kanghyunsoon/duo/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Decision compliance for coding agents.**

Keep coding agents aligned with human-confirmed engineering decisions. You confirm the decisions. Coding agents such as Codex and Claude Code implement. DUO checks repository changes against those decisions on its own and reports what it found, with file and line evidence. DUO does not write code.

[한국어](README.ko.md) · [Latest release](https://github.com/kanghyunsoon/duo/releases/latest) · [npm](https://www.npmjs.com/package/@duo-director/cli)

## Why not just AGENTS.md, CLAUDE.md or repository rules?

Instruction files and rules tell an agent what it should do. They are a good place for conventions, and DUO adds a short block to them when you connect an agent.

DUO works on the other side of the change. It keeps human-confirmed Requirements and Decisions as Project Truth in your repository and reviews what actually changed against them, whichever agent made the change. What DUO adds on top of instructions:

- **Decision lifecycle.** Agents can only propose a Decision. A person confirms or rejects it, and a confirmed Decision is locked with a digest so later edits are visible.
- **Deterministic evidence.** Review claims point to files, line ranges, Git diff hunks and the Decision itself. The core review does not use an LLM, so the same repository state gives the same result.
- **Adoption baseline.** When you adopt DUO in an existing repository, it records the violations that already exist. Later reviews tell a violation that was already there (pre-existing) from one a change introduced.
- **One Project Truth for every connected agent.** Codex and Claude Code read the same Truth through DUO's MCP server.

The [Decision Compliance Benchmark](docs/benchmarks/decision-compliance-01.md) tests this on a fixed legacy + new violation fixture with the published DUO, a one-rule script and an AI review as controls. In that fixture all three classified the change the same way; the benchmark lists what differed, its raw evidence and its limits.

## A Decision drift example

This runs on a two-file TypeScript repository with the published `duoctl` 0.2.0. The output below is unedited.

**1. A person confirms a Decision.** Decisions usually start as an agent proposal; here the file is written by hand:

```yaml
# .duo-project/decisions/D-001.yaml
id: D-001
title: Stateless authentication
kind: decision
state: proposed
question: session_state
answer: tokens are verified without a server-side session store
forbids:
  symbols: ["*SessionStore*"]
enforcement: block
```

```text
$ duoctl decision confirm D-001
D-001  "Stateless authentication"
  question  session_state
  answer    tokens are verified without a server-side session store
Type the ID to confirm: D-001

confirmed as D-001 · .duo-project/decisions/D-001.yaml
```

Confirmation only happens in an interactive terminal (or the local UI), and the person types the ID again.

**2. The team adopts DUO.** The repository already contains a `LegacySessionStore` class, which breaks D-001. `duoctl init` records it in the adoption baseline instead of reporting it as new:

```text
$ duoctl init
Repository ok · duo-t30-demo · typescript · 2 files · branch main
Truth      already done
Index      ok · full (no-state) · 4 files
Baseline   ok · a0bfda12ccc7 · 2 pre-existing findings
```

**3. A coding agent changes the code.** It adds `src/auth/server-session-store.ts` with a new `ServerSessionStore` class and edits one line in the legacy store.

**4. DUO reviews the change.**

```text
$ duoctl index
Indexed (incremental) · 5 files · 2 parsed · 2 changed · graph updated
$ duoctl review
BLOCK  2 claims · 2 files · llm_calls 0
  CONFLICT  decision-forbids           D-001 · forbidden-symbol [blocking, introduced]
            evidence: src/auth/server-session-store.ts:3-5, src/auth/server-session-store.ts:1-6, .duo-project/decisions/D-001.yaml:1-14
  CONFLICT  decision-forbids           D-001 · forbidden-symbol [pre-existing-touched]
            evidence: src/auth/legacy-session-store.ts:3-5, .duo-project/decisions/D-001.yaml:1-14, src/auth/legacy-session-store.ts:4-4
Knowledge gaps:
  - No confirmed Requirement or Decision is linked to this task.
Limitations:
  calls-exact-only
  no-task-scope
```

The new store is **introduced** and blocks. The legacy store existed before adoption, so touching it is **pre-existing-touched**, which is reported but never blocks. A pre-existing violation that the change does not touch is not reported as a new problem. Each claim names the Decision and points at the source lines.

The verdict is not an exit code by default. In CI, `duoctl review --fail-on block` exits with code 4 on BLOCK. `--json` returns the same claims with `expected` ("no symbol matching *SessionStore* (D-001)"), `observed`, `provenance` and the Evidence records.

## Quick start

Node.js 24.15 or later. No native build and no install script.

```bash
npm install -g @duo-director/cli

cd existing-project
duoctl init
duoctl install codex    # or: duoctl install claude-code
duoctl doctor
```

- `duoctl init` adopts an existing Git repository (it needs a first commit). It observes the repository, asks only what it cannot infer, writes a minimal Project Truth under `.duo-project/`, builds the first index and records the adoption baseline. With uncommitted changes, choose `--baseline-policy head` or `--baseline-policy abort`.
- `duoctl install codex` or `duoctl install claude-code` shows the files it will change, then adds the MCP configuration (`.codex/config.toml` or `.mcp.json`) and a short instruction block (`AGENTS.md` or `CLAUDE.md`), and checks that the DUO server starts. Codex must trust the project; Claude Code asks you to approve the `duo-director` server. You commit the changes yourself.
- `duoctl doctor` checks Git, Project Truth, the index, the analysis level per language, connected agents and the optional LLM settings, and lists the next one to three steps. It only reads.

The local UI (`duoctl ui`) and LLM assistance are optional.

## How DUO works

```text
Person ── confirms ──▶ Project Truth (.duo-project/: Requirements, Decisions, Constraints)
                              │
          Git repository ──▶ Index (Project Graph: files, symbols, tests, history)
                              │
                     Context Compiler ──▶ Context Packet ──▶ Coding agent
                                                                  │ changes the repository
                     Drift Review ◀──────────────────────────────┘
                              │
                     Claim → Evidence → Verdict (PASS · WARN · BLOCK · ASK)
```

Agents reach DUO through the `duo-director` MCP server (`duoctl mcp`, nine tools). The tools read; the only write an agent can make is a Decision proposal.

## Core concepts

- **Project Truth**: the Requirements, Decisions and Constraints a person has confirmed, kept as plain files in `.duo-project/` and committed with the code. It is the reference every review uses.
- **Requirement**: what the project must do, with an ID that code, tests and Decisions can point to.
- **Decision**: an engineering choice with an answer and, optionally, what it forbids (paths, symbols, dependencies) and how strictly (`enforcement: warn` or `block`).
- **Decision Lock**: confirming a Decision records a digest of its content. Review reports a Decision whose content no longer matches its lock.
- **Adoption Baseline**: the state of the repository when DUO was adopted, so existing problems are not reported as new ones.
- **Context Compiler**: builds a small Context Packet for a task (the relevant Truth, code and tests) instead of having the agent read the whole repository.
- **Drift Review**: compares a change with Project Truth and returns PASS, WARN, BLOCK or ASK.
- **Evidence**: what each claim rests on, such as a file and line range with a content hash, a Git diff hunk or a Truth entry.

Details: [architecture](docs/02-system-architecture.md) · [data model](docs/03-data-model.md) · [product contract](docs/release/product-contract.md).

## What DUO is not

- Not a code generator. It never edits your source code or commits.
- Not a replacement for tests or linters. Review does not run tests.
- Not proof that code is correct. PASS means no Project Direction violation was found in the available evidence.
- Not an enterprise policy platform. There is no hosted service, account, RBAC or SSO.
- Not dependent on an LLM. The core works without one.

## Local, with an optional LLM

Project Truth lives in your repository. Indexing, context, review, the MCP server and the local UI need no account and no LLM API, and with the default configuration (`llm.provider: none`) DUO makes no network calls.

Semantic assistance is optional. If you configure a provider and run `duoctl review --semantic`, selected evidence excerpts (relevant Truth paragraphs, changed code, diff hunks) are sent to that provider after DUO's secret redaction. The semantic result is attached separately and never creates a BLOCK. Setup: [LLM configuration](#optional-llm-assistance).

## Agent support

Built-in setup and verification: **Codex** and **Claude Code** (`duoctl install`). Both can be connected to the same repository. Project Truth and the review logic do not depend on the agent, and other MCP clients can launch the same stdio server with `duoctl mcp`, but DUO only sets up and checks the two agents above.

## Language support

| Level | Covers | What DUO does |
|---|---|---|
| L0 | Any Git repository: every file, including languages without an analyzer | files, fingerprints, Git history and diffs, Project Truth references, file-level context and review |
| L1 | TypeScript / JavaScript / Java / C# / C++ / Python | symbols, tests, imports·includes·usings, call sites, exact source locations |
| L2 | TypeScript / JavaScript | module resolution for every import, CALLS edges proven by bindings |

This is not semantic understanding of every language. Where an analyzer is missing or shallow, DUO is less certain, but it does not fail or raise WARN or BLOCK because of it. See [language support](docs/language-support.md).

## Performance

Measured on one reference machine (Windows 11, Intel Core Ultra 7 155H, Node 24.18) with DUO's synthetic 5,000-source-file fixture: in a long-running process (MCP, UI) `context` takes about 2.5 s, `review` about 3.9 s, and `index` after a one-file change about 2.4 s. Most of that is the freshness check DUO runs on every call to keep results exact. These are measurements, not guarantees. Method, real-world repositories and full results: [performance benchmark](docs/performance-benchmark.md).

On Windows the first command after installation can take much longer than later ones (about 18 s vs 1.5 s on the reference machine) while freshly installed files are opened for the first time.

## Everyday commands

```bash
duoctl status                      # Truth, index freshness, baseline, pending Decisions
duoctl context "what you are about to do"
duoctl index                       # after code changes
duoctl review                      # or: duoctl review --fail-on block in CI
duoctl decision list               # pending proposals; confirm or reject in a terminal
```

The MCP tools do not index; when an agent gets `index-required`, run `duoctl index`. Commands: [CLI reference](docs/07-cli-interface.md). MCP tools and install contract: [MCP interface](docs/06-mcp-interface.md).

## Optional LLM assistance

The official OpenAI Responses API:

```yaml
# .duo-project/project.yaml
llm:
  provider: openai-responses   # official api.openai.com only
  model: <model ID>            # DUO does not pick a model
```

```bash
OPENAI_API_KEY=... duoctl review --semantic
```

An explicitly configured OpenAI-compatible endpoint (since 0.2.0):

```yaml
llm:
  provider: openai-compatible
  model: <model ID on that endpoint>
  base_url: https://<gateway host>/<path>/v1   # https, or http on localhost, 127.x or [::1]
  transport: chat-completions                  # or responses, if the endpoint supports it
  api_key_env: MY_GATEWAY_KEY                  # name of the variable that holds the key
  structured_output: prompt-only               # json-schema | json-object | prompt-only
```

All five fields are required, and DUO never falls back to another transport or output mode. It works with endpoints that support the transport and mode you choose; not every OpenAI-compatible API is expected to work, and DUO has not verified specific external gateways. Keys come only from environment variables, and `duoctl status` and `duoctl doctor` show only the endpoint origin.

## Development

Node.js 24 (`>=24.15.0`) and pnpm 11.

```bash
pnpm install
pnpm verify        # check:boundaries → lint → typecheck → build → test → docs:validate
pnpm duoctl --version
```

| Command | What it does |
|---|---|
| `pnpm check:boundaries` | package dependency direction (package.json, tsconfig references) |
| `pnpm lint` | ESLint, including package boundaries and `node:sqlite` isolation |
| `pnpm typecheck` | type check including tests |
| `pnpm build` | `tsc -b` project references build |
| `pnpm test` | Vitest |
| `pnpm docs:validate` | Requirement/ADR/Task/AC traceability, links and anchors |
| `pnpm pack:cli` | package directory (`.dist/cli-package/`) and tarball, no publish |
| `pnpm test:dist` | installs the tarball into a temporary prefix and runs end-to-end tests (needs the npm registry) |
| `pnpm release:pack` · `release:preflight` · `release:audit` · `release:lock` | release tarball and checks ([checklist](docs/release/checklist.md)), no publish |
| `pnpm release:verify-published` | installs a published version from the registry and checks integrity, `duoctl --version`, init·status, tag and GitHub Release |
| `pnpm benchmark:smoke` | 100-file fixture benchmark and result contract (CI) |
| `pnpm benchmark` | full 100/1,000/5,000-file benchmark; results go to the Git-ignored `bench/results/local/` |

### From source

Build the same package as the npm registry's and install it:

```bash
pnpm install && pnpm release:pack          # writes .dist/duo-director-cli-<version>.tgz
npm install -g .dist/duo-director-cli-<version>.tgz
```

## License and security

DUO is released under the [Apache License 2.0](LICENSE). Third-party licenses for bundled software (React in the UI, Tree-sitter grammars, npm dependencies) are in `dist/THIRD_PARTY_NOTICES.md` and `dist/grammars/LICENSE-*` inside the package.

Please report vulnerabilities through GitHub Private Vulnerability Reporting, not public issues ([SECURITY.md](SECURITY.md)).

## Documentation

- [Documentation map](docs/README.md) (the design documents are written in Korean)
- [Release notes 0.2.0](docs/release/notes-0.2.0.md) · [Compatibility](docs/release/compatibility.md) · [Product contract](docs/release/product-contract.md) · [Release checklist](docs/release/checklist.md)
- [Decision Compliance Benchmark](docs/benchmarks/decision-compliance-01.md) · [Performance benchmark](docs/performance-benchmark.md)
- [Product vision](docs/00-product-vision.md) · [Requirements](docs/01-requirements.md) · [Architecture](docs/02-system-architecture.md) · [ADRs](docs/adr/README.md)
- [Open questions and decisions](docs/conflicts.md)

The original Korean concept document, [Duo 기획서.md](Duo%20기획서.md), is kept as historical design input and is not the current specification.
