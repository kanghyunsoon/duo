# 충돌, Human 결정, 미결 사항

상태: Draft (T00 2차)

원본 문서([개발 지시문](references/development-directive.md) D§, [기획서](../Duo%20기획서.md) P§) 사이의 충돌과 불명확한 부분, 그에 대한 Human 결정을 기록한다. C 번호는 T00 1차 보고의 번호를 유지한다.

## Human 결정 기록

2026-09-27 Human이 T00 1차 설계안을 검토하고 내린 결정이다. 문서의 출처 표기 **H-n**은 이 표를 가리킨다.

| ID | 결정 | 반영 |
|---|---|---|
| H-1 | Decision 승인은 `duo decision confirm/reject <id>`로 한다. 흐름은 proposed → Human confirm/reject → confirmed lock. YAML 직접 수정은 fallback. UI Decisions 화면에서 Confirm/Reject를 예외적으로 허용. Confirmed Decision의 자동 변경은 계속 금지 | ADR-013, 07, 08 |
| H-2 | MVP 언어는 TypeScript/JavaScript만. Python은 Post-MVP/Stretch. 구조는 `LanguageAnalyzer`로 언어 비종속. CALLS가 이름 기반 heuristic이라는 한계를 문서화 | ADR-003, 04 |
| H-3 | "LLM 호출 0회 기본"이 아니라 Deterministic First. 정해진 의미 판단에만 LLM 사용. 동작하는 Provider 1개 구현. LLM이 없어도 결정적 기능은 전부 동작하고 의미 판단은 UNKNOWN/ASK. 토큰 사용량은 `duo stats`에 기록 | ADR-008, ADR-012, 09 |
| H-4 | UI는 읽기 중심이며 Human Action은 Decision Confirm/Reject만. Confirm 결과는 `.duo/decisions/`에 반영하고 UI 전용 상태를 만들지 않음 | ADR-009, 08 |
| H-5 | 공식 benchmark는 tokenizer 기반. `chars/4`는 UI fallback. 측정 방식을 항상 기록하고 정확한 tokenizer를 쓸 수 없으면 estimated 표시. byte/char 지표 별도 기록 가능 | ADR-005, 09 |
| H-6 | 패키지는 core, analyzer, graph, director, integration, ui 6개. CLI는 얇은 진입점(`apps/cli`)이고 domain 로직을 두지 않음 | ADR-010, 02 |
| H-7 | Git 추적: project.yaml, intent, specs, decisions, milestones, integrations. generated, cache는 ignore. state와 evidence는 장기 추적 근거와 재생성 가능한 runtime evidence를 구분해 재설계하고 ADR에 근거를 기록 | ADR-006, 03 |
| H-8 | Verdict는 두 수준: Claim(ALIGNED, PARTIAL, CONFLICT, UNKNOWN)과 Review(PASS, WARN, BLOCK, ASK). 숫자 점수 금지 | ADR-007 |
| H-9 | ADR 위치는 `docs/adr/`로 통일하고 충돌 사실을 이 문서에 남김 | C1 |
| H-10 | MCP는 조사한 v2 방식 기준으로 설계하고 구현 직전에 공식 문서 재확인. MCP 서버는 Context Gateway이며 Tool을 늘리지 않음 | ADR-004, 06 |
| H-11 | Requirement ID, ADR ID, Task ID를 추적 가능하게 연결하고, 이 관계가 DUO 자체의 Project Graph fixture가 되도록 설계 | ADR-014, 01, TASKS |

## 충돌과 해석

