# DUO 프로젝트 개발 지시

당신은 지금부터 오픈소스 프로젝트 **DUO**를 설계하고 구현한다.

DUO는 또 하나의 코딩 에이전트가 아니다.

DUO의 목적은 **Codex, Claude Code 등 AI Coding Agent가 프로젝트의 원래 목표와 명세에서 벗어나지 않도록 프로젝트 상태를 관찰하고, 필요한 Context만 제공하며, 작업 결과를 검수하는 AI Director Layer**를 만드는 것이다.

핵심 목표는 다음 두 가지다.

1. AI Coding Agent가 프로젝트의 목표와 결정사항을 잊지 않도록 한다.
2. 전체 Repository를 반복해서 읽지 않고 필요한 정보만 전달하여 토큰 사용량을 줄인다.

---

# 0. 작업 원칙

코드를 바로 작성하지 마라.

반드시 다음 순서로 진행한다.

1. 이 문서 전체를 분석한다.
2. `/docs` 아래에 SDD 문서를 작성한다.
3. 시스템 요구사항과 아키텍처를 확정한다.
4. 구현 단위를 작은 Task로 분해한다.
5. 의존성과 구현 순서를 정의한다.
6. 그 후에만 코드를 작성한다.
7. 각 Task가 끝날 때마다 관련 문서와 실제 구현 상태를 비교한다.
8. 요구되지 않은 기능을 임의로 추가하지 않는다.

문서와 구현이 충돌하면 임의로 한쪽을 수정하지 말고 충돌을 기록한다.

---

# 1. 제품 정의

DUO는 다음 구조를 가진다.

```text
Human
  │
  │ Intent / Decision
  ▼
DUO
  │
  │ Context / Review / Evidence
  ▼
Coding Agent
  │
  │ Implementation
  ▼
Repository
```

역할을 명확하게 분리한다.

## Human

사람이 최종 결정권을 가진다.

Human-owned 정보:

- Project Goal
- Product Intent
- Requirement
- Confirmed Decision
- Constraint

DUO가 이를 자동으로 변경해서는 안 된다.

---

## DUO

DUO가 담당한다.

- Repository 관찰
- Git 변경 감지
- Project Graph 관리
- 관련 Context 추출
- Requirement ↔ Code 연결
- Decision ↔ Code 연결
- Issue ↔ Code 연결
- Test ↔ Code 연결
- Scope Drift 감지
- Spec Conflict 감지
- Knowledge Gap 감지
- Evidence 수집
- AI Coding Agent용 Context 생성

DUO는 기본적으로 프로젝트 Source Code를 직접 수정하지 않는다.

---

## Coding Agent

Codex, Claude Code 등의 Agent가 담당한다.

- 실제 코드 작성
- 테스트 작성
- 리팩터링
- 버그 수정

Coding Agent는 `.duo` 내부 상태를 임의 수정하면 안 된다.

---

# 2. Source of Truth

각 프로젝트에는 다음 디렉터리가 생성된다.

```text
.duo/
├─ project.yaml
│
├─ intent/
│  ├─ vision.md
│  └─ constraints.yaml
│
├─ specs/
│
├─ decisions/
│
├─ milestones/
│
├─ integrations/
│
├─ state/
│
├─ evidence/
│
└─ generated/
```

## Git으로 관리하는 Human-readable 데이터

```text
intent/
specs/
decisions/
milestones/
integrations/
```

사용자는 이 파일들을 직접 읽고 수정할 수 있어야 한다.

## 자동 생성 데이터

```text
state/
evidence/
generated/
```

예:

```text
generated/
├─ graph.db
├─ fingerprints.db
└─ cache/
```

UI나 별도의 Cloud DB가 Source of Truth가 되어서는 안 된다.

---

# 3. 핵심 기능

MVP에는 다음 기능만 구현한다.

## duo init

Repository를 최초 분석한다.

수행 작업:

- 프로젝트 구조 탐색
- README / docs 탐색
- manifest 탐색
- Git metadata 분석
- source file 탐색
- AST 기반 symbol 추출
- dependency 분석
- 기존 기획 문서 탐색
- Project Intent 초안 생성
- 현재 구현 상태 추론
- Knowledge Gap 생성

