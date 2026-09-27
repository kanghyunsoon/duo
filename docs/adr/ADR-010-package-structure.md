---
id: ADR-010
type: decision
title: 패키지 구조와 배포
state: confirmed
owner: human
question: package_structure
answer: "6 packages (core, analyzer, graph, director, integration, ui) + thin apps/cli; single npm package"
governs:
  requirements: [REQ-CLI-001, REQ-NFR-003, REQ-SAFETY-001]
supersedes: null
confirmed_by: human (H-6)
confirmed_at: 2026-09-27
---

# ADR-010: 패키지 구조와 배포

상태: **Accepted** (Human 결정 H-6)

## 결정

```text
packages/
├─ core/          .duo-project schema · loader · 추적성 파서 · decisions(DecisionService) · state 경로 · verdict 타입 · shared models · tokens · write boundary
├─ analyzer/      filesystem scan · fingerprint · LanguageAnalyzer(TS/JS) · git(EvidenceProvider)
├─ graph/         GraphStore · graph builder · traversal · incremental · trace · impact · check
├─ director/      Context Compiler · Evidence · Review · Knowledge Gap · token budget · LLMProvider · init
├─ integration/   MCP · Codex adapter · Claude adapter · local HTTP API · (future) Jira/GitHub providers
└─ ui/            React application
apps/
└─ cli/           인자 파싱 · 대화형 입력 · 출력 형식 · 종료 코드 (domain logic 없음)
```

### 의존 방향

```mermaid
flowchart TD
  cli[apps/cli] --> integration & director & graph & analyzer & core
  integration --> director & graph & core
  director --> graph & analyzer & core
  graph --> analyzer & core
  analyzer --> core
  ui -. "type-only" .-> core
  ui -. "HTTP" .-> integration
```

- 역방향 import는 lint 규칙으로 금지한다(AC-001-02).
- ui는 core의 타입만 가져오고 런타임에서는 HTTP API로만 데이터를 얻는다.
- 6개 패키지가 6명 팀의 병렬 개발 Lane이다([TASKS.md](../tasks/TASKS.md#병렬-개발-lane)).
- 개발은 pnpm workspace에서 한다. 배포는 npm 패키지 하나로 번들하고 binary 이름은 `duoctl`이다. 번들러는 TASK-001에서 고른다. 패키지 이름과 라이선스는 [conflicts.md Q3](../conflicts.md)에서 정한다.
- 장기적으로 Node SEA 단일 binary를 만든다(REQ-POST-007). grammar wasm과 UI 번들을 asset으로 포함하는 문제를 그때 검증한다.

## 저장소 구조

```text
duo/
├─ docs/                  SDD · adr/ · tasks/ · references/
├─ packages/{core,analyzer,graph,director,integration,ui}/
├─ apps/cli/
├─ fixtures/auth-app/     소스 · .duo-project · history.ts · changes/*.patch
├─ bench/                 scenarios/ · results/ · runner
├─ tests/e2e/
├─ .github/workflows/ci.yml
└─ package.json · pnpm-workspace.yaml · tsconfig.base.json · vitest.config.ts
```
