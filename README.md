# DUO

**AI Project Direction Layer for Coding Agents**

> Human defines intent. Agent performs implementation. DUO maintains direction.

DUO는 Codex, Claude Code 같은 AI Coding Agent가 프로젝트의 목표와 결정사항에서 벗어나지 않도록 Repository 상태를 관찰하고, 현재 작업에 필요한 Context만 전달하며, 작업 결과를 근거(Evidence)와 함께 검수하는 로컬 도구입니다. DUO는 코드를 작성하지 않습니다.

## 상태

T00 설계는 동결되었고 T01 Repository Skeleton까지 진행했습니다. 기능 구현은 [docs/tasks/TASKS.md](docs/tasks/TASKS.md)의 순서를 따릅니다.

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
