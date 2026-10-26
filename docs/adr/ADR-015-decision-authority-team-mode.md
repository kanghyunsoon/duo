---
id: ADR-015
type: decision
title: Team Mode의 Decision 승인 신뢰 경계
state: proposed
question: decision_authority_team_mode
answer: "Local Mode unchanged (actor labels are mistake prevention, not authentication); opt-in Team Mode via .duo-project/governance.yaml where team authority comes only from a merge to a protected branch whose host enforces required code-owner review, with admin bypass and agent-reachable approval credentials in the threat model; DUO reports the host protection as VERIFIED only after reading it and UNVERIFIED otherwise; lockless or eventless Decisions fail closed in Team Mode; Decision audit events are one Git-tracked file per event and are claims, not proof"
governs:
  requirements: [REQ-DECISION-002, REQ-DECISION-003, REQ-TRUTH-001]
supersedes: null
---

# ADR-015: Team Mode의 Decision 승인 신뢰 경계

상태: **Proposed**(T87 초안, T94 수정, Maintainer 승인 전). 승인 전에는 제품 규칙이 아니고, 초안 H-88도 승인되지 않았다. 근거와 비교는 [decision-rbac-design.md](../roadmap/decision-rbac-design.md), 감사 Gap은 [decision-audit-gap.md](../roadmap/decision-audit-gap.md)에 있다. T94 수정은 T91·T92 검토에서 남은 미결 사항(CODEOWNERS 미강제, 관리자 bypass, agent의 자격증명 접근, CI 약화 경로, 기존 Decision 이전, 이벤트 무결성)을 반영했다.

## 맥락

[ADR-013](ADR-013-decision-lifecycle.md)은 "AI는 제안하고 사람이 확정한다"를 actor kind로 나눈다. kind와 이름은 호출자가 정하고, CLI·UI는 human으로 고정한다. 같은 OS 사용자로 도는 셸 agent는 PTY로 CLI를, 로컬 HTTP로 UI API를 조작해 확정할 수 있고(T87 재현), lock 없는 Decision 파일을 직접 써서 확정 권한을 만들 수 있다. 로컬 도구만으로는 이를 막을 수 없다. 같은 agent가 사용자의 Git 호스팅 토큰을 쓸 수 있으면 호스팅 쪽 승인도 대신할 수 있다.

## 결정(제안)

### 1. 두 모드의 신뢰 근거

1. **Local Mode(기본)는 ADR-013 그대로 둔다.** actor label(`human`, `ui:<Git user.name>`, Git identity)은 **인증이 아니라 실수 방지**다. 누가 확정했는지 증명하지 않는다.
2. **Team Mode는 `.duo-project/governance.yaml`(`duo.governance/1`)로 켠다.** 역할(ADMIN, APPROVER, DEVELOPER, AI_AGENT, READ_ONLY)과 Decision 범위별 승인자를 적는다. 로컬 승인자 검사는 실수 방지다.
3. **Team Mode의 승인 권한은 보호된 Git 호스팅 시스템이 병합 때 검증한다.** 로컬 확정과 감사 이벤트는 그 리뷰의 입력이다. 팀 권한은 보호 branch에 병합된 commit에서만 생긴다.

### 2. 호스팅 보호 전제

Team Mode의 강한 승인 보장은 아래가 모두 강제될 때만 주장한다.

- **CODEOWNERS 파일만으로는 부족하다.** 보호 branch 규칙이 code owner 리뷰를 필수로 강제해야 한다(GitHub: 승인 1건 이상, code owner 리뷰 필수, 새 push 뒤 이전 승인 해제, 마지막 push는 다른 사람이 승인).
- CODEOWNERS가 정책 경로(`.github/workflows/**`, CODEOWNERS, `governance.yaml`, `decisions/**`, Decision 검증 설정)를 덮고, 경로마다 승인할 수 있는 사람이 작성자 외에 있어야 한다.
- force push와 branch 삭제가 막혀 있어야 한다.
- **관리자 bypass는 위협 모델에 포함한다.** bypass를 가진 사람과 그 사람의 토큰은 리뷰 없이 팀 권한을 만들 수 있다. 정책 경로를 다루는 규칙에는 bypass를 두지 않는 것을 권장하고, 남겨 두면 그 경로를 잔여 위험으로 표시한다.
- GitHub ruleset의 bypass 모드는 세 가지다. `always`는 직접 push를 포함해 우회하고, `pull_request`는 PR 병합에서만 우회하며(branch ruleset 전용), `exempt`는 규칙을 평가하지 않고 bypass 기록도 남기지 않는다. **정책 보호 ruleset에는 `exempt`를 쓰지 않는다.** 남겨야 하면 `pull_request`를 쓴다.
- 필수 code owner는 PR의 **base branch**에 있는 CODEOWNERS로 정해진다. PR이 CODEOWNERS를 바꿔도 그 PR의 필수 리뷰어는 바뀌지 않는다.
- 개인 계정 저장소에서는 organization 기능인 required workflow를 쓸 수 없다고 본다(추론, rbac 설계 §16). 개인 저장소의 CI 보호는 이름으로 맞추는 required status check와 `.github/workflows/**`의 code owner 리뷰뿐이다.