LLM에게 Repository 전체를 전달해서는 안 된다.

가능한 분석은 일반 코드로 먼저 수행한다.

---

## Context Compiler

DUO의 핵심 기능이다.

Coding Agent에게 Repository 전체를 제공하지 않는다.

입력:

```text
Task
Git Diff
Project Graph
Relevant Requirement
Relevant Decision
Relevant Issue
Relevant Tests
```

출력:

```text
Director Context Packet
```

예:

```text
TASK
GAME-42 Refresh Token

REQUIREMENT
AUTH-03

DECISION
D-004 JWT Authentication

CHANGED SYMBOLS
AuthService.refresh
JwtProvider.validate

RELATED TEST
AuthServiceTest.refreshToken

CONSTRAINT
OAuth is outside MVP.
```

Context에는 token budget을 적용한다.

---

# 4. Project Graph

DUO는 Project Graph를 유지한다.

단순 Code Graph가 아니다.

초기 Node Type:

```text
Project
Milestone
Requirement
Decision
Issue
File
Symbol
Test
```

초기 Edge Type:

```text
CONTAINS
REQUIRES
IMPLEMENTS
CALLS
IMPORTS
GOVERNS
TRACKED_BY
VALIDATED_BY
CHANGED_WITH
```

예:

```text
GAME-42
   │
TRACKED_BY
   ▼
AUTH-03
   │
GOVERNS
   ▼
AuthService.refresh
   │
CALLS
   ▼
JwtProvider.validate
   │
VALIDATED_BY
   ▼
AuthServiceTest
```

그래프의 목적은 시각화가 아니라 **Context Localisation**이다.

Task 또는 변경된 Symbol을 seed로 사용하여 작은 Subgraph만 탐색한다.

초기 구현에서는 외부 Neo4j를 필수 의존성으로 만들지 않는다.

가능하면 SQLite 또는 가벼운 embedded storage를 사용한다.

---

# 5. Incremental Indexing

초기 `duo init` 이후 Repository 전체를 반복 분석하지 않는다.

파일 fingerprint/hash를 저장한다.

```text
Git Diff
   ↓
Changed Files
   ↓
Changed Symbols
   ↓
Affected Subgraph
   ↓
Context Compiler
```

변경되지 않은 파일은 분석하지 않는다.

---

# 6. Evidence 기반 판정

DUO는 근거 없이 판정하지 않는다.

모든 주요 판단은 다음 구조를 가진다.

```text
Claim
Evidence
Verdict
```

Verdict는 다음 네 종류만 기본 제공한다.

```text
PASS
WARN
BLOCK
ASK
```

또는 세부 Alignment 표현:

```text
ALIGNED
PARTIAL
CONFLICT
UNKNOWN
```

임의의 `Alignment 83%` 같은 정밀 점수는 사용하지 않는다.

예:

```text
VERDICT: CONFLICT

Expected:
MVP에서는 OAuth를 지원하지 않는다.

Observed:
GoogleOAuthService가 새로 추가되었다.

Evidence:
D-012
src/auth/GoogleOAuthService.ts
commit 91aca1
```

---

# 7. Decision Lock

사람이 승인한 결정은 잠근다.

예:

```yaml
id: D-004
state: confirmed

question: multiplayer_authority
answer: server_authoritative

owner: human
```

DUO와 Coding Agent는 이를 자동 수정할 수 없다.

필요하다면:

```text
Propose Superseding D-004
```

까지만 가능하다.

최종 변경은 Human 승인 후 이루어진다.

---

# 8. Knowledge Gap

DUO가 알 수 없는 프로젝트 정보를 기록한다.

하지만 발견할 때마다 사용자에게 질문하지 않는다.

현재 Task에 영향을 줄 때만 질문한다.

예:

```text
UNKNOWN:
Maximum concurrent players
```

현재 UI 작업이라면 무시한다.

Network Architecture 작업이라면:

```text
ASK

Maximum concurrent players is undefined.
This affects the proposed architecture.
```

