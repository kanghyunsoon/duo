# 충돌 및 미결 사항

상태: Draft

두 원본 문서([개발 지시문](references/development-directive.md), [기획서](../Duo%20기획서.md)) 사이의 충돌과 불명확한 부분을 기록한다. **Resolved**는 Human 승인 후에만 표시한다. 현재 제안 해석은 SDD에 반영되어 있고, Human이 다르게 결정하면 해당 문서를 고친다.

## 충돌·해석 기록

| ID | 내용 | 제안 해석 | 반영 문서 | 상태 |
|---|---|---|---|---|
| C1 | ADR 위치: 지시문 17절 `docs/architecture/ADR-xxx.md` vs 18절 `docs/adr/` | `docs/adr/`로 통일 | adr/ | Proposed |
| C2 | MCP Tool 이름: 지시문은 `duo_` 접두사 9개(propose 포함), 기획서는 접두사 없음 8개 | 지시문 기준 | 06 | Proposed |
| C3 | Graph 목적: 지시문 "시각화가 아니라 Localisation" vs 기획서 "탐색과 시각화" | Localisation이 주목적, UI Graph는 보조 | 04, 08 | Proposed |
| C4 | UI 역할: 기획서 "표현하고 수정하는 View" vs Human-owned·Decision Lock 원칙 | v0.1 UI는 읽기 전용, 편집은 파일 직접 수정 | 08 | Proposed |
| C5 | Decision 승인 경로가 최소 CLI에 없음 | Q1 참조. 기본안: proposal 파일을 Human이 옮기고 state 변경, 커밋 = 승인 | 03 | **Human 결정 대기** |
| C6 | Verdict 체계 두 가지(PASS/WARN/BLOCK/ASK, ALIGNED/PARTIAL/CONFLICT/UNKNOWN) | Claim에 Alignment, Review 전체에 Verdict | ADR-007 | Proposed |
| C7 | 같은 OAuth 예시가 지시문에서는 CONFLICT, 기획서에서는 WARN | Alignment는 CONFLICT, Verdict는 Constraint의 `enforcement`(warn/block)로 결정 | 03, ADR-007 | Proposed |
| C8 | Jira가 Post-MVP인데 Issue Node와 Issue ↔ Code Drift가 MVP에 있음 | MVP Issue 출처는 milestones/*.yaml 로컬 Issue와 커밋 메시지 키 | 03, 04 | Proposed |
| C9 | "Agent는 .duo 수정 금지"를 기술적으로 강제할 수 없음 | 탐지 기반(R-LOCK, HEAD 기준선) + Agent instruction 명시 | 10 | Proposed |
| C10 | MVP AST 대상 언어 미정 | Q2 참조. 기본안: TS/JS | ADR-003 | **Human 결정 대기** |
| C11 | "Test 성공 여부" 판정을 위해 테스트를 실행해야 하는가 | 기본 실행 안 함. test_command 설정 + `--run-tests`일 때만 | 03, 07, 10 | Proposed |
| C12 | 절감률(97.3% 등) 계산 기준 미정 | 09의 지표 정의 + 추정기 고정 + Coverage 병기 | 09, ADR-005 | Proposed |
| C13 | state/evidence/generated의 Git 관리 여부 미정 | 셋 다 gitignore. evidence는 재생성 불가함을 문서화 | 03 | Proposed |
| C14 | Constraint가 초기 Node Type 8종에 없음 | Decision Node(`kind: constraint`)로 표현, Node Type 추가 없음 | 03, 04 | Proposed |
| C15 | 지시문 예시 `GAME-42 TRACKED_BY AUTH-03`의 방향이 의미와 반대 | 정규 방향 Requirement → Issue | 04 | Proposed |
| C16 | `duo install`, `duo mcp`가 최소 CLI 목록(11절)에 없음 | 10절·9절 요구를 위해 포함 | 07 | Proposed |
| C17 | "Project Intent 초안 생성"과 "LLM 최소화"의 긴장: 규칙만으로 만든 초안은 빈약할 수 있음 | v0.1은 README/manifest/문서 Heading에서 뽑은 초안 + UNKNOWN 질문. LLM 초안은 v0.3 이후 | 02, ADR-008 | Proposed |
| C18 | LLMProvider 실제 구현 범위: "MVP에서 불필요한 Provider를 전부 구현하지 않는다" vs benchmark 예시 "LLM Calls 1" | v0.1은 interface + none. 예시의 1은 향후 값으로 해석 | ADR-008 | Proposed |

## Human 결정 대기

| ID | 질문 | 선택지 | 기본안(결정 전까지 적용) |
|---|---|---|---|
| Q1 | Decision 확정을 어떤 방식으로 할까? | (a) 파일 직접 수정 + 커밋 = 승인 (b) `duo decision confirm/reject` 명령 추가(TTY에서만 동작) | (a) |
| Q2 | v0.1 AST 대상 언어는? | (a) TS/JS만 (b) TS/JS + Python (c) TS/JS + Java | (a) |
| Q3 | 배포 패키지 이름과 라이선스는? | npm 이름 후보: `duo`(선점 여부 확인 필요), `@duo-dev/cli` 등 / MIT 또는 Apache-2.0 | 미정, 공개 전 결정 |
| Q4 | 저장소 공개 시점은? | 지금 / v0.1 이후 | 현재 private |
