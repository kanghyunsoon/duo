# ADR-010: 저장소 구조와 배포

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 결정

- 개발: pnpm workspace monorepo(`packages/*`). 패키지 경계는 [02-system-architecture.md](../02-system-architecture.md).
- 빌드: 패키지별 `tsc` 타입 검사 + 배포용 번들러로 단일 패키지 생성(번들러는 T01에서 결정).
- 배포: npm 패키지 하나, binary 이름 `duo`. 패키지 이름은 [conflicts.md Q3](../conflicts.md).
- 장기: Node SEA(Single Executable Application)로 단일 binary. WASM grammar와 UI 번들을 asset으로 포함해야 하므로 v0.1 이후 검증.

## 저장소 초기 구조

~~~text
duo/
├─ docs/                    SDD, adr/, tasks/, references/
├─ packages/
│  ├─ core/                 .duo 스키마, loader, IDs, Verdict 타입, fs-guard
│  ├─ indexer/              scan, fingerprint, language/typescript
│  ├─ graph/                GraphStore(node:sqlite), traverse, check, incremental
│  ├─ providers/            git, llm-none, token-estimator
│  ├─ compiler/             Context Compiler
│  ├─ review/               rules, aggregate, drift
│  ├─ mcp/                  tool 정의, stdio 서버
│  ├─ adapters/             codex, claude
│  ├─ cli/                  명령, UI HTTP 서버, 배포 진입점
│  └─ ui/                   React 앱
├─ fixtures/auth-app/       fixture 소스, .duo, history.ts, changes/*.patch
├─ bench/                   scenarios/, results/, runner
├─ .github/workflows/ci.yml
├─ package.json · pnpm-workspace.yaml · tsconfig.base.json · vitest.config.ts
└─ README.md
~~~
