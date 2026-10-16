# External Validation 02: Protocol

공개 stable DUO 0.3.3을 외부 개발자가 자기 저장소에서 쓰는 사전 등록 protocol이다(T81). 질문은 "DUO를 기존 작업 흐름에 더했을 때 개발자에게 실제 이득이 있는가"이며, 없으면 없다고 보고한다. [External Validation 01](../external-validation-01/README.md)(0.2.1)의 protocol, 마감일, 결과, 판정 기준은 바꾸지 않는다. 결과를 본 뒤에는 이 문서의 기준을 바꾸지 않는다. 바꿔야 하면 이유를 공개하고 새 Human Decision을 기록한다.

```yaml
round: external-validation-02
protocol_version: 1
status: not-started        # not-started | recruiting | stage-1 | stage-2 | evaluating | closed
duo_version: 0.3.3         # 모든 참가자가 같은 공개 stable version
recruitment_opened_at:     # 사용자 승인 뒤 첫 외부 게시 시각
recruitment_deadline:      # recruitment_opened_at + 28 days
participants: []           # S1.. (stage 1), L1.. (stage 2)
result:                    # CONTINUE | STOP | INCONCLUSIVE
```

모집 문구: [recruitment.en.md](recruitment.en.md), [recruitment.ko.md](recruitment.ko.md).

## 1. External Validation 01과의 관계

- EV01은 0.2.1로 그대로 진행하고 2026-11-01T09:37:54Z에 모집을 마감한다. EV01 참가자를 0.3.3이나 EV02로 옮기지 않는다.
- EV01 마감 전에는 EV01 후보 명단에 있던 사람과 EV01 참가자에게 EV02로 연락하지 않는다.
- 두 round의 결과를 합치지 않는다. 내부 실험([Value Validation 01](../value-validation-01/README.md))의 결과와도 섞지 않는다.

## 2. 두 단계

| 단계 | 질문 | 참여 시간 | 목표 인원 |
|---|---|---|---|
| Stage 1 초기 사용성 | 처음 쓰는 사람이 설치, 에이전트 연결, 첫 review까지 막힘 없이 가는가 | 10~15분(최대 30분에서 멈춤) | 8~12명 |
| Stage 2 지속 사용 | 실제 저장소에서 7~14일 쓰면 유지 비용보다 이득이 큰가 | Day 0 30~45분, 사건마다 1~2분, 마지막 20~30분 | 3~5명 |

Stage 1 참가자는 원하면 Stage 2로 이어서 참여할 수 있다. Stage 2만 참여해도 된다.

## 3. 참가 조건

- 직접 유지하는 실제 Git 저장소(공개·비공개 무관)와 이미 쓰고 있는 코딩 에이전트(Codex, Claude Code 또는 MCP client). Node.js 24.15 이상.
- Stage 2: 7~14일 안에 실제 변경을 할 계획이 있다.
- 제외: DUO 기여자, 설계·벤치마크 참여자, Value Validation 01 실행자.

## 4. Stage 1 절차와 측정

