# 01. Requirements

상태: Draft · 출처 표기: **D§n** = [개발 지시문](references/development-directive.md) n절, **P§n** = [기획서](../Duo%20기획서.md) n절

## 기능 요구사항 (MVP, v0.1)

| ID | 요구사항 | 출처 | 상세 |
|---|---|---|---|
| FR-01 | `duo init`은 Repository에 `.duo/` Project Truth Layer를 생성한다 | D§2, P§6 | [03](03-data-model.md) |
| FR-02 | `duo init`은 구조, README/docs, manifest, Git metadata, source file, AST symbol, dependency, 기존 기획 문서를 일반 코드로 분석한다. Repository 전체를 LLM에 전달하지 않는다 | D§3 | [02](02-system-architecture.md) |
| FR-03 | `duo init`은 Project Intent 초안, 현재 구현 상태 추론, Knowledge Gap을 생성한다. 근거 없는 Requirement를 지어내지 않는다 | D§3 | [03](03-data-model.md) |
| FR-04 | `duo init`은 Human Intent 확인 단계를 가진다. TTY에서는 대화형으로 묻고, 비대화형(Agent 실행)에서는 질문 목록을 ASK로 출력한다 | D§22, P§25 | [07](07-cli-interface.md) |
| FR-05 | Project Graph는 Node 8종(Project, Milestone, Requirement, Decision, Issue, File, Symbol, Test)과 Edge 9종(CONTAINS, REQUIRES, IMPLEMENTS, CALLS, IMPORTS, GOVERNS, TRACKED_BY, VALIDATED_BY, CHANGED_WITH)을 embedded SQLite에 저장한다 | D§4, P§8 | [04](04-project-graph.md) |
| FR-06 | 최초 init 이후에는 fingerprint와 Git diff로 변경 파일만 다시 분석한다. 변경되지 않은 파일은 parse하지 않는다 | D§5, P§10 | [04](04-project-graph.md) |
| FR-07 | Context Compiler는 Task, Git Diff, Graph, 관련 Requirement/Decision/Issue/Test를 입력으로 받아 token budget 이하의 Director Context Packet을 만든다 | D§3, P§9 | [05](05-context-compiler.md) |
| FR-08 | Context 생성마다 Repository/Candidate/Loaded 토큰, 고려·로드 파일 수, LLM 호출 수를 기록한다 | D§12, D§21 | [09](09-token-strategy.md) |
| FR-09 | `duo review`는 Git diff → 변경 파일 → 변경 Symbol → 영향 Subgraph → Claim → Verdict 순서로 검수한다 | D§5, P§12 | [05](05-context-compiler.md), [02](02-system-architecture.md) |
| FR-10 | 모든 Claim은 하나 이상의 Evidence 참조(Requirement, Decision, Constraint, File, Symbol, Commit, Test, Issue, Document, Diff)를 가진다. Review 결과는 `.duo/evidence/`에 저장한다 | D§6, P§13 | [03](03-data-model.md) |
| FR-11 | Review Verdict는 PASS/WARN/BLOCK/ASK, Claim Alignment는 ALIGNED/PARTIAL/CONFLICT/UNKNOWN만 사용한다. 수치 점수를 쓰지 않는다 | D§6, P§12 | [ADR-007](adr/ADR-007-verdict-model.md) |
| FR-12 | Confirmed Decision은 DUO와 Agent가 변경할 수 없다(Decision Lock). 변경은 Superseding 제안까지만 가능하며, 확정은 Human이 한다 | D§7, P§14 | [03](03-data-model.md) |
| FR-13 | Knowledge Gap을 기록하되, 현재 Task의 Subgraph에 영향을 줄 때만 ASK로 노출한다 | D§8, P§15 | [05](05-context-compiler.md) |
| FR-14 | Scope Drift(연결된 Requirement가 없는 추가, Constraint 위반)를 감지한다 | D§1 | [ADR-007](adr/ADR-007-verdict-model.md) |
| FR-15 | Spec/Decision/Issue ↔ Code 불일치(Drift)를 감지한다 | D§12 | [08](08-ui-spec.md) |
| FR-16 | MCP Server(stdio)는 Tool 9종을 제공한다: duo_get_context, duo_review_changes, duo_get_status, duo_get_requirement, duo_get_decision, duo_trace, duo_impact, duo_search_evidence, duo_propose_decision | D§9 | [06](06-mcp-interface.md) |
| FR-17 | `duo install codex`, `duo install claude`는 MCP 설정과 짧은 Agent instruction(AGENTS.md, CLAUDE.md)을 설정한다. Repository Context를 startup prompt에 넣지 않는다 | D§10, P§22 | [ADR-011](adr/ADR-011-agent-integration.md) |
| FR-18 | CLI: init, status, context, review, trace, impact, stats, ui, install, mcp | D§11 | [07](07-cli-interface.md) |
| FR-19 | `duo ui`는 127.0.0.1:7346에 읽기 전용 Web UI(Overview, Graph, Decisions, Drift, Context)를 띄운다 | D§12, P§18 | [08](08-ui-spec.md) |
| FR-20 | 외부 근거는 EvidenceProvider 인터페이스로 Core와 분리한다. MVP는 Git Provider만 구현한다 | D§13 | [02](02-system-architecture.md) |
| FR-21 | LLM 사용은 LLMProvider 인터페이스로 추상화한다. MVP 기본값은 LLM 미사용이다 | D§14, D§15 | [ADR-008](adr/ADR-008-llm-policy.md) |
| FR-22 | 재현 가능한 benchmark가 D§21의 지표와 Ground-truth Coverage를 기록한다 | D§21, P§20 | [09](09-token-strategy.md), [11](11-testing-strategy.md) |
| FR-23 | DUO는 프로젝트 Source Code를 수정하지 않는다. DUO가 쓰는 파일은 `.duo/` 내부와 `duo install`이 명시적으로 설정하는 Agent 설정 파일뿐이다 | D§1 | [10](10-security.md) |

