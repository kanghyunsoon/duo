# DUO

**AI Project Direction Layer for Coding Agents**

> Human defines intent. Agent performs implementation. DUO maintains direction.

DUO는 Codex, Claude Code 같은 AI Coding Agent가 프로젝트의 목표와 결정사항에서 벗어나지 않도록 Repository 상태를 관찰하고, 현재 작업에 필요한 Context만 전달하며, 작업 결과를 근거(Evidence)와 함께 검수하는 로컬 도구입니다. DUO는 코드를 작성하지 않습니다.

## 상태

CLI(`duoctl`)와 MCP 서버(`duoctl mcp`)까지 구현했습니다(TASK-016). Agent 설정 자동화(`duoctl install`, TASK-017), OpenAI Provider(TASK-012B), Web UI(TASK-018)는 아직입니다. 진행 순서는 [docs/tasks/TASKS.md](docs/tasks/TASKS.md)를 따릅니다.

## 사용

```bash
pnpm install && pnpm build
cd <your-git-repository>
node <duo>/apps/cli/dist/main.js init        # 관찰 → 최소 Truth → Index → Adoption Baseline
node <duo>/apps/cli/dist/main.js status
node <duo>/apps/cli/dist/main.js context "작업 설명"
node <duo>/apps/cli/dist/main.js review
```

명령과 종료 코드는 [07-cli-interface.md](docs/07-cli-interface.md)에 있습니다.

## MCP (Coding Agent 연결)

`duoctl mcp`는 저장소 하나를 다루는 stdio MCP 서버(`duo-director`)를 띄웁니다. `--root`는 Git 저장소의 최상위여야 합니다. Agent의 MCP 설정에 다음 명령을 등록합니다(설정 파일 자동 작성은 TASK-017).

```text
command: node
args:    ["<duo>/apps/cli/dist/main.js", "mcp", "--root", "<your-git-repository>"]
```

Tool은 9개입니다: `duo_get_status`, `duo_get_context`, `duo_review_changes`, `duo_get_requirement`, `duo_get_decision`, `duo_trace`, `duo_impact`, `duo_search_evidence`, `duo_propose_decision`. Agent는 Decision을 제안만 할 수 있고, 확정과 거절은 사람이 `duoctl decision`으로 합니다. Tool은 인덱싱하지 않으므로 `index-required`를 받으면 `duoctl index`를 실행합니다. 상세 계약은 [06-mcp-interface.md](docs/06-mcp-interface.md)에 있습니다.

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

## 문서

- [문서 지도](docs/README.md)
- [제품 비전](docs/00-product-vision.md) · [요구사항](docs/01-requirements.md) · [아키텍처](docs/02-system-architecture.md)
- [충돌 및 미결 사항](docs/conflicts.md)
- [ADR](docs/adr/README.md)

## 원본 입력

- [Duo 기획서.md](Duo%20기획서.md): 제품 기획서
- [docs/references/development-directive.md](docs/references/development-directive.md): 개발 지시문
