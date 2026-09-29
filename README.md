# DUO

**AI Project Direction Layer for Coding Agents**

> Human defines intent. Agent performs implementation. DUO maintains direction.

DUO는 Codex, Claude Code 같은 AI Coding Agent가 프로젝트의 목표와 결정사항에서 벗어나지 않도록 Repository 상태를 관찰하고, 현재 작업에 필요한 Context만 전달하며, 작업 결과를 근거(Evidence)와 함께 검수하는 로컬 도구입니다. DUO는 코드를 작성하지 않습니다.

## 상태

CLI(`duoctl`), MCP 서버(`duoctl mcp`), Agent 연결(`duoctl install`), 선택적 OpenAI 의미 보조, 로컬 Project Direction Console(`duoctl ui`)까지 구현했습니다. 배포용 package는 만들었지만 **npm에는 아직 publish하지 않았습니다.** Benchmark(TASK-019)는 아직입니다. 진행 순서는 [docs/tasks/TASKS.md](docs/tasks/TASKS.md)를 따릅니다.

## 지원 범위

DUO는 stack-agnostic repository support 위에 언어별 Analyzer를 점점 깊게 얹는 구조입니다. 모든 언어를 의미 수준으로 이해한다는 뜻은 아닙니다.

| 수준 | 대상 | 하는 일 |
|---|---|---|
| Universal repository support (L0) | 모든 Git repository의 모든 파일 | 파일, fingerprint, Git history와 diff, Project Truth 참조, 파일 수준 Context와 Review |
| Structural analyzers (L1) | TypeScript / JavaScript / Java / C# / C++ / Python | Symbol, Test, import·include·using, call site, 정확한 source 위치 |
| Deep semantic resolution (L2 일부) | 현재 TypeScript / JavaScript가 가장 강함 | 모든 import의 module resolution, binding으로 확실한 CALLS |

Analyzer가 없거나 얕은 언어에서는 확신이 낮아질 뿐 DUO가 실패하거나 WARN·BLOCK이 생기지 않습니다. 언어별 범위와 한계는 [docs/language-support.md](docs/language-support.md)에 있습니다.

## 설치

세 단계는 서로 다른 일입니다.

| 단계 | 명령 | 하는 일 |
|---|---|---|
| 1. 실행 파일 설치 | 아래 참고 | 컴퓨터에 `duoctl`을 설치합니다 |
| 2. 저장소 초기화 | `duoctl init` | 저장소를 관찰하고 `.duo-project/`, 첫 Index, Adoption Baseline을 만듭니다 |
| 3. Agent 연결 | `duoctl install codex` 또는 `duoctl install claude-code` | MCP 설정과 짧은 안내 블록을 추가합니다 |
| 4. Project Direction 확인 | `duoctl ui` | 로컬 Console에서 Truth, 관계, Coverage, Context, Review와 사람의 Decision을 확인합니다 |

Node.js 24.15 이상이 필요합니다. native build나 install script는 없습니다.

### 1. 실행 파일 설치

지금은 이 저장소에서 배포 tarball을 만들어 설치합니다.

```bash
pnpm install && pnpm build && pnpm pack:cli
npm install -g .dist/duo-director-cli-0.1.0.tgz
duoctl --version
```

npm에 publish한 뒤에는 `npm install -g @duo-director/cli` 한 줄이 됩니다(아직 사용할 수 없음). project 안에만 설치하려면 `npm install -D <tarball>` 뒤 `npx --no-install duoctl …`로 실행하고, Agent 연결 때 `--launcher npx`를 줍니다.

### 2. 저장소 초기화

저장소 최상위에서 `duoctl init`. 작업 중인 변경이 있으면 `--baseline-policy head|abort` 중 하나를 고릅니다.

### 3. Agent 연결

`duoctl install codex` 또는 `duoctl install claude-code`. 바꿀 파일을 먼저 보여 주고, 확인하면 MCP 설정(`.codex/config.toml` 또는 `.mcp.json`)과 안내 블록(`AGENTS.md` 또는 `CLAUDE.md`)을 추가한 뒤 DUO 서버가 실제로 뜨는지 확인합니다. 기존 설정과 사람이 쓴 글은 그대로 두고, commit은 직접 합니다. Codex는 이 project를 trust해야 하고, Claude Code는 `duo-director` 서버 승인을 묻습니다. DUO는 둘 다 대신하지 않습니다.

