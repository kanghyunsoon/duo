# Backend 구현 백로그(T87)

[decision-rbac-design.md](decision-rbac-design.md)(#25), [decision-audit-gap.md](decision-audit-gap.md)(#26), [backend-api-contract.md](backend-api-contract.md)를 구현 단위로 나눈 백로그다.

- **Jira:** DUO 전용 프로젝트 S15P31A106에 이미 있는 이슈(T86 이관)에 먼저 연결했다. 겹치지 않는 항목만 "신규"로 표시했다.
- **신규 항목 생성 시점:** 대부분 ADR-015와 H-88 승인을 기다리므로 지금 Jira·GitHub에 만들지 않았다. 승인 뒤 이 표를 manifest로 그대로 생성한다.
- **GitHub:** 기술 토론과 PR용으로 쓴다.

## 1. 규칙

- **SP:** 1, 2, 3, 5만 쓴다. 8 이상은 나눴다. Risk(LOW/MEDIUM/HIGH/CRITICAL)와 Confidence(HIGH/MEDIUM/LOW)는 SP와 따로 적는다.
- **Component:** Jira에 있는 이름을 쓴다(`Governance / Security`, `Decision`, `Core / Truth`, `API / Backend`, `Data / Storage`, `MCP`, `Agent Integration`, `CLI`, `QA / Testing`, `Documentation`). 지시문의 후보와는 이렇게 연결했다.
  - "Integration" → `MCP` 또는 `Agent Integration`
  - "QA / Backend Testing" → `QA / Testing`
  - "Core / Decision" → `Core / Truth` + `Decision`
- **Owner Role:** T86 레이블 `owner-be1` 등을 쓴다. 담당자는 계정이 확인된 BE-1(강형순)만 연결한다.
- **공통 DoD:**
  - 작성자가 아닌 사람의 승인 리뷰를 받는다.
  - `next`의 Windows·Ubuntu·macOS verify를 통과한다.
  - 공개 `/1` 형식, MCP 9개 tool, 종료 코드 의미를 바꾸지 않는다. 바꾸려면 Human Decision을 먼저 받는다.
  - 실수 방지 기능을 인증이라고 부르지 않는다.
  - `pnpm verify`와 `pnpm docs:validate`를 통과한다.
- **"HD"** 표시는 H-88(ADR-015) 승인 뒤에만 착수하는 항목이다.

## 2. 항목

| ID | Summary | Epic | Type | Component | Owner | SP | Pri | Risk | Conf | 선행 | Jira / GitHub | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BE-GOV-01 | RBAC 위협 모델 | EP-04 | Task | Governance / Security | BE-1 | 3 | P1 | HIGH | MEDIUM | 없음 | S15P31A106-236, #25 | 이 PR의 설계 문서로 완료(승인 대기) |
| BE-GOV-02 | 옵션 비교와 ADR 제안 | EP-04 | Task | Governance / Security, Documentation | BE-1 | 3 | P1 | HIGH | MEDIUM | GOV-01 | S15P31A106-237, #25 | ADR-015 초안으로 완료(승인 대기) |
| BE-GOV-03 | `governance.yaml`(`duo.governance/1`) 스키마·loader·쓰기 경계 | EP-04 | Story | Core / Truth, Governance / Security | BE-1 | 3 | P1 | HIGH | MEDIUM | HD | S15P31A106-238 | 미구현 |
| BE-GOV-04 | Git identity → 사람 → 역할·범위 해석 | EP-04 | Sub-task | Governance / Security | BE-1 | 2 | P1 | MEDIUM | MEDIUM | GOV-03 | S15P31A106-238 하위(신규) | 미구현 |
| BE-GOV-05 | Decision Authorization Service와 DecisionService 연결 | EP-04 | Sub-task | Decision, Governance / Security | BE-1 | 5 | P1 | HIGH | LOW | GOV-04 | S15P31A106-305 | 미구현 |
| BE-GOV-06 | agent 실행 환경 감지 시 CLI·UI 확정 거부(실수 방지) | EP-04 | Task | CLI, API / Backend | BE-1 | 2 | P2 | MEDIUM | LOW | 각 agent 공식 문서 확인 | 신규 | 미구현 |
| BE-GOV-07 | Team Mode에서 lock·이벤트 없는 Decision을 Truth 오류로 | EP-03 | Story | Core / Truth, Decision | BE-1 | 3 | P1 | HIGH | MEDIUM | GOV-03, AUD-02, HD | 신규 | 미구현 |
| BE-GOV-08 | `duoctl decision verify`(로컬 검증) | EP-04 | Story | CLI, Decision | BE-1 | 3 | P1 | HIGH | MEDIUM | AUD-04, GOV-04 | 신규 | 미구현 |
| BE-GOV-09 | `decision verify --ci`: PR에서 바뀐 Decision 파일 검사와 workflow 예시 | EP-04 | Story | CLI, Governance / Security | BE-1 | 3 | P1 | HIGH | LOW | GOV-08 | 신규 | 미구현 |
| BE-GOV-10 | 권한 실패 종료 코드와 `--json` 오류 계약 | EP-04 | Sub-task | CLI | BE-1 | 2 | P2 | MEDIUM | MEDIUM | GOV-05 | S15P31A106-308 | 미구현 |
| BE-GOV-11 | HTTP 확정 경로 권한 검사와 `/api/me`(API-01) | EP-04 | Sub-task | API / Backend | BE-1 | 2 | P2 | MEDIUM | MEDIUM | GOV-05 | S15P31A106-310 | 미구현 |
| BE-GOV-12 | MCP 제안의 actor·표면 기록, 확정 도구 없음 유지 | EP-04 | Story | MCP | AI-2(BE-1 리뷰) | 3 | P2 | HIGH | LOW | AUD-03 | S15P31A106-241 | 미구현 |
| BE-GOV-13 | 모든 표면에서 agent 확정 우회 방지 회귀 테스트 | EP-04 | Sub-task | QA / Testing | AI-1(BE-1 지원) | 3 | P1 | HIGH | MEDIUM | GOV-05 | S15P31A106-306 | 미구현 |
| BE-GOV-14 | 병렬 승인 요청 일관성 | EP-04 | Sub-task | QA / Testing | AI-4 | 3 | P1 | HIGH | LOW | GOV-05, #34 | S15P31A106-307, #34 | 미구현 |
| BE-GOV-15 | DUO 저장소 CODEOWNERS와 code owner review | EP-04 | Task | Governance / Security | BE-1 | 2 | P2 | MEDIUM | MEDIUM | HD | S15P31A106-246 | 미구현 |
| BE-GOV-16 | 신뢰 상태 확인(호스트 branch 규칙 조회, `LOCAL`·`VERIFIED`·`NOT_MET`·`UNVERIFIED`, T94) | EP-04 | Story | Governance / Security, CLI | BE-1 | 3 | P1 | HIGH | LOW | GOV-03, rbac 설계 §11 사실 확인, HD | 신규 | 미구현 |
| BE-GOV-17 | `decision verify --ci`의 정책 경로 변경 보고, 이벤트 append-only, stale 승인 검사(T94) | EP-04 | Story | Governance / Security, CLI | BE-1 | 3 | P1 | HIGH | MEDIUM | GOV-09, AUD-04 | 신규 | 미구현 |
| BE-GOV-18 | `decision adopt`와 Team Mode bootstrap 검증(T94) | EP-04 | Story | Decision, CLI | BE-1 | 3 | P2 | HIGH | MEDIUM | AUD-01, GOV-07 | 신규 | 미구현 |
| BE-AUD-01 | 이벤트 형식 `duo.decision-event/1`, `decisions/events/<subject>/<eventId>.json`(이벤트당 파일 1개, T94) 쓰기 경계 | EP-04 | Story | Core / Truth, Decision | BE-1 | 3 | P1 | HIGH | MEDIUM | HD | 신규 | 미구현 |
| BE-AUD-02 | propose·confirm·reject·repair에서 lock 안에 이벤트 기록 | EP-04 | Story | Decision | BE-1 | 5 | P1 | HIGH | LOW | AUD-01 | 신규 | 미구현 |
| BE-AUD-03 | 본 digest, 표면, actor label, 사유, `basedOn`·`prevHash`·stale 기록(Git email은 opt-in, T94) | EP-04 | Task | Decision | BE-1 | 2 | P1 | MEDIUM | MEDIUM | AUD-02 | 신규 | 미구현 |
| BE-AUD-04 | 이벤트 해시 체인과 무결성 검사(doctor·verify) | EP-04 | Task | Decision, Governance / Security | BE-1 | 3 | P2 | MEDIUM | MEDIUM | AUD-02 | 신규 | 미구현 |
| BE-AUD-05 | 이력 read model(이벤트, 대체 사슬, lock, 파일 추론 fallback) | EP-04 | Sub-task | Core / Truth | BE-1 | 3 | P2 | MEDIUM | MEDIUM | AUD-02 | S15P31A106-244(분할) | 미구현 |
| BE-AUD-06 | `duoctl decision history <id>` | EP-04 | Sub-task | CLI | BE-1 | 2 | P2 | LOW | HIGH | AUD-05 | S15P31A106-244(분할) | 미구현 |
| BE-AUD-07 | 이벤트 누락 감지(doctor, Team Mode) | EP-04 | Task | Decision | BE-1 | 2 | P2 | MEDIUM | MEDIUM | AUD-02, GOV-07 | 신규 | 미구현 |
| BE-AUD-08 | 재시도·repair 재실행의 중복 이벤트 방지 | EP-04 | Task | Decision | BE-1 | 2 | P2 | MEDIUM | MEDIUM | AUD-02 | 신규 | 미구현 |
| BE-AUD-09 | 이벤트의 개인정보·보존 정책(표시 이름, Git email, 사유) | EP-04 | Task | Documentation, Governance / Security | BE-1 | 1 | P2 | MEDIUM | HIGH | HD | 신규 | 미구현 |
| BE-API-02 | `GET /api/decisions`, `GET /api/decisions/{id}`(API-02·03) | EP-14 | Story | API / Backend | BE-1 | 3 | P2 | LOW | HIGH | 없음 | S15P31A106-331 | `next`에 구현(#53 `a0d4c92`, 미공개) |
| BE-API-04 | `GET /api/decisions/{id}/history` | EP-14 | Sub-task | API / Backend | BE-1 | 2 | P2 | LOW | MEDIUM | AUD-05 | S15P31A106-314 | 미구현 |
| BE-API-05 | `GET /api/proposals/{id}/preview` | EP-14 | Task | API / Backend | BE-1 | 1 | P3 | LOW | HIGH | 없음 | S15P31A106-332 | `next`에 구현(#54 `81b1b95`, 미공개) |
| BE-API-06 | confirm 요청의 선택 `reason` | EP-14 | Task | API / Backend, CLI | BE-1 | 1 | P2 | LOW | HIGH | AUD-02 | 신규 | 미구현 |
| BE-API-07 | proposal withdraw(스키마 확장 포함) | EP-03 | Story | Decision, API / Backend | BE-1 | 3 | P3 | MEDIUM | MEDIUM | HD | 신규 | 미구현 |
| BE-API-09 | 새 진단 코드의 공통 오류 계약 테스트 | EP-16 | Task | API / Backend, QA / Testing | BE-1 | 2 | P2 | LOW | HIGH | GOV-05 | 신규 | 미구현 |
| BE-API-10 | 새 엔드포인트의 세션·CSRF·Origin 회귀 테스트 | EP-16 | Task | QA / Testing | BE-1 | 2 | P2 | MEDIUM | HIGH | API-02 | S15P31A106-333 | 진행 중: Preview·Confirm은 `next`(#64 `6c6c872`), Decision 목록·상세는 PR #76 리뷰 중 |
| BE-DATA-02 | repair 결과를 이벤트와 모든 표면 출력에 노출 | EP-03 | Task | Decision, MCP | BE-1(MCP 출력은 AI-2와 협의) | 2 | P2 | MEDIUM | MEDIUM | AUD-02 | 신규 | 미구현 |
| BE-DATA-03 | #34 결과의 동시성 버그 수정 | EP-15 | Bug(예약) | Data / Storage | BE-1 | 미정 | P1 | HIGH | LOW | #34 결과 | S15P31A106-274·275 결과에 따라 생성 | 조사 중 |
| BE-DATA-04 | 0.3.3 저장소가 새 선택 파일·이벤트 영역과 함께 그대로 읽히는지 호환 테스트 | EP-16 | Task | Data / Storage, QA / Testing | BE-1 | 2 | P1 | MEDIUM | HIGH | AUD-01, GOV-03 | 신규 | 미구현 |
| BE-DATA-05 | stale index 자동 복구의 Graph lock | EP-06 | Sub-task | Graph | BE-1 | 3 | P2 | HIGH | LOW | S15P31A106-255(AI-4) | S15P31A106-321, #4 | 미구현 |
| BE-OPS-01 | UI 서버 통합 테스트(Team Mode 확정·거절, lock busy, preview 변경) | EP-16 | Task | QA / Testing | BE-1 | 3 | P2 | MEDIUM | MEDIUM | GOV-11 | 신규 | 미구현 |
| BE-OPS-02 | 보안 시나리오 fixture(위조 Decision 파일, label 사칭, agent 환경) | EP-16 | Task | QA / Testing, Governance / Security | BE-1 | 3 | P1 | HIGH | MEDIUM | GOV-07 | 신규 | 미구현 |
| BE-OPS-03 | Team Mode 전환 테스트와 lock 없는 기존 Decision 이전 절차 | EP-16 | Task | QA / Testing | BE-1 | 2 | P2 | MEDIUM | MEDIUM | GOV-07 | 신규 | 미구현 |
| BE-OPS-04 | 이벤트 추가 뒤 confirm 시간·파일 수 측정 | EP-16 | Task | Performance | AI-3(BE-1 지원) | 1 | P3 | LOW | HIGH | AUD-02 | 신규 | 미구현 |
| BE-OPS-06 | Decision·이벤트 백업·복구 가이드 | EP-17 | Task | Documentation | BE-1 | 1 | P3 | LOW | HIGH | AUD-04 | 신규 | 미구현 |
| BE-OPS-07 | Team Mode 운영 가이드(CODEOWNERS, ruleset, CI) | EP-17 | Task | Documentation | BE-1 | 2 | P2 | LOW | HIGH | GOV-09 | 신규 | 미구현 |

CI 안정성(#37)은 기존 S15P31A106-233(AI-4)이 맡고 있어 새로 만들지 않았다. #34·#4는 AI-4의 기존 이슈에 의존성으로만 연결했다.

## 3. 수용 기준과 테스트

| ID | Acceptance Criteria | Tests |
|---|---|---|
| BE-GOV-03 | 스키마가 mode, people(github, gitEmails, displayName), roles, approvers(scope: paths·requirements·decisionIds)를 검증. 파일이 없으면 Local Mode. 잘못된 파일은 Truth 오류. DUO는 이 파일을 쓰지 않음 | loader 단위 테스트, 쓰기 경계 테스트 |
| BE-GOV-04 | Git `user.email`(없으면 `user.name`)로 사람을 찾고, 매핑이 없으면 "알 수 없는 사람"으로 반환(거부 사유 포함) | 단위 테스트(일치, 없음, 중복 email) |
| BE-GOV-05 | 하나의 순수 함수가 actor·mode·Decision 범위·조작으로 allow/deny와 사유, `enforcement`를 반환. confirm·reject·supersede(대상과 새 Decision 모두)가 그 결과를 따름. Local Mode 결과는 0.3.3과 같음 | 판정표 테스트, 0.3.3 fixture 회귀 |
| BE-GOV-06 | 공식 문서로 확인된 agent 환경 표지가 있으면 CLI confirm·reject·review-pending과 UI confirm·reject가 `DECISION_AGENT_ENVIRONMENT`로 거부. 메시지에 "실수 방지, 인증 아님" | 환경 변수 주입 테스트 |
| BE-GOV-07 | Team Mode에서 lock 없는 Decision, 확정 이벤트가 없는 확정 Decision이 `requireCompleteTruth` 오류. Local Mode는 변화 없음 | integrity 테스트, review·context 차단 확인 |
| BE-GOV-08 | 각 Decision의 lock, 이벤트, 승인자 매핑, 해시 체인을 검사하고 문제 목록과 종료 코드를 반환 | fixture 테스트 |
| BE-GOV-09 | base·head 사이에 바뀐 Decision 파일만 검사, PR 승인자 정보가 없으면 "병합 리뷰 필요"를 출력. workflow 예시는 `pull-requests: read`만 요구 | CI fixture, 문서 |
| BE-GOV-10 | 권한 실패의 종료 코드와 `duo.cli.decision/1` 오류 형식이 문서·테스트에 고정 | CLI e2e |
| BE-GOV-11 | UI 확정 경로가 Authorization Service 결과를 따르고 `/api/me`가 capability와 `enforcement`를 반환 | `server.test.ts` 확장 |
| BE-GOV-12 | MCP 제안 이벤트에 surface `mcp`와 label이 남고, 9개 tool과 스키마는 그대로 | `propose-contract.test.ts` |
| BE-GOV-13 | 서비스·CLI·UI·MCP·세션 계획 어느 경로로도 agent kind 확정이 불가 | 표면별 테스트 |
| BE-GOV-14 | 같은 proposal 동시 확정은 1건만 성공, 같은 대상 동시 supersede는 1건만 성공, Decision Lock·digest 유지 | 동시 실행 테스트(#34 스크립트 재사용) |
| BE-GOV-15 | CODEOWNERS가 Decision·거버넌스·release 경로를 maintainer에게 지정, ruleset이 code owner review를 요구, 기존 release 절차가 막히지 않음 | ruleset 사전 검증(T84 방식) |
| BE-GOV-16 | 지원 호스트에서 규칙을 읽어 상태를 계산, 읽지 못하면 항상 `UNVERIFIED`, `VERIFIED`도 자격증명 분리는 미확인으로 표시. review·context 판정과 종료 코드는 그대로 | 호스트 응답 mock(권한 부족, 오프라인, bypass 불가시, 조건 누락) |
| BE-GOV-17 | PR이 정책 경로를 바꾸면 결과 맨 위에 보고. base 대비 이벤트 파일 수정·삭제·이름 변경과 `basedOn` 불일치(stale 승인)는 실패 | CI fixture(병렬 확정 두 branch) |
| BE-GOV-18 | 기존 확정·대체·거절 Decision마다 `adopt` 이벤트, lock 없는 확정 Decision·무결성 오류가 있으면 bootstrap 실패, 이력은 만들어 내지 않음 | 전환 fixture(0.3.3 저장소) |
| BE-AUD-01 | 이벤트 스키마([API 계약](backend-api-contract.md) §7의 DecisionEvent)와 `decisions/events/<subject>/<eventId>.json` 쓰기 경계. 파일 1개 = 이벤트 1건, 한 번 쓴 파일은 고치지 않음. 0.3.3 loader가 무시하는 확장자(`.json`) | 스키마·경계 테스트, 0.3.3 loader 호환 테스트 |
| BE-AUD-02 | 조작마다 정확히 이벤트 1건, commit 지점과의 순서가 정의됨(파일 생성 성공 뒤 이벤트, 실패 시 repair가 보충) | 실패 주입 테스트(`DecisionFileSystem` mock) |
| BE-AUD-03 | 이벤트에 본 digest, 표면, actor label, 사유, `basedOn`·`prevHash`, stale 여부가 들어감. Git email은 `governance.yaml` opt-in일 때만 | 단위 테스트 |
| BE-AUD-04 | subject별 `basedOn`·`prevHash` 체인을 검사하고, 깨지거나 빠진 이벤트를 doctor·verify가 보고. 체인은 변조 탐지이며 서명이 아님을 출력에 명시 | 변조 fixture |
| BE-AUD-05 | Decision ID로 이벤트, 대체 사슬, lock 상태를 반환. 이벤트가 없는 기존 Decision은 파일에서 추론하고 `derived: true` | read model 테스트 |
| BE-AUD-06 | `decision history D-###`가 사람용 표와 `--json`을 출력 | CLI e2e |
| BE-AUD-07 | Team Mode에서 이벤트 없는 확정 Decision을 doctor가 action으로 표시 | doctor 테스트 |
| BE-AUD-08 | 같은 요청 재시도와 repair 재실행이 이벤트를 늘리지 않음 | 재시도 테스트 |
| BE-AUD-09 | 저장하는 개인정보와 보존 기간, 삭제 방법을 문서화 | 문서 리뷰 |
| BE-API-02 | Decision 목록·상세가 권한 상태, lock 상태, 대체 사슬, `origin: lifecycle\|manual`을 반환 | `decisions-api.test.ts`(`next`, 충족) |
| BE-API-04 | 이력 엔드포인트가 BE-AUD-05 결과를 반환 | `server.test.ts` |
| BE-API-05 | 단건 preview가 `/api/proposals`의 preview와 같은 digest | `preview-api.test.ts`(`next`, 충족) |
| BE-API-06 | `reason`이 이벤트에 저장, 없으면 생략, 길이 제한 2000 | `server.test.ts`, CLI |
| BE-API-07 | withdraw 상태가 스키마에 추가되고 pending에서 빠짐, 이벤트 기록 | service·server 테스트 |
| BE-API-09 | 새 진단 코드가 HTTP 200 + failed로 오고 CLI·UI가 같은 코드 | 계약 테스트 |
| BE-API-10 | 새 GET·POST가 세션·CSRF·Origin·Host 규칙을 그대로 따름 | `server.test.ts` |
| BE-DATA-02 | repair가 이벤트로 남고 CLI·UI 결과와 MCP 제안 응답(additive)에 보임 | 실패 주입 테스트 |
| BE-DATA-04 | 0.3.3 fixture 저장소가 새 코드에서 오류 없이 읽힘, 새 파일이 없어도 동작 | 호환 테스트 |
| BE-DATA-05 | #4 수용 기준의 lock 부분(동시 두 agent가 index를 깨지 않음) | 동시 실행 테스트 |
| BE-OPS-01 | UI 서버로 확정·거절·preview 변경·lock busy 경로 통과 | 통합 테스트 |
| BE-OPS-02 | 감사 문서 S7a~S7d 시나리오가 Team Mode에서 오류 또는 경고로 바뀜 | 보안 fixture |
| BE-OPS-03 | lock 없는 기존 Decision을 사람이 확정 이벤트와 함께 이전하는 절차와 테스트 | 이전 테스트 |
| BE-OPS-04 | confirm 시간 증가와 이벤트 파일 수를 기록 | 측정 스크립트 |
| BE-OPS-06 | Git에서 Decision·이벤트를 복원하는 절차 | 문서 리뷰 |
| BE-OPS-07 | CODEOWNERS·ruleset·CI 설정 절차와 막지 못하는 것 | 문서 리뷰 |

## 4. 합계

| 묶음 | 항목 | SP(미정 제외) | HD 없이 가능한 항목 |
|---|---|---|---|
| BE-GOV | 18 | 51 | GOV-06(사실 확인 뒤) |
| BE-AUD | 9 | 23 | 없음 |
| BE-API | 7 | 14 | API-02, API-05 |
| BE-DATA | 3(+예약 1) | 7 | DATA-05(#4 쪽 결정은 이미 있음) |
| BE-OPS | 6 | 12 | 없음 |

완료로 표시한 GOV-01·02(6 SP)를 빼면 구현 SP는 101이다(T94에서 GOV-16·17·18, 9 SP 추가). 이 중 BE-1 단독이 아닌 항목은 GOV-12(AI-2), GOV-13(AI-1), GOV-14(AI-4), OPS-04(AI-3)다.

## 5. 첫 백엔드 Sprint 제안(H-88 승인 직후, 2주)

BE-1 한 명의 PM 업무를 고려해 19 SP로 잡는다. 순서는 의존 관계 순이다.

1. BE-API-02(3), BE-API-05(1): HD 없이 지금 시작 가능, FE가 바로 쓸 수 있음
2. BE-AUD-01(3) → BE-AUD-02(5) → BE-AUD-03(2): 감사 이벤트 기반
3. BE-GOV-03(3): `governance.yaml` 스키마
4. BE-DATA-04(2): 호환 테스트를 같은 Sprint에 고정

다음 Sprint는 BE-GOV-04·05, BE-AUD-04·05·06, BE-API-04, BE-GOV-07·08 순이다. FE·AI의 해당 Sub-task(S15P31A106-306·307·311~317)는 BE 선행 항목이 병합된 뒤 시작한다. FE는 그 전에 [API 계약](backend-api-contract.md) §7 타입으로 mock 작업을 할 수 있다.

## 6. 6인 협업 경계

| 역할 | 맡는 것 | 백엔드가 먼저 줘야 하는 것 | 백엔드가 받는 것 |
|---|---|---|---|
| BE-1 | Decision·인증 아키텍처, API·도메인 계약, 데이터 무결성, 백엔드 보안, 기술 결정 | 이 문서들, ADR-015, H-88 | 각 역할의 리뷰 |
| FE-1 | 화면·상호작용, UI 상태, API 소비, 권한별 표현, 오류·로딩 UX | API-01·02·04·05 계약과 §7 타입(지금), 구현(Sprint 1~2) | 화면 요구로 필요한 필드 |
| AI-1 | Decision Compliance, Context·Review 정책, 오탐·미탐, 평가 시나리오 | Authorization Service(GOV-05), 이벤트 형식(AUD-01) | 우회 방지 테스트(GOV-13), Team Mode에서 review가 Decision 권한을 읽는 규칙 검토 |
| AI-2 | MCP Tool, Codex·Claude Code 연동 | 제안 이벤트 형식(AUD-03), repair 노출 방식(DATA-02) | MCP 출력 additive 변경(GOV-12), `duo_get_decision` 이력 요약 여부 |
| AI-3 | A/B/C 평가, 성능·토큰·비용 측정 | 이벤트(승인 횟수·대기 시간 측정 근거) | 승인 마찰 측정, OPS-04 |
| AI-4 | Multi-Agent, 동시 실행·충돌 검증, Session Handoff | 서비스의 lock·repair 동작 설명(현재 구조 문서) | #34 결과(DATA-03), GOV-14 동시성 테스트, #4 안전 조건(S15P31A106-255) |

코드가 겹치는 곳과 선행 PR:

| 영역 | 겹치는 작업 | 순서 |
|---|---|---|
| `packages/core/src/decisions/*` | GOV-05, AUD-02(BE-1) / GOV-13(AI-1), GOV-14(AI-4) 테스트 | BE PR 먼저 병합. AI 테스트는 그 위에서 `*.test.ts`만 추가 |
| `packages/integration/src/http/server.ts` ↔ `packages/ui/src/*` | API-02·04·05, GOV-11(BE-1) / 화면(FE-1) | API PR 먼저. FE는 mock으로 병행하고 API 병합 뒤 연결 |
| `packages/integration/src/mcp/tools.ts` ↔ `operations/propose.ts` | GOV-12(AI-2) / AUD-03, DATA-02(BE-1) | BE가 operation 결과에 필드를 추가한 뒤 AI-2가 tool 출력에 반영 |
| `packages/graph/src/incremental/*` | DATA-05(BE-1) / #34·S15P31A106-255·257(AI-4) | AI-4의 안전 조건 결론 → BE lock 구현 → AI-4 테스트 |

GitHub 계정과 역할은 이 문서에서 연결하지 않는다. 팀원이 Issue 댓글로 역할을 고르면 그때 담당자를 지정한다.

## 7. Jira·GitHub 반영 방법

- **기존 Jira 이슈:**
  - S15P31A106-236·237·243에는 이 PR과 문서를 댓글로 연결했다.
  - 상태는 Maintainer 승인 뒤 바꾼다. 근거 없이 상태를 바꾸지 않는다.
- **분할 대상:**
  - S15P31A106-244 → BE-AUD-05와 BE-AUD-06
  - S15P31A106-238 → BE-GOV-03과 BE-GOV-04
  - 분할은 H-88 뒤 Sub-task로 만든다.
- **신규 항목:**
  - H-88 승인 뒤 이 표를 manifest로 Jira에 생성한다.
  - 레이블: `owner-*`, `c-*`, `risk-*`, `conf-*`, `needs-hd`(HD 항목)
  - GitHub Issue는 구현을 시작하는 항목만 만든다.
- **#25·#26:** 이 PR이 각 Issue의 문서 수용 기준을 채운다. Issue는 Maintainer가 결정한 뒤 닫는다.

