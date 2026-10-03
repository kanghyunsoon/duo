> **Historical design input.** This document records the original concept (2026-09) and is not the current product specification. Names, interfaces and scope changed during development (for example `duo` → `duoctl`, `.duo/` → `.duo-project/`). For current behavior see [README.md](README.md), [docs/README.md](docs/README.md) and [docs/release/product-contract.md](docs/release/product-contract.md).
>
> **초기 설계 입력 기록.** 이 문서는 처음 구상(2026-09)을 보존한 것이며 현재 제품 사양이 아닙니다. 개발 중 이름, 인터페이스, 범위가 바뀌었습니다(예: `duo` → `duoctl`, `.duo/` → `.duo-project/`). 현재 동작은 [README.ko.md](README.ko.md), [docs/README.md](docs/README.md), [docs/release/product-contract.md](docs/release/product-contract.md)를 보세요.

# DUO

## AI Project Direction Layer for Coding Agents

### 1. 프로젝트 개요

DUO는 Codex, Claude Code와 같은 AI Coding Agent가 장기간 프로젝트를 개발할 때 발생하는 **컨텍스트 손실, 과잉 구현, 요구사항 이탈, 반복적인 Repository 탐색 문제를 해결하기 위한 오픈소스 AI Director 시스템**이다.

DUO는 직접 코드를 작성하는 Coding Agent가 아니다.

프로젝트의 목표, 요구사항, 기술적 결정, 현재 구현 상태를 지속적으로 연결하고 분석하여 Coding Agent에게 현재 작업에 필요한 Context만 제공하고 작업 결과가 프로젝트의 방향성과 일치하는지 검수한다.

핵심 개념은 다음과 같다.

```text
Human defines intent.
Agent performs implementation.
DUO maintains direction.
```

---

# 2. 문제 정의

AI Coding Agent의 구현 능력은 지속적으로 향상되고 있지만 장기간 프로젝트에서는 다음 문제가 반복된다.

### Context 과다

대규모 Repository를 반복해서 탐색하면서 불필요한 토큰이 소비된다.

### Context 손실

이전에 정한 요구사항이나 기술적 결정을 새로운 Agent Session이 알지 못한다.

### Scope Drift

요청하지 않은 기능이나 과도한 구조를 Agent가 추가한다.

### Spec Drift

코드와 기획서가 시간이 지나면서 서로 다른 상태가 된다.

### Project Management Drift

Issue Tracker에서는 완료 상태지만 실제 구현이 없거나 반대 상황이 발생할 수 있다.

### Human Verification Cost

사용자가 Agent가 프로젝트를 제대로 이해하고 있는지 매번 확인해야 한다.

DUO는 이 문제를 프로젝트 단위의 지속적인 상태 관리와 Context Localisation으로 해결한다.

---

# 3. 핵심 가치

DUO의 핵심 가치는 세 가지다.

## Direction

AI가 무엇을 구현할 수 있는지가 아니라 **무엇을 구현해야 하는지**를 유지한다.

## Evidence

AI의 판단을 단순한 자연어 추론으로 끝내지 않는다.

Requirement, Decision, Code, Test, Git Diff 등의 근거를 연결한다.

## Context Efficiency

Repository 전체를 반복해서 LLM에게 전달하지 않는다.

현재 Task와 관계있는 정보만 전달한다.

---

# 4. 기본 구조

```text
                  HUMAN
                    │
             Intent / Decision
                    │
                    ▼
              ┌──────────┐
              │   DUO    │
              │ Director │
              └────┬─────┘
                   │
          Context / Evidence
                   │
                   ▼
           ┌──────────────┐
           │ Coding Agent │
           │Codex / Claude│
           └──────┬───────┘
                  │
             Implementation
                  │
                  ▼
             Repository
                  │
                  └──────────→ DUO
```

---

# 5. 역할 분리

## Human

최종 프로젝트 방향을 결정한다.

Human이 최종 권한을 갖는 정보:

- Product Goal
- Product Intent
- Requirement
- Constraint
- Confirmed Decision

DUO가 이를 임의 변경해서는 안 된다.

## DUO

프로젝트의 이해와 검수를 담당한다.

- Repository 구조 분석
- 상태 추적
- Project Graph
- Context Compiler
- Evidence
- Drift Detection
- Knowledge Gap
- Decision Lock

## Coding Agent

실제 구현을 수행한다.

- Coding
- Testing
- Refactoring
- Debugging

---

# 6. Project Truth Layer

각 Repository에는 `.duo` 디렉터리가 존재한다.

