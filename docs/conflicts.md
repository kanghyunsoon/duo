# 충돌, Human 결정, 미결 사항

상태: **Frozen** (T00 final, 2026-09-27)

원본 문서([개발 지시문](references/development-directive.md) D§, [기획서](../Duo%20기획서.md) P§) 사이의 충돌과 불명확한 부분, 그리고 그에 대한 Human 결정을 기록한다. C 번호는 T00 1차 보고의 번호를 유지한다.

T00 동결 시점에 **Proposed** 상태인 해석은 구현 기본값으로 적용한다. 구현 중 문제가 드러나면 한쪽을 임의로 고치지 않고 이 문서에 기록한 뒤 Human 결정을 받는다.

## Human 결정 기록

문서의 출처 표기 **H-n**은 이 표를 가리킨다.

| ID | 날짜 | 결정 | 반영 |
|---|---|---|---|
| H-1 | 2026-09-27 | Decision 승인은 `duo decision confirm/reject <id>`. 흐름은 proposed → Human confirm/reject → confirmed lock. YAML 직접 수정은 fallback. UI Decisions 화면의 Confirm/Reject는 예외적으로 허용. Confirmed Decision의 자동 변경은 계속 금지 | ADR-013, 07, 08 |
| H-2 | 2026-09-27 | MVP 언어는 TypeScript/JavaScript만. Python은 Post-MVP/Stretch. `LanguageAnalyzer`로 언어 비종속. CALLS가 이름 기반 heuristic이라는 한계를 문서화 | ADR-003, 04 |
| H-3 | 2026-09-27 | Deterministic First. 정해진 의미 판단에만 LLM을 쓴다. 동작하는 Provider 1개를 구현한다. LLM이 없어도 결정적 기능은 전부 동작하고 의미 판단은 UNKNOWN/ASK. 토큰 사용량은 `duo stats`에 기록 | ADR-008, ADR-012, 09 |
| H-4 | 2026-09-27 | UI는 읽기 중심, Human Action은 Decision Confirm/Reject만. 결과는 `.duo/decisions/`에 반영하고 UI 전용 상태를 만들지 않음 | ADR-009, 08 |
| H-5 | 2026-09-27 | 공식 benchmark는 tokenizer 기반. `chars/4`는 UI fallback. 측정 방식을 항상 기록하고, 정확한 tokenizer가 없으면 estimated 표시. byte/char 지표 별도 기록 가능 | ADR-005, 09 |
| H-6 | 2026-09-27 | 패키지는 core, analyzer, graph, director, integration, ui 6개. CLI는 얇은 진입점(`apps/cli`)이며 domain 로직을 두지 않음 | ADR-010, 02 |
| H-7 | 2026-09-27 | Git 추적과 ignore 대상 지정. state와 evidence는 장기 추적 근거와 재생성 가능한 runtime evidence를 구분해 재설계 | ADR-006, 03 |
| H-8 | 2026-09-27 | Verdict 두 수준: Claim(ALIGNED, PARTIAL, CONFLICT, UNKNOWN), Review(PASS, WARN, BLOCK, ASK). 숫자 점수 금지 | ADR-007 |
| H-9 | 2026-09-27 | ADR 위치는 `docs/adr/`로 통일하고 충돌 사실을 이 문서에 남김 | C1 |
| H-10 | 2026-09-27 | MCP는 v2 기준으로 설계하고 구현 직전에 공식 문서를 재확인. MCP 서버는 Context Gateway이며 Tool을 늘리지 않음 | ADR-004, 06 |
| H-11 | 2026-09-27 | Requirement, ADR, Task ID를 추적 가능하게 연결하고 DUO 자체의 Project Graph fixture가 되도록 설계 | ADR-014, 01, TASKS |
| H-12 | 2026-09-27 | ADR-001 확정: TypeScript + Node.js 24, ESM, pnpm workspace, 최소 `>=24.15.0`, CI 기준 Node 24, 최신 patch에 고정하지 않음 | ADR-001 |
| H-13 | 2026-09-27 | ADR-002 확정: `GraphStore` → `NodeSqliteGraphStore` → `node:sqlite`. graph 패키지 밖 직접 import 금지, storage 전용 API 비노출, `graph_schema_version`을 처음부터 두되 범용 migration framework는 만들지 않음 | ADR-002, 03 |
| H-14 | 2026-09-27 | ADR-006 수정 확정: Project Truth(tracked), Human-approved History `reviews/`(tracked, Human이 보존하거나 승인한 Review만, Evidence Pointer만 저장), Regenerable/Runtime `generated/` `cache/` `runtime/`(ignored) | ADR-006, 03 |
| H-15 | 2026-09-27 | ADR-012 수정 확정: MVP 실제 Provider는 OpenAI Responses API 1종(`OpenAIResponsesProvider`). 계약은 Provider 비종속. 기존 12번 Task를 TASK-012A(계약, no-op)와 TASK-012B(Responses Adapter, Context/Review 계약 안정 후)로 분리 | ADR-012, TASKS |
| H-16 | 2026-09-27 | ADR-014 수정 확정: `.duo`가 유일한 Project Truth. `sources.markdown` 등 외부 문서는 External Evidence/Input Source이며 init 이해, draft, Review 근거, Drift 탐지에만 사용. 외부 변경은 `.duo`를 자동 변경하지 않고 Drift로 보고. provenance는 `{path, hash}` 수준 | ADR-014, 03, ADR-007 |
| H-17 | 2026-09-27 | ADR-011은 미결 유지. MCP Core는 v2 기준으로 진행하고, Codex/Claude 설정 변경은 TASK-017 직전에 공식 문서로 확인. Core 설계를 Adapter 설정에 종속시키지 않음 | ADR-011 |
| H-19 | 2026-09-27 | T02 범위: `@duo/core`의 Core Data Contract(스키마, domain model, YAML loader, Markdown metadata parser, 추적성 파서, diagnostics, fixture, 검증)만. YAML은 `yaml` 2.x `parseDocument()`, Markdown은 `mdast-util-from-markdown` + frontmatter 확장(remark/unified 없음). 원문 파싱과 domain 분리, `schema_version`, strict schema + `extensions`, 오류를 diagnostic으로 수집, POSIX 저장소 경로, `EntityRef` 식별자 계약, docs validator는 core parser 사용. 이름 공간은 Q-NAMESPACE로 기록하고 상수로 관리 | ADR-014, 03, core |
| H-18 | 2026-09-27 | T00 동결. Requirement, ADR, Task, AC를 더 세분화하지 않는다. 새 Requirement/ADR은 구현 중 필요가 발견될 때만 추가. 다음 단계는 T01 Repository Skeleton | 전체 |

