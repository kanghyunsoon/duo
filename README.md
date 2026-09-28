# DUO

**AI Project Direction Layer for Coding Agents**

> Human defines intent. Agent performs implementation. DUO maintains direction.

DUO는 Codex, Claude Code 같은 AI Coding Agent가 프로젝트의 목표와 결정사항에서 벗어나지 않도록 Repository 상태를 관찰하고, 현재 작업에 필요한 Context만 전달하며, 작업 결과를 근거(Evidence)와 함께 검수하는 로컬 도구입니다. DUO는 코드를 작성하지 않습니다.

## 상태

CLI(`duoctl`), MCP 서버(`duoctl mcp`), Agent 연결(`duoctl install`), 배포용 package(`@duo-director/cli`, T17.1)까지 구현했습니다. **npm에는 아직 publish하지 않았습니다.** OpenAI Provider(TASK-012B), Web UI(TASK-018), Benchmark(TASK-019)는 아직입니다. 진행 순서는 [docs/tasks/TASKS.md](docs/tasks/TASKS.md)를 따릅니다.

## 설치

세 단계는 서로 다른 일입니다.

| 단계 | 명령 | 하는 일 |
|---|---|---|
| 1. 실행 파일 설치 | 아래 참고 | 컴퓨터에 `duoctl`을 설치합니다 |
| 2. 저장소 초기화 | `duoctl init` | 저장소를 관찰하고 `.duo-project/`, 첫 Index, Adoption Baseline을 만듭니다 |
| 3. Agent 연결 | `duoctl install codex` 또는 `duoctl install claude-code` | MCP 설정과 짧은 안내 블록을 추가합니다 |

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

## 사용

```bash
duoctl status
duoctl context "작업 설명"
duoctl index        # 코드를 바꾼 뒤
duoctl review
```

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