참가자는 README의 Quick start만 보고 진행하고, 단계마다 시작·끝 시각과 막힌 곳을 [양식 A](#양식-a-stage-1)에 적는다. 작성자는 참가자가 요청하기 전에는 돕지 않으며, 도운 경우 내용과 시간을 기록한다.

| 단계 | 끝난 것으로 보는 시점 |
|---|---|
| 설치 | `duoctl --version`이 0.3.3 |
| 도입 | `duoctl init` 성공 |
| 에이전트 연결 | `duoctl install codex` 또는 `claude-code` 성공, Codex trust 또는 Claude Code 승인까지 |
| 상태 확인 | `duoctl doctor`가 ready 또는 warning만 |
| 첫 review | 실제 변경 하나에 `duoctl review` 결과를 봄 |

사전 선언한 Stage 1 판단 기준: 참가자의 3분의 2 이상이 작성자 도움 없이 30분 안에 첫 review에 도달하면 "도입 가능", 아니면 막힌 단계를 0.4 개선 대상으로 보고한다. Stage 1만으로 제품의 이득을 판단하지 않는다.

## 5. Stage 2 절차와 측정

- **Day 0**: 참가자는 DUO를 쓰기 전에 "DUO가 없으면 이 규칙을 어떻게 지킬지"(AGENTS.md, lint, review 등)를 적는다. 그다음 실제 설계 결정 3개 이상을 Decision으로 확정한다. 걸린 시간을 적는다.
- **사용 기간(7~14일)**: DUO가 무언가를 보고하거나, 확인해야 하거나, 시간을 쓰게 할 때마다 [양식 B](#양식-b-stage-2-사건-기록)에 한 줄을 적는다.
- **마지막 날**: [양식 C](#양식-c-stage-2-마지막-인터뷰) 인터뷰.

| 지표 | 측정 방법 | 성격 |
|---|---|---|
| DUO에 쓴 시간 | 사건 기록의 분, Day 0 설정 시간 | 자기 보고 |
| 유용한 탐지 | DUO가 막거나 알렸고 참가자가 "이게 없으면 나중에 고쳤을 것"이라 판단한 사건 | 자기 보고 |
| 오탐 | DUO가 막거나 알렸지만 문제가 아니었던 사건 | 자기 보고 |
| 놓침 | 나중에 발견된 규칙 위반을 DUO가 보고하지 않은 사건 | 자기 보고 |
| 재작업 | 위반을 고치는 데 든 시간과 시점 | 자기 보고 |
| 토큰 | 참가자가 에이전트 사용량을 내보낼 수 있을 때만, 아니면 NOT MEASURED | 선택 |
| 계속 사용 여부 | 마지막 날 "계속 쓰겠다/안 쓰겠다"와 이유 | 자기 보고 |

자기 보고 값은 자기 보고라고 표시해 공개하고, 내부 실험의 측정값과 같은 표에 넣지 않는다.

## 6. 사전 선언한 판정

- **CONTINUE**: Stage 2를 마친 참가자의 과반이 "Day 0에 적은 대안으로는 놓쳤을 유용한 탐지"를 1건 이상 보고하고, 그 참가자들이 보고한 DUO 사용 시간이 그 탐지로 아꼈다고 보고한 재작업 시간보다 짧다.
- **STOP**: Stage 2 완료자 누구도 그런 탐지를 보고하지 않거나, 과반이 DUO를 계속 쓰지 않겠다고 답한다.
- **INCONCLUSIVE**: 둘 다 아니거나 완료자가 3명보다 적다.
- 작성자 개입이 결과를 만든 경우(작성자가 Decision을 대신 써 준 경우 등)는 그 참가자의 결과를 따로 표시한다.

## 7. 개인정보와 부담

- source code, key, 개인 데이터를 수집하지 않는다. telemetry가 없다. 결과는 S1, L1 같은 ID로만 공개한다.
- 언제든 그만둘 수 있고, 그만둔 이유를 물어도 답하지 않아도 된다.
- 보상은 없다. 참가자가 쓴 시간(Stage 1, Day 0, 사건 기록, 인터뷰)을 결과와 함께 공개한다.

## 8. 모집 계획(실행은 사용자 승인 뒤)

| 경로 | 방법 | 상한 |
|---|---|---|
| GitHub Discussion | 새 Discussion 하나에 모집 문구 게시 | 1건 |
| 직접 연락 | 공개 저장소에서 Codex·Claude Code·AGENTS.md·CLAUDE.md를 쓰는 것이 보이는 maintainer에게 공개 연락처로 짧은 요청 1회. 추가 연락은 하지 않음 | 첫 7일 20명 |
| 개발자 커뮤니티 | 각 커뮤니티의 자기 홍보 규칙을 확인하고 허용되는 곳에만 같은 문구로 1회 게시(후보: GeekNews, OKKY, 영어권 coding-agent 관련 커뮤니티) | 커뮤니티당 1회 |

별 요청, "검증된 효율 개선" 같은 표현, 유료 홍보, launch campaign은 하지 않는다. 게시와 연락은 사람이 승인한 뒤 사람의 계정으로 한다.

## 양식 A: Stage 1

```text
참가자 ID: S_
OS / Node.js / 에이전트:
단계 | 시작 | 끝 | 성공? | 막힌 곳(그대로 적기) | 작성자 도움(내용, 분)
설치 | | | | |
도입(init) | | | | |
에이전트 연결(trust·승인 포함) | | | | |
상태 확인(doctor) | | | | |
첫 review | | | | |
질문 1. 첫 review 결과가 무엇을 말하는지 이해했나요? (예/부분/아니오, 한 줄 설명)
질문 2. 이 도구를 실제 작업에 계속 써 보겠나요? 그 이유는?
질문 3. 가장 헷갈리거나 귀찮았던 것 하나는?
```

## 양식 B: Stage 2 사건 기록

```text
날짜 | 무슨 일(review 결과, Decision 추가·변경, index 등) | 분류(유용/오탐/놓침/유지 작업) | 쓴 시간(분) | 대안(Day 0)으로도 잡았을까? | 아낀 재작업(분, 추정이면 "추정")
```

## 양식 C: Stage 2 마지막 인터뷰

1. Day 0에 적은 대안과 비교해 DUO가 더한 것과 뺀 것은?
2. 가장 쓸모 있었던 사건과 가장 방해가 된 사건 하나씩.
3. Decision을 최신으로 유지하는 데 든 수고는 어땠나요?
4. 계속 쓰겠나요? 아니라면 무엇이 바뀌어야 하나요?
5. 에이전트 토큰 사용량을 볼 수 있었다면 DUO를 쓰기 전과 차이를 느꼈나요? (모르면 모른다고)