## 충돌과 해석

| ID | 내용 | 해석 | 반영 | 상태 |
|---|---|---|---|---|
| C1 | ADR 위치: D§17 `docs/architecture/ADR-xxx.md` vs D§18 `docs/adr/` | `docs/adr/` | adr/ | **Resolved** (H-9) |
| C2 | MCP Tool 이름: D§9는 `duo_` 접두사 9개(propose 포함), P§16은 접두사 없는 8개 | D§9 기준 9개 | 06 | **Resolved** (H-10) |
| C3 | Graph 목적: D§4 "시각화가 아니라 Localisation" vs P§8 "탐색과 시각화" | Localisation이 주목적, UI Graph는 보조 | 04, 08 | Proposed |
| C4 | UI 역할: P§7 "표현하고 수정하는 View" vs Human-owned·Decision Lock 원칙 | 읽기 중심 + Decision Confirm/Reject | 08, ADR-009 | **Resolved** (H-4) |
| C5 | Decision 승인 경로가 D§11 최소 CLI에 없음 | `duo decision confirm/reject` + UI, 파일 수정은 fallback | ADR-013 | **Resolved** (H-1) |
| C6 | Verdict 체계 두 가지 | 두 수준으로 분리 | ADR-007 | **Resolved** (H-8) |
| C7 | LLM 정책: "LLM 최소화"와 규칙만으로 Scope Drift를 판단하기 어려운 문제 | Deterministic First, 의미 판단만 LLM, OpenAI Responses Provider 1종, 없으면 UNKNOWN/ASK | ADR-008, ADR-012 | **Resolved** (H-3, H-15) |
| C8 | Jira가 Post-MVP인데 Issue Node와 Issue ↔ Code Drift가 MVP에 있음 | MVP Issue 출처는 milestones의 로컬 Issue, Markdown `type: issue`, 커밋 메시지 키 | 03, 04 | Proposed |
| C9 | "Agent는 .duo 수정 금지"를 기술적으로 강제할 수 없음 | 탐지 기반(lock digest, HEAD 기준선, R-LOCK) + Agent instruction + TTY 요구 | 10 | Proposed |
| C10 | MVP AST 대상 언어 미정 | TS/JS, LanguageAnalyzer 인터페이스 | ADR-003 | **Resolved** (H-2) |
| C11 | "Test 성공 여부" 판정을 위해 테스트를 실행해야 하는가 | 기본 실행하지 않음. `test_command` 설정 + `--run-tests`일 때만 | 03, 07, 10 | Proposed |
| C12 | 절감률 계산 기준 미정 | o200k_base 공식 측정, 방식 기록, Coverage 병기 | ADR-005, 09 | **Resolved** (H-5) |
| C13 | state/evidence/generated의 Git 관리 | Project Truth, Human-approved History, Regenerable/Runtime 3분류 | ADR-006 | **Resolved** (H-7, H-14) |
| C14 | Constraint가 D§4 초기 Node Type 8종에 없음 | Decision Node(`kind: constraint`)로 표현 | 03, 04 | Proposed |
| C15 | D§4 예시 `GAME-42 TRACKED_BY AUTH-03`의 방향이 의미와 반대 | 정규 방향 Requirement → Issue | 04 | Proposed |
| C16 | `duo decision`, `duo install`, `duo mcp`가 D§11 최소 목록에 없음 | H-1, D§10, D§9 요구를 위해 포함 | 07 | decision은 **Resolved** (H-1), install/mcp는 Proposed |
| C17 | D§3 "Project Intent 초안 생성"과 결정적 분석의 긴장 | H-3의 LLM 허용 목록에 Intent 초안이 없으므로 MVP는 결정적 초안 + UNKNOWN 질문 | ADR-008 | Proposed |
| C18 | 같은 OAuth 예시가 D§6에서는 CONFLICT, P§12에서는 WARN | Claim은 CONFLICT, Verdict는 Constraint `enforcement`(warn/block)로 결정 | ADR-007, 03 | Proposed |
| C19 | D§2의 `.duo` 디렉터리 목록(state/, evidence/)과 ADR-006 구조가 다름 | reviews/, generated/, cache/, runtime/ | ADR-006, 03 | **Resolved** (H-14) |
| C20 | D§4 Edge 표에는 Decision → Issue GOVERNS, Issue → Issue REQUIRES가 없음 | Edge Type은 그대로 두고 허용 endpoint만 넓힘(ADR ↔ Task 추적용) | 04, ADR-014 | Proposed |
| C21 | "Source of Truth는 .duo"와 .duo 밖 문서를 정의 소스로 읽는 것의 긴장 | 외부 문서는 External Evidence/Input Source. self fixture는 docs/를 임시 .duo로 복사해 사용 | 03, ADR-014 | **Resolved** (H-16) |
| C22 | D§12 예시의 "LLM Calls 1"과 Context Packet 생성의 LLM 미사용 | Context 생성은 항상 0. LLM 호출은 Review 의미 판정에서만 생기며 해당 지표에 표시 | 09 | Proposed |
| C23 | 12번 Task 분리로 생긴 `TASK-012A` 형식이 기존 ID 정규식(`-\d+`로 끝남)과 맞지 않음 | ID 정규식에 선택적 알파벳 접미사 허용(`-\d+[A-Z]?`), AC는 `AC-NNN[A-Z]?-NN` | ADR-014, 03 | **Resolved** (H-15의 결과) |
| C24 | ADR-010은 배포 번들러를 TASK-001에서 고른다고 했으나, T01 범위(H-18 이후 지시)는 workspace, TypeScript, Vitest, Lint, skeleton, 경계, CI, 기본 build/test로 한정됨 | T01은 `tsc -b` 빌드만 둔다. 번들러는 배포 산출물이 필요한 시점(TASK-017 또는 TASK-020 전)에 고르고 ADR-010에 기록 | ADR-010 | Proposed |
| C25 | TASK-001의 "Files expected to change"와 실제 변경 차이: `eslint.config.js`, `tsconfig.json`(테스트 포함 typecheck), `tsconfig.build.json`(빌드 solution), `scripts/boundaries.json`, `scripts/check-boundaries.mjs`, `tests/workspace/`가 추가됨. TypeScript는 7.0이 나왔지만 typescript-eslint 8.70이 `<6.1.0`만 지원해 `~6.0.3`으로 고정 | 경계 강제(AC-001-02)와 테스트 typecheck에 필요한 파일. TypeScript 7 전환은 lint 도구 지원 후 별도 검토 | TASKS, ADR-001 | Proposed |
| C26 | TASK-002 AC-002-04(fs-guard가 허용 경로 밖 쓰기를 거부)가 H-19의 T02 범위 목록에 없음 | T02에서 구현하지 않음. 파일 쓰기가 처음 생기는 TASK-009(DecisionService) 또는 TASK-014(init) 전에 구현. TASK-002는 AC-002-04를 남겨 둔 채 `review` | TASKS | Proposed |
| C27 | 03 문서에 없던 Core 계약 세부: (1) 모든 스키마가 strict이고 사용자 데이터는 `extensions`에만 둠 (2) `schema_version`은 `project.yaml`에만 있고 `.duo` 전체에 적용 (3) YAML은 core schema, 명시적 tag·anchor·alias·merge key 금지 (4) Markdown 정의는 정규식이 아닌 mdast 구조로 읽으며, 2~4수준 Heading 바로 다음 블록이 metadata block일 때만 정의 (5) `specs/`, `decisions/`, `milestones/`의 Markdown은 폴더와 관계없이 같은 규칙으로 읽음 (6) ID Heading 뒤에 metadata block이 없으면 `METADATA_BLOCK_MISSING` 경고 | 구현 기준으로 적용. 03 문서 반영은 문서 갱신 시점에 | 03, core | Proposed |
| C28 | 03의 `UNKNOWN:` 줄(Knowledge Gap)은 T02 파서가 해석하지 않음. Markdown 본문은 `description`과 `texts`로만 보존 | Gap 탐지는 TASK-011 | 03, TASKS | Proposed |
| C29 | "Requirement에 Task가 없음"은 사용자 프로젝트에서는 흔한 상태라 core 기본 심각도는 info. 이 저장소 docs validator만 정책으로 error로 올림(`requireTrackedRequirements`) | 규칙은 core 한 곳, 심각도만 호출 측 정책 | core, scripts | Proposed |

