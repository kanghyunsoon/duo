# 충돌, Human 결정, 미결 사항

상태: **Frozen** (T00 final, 2026-09-27)

원본 문서([개발 지시문](references/development-directive.md) D§, [기획서](../Duo%20기획서.md) P§) 사이의 충돌과 불명확한 부분, 그리고 그에 대한 Human 결정을 기록한다. C 번호는 T00 1차 보고의 번호를 유지한다.

T00 동결 시점에 **Proposed** 상태인 해석은 구현 기본값으로 적용한다. 구현 중 문제가 드러나면 한쪽을 임의로 고치지 않고 이 문서에 기록한 뒤 Human 결정을 받는다.

## Human 결정 기록

문서의 출처 표기 **H-n**은 이 표를 가리킨다.

| ID | 날짜 | 결정 | 반영 |
|---|---|---|---|
| H-1 | 2026-09-27 | Decision 승인은 `duoctl decision confirm/reject <id>`. 흐름은 proposed → Human confirm/reject → confirmed lock. YAML 직접 수정은 fallback. UI Decisions 화면의 Confirm/Reject는 예외적으로 허용. Confirmed Decision의 자동 변경은 계속 금지 | ADR-013, 07, 08 |
| H-2 | 2026-09-27 | MVP 언어는 TypeScript/JavaScript만. Python은 Post-MVP/Stretch. `LanguageAnalyzer`로 언어 비종속. CALLS가 이름 기반 heuristic이라는 한계를 문서화 | ADR-003, 04 |
| H-3 | 2026-09-27 | Deterministic First. 정해진 의미 판단에만 LLM을 쓴다. 동작하는 Provider 1개를 구현한다. LLM이 없어도 결정적 기능은 전부 동작하고 의미 판단은 UNKNOWN/ASK. 토큰 사용량은 `duoctl stats`에 기록 | ADR-008, ADR-012, 09 |
| H-4 | 2026-09-27 | UI는 읽기 중심, Human Action은 Decision Confirm/Reject만. 결과는 `.duo-project/decisions/`에 반영하고 UI 전용 상태를 만들지 않음 | ADR-009, 08 |
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
| H-16 | 2026-09-27 | ADR-014 수정 확정: `.duo-project`가 유일한 Project Truth. `sources.markdown` 등 외부 문서는 External Evidence/Input Source이며 init 이해, draft, Review 근거, Drift 탐지에만 사용. 외부 변경은 `.duo-project`를 자동 변경하지 않고 Drift로 보고. provenance는 `{path, hash}` 수준 | ADR-014, 03, ADR-007 |
| H-17 | 2026-09-27 | ADR-011은 미결 유지. MCP Core는 v2 기준으로 진행하고, Codex/Claude 설정 변경은 TASK-017 직전에 공식 문서로 확인. Core 설계를 Adapter 설정에 종속시키지 않음 | ADR-011 |
| H-19 | 2026-09-27 | T02 범위: `@duo-director/core`의 Core Data Contract(스키마, domain model, YAML loader, Markdown metadata parser, 추적성 파서, diagnostics, fixture, 검증)만. YAML은 `yaml` 2.x `parseDocument()`, Markdown은 `mdast-util-from-markdown` + frontmatter 확장(remark/unified 없음). 원문 파싱과 domain 분리, `schema_version`, strict schema + `extensions`, 오류를 diagnostic으로 수집, POSIX 저장소 경로, `EntityRef` 식별자 계약, docs validator는 core parser 사용. 이름 공간은 Q-NAMESPACE로 기록하고 상수로 관리 | ADR-014, 03, core |
| H-20 | 2026-09-27 | T02.1: 표시 이름은 DUO 유지. 기술 식별자는 CLI `duoctl`, 상태 디렉터리 `.duo-project`, MCP 서버 `duo-director`, workspace scope `@duo-director/*`(npm publish 가능 여부는 배포 단계에서 재확인). 그 밖에 AC-002-04 write boundary 정책, Symbol Node ID 가역 escaping, 경로 철자 보존과 `PATH_PORTABILITY_COLLISION`, Issue 정의 위치 단일화(Milestone은 참조만), YAML 끝 위치 계산, `SUPERSEDES` 관계 추가, 03 문서 동기화(C27) | core, 03, 04 |
| H-18 | 2026-09-27 | T00 동결. Requirement, ADR, Task, AC를 더 세분화하지 않는다. 새 Requirement/ADR은 구현 중 필요가 발견될 때만 추가. 다음 단계는 T01 Repository Skeleton | 전체 |
| H-21 | 2026-09-27 | T04 정책. (1) stale은 GraphStore 책임이 아니다: GraphStore는 contentHash/source 저장, Scanner는 현재 fingerprint, Indexer는 비교, Freshness는 fresh/changed/deleted/unknown 판정. WAL 읽기는 snapshot visibility(C31). (2) TASK-004는 file discovery와 cross-platform fingerprint만: Git이 canonical path source(tracked는 index 철자, untracked는 파일 시스템 철자, 둘 다 `PATH_PORTABILITY_COLLISION`), `tracked \| untracked`, ignored와 `.git/` 제외, batch Git 호출, symlink 비추적, text는 CRLF → LF만 정규화한 SHA-256, binary는 raw SHA-256, 확장자 기반 분류, `gitBlobOid`는 provenance, fingerprint는 graph.db가 아닌 `generated/fingerprints.json`, mtime 비권위, UNCHANGED/CHANGED/ADDED/DELETED 비교 primitive. (3) UTF-8 byte 순 공통 comparator. (4) Tokenizer 선택은 TASK-010 또는 TASK-019 착수 전, o200k_base 기준은 유지. (5) GraphNode payload schema는 TASK-007 | 03, 04, ADR-002, ADR-005, ADR-006, TASKS, analyzer, core, graph |
| H-22 | 2026-09-27 | T04.1: DUO MVP는 Git 저장소 필수(`GIT_REPOSITORY_REQUIRED`, init은 TASK-014), `kind` → `fingerprintMode: normalized-text \| raw`(MIME/언어 지원과 별개, EOL 보장은 normalized-text에만), symlink ↔ 일반 파일 타입 변경을 `FILE_TYPE_CHANGED`로 보고(대상 비추적), `gitBlobOid`는 index 기준 유지. T05: web-tree-sitter + 공식 grammar 패키지 WASM(제3자 묶음·커밋 금지), 확장자 매핑(.ts/.mts/.cts, .tsx, .js/.mjs/.cjs/.jsx), 실제 load/parse smoke test를 CI에서, LanguageAnalyzer → SourceAnalysis(Symbols, Module References, Call Sites, DUO annotations, parse status), Tree-sitter 타입 비노출, runtime 1회·grammar 1회·tree 해제, Symbol 범위와 qualified name, overload 한 Symbol, 익명 default는 `default`, literal specifier만, CallSite는 syntax 사실만(resolution은 TASK-007), comment 노드의 `duo:`만, partial parse, UTF-16 위치와 CRLF, compareUtf8 정렬 | 03, 04, ADR-003, TASKS, analyzer, core |
| H-23 | 2026-09-27 | T05.1: Test 정의는 Analyzer 책임(syntax fact만, Test Node와 VALIDATED_BY는 T07). vitest / @jest/globals / node:test import는 explicit, test 파일의 전역 호출만 heuristic(unknown), literal 이름만, 위치는 ID 재료 아님. ImportBinding(local → imported / default / *) 추가, re-export는 별도. static/instance member identity 분리, getter/setter는 같은 scope 안에서만 병합. `.d.ts` 특별 정책 없음(T07: implementation 우선, 모호하면 unresolved). annotation free-text 정책 승인, attachment 우선순위(바로 뒤 Symbol → enclosing Symbol → File)는 T07. T06: read-only Git Provider(Repository state, HEAD/Index/Working Tree provenance, staged/unstaged 변경, rename heuristic, metadata/content 두 수준 diff, binary는 metadata만, spawn + `-z`, batch, locale/pager 고정, submodule 비재귀) | 03, 04, ADR-003, TASKS, analyzer |

