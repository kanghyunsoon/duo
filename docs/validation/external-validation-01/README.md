# External Validation 01: Protocol

DUO 0.2.1을 독립 외부 maintainer가 자기 실제 repository에서 쓰는 사전 등록 protocol이다. 결정: [H-66](../../conflicts.md#human-결정-기록)(Option C, fallback E), 이 protocol 자체는 H-67. 결과를 본 뒤에는 이 문서의 기준을 바꾸지 않는다. 바꿔야 하면 이유를 공개하고 새 Human Decision을 기록한다.

모집은 사람이 승인한 T33.1에서 시작했다(GitHub Discussion #1, 2026-10-04T09:37:54Z). 아래 상태 블록이 현재 값이다.

```yaml
round: external-validation-01
protocol_version: 1
decision: H-67            # H-66 아래의 operational protocol
status: recruiting        # not-started | recruiting | observing | paused | evaluating | closed
duo_version: 0.2.1        # 모든 participant가 같은 공개 version을 쓴다
recruitment_opened_at: 2026-10-04T09:37:54Z   # 첫 외부 message: GitHub Discussion #1 게시(server 시각, T33.1)
recruitment_deadline: 2026-11-01T09:37:54Z    # recruitment_opened_at + 28 calendar days
recruitment_page: https://github.com/kanghyunsoon/duo/discussions/1
outreach_window_ends: 2026-10-11T09:37:54Z    # 첫 7 days, Day 7 checkpoint(H-68)
participants: []          # P1, P2, P3: day0, observation_start, observation_end, outcome
result:                   # CONTINUE | KILL | INCONCLUSIVE
```

자료:

| 파일 | 용도 |
|---|---|
| [participant-guide.md](participant-guide.md) | participant가 읽는 안내(영어, 한국어) |
| [recruitment.en.md](recruitment.en.md), [recruitment.ko.md](recruitment.ko.md) | 모집 문구(직접 요청, community 게시) |
| [day-0.md](day-0.md) | 사전 등록과 Day 0 기록 |
| [event-log.md](event-log.md) | 14일 event log |
| [exit-interview.md](exit-interview.md) | Day 14 질문과 대안 비교 |
| [author-interventions.md](author-interventions.md) | 작성자 개입 기록 |
| [evaluation.md](evaluation.md) | cohort 평가와 gate 판정 양식 |

## 1. Question

DUO의 추가 ceremony와 Truth 유지 비용을 감수하고도, 실제 repository에서 participant가 원래 쓰던 대안보다 DUO를 계속 사용할 가치가 있는가.

시험할 가설([T32.5 §14](../../roadmap/0.2.1-product-thesis-review.md#14-external-validation-gate)): 실제 저장소에서 coding agent와 일하는 개인·소규모 팀이 사람이 확정한 engineering Decision을 DUO에 두면, 그들이 대신 쓸 방법보다 적은 유지 노력으로 drift를 잡거나 authority를 유지하고, maintainer 도움 없이 계속 쓴다.

## 2. Why external validation

T32.5에서 남은 차별화 후보(Decision이 많을 때의 비용, 손으로 쓴 기록의 drift, 여러 사람·agent, 장기 history)는 시간과 실제 workflow가 있어야 드러난다. 작성자가 만든 fixture는 이 질문에 답하지 못하고 편향도 있다. 새 기능은 답을 만들지 않는다. 그래서 공개된 0.2.1을 그대로, 작성자가 아닌 사람이 쓰게 한다.

## 3. Evidence leading here

- [Benchmark 1](../../benchmarks/decision-compliance-01.md)(T31): 57줄 DIY gate와 Codex + `AGENTS.md`가 DUO와 같은 판정.
- [Benchmark 2](../../benchmarks/decision-compliance-02.md)(T32): adoption provenance와 supersession도 DIY(54~73줄 + 작은 JSON)와 Codex + 사람이 쓴 docs가 재현. checkpoint C.
- [Product Thesis Review](../../roadmap/0.2.1-product-thesis-review.md)(T32.5, H-66): 기술적으로 동작하지만 차별점은 약화, 실사용 evidence 0. Option C, feature 동결.

## 4. Recruitment window

| 항목 | 값 |
|---|---|
| 모집 기간 | **28 calendar days** |
| clock start | 첫 외부 모집 message(공개 게시 또는 직접 요청 중 먼저인 것)를 실제로 보낸 시각 = `recruitment_opened_at`. 이 문서의 commit 시각이 아니다 |
| deadline | `recruitment_opened_at` + 28 days = `recruitment_deadline` |
| 연장 | 하지 않는다. 연장하려면 새 Human Decision이 필요하다 |

왜 28일인가:

- participant study 자체가 14일이다.
- 새 소규모 OSS가 며칠 안에 3명을 모으려 하면 수요 부족과 모집 마찰을 혼동할 위험이 있다.
- 1~3개월 이상 기다리면 thesis를 반증하지 못하고 결정을 계속 미루게 된다.
- 28일은 두 사용 주기 길이를 모집에 허용하면서 명확한 종료 조건을 준다.

일정:

| 단계 | 기간 |
|---|---|
| Recruitment | Day 0 → Day 28(`recruitment_opened_at` 기준) |
| Participant observation | participant마다 onboarding 완료일 다음 날부터 14 consecutive calendar days |
| 전체 round 최대 길이 | Day 28에 시작한 participant가 있으면 약 Day 42(+ onboarding 하루) |
| 최종 평가 | primary cohort의 모든 observation이 끝난 뒤 |

**Recruitment failure.** `recruitment_deadline`까지 Day 0을 시작한 eligible participant가 3명 미만이면 External Validation Gate = **FAIL(KILL A)**, Option E 권고로 기록한다. "홍보를 더 하면 모일 수도 있다"는 이유로 gate를 미루지 않는다.

## 5. Eligibility

**Cohort.** primary cohort는 **독립 외부 maintainer 3명**이다. gate를 통과하는 최소 수이자 평가 대상이다.

- eligibility를 먼저 판단하고, eligible로 확인된 순서대로 받는다. 결과를 보고 유리한 3명을 고르지 않는다.
- round 1은 3명만 시작한다. 그 뒤 지원자는 waitlist에 두고, 이 round에는 넣지 않는다(§18 두 번째 round에서만 쓸 수 있다).
- participant가 되는 시점: eligibility 확인 후 Day 0 사전 등록을 제출하고 설치를 시작한 때.
- Day 0 전에 취소한 사람은 participant가 아니며, 그 자리는 다음 eligible 지원자가 받는다.

**Independent.** 다음을 모두 만족해야 한다.

- DUO repository의 기존 contributor가 아니다.
- T31·T32 benchmark 작성·실행에 관여하지 않았다.
- DUO source·product 설계에 관여하지 않았다.
- benchmark fixture가 아니라 자신이 실제로 유지하는 repository를 쓴다.
- 작성자 대신 실험을 수행하는 사람이 아니라 자기 개발 workflow에서 쓴다.

지인·동료라는 사실만으로 제외하지 않는다. 다만 DUO 내부 구조나 benchmark 해답을 자세히 전달받은 적이 있으면 bias로 기록하고 primary cohort에서 제외하는 쪽을 우선한다.

**Coding agent.** participant는 validation 전부터 하나 이상의 coding agent(Codex, Claude Code, 또는 MCP client를 쓰는 다른 agent)를 실제 개발에 쓰고 있어야 한다. DUO validation을 위해 처음 coding agent를 쓰게 하지 않는다. DUO의 built-in 설치·검증은 Codex와 Claude Code만 지원한다(product contract #12·#13). 두 agent 병행은 요구하지 않는다.

## 6. Exclusion

- 위 independence 조건 중 하나라도 맞지 않는 사람.
- DUO 내부 구조·benchmark 해답을 자세히 들은 사람(우선 제외, 포함하면 bias로 기록).
- coding agent를 아직 실제 개발에 쓰지 않는 사람.
- 14일 동안 실제 개발 변경이 예정되지 않은 repository만 가진 사람.
- 14일 동안 자연스러운 engineering Decision 3개가 생길 상황이 없는 repository(§9). onboarding 전에 participant와 함께 판단한다.

## 7. Repository requirements

- Git repository. benchmark나 validation을 위해 새로 만든 toy repository가 아니다.
- validation 기간에도 실제 개발이 일어난다.
- participant가 유지보수 권한이나 실제 개발 책임을 갖고, DUO가 추가하는 파일(`.duo-project/`, agent 설정)을 commit할 수 있다.
- 공개·비공개 모두 가능하다. 비공개 repository의 source를 DUO repository로 제출하게 하지 않는다. 필요한 것은 결과 metadata와 participant가 공유하기로 고른 sanitized evidence뿐이다.
- participant마다 서로 다른 repository.

## 8. Day 0

순서가 중요하다.

1. **사전 등록(설치 전)**: "DUO가 없다면 나는 이 문제를 어떻게 관리할 것인가?"를 먼저 적는다(pre-declared alternative). 예시만 보여 준다: `AGENTS.md`, `CLAUDE.md`, ADR·docs, linter, CI script, PR review, agent memory, 아무것도 안 함, 기타. 어떤 대안이든 participant가 실제로 쓸 것을 그대로 인정한다. DIY gate 구현을 요구하지 않는다. DUO를 써 본 뒤 대안을 사후에 적지 않는다.
2. **Self-onboarding**: 공개 자료(README, npm package, `duoctl doctor`)만으로 설치한다. 작성자가 먼저 화면 공유로 설정해 주지 않는다. participant가 막혀서 도움을 청하면 도울 수 있고, 모든 개입을 기록한다(§14).
3. **Day 0 기록**([day-0.md](day-0.md)): participant ID, repository 종류·언어, 대략의 나이, team 크기, coding agent, pre-declared alternative, 시험 이유, 설치 시작·끝, 첫 `duoctl init` 성공, 첫 Decision confirm, 첫 review, 작성자 도움, 초기 마찰. repository source는 수집하지 않는다.

**Onboarding 완료**는 participant의 repository에서 `duoctl init`이 처음 성공한 때다. 설치를 시작했지만 onboarding을 끝내지 못하면 dropout(이유: onboarding)으로 기록하고 교체하지 않는다.

## 9. 14-day observation

- 기간: onboarding 완료일 다음 날부터 **14 consecutive calendar days**.
- version: 모든 participant가 같은 공개 `@duo-director/cli@0.2.1`. security·correctness hotfix가 없으면 기간 중 바꾸지 않는다(§21).
- 최소 사용 조건(participant마다):
  - confirmed Decision 3개 이상
  - Decision 추가 또는 supersede event 1회 이상
  - 실제 개발 변경에 대한 review 사용
  - 기간 종료 때 Truth 상태 확인
- Decision은 실제 engineering choice만 기록한다. validation을 위해 가짜 Decision을 만들지 않는다. 최소 조건을 채우지 못한 것도 결과이며 그대로 기록한다(§16 Continue 조건에는 못 미친다).
- 매일 기록을 강요하지 않는다. event가 있을 때만 [event-log.md](event-log.md)에 적는다.

## 10. Metrics

| Metric | 출처 |
|---|---|
| install → first useful review 시간 | Day 0 기록, event log |
| confirmed Decisions created / superseded | event log, `.duo-project/decisions/` 상태(participant 확인) |
| useful findings 수(§11) | event log, exit |
| noisy/false findings 수(§12, C239 WARN은 따로 표시) | event log, exit |
| maintenance minutes(대략) | setup, Truth·Decision 유지, review 해석, 작성자 도움 시간. participant self-report이며 performance benchmark가 아니다 |
| alternative used / chosen | event log(Alternative tool used), exit 마지막 질문 |
| repeated use | event log(서로 다른 날의 Review run·Context use) |
| retained without help | exit, author intervention log |
| agent reuse(해당 시) | event log(Agent switch), exit |
| abandon reason(해당 시) | event log(Abandonment), exit |

stars, downloads, 설치 수로 판단하지 않는다.

## 11. Useful finding

DUO가 보여 준 Review claim, Knowledge Gap, Evidence 때문에 participant가 실제로 다음 중 하나를 했을 때만 useful finding이다.

- code를 고쳤다.
- Decision을 수정하거나 다시 확인했다.
- change를 중단했다.
- 문제를 조사했다.
- 누락된 intent를 명시했다(Requirement·Decision 추가).

"맞는 말 같다"는 useful finding이 아니다. 결과를 본 뒤 이 정의를 바꾸지 않는다.

## 12. Noise

participant가 현재 task에서 행동 가치가 없다고 판단한 finding, WARN, gap. C239 같은 현상도 participant 판단을 그대로 기록한다. 연구자가 사후에 "사실 유용했을 것"으로 바꾸지 않는다.

## 13. Truth abandonment

다음 중 하나가 일어난 경우다.

- participant가 실제 Decision이 바뀐 것을 알고도 `.duo-project`의 authority를 더 이상 갱신하지 않기로 했다.
- DUO ceremony(confirm, index 등) 때문에 Truth 유지를 그만뒀다.

14일 동안 Decision 변경이 없었던 것 자체는 abandonment가 아니다.

## 14. Author intervention

"도움 없이 쓸 수 있었다"를 과장하지 않기 위해 작성자의 모든 개입을 [author-interventions.md](author-interventions.md)에 기록한다: participant, timestamp, trigger(막힌 단계와 질문), minutes, category(docs clarification, install problem, product bug, workflow coaching, Decision modeling help), 해결 여부, "도움이 없었다면 그만뒀을 것 같은가"(participant 답).

작성자는 먼저 연락하지 않는다. 예외는 일정 안내(시작·종료·exit interview)뿐이며 이것은 개입으로 세지 않는다.

## 15. Exit interview

Day 14 다음 날 이후 [exit-interview.md](exit-interview.md)의 같은 질문을 모든 participant에게 한다. 질문 14개, pre-declared alternative와의 축별 비교(setup, maintenance, finding usefulness, noise, trust, current authority clarity, history·provenance value, agent workflow fit, would actually keep using; 숫자 합산 없음), multi-agent·Context 관찰, C239~C241 질문, 그리고 마지막 필수 질문:

> DUO와 처음 적어 둔 alternative 중 앞으로 실제 repository에서 무엇을 선택하겠는가?

**Multi-agent.** 두 agent 이상을 실제로 쓴 participant에게만 같은 Truth 재사용, 중복 지시 유지 감소, authority 불일치 방지, agent 교체 마찰을 묻는다. 관찰되지 않으면 Untested로 남긴다.

**Context Compiler.** 실제로 쓴 participant에게 쓴 이유, agent 검색·읽기가 줄었다고 느꼈는지, 추가 마찰, 계속 썼는지를 묻는다. token 계측은 새로 만들지 않는다. 쓰지 않았다는 사실도 관찰로 기록한다.

## 16. Continue criteria

primary cohort 3명 중 **최소 2명**이 다음을 모두 충족하고:

- 14일 workflow를 완료했다.
- ongoing maintainer help 없이 사용할 수 있었다(author intervention log와 participant 답).
- 실제 useful finding(§11)을 하나 이상 경험했다.
- Truth 유지 비용을 받아들일 만하다고 평가했다.
- pre-declared alternative보다 DUO를 계속 선택한다(마지막 질문).

cohort 전체에서 critical correctness·security 문제가 없으면 **External Validation Gate: CONTINUE** 후보다. feature 개발이 자동으로 재개되지는 않는다. 별도 Human Decision이 필요하다.

## 17. Kill criteria

다음 중 하나라도 맞으면 **External Validation Gate: KILL**, Option E 권고.

| ID | 조건 |
|---|---|
| A | `recruitment_deadline`까지 Day 0을 시작한 eligible participant 3명 미만 |
| B | 3명 중 2명 이상이 14일 observation 도중 DUO 사용을 중단(onboarding 실패 dropout 포함) |
| C | 3명 중 2명 이상이 종료 때 pre-declared alternative를 선택 |
| D | cohort 전체에서 useful finding 0 |
| E | 3명 중 2명 이상이 Truth 유지를 받아들일 수 없다고 평가하거나 실제로 Truth를 방치(§13) |
| F | 3명 중 2명 이상에서 noise가 useful finding보다 많고, 그 noise가 계속 쓰지 않는 이유가 됨 |
| G | critical correctness·security 문제 때문에 실제 사용을 계속할 수 없음 |

결과 때문에 기준을 바꾸지 않는다.

## 18. Inconclusive rule and dropout

**Inconclusive.** Continue도 Kill도 충족하지 않으면 INCONCLUSIVE다.

- 추가 validation round(`external-validation-02`)는 **한 번만** 허용한다. 같은 기준, 새 28일 모집 window, waitlist 지원자 포함.
- 두 번째도 INCONCLUSIVE면 Option E로 전환한다.
- 두 번째 round 전에 기준을 유리하게 바꾸지 않는다. protocol 변경이 필요하면 이유를 공개하고 새 Human Decision을 기록한다.

**Dropout.**

- observation(onboarding 포함) 시작 뒤 그만두면 dropout이고 이유를 기록한다.
- dropout은 cohort 결과에 남는다. replacement로 outcome을 지우지 않는다.
- 모집 window 안에 새 지원자가 와도 primary 3명의 결과를 사후 교체하지 않는다.

## 19. Privacy

수집하지 않는 것: private source code, API key, token, credential, 개인 email, 실제 고객 데이터, proprietary requirement 전문.

- participant는 repository 이름 익명화, Decision 내용 요약, evidence path redaction을 할 수 있다.
- 지나친 redaction으로 결과를 확인할 수 없으면 그 항목은 **Unverifiable**로 기록한다(useful로 세지 않는다).
- 공개 evidence에서는 P1, P2, P3만 쓴다. 실명·GitHub ID는 participant가 명시적으로 동의한 경우에만 공개한다.

## 20. No telemetry

DUO에 telemetry를 추가하지 않는다(H-66). DUO runtime은 validation 때문에 외부로 데이터를 보내지 않는다. 자료는 participant가 골라 작성한 Markdown report(이 디렉터리의 양식)뿐이다. form, backend, dashboard를 만들지 않는다. participant는 report를 개인적으로 전달할 수 있다. `duoctl stats` 같은 local 요약은 participant가 원할 때만 공유한다.

## 21. Product-freeze rules

- 모든 participant는 가능한 한 같은 공개 version 0.2.1을 쓴다.
- security·correctness·compatibility 문제는 H-66 maintenance 범위라 별도 수정할 수 있다. 수정 release가 나오면 participant별 version과 날짜를 기록한다.
- participant 요청이라는 이유로 feature, UX 개선, 새 analyzer, 새 rule을 기간 중 구현하지 않는다. 필요하면 conflict나 issue로만 기록한다.
- feedback 때문에 0.2.2 feature patch를 만들지 않는다.
- 결과를 왜곡할 정도의 critical bug면 round를 **PAUSE**(`status: paused`)하고, 수정 후 처리 방법(기간 보정, 재시작 등)은 Human Decision으로 정한다.

## 22. C239–C241 observations

수정하지 않고 관찰만 한다.

| Conflict | 관찰 질문 |
|---|---|
| C239 | 정상 변경의 knowledge gap WARN을 participant가 noise로 보는가. 몇 번, 어떤 상황에서 |
| C240 | `introduced` 라벨을 "이 변경이 추가함"으로 실제로 오해하는가 |
| C241 | current·superseded authority를 review에서 직접 보고 싶어 하는가(supersede event가 있었던 participant에게) |

participant가 불편하다고 하면 evidence로 기록한다. 바로 고치지 않는다.

## 23. Recruitment copy

[recruitment.en.md](recruitment.en.md), [recruitment.ko.md](recruitment.ko.md). 목표는 사용자 확보가 아니라 반증 participant 모집이다(H-66의 broad marketing Stop).

허용: 실제 repository maintainer에게 직접 요청, OSS developer community의 "2주 validation participant 모집" 글, 개인 개발자·소규모 팀 대상, 기존 전문 network.

금지: star 요청, "DUO가 Codex보다 낫다" 류 홍보, benchmark 승자 표현, Product Hunt식 launch, 대규모 paid promotion.

T33에서는 문구만 준비한다. 게시, 외부 message, GitHub issue·discussion 생성은 하지 않는다.

## 24. Clock-start rule

T33의 완료나 이 문서의 commit은 clock을 시작하지 않는다. 사람이 모집 게시를 승인한 뒤(T33.1), 첫 공개 게시나 직접 요청 message를 실제로 보낸 날짜·시각(UTC)을 `recruitment_opened_at`에 기록하는 순간부터 28일이다. `recruitment_deadline`은 그 값에 28일을 더한 값이다.

## 25. Reporting plan

**저장 위치.**

| 종류 | 위치 |
|---|---|
| 공개 sanitized evidence | 이 디렉터리 아래 `results/P1/`, `results/P2/`, `results/P3/`(participant가 공개를 고른 Day 0, event log, exit 요약). round 시작 때 만든다 |
| 작성자 개입 기록 | `results/author-interventions.md`(participant ID만) |
| cohort 평가 | `results/evaluation.md`([evaluation.md](evaluation.md) 양식) |
| private notes, 원본 report, 연락처 | repository 밖(작성자 local). commit하지 않는다 |

**보고.** 모든 primary observation이 끝나면 [evaluation.md](evaluation.md) 양식으로 participant별 결과, dropout, Continue·Kill 조건별 판정, 작성자 개입 합계, Unverifiable 항목, C239~C241 관찰, multi-agent·Context 관찰을 공개한다. 판정 결과(CONTINUE, KILL, INCONCLUSIVE)와 다음 option은 새 Human Decision으로 기록한다. 부정적 결과도 같은 방식으로 공개한다.

## 26. Recruitment execution (H-68)

결과를 보기 전에 고정한 실행 강도다. §4~§18의 기준은 바꾸지 않는다.

| 항목 | 값 |
|---|---|
| Public landing | GitHub Discussion(General). canonical recruitment page. GitHub Issues는 모집에 쓰지 않는다 |
| Acquisition | targeted direct outreach. 공개된 email, 웹사이트 contact 같은 정상적인 developer 연락 수단만 |
| Outreach budget | `recruitment_opened_at` 뒤 첫 7 calendar days 안에 개별 invitation 최대 **20**건 |
| Follow-up | 한 사람당 최대 1회 |
| 중단 | primary cohort 3명이 확정되면 새 outreach를 멈춘다. quota를 채울 의무는 없다 |
| 금지 | mass spam, 자동 대량 발송, 결과를 본 뒤 유리한 사람만 추가 접촉, quota 사후 확장 |
| 지원 방법 | Discussion에 짧게 관심 표시(개인 정보 없이). maintainer가 답하고 eligibility 답변과 report용 비공개 채널을 participant와 정한다. direct outreach는 보낸 채널로 답을 받는다 |

**후보 선정 기준**(결과 전 고정): 실제 Git repository maintainer, 기간 중 개발 가능, 이미 coding agent 사용(공개 근거: repository의 `AGENTS.md`·`CLAUDE.md`, agent 사용을 밝힌 commit이나 문서), DUO contributor·T31/T32 참여자 아님, toy repository 아님, 공개된 연락 수단이 있음. 언어를 고르지 않는다. 공개 language support와 맞지 않는 repository는 eligibility 기록에 적는다.

**후보 탐색 절차**: GitHub에서 `AGENTS.md` 또는 `CLAUDE.md`를 가진 공개 repository를 찾고, 결과 순서대로 다음을 만족하는 maintainer를 후보로 둔다: 개인 또는 소규모 팀 소유, 최근 30일 안의 commit, 위 기준 충족. 같은 사람은 한 번만. 개인화는 유지하는 repository와 coding-agent workflow 관련 한 문장으로 한정한다.

**보내는 사람**: Codex는 email·DM을 보내지 않는다. 후보, 공개 연락 경로, 완성 문구까지 준비하고 사람이 보낸다. 보내지 않은 message는 contacted로 세지 않는다.

**개인 정보**: 이름, email, 연락처는 Git 밖 private log에만 둔다. 이 문서에는 아래 aggregate만 적는다.

```yaml
outreach:                 # aggregate only; updated at Day 7 and Day 28
  invitations_sent: 0
  follow_ups_sent: 0
  responded: 0
  eligible: 0
  accepted: 0
  day0_started: 0
  declined: 0
  no_response: 0
  discussion_interest: 0  # Discussion에서 관심을 표시한 사람
```

**Checkpoint**: Day 7(`recruitment_opened_at` + 7 days)에 위 aggregate만 집계한다. 제품 수정이나 기준 변경 없이 Day 28까지 모집을 계속한다. Day 28에 Day 0을 시작한 eligible participant가 3명 미만이면 KILL A(§17), Option E 권고, 자동 연장 없음.

