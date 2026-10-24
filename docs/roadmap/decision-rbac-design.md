# Decision 승인 권한(RBAC)과 신뢰 경계 설계(#25, T87)

상태: **제안(Maintainer 승인 전, T87 초안, T94 수정)**. 이 문서는 [Issue #25](https://github.com/kanghyunsoon/duo/issues/25)의 설계 산출물이다. 제품 규칙은 바뀌지 않았고, 승인되면 [ADR-015](../adr/ADR-015-decision-authority-team-mode.md)(proposed)와 Human Decision으로 확정한다. 현재 구조는 [backend-architecture-current.md](backend-architecture-current.md), 감사 Gap은 [decision-audit-gap.md](decision-audit-gap.md)에 있다.

## 1. 권장안 요약

**C(GitHub CODEOWNERS + ruleset의 필수 리뷰)를 팀의 실제 신뢰 경계로 쓰고, 로컬 DUO는 실수 방지와 감사 기록을 맡는다.** 구체적으로는 다음 네 가지를 묶는다.

1. **Local Mode(기본값)는 지금 동작을 유지한다.** human만 확정하는 규칙, TTY와 ID 재입력, preview digest 바인딩을 그대로 둔다. 문구도 "인증이 아니다"를 유지한다.
2. **Team Mode(선택)를 `.duo-project/governance.yaml`로 켠다.** 역할과 Decision 범위별 승인자를 적는다. 로컬 승인자 검사는 실수 방지용 경고·거부이며 보안 통제라고 부르지 않는다.
3. **Team Mode에서 Decision의 팀 권한은 보호 branch에 병합될 때 생긴다.**
   - `.duo-project/decisions/**`와 `governance.yaml`은 CODEOWNERS 승인자의 리뷰 없이는 병합되지 않게 한다.
   - CI 검증(`duoctl decision verify --ci`)이 lock, 확정 이벤트, 승인자 매핑을 확인한다.
   - lock이 없거나 이벤트가 없는 Decision 파일은 Team Mode에서 오류(fail-closed)다.
   - 이 보장은 §12의 전제(호스트가 code owner 리뷰를 필수로 강제, 정책 경로에 관리자 bypass 없음, agent 환경에 승인·병합·bypass 가능한 토큰 없음)가 있을 때만 주장한다. DUO가 호스트 설정을 확인하지 못하면 신뢰 상태는 `UNVERIFIED`다.
4. **감사 이벤트(BE-AUD)를 추가한다.** 실패와 복구를 포함해 승인 이력을 Git이 추적하는 이벤트 파일로 남긴다. 이벤트는 "주장"이고, 신뢰는 그 이벤트가 리뷰를 거쳐 병합됐다는 사실에서 나온다.

서명 승인(D)은 GitHub를 쓰지 않거나 오프라인 증명이 필요한 팀을 위한 후속 확장으로 미룬다.

**이유:** 같은 OS 사용자로 도는 에이전트는 로컬 파일, PTY, 로컬 HTTP를 모두 쓸 수 있다(T87 재현). 그래서 로컬에서 할 수 있는 것은 실수 방지와 변조 감지뿐이다. 에이전트의 OS 권한 밖에서 사람을 인증하는 곳은 Git 호스팅 서버다. DUO 저장소도 이미 GitHub ruleset을 쓴다.

## 2. 위협 모델

| 행위자 | 가진 능력 | 예 |
|---|---|---|
| Maintainer | 저장소 쓰기, GitHub 관리자 | BE-1 |
| Developer | 저장소 쓰기(collaborator) | FE-1, AI-1~4 |
| AI agent(MCP만) | MCP 9개 tool | 샌드박스가 셸을 막은 agent |
| AI agent(셸 포함) | 같은 OS 사용자의 파일 쓰기, PTY, 로컬 HTTP, 사용자의 `gh` 인증을 그대로 쓸 수 있음 | Codex·Claude Code의 셸 도구 |
| 사칭하는 팀원 | 자기 컴퓨터에서 Git `user.name`·파일을 마음대로 설정 | |
| 저장소 권한이 없는 외부인 | 없음(로컬 UI는 127.0.0.1, 세션·CSRF로 다른 웹 페이지 차단) | |

| 위협 | 설명 | 지금(0.3.3) |
|---|---|---|
| W1 정직한 실수 | 잘못된 사람이 확정, agent가 의도치 않게 확정 시도 | MCP에는 확정 도구가 없고 서비스가 agent kind를 거부. CLI는 TTY와 ID 재입력 |
| W2 agent가 사람용 표면을 조작 | PTY로 CLI 확정, 셸에서 `duoctl ui`를 띄워 API 호출 | **막지 못함**(T87 재현 S2, S4) |
| W3 팀원 사칭 | `git config user.name`을 바꿔 확정 | **막지 못함**(S7b, `confirmed_by: ui:Mallory`) |
| W4 파일 직접 작성 | lock 없는 `D-###.yaml` 작성, lock digest 재계산 | **막지 못함**(S7c). lock은 실수 감지용 |
| W5 이력 조작 | rebase, force push로 Decision commit 지우기 | DUO 범위 밖. GitHub ruleset(force push 금지)이 막음 |
| W6 본 것과 다른 내용 확정 | preview 뒤 proposal 변경 | **막음**(`DECISION_CONFIRM_PREVIEW_CHANGED`, S2) |
| W7 관리자 bypass | ruleset bypass를 가진 사람(또는 그 토큰)이 리뷰 없이 Decision·정책 변경을 보호 branch에 넣음 | DUO 범위 밖. Team Mode 전제에서 정책 경로 bypass를 없애거나 잔여 위험으로 표시(§13) |
| W8 agent가 사람의 호스팅 토큰 사용 | 셸 agent가 승인자의 `gh` 인증으로 PR 승인·병합 | **막지 못함.** 운영 요건(agent 환경 토큰 분리)으로만 다룸. 충족을 확인할 수 없으므로 강한 보장은 이 전제가 있을 때만 주장(§12) |
| W9 정책·CI 약화 PR | PR이 workflow, CODEOWNERS, `governance.yaml`, 검증 버전을 바꿔 검사를 끄거나 자기 승인을 만듦 | 필수 code owner 리뷰로만 막음. 리뷰어가 놓치면 통과(§13) |

**핵심 한계:** 공격자(agent 포함)가 같은 파일 시스템 권한을 가지면 로컬 DUO는 완전한 RBAC를 강제할 수 없다. 로컬에서 "관리자 플래그"나 역할 설정을 확인하는 기능은 실수 방지(UX)로만 설명한다.

## 3. 현재 권한(0.3.3)

| 조작 | human | agent | system | 실제 강제 위치 | 우회 |
|---|---|---|---|---|---|
| propose | O | O | O | `DECISION_PERMISSIONS.propose` | 해당 없음 |
| confirm | O | X | X | 서비스 kind 검사 + `guardDecisionWrite`(Decision 파일은 human만) | kind는 호출자가 정함. CLI·UI는 human 고정이라 조작하면 통과(W2) |
| reject | O | X | X | 서비스 kind 검사 | 같음 |
| supersede | confirm과 같음 | | | | 같음 |
| Decision 파일 직접 편집 | 허용(ADR-013 fallback) | 막는 장치 없음 | | OS 권한 | W4 |

## 4. 역할과 권한 매트릭스(제안)

역할 정의:

- **ADMIN(Maintainer):** 모든 Decision 확정과 거버넌스 변경
- **APPROVER:** `governance.yaml`에서 특정 Decision 범위의 승인자로 지정된 DEVELOPER
- **DEVELOPER:** 제안만 가능
- **AI_AGENT:** 제안만 가능
- **READ_ONLY:** 조회만 가능

"강제 위치"의 **로컬**은 같은 OS 사용자가 우회할 수 있는 실수 방지다. **GitHub**는 병합 시 인증된 리뷰다.

| 조작 | ADMIN | APPROVER | DEVELOPER | AI_AGENT | READ_ONLY | 강제 위치(Team Mode) |
|---|---|---|---|---|---|---|
| Project Truth 조회 | O | O | O | O | O | 없음(공개 파일) |
| Decision 조회 | O | O | O | O | O | 없음 |
| Proposal 생성 | O | O | O | O | X | 로컬(READ_ONLY는 저장소 쓰기 권한이 없음) |
| Proposal 취소(withdraw, 신규 조작) | O(모두) | 자기 것 | 자기 것 | 자기 label 것 | X | 로컬. 0.3.3에는 취소 조작이 없다 |
| Confirm | O | 자기 범위 | X | **X** | X | 로컬 경고·거부 + **GitHub code owner 리뷰** |
| Reject | O | 자기 범위 | X | **X** | X | 같음 |
| Supersede | O | 대상과 새 Decision 모두 자기 범위 | X | **X** | X | 같음 |
| Audit 조회 | O | O | O | O | O | 없음 |
| 권한 설정 변경(`governance.yaml`) | O | X | X | X | X | **GitHub CODEOWNERS(maintainer)** |
| 보안 정책 변경(ruleset, CODEOWNERS, release 정책) | O | X | X | X | X | **GitHub 관리자 권한** |

AI_AGENT가 Confirm·Reject·Supersede를 끝내지 못하게 하는 장치는 두 겹이다.

1. **로컬(실수 방지):** MCP에는 확정 도구가 없고, 서비스는 agent kind를 거부한다. 신규로 agent 실행 환경 감지 거부(BE-GOV-06)를 둔다.
2. **팀(강제):** agent가 셸로 사람용 표면을 조작해 Decision 파일을 만들더라도, 보호 branch에 들어가려면 code owner인 사람의 GitHub 리뷰가 필요하다.

## 5. 옵션 비교

A: 현재 actor label 정책 유지. B: Decision별 owner·approver 목록과 Git identity 확인. C: GitHub CODEOWNERS·ruleset·필수 리뷰를 신뢰 경계로 사용. D: 서명된 승인 이벤트(SSH/GPG) 또는 별도 승인 서비스.

| 기준 | A label | B approver + Git identity | C CODEOWNERS + ruleset | D 서명 승인 |
|---|---|---|---|---|
| 실제 강제 범위 | 없음(기록만) | 정직한 실수(범위 밖 승인자) | 보호 branch 병합 시 인증된 사람의 리뷰 | 서명 키 보유자만 승인 이벤트 생성 |
| agent가 OS 파일에 직접 쓸 때 | 우회 | 우회 | 로컬은 우회, 병합에서 막힘 | 키가 잠겨 있거나 하드웨어 키 터치가 필요하면 막힘. ssh-agent에 풀린 키가 있으면 우회 |
| 다른 개발자의 사람 사칭 | 가능 | 가능(`user.name`·`user.email`은 자유) | 병합 단계에서 불가(GitHub 계정 인증) | 불가(상대 개인 키 필요) |
| 오프라인 사용 | O | O | 로컬 작업은 O, 팀 권한은 push·병합 때 | O(검증도 로컬) |
| 기존 CLI 호환 | 그대로 | 추가 경고·거부만 | 그대로(CI 명령 추가) | confirm마다 서명 단계 추가 |
| MCP·UI 호환 | 그대로 | UI에 승인 가능 여부 표시 | 그대로 | UI가 서명을 대신 못 함(CLI로 넘겨야 함) |
| 초기 설치 복잡도 | 없음 | `governance.yaml` 작성 | CODEOWNERS·ruleset(관리자 1회) + CI step | 사람마다 키, allowed_signers 관리, OS별 `ssh-keygen -Y` 지원 확인 |
| 사용자 승인 횟수 | 확정 1회 | 확정 1회 | 확정 1회 + PR 리뷰 1회(여러 Decision 묶음 가능) | 확정 1회 + 서명(패스프레이즈·터치) |
| GitHub 의존 | 없음 | 없음 | 있음(GitLab은 CODEOWNERS·approval rule로 대응 가능, 미검증) | 없음 |
| 구현 비용 | 0 | 중간(스키마, 검사, UI 표시) | 작음~중간(CI 검증, 문서. 강제는 GitHub가 함) | 큼(이벤트 형식, 서명·검증, 키 관리 UX) |
| 데이터 마이그레이션 | 없음 | `governance.yaml` 신규(선택) | 없음 | 기존 Decision은 서명 없음(legacy 표시) |
| 운영 위험 | 보안이 있다고 오해 | B를 보안으로 오해 | 로컬 branch의 미병합 Decision은 병합 전까지 그 branch에서 권한을 가짐. agent가 maintainer의 `gh` 토큰으로 GitHub를 조작할 수 있으면 우회 | 키 분실·유출, 키 회전 |

각 옵션이 **막지 못하는 것**:

- **A:** W2, W3, W4 전부. 감사 기록의 승인자 이름을 믿을 수 없다.
- **B:**
  - W3: 팀원이 `user.email`을 승인자의 것으로 바꾸면 통과한다.
  - W2, W4: 같은 OS 사용자의 agent는 둘 다 할 수 있다.
  - B는 "범위 밖 사람이 실수로 확정"만 줄인다.
- **C:**
  - 병합 전 로컬 branch: 위조된 Decision이 그 branch의 review·context에서는 권한으로 쓰인다.
  - 관리자 bypass: ruleset bypass를 가진 사람이 리뷰 없이 병합할 수 있다.
  - 사용자의 `gh` 토큰을 쓰는 agent:
    - 토큰이 PR 승인·병합 권한을 가지면 사람처럼 행동할 수 있다.
    - 이 작업 환경도 셸 agent가 maintainer 계정의 `gh` 인증을 쓴다. 리뷰 규칙("작성자 아닌 승인자")과 bypass 금지가 함께 있어야 한다.
  - GitHub 밖으로 복사된 저장소: 보호가 없다.
- **D:**
  - 같은 사용자 세션에서 풀려 있는 서명 키: agent가 서명할 수 있다.
  - allowed_signers 파일: 그 파일 자체를 C나 다른 방법으로 보호해야 한다.
  - 승인 내용과 무관한 정책 판단: 서명은 "누가"를 증명할 뿐 "그 사람이 그 범위의 승인자인가"는 따로 검사해야 한다.

## 6. 운영 모델(제안, 승인 전)

| | Local Mode(기본) | Team Mode(선택) |
|---|---|---|
| 켜는 방법 | 아무것도 하지 않음 | `.duo-project/governance.yaml`(형식 `duo.governance/1`, 사람이 작성, CODEOWNERS로 보호) |
| 확정 규칙 | 지금과 같음(human kind) | 지금 규칙 + 로컬 승인자 검사(Git email이 해당 범위 승인자가 아니면 거부, 실수 방지) |
| lock 없는 Decision 파일 | ADR-013 수동 fallback으로 인정 | 오류(`DECISION_TEAM_LOCK_REQUIRED`, fail-closed). 기존 파일은 확정 이벤트와 lock을 받는 이전 절차 제공 |
| 감사 이벤트 | 기록(`decisions/events/`) | 기록 + 이벤트 없는 확정 Decision은 오류 |
| 팀 권한의 근거 | 로컬 파일 | 보호 branch 병합(code owner 리뷰) + CI 검증 |
| agent 실행 환경 감지 | 확정 거부(실수 방지, 우회 가능하다고 명시) | 같음 |
| 필요한 외부 설정 | 없음 | CODEOWNERS(정책 경로 포함), ruleset(승인 1건 이상, code owner 리뷰 필수, stale 승인 해제, 마지막 push 승인, force push 금지, 정책 경로 bypass 없음), CI의 `pull-requests: read`, agent 환경의 토큰 분리(운영 요건) |
| 신뢰 상태 표시 | `LOCAL` | `VERIFIED` / `NOT_MET` / `UNVERIFIED`(§12) |

## 7. 권장안의 근거

1. **신뢰 경계를 실제로 강제할 수 있는 곳에 둔다.**
   - 로컬에서 인증을 흉내 내면(B 단독) 사용자가 보안이 있다고 오해한다(A·B의 운영 위험).
   - C는 이미 인증된 GitHub 계정과 ruleset을 쓰므로 DUO가 인증 서버를 만들 필요가 없다.
2. **Local-first를 지킨다.**
   - Local Mode는 바뀌지 않는다.
   - Team Mode도 로컬 작업과 오프라인 확정을 그대로 허용한다. 팀 권한만 병합 때 생긴다.
3. **공개 /1 형식을 깨지 않는다.**
   - Decision·Proposal 스키마는 1단계에서 바꾸지 않는다.
   - 이벤트와 `governance.yaml`은 새 선택 파일이다.
   - MCP 9개 tool도 그대로다.
4. **감사 Gap의 CRITICAL 두 개를 직접 다룬다.**
   - 승인자 신원: 병합 리뷰로 다룬다.
   - lock 없는 위조 Decision: Team Mode fail-closed로 다룬다.
   - HIGH Gap(사유, 본 digest, 복구 이력)은 이벤트로 다룬다.
5. **D를 막지 않는다.** 이벤트 형식에 서명 필드를 넣을 자리를 두면, 나중에 GitHub 밖의 팀을 위해 서명 검증을 더할 수 있다.

## 8. 호환성

| 대상 | 변화 |
|---|---|
| `D-###.yaml`, `P-###.yaml` 스키마 | 1단계 변화 없음. 대체 시각·승인 사유는 이벤트에 기록 |
| `governance.yaml` | 신규 선택 파일. loader 스키마와 쓰기 경계(project-truth, DUO는 쓰지 않음)에 추가 |
| `decisions/events/` | 신규 tracked 영역(project-truth 안, DecisionService만 씀). 이벤트 1건당 `.json` 파일 1개(§14). 0.3.3 loader는 `decisions/`에서 `.yaml`·`.yml`만 읽으므로 이 파일을 무시한다 |
| Decision Lock | 변화 없음(대상 필드 그대로) |
| UI API | additive(`/api/me`, 이력 조회, confirm 사유 선택 필드). [backend-api-contract.md](backend-api-contract.md) |
| MCP | 9개 tool 이름·스키마 그대로. 확정 도구 없음 유지 |
| CLI | 신규 하위 명령(`decision history`, `decision verify`, `decision withdraw`), 신규 진단 코드. 기존 종료 코드 의미 유지 |
| 기존 저장소 | Local Mode 기본이라 아무것도 바뀌지 않음. Team Mode 전환은 §15 |
| 0.3.3 이하 클라이언트 | `governance.yaml`을 읽지 않으므로 Team Mode 저장소를 Local Mode로 다룬다. 팀 권한은 병합 리뷰가 강제하므로 안전성은 유지되지만, 로컬 경고는 보이지 않는다. CI는 Team Mode를 아는 버전으로 고정한다 |

## 9. 구현에 필요한 테스트

- agent actor는 서비스, CLI, UI 서버, MCP, 세션 계획 어느 경로로도 confirm·reject·supersede를 끝내지 못한다(기존 테스트 확장).
- agent 실행 환경으로 감지되면 CLI·UI 확정이 거부되고, 메시지가 "인증이 아니다"를 말한다.
- Team Mode: 승인자가 아닌 Git email의 확정은 거부, 범위 밖 supersede도 거부.
- Team Mode: lock 없는 Decision과 이벤트 없는 확정 Decision은 `requireCompleteTruth` 오류.
- Local Mode: 기존 저장소와 0.3.3 fixture가 그대로 통과(회귀).
- 이벤트: confirm·reject·repair·실패마다 이벤트 1개, 같은 요청 재시도는 중복 이벤트 없음, 해시 체인 깨짐 감지.
- CI 검증: Decision 파일이 바뀐 PR에서 lock·이벤트·승인자 매핑을 검사하고, 위반 시 실패.
- 동시 확정: 같은 proposal 두 번, 같은 대상을 두 proposal이 supersede(#34와 공유).
- 신뢰 상태: 호스트 설정을 읽을 수 없을 때, 미지원 호스트일 때, code owner 리뷰가 꺼져 있을 때 각각 `UNVERIFIED`, `UNVERIFIED`, `NOT_MET`. `VERIFIED` 표시에도 자격증명 전제는 "확인되지 않음"으로 함께 나온다.
- 정책 경로: PR이 workflow·CODEOWNERS·`governance.yaml`·검증 버전을 바꾸면 CI 출력이 그 사실을 맨 위에 보고한다.
- 이벤트: 기존 이벤트 파일의 수정·삭제·이름 변경이 있는 PR은 CI 실패. 같은 Decision에 같은 `based_on`을 가진 확정 이벤트가 둘이면 나중 병합 쪽이 실패.
- 전환: bootstrap PR이 lock 없는 확정 Decision을 남기면 실패하고, Team Mode가 켜지지 않는다.

## 10. Maintainer가 결정할 항목(초안 H-88, 미승인)

T94에서 선택지와 권고를 붙였다. 권고는 설계 제안일 뿐 결정이 아니다.

| # | 결정 | 선택지 | 권고 | 결정 전 영향 |
|---|---|---|---|---|
| 1 | Team Mode 신뢰 경계 | C(호스트 병합 리뷰) / D(서명) / A·B 유지 | C, D는 후속 | Team Mode 구현 전체가 대기 |
| 2 | Team Mode를 `governance.yaml` 선택 기능으로, 역할 다섯 개 | 채택 / 역할 축소(APPROVER·DEVELOPER만) | 채택 | BE-GOV-03 이후 대기 |
| 3 | 자격증명 전제(agent 환경에 승인·병합·bypass 가능 토큰 금지)를 Team Mode 필수 운영 요건으로 둘지 | 필수 요건 / 권장 사항 | **필수 요건.** 없으면 강한 보장을 주장하지 않음 | 미결이면 ADR-015 승인 불가 |
| 4 | 정책 경로의 관리자 bypass | bypass 없음 / PR 병합만 허용하는 bypass / 현행 유지(잔여 위험 표시) | 정책 경로는 bypass 없음. release 경로와 ruleset을 나눔 | DUO 저장소 ruleset 제안(§13.4) 적용 여부와 연결 |
| 5 | 신뢰 상태 이름과 표시 위치(`LOCAL`·`VERIFIED`·`NOT_MET`·`UNVERIFIED`; doctor·status·UI·CI) | 채택 / 이름 변경 | 채택 | API-01 mock 필드 이름 |
| 6 | 지원 호스트 | GitHub만 / GitHub + 수동 확인된 호스트 목록 | GitHub만으로 시작. GitLab(SSAFY mirror)은 확인 전 `UNVERIFIED` | 없음 |
| 7 | Team Mode에서 lock·이벤트 없는 Decision을 오류로(ADR-013 fallback 제한) | 오류 / 경고 | 오류(fail-closed) | BE-GOV-07 |
| 8 | 감사 이벤트 저장 방식과 개인정보 | 이벤트당 파일(§14) / Decision당 append 파일 | 이벤트당 파일, Git email 기본 미저장(opt-in) | BE-AUD-01 |
| 9 | 실패·중단 흐름 기록 범위 | 사용자 의도 뒤의 실패만 / 모든 실패 / 기록 안 함 | 사용자 의도 뒤의 실패(digest 변경, 권한 거부, 중단 repair)만 | BE-AUD-02 |
| 10 | 기존 저장소 전환(bootstrap PR, §15) | bootstrap 승인 = 기존 Decision 신뢰 출발점 / Decision마다 재확정 | bootstrap 승인 | BE-OPS-03 |
| 11 | agent 실행 환경 감지 거부(실수 방지) | 넣음 / 넣지 않음 | 공식 문서로 표지를 확인한 뒤 넣음 | BE-GOV-06 |
| 12 | DUO 저장소 자체에 CODEOWNERS·code owner 리뷰 적용(Jira S15P31A106-246) | 지금 / Team Mode 구현 뒤 | 정책 경로 공동 owner가 2명 이상 정해진 뒤 | 저장소 운영 |
| 13 | 개인 저장소에서 required workflow를 쓸 수 없는 한계(§16) | 한계를 받아들이고 status check + workflow 경로 code owner 리뷰로 운영 / organization으로 이전해 required workflow 사용 | 개인 저장소에서는 Team Mode의 CI 보호를 "리뷰 의존"으로 명시. 이전 여부는 팀 운영 결정 | Team Mode의 CI 강제 수준 |
| 14 | 정책 보호 ruleset의 bypass 모드 | `exempt` 금지, 필요하면 `pull_request` / 현행 `always` 유지(잔여 위험) | `exempt` 금지 | DUO 저장소 ruleset 제안(§13.4) |

## 11. 구현 전에 확인할 사실

- 각 agent가 공식 문서에 남긴 실행 환경 변수(감지 기준). 추측한 변수 이름으로 구현하지 않는다.
- CI에서 PR 리뷰를 읽는 데 필요한 GitHub 권한과 fork PR에서의 동작
- (T97) 같은 GitHub Actions 앱 안에서 같은 이름의 job이 필수 check를 채우는지 임시 저장소에서 재현(§16 미검증 행)
- GitHub의 branch 규칙 조회 API가 읽기 권한으로 무엇을 보여 주는지. 특히 bypass 대상 목록은 관리자 권한 없이 보이지 않을 수 있다. 보이지 않으면 bypass 항목은 `UNVERIFIED`로 둔다.
- PR의 필수 code owner가 base branch의 CODEOWNERS로 정해지는지(PR이 CODEOWNERS를 바꿔 자기 승인을 만들 수 없는지) 실제 저장소에서 확인
- 필수 status check가 이름만으로 맞춰질 때, 같은 이름의 다른 workflow job이 성공 status를 낼 수 있는지
- GitLab mirror(SSAFY)에서 같은 보호를 쓸 수 있는지
- Windows·macOS·Linux에서 `ssh-keygen -Y sign/verify` 사용 가능 여부(D를 할 때)

## 12. 신뢰 상태와 Team Mode 보장 범위(T94)

### 12.1 상태

| 상태 | 조건 | 사용자에게 하는 말 |
|---|---|---|
| `LOCAL` | `governance.yaml` 없음 | "Local Mode: 확정 기록은 실수 방지이며 인증이 아닙니다" |
| `VERIFIED` | 지원 호스트에서 기본 branch 규칙을 읽었고 §2 W7·W9 대응 조건(승인 1건 이상, code owner 리뷰 필수, stale 승인 해제, 마지막 push 승인, force push·삭제 금지, 정책 경로 bypass 없음)이 모두 확인됨 | "호스트 보호 확인됨. agent 환경의 토큰 분리는 DUO가 확인할 수 없습니다" |
| `NOT_MET` | 읽었지만 조건 중 하나 이상이 빠짐 | 빠진 조건 목록과 설정 위치 |
| `UNVERIFIED` | 권한 부족, 오프라인, 미지원 호스트, API 오류, bypass 목록을 볼 수 없음 | "호스트 보호를 확인하지 못했습니다. 팀 권한을 보장한다고 표시하지 않습니다" |

- 확인 결과는 시각과 함께 캐시하지 않고 매번 표시 시점에 다시 읽는다. 읽지 못하면 `UNVERIFIED`다.
- 상태는 표시용이다. review·context 판정과 종료 코드를 바꾸지 않는다. CI의 `decision verify --ci`에서 `NOT_MET`을 실패로 할지는 저장소 설정으로 둔다(PROPOSED).

### 12.2 보장하는 것(`VERIFIED`이고 §3 자격증명 전제를 사람이 지킨 경우)

- 보호 branch에 들어간 Decision·정책 변경은 code owner인 인증된 호스팅 계정의 승인을 거쳤다.
- 승인 뒤 바뀐 내용은 그 승인으로 병합되지 않는다(stale 승인 해제, 마지막 push 승인).
- 병합된 이력은 force push로 지워지지 않는다.
- 확정한 내용은 그 사람이 본 preview와 같다(`DECISION_CONFIRM_PREVIEW_CHANGED`, 기존).

### 12.3 보장하지 않는 것

- 승인한 계정 뒤에 사람이 있었는지(agent의 토큰 사용, 계정 탈취)
- 저장소 관리자가 규칙을 끄거나 바꾸는 것
- 병합 전 branch에서의 Decision 권한, 호스팅 밖 복사본
- CI runner와 GitHub 자체의 무결성
- 이벤트에 적힌 사유·label의 진실성

## 13. 정책·CI 보호(T94)

### 13.1 보호 대상 경로

| 경로 | 약화되면 생기는 일 | 방어 | 한계 |
|---|---|---|---|
| `.github/workflows/**` | `pull_request` workflow는 PR 쪽 정의로 실행되므로, PR이 검증 job을 지우거나 항상 성공하게 바꿀 수 있다. 필수 status check는 이름으로만 맞추므로 같은 이름의 다른 job이 채울 수 있다고 가정한다(§16) | CODEOWNERS + 필수 code owner 리뷰. 필수 status check로 job 이름 고정(job이 사라지면 check가 오지 않아 병합 불가) | 같은 이름의 다른 job으로 check를 채우는 경로는 §11에서 확인 필요. 리뷰어가 놓치면 통과 |
| CODEOWNERS | PR이 owner를 자기로 바꿔 자기 승인을 만듦 | CODEOWNERS 자체를 owner 대상에 넣음. 필수 owner는 base branch의 파일로 정해지는지 확인(§11) | 관리자 bypass |
| `.duo-project/governance.yaml` | 자기를 APPROVER로 넣거나 Team Mode를 끔 | owner 대상. 끄는 것도 이 파일 변경이라 리뷰 대상 | 같음 |
| `.duo-project/decisions/**`(이벤트 포함) | 위조 Decision, 이벤트 수정·삭제 | owner 대상. CI가 lock·이벤트·append-only를 검사(§14) | 리뷰어가 승인하면 들어감 |
| Decision 검증 설정(workflow 안의 `duoctl` 버전 고정, lockfile) | 검사가 없는 옛 버전이나 다른 패키지로 바꿈 | 정확한 버전 고정(`@duo-director/cli@<version>`)과 lockfile을 owner 대상에 넣음 | 같음 |

### 13.2 공격 경로

1. PR이 workflow를 바꿔 verify를 건너뛴다.
2. PR이 CODEOWNERS나 `governance.yaml`을 바꿔 자기 승인을 만든다.
3. PR이 검증 버전을 낮추거나 패키지를 바꾼다.
4. `pull_request_target`을 쓰는 workflow가 신뢰하지 않는 코드에 쓰기 토큰을 준다. DUO 예시 workflow는 `pull_request_target`을 쓰지 않는다.
5. fork PR: 토큰은 읽기 전용이다. 리뷰 조회 권한이 fork PR에서 어떻게 동작하는지 §11에서 확인한다.
6. 관리자 bypass나 관리자의 토큰을 가진 agent가 리뷰 없이 병합한다(W7, W8).

### 13.3 DUO가 하는 일과 한계

- `decision verify --ci`(PROPOSED)는 PR이 정책 경로를 바꾸면 그 사실을 결과 맨 위에 보고해, 리뷰어가 놓치지 않게 한다. 정책 변경 자체를 거부하지는 않는다. 정책을 정하는 것은 사람의 리뷰다.
- DUO는 자기 검증이 실행되었는지 스스로 보장할 수 없다. 실행을 강제하는 것은 호스트의 필수 check와 code owner 리뷰다.

### 13.4 DUO 저장소 ruleset 제안(적용하지 않음)

현재(T84 적용): `next`는 승인 1·stale 해제·마지막 push 승인·3 OS check, code owner 리뷰 꺼짐. 모든 branch 규칙에 관리자 bypass(always). 저장소에 CODEOWNERS 없음.

제안(별도 승인 뒤, T84처럼 임시 branch로 사전 검증):

1. CODEOWNERS: `.github/`, `CODEOWNERS`, `.duo-project/`, `docs/conflicts.md`, `scripts/release/`에 maintainer와 지정 리뷰어 1명 이상
2. `next-integration`: `require_code_owner_review: true`
3. 정책 경로에는 bypass가 없도록, release용 bypass ruleset과 일반 PR 규칙을 나눈다. GitHub ruleset의 파일 경로 조건은 저장소 종류와 요금제에 따라 쓸 수 없을 수 있으므로 적용 전에 확인한다.
4. 이 저장소의 작업 환경(maintainer 계정의 `gh` 인증을 쓰는 agent)을 승인·bypass 권한이 없는 토큰으로 바꾼다. 바꾸기 전에는 DUO 저장소 자체도 §3 자격증명 전제를 충족하지 않는다.

## 14. 감사 이벤트 설계(T94 수정)

### 14.1 저장

- 위치: `.duo-project/decisions/events/<subject>/<eventId>.json`. `subject`는 `D-###` 또는 `P-…`. 이벤트 1건당 파일 1개다.
- `eventId`: UTC 시각(밀리초)과 무작위 접미사. 파일 이름이 겹치지 않아 병렬 branch의 이벤트가 Git 충돌을 만들지 않는다.
- 확장자는 `.json`이다. 0.3.3 loader가 `decisions/` 아래 `.yaml`·`.yml`을 Decision 원본으로 읽기 때문이다.
- DecisionService만 쓴다. 한 번 쓴 파일은 고치지 않는다.

### 14.2 필드(`duo.decision-event/1`, PROPOSED)

| 필드 | 내용 |
|---|---|
| `eventId`, `at`, `op` | `op`: propose, confirm, reject, withdraw, supersede-mark, repair, confirm-failed, confirm-interrupted, adopt(§15) |
| `subject` | Decision·proposal ID, supersede 대상 |
| `actor` | `kind`, `label`(Git `user.name` 또는 `ui:` label), `surface`(cli, ui, mcp, session, repair). 인증이 아님 |
| `reviewedDigest` | 확정한 사람이 본 preview digest(Approval Preview Digest) |
| `lockDigest` | 확정 직후 Decision Lock digest |
| `basedOn` | 이 이벤트를 쓸 때 같은 subject의 마지막 이벤트 ID(없으면 null) |
| `prevHash` | `basedOn` 이벤트 파일의 SHA-256 |
| `requestId` | 같은 요청 재시도의 중복 방지 |
| `reason` | 선택, 2000자, 기존 secret redaction 적용 |
| `diagnostics` | 실패·중단 이벤트의 진단 코드 |

Git email은 기본으로 저장하지 않는다(commit 메타데이터에 이미 있다). 필요하면 `governance.yaml`의 opt-in으로만 넣는다. host 이름, 저장소 밖 경로, 환경 변수는 넣지 않는다.

### 14.3 삭제·변경 탐지

- CI(`decision verify --ci`): base 대비 `decisions/events/`의 기존 파일이 수정·삭제·이름 변경되면 실패한다(append-only).
- 로컬(doctor, verify): 각 이벤트의 `basedOn`·`prevHash`가 가리키는 파일이 있고 해시가 맞는지 본다. 가운데가 빠지거나 바뀌면 보고한다.
- 마지막 이벤트를 지우는 것은 내용만으로 알 수 없다. base와 비교하는 CI와 Git 이력이 잡는다.

### 14.4 병렬 confirm·supersede와 stale 승인

- 두 branch가 같은 proposal을 확정하거나 같은 Decision을 supersede하면, 두 이벤트의 `basedOn`이 같다.
- CI는 PR의 새 이벤트마다 `basedOn`이 base에서 그 subject의 마지막 이벤트인지 확인한다. 아니면 **stale 승인**으로 실패한다. 먼저 병합된 쪽만 유효하고, 나중 쪽은 rebase한 뒤 다시 preview하고 다시 확정해야 한다(새 승인).
- 같은 `D-###` 번호를 두 branch가 만들면 Decision 파일이 Git에서 충돌하거나, CI가 같은 ID의 확정 이벤트 두 개를 보고 실패한다.
- 로컬의 기존 직렬화(decisions.lock, `PROPOSAL_NOT_PENDING`, `DECISION_SUPERSEDE_TARGET_INVALID`)는 그대로다.

### 14.5 실패·중단 흐름

| 상황 | 이벤트 |
|---|---|
| preview 뒤 내용 변경으로 거부(`DECISION_CONFIRM_PREVIEW_CHANGED`) | `confirm-failed` + 진단 |
| 권한 거부(Team Mode) | `confirm-failed` + 진단 |
| lock busy, 전송 오류, 입력 검증 실패 | 기록하지 않음(사용자 의도 전) |
| Decision 파일은 썼지만 proposal 삭제·대상 표시 전에 중단 | 다음 쓰기 조작이 repair하며 `confirm-interrupted`와 `repair`를 남김 |
| Decision 파일은 있지만 확정 이벤트가 없음 | Team Mode: `DECISION_EVENT_MISSING`(fail-closed). 사후에 만든 이벤트는 `repair`로 표시되고 확정 승인으로 치지 않으며, 리뷰된 병합을 다시 거쳐야 한다 |

### 14.6 진정성·무결성·완전성

| 성질 | 뜻 | 근거 | DUO 이벤트가 하는 일 | 한계 |
|---|---|---|---|---|
| 진정성 | 누가 승인했는가 | 호스팅의 code owner 리뷰(인증된 계정) | label·surface는 주장으로만 기록 | 계정 뒤의 사람은 증명하지 못함(W8) |
| 무결성 | 병합 뒤 바뀌지 않았는가 | 보호 branch 이력(force push 금지)과 Git object hash | `prevHash` 체인과 append-only CI 검사로 바뀐 이벤트를 찾음 | 체인은 서명이 아니다. 쓰기 권한자는 병합 전에 체인 전체를 다시 만들 수 있다 |
| 완전성 | 빠진 이벤트가 없는가 | Team Mode의 fail-closed 규칙 | 확정 Decision마다 확정 이벤트 요구, 실패·중단을 가능한 범위에서 기록 | push하지 않은 로컬 조작, 기록하지 않기로 한 실패, 지워진 마지막 이벤트(CI 밖)는 보이지 않음 |

이벤트 해시 체인은 서명도 독립 신뢰 기관도 아니다. 이벤트를 "누가 언제 무엇을 보고 승인했다는 기록"으로 쓰되, 신뢰는 리뷰된 병합에서 온다.

## 15. 기존 저장소의 Team Mode 전환(T94)

### 15.1 켜지는 시점

- 한 commit에서 `governance.yaml`이 있고 `mode: team`이면 그 commit은 Team Mode 규칙으로 읽힌다(로컬 검사).
- **팀 권한은 bootstrap PR이 보호 branch에 병합된 commit부터 생긴다.** 그 전의 branch는 로컬 검사만 받는다.
- Team Mode를 끄는 것도 `governance.yaml` 변경이라 code owner 리뷰 대상이다. 끈 뒤에도 이벤트 파일은 남는다.

### 15.2 Bootstrap PR

1. `governance.yaml`, CODEOWNERS 변경, CI 검증 단계를 추가한다.
2. 기존 확정·대체·거절 Decision마다 `adopt` 이벤트 1건(현재 상태와 `lockDigest`)을 만든다(`duoctl decision adopt`, PROPOSED).
3. 이 PR의 code owner 승인이 **기존 Decision의 현재 내용에 대한 신뢰 출발점**이다. 과거 이력을 승인한 것은 아니다.

### 15.3 기존 파일 검증

| 기존 상태 | 처리 |
|---|---|
| lock이 유효한 확정 Decision | `adopt` 이벤트에 `lockDigest` 기록 |
| lock이 없는 확정 Decision(ADR-013 수동 fallback) | bootstrap 실패. proposal로 되돌려 정상 확정 흐름을 거치거나, 사람이 `decision adopt`로 lock을 만들고 그 PR에서 리뷰받는다 |
| lock 불일치·lifecycle 무결성 오류(H-82 검사) | bootstrap 실패. 기존 0.3.1 진단 그대로 |
| superseded·rejected | 상태 그대로 `adopt`. 사슬은 기존 H-82 검사 |
| proposal | 이벤트 없이 그대로. 다음 조작부터 기록 |

### 15.4 실패와 불완전한 이력

- bootstrap 검증이 실패하면 CI가 PR을 막고 Team Mode는 켜지지 않는다. 일부만 켜진 상태는 없다.
- Team Mode 이전의 이력은 만들어 내지 않는다. 이력 조회(API-04)는 파일에서 추론한 항목을 `derived: true`와 "Team Mode 이전"으로 표시한다.
- 전환 뒤 이벤트가 빠진 확정 Decision은 `DECISION_EVENT_MISSING`으로 authority 조작이 멈춘다. 복구는 `repair` 이벤트를 담은 PR을 code owner가 리뷰해 병합하는 것이다.

### 15.5 호환성

| 대상 | 영향 |
|---|---|
| Decision Lock | 형식·digest 대상 필드 그대로. 이벤트는 digest를 복사해 둘 뿐 |
| Project Truth | 선택 파일 `governance.yaml`과 `decisions/events/` 추가. 기존 파일 의미 그대로 |
| 공개 `/1` 형식 | Decision·Proposal·Review·Context·Record 그대로. 새 형식 `duo.governance/1`, `duo.decision-event/1` 추가 |
| 0.3.3 클라이언트 | 두 새 파일을 읽지 않고 Local Mode로 동작(§8). 팀 권한은 병합 리뷰가 지킨다 |
| MCP | 9개 tool 그대로. 확정 도구 없음 |

## 16. GitHub 기능 사실 확인(T95·T97)

근거 수준을 나눠 적는다. **문서 확인**은 GitHub 공식 문서에서 확인한 것, **추론**은 문서 설명에서 끌어낸 판단, **미검증**은 문서로도 실제 저장소로도 확인하지 못한 공격 가능성이다. 실제 ruleset은 바꾸지 않았다.

| 항목 | 내용 | 근거 수준 | 설계 영향 |
|---|---|---|---|
| CODEOWNERS 평가 기준 | PR의 필수 code owner는 base branch의 CODEOWNERS로 정해진다. 파일은 `.github/`, 루트, `docs/` 순서로 찾아 처음 것을 쓴다 | 문서 확인([About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)) | §13.2의 "PR이 CODEOWNERS를 바꿔 자기 승인을 만든다"는 그 PR 안에서는 막힘. 병합된 뒤의 다음 PR부터 새 owner가 적용되므로 CODEOWNERS 변경 자체는 계속 owner 리뷰 대상 |
| bypass 모드 | `always`: 직접 push 포함 우회. `pull_request`: PR 병합에서만 우회, branch ruleset 전용. `exempt`: 규칙을 평가하지 않고 bypass 기록도 없음 | 문서 확인([Creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository), [REST rules API](https://docs.github.com/en/rest/repos/rules)) | 정책 보호 ruleset에 `exempt` 금지. 우회가 꼭 필요하면 `pull_request`로 기록이 남게 함. 현재 DUO 저장소의 branch ruleset은 모두 `always` |
| Required workflow | "병합 전 workflow 통과 요구" 규칙은 organization ruleset 기능으로 설명되고, 필수 workflow는 check 이름이 아니라 저장소·branch·workflow 파일로 지정된다 | 문서 확인([Troubleshooting rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules)) | — |
| 개인 저장소에서 required workflow 사용 불가 | 개인 계정 저장소에는 organization ruleset이 없으므로 쓸 수 없다고 본다. "개인 저장소에서 쓸 수 없다"는 문장을 직접 찾지는 못했다 | **추론** | 개인 저장소의 Team Mode는 workflow 자체를 외부에서 강제할 수 없음(BLOCKED). organization으로 옮기면 다시 검토 |
| Required status check와 required workflow의 차이 | status check는 **이름**(과 선택적으로 보고하는 앱)으로 맞춘다. required workflow는 **정해진 workflow 파일**을 실행하게 한다. 앞의 것은 "그 이름의 성공 결과가 왔다"만 보장하고 어떤 코드가 그 결과를 냈는지는 보장하지 않는다 | 문서 확인(위 두 문서) + 설계 해석 | §13.1의 workflow 행: PR이 같은 이름의 job을 다른 내용으로 바꾸면 check는 성공으로 채워질 수 있으므로 `.github/workflows/**` code owner 리뷰가 실제 방어 |
| check source를 GitHub Actions 앱에 고정 | DUO 저장소의 필수 check는 `integration_id: 15368`(GitHub Actions)로 고정되어 있다. 다른 앱이나 사용자의 commit status로 채우는 것은 막는다 | 실제 설정 확인(T84) | 같은 앱 안의 다른 workflow가 같은 job 이름을 쓰면 구분하지 못할 수 있다(아래 행) |
| 같은 Actions 앱 안 같은 이름 job의 신뢰 | PR이 새 workflow 파일에 `verify (ubuntu-latest, node 24)` 같은 이름의 job을 만들어 필수 check를 채울 수 있는지 | **미검증**(문서·재현 없음) | 가능하다고 가정하고 workflow 경로를 code owner 리뷰로 보호한다. 임시 저장소에서 T84 방식으로 재현한 뒤 이 행을 갱신 |
| 자격증명 분리 | agent 실행 환경에 승인·병합·bypass 가능한 토큰이 없어야 함 | 설계 요건(DUO가 확인 불가) | **운영 필수 조건.** 충족을 확인할 수 없으므로 `VERIFIED`도 이를 포함하지 않음 |
| `VERIFIED`의 의미 | DUO가 읽은 호스트 설정이 §12 조건을 만족한다는 상태 | 설계 | 사람의 신원, 승인 계정 뒤의 실제 사람, 토큰 분리는 보장하지 않음(§12.3) |