를 반환한다.

---

# 9. MCP

DUO는 MCP Server를 제공한다.

Codex, Claude Code 등의 Agent가 `.duo` 파일을 직접 전부 읽지 않고 DUO를 통해 필요한 정보만 얻도록 한다.

초기 MCP Tool은 최소화한다.

```text
duo_get_context
duo_review_changes
duo_get_status
duo_get_requirement
duo_get_decision
duo_trace
duo_impact
duo_search_evidence
duo_propose_decision
```

MCP의 가장 중요한 역할은 **Context Compiler API**다.

---

# 10. Agent Integration

다음을 지원하는 Adapter 구조를 만든다.

```text
Codex
Claude Code
```

향후 확장 가능해야 한다.

설치 명령의 최종 UX 목표:

```bash
duo install codex
duo install claude
```

설치 과정에서 필요하면 다음을 설정한다.

```text
AGENTS.md
CLAUDE.md
.mcp.json
Codex MCP configuration
```

단, 생성되는 Agent instruction 파일은 매우 짧게 유지한다.

Repository 전체 Context를 startup prompt에 넣지 않는다.

---

# 11. CLI

최소 CLI:

```bash
duo init

duo status

duo context <task>

duo review

duo trace <node>

duo impact <symbol>

duo stats

duo ui
```

CLI는 Human과 Agent 모두 사용할 수 있어야 한다.

---

# 12. Web UI

`duo ui` 실행 시 로컬 웹 UI를 실행한다.

예:

```text
http://localhost:7346
```

초기 화면은 5개만 만든다.

```text
Overview
Graph
Decisions
Drift
Context
```

## Overview

- Project Goal
- Current Milestone
- Current Progress
- Blocking Decisions
- Recent Changes

## Graph

Project Graph 탐색.

## Decisions

- Confirmed
- Pending
- Superseded

## Drift

- Spec ↔ Code
- Decision ↔ Code
- Issue ↔ Code

불일치를 보여준다.

## Context

DUO가 얼마나 많은 Context를 줄였는지 보여준다.

예:

```text
Repository Estimated Context
182,400 tokens

Candidate Context
17,800 tokens

Loaded Context
4,920 tokens

Reduction
97.3%

LLM Calls
1
```

---

# 13. 외부 Integration

초기 MVP에서는 외부 Integration을 Core와 분리한다.

Adapter 구조:

```text
Duo Core
    │
Evidence Provider
    │
 ┌──┴─────────────┐
Git              Jira
                 GitHub Issues
```

MVP에서는 Git을 구현한다.

Jira는 Core 구현이 안정된 후 추가한다.

Jira 초기 연동은 READ ONLY로 제한한다.

JQL은 다음처럼 `.duo`에서 관리할 수 있어야 한다.

```text
.duo/integrations/jira.yaml
```

---

# 14. Token Optimization 원칙

DUO에서 토큰 최적화는 핵심 기능이지 부가 기능이 아니다.

우선순위:

```text
1. LLM을 호출하지 않는다.
2. 전체 Repository를 읽지 않는다.
3. 관련 파일만 찾는다.
4. 관련 Symbol만 읽는다.
5. 관련 Subgraph만 전달한다.
6. 적절한 작은 모델을 사용한다.
7. 반복 Context는 caching 가능하게 구성한다.
8. 출력은 기본적으로 간결하게 유지한다.
```

다음 작업에는 LLM을 사용하지 않는다.

- 파일 변경 여부
- Git Diff
- Test 성공 여부
- Dependency 존재 여부
- Jira 상태
- Symbol 추출
- import 관계
- call 관계
- fingerprint 비교

LLM은 의미적 판단이 필요한 경우에만 사용한다.

---

# 15. Model Provider

특정 LLM Provider에 종속되지 않게 한다.

초기 interface:

```text
LLMProvider
```

향후:

```text
OpenAI
Anthropic
Local
```

등을 연결할 수 있어야 한다.

하지만 MVP에서 불필요한 Provider를 전부 구현하지 않는다.

---

# 16. 구현하지 않을 것

MVP에서는 다음 기능을 구현하지 않는다.