## 충돌과 해석

| ID | 내용 | 해석 | 반영 | 상태 |
|---|---|---|---|---|
| C1 | ADR 위치: D§17 `docs/architecture/ADR-xxx.md` vs D§18 `docs/adr/` | `docs/adr/` | adr/ | **Resolved** (H-9) |
| C2 | MCP Tool 이름: D§9는 `duo_` 접두사 9개(propose 포함), P§16은 접두사 없는 8개 | D§9 기준 9개 | 06 | **Resolved** (H-10) |
| C3 | Graph 목적: D§4 "시각화가 아니라 Localisation" vs P§8 "탐색과 시각화" | Localisation이 주목적, UI Graph는 보조 | 04, 08 | Proposed |
| C4 | UI 역할: P§7 "표현하고 수정하는 View" vs Human-owned·Decision Lock 원칙 | 읽기 중심 + Decision Confirm/Reject | 08, ADR-009 | **Resolved** (H-4) |
| C5 | Decision 승인 경로가 D§11 최소 CLI에 없음 | `duoctl decision confirm/reject` + UI, 파일 수정은 fallback | ADR-013 | **Resolved** (H-1) |
| C6 | Verdict 체계 두 가지 | 두 수준으로 분리 | ADR-007 | **Resolved** (H-8) |
| C7 | LLM 정책: "LLM 최소화"와 규칙만으로 Scope Drift를 판단하기 어려운 문제 | Deterministic First, 의미 판단만 LLM, OpenAI Responses Provider 1종, 없으면 UNKNOWN/ASK | ADR-008, ADR-012 | **Resolved** (H-3, H-15) |
| C8 | Jira가 Post-MVP인데 Issue Node와 Issue ↔ Code Drift가 MVP에 있음 | MVP Issue 출처는 milestones의 로컬 Issue, Markdown `type: issue`, 커밋 메시지 키 | 03, 04 | Proposed |
| C9 | "Agent는 .duo-project 수정 금지"를 기술적으로 강제할 수 없음 | 탐지 기반(lock digest, HEAD 기준선, R-LOCK) + Agent instruction + TTY 요구 | 10 | Proposed |
| C10 | MVP AST 대상 언어 미정 | TS/JS, LanguageAnalyzer 인터페이스 | ADR-003 | **Resolved** (H-2) |
| C11 | "Test 성공 여부" 판정을 위해 테스트를 실행해야 하는가 | 기본 실행하지 않음. `test_command` 설정 + `--run-tests`일 때만 | 03, 07, 10 | Proposed |
| C12 | 절감률 계산 기준 미정 | o200k_base 공식 측정, 방식 기록, Coverage 병기 | ADR-005, 09 | **Resolved** (H-5) |
| C13 | state/evidence/generated의 Git 관리 | Project Truth, Human-approved History, Regenerable/Runtime 3분류 | ADR-006 | **Resolved** (H-7, H-14) |
| C14 | Constraint가 D§4 초기 Node Type 8종에 없음 | Decision Node(`kind: constraint`)로 표현 | 03, 04 | Proposed |
| C15 | D§4 예시 `GAME-42 TRACKED_BY AUTH-03`의 방향이 의미와 반대 | 정규 방향 Requirement → Issue | 04 | Proposed |
| C16 | `duoctl decision`, `duoctl install`, `duoctl mcp`가 D§11 최소 목록에 없음 | H-1, D§10, D§9 요구를 위해 포함 | 07 | decision은 **Resolved** (H-1), install/mcp는 Proposed |
| C17 | D§3 "Project Intent 초안 생성"과 결정적 분석의 긴장 | H-3의 LLM 허용 목록에 Intent 초안이 없으므로 MVP는 결정적 초안 + UNKNOWN 질문 | ADR-008 | Proposed |
| C18 | 같은 OAuth 예시가 D§6에서는 CONFLICT, P§12에서는 WARN | Claim은 CONFLICT, Verdict는 Constraint `enforcement`(warn/block)로 결정 | ADR-007, 03 | Proposed |
| C19 | D§2의 `.duo-project` 디렉터리 목록(state/, evidence/)과 ADR-006 구조가 다름 | reviews/, generated/, cache/, runtime/ | ADR-006, 03 | **Resolved** (H-14) |
| C20 | D§4 Edge 표에는 Decision → Issue GOVERNS, Issue → Issue REQUIRES가 없음 | Edge Type은 그대로 두고 허용 endpoint만 넓힘(ADR ↔ Task 추적용) | 04, ADR-014 | Proposed |
| C21 | "Source of Truth는 .duo-project"와 .duo-project 밖 문서를 정의 소스로 읽는 것의 긴장 | 외부 문서는 External Evidence/Input Source. self fixture는 docs/를 임시 .duo-project로 복사해 사용 | 03, ADR-014 | **Resolved** (H-16) |
| C22 | D§12 예시의 "LLM Calls 1"과 Context Packet 생성의 LLM 미사용 | Context 생성은 항상 0. LLM 호출은 Review 의미 판정에서만 생기며 해당 지표에 표시 | 09 | Proposed |
| C23 | 12번 Task 분리로 생긴 `TASK-012A` 형식이 기존 ID 정규식(`-\d+`로 끝남)과 맞지 않음 | ID 정규식에 선택적 알파벳 접미사 허용(`-\d+[A-Z]?`), AC는 `AC-NNN[A-Z]?-NN` | ADR-014, 03 | **Resolved** (H-15의 결과) |
| C24 | ADR-010은 배포 번들러를 TASK-001에서 고른다고 했으나, T01 범위(H-18 이후 지시)는 workspace, TypeScript, Vitest, Lint, skeleton, 경계, CI, 기본 build/test로 한정됨 | T01은 `tsc -b` 빌드만 둔다. 번들러는 배포 산출물이 필요한 시점(TASK-017 또는 TASK-020 전)에 고르고 ADR-010에 기록 | ADR-010 | Proposed |
| C25 | TASK-001의 "Files expected to change"와 실제 변경 차이: `eslint.config.js`, `tsconfig.json`(테스트 포함 typecheck), `tsconfig.build.json`(빌드 solution), `scripts/boundaries.json`, `scripts/check-boundaries.mjs`, `tests/workspace/`가 추가됨. TypeScript는 7.0이 나왔지만 typescript-eslint 8.70이 `<6.1.0`만 지원해 `~6.0.3`으로 고정 | 경계 강제(AC-001-02)와 테스트 typecheck에 필요한 파일. TypeScript 7 전환은 lint 도구 지원 후 별도 검토 | TASKS, ADR-001 | Proposed |
| C26 | TASK-002 AC-002-04(fs-guard가 허용 경로 밖 쓰기를 거부)가 H-19의 T02 범위 목록에 없었음 | T02.1에서 순수 정책 `checkWriteBoundary`로 구현(실제 writer는 이후 Task). AC는 삭제·이동하지 않음 | core, 03, TASKS | **Resolved** (H-20) |
| C27 | 03 문서에 없던 Core 계약 세부(strict + `extensions`, `schema_version`, YAML 제한, metadata 인식 규칙, RepoPath, SourceLocation, EntityRef, Namespace 등) | T02.1에서 03을 구현 기준으로 다시 작성 | 03 | **Resolved** (H-20) |
| C28 | 03의 `UNKNOWN:` 줄(Knowledge Gap)은 T02 파서가 해석하지 않음. Markdown 본문은 `description`과 `texts`로만 보존 | Gap 탐지는 TASK-011 | 03, TASKS | Proposed |
| C29 | "Requirement에 Task가 없음"은 사용자 프로젝트에서는 흔한 상태라 core 기본 심각도는 info. 이 저장소 docs validator만 정책으로 error로 올림(`requireTrackedRequirements`) | 규칙은 core 한 곳, 심각도만 호출 측 정책 | core, scripts | Proposed |
| C30 | 04의 traverse는 "같은 거리의 Node를 edge weight 순으로 방문"한다고 했으나, 저장 계층 traverse(TASK-003)에는 weight가 없음 | 저장 계층은 (depth, id)의 결정적 BFS와 bounded adjacency만 제공. weight 기반 순위는 Context Compiler(TASK-010)가 traverse 결과에 적용. 04 갱신 | 04, graph | Proposed |
| C31 | AC-003-03 "쓰기 잠금을 얻지 못한 두 번째 프로세스는 stale 표시와 함께 읽기만 한다"는 GraphStore가 stale을 판정하는 것처럼 읽힘. 마지막 commit 상태를 읽는 것은 snapshot visibility이고 freshness 판정이 아님 | AC-003-03 문구를 "busy 결과 + 마지막 commit 상태 읽기, GraphStore는 contentHash/source만 저장"으로 정정. freshness는 TASK-004(비교 primitive)와 TASK-008(Indexer, fresh/changed/deleted/unknown)이 담당하고 표시는 TASK-015/016. T03은 contentHash/source 저장(왕복 테스트)과 busy/WAL 동작으로 조건을 충족해 done 유지 | TASKS, 02, 03, 04, 06, ADR-002 | **Resolved** (H-21) |
| C32 | 03의 이전 SQLite 계획(`owner_file`, Edge `provenance` 칼럼, fingerprints·unresolved_refs 테이블)이 T03 스키마에 없음 | T03은 저장 계층만. provenance는 Edge metadata에 둘 수 있다. fingerprints는 graph.db에 넣지 않고 `generated/fingerprints.json`에 둔다(H-21). `owner_file`, unresolved_refs는 TASK-007/008에서 `graph_schema_version`을 올리며 추가(ADR-002) | ADR-002, 03 | fingerprints는 **Resolved** (H-21), 나머지 Proposed |
| C33 | AC-004-03 "stat이 같으면 재실행 시 hash 계산이 0회"와 02의 변경 탐지 순서(stat 후 필요할 때만 hash)는 mtime/size를 내용 동일성의 근거로 씀. H-21은 mtime을 authoritative로 쓰지 않음 | AC-004-03을 "변경 판정은 contentHash로 한다. mtime만 바뀌면 UNCHANGED, 같은 크기의 내용 변경은 CHANGED"로 바꾸고 02를 갱신. T04는 매번 hash한다. stat fast path는 성능 문제가 드러나면(REQ-NFR-004, TASK-008/019) hint로만 추가 | TASKS, 02 | **Resolved** (H-21) |
| C34 | TASK-004가 토큰 측정(Output TokenEstimator, AC-004-04, ADR-005 "라이브러리는 TASK-004에서 선택", 09 "fingerprint 단계에서 저장")을 맡고 REQ-TOKEN-001이 M1이었음 | tokenizer 의존성과 토큰 AC를 TASK-010으로 옮김(AC-010-06, 문구 유지). REQ-TOKEN-001은 TASK-010이 추적하고 milestone은 M2. AC-004-04는 contentHash 규칙으로 대체. o200k_base 기준은 유지(ADR-005) | TASKS, 01, 12, ADR-005, 09 | **Resolved** (H-21) |
| C35 | ADR-006과 03은 `generated/graph.db`에 fingerprints가 포함된다고 했고 04 불변식 3은 "fingerprints 행"을 말함 | fingerprint는 `generated/fingerprints.json`(Regenerable). 04 불변식 3은 이 파일의 항목과 File Node의 1:1 대응 | ADR-006, 03, 04 | **Resolved** (H-21) |
| C36 | Scanner는 Git work tree의 최상위에서만 동작함. Git이 없는 경우의 동작이 정해지지 않았음 | DUO MVP는 Git 저장소 필수. non-Git fallback은 구현하지 않는다. Git work tree가 아니면 `GIT_REPOSITORY_REQUIRED`(core 진단, `duoctl init`은 TASK-014에서 같은 코드), 최상위가 아니면 `SCAN_ROOT_INVALID` | analyzer, core, 03 | **Resolved** (H-22) |
| C37 | `kind: "text" \| "binary"`는 실제 파일 형식을 판별하지 않음(목록에 없는 `.log`도 "binary"). index mode가 symlink면 working tree 변화를 숨김 | `fingerprintMode: "normalized-text" \| "raw"`로 바꾸고 fingerprints.json version 2. hash 정책일 뿐 MIME이나 언어 지원을 뜻하지 않는다. EOL 무관 보장은 normalized-text 파일에만 적용(03). 목록에 없는 확장자의 raw 처리는 MVP에서 허용. symlink ↔ 일반 파일 변화는 `FILE_TYPE_CHANGED`와 `typeChanges`로 보고하고 대상은 계속 읽지 않는다 | analyzer, 03 | **Resolved** (H-22) |
| C38 | ADR-003은 wasm을 `packages/analyzer/grammars/*.wasm`로 저장소에 포함하고, 인터페이스를 `init()` + `analyze(filePath, source): AnalysisResult`로 적었음. TASK-005 Files도 `grammars/*.wasm` | 공식 grammar 패키지에 들어 있는 WASM을 `require.resolve`로 쓰고 저장소에 binary를 커밋하지 않는다(배포 packaging은 별도 단계). 초기화는 async factory, `analyze({ path, content }): ParseResult<SourceAnalysis>`, `dispose()`. ADR-003, 04, TASKS 갱신 | ADR-003, 04, TASKS | **Resolved** (H-22) |
| C39 | AC-005-03 "parse 오류 파일은 diagnostics와 함께 File 수준 결과만 낸다" vs H-22 "error recovery로 가능한 Symbol/Import/Call 계속 추출" | AC-005-03을 "partial + AST_PARSE_ERROR, ERROR 노드 밖은 계속 추출"로 변경. ERROR 노드 안은 읽지 않는다. Graph Builder가 `parseStatus`로 신뢰 수준을 정한다 | TASKS, 03 | **Resolved** (H-22) |
| C40 | AC-005-02와 04의 AnalysisResult는 test 추출(Test Node, VALIDATED_BY 근거)을 포함했으나 T05 SourceAnalysis에는 없었음 | T05.1에서 Analyzer 책임으로 추가: `SourceAnalysis.tests`(literal 이름, suite `fullName`, framework explicit/heuristic, skip/only/todo). Test Node와 VALIDATED_BY는 TASK-007 | analyzer, 04, TASKS | **Resolved** (H-23) |
| C41 | 03의 SourceLocation 칸 단위가 명시되지 않았음 | 기존 YAML/Markdown 구현과 web-tree-sitter가 모두 UTF-16 code unit이므로 이를 계약으로 명시(03). `sliceSourceLocation`과 한글·emoji·CRLF 테스트로 고정. Markdown의 tab 폭 처리는 별도 검증하지 않았음 | 03, core | Proposed |
| C42 | T05 추출 한계: computed name·class field(arrow 함수 속성 포함)·namespace와 `declare module` 내부·`module.exports = function`은 Symbol이 아님. 이름 없는 callee(IIFE, `f()()`, `(a \|\| b)()`)와 template literal specifier(``import(`x`)``)는 기록하지 않음. `import { type A }`는 문장 `typeOnly: false`, binding `typeOnly: true`. static/instance 같은 이름 병합은 T05.1에서 해소(identity `Class.static.name`) | 04의 Symbol 범위와 H-22의 "필요한 Symbol만" 원칙. 누락이 Coverage에서 드러나면 범위를 넓힘 | analyzer, 04 | static/instance는 **Resolved** (H-23), 나머지 Proposed |
| C43 | `core.symlinks=false`에서 index symlink 자리의 일반 파일을 다른 내용으로 바꾸면 Git은 typechange가 아니라 modified로 봄 | Git 판정을 따른다. 이 경우 계속 symlink로 제외되고 `FILE_TYPE_CHANGED`는 나오지 않음 | analyzer, 03 | Proposed |
| C44 | 02와 REQ-PROVIDER-001은 core `EvidenceProvider` 인터페이스 뒤에 Git Provider를 둔다고 했으나, H-23은 T06을 provenance primitive로 한정하고 Evidence system을 TASK-013으로 미룸 | T06은 analyzer의 `GitProvider`만 제공한다. core `EvidenceProvider` 인터페이스 정의와 Git Provider 연결은 Evidence가 필요한 TASK-013에서 한다 | 02, analyzer | Proposed |
| C45 | Git rename은 similarity heuristic이다. `git status`는 staged rename만 찾고(unstaged rename은 삭제 + untracked), 기본 기준은 50%다. `getDiff`에서 rename을 보려면 old/new path를 모두 요청해야 한다 | Git의 판정을 그대로 사실로 주고 `similarity`를 붙인다. Node ID 이전 여부는 Indexer(TASK-008)가 정한다 | analyzer, 03 | Proposed |
| C46 | T05.1 test/binding 한계: `test.each(...)(...)`, `describe.skip.each`, `.concurrent` 같은 다른 modifier, CommonJS `require("node:test")` 구조 분해로 받은 test 함수, `__tests__/` 디렉터리의 전역 호출, 이름이 literal이 아닌 test는 기록하지 않음. dynamic import와 중첩 구조 분해는 binding이 없음. `extractIssueKeys`는 `UTF-8` 같은 문자열도 후보로 냄 | 보수적 추출 원칙(H-23 §4, §5). Issue 키는 Project Truth 대조(TASK-007)로 걸러짐 | analyzer, 04 | Proposed |

## 미결 사항

| ID | 질문 | 현재 기본안 |
|---|---|---|
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
| Q-NAMESPACE | 기술 식별자가 외부 AI coding 도구와 충돌할 수 있음 | 기술 식별자 변경 확정 (H-20). npm publish 가능 여부는 배포 단계에서 다시 확인 |
