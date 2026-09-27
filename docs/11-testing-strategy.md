# 11. Testing Strategy

상태: Draft

## 도구

- 테스트: vitest. 모든 패키지가 같은 설정을 쓴다.
- CI: GitHub Actions, `ubuntu-latest` · `windows-latest` · `macos-latest` × Node 24.
- Snapshot은 결정적 출력(Packet, tools/list, Review JSON)에만 쓴다.

## Fixture

- `fixtures/auth-app/`: 작은 TS 프로젝트(AuthService, JwtProvider, 테스트, .duo/ 포함).
- Git 이력은 저장소 안에 중첩 `.git`으로 둘 수 없으므로 `fixtures/auth-app/history.ts` 스크립트가 임시 디렉터리에 커밋을 재현한다(작성자, 시각 고정).
- 시나리오 변경 세트(`fixtures/auth-app/changes/*.patch`): OAuth 추가(Constraint 위반), D-004 수정(Lock 위반), 테스트 없는 변경, 정상 변경, 관련 gap이 있는 변경.

## 필수 검증

| 항목 | 방법 | Task |
|---|---|---|
| Repository indexing | fixture 스캔 결과 파일 목록·제외 목록·Symbol 테이블 golden 비교 | T04, T05 |
| Incremental indexing | 변경 시퀀스 적용 후 증분 Graph == 전체 재구축 Graph. 변경 없는 재실행에서 parse 호출 0회(계측 카운터) | T07 |
| Graph consistency | `graph.check()` 불변식 5개. fuzz: 임의 파일 추가/삭제/rename 시퀀스 | T06, T07 |
| Context retrieval | 시나리오별 필수 Node 포함(Coverage 100% 목표 fixture) | T10 |
| Token budget | property test: 임의 budget(500~50000)에서 Packet 토큰 ≤ budget, 필수 항목 포함 | T10 |
| Decision Lock | HEAD confirmed 변경 → BLOCK, 정상 supersede → ASK, proposal 생성은 새 파일만, DUO 코드에서 confirmed 기록 경로 없음 | T09, T11 |
| Knowledge Gap | 관련 gap → ASK, 무관 gap → Packet 미포함 + gaps_suppressed 증가, UNKNOWN 줄 삭제 → resolved | T08, T10 |
| Diff review | 변경 세트별 기대 verdict와 Claim 규칙 ID, 모든 Claim에 Evidence ≥ 1 | T11 |
| MCP tool contract | stdio spawn, tools/list 스냅샷, 입력 검증 오류, structured 출력 스키마, stdout 순수성 | T13 |
| Install | 임시 HOME/프로젝트에서 install → 파일 내용 검증 → 재실행 idempotent → uninstall 복원 | T14 |
| E2E | 아래 시나리오 | T17 |

## E2E 시나리오 (v0.1 인수 기준)

1. fixture 이력 재현 → `duo init --yes` → .duo 파일과 graph.db 생성, llm_calls 0
2. `duo install codex`, `duo install claude` (임시 설정 경로)
3. MCP client로 `duo_get_context("GAME-42 refresh token")` → AUTH-03, D-004, CON-001, AuthService.refresh 포함, budget 준수
4. OAuth 변경 세트 적용 → `duo_review_changes` → CON-001 enforcement에 맞는 WARN 또는 BLOCK, Evidence에 CON-001과 새 파일
5. UI 서버 기동 → `/api/drift`에 4의 Claim 존재
6. `duo stats`에 3, 4의 지표 존재

## 문서-구현 비교

각 Task 완료 시 [TASKS.md](tasks/TASKS.md)의 "검증할 문서"를 대조하고, 차이가 있으면 [conflicts.md](conflicts.md)에 기록한다. 이 절차 자체가 Task 완료 조건이다.