### 3. 자격증명 전제

- AI agent가 실행되는 환경에 PR 승인, 병합, ruleset bypass가 가능한 Git 호스팅 토큰을 노출하지 않는다.
- 같은 OS 사용자 권한으로 실행되는 agent가 그런 자격증명(`gh` 인증, OS credential manager, 브라우저 세션 등)에 접근할 수 있으면 **Team Mode의 강한 승인 보장을 주장할 수 없다.** 그 환경의 승인은 agent가 했을 수 있다.
- DUO는 이 조건을 기술적으로 확인할 수 없다. 운영 요건으로 문서화하고, Team Mode 설정 안내와 신뢰 상태 표시에서 "확인되지 않음"으로 함께 보여 준다.

### 4. 신뢰 상태 표시

| 상태 | 뜻 |
|---|---|
| `LOCAL` | Local Mode. 팀 권한 주장 없음 |
| `VERIFIED` | DUO가 호스트 설정을 읽어 §2 조건을 확인했다. **호스트 설정 상태일 뿐 사람의 신원 증명이 아니다.** §3 자격증명 조건은 포함하지 않는다 |
| `NOT_MET` | 읽었지만 조건이 빠졌다(예: code owner 리뷰 미강제, 정책 경로에 bypass) |
| `UNVERIFIED` | 권한 부족, 오프라인, 미지원 호스트, API 오류 등으로 확인하지 못했다 |

확인하지 못한 상태를 `VERIFIED`처럼 표시하거나 "보호됨"이라고 말하지 않는다.

### 5. 지원 범위

GitHub(repository ruleset 또는 branch protection과 CODEOWNERS)만 설계와 검증 대상이다. 같은 보호를 제공하는 다른 Git 호스팅은 사람이 확인한 뒤 지원 목록에 추가하며, DUO는 동등성을 자동으로 가정하지 않는다. 목록에 없는 호스트는 항상 `UNVERIFIED`다.

### 6. Team Mode 데이터

1. lock이나 확정 이벤트가 없는 Decision은 Team Mode에서 Truth 오류다. ADR-013 수동 fallback은 Team Mode에서 제한한다. 기존 Decision은 bootstrap 절차로 이전한다(rbac 설계 §15).
2. 감사 이벤트는 **이벤트 1건당 Git 추적 파일 1개**(`.duo-project/decisions/events/`, `duo.decision-event/1`)이며 DecisionService가 쓴다. 이벤트는 주장이고, 해시 체인은 서명이나 독립 신뢰 기관이 아니다. 신뢰는 리뷰된 병합에서 온다(rbac 설계 §14).
3. 서명 승인 검증은 후속 확장으로 둔다.

## 결과

- 공개 `/1` Decision·Proposal 스키마, Decision Lock, MCP 9개 tool은 바뀌지 않는다. Local Mode 저장소는 아무것도 바뀌지 않는다.
- Team Mode는 외부 조건(호스트 보호 강제, 자격증명 분리)에 의존한다. 조건이 깨지면 보장은 Local Mode 수준으로 내려가며, DUO는 확인할 수 있는 부분만 상태로 보여 준다.
- 병합 전 branch에서는 위조 Decision이 그 branch의 review·context에 영향을 줄 수 있다.
- CI·정책 파일을 약화시키는 PR은 필수 code owner 리뷰로만 막는다. 리뷰어가 놓치면 통과한다(rbac 설계 §13).

## 보장하지 않는 것

- 승인한 호스팅 계정 뒤에 실제 사람이 있었는지(토큰을 가진 agent, 계정 탈취)
- 저장소 관리자가 보호 규칙을 끄거나 bypass로 병합하는 것
- 호스팅 밖으로 복사된 저장소, 병합 전 branch의 Decision
- 이벤트 내용(사유, label)의 진실성