## 비기능 요구사항

| ID | 요구사항 |
|---|---|
| NFR-01 | Windows, macOS, Linux에서 동일하게 동작한다. 내부 경로는 Repository 기준 POSIX 상대경로로 정규화한다 |
| NFR-02 | Local-first. 기본 설정에서 네트워크 호출, telemetry, Cloud 저장소가 없다 |
| NFR-03 | 네이티브 컴파일 없이 `npm` 계열 한 줄로 설치된다. 장기적으로 단일 binary를 지향한다([ADR-010](adr/ADR-010-packaging.md)) |
| NFR-04 | 성능 초기 목표(benchmark로 검증 후 확정): 소스 1만 파일 init 60초 이내, 변경 20파일 이하 증분 인덱싱 2초 이내, `duo context` 1초 이내 |
| NFR-05 | 결정적 출력: 같은 입력(Graph, Task, budget)은 같은 Packet을 만든다. 정렬 기준을 항상 명시한다 |
| NFR-06 | Packet은 token budget을 절대 넘지 않는다 |
| NFR-07 | Human-owned 정보는 사람이 읽고 고칠 수 있는 Markdown/YAML이다. `generated/`와 `state/`는 삭제 후 재생성할 수 있다 |
| NFR-08 | 기본 출력은 간결하다. 상세 정보는 `--verbose` 또는 `--json`으로 얻는다 |
| NFR-09 | MCP stdio 서버는 stdout에 JSON-RPC 메시지 외의 것을 쓰지 않는다 |

## MVP 제외 (v0.1)

두 원본 문서의 제외 목록을 합친 것이다. 필요성이 검증되면 별도 Spec을 작성한 뒤 추가한다.

Vector Database, Neo4j 필수 설치, Multi-Agent 토론, Cloud Account/Dashboard, Team Chat, Kanban, Sprint Manager, Jira 대체 기능, Jira Write, Git GUI/Client, 자동 Source Code 수정, 자동 Requirement/Spec 수정, 자동 Confirmed Decision 변경, Jira Issue 삭제.

## Post-MVP 후보

| ID | 내용 | 조건 |
|---|---|---|
| FR-P1 | Jira Read-only 연동, JQL은 `.duo/integrations/jira.yaml` | Core E2E 안정화 후 |
| FR-P2 | GitHub Issues, Linear, GitLab Issues Provider | FR-P1 이후 |
| FR-P3 | 실제 LLMProvider 구현과 의미 판정(semantic review) | benchmark로 규칙 기반 판정의 한계가 확인된 후 |
| FR-P4 | TS/JS 외 언어 Adapter | [conflicts.md Q2](conflicts.md) 결정 |
| FR-P5 | UI에서 `.duo` 편집 | Decision Lock과 승인 흐름 확정 후 |
| FR-P6 | 테스트 결과 수집(JUnit XML 등) | Review 규칙 안정화 후 |

## 인수 기준 (v0.1)

[11-testing-strategy.md](11-testing-strategy.md)의 E2E 시나리오가 3개 OS CI에서 통과하고, benchmark 보고서가 저장소에 커밋되어 있어야 한다.