| ID | 내용 | 해석 | 반영 | 상태 |
|---|---|---|---|---|
| C1 | ADR 위치: D§17 `docs/architecture/ADR-xxx.md` vs D§18 `docs/adr/` | `docs/adr/` | adr/ | **Resolved** (H-9) |
| C2 | MCP Tool 이름: D§9는 `duo_` 접두사 9개(propose 포함), P§16은 접두사 없는 8개 | D§9 기준 9개 | 06 | **Resolved** (H-10) |
| C3 | Graph 목적: D§4 "시각화가 아니라 Localisation" vs P§8 "탐색과 시각화" | Localisation이 주목적, UI Graph는 보조 | 04, 08 | Proposed |
| C4 | UI 역할: P§7 "표현하고 수정하는 View" vs Human-owned·Decision Lock 원칙 | 읽기 중심 + Decision Confirm/Reject | 08, ADR-009 | **Resolved** (H-4) |
| C5 | Decision 승인 경로가 D§11 최소 CLI에 없음 | `duo decision confirm/reject` + UI, 파일 수정은 fallback | ADR-013 | **Resolved** (H-1) |
| C6 | Verdict 체계 두 가지 | 두 수준으로 분리 | ADR-007 | **Resolved** (H-8) |
| C7 | LLM 정책: "LLM 최소화"와 규칙만으로 Scope Drift를 판단하기 어려운 문제 | Deterministic First, 의미 판단만 LLM, Provider 1종, 없으면 UNKNOWN/ASK | ADR-008, ADR-012 | **Resolved** (H-3), Provider 선택은 ADR-012 Proposed |
| C8 | Jira가 Post-MVP인데 Issue Node와 Issue ↔ Code Drift가 MVP에 있음 | MVP Issue 출처는 milestones/*.yaml, Markdown `type: issue`, 커밋 메시지 키 | 03, 04 | Proposed |
| C9 | "Agent는 .duo 수정 금지"를 기술적으로 강제할 수 없음 | 탐지 기반(lock digest, HEAD 기준선, R-LOCK) + Agent instruction + TTY 요구 | 10 | Proposed |
| C10 | MVP AST 대상 언어 미정 | TS/JS, LanguageAnalyzer 인터페이스 | ADR-003 | **Resolved** (H-2) |
| C11 | "Test 성공 여부" 판정을 위해 테스트를 실행해야 하는가 | 기본 실행하지 않음. `test_command` 설정 + `--run-tests`일 때만 | 03, 07, 10 | Proposed |
| C12 | 절감률 계산 기준 미정 | o200k_base 공식 측정, 방식 기록, Coverage 병기 | ADR-005, 09 | **Resolved** (H-5) |
| C13 | state/evidence/generated의 Git 관리 | Definition, Review Record, Derived, Cache, Runtime 5분류 | ADR-006 | 방향은 **Resolved** (H-7), 구체안은 ADR-006 Proposed |
| C14 | Constraint가 D§4 초기 Node Type 8종에 없음 | Decision Node(`kind: constraint`)로 표현 | 03, 04 | Proposed |
| C15 | D§4 예시 `GAME-42 TRACKED_BY AUTH-03`의 방향이 의미와 반대 | 정규 방향 Requirement → Issue | 04 | Proposed |
| C16 | `duo decision`, `duo install`, `duo mcp`가 D§11 최소 목록에 없음 | H-1, D§10, D§9 요구를 위해 포함 | 07 | Proposed(decision은 H-1로 확정) |
| C17 | D§3 "Project Intent 초안 생성"과 결정적 분석의 긴장: 규칙만으로 만든 초안은 빈약할 수 있음 | H-3의 LLM 허용 목록에 Intent 초안이 없으므로 MVP는 결정적 초안 + UNKNOWN 질문 | ADR-008 | Proposed |
| C18 | 같은 OAuth 예시가 D§6에서는 CONFLICT, P§12에서는 WARN | Claim은 CONFLICT, Verdict는 Constraint `enforcement`(warn/block)로 결정 | ADR-007, 03 | Proposed |
| C19 | D§2의 `.duo` 디렉터리 목록(state/, evidence/)이 ADR-006 구조(reviews/, generated/, cache/, runtime/)와 다름 | H-7 재설계 요구에 따른 변경 | ADR-006, 03 | Proposed |
| C20 | D§4 Edge 표에는 Decision → Issue GOVERNS, Issue → Issue REQUIRES가 없음 | Edge Type은 그대로 두고 허용 endpoint만 넓힘(ADR ↔ Task 추적용) | 04, ADR-014 | Proposed |
| C21 | D§2 "Source of Truth는 .duo"와 `sources.markdown`으로 .duo 밖 문서(docs/)를 정의 소스로 읽는 것의 긴장 | 외부 Markdown은 읽기 전용이며 명시적으로 등록해야 함. 기본값은 .duo만 | 03, ADR-014 | Proposed |
| C22 | D§12 예시의 "LLM Calls 1"과 Context Packet 생성의 LLM 미사용 | Context 생성은 항상 0. LLM 호출은 Review 의미 판정에서만 생기며 해당 지표에 표시 | 09 | Proposed |

## 미결 사항

| ID | 질문 | 선택지 | 현재 기본안 |
|---|---|---|---|
| Q-A | ADR-001(TypeScript + Node 24)과 ADR-002(node:sqlite)를 확정할까? ADR-004, 009, 010이 이미 이를 전제로 한다 | 확정 / 수정 | Proposed, 확정 요청 |
| Q-B | ADR-006의 5분류와 디렉터리 구조(reviews/, generated/, cache/, runtime/), `reviews/` 기본 tracked | 확정 / 수정 | Proposed |
| Q-C | ADR-012 MVP Provider로 OpenAI 호환 Chat Completions 1종 | 확정 / 다른 Provider | Proposed |
| Q-D | ADR-014 ID 체계와 `sources.markdown`(self fixture용 외부 Markdown 읽기) | 확정 / 수정 | Proposed |
| Q-E | ADR-011 Agent 설정 형식(공식 문서 확인 필요) | TASK-017 착수 시 확인 | 검증 대기 |
| Q3 | 배포 패키지 이름과 라이선스 | npm 이름 후보: `duo`(선점 여부 확인 필요), `@duo-dev/cli` 등 / MIT 또는 Apache-2.0 | 미정, 공개 전 결정 |
| Q4 | 저장소 공개 시점 | 지금 / v0.1 이후 | 현재 private |
