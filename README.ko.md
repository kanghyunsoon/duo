# DUO

[![npm](https://img.shields.io/npm/v/@duo-director/cli)](https://www.npmjs.com/package/@duo-director/cli)
[![CI](https://github.com/kanghyunsoon/duo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kanghyunsoon/duo/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Coding Agent를 위한 Decision compliance.**

사람이 확정한 엔지니어링 결정(Decision)에서 Coding Agent가 벗어나지 않게 합니다. 결정은 사람이 확정하고, 구현은 Codex·Claude Code 같은 Coding Agent가 합니다. DUO는 저장소 변경을 그 결정과 독립적으로 대조하고, 찾은 내용을 파일과 줄 단위 근거와 함께 보고합니다. DUO는 코드를 작성하지 않습니다.

[English](README.md) · [최신 release](https://github.com/kanghyunsoon/duo/releases/latest) · [npm](https://www.npmjs.com/package/@duo-director/cli)

## AGENTS.md, CLAUDE.md, 저장소 규칙만으로는 왜 부족한가요?

지시 파일과 규칙은 Agent에게 무엇을 해야 하는지 알려 줍니다. 관례를 적어 두기에 좋은 곳이고, Agent를 연결하면 DUO도 그 파일에 짧은 안내 블록을 추가합니다.

DUO는 변경이 일어난 뒤를 봅니다. 사람이 확정한 Requirement와 Decision을 저장소의 Project Truth로 두고, 어느 Agent가 만든 변경이든 실제로 바뀐 내용을 그 Truth와 대조합니다. 지시 파일 위에 DUO가 더하는 것은 다음과 같습니다.

- **Decision 생명주기.** Agent는 Decision을 제안만 할 수 있습니다. 확정과 거절은 사람이 하고, 확정된 Decision은 내용 digest로 잠겨 이후 수정이 드러납니다.
- **결정적 근거(Evidence).** Review claim은 파일, 줄 범위, Git diff hunk, 해당 Decision을 가리킵니다. 핵심 Review는 LLM을 쓰지 않으므로 같은 저장소 상태에서는 같은 결과가 나옵니다.
- **Adoption Baseline.** 기존 저장소에 DUO를 도입할 때 이미 있던 위반을 기록합니다. 이후 Review는 원래 있던 위반(pre-existing)과 변경이 새로 만든 위반(introduced)을 구분합니다.
- **연결한 모든 Agent에 같은 Project Truth.** Codex와 Claude Code는 DUO의 MCP 서버로 같은 Truth를 읽습니다.

두 Decision Compliance Benchmark가 고정된 fixture에서 공개된 DUO와, 대조군으로 직접 만든 script와 AI 리뷰를 실행해 이 주장들을 시험하고 raw evidence와 한계를 공개합니다. 두 benchmark 모두 대조군이 DUO와 같은 판정에 이르렀고, 무엇이 달랐는지를 기록했습니다.

- [Benchmark 1: Legacy + New Violation](docs/benchmarks/decision-compliance-01.md)
- [Benchmark 2: Adoption Provenance + Supersession](docs/benchmarks/decision-compliance-02.md)

## Decision drift 예시

파일 두 개짜리 TypeScript 저장소에서 공개된 `duoctl` 0.2.0으로 실행한 결과입니다. 아래 출력은 고치지 않은 그대로입니다.

**1. 사람이 Decision을 확정합니다.** Decision은 보통 Agent의 제안으로 시작하지만, 여기서는 파일을 직접 작성했습니다.

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

확정은 대화형 터미널(또는 로컬 UI)에서만 되고, 사람이 ID를 한 번 더 입력합니다.

**2. 팀이 DUO를 도입합니다.** 저장소에는 이미 D-001을 어기는 `LegacySessionStore` class가 있습니다. `duoctl init`은 이것을 새 문제로 보고하지 않고 adoption baseline에 기록합니다.

```text
$ duoctl init
Repository ok · duo-t30-demo · typescript · 2 files · branch main
Truth      already done
Index      ok · full (no-state) · 4 files
Baseline   ok · a0bfda12ccc7 · 2 pre-existing findings
```

**3. Coding Agent가 코드를 바꿉니다.** 새 `ServerSessionStore` class가 든 `src/auth/server-session-store.ts`를 추가하고, legacy store의 한 줄을 고칩니다.

**4. DUO가 변경을 Review합니다.**

```text
$ duoctl index
Indexed (incremental) · 5 files · 2 parsed · 2 changed · graph updated
$ duoctl review
BLOCK  2 claims · 2 files · llm_calls 0
  CONFLICT  decision-forbids           D-001 · forbidden-symbol [blocking, not-in-adoption-baseline]
            evidence: src/auth/server-session-store.ts:3-5, src/auth/server-session-store.ts:1-6, .duo-project/decisions/D-001.yaml:1-14
  CONFLICT  decision-forbids           D-001 · forbidden-symbol [in-adoption-baseline, touched]
            evidence: src/auth/legacy-session-store.ts:3-5, .duo-project/decisions/D-001.yaml:1-14, src/auth/legacy-session-store.ts:4-4
Knowledge gaps:
  - No confirmed Requirement or Decision is linked to this task.
Limitations:
  calls-exact-only
  no-task-scope
```

새 store는 **adoption baseline에 없으므로** BLOCK을 만듭니다. legacy store는 **adoption baseline에 있고** 이번 변경이 그것을 건드렸으므로 보고는 되지만 BLOCK을 만들지 않습니다. `--json`에서는 각각 `provenance: "introduced"`, `"pre-existing-touched"`입니다. `introduced`는 위반이 adoption baseline에 없다는 뜻일 뿐 이번 변경이 만들었다는 뜻이 아닙니다. 변경이 건드리지 않은 기존 위반은 새 문제로 보고되지 않습니다. 각 claim은 Decision ID를 밝히고 source 줄을 가리킵니다.

verdict는 기본적으로 종료 코드가 아닙니다. CI에서는 `duoctl review --fail-on block`이 BLOCK일 때 종료 코드 4로 끝납니다. `--json`은 같은 claim을 `expected`("no symbol matching *SessionStore* (D-001)"), `observed`, `provenance`, Evidence 기록과 함께 돌려줍니다.

## 빠른 시작

Node.js 24.15 이상이 필요합니다. native build나 install script는 없습니다.

```bash
npm install -g @duo-director/cli

cd existing-project
duoctl init
duoctl install codex    # 또는: duoctl install claude-code
duoctl doctor
```

- `duoctl init`은 기존 Git 저장소를 도입합니다(첫 commit이 있어야 합니다). 저장소를 관찰하고, 추론할 수 없는 것만 묻고, `.duo-project/`에 최소한의 Project Truth를 만들고, 첫 index를 만든 뒤 adoption baseline을 기록합니다. commit하지 않은 변경이 있으면 `--baseline-policy head`나 `--baseline-policy abort` 중 하나를 고릅니다.
- `duoctl install codex`나 `duoctl install claude-code`는 바꿀 파일을 먼저 보여 준 뒤 MCP 설정(`.codex/config.toml` 또는 `.mcp.json`)과 짧은 안내 블록(`AGENTS.md` 또는 `CLAUDE.md`)을 추가하고 DUO 서버가 실제로 뜨는지 확인합니다. Codex는 이 project를 trust해야 하고 Claude Code는 `duo-director` 서버 승인을 묻습니다. commit은 직접 합니다.
- `duoctl doctor`는 Git, Project Truth, index, 언어별 분석 수준, 연결한 Agent, 선택 LLM 설정을 확인하고 다음 할 일을 1~3개 보여 줍니다. 읽기만 합니다.

로컬 UI(`duoctl ui`)와 LLM 보조는 선택 사항입니다.

## DUO의 동작

```text
사람 ── 확정 ──▶ Project Truth (.duo-project/: Requirement, Decision, Constraint)
                        │
     Git 저장소 ──▶ Index (Project Graph: 파일, Symbol, Test, history)
                        │
               Context Compiler ──▶ Context Packet ──▶ Coding Agent
                                                            │ 저장소를 바꿈
               Drift Review ◀──────────────────────────────┘
                        │
               Claim → Evidence → Verdict (PASS · WARN · BLOCK · ASK)
```

Agent는 `duo-director` MCP 서버(`duoctl mcp`, Tool 9개)로 DUO를 씁니다. Tool은 읽기만 하며, Agent가 할 수 있는 쓰기는 Decision 제안 하나뿐입니다.

## 핵심 개념

- **Project Truth**: 사람이 확정한 Requirement, Decision, Constraint입니다. `.duo-project/`에 평범한 파일로 두고 코드와 함께 commit합니다. 모든 Review의 기준입니다.
- **Requirement**: 프로젝트가 해야 하는 일입니다. 코드, 테스트, Decision이 가리킬 수 있는 ID를 가집니다.
- **Decision**: 답이 정해진 엔지니어링 선택입니다. 무엇을 금지하는지(path, symbol, dependency)와 얼마나 엄격한지(`enforcement: warn` 또는 `block`)를 함께 적을 수 있습니다.
- **Decision Lock**: Decision을 확정하면 내용의 digest가 기록됩니다. 내용이 lock과 맞지 않게 된 Decision은 Review가 보고합니다.
- **Adoption Baseline**: DUO를 도입한 시점의 저장소 상태입니다. 원래 있던 문제를 새 문제로 보고하지 않게 합니다.
- **Context Compiler**: Agent가 저장소 전체를 읽는 대신, 작업에 필요한 Truth·코드·테스트만 담은 작은 Context Packet을 만듭니다.
- **Drift Review**: 변경을 Project Truth와 대조해 PASS, WARN, BLOCK, ASK를 돌려줍니다.
- **Evidence**: 각 claim의 근거입니다. content hash가 붙은 파일과 줄 범위, Git diff hunk, Truth 항목 같은 것입니다.

자세한 내용: [아키텍처](docs/02-system-architecture.md) · [데이터 모델](docs/03-data-model.md) · [제품 계약](docs/release/product-contract.md).

## DUO가 아닌 것

- 코드 생성기가 아닙니다. source code를 고치거나 commit하지 않습니다.
- 테스트나 linter를 대신하지 않습니다. Review는 테스트를 실행하지 않습니다.
- 코드가 옳다는 증명이 아닙니다. PASS는 가진 Evidence에서 Project Direction 위반을 찾지 못했다는 뜻입니다.
- enterprise policy platform이 아닙니다. hosted service, 계정, RBAC, SSO가 없습니다.
- LLM에 의존하지 않습니다. 핵심 기능은 LLM 없이 동작합니다.

## 로컬 동작과 선택 LLM

Project Truth는 저장소 안에 있습니다. index, Context, Review, MCP 서버, 로컬 UI는 계정이나 LLM API 없이 동작하고, 기본 설정(`llm.provider: none`)에서는 네트워크 호출이 없습니다.

의미 보조(semantic assist)는 선택 사항입니다. provider를 설정하고 `duoctl review --semantic`을 실행하면 선택된 Evidence 발췌(관련 Truth 문단, 바뀐 코드, diff hunk)가 DUO의 secret redaction을 거친 뒤 그 provider로 전송됩니다. 의미 보조 결과는 따로 붙고 BLOCK을 만들지 않습니다. 설정: [선택 LLM 보조](#선택-llm-보조).

## Agent 지원

설정과 확인을 내장한 Agent: **Codex**, **Claude Code**(`duoctl install`). 한 저장소에 둘 다 연결할 수 있습니다. Project Truth와 Review logic은 Agent와 무관하고 다른 MCP client도 `duoctl mcp`로 같은 stdio 서버를 띄울 수 있지만, DUO가 설정하고 확인하는 것은 위 두 Agent뿐입니다.

## 언어 지원

| 수준 | 대상 | 하는 일 |
|---|---|---|
| L0 | 모든 Git repository의 모든 파일(분석기 없는 언어 포함) | 파일, fingerprint, Git history와 diff, Project Truth 참조, 파일 수준 Context와 Review |
| L1 | TypeScript / JavaScript / Java / C# / C++ / Python | Symbol, Test, import·include·using, call site, 정확한 source 위치 |
| L2 | TypeScript / JavaScript | 모든 import의 module resolution, binding으로 확실한 CALLS |

모든 언어를 의미 수준으로 이해한다는 뜻은 아닙니다. Analyzer가 없거나 얕은 언어에서는 확신이 낮아질 뿐, 그 이유로 DUO가 실패하거나 WARN·BLOCK이 생기지 않습니다. [언어 지원](docs/language-support.md)을 보세요.

## 성능

한 기준 환경(Windows 11, Intel Core Ultra 7 155H, Node 24.18)과 DUO의 synthetic 5,000 source file fixture에서 잰 값입니다. 장기 실행 process(MCP, UI)에서 `context`는 약 2.5초, `review`는 약 3.9초, 파일 하나를 바꾼 뒤 `index`는 약 2.4초입니다. 대부분은 결과를 정확하게 유지하려고 매 호출 수행하는 freshness 확인입니다. 측정값이며 보장이 아닙니다. 방법, 실제 저장소 결과, 전체 수치: [performance benchmark](docs/performance-benchmark.md).

Windows에서는 설치 직후 첫 명령이 이후보다 훨씬 오래 걸릴 수 있습니다(기준 PC에서 약 18초, 이후 약 1.5초). 새로 설치된 파일을 처음 열 때 드는 비용입니다.

## 자주 쓰는 명령

```bash
duoctl status                      # Truth, index 상태, baseline, 대기 중인 Decision
duoctl context "작업 설명"
duoctl index                       # 코드를 바꾼 뒤
duoctl review                      # CI에서는 duoctl review --fail-on block
duoctl decision list               # 대기 중인 제안. 확정과 거절은 터미널에서
```

MCP Tool은 인덱싱하지 않습니다. Agent가 `index-required`를 받으면 `duoctl index`를 실행합니다. 명령: [CLI reference](docs/07-cli-interface.md). MCP Tool과 설치 계약: [MCP interface](docs/06-mcp-interface.md).

## 선택 LLM 보조

공식 OpenAI Responses API:

```yaml
# .duo-project/project.yaml
llm:
  provider: openai-responses   # 공식 api.openai.com 전용
  model: <model ID>            # DUO는 model을 고르지 않습니다
```

```bash
OPENAI_API_KEY=... duoctl review --semantic
```

명시적으로 설정한 OpenAI-compatible endpoint(0.2.0부터):

```yaml
llm:
  provider: openai-compatible
  model: <그 endpoint의 model ID>
  base_url: https://<gateway host>/<path>/v1   # https, 또는 localhost·127.x·[::1]의 http
  transport: chat-completions                  # 또는 responses (endpoint가 지원할 때만)
  api_key_env: MY_GATEWAY_KEY                  # key가 든 환경 변수 이름
  structured_output: prompt-only               # json-schema | json-object | prompt-only
```

다섯 값은 모두 필수이고 DUO는 다른 transport나 출력 방식으로 바꿔 보내지 않습니다. 고른 transport와 방식을 지원하는 endpoint에서 동작하며, 모든 OpenAI 호환 API가 동작한다는 뜻은 아니고 DUO가 특정 외부 gateway를 검증하지도 않았습니다. key는 환경 변수로만 받고, `duoctl status`와 `duoctl doctor`는 endpoint의 origin만 보여 줍니다.

## 개발

Node.js 24(`>=24.15.0`)와 pnpm 11이 필요합니다.

```bash
pnpm install
pnpm verify        # check:boundaries → lint → typecheck → build → test → docs:validate
pnpm duoctl --version
```

| 명령 | 내용 |
|---|---|
| `pnpm check:boundaries` | 패키지 의존 방향(package.json, tsconfig references) 검사 |
| `pnpm lint` | ESLint(패키지 경계, `node:sqlite` 격리 포함) |
| `pnpm typecheck` | 테스트를 포함한 전체 타입 검사 |
| `pnpm build` | `tsc -b` project references 빌드 |
| `pnpm test` | Vitest |
| `pnpm docs:validate` | Requirement/ADR/Task/AC 추적성, 링크와 anchor 검사 |
| `pnpm pack:cli` | 배포 package(`.dist/cli-package/`)와 tarball 생성(publish는 하지 않음) |
| `pnpm test:dist` | tarball을 임시 prefix에 설치해 배포본만으로 E2E(npm registry 접근 필요) |
| `pnpm release:pack` · `release:preflight` · `release:audit` · `release:lock` | release tarball 생성과 검사([checklist](docs/release/checklist.md), publish는 하지 않음) |
| `pnpm release:verify-published` | publish한 version을 registry에서 설치해 확인(integrity, `duoctl --version`, init·status, tag, GitHub Release) |
| `pnpm benchmark:smoke` | 100파일 fixture benchmark와 결과 계약 검사(CI) |
| `pnpm benchmark` | 100/1,000/5,000파일 full benchmark, 결과는 Git 제외 `bench/results/local/` |

### From source

npm registry와 같은 구성의 package를 만들어 설치합니다.

```bash
pnpm install && pnpm release:pack          # .dist/duo-director-cli-<version>.tgz 생성
npm install -g .dist/duo-director-cli-<version>.tgz
```

## License와 보안

DUO는 [Apache License 2.0](LICENSE)으로 배포합니다. 배포 package에 들어 있는 제3자 소프트웨어(UI의 React, Tree-sitter grammar, npm 의존성)의 license는 package 안의 `dist/THIRD_PARTY_NOTICES.md`와 `dist/grammars/LICENSE-*`에 있습니다.

보안 취약점은 공개 Issue로 올리지 말고 GitHub Private Vulnerability Reporting으로 신고해 주세요([SECURITY.md](SECURITY.md)).

## 문서

- [문서 지도](docs/README.md)
- [0.2.1 release notes](docs/release/notes-0.2.1.md) · [0.2.0](docs/release/notes-0.2.0.md) · [호환성](docs/release/compatibility.md) · [제품 계약](docs/release/product-contract.md) · [release checklist](docs/release/checklist.md)
- Decision Compliance Benchmarks: [1](docs/benchmarks/decision-compliance-01.md) · [2](docs/benchmarks/decision-compliance-02.md) · [Performance benchmark](docs/performance-benchmark.md)
- [제품 비전](docs/00-product-vision.md) · [요구사항](docs/01-requirements.md) · [아키텍처](docs/02-system-architecture.md) · [ADR](docs/adr/README.md)
- [미결 사항과 결정 기록](docs/conflicts.md)

처음 작성한 기획서 [Duo 기획서.md](Duo%20기획서.md)는 초기 설계 입력으로 보존한 기록이며 현재 사양이 아닙니다.
