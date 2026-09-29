# 01. Requirements

상태: **Frozen** (T00 final, 2026-09-27). 새 Requirement는 구현 중 필요가 발견될 때만 추가한다.

## 읽는 법

Requirement마다 Heading과 `duo` block을 둔다. 이 형식은 [03-data-model.md](03-data-model.md#markdown-정의-형식)와 [ADR-014](adr/ADR-014-traceability-ids.md)에 정의되어 있다. 연결 방향은 ADR 쪽의 `governs`와 Task 쪽의 `requirements`가 정규 원본이며, 각 Requirement 아래의 링크 줄과 맨 아래 추적 표는 같은 데이터에서 생성한 읽기용 사본이다.

출처 표기: **D§n** [개발 지시문](references/development-directive.md) n절 · **P§n** [기획서](../Duo%20기획서.md) n절 · **H-n** [Human 결정](conflicts.md#human-결정-기록) n번

## Truth Layer와 추적성

### REQ-TRUTH-001 .duo-project Project Truth Layer와 소유권

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§2, P§6]
```

`duoctl init`은 `.duo-project/`를 만든다. 경로별 소유자(Human, DUO, Agent)와 쓰기 권한은 03 문서의 소유권 표를 따른다. UI나 DB는 Source of Truth가 아니다.

상세: [03-data-model](03-data-model.md) · ADR: [ADR-006](adr/ADR-006-duo-layout-git-policy.md) · Task: [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서), [TASK-014](tasks/TASKS.md#task-014-init-파이프라인)

### REQ-TRUTH-002 Git 관리 정책

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§2, H-7, H-14]
```

Project Truth(project.yaml, intent, specs, decisions, milestones, integrations)와 Human이 보존하거나 승인한 Review(`.duo-project/reviews/`)만 Git 추적한다. 재생성 가능하거나 실행 중 생기는 데이터(`generated/`, `cache/`, `runtime/`)는 ignore한다.

상세: [03-data-model](03-data-model.md) · ADR: [ADR-006](adr/ADR-006-duo-layout-git-policy.md) · Task: [TASK-014](tasks/TASKS.md#task-014-init-파이프라인)

### REQ-TRUTH-003 Human-readable 형식과 스키마 검증

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [P§7, H-11, H-16]
```

Project Truth는 Markdown/YAML이며 스키마로 검증하고 오류를 파일:줄로 보고한다. `sources.markdown`으로 지정한 `.duo-project` 밖 문서는 Truth가 아니라 External Evidence/Input Source다. init 초안, Review 근거, Drift 탐지에만 쓰며, 외부 문서가 바뀌어도 `.duo-project`를 자동으로 바꾸지 않는다.

상세: [03-data-model](03-data-model.md) · ADR: [ADR-014](adr/ADR-014-traceability-ids.md) · Task: [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서)

### REQ-TRACE-001 ID 기반 추적성

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [H-11]
```

Requirement, Decision(ADR 포함), Issue(Task 포함), Milestone은 전역에서 유일한 ID를 가지고 ID 참조로 연결된다. 이 저장소의 `docs/`도 같은 형식을 따르므로, 테스트에서 임시 `.duo-project/`로 복사해 DUO 자체의 Project Graph fixture로 쓴다.

상세: [03-data-model](03-data-model.md) · ADR: [ADR-014](adr/ADR-014-traceability-ids.md) · Task: [TASK-000](tasks/TASKS.md#task-000-sdd-문서-작성), [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서), [TASK-007](tasks/TASKS.md#task-007-graph-builder와-일관성-검사), [TASK-020](tasks/TASKS.md#task-020-e2e와-문서-구현-대조)

## duoctl init

### REQ-INIT-001 결정적 Repository 분석

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§3]
```

`duoctl init`은 구조, README/docs, manifest, Git metadata, source file, AST symbol, dependency, 기존 기획 문서를 일반 코드로 분석한다. Repository 전체를 LLM에 전달하지 않는다.

상세: [02-system-architecture](02-system-architecture.md) · ADR: [ADR-008](adr/ADR-008-deterministic-first.md) · Task: [TASK-014](tasks/TASKS.md#task-014-init-파이프라인)

### REQ-INIT-002 Intent 초안, 구현 상태 추론, Knowledge Gap 생성

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§3]
```

`duoctl init`은 Project Intent 초안, 현재 구현 상태 추론, Knowledge Gap을 만든다. 근거 없는 Requirement를 지어내지 않는다.

상세: [02-system-architecture](02-system-architecture.md) · Task: [TASK-014](tasks/TASKS.md#task-014-init-파이프라인)

### REQ-INIT-003 Human Intent 확인

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§22, P§25]
```

TTY에서는 대화형으로 최대 3개 질문을 하고, 비대화형(Agent 실행)에서는 같은 질문을 ASK 목록으로 출력한다.

상세: [07-cli-interface](07-cli-interface.md) · Task: [TASK-014](tasks/TASKS.md#task-014-init-파이프라인)

## 인덱싱

### REQ-INDEX-001 언어 비종속 LanguageAnalyzer

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§3, H-2]
```

분석은 `LanguageAnalyzer` 인터페이스로 추상화한다. MVP는 TypeScriptAnalyzer와 JavaScriptAnalyzer만 제공한다. CALLS는 타입 정보 없이 syntax 사실과 module resolution으로 해석하고 exact 결과만 Edge로 저장하며, 해석하지 못하는 경우를 한계로 문서화한다(C48).

상세: [04-project-graph](04-project-graph.md) · ADR: [ADR-003](adr/ADR-003-language-analysis.md) · Task: [TASK-005](tasks/TASKS.md#task-005-languageanalyzer와-tsjs-analyzer)

### REQ-INDEX-002 Fingerprint 기반 증분 인덱싱

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§5, P§10]
```

최초 init 이후에는 fingerprint와 Git 변경 정보로 바뀐 파일만 다시 분석한다. 변경되지 않은 파일은 parse하지 않는다.

상세: [04-project-graph](04-project-graph.md) · ADR: [ADR-002](adr/ADR-002-graph-storage.md) · Task: [TASK-004](tasks/TASKS.md#task-004-파일-스캔과-fingerprint), [TASK-008](tasks/TASKS.md#task-008-증분-인덱싱-trace-impact)

### REQ-INDEX-003 Git diff에서 변경 Symbol 도출

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§5]
```

Git diff → 변경 파일 → 변경 Symbol(added, modified, removed) → 영향 Subgraph를 LLM 없이 계산한다.

상세: [04-project-graph](04-project-graph.md) · ADR: [ADR-003](adr/ADR-003-language-analysis.md) · Task: [TASK-006](tasks/TASKS.md#task-006-git-evidence-provider)

## Project Graph

### REQ-GRAPH-001 Node 8종과 Edge 10종의 embedded 저장

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§4, P§8]
```

Project Graph는 Node 8종과 Edge 10종(지시문 D§4의 9종 + Decision lifecycle의 SUPERSEDES, H-20)을 embedded SQLite에 저장한다. 외부 Graph DB를 요구하지 않는다.

상세: [04-project-graph](04-project-graph.md) · ADR: [ADR-002](adr/ADR-002-graph-storage.md), [ADR-003](adr/ADR-003-language-analysis.md) · Task: [TASK-003](tasks/TASKS.md#task-003-graphstore), [TASK-007](tasks/TASKS.md#task-007-graph-builder와-일관성-검사)

### REQ-GRAPH-002 결정적 bounded traversal, trace, impact

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§4]
```

Seed에서 depth와 Node 수가 제한된 Subgraph만 결정적 순서로 탐색한다. `trace`와 `impact`는 이 탐색 위에 만든다.

상세: [04-project-graph](04-project-graph.md) · Task: [TASK-003](tasks/TASKS.md#task-003-graphstore), [TASK-008](tasks/TASKS.md#task-008-증분-인덱싱-trace-impact)

### REQ-GRAPH-003 Graph 일관성 불변식

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§20]
```

Graph는 04 문서의 불변식을 항상 만족하며, 증분 갱신 결과는 전체 재구축 결과와 같다.

상세: [04-project-graph](04-project-graph.md) · Task: [TASK-007](tasks/TASKS.md#task-007-graph-builder와-일관성-검사), [TASK-008](tasks/TASKS.md#task-008-증분-인덱싱-trace-impact)

## Context Compiler

### REQ-CONTEXT-001 Director Context Packet 생성

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§3, P§9, H-10]
```

Context Compiler는 Task, Git Diff, Project Graph, 관련 Requirement/Decision/Issue/Test를 입력으로 받아 Director Context Packet을 결정적으로 만든다. LLM을 호출하지 않는다.

상세: [05-context-compiler](05-context-compiler.md) · ADR: [ADR-004](adr/ADR-004-mcp-context-gateway.md), [ADR-005](adr/ADR-005-token-measurement.md), [ADR-008](adr/ADR-008-deterministic-first.md) · Task: [TASK-010](tasks/TASKS.md#task-010-context-compiler)

### REQ-CONTEXT-002 Token budget 상한

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§3]
```

Packet은 공식 토큰 측정 기준으로 budget을 넘지 않는다. 필수 항목(Task, 관련 confirmed Decision과 Constraint, 관련 ASK)이 먼저 들어간다.

상세: [05-context-compiler](05-context-compiler.md) · ADR: [ADR-005](adr/ADR-005-token-measurement.md) · Task: [TASK-010](tasks/TASKS.md#task-010-context-compiler)

### REQ-CONTEXT-003 Context 지표 기록

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§12, D§21]
```

Context 요청마다 Repository, Candidate, Loaded 토큰, 고려하거나 로드한 파일 수, LLM 호출 수, 측정 방식을 기록한다.

상세: [09-token-strategy](09-token-strategy.md) · ADR: [ADR-005](adr/ADR-005-token-measurement.md) · Task: [TASK-010](tasks/TASKS.md#task-010-context-compiler)

## Review와 Evidence

### REQ-REVIEW-001 Diff Review 파이프라인

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§5, P§12]
```

`duoctl review`는 변경 Symbol과 영향 Subgraph에 규칙을 적용해 Claim을 만들고 Review Verdict를 낸다.

상세: [ADR-007](adr/ADR-007-verdict-model.md) · ADR: [ADR-007](adr/ADR-007-verdict-model.md) · Task: [TASK-013](tasks/TASKS.md#task-013-review-엔진)

### REQ-REVIEW-002 두 수준 Verdict 모델

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§6, H-8]
```

Claim 수준은 ALIGNED, PARTIAL, CONFLICT, UNKNOWN, Review 수준은 PASS, WARN, BLOCK, ASK만 쓴다. 숫자 점수는 쓰지 않는다.

상세: [ADR-007](adr/ADR-007-verdict-model.md) · ADR: [ADR-007](adr/ADR-007-verdict-model.md) · Task: [TASK-013](tasks/TASKS.md#task-013-review-엔진)

### REQ-REVIEW-003 Scope Drift와 Spec Conflict 감지

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§1, H-3]
```

명백한 Constraint와 Decision 위반은 규칙으로 판정한다. 의미 판단이 필요한 Scope Drift와 의도 충돌은 LLM에 escalation하며, LLM이 없으면 UNKNOWN 또는 ASK로 남긴다.

상세: [ADR-008](adr/ADR-008-deterministic-first.md) · ADR: [ADR-007](adr/ADR-007-verdict-model.md), [ADR-008](adr/ADR-008-deterministic-first.md) · Task: [TASK-013](tasks/TASKS.md#task-013-review-엔진)

### REQ-REVIEW-004 Spec/Decision/Issue와 Code 사이의 Drift

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§12, H-16]
```

Spec ↔ Code, Decision ↔ Code, Issue ↔ Code 불일치와 External Source가 확정된 Truth와 달라진 경우를 구조적 규칙과 Review Claim으로 계산해 UI에 제공한다.

상세: [08-ui-spec](08-ui-spec.md) · Task: [TASK-013](tasks/TASKS.md#task-013-review-엔진), [TASK-018](tasks/TASKS.md#task-018-local-http-api와-web-ui)

### REQ-EVIDENCE-001 Claim-Evidence-Verdict와 근거 보존

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§6, P§13, H-7, H-14]
```

모든 Claim은 Evidence Pointer를 하나 이상 가진다. 실행마다 생기는 runtime evidence는 ignore하고, Human이 보존하거나 승인한 Review만 `.duo-project/reviews/`에 Pointer 형식(commit SHA, 경로, Symbol, 줄 범위, content hash, ID)으로 남긴다.

상세: [03-data-model](03-data-model.md) · ADR: [ADR-006](adr/ADR-006-duo-layout-git-policy.md), [ADR-007](adr/ADR-007-verdict-model.md) · Task: [TASK-013](tasks/TASKS.md#task-013-review-엔진)

## Decision

### REQ-DECISION-001 Decision 제안

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§7, H-1]
```

DUO와 Agent는 `duo_propose_decision`으로 proposal을 새 파일로만 만들 수 있다. 기존 Decision을 수정하지 않는다.

상세: [ADR-013](adr/ADR-013-decision-lifecycle.md) · ADR: [ADR-013](adr/ADR-013-decision-lifecycle.md) · Task: [TASK-009](tasks/TASKS.md#task-009-decision-생명주기)

### REQ-DECISION-002 Human Confirm/Reject

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [H-1]
```

Human은 `duoctl decision confirm <id>`, `duoctl decision reject <id>`, 또는 UI Decisions 화면의 Confirm/Reject로 결정한다. `.duo-project/decisions/*.yaml` 직접 수정은 fallback이다.

상세: [ADR-013](adr/ADR-013-decision-lifecycle.md) · ADR: [ADR-013](adr/ADR-013-decision-lifecycle.md) · Task: [TASK-009](tasks/TASKS.md#task-009-decision-생명주기), [TASK-015](tasks/TASKS.md#task-015-cli)

### REQ-DECISION-003 Decision Lock

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§7, P§14]
```

Confirmed Decision의 내용은 DUO와 Agent가 자동으로 변경할 수 없다. 변경은 Superseding proposal과 Human confirm으로만 이루어진다. 위반은 Review에서 BLOCK된다.

상세: [ADR-013](adr/ADR-013-decision-lifecycle.md) · ADR: [ADR-013](adr/ADR-013-decision-lifecycle.md) · Task: [TASK-009](tasks/TASKS.md#task-009-decision-생명주기), [TASK-013](tasks/TASKS.md#task-013-review-엔진)

## Knowledge Gap

### REQ-GAP-001 Knowledge Gap 기록과 관련성 기반 질문

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§8, P§15]
```

Knowledge Gap을 기록하되 현재 Task의 Subgraph에 영향을 줄 때만 ASK로 노출한다. 관련성이 애매한 경우의 중요도 판단은 LLM을 쓸 수 있다.

상세: [05-context-compiler](05-context-compiler.md) · ADR: [ADR-008](adr/ADR-008-deterministic-first.md) · Task: [TASK-011](tasks/TASKS.md#task-011-knowledge-gap)

## LLM

### REQ-LLM-001 Deterministic First 판단 순서

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [H-3, P§11]
```

판단은 Rule → Static Analysis → Git → Test → Project Graph → Evidence Retrieval → LLM 순서로 한다. LLM은 의미 판단이 필요할 때만 쓰는 최후의 수단이다.

상세: [ADR-008](adr/ADR-008-deterministic-first.md) · ADR: [ADR-008](adr/ADR-008-deterministic-first.md) · Task: [TASK-013](tasks/TASKS.md#task-013-review-엔진)

### REQ-LLM-002 LLMProvider와 동작하는 Provider 1종

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§15, H-3, H-15]
```

`LLMProvider` 인터페이스와 실제로 동작하는 `OpenAIResponsesProvider`(OpenAI Responses API) 1종을 구현한다. 인터페이스는 OpenAI에 종속되지 않는다.

상세: [ADR-012](adr/ADR-012-llm-provider.md) · ADR: [ADR-012](adr/ADR-012-llm-provider.md) · Task: [TASK-012A](tasks/TASKS.md#task-012a-llmprovider-계약과-no-op), [TASK-012B](tasks/TASKS.md#task-012b-openai-responses-provider)

### REQ-LLM-003 LLM 없이도 동작

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [H-3]
```

API Key나 Provider가 없어도 deterministic 기능은 모두 동작한다. 의미 판단은 추측하지 않고 UNKNOWN 또는 ASK로 처리한다(LLM unavailable ≠ DUO unavailable).

상세: [ADR-008](adr/ADR-008-deterministic-first.md) · ADR: [ADR-008](adr/ADR-008-deterministic-first.md) · Task: [TASK-012A](tasks/TASKS.md#task-012a-llmprovider-계약과-no-op)

### REQ-LLM-004 LLM 사용량 기록

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [H-3]
```

LLM 호출 수와 입력/출력 토큰을 기록하고 `duoctl stats`에 보여 준다.

상세: [09-token-strategy](09-token-strategy.md) · ADR: [ADR-012](adr/ADR-012-llm-provider.md) · Task: [TASK-012A](tasks/TASKS.md#task-012a-llmprovider-계약과-no-op)

## 외부 근거와 안전

### REQ-PROVIDER-001 EvidenceProvider와 Git Provider

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§13]
```

외부 근거는 `EvidenceProvider` 인터페이스로 Core와 분리한다. MVP는 Git Provider만 구현한다.

상세: [02-system-architecture](02-system-architecture.md) · Task: [TASK-006](tasks/TASKS.md#task-006-git-evidence-provider)

### REQ-SAFETY-001 Source Code 비수정과 쓰기 경로 제한

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§1]
```

DUO는 프로젝트 Source Code를 수정하지 않는다. 모든 파일 쓰기는 허용 경로(`.duo-project/` 하위와 `duoctl install`이 설정하는 Agent 파일)로 제한된다.

상세: [10-security](10-security.md) · ADR: [ADR-010](adr/ADR-010-package-structure.md) · Task: [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서), [TASK-004](tasks/TASKS.md#task-004-파일-스캔과-fingerprint)

## Interfaces

### REQ-MCP-001 MCP Context Gateway

```duo
type: requirement
status: planned
milestone: M3
priority: must
source: [D§9, H-10]
```

MCP 서버는 Agent가 `.duo-project`를 직접 읽지 않고 필요한 Context만 얻도록 하는 Context Gateway다. Tool은 9개로 제한한다.

상세: [06-mcp-interface](06-mcp-interface.md) · ADR: [ADR-004](adr/ADR-004-mcp-context-gateway.md), [ADR-011](adr/ADR-011-agent-integration.md) · Task: [TASK-016](tasks/TASKS.md#task-016-mcp-서버)

### REQ-AGENT-001 duoctl install codex/claude

```duo
type: requirement
status: planned
milestone: M3
priority: must
source: [D§10, P§22]
```

Codex와 Claude Code용 Adapter가 MCP 설정과 10줄 이하의 instruction 블록을 설치한다. Repository Context를 startup prompt에 넣지 않는다.

상세: [ADR-011](adr/ADR-011-agent-integration.md) · ADR: [ADR-011](adr/ADR-011-agent-integration.md) · Task: [TASK-017](tasks/TASKS.md#task-017-agent-adapter와-duoctl-install)

### REQ-CLI-001 얇은 CLI

```duo
type: requirement
status: planned
milestone: M3
priority: must
source: [D§11, H-6]
```

CLI는 인자 파싱, 대화형 입력, 출력 형식만 담당한다. Domain Logic은 packages에 둔다.

상세: [07-cli-interface](07-cli-interface.md) · ADR: [ADR-001](adr/ADR-001-language-runtime.md), [ADR-010](adr/ADR-010-package-structure.md) · Task: [TASK-001](tasks/TASKS.md#task-001-저장소-골격), [TASK-015](tasks/TASKS.md#task-015-cli)

### REQ-UI-001 읽기 중심 Web UI 5개 화면

```duo
type: requirement
status: planned
milestone: M3
priority: must
source: [D§12, P§18, H-4]
```

`duoctl ui`는 사용 가능한 127.0.0.1 port에 Overview, Direction, Decisions, Graph, Coverage, Context, Review, Reviews/Evidence 화면을 띄운다. Graph는 bounded 탐색이며 Review에서 drift와 evidence를 보여준다. `--port`로 port를 선택할 수 있다.

상세: [08-ui-spec](08-ui-spec.md) · ADR: [ADR-009](adr/ADR-009-ui-stack.md) · Task: [TASK-018](tasks/TASKS.md#task-018-local-http-api와-web-ui)

### REQ-UI-002 UI의 Decision Confirm/Reject

```duo
type: requirement
status: planned
milestone: M3
priority: must
source: [H-1, H-4]
```

UI가 허용하는 쓰기는 Decision Confirm과 Reject 두 가지뿐이다. 결과는 `.duo-project/decisions/`에 직접 반영되며 UI 전용 상태를 만들지 않는다.

상세: [08-ui-spec](08-ui-spec.md) · ADR: [ADR-009](adr/ADR-009-ui-stack.md), [ADR-013](adr/ADR-013-decision-lifecycle.md) · Task: [TASK-018](tasks/TASKS.md#task-018-local-http-api와-web-ui)

## Token

### REQ-TOKEN-001 토큰 측정 방식과 표기

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§21, H-5]
```

공식 측정은 tokenizer 기반(o200k_base)으로 하고 모든 결과에 측정 방식을 기록한다. `chars/4`는 UI의 대략 추정 fallback으로만 쓴다. 정확한 tokenizer를 적용할 수 없는 Provider의 값은 estimated로 표시한다.

상세: [09-token-strategy](09-token-strategy.md) · ADR: [ADR-005](adr/ADR-005-token-measurement.md) · Task: [TASK-010](tasks/TASKS.md#task-010-context-compiler)

### REQ-TOKEN-002 재현 가능한 Benchmark

```duo
type: requirement
status: planned
milestone: M4
priority: must
source: [D§21, P§20]
```

Benchmark는 D§21의 지표, 측정 방식, byte/char 지표, Ground-truth Coverage를 기록하며 같은 입력에 같은 결과를 낸다.

상세: [09-token-strategy](09-token-strategy.md) · ADR: [ADR-005](adr/ADR-005-token-measurement.md) · Task: [TASK-019](tasks/TASKS.md#task-019-benchmark)

## 비기능

### REQ-NFR-001 Cross-platform

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§17]
```

Windows, macOS, Linux에서 동일하게 동작한다. 내부 경로는 Repository 기준 POSIX 상대경로다.

상세: [02-system-architecture](02-system-architecture.md) · ADR: [ADR-001](adr/ADR-001-language-runtime.md) · Task: [TASK-001](tasks/TASKS.md#task-001-저장소-골격), [TASK-004](tasks/TASKS.md#task-004-파일-스캔과-fingerprint), [TASK-020](tasks/TASKS.md#task-020-e2e와-문서-구현-대조)

### REQ-NFR-002 Local-first

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§16, P§7]
```

기본 설정에서 네트워크 호출, telemetry, Cloud 저장소가 없다. 네트워크는 사용자가 LLM Provider를 설정했을 때만 그 Provider로 발생한다.

상세: [10-security](10-security.md) · ADR: [ADR-012](adr/ADR-012-llm-provider.md) · Task: [TASK-012B](tasks/TASKS.md#task-012b-openai-responses-provider)

### REQ-NFR-003 네이티브 빌드 없는 설치

```duo
type: requirement
status: planned
milestone: M1
priority: must
source: [D§17]
```

npm 계열 명령 한 줄로 설치되며 네이티브 컴파일이 필요 없다. 장기적으로 단일 binary를 지향한다.

상세: [ADR-010](adr/ADR-010-package-structure.md) · ADR: [ADR-001](adr/ADR-001-language-runtime.md), [ADR-010](adr/ADR-010-package-structure.md) · Task: [TASK-001](tasks/TASKS.md#task-001-저장소-골격)

### REQ-NFR-004 성능 목표

```duo
type: requirement
status: planned
milestone: M4
priority: should
source: [D§17]
```

초기 목표(benchmark로 검증 후 확정): 소스 1만 파일 init 60초 이내, 변경 20파일 이하 증분 인덱싱 2초 이내, `duoctl context` 1초 이내.

상세: [09-token-strategy](09-token-strategy.md) · Task: [TASK-019](tasks/TASKS.md#task-019-benchmark)

### REQ-NFR-005 결정적 출력

```duo
type: requirement
status: planned
milestone: M2
priority: must
source: [D§21]
```

같은 Graph 상태, Task, budget은 byte 단위로 같은 Packet을 만든다. LLM 판정 결과는 cache에 저장해 재실행 시 재사용한다.

상세: [05-context-compiler](05-context-compiler.md) · Task: [TASK-010](tasks/TASKS.md#task-010-context-compiler)

### REQ-NFR-006 간결한 기본 출력

```duo
type: requirement
status: planned
milestone: M3
priority: must
source: [D§14]
```

기본 출력은 짧다. 상세 정보는 `--verbose`와 `--json`으로 얻는다.

상세: [07-cli-interface](07-cli-interface.md) · Task: [TASK-015](tasks/TASKS.md#task-015-cli)

### REQ-NFR-007 MCP stdout 순수성

```duo
type: requirement
status: planned
milestone: M3
priority: must
source: [D§9]
```

MCP stdio 서버는 stdout에 JSON-RPC 메시지만 쓴다.

상세: [06-mcp-interface](06-mcp-interface.md) · ADR: [ADR-004](adr/ADR-004-mcp-context-gateway.md) · Task: [TASK-016](tasks/TASKS.md#task-016-mcp-서버)

## MVP 제외

두 원본 문서의 제외 목록을 합쳤다. 필요성이 검증되면 별도 Spec을 작성한 뒤 추가한다.

Vector Database, Neo4j 필수 설치, Multi-Agent 토론, Cloud Account/Dashboard, Team Chat, Kanban, Sprint Manager, Jira 대체 기능, Jira Write, Jira Issue 삭제, Git GUI/Client, 자동 Source Code 수정, 자동 Requirement/Spec 수정, 자동 Confirmed Decision 변경, UI의 Intent/Spec/Milestone 편집(H-4), OpenAI Responses 외 LLM Provider(H-15).

## Post-MVP

### REQ-POST-001 Jira Read-only 연동

```duo
type: requirement
status: deferred
milestone: null
priority: could
source: [D§13]
```

JQL은 `.duo-project/integrations/jira.yaml`에서 관리한다. Core E2E가 안정된 뒤 착수한다.

상세: [12-roadmap](12-roadmap.md)

### REQ-POST-002 GitHub Issues, Linear, GitLab Issues Provider

```duo
type: requirement
status: deferred
milestone: null
priority: could
source: [P§21]
```

POST-001 이후 EvidenceProvider로 추가한다.

상세: [12-roadmap](12-roadmap.md)

### REQ-POST-003 PythonAnalyzer

```duo
type: requirement
status: deferred
milestone: null
priority: could
source: [H-2]
```

Stretch Goal이다. `LanguageAnalyzer` 구현 하나를 추가하는 것으로 끝나야 한다.

상세: [12-roadmap](12-roadmap.md)

### REQ-POST-004 추가 LLM Provider

```duo
type: requirement
status: deferred
milestone: null
priority: could
source: [D§15, H-15]
```

OpenAICompatibleChatProvider, AnthropicProvider, LocalProvider. MVP Provider가 안정된 뒤 `LLMProvider` 구현으로 추가한다.

상세: [12-roadmap](12-roadmap.md)

### REQ-POST-005 UI 편집 확장

```duo
type: requirement
status: deferred
milestone: null
priority: could
source: [P§7]
```

Intent, Spec, Milestone 편집. MVP에서는 구현하지 않는다.

상세: [12-roadmap](12-roadmap.md)

### REQ-POST-006 테스트 결과 보고서 수집

```duo
type: requirement
status: deferred
milestone: null
priority: could
source: [D§14]
```

JUnit XML 등 외부 테스트 결과 파일 수집.

상세: [12-roadmap](12-roadmap.md)

### REQ-POST-007 단일 binary 배포

```duo
type: requirement
status: deferred
milestone: null
priority: could
source: [D§17]
```

Node SEA 등으로 단일 실행 파일을 만든다.

상세: [ADR-010](adr/ADR-010-package-structure.md)

## 추적 표

| Requirement | Milestone | ADR | Task | AC |
|---|---|---|---|---|
| [REQ-TRUTH-001](#req-truth-001-duo-project-project-truth-layer와-소유권) | M1 | [ADR-006](adr/ADR-006-duo-layout-git-policy.md) | [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서), [TASK-014](tasks/TASKS.md#task-014-init-파이프라인) | 10 |
| [REQ-TRUTH-002](#req-truth-002-git-관리-정책) | M1 | [ADR-006](adr/ADR-006-duo-layout-git-policy.md) | [TASK-014](tasks/TASKS.md#task-014-init-파이프라인) | 5 |
| [REQ-TRUTH-003](#req-truth-003-human-readable-형식과-스키마-검증) | M1 | [ADR-014](adr/ADR-014-traceability-ids.md) | [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서) | 5 |
| [REQ-TRACE-001](#req-trace-001-id-기반-추적성) | M1 | [ADR-014](adr/ADR-014-traceability-ids.md) | [TASK-000](tasks/TASKS.md#task-000-sdd-문서-작성), [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서), [TASK-007](tasks/TASKS.md#task-007-graph-builder와-일관성-검사), [TASK-020](tasks/TASKS.md#task-020-e2e와-문서-구현-대조) | 16 |
| [REQ-INIT-001](#req-init-001-결정적-repository-분석) | M2 | [ADR-008](adr/ADR-008-deterministic-first.md) | [TASK-014](tasks/TASKS.md#task-014-init-파이프라인) | 5 |
| [REQ-INIT-002](#req-init-002-intent-초안-구현-상태-추론-knowledge-gap-생성) | M2 | - | [TASK-014](tasks/TASKS.md#task-014-init-파이프라인) | 5 |
| [REQ-INIT-003](#req-init-003-human-intent-확인) | M2 | - | [TASK-014](tasks/TASKS.md#task-014-init-파이프라인) | 5 |
| [REQ-INDEX-001](#req-index-001-언어-비종속-languageanalyzer) | M1 | [ADR-003](adr/ADR-003-language-analysis.md) | [TASK-005](tasks/TASKS.md#task-005-languageanalyzer와-tsjs-analyzer) | 4 |
| [REQ-INDEX-002](#req-index-002-fingerprint-기반-증분-인덱싱) | M1 | [ADR-002](adr/ADR-002-graph-storage.md) | [TASK-004](tasks/TASKS.md#task-004-파일-스캔과-fingerprint), [TASK-008](tasks/TASKS.md#task-008-증분-인덱싱-trace-impact) | 8 |
| [REQ-INDEX-003](#req-index-003-git-diff에서-변경-symbol-도출) | M1 | [ADR-003](adr/ADR-003-language-analysis.md) | [TASK-006](tasks/TASKS.md#task-006-git-evidence-provider) | 4 |
| [REQ-GRAPH-001](#req-graph-001-node-8종과-edge-10종의-embedded-저장) | M1 | [ADR-002](adr/ADR-002-graph-storage.md), [ADR-003](adr/ADR-003-language-analysis.md) | [TASK-003](tasks/TASKS.md#task-003-graphstore), [TASK-007](tasks/TASKS.md#task-007-graph-builder와-일관성-검사) | 8 |
| [REQ-GRAPH-002](#req-graph-002-결정적-bounded-traversal-trace-impact) | M1 | - | [TASK-003](tasks/TASKS.md#task-003-graphstore), [TASK-008](tasks/TASKS.md#task-008-증분-인덱싱-trace-impact) | 8 |
| [REQ-GRAPH-003](#req-graph-003-graph-일관성-불변식) | M1 | - | [TASK-007](tasks/TASKS.md#task-007-graph-builder와-일관성-검사), [TASK-008](tasks/TASKS.md#task-008-증분-인덱싱-trace-impact) | 8 |
| [REQ-CONTEXT-001](#req-context-001-director-context-packet-생성) | M2 | [ADR-004](adr/ADR-004-mcp-context-gateway.md), [ADR-005](adr/ADR-005-token-measurement.md), [ADR-008](adr/ADR-008-deterministic-first.md) | [TASK-010](tasks/TASKS.md#task-010-context-compiler) | 6 |
| [REQ-CONTEXT-002](#req-context-002-token-budget-상한) | M2 | [ADR-005](adr/ADR-005-token-measurement.md) | [TASK-010](tasks/TASKS.md#task-010-context-compiler) | 6 |
| [REQ-CONTEXT-003](#req-context-003-context-지표-기록) | M2 | [ADR-005](adr/ADR-005-token-measurement.md) | [TASK-010](tasks/TASKS.md#task-010-context-compiler) | 6 |
| [REQ-REVIEW-001](#req-review-001-diff-review-파이프라인) | M2 | [ADR-007](adr/ADR-007-verdict-model.md) | [TASK-013](tasks/TASKS.md#task-013-review-엔진) | 5 |
| [REQ-REVIEW-002](#req-review-002-두-수준-verdict-모델) | M2 | [ADR-007](adr/ADR-007-verdict-model.md) | [TASK-013](tasks/TASKS.md#task-013-review-엔진) | 5 |
| [REQ-REVIEW-003](#req-review-003-scope-drift와-spec-conflict-감지) | M2 | [ADR-007](adr/ADR-007-verdict-model.md), [ADR-008](adr/ADR-008-deterministic-first.md) | [TASK-013](tasks/TASKS.md#task-013-review-엔진) | 5 |
| [REQ-REVIEW-004](#req-review-004-specdecisionissue와-code-사이의-drift) | M2 | - | [TASK-013](tasks/TASKS.md#task-013-review-엔진), [TASK-018](tasks/TASKS.md#task-018-local-http-api와-web-ui) | 10 |
| [REQ-EVIDENCE-001](#req-evidence-001-claim-evidence-verdict와-근거-보존) | M2 | [ADR-006](adr/ADR-006-duo-layout-git-policy.md), [ADR-007](adr/ADR-007-verdict-model.md) | [TASK-013](tasks/TASKS.md#task-013-review-엔진) | 5 |
| [REQ-DECISION-001](#req-decision-001-decision-제안) | M2 | [ADR-013](adr/ADR-013-decision-lifecycle.md) | [TASK-009](tasks/TASKS.md#task-009-decision-생명주기) | 5 |
| [REQ-DECISION-002](#req-decision-002-human-confirmreject) | M2 | [ADR-013](adr/ADR-013-decision-lifecycle.md) | [TASK-009](tasks/TASKS.md#task-009-decision-생명주기), [TASK-015](tasks/TASKS.md#task-015-cli) | 10 |
| [REQ-DECISION-003](#req-decision-003-decision-lock) | M2 | [ADR-013](adr/ADR-013-decision-lifecycle.md) | [TASK-009](tasks/TASKS.md#task-009-decision-생명주기), [TASK-013](tasks/TASKS.md#task-013-review-엔진) | 10 |
| [REQ-GAP-001](#req-gap-001-knowledge-gap-기록과-관련성-기반-질문) | M2 | [ADR-008](adr/ADR-008-deterministic-first.md) | [TASK-011](tasks/TASKS.md#task-011-knowledge-gap) | 4 |
| [REQ-LLM-001](#req-llm-001-deterministic-first-판단-순서) | M2 | [ADR-008](adr/ADR-008-deterministic-first.md) | [TASK-013](tasks/TASKS.md#task-013-review-엔진) | 5 |
| [REQ-LLM-002](#req-llm-002-llmprovider와-동작하는-provider-1종) | M2 | [ADR-012](adr/ADR-012-llm-provider.md) | [TASK-012A](tasks/TASKS.md#task-012a-llmprovider-계약과-no-op), [TASK-012B](tasks/TASKS.md#task-012b-openai-responses-provider) | 5 |
| [REQ-LLM-003](#req-llm-003-llm-없이도-동작) | M2 | [ADR-008](adr/ADR-008-deterministic-first.md) | [TASK-012A](tasks/TASKS.md#task-012a-llmprovider-계약과-no-op) | 3 |
| [REQ-LLM-004](#req-llm-004-llm-사용량-기록) | M2 | [ADR-012](adr/ADR-012-llm-provider.md) | [TASK-012A](tasks/TASKS.md#task-012a-llmprovider-계약과-no-op) | 3 |
| [REQ-PROVIDER-001](#req-provider-001-evidenceprovider와-git-provider) | M1 | - | [TASK-006](tasks/TASKS.md#task-006-git-evidence-provider) | 4 |
| [REQ-SAFETY-001](#req-safety-001-source-code-비수정과-쓰기-경로-제한) | M1 | [ADR-010](adr/ADR-010-package-structure.md) | [TASK-002](tasks/TASKS.md#task-002-core-스키마-loader-추적성-파서), [TASK-004](tasks/TASKS.md#task-004-파일-스캔과-fingerprint) | 9 |
| [REQ-MCP-001](#req-mcp-001-mcp-context-gateway) | M3 | [ADR-004](adr/ADR-004-mcp-context-gateway.md), [ADR-011](adr/ADR-011-agent-integration.md) | [TASK-016](tasks/TASKS.md#task-016-mcp-서버) | 5 |
| [REQ-AGENT-001](#req-agent-001-duoctl-install-codexclaude) | M3 | [ADR-011](adr/ADR-011-agent-integration.md) | [TASK-017](tasks/TASKS.md#task-017-agent-adapter와-duoctl-install) | 5 |
| [REQ-CLI-001](#req-cli-001-얇은-cli) | M3 | [ADR-001](adr/ADR-001-language-runtime.md), [ADR-010](adr/ADR-010-package-structure.md) | [TASK-001](tasks/TASKS.md#task-001-저장소-골격), [TASK-015](tasks/TASKS.md#task-015-cli) | 9 |
| [REQ-UI-001](#req-ui-001-읽기-중심-web-ui-5개-화면) | M3 | [ADR-009](adr/ADR-009-ui-stack.md) | [TASK-018](tasks/TASKS.md#task-018-local-http-api와-web-ui) | 5 |
| [REQ-UI-002](#req-ui-002-ui의-decision-confirmreject) | M3 | [ADR-009](adr/ADR-009-ui-stack.md), [ADR-013](adr/ADR-013-decision-lifecycle.md) | [TASK-018](tasks/TASKS.md#task-018-local-http-api와-web-ui) | 5 |
| [REQ-TOKEN-001](#req-token-001-토큰-측정-방식과-표기) | M2 | [ADR-005](adr/ADR-005-token-measurement.md) | [TASK-010](tasks/TASKS.md#task-010-context-compiler) | 6 |
| [REQ-TOKEN-002](#req-token-002-재현-가능한-benchmark) | M4 | [ADR-005](adr/ADR-005-token-measurement.md) | [TASK-019](tasks/TASKS.md#task-019-benchmark) | 4 |
| [REQ-NFR-001](#req-nfr-001-cross-platform) | M1 | [ADR-001](adr/ADR-001-language-runtime.md) | [TASK-001](tasks/TASKS.md#task-001-저장소-골격), [TASK-004](tasks/TASKS.md#task-004-파일-스캔과-fingerprint), [TASK-020](tasks/TASKS.md#task-020-e2e와-문서-구현-대조) | 11 |
| [REQ-NFR-002](#req-nfr-002-local-first) | M1 | [ADR-012](adr/ADR-012-llm-provider.md) | [TASK-012B](tasks/TASKS.md#task-012b-openai-responses-provider) | 2 |
| [REQ-NFR-003](#req-nfr-003-네이티브-빌드-없는-설치) | M1 | [ADR-001](adr/ADR-001-language-runtime.md), [ADR-010](adr/ADR-010-package-structure.md) | [TASK-001](tasks/TASKS.md#task-001-저장소-골격) | 4 |
| [REQ-NFR-004](#req-nfr-004-성능-목표) | M4 | - | [TASK-019](tasks/TASKS.md#task-019-benchmark) | 4 |
| [REQ-NFR-005](#req-nfr-005-결정적-출력) | M2 | - | [TASK-010](tasks/TASKS.md#task-010-context-compiler) | 6 |
| [REQ-NFR-006](#req-nfr-006-간결한-기본-출력) | M3 | - | [TASK-015](tasks/TASKS.md#task-015-cli) | 5 |
| [REQ-NFR-007](#req-nfr-007-mcp-stdout-순수성) | M3 | [ADR-004](adr/ADR-004-mcp-context-gateway.md) | [TASK-016](tasks/TASKS.md#task-016-mcp-서버) | 5 |

ADR 열이 비어 있는 Requirement는 별도의 기술 선택이 필요 없어 Task로 바로 연결된다.