```text
.duo/
├─ project.yaml
├─ intent/
├─ specs/
├─ decisions/
├─ milestones/
├─ integrations/
├─ state/
├─ evidence/
└─ generated/
```

`.duo`는 단순 AI 메모 폴더가 아니다.

다음을 나타내는 Project Truth Layer다.

> 이 프로젝트가 무엇을 만들려고 하는가.

> 어떤 결정을 내렸는가.

> 현재 어디까지 구현되었는가.

> 무엇이 요구사항과 충돌하는가.

---

# 7. Human-readable First

프로젝트의 핵심 정보는 독점 DB에 저장하지 않는다.

다음 정보는 사람이 직접 읽을 수 있는 Markdown/YAML/JSON 형태로 관리한다.

```text
Intent
Requirement
Decision
Milestone
Integration configuration
```

사용자는 UI 없이도 `.duo`를 이해할 수 있어야 한다.

UI는 `.duo`를 표현하고 수정하는 View 역할을 한다.

---

# 8. Project Graph

DUO의 핵심 데이터 구조다.

Project Graph는 Code Graph보다 상위 개념이다.

초기 Node:

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

초기 Edge:

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
Milestone
   │
   ▼
Requirement
   │
   ├───────────────┐
   ▼               ▼
Decision          Issue
   │               │
   └──────┬────────┘
          ▼
        Symbol
          │
        CALLS
          ▼
        Symbol
          │
    VALIDATED_BY
          ▼
         Test
```

Project Graph는 두 가지 목적으로 사용한다.

1. Coding Agent에게 필요한 Context 탐색
2. 사용자에게 프로젝트 관계 시각화

---

# 9. Context Compiler

DUO의 가장 중요한 기능이다.

기존 Coding Agent의 일반적인 탐색:

```text
Search
→ Read
→ Search
→ Read
→ Search
→ Read
```

DUO에서는:

```text
Task / Git Diff
       ↓
Project Graph
       ↓
Relevant Subgraph
       ↓
Context Compiler
       ↓
Token Budget
       ↓
Coding Agent
```

으로 변경한다.

Context Compiler는 다음 정보를 선택적으로 포함한다.

- Current Task
- Relevant Requirement
- Relevant Decision
- Relevant Symbol
- Relevant Test
- Git Diff
- Issue
- Constraint
- Evidence

---

# 10. Incremental Analysis

DUO는 Repository를 매번 전체 분석하지 않는다.

최초 `duo init`에서 Full Scan을 수행한다.

이후에는 fingerprint와 Git Diff를 이용한다.

```text
Changed Files
     ↓
Changed Symbols
     ↓
Affected Graph
     ↓
Review Context
```

변경되지 않은 영역은 다시 분석하지 않는다.

---

# 11. AI 사용 원칙

DUO는 모든 판단에 LLM을 사용하지 않는다.

우선순위:

```text
Rule
↓
Static Analysis
↓
Git
↓
Tests
↓
External Integration
↓
Graph Retrieval
↓
LLM
```

LLM은 의미 판단이 필요한 경우에만 사용한다.

---

# 12. Director Review

Coding Agent의 작업 후 DUO는 변경사항을 검수한다.

기본 결과:

```text
PASS
WARN
BLOCK
ASK
```

예:

```text
WARN

OAuth implementation is outside the current MVP.

Evidence:
- Requirement AUTH-01
- Decision D-014
- GoogleOAuthService.ts
```

DUO는 근거 없는 0~100 점수를 사용하지 않는다.

---

# 13. Evidence

DUO의 판단에는 항상 근거가 연결된다.

```text
Claim
   ↓
Evidence
   ↓
