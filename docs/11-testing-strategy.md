# 11. Testing Strategy

상태: Draft

## 도구

- 테스트는 vitest로 하고 모든 패키지가 같은 설정을 쓴다.
- CI는 GitHub Actions에서 `ubuntu-latest`, `windows-latest`, `macos-latest` × Node 24로 돈다.
- Snapshot은 결정적 출력(Packet, tools/list, Review JSON)에만 쓴다.
- 테스트 이름에 검증 대상 ID를 넣는다(예: `it("AC-010-02 budget never exceeded")`). DUO가 이 이름으로 VALIDATED_BY Edge를 만든다([ADR-014](adr/ADR-014-traceability-ids.md)).

## Fixture

| Fixture | 내용 | 용도 |
|---|---|---|
| `fixtures/auth-app/` | 작은 TS/JS 프로젝트(AuthService, JwtProvider, 테스트, .duo 포함) | 인덱싱, Graph, Context, Review |
| `fixtures/auth-app/history.ts` | 임시 디렉터리에 Git 이력을 재현(작성자, 시각 고정). 저장소 안에 중첩 .git을 둘 수 없기 때문 | Git, CHANGED_WITH, Decision Lock |
| `fixtures/auth-app/changes/*.patch` | 변경 세트 6종: OAuth 추가(Constraint 위반), D-004 수정(Lock 위반), 테스트 없는 변경, 정상 변경, 관련 Gap이 있는 변경, Requirement와 연결되지 않은 추가(R-SCOPE) | Review |
| self(이 저장소 docs/) | REQ/ADR/TASK/Milestone 정의 | 추적성 파싱, Graph 경로, E2E trace |
| 가짜 LLM 서버 | OpenAI 호환 응답을 돌려주는 로컬 HTTP 서버(정상, 스키마 위반, 범위 밖 ID 인용, 타임아웃) | LLMProvider, escalation |

## 필수 검증

| 항목 | 방법 | AC |
|---|---|---|
| Repository indexing | 파일 목록, 제외 목록, Symbol 테이블 golden 비교 | AC-004-01, AC-005-02 |
| Incremental indexing | 변경 시퀀스 fuzz에서 증분 == 전체 재구축, 무변경 재실행 parse 0회 | AC-008-01, AC-008-02 |
| Graph consistency | 불변식 1~6 | AC-007-02, AC-008-01 |
| Context retrieval | 시나리오별 필수 Node Coverage | AC-010-01 |
| Token budget | property test(500~50000) | AC-010-02 |
| Decision Lock | lock 생성, digest 불일치 BLOCK, 수동 confirm ASK, supersede 유효성, confirmed 기록 경로 정적 검사 | AC-009-02~05, AC-013-01 |
| Knowledge Gap | 관련 Gap만 ASK, 무관 Gap 억제, UNKNOWN 삭제 시 resolved | AC-011-02~04 |
| Diff review | 변경 세트 6종의 verdict와 규칙 ID, Evidence ≥ 1 | AC-013-01, AC-013-02 |
| LLM 없이 동작 | Provider 없음에서 전체 테스트 통과, 의미 판정은 UNKNOWN과 skipped_checks | AC-012-01, AC-013-03 |
| LLM Provider | 가짜 서버로 정상, 오류, 스키마 위반, 범위 밖 인용 처리 | AC-012-02, AC-012-03 |
| MCP tool contract | tools/list 스냅샷, 입력 검증, 출력 스키마, stdout 순수성 | AC-016-02~05 |
| UI Human Action | Confirm/Reject가 .duo/decisions만 바꿈, token/Host/Origin 없는 요청 거부 | AC-018-02, AC-018-03 |
| Install | install → 재실행 동일 → uninstall 복원 | AC-017-02~04 |
| Self fixture | docs/ 파싱, 참조 해석, REQ → ADR → TASK 경로 | AC-002-03, AC-007-03, AC-020-02 |

## E2E 시나리오 (v0.1 인수 기준, TASK-020)

1. fixture 이력 재현 → `duo init --non-interactive` → .duo와 graph.db 생성, ASK 목록 출력, llm_calls 0
2. `duo install codex`, `duo install claude`(임시 설정 경로)
3. MCP client로 `duo_get_context("GAME-42 refresh token")` → AUTH-03, D-004, CON-001, AuthService.refresh 포함, budget 준수, llm_calls 0
4. OAuth 변경 세트 적용 → `duo_review_changes` → CON-001 enforcement에 맞는 Verdict, Evidence에 CON-001과 새 파일
5. `duo_propose_decision` → UI API로 Confirm(token 포함) → `.duo/decisions/D-###.yaml` 생성, lock 기록
6. UI 서버 `/api/drift`에 4의 Claim 존재, `/api/decisions`에 5의 결과 존재
7. `duo stats`에 3, 4의 지표 존재
8. 이 저장소에서 `duo trace REQ-CONTEXT-001` → ADR-005, TASK-010 포함

모든 단계는 LLM Provider 없이 통과해야 한다. 가짜 LLM 서버를 켠 변형 시나리오는 4단계에서 R-SCOPE/R-INTENT 결과가 LLM 판정으로 채워지는지 추가 확인한다.

## 문서-구현 대조

각 Task를 마칠 때 TASKS.md의 "검증 대상 Requirement" 문서와 실제 구현을 대조하고, 차이는 [conflicts.md](conflicts.md)에 기록한다. 이 절차가 Task 완료 조건이다.