```text
Vector Database
Neo4j 필수 설치
Multi-Agent 토론
Cloud Account
Cloud Dashboard
Team Chat
Kanban
Sprint Manager
Jira 대체 기능
Git GUI
자동 Source Code 수정
자동 Requirement 수정
자동 Confirmed Decision 변경
Jira Issue 삭제
```

필요성이 검증된 후 별도 Spec을 작성해서 추가한다.

---

# 17. 기술 스택 선정

구현을 시작하기 전에 기술 스택 후보를 분석한다.

조건:

- Cross-platform
- 빠른 설치
- Local-first
- CLI 제공
- MCP 지원
- AST 분석 가능
- React 기반 UI 사용 가능
- 단일 binary 또는 단순한 package 설치를 장기적으로 지향

TypeScript 기반을 우선 검토하되 다른 선택이 명확히 유리하면 근거를 문서화한다.

기술 선택은 `/docs/architecture/ADR-xxx.md` 형식으로 기록한다.

---

# 18. SDD 문서

구현 전 최소 다음 문서를 생성한다.

```text
docs/

├─ 00-product-vision.md
├─ 01-requirements.md
├─ 02-system-architecture.md
├─ 03-data-model.md
├─ 04-project-graph.md
├─ 05-context-compiler.md
├─ 06-mcp-interface.md
├─ 07-cli-interface.md
├─ 08-ui-spec.md
├─ 09-token-strategy.md
├─ 10-security.md
├─ 11-testing-strategy.md
├─ 12-roadmap.md
│
├─ adr/
│
└─ tasks/
```

각 문서는 서로 충돌하지 않아야 한다.

---

# 19. Task 관리

기능 구현 전에:

```text
docs/tasks/TASKS.md
```

를 생성한다.

각 Task에는:

```text
ID
Goal
Input
Output
Dependencies
Acceptance Criteria
Files expected to change
Status
```

가 있어야 한다.

한 번에 너무 많은 Task를 구현하지 않는다.

---

# 20. 검증

각 주요 기능은 테스트를 작성한다.

특히 다음은 반드시 검증한다.

```text
Repository indexing
Incremental indexing
Graph consistency
Context retrieval
Token budget
Decision Lock
Knowledge Gap
Diff review
MCP tool contract
```

가능하면 fixture repository를 만들어 테스트한다.

---

# 21. Benchmark

DUO의 핵심 주장인 Context 절감 효과를 측정한다.

Benchmark에서는 최소 다음 값을 기록한다.

```text
Repository Files
Repository Estimated Tokens

Files Considered
Files Loaded

Raw Context Tokens
Compiled Context Tokens

Reduction %

LLM Calls

Review Result
```

단순히 "토큰을 많이 절약한다"고 주장하지 않는다.

재현 가능한 benchmark를 만든다.

---

# 22. 현재 첫 번째 작업

아직 Source Code를 구현하지 마라.

먼저 다음을 수행하라.

1. 이 요구사항을 분석한다.
2. 예상되는 모순이나 불명확한 부분을 식별한다.
3. `/docs` SDD 구조를 설계한다.
4. 시스템 아키텍처를 작성한다.
5. MVP와 Post-MVP 경계를 확정한다.
6. Task를 dependency 순서로 분해한다.
7. ADR이 필요한 기술적 결정사항을 정리한다.
8. Repository 초기 구조를 제안한다.

모든 설계가 끝난 후 구현을 시작한다.

목표는 기능 수가 아니라 다음 End-to-End 흐름을 완성하는 것이다.

```text
Repository
    ↓
Duo 설치
    ↓
duo init
    ↓
자동 프로젝트 분석
    ↓
필요한 Human Intent 확인
    ↓
.duo 생성
    ↓
Project Graph 생성
    ↓
Coding Agent가 MCP를 통해 Context 요청
    ↓
코딩
    ↓
Git Diff
    ↓
Duo Review
    ↓
PASS / WARN / BLOCK / ASK
    ↓
UI에서 Evidence와 Drift 확인
```

이 흐름이 안정적으로 작동하기 전까지 범위를 확장하지 마라.