`duoctl install status`로 연결 상태를, `duoctl install remove <agent>`로 DUO가 추가한 항목만 제거합니다. Agent가 비대화형으로 연결할 때는 `--non-interactive --yes --json`을 씁니다(`--yes`는 충돌을 덮어쓰지 않습니다).

### 4. Local UI

`duoctl ui`를 실행하고 출력된 URL을 브라우저에서 엽니다. 서버는 `127.0.0.1`의 사용 가능한 port를 선택합니다. `--port N`으로 port를 지정하거나 `--open`으로 브라우저를 열 수 있습니다. UI는 현재 Index를 읽기만 하므로 `index-required`가 나오면 별도 터미널에서 `duoctl index`를 실행하고 화면에서 Refresh합니다. Confirm/Reject 외의 Truth 변경이나 Review Record 생성은 CLI를 사용합니다. UI API는 실행별 session cookie, CSRF token, Host/Origin 검사를 사용합니다.

## 사용

```bash
duoctl status
duoctl context "작업 설명"
duoctl index        # 코드를 바꾼 뒤
duoctl review
```

### LLM은 선택 사항입니다

LLM is optional. DUO's indexing, context selection and deterministic review work without an API key. 기본값은 꺼짐(`llm.provider: none`)이고, 켜지 않으면 네트워크 호출이 없습니다. 켜려면 `.duo-project/project.yaml`에 provider와 model을 명시하고 key는 환경 변수로만 줍니다(파일에 쓰지 않음).

```yaml
llm:
  provider: openai-responses   # 공식 OpenAI Responses API
  model: <사용할 model ID>      # DUO는 model을 고르지 않습니다
```

```bash
OPENAI_API_KEY=... duoctl review --semantic
```

`--semantic`(MCP `includeSemanticAssist: true`)을 줄 때만 Review의 의미 후보를 한 번 확인합니다. 이때 **선택된 Evidence 발췌(관련 Truth 문단, 바뀐 코드 부분, diff hunk)가 OpenAI API로 전송됩니다**. 파일 전체나 저장소는 보내지 않고, `store: false`로 요청합니다. 결과는 별도 `semanticAssist`로 붙고 결정적 판정을 바꾸거나 BLOCK을 만들지 않습니다. 같은 요청의 검증된 응답은 로컬 `.duo-project/cache/llm/`에 저장되며(`llm.cache: false`로 끔), 이것은 OpenAI 서버 저장과 별개입니다.

Agent는 MCP Tool 9개(`duo_get_status`, `duo_get_context`, `duo_review_changes`, `duo_get_requirement`, `duo_get_decision`, `duo_trace`, `duo_impact`, `duo_search_evidence`, `duo_propose_decision`)를 씁니다. Agent는 Decision을 제안만 할 수 있고 확정과 거절은 사람이 `duoctl decision`으로 합니다. Tool은 인덱싱하지 않으므로 `index-required`를 받으면 `duoctl index`를 실행합니다. 명령은 [07-cli-interface.md](docs/07-cli-interface.md), MCP와 설치 계약은 [06-mcp-interface.md](docs/06-mcp-interface.md)에 있습니다.

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
| `pnpm docs:validate` | Requirement/ADR/Task/AC 추적성 검사 |
| `pnpm pack:cli` | 배포 package(`.dist/cli-package/`)와 tarball 생성, publish하지 않음 |
| `pnpm test:dist` | tarball을 임시 prefix·project에 설치해 배포본만으로 E2E(npm registry 접근 필요) |

## 문서

- [문서 지도](docs/README.md)
- [제품 비전](docs/00-product-vision.md) · [요구사항](docs/01-requirements.md) · [아키텍처](docs/02-system-architecture.md)
- [충돌 및 미결 사항](docs/conflicts.md)
- [ADR](docs/adr/README.md)

## 원본 입력

- [Duo 기획서.md](Duo%20기획서.md): 제품 기획서
- [docs/references/development-directive.md](docs/references/development-directive.md): 개발 지시문