Verdict
```

Evidence는 다음에서 가져올 수 있다.

- Requirement
- Decision
- Git
- Code
- Test
- Issue
- Document

---

# 14. Decision Lock

사람이 승인한 결정은 Confirmed Decision으로 등록한다.

Confirmed Decision은 AI가 자동 변경할 수 없다.

AI는 변경 필요성을 제안할 수만 있다.

이를 통해 장기 프로젝트에서 Agent가 이전 결정을 임의로 뒤집는 문제를 방지한다.

---

# 15. Knowledge Gap

DUO가 알지 못하는 중요한 정보를 관리한다.

모든 Knowledge Gap을 즉시 사람에게 질문하지 않는다.

현재 작업에 영향을 줄 때만 질문한다.

이 원칙을 통해 AI의 과도한 질문을 줄인다.

---

# 16. MCP

DUO는 MCP Server를 제공한다.

지원 대상 예:

- Codex
- Claude Code
- 기타 MCP 지원 Coding Agent

Coding Agent는 `.duo` 전체를 직접 읽는 대신 DUO MCP를 통해 필요한 정보를 가져간다.

대표 Tool:

```text
get_context
review_changes
get_status
trace
impact
get_requirement
get_decision
search_evidence
```

---

# 17. CLI

초기 CLI:

```text
duo init
duo status
duo context
duo review
duo trace
duo impact
duo stats
duo ui
```

---

# 18. UI

DUO는 Local-first Web UI를 제공한다.

```text
duo ui
```

실행 후 브라우저에서 프로젝트 상태를 확인한다.

초기 주요 화면:

### Overview

프로젝트 목표와 현재 상태.

### Graph

Project Graph 시각화.

### Decisions

확정/대기/폐기 결정.

### Drift

Spec, Decision, Issue와 Code 간 불일치.

### Context

Token 절감과 Context Compiler 동작 상태.

---

# 19. Token Optimization

토큰 최적화는 DUO의 핵심 경쟁력이다.

DUO의 기본 전략은 다음과 같다.

```text
Don't read everything.
Don't ask the LLM everything.
Don't send everything.
```

실제 우선순위:

1. LLM 호출 제거
2. Incremental Scan
3. Symbol localisation
4. Graph traversal
5. Context budget
6. Small model routing
7. Prompt caching
8. Concise output

---

# 20. Token Transparency

사용자는 실제 절감 효과를 확인할 수 있어야 한다.

예:

```text
Repository Estimated Tokens
184,200

Relevant Candidate Tokens
16,820

Director Context
4,730

Reduction
97.4%

LLM Calls
1
```

이를 위해 DUO는 benchmark 기능을 제공한다.

---

# 21. 외부 서비스 Integration

Integration은 DUO Core와 분리한다.

초기 후보:

- Git
- Jira
- GitHub Issues
- Linear
- GitLab Issues

Jira의 경우 JQL을 `.duo`에 저장할 수 있다.

초기 버전에서는 Read-only 연동을 우선한다.

DUO가 Jira 자체를 대체하지 않는다.

---

# 22. 설치 UX

최종적으로 사용자가 직접 복잡한 설정을 할 필요가 없어야 한다.

이상적인 사용 흐름:

```text
사용자:
"이 Repository에 DUO 설치해줘."

Coding Agent:
↓
DUO 설치
↓
duo init
↓
Repository 분석
↓
필요한 정보만 사용자 확인
↓
MCP 설정
↓
Agent bridge 설정
↓
완료
```

사용자는 MCP 설정법이나 `.duo` 내부 구조를 몰라도 사용할 수 있어야 한다.

---

# 23. MVP

DUO v0.1의 범위:

```text
.duo Project Truth Layer
CLI
duo init
Repository Scan
AST Index
Incremental Index
Project Graph
Context Compiler
Evidence
Decision Lock
Knowledge Gap
Git Diff Review
MCP
Codex Integration
Claude Integration
Local Web UI
Token Metrics
```

---

# 24. MVP에서 제외

다음은 초기 버전에서 제외한다.

```text
Vector DB
Neo4j 필수 의존성
Cloud Service
Team Account
Multi-Agent Debate
Jira Write Automation
Kanban
Sprint Management
Chat
Git Client
자동 Source 수정
자동 Spec 수정
```

---

# 25. 핵심 사용자 흐름

DUO MVP의 성공 여부는 다음 하나의 흐름으로 판단한다.

```text
Git Repository
      ↓
DUO 설치
      ↓
duo init
      ↓
Project Intent 자동 추론
      ↓
Human 확인
      ↓
Project Graph 생성
      ↓
Codex / Claude 연결
      ↓
Agent가 DUO에서 Context 요청
      ↓
구현
      ↓
Git Diff
      ↓
DUO Review
      ↓
PASS / WARN / BLOCK / ASK
      ↓
UI에서 Evidence 확인
```

이 흐름이 완성되기 전에는 기능을 추가하지 않는다.

---

# 26. 제품 포지셔닝

DUO는 IDE가 아니다.

DUO는 Jira가 아니다.

DUO는 Coding Agent가 아니다.

DUO는 문서 생성기도 아니다.

DUO는:

> **AI Coding Agent와 프로젝트 사이에 존재하는 Project Direction Layer다.**

Coding Agent가 구현에 집중한다면 DUO는 다음 질문을 담당한다.

> 지금 하고 있는 작업이 정말 우리가 만들려고 했던 것인가?

그리고 이 질문에 답하기 위해 필요한 Context만 제공한다.