## 미결 사항

| ID | 질문 | 현재 기본안 |
|---|---|---|
| Q-NAMESPACE | DUO, `duo` 실행 파일, `.duo/` 이름이 외부 AI coding 도구와 충돌할 수 있음. 공개 배포 구조가 굳기 전에 확정. 검토 대상: 제품 표시 이름, npm 패키지 이름, CLI 실행 파일, 프로젝트 상태 디렉터리, MCP 서버 이름 | 현재 이름 유지. 코드에서는 `packages/core/src/constants.ts`(`PRODUCT_NAME`, `CLI_NAME`, `STATE_DIR_NAME`, `MCP_SERVER_NAME`, `METADATA_BLOCK_LANG`)만 바꾸면 됨. 상수 밖에 남은 이름: 패키지 scope `@duo/*`, `apps/cli/package.json`의 bin `duo`, export 조건 `@duo/source`, 문서 |
| Q-E | ADR-011 Codex/Claude Code 설정 형식 | TASK-017 착수 직전에 공식 문서로 확인 (H-17) |
| Q3 | 배포 패키지 이름과 라이선스 | 미정. 공개 전에 결정 |
| Q4 | 저장소 공개 시점 | 현재 private |

## 해결된 미결 사항

| ID | 질문 | 결정 |
|---|---|---|
| Q-A | ADR-001, ADR-002 확정 여부 | 확정 (H-12, H-13) |
| Q-B | ADR-006 구조 | 3분류로 수정 확정 (H-14) |
| Q-C | ADR-012 MVP Provider | OpenAI Responses API로 수정 확정 (H-15) |
| Q-D | ADR-014 ID 체계와 외부 Markdown | External Evidence로 수정 확정 (H-16) |
