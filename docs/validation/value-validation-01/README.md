# Value Validation 01: Protocol

DUO를 기존 작업 흐름에 더했을 때, 더해지는 시간·토큰·사람 개입 비용보다 막아 주는 설계 위반과 재작업 비용이 더 큰지를 측정하는 사전 등록 protocol이다(T81). DUO가 낫다는 것을 보이는 실험이 아니다. 기존 도구만 쓰는 편이 더 효율적이면 그 결과를 그대로 보고한다. 결과를 본 뒤에는 이 문서의 조건, 지표, 판정 규칙을 바꾸지 않는다. 바꿔야 하면 이유를 공개하고 새 Human Decision을 기록한다.

```yaml
round: value-validation-01
protocol_version: 1.1      # 1.1: 실행 전 산술 정정만(§14). 조건·지표·판정 규칙은 1과 같다
status: protocol-ready      # protocol-ready | running | analyzing | closed
duo_version: 0.3.3          # 공개 npm stable, 모든 C run에 같은 package
part1_detection: measured   # 결정적 탐지 테스트(유료 호출 없음), detection-results-01.md
part2_agent_runs: not-run   # 실제 에이전트 작업, 사용자 승인 필요(Codex 사용량)
part3_discovery: not-run    # Issue #8 실제 Codex 도구 발견률, 사용자 승인 필요
part4_human_steps: not-run  # 사람 단계의 시간 측정(설치, 승인, 검토)
```

자료:

| 파일 | 용도 |
|---|---|
| [scenarios.md](scenarios.md) | 결정적 사례 17개의 정답과 검사 범위, 에이전트 작업 7개, 사람 단계 절차 |
| [detection-results-01.md](detection-results-01.md) | Part 1 결과(실측) |
| [report-template.md](report-template.md) | 최종 보고서 양식 |
| [measurement-notes.md](measurement-notes.md) | Codex·Claude Code 토큰·시간의 출처, 정밀도, 가용성과 MEASURED·ESTIMATED·NOT MEASURED 기준 |
| [bench/value-validation/](../../../bench/value-validation/README.md) | fixture, 사례, oracle, harness, 집계 도구 |

## 1. 질문

**DUO를 도입하면서 추가되는 시간·토큰·인간 개입 비용보다, 예방하는 설계 위반과 재작업 비용이 더 큰가?**

이 질문은 "B에 DUO를 더한 C가 B보다 나은가"로 측정한다. A와 B의 비교는 기존 도구가 이미 얼마나 막는지를 보이는 기준선이다.

## 2. 이미 있는 증거

- [Benchmark 1](../../benchmarks/decision-compliance-01.md): 고정된 위반 하나를 DUO, 57줄짜리 DIY gate, Codex review가 같게 판정했다. 탐지 하나만으로는 DUO의 근거가 되지 않는다.
- [Benchmark 2](../../benchmarks/decision-compliance-02.md): adoption 시점과 supersede를 다루는 DIY gate는 73줄이었고 DUO와 같은 결과를 냈다.
- T32 product thesis checkpoint: "Thesis materially weakened".
- T74: 같은 작업에서 지시문만 쓴 조건과 DUO 조건의 차이는 사례 2건으로 판단할 수 없었다.

이번 실험은 이 결과를 뒤집으려는 것이 아니다. 탐지 정확도에 더해 시간, 토큰, 사람 개입, 재작업을 같은 조건에서 함께 잰다.

## 3. 조건

세 조건은 같은 source, 같은 규칙 문장, 같은 작업 지시를 쓴다. 각 조건은 자기 도구의 산출물만 더한다([fixture.mjs](../../../bench/value-validation/fixture.mjs)).

| 조건 | 구성 |
|---|---|
| A | AI 코딩 에이전트 + 잘 쓴 AGENTS.md(규칙 R1~R3 전문, 규칙을 어겨야 하면 멈추고 묻기) |
| B | A + ESLint(`no-restricted-imports`, `no-restricted-syntax`), dependency 검사 script, `npm run check`, Git pre-commit hook, CI workflow. adoption 시점의 기존 위반 2개는 `eslint-disable` 주석으로 억제(기존 code base에 lint를 들일 때 흔한 방법). AGENTS.md에 "끝내기 전에 `npm run check`를 실행하고 모든 오류를 고칠 것" 한 줄 |
| C | B + DUO 0.3.3: 같은 규칙 R1~R3을 사람이 확정한 Decision(forbids)으로 기록, `duoctl init`(adoption baseline), `duoctl install codex`(MCP 설정과 DUO가 생성하는 AGENTS.md 블록) |

공정성 규칙:

- C는 DUO가 설치할 때 스스로 쓰는 AGENTS.md 블록 말고는 추가 지침을 받지 않는다. 작업 지시는 DUO, ESLint, 규칙을 언급하지 않는다.
- B의 ESLint 설정은 규칙을 아는 사람이 일반적인 방법으로 쓴 것이다. B를 일부러 약하게 만들지 않는다. B가 구조적으로 못 보는 범위(require, 계산된 dynamic import)는 결과를 보기 전에 범위 밖으로 선언했다.
- 모든 조건이 같은 adoption 시점의 기존 위반(legacy debt)을 갖는다.
- 각 조건의 설치·설정 단계는 시간을 잰다. 도구 실행 시간은 harness가 기록하고, 사람이 하는 시간은 [§9](#9-사람-단계의-시간-측정part-4)의 양식으로 잰다.

## 4. 검증 대상과 구성

| 범주 | 내용 | 결정적 사례 | 에이전트 작업 |
|---|---|---|---|
| 1 | 규칙을 지키는 정상 작업 | N1~N4 | T1 |
| 2 | 직접 import 등 명확한 위반 가능성 | V1~V4 | T2, T3 |
| 3 | 우회 구현, 간접 의존성(분석 한계) | L1~L5 | T4 |
| 4 | 사람의 설계 변경 승인이 필요한 작업 | H1 | T5 |
| 5 | 새 세션·다른 에이전트로 이어받기 | 없음 | T6(두 세션) |
| 6 | 기존 저장소에 뒤늦게 도입 | D1~D3 | T7 |

- **Part 1 결정적 탐지 테스트**: 정답이 미리 정해진 변경을 B gate와 DUO에 똑같이 적용한다. LLM과 네트워크를 쓰지 않는다. 사례의 정답과 도구별 검사 범위는 결과 전에 [cases.mjs](../../../bench/value-validation/cases.mjs)에 고정했다.
- **Part 2 에이전트 작업**: 같은 작업을 A, B, C의 독립 저장소 복제본에서 실제 에이전트가 수행한다. 정답 판정은 ESLint와 DUO 어느 쪽에도 기대지 않는 별도 oracle([oracle.mjs](../../../bench/value-validation/oracle.mjs))이 한다. oracle은 Part 1의 17개 사례에서 정답과 모두 일치했다(계산된 dynamic import는 "사람 검토 필요").
- **Part 3 Codex MCP 발견률**(Issue #8): [§8](#8-part-3-실제-codex-mcp-발견률issue-8).
- **Part 4 사람 단계 시간**: [§9](#9-사람-단계의-시간-측정part-4).

## 5. 통제

- 모델: 한 실험 안의 모든 run은 같은 모델을 `-m`으로 고정한다. 모델 이름, Codex CLI version, reasoning 설정을 결과에 적는다. 현재 사용자 Codex 기본값은 OpenCodex 경유 `anthropic/claude-opus-5-5`이며, 어떤 모델로 할지는 실행 승인 때 정한다.
- 환경: `codex exec --json`, sandbox `workspace-write`(Part 3은 `read-only`), `approval_policy="never"`, 실행할 저장소만 command-line override로 trusted. 사용자 Codex 설정 파일은 바꾸지 않고 인증 파일을 복사하지 않는다.
- 시간 제한: 세션당 20분(Part 3은 10분). 초과는 `timeout`으로 남기고 다시 돌리지 않는다.
- 독립성: 모든 run은 조건 template의 새 복사본에서 시작한다. 이전 run의 파일, index, 대화가 남지 않는다.
- 순서: seed 81로 작업 순서를 섞고, 작업마다 A/B/C 실행 순서를 여섯 가지 순서에 고르게 돌린다([agent.mjs](../../../bench/value-validation/agent.mjs) `schedule`). 일정은 실행 전에 `schedule.json`으로 남긴다.
- 반복: 작업 7개 × 조건 3개 × 3회 = 63 run(T6은 run마다 두 세션이므로 Codex 세션은 63 + 9 = 72개).
- 재실행: 기반 설비 실패(Codex 서비스 오류, 네트워크 단절)만 같은 run ID로 다시 돌리고, 그 사실과 원래 log를 남긴다. 결과가 마음에 들지 않아서 다시 돌리지 않는다.
- 제품 고정: 실험 동안 DUO와 fixture는 바꾸지 않는다. 결함을 찾으면 Issue로 기록하고 이 round의 결과는 0.3.3 기준으로 남긴다.

## 6. 지표

모든 값은 측정한 값이거나 `NOT MEASURED`이다. 추정값을 실측값처럼 쓰지 않는다.

### 6.1 개발 시간

| 지표 | 출처 |
|---|---|
| 초기 설치·설정 시간(도구) | fixture 단계별 시간(`templates/<조건>.json`) |
| 초기 설치·설정 시간(사람) | §9 양식 |
| 에이전트 실행 시간 | 세션 wall time |
| 검증 도구 실행 시간 | Part 1 도구별 시간, Part 2의 check 명령 수 |
| 사용자 능동 개입 시간 | §9 양식(승인, 검토, 답변) |
| 오류 수정·재작업 시간 | check 실패 뒤 수정까지의 세션 구간(가능한 경우), 남은 위반을 사람이 고친 시간(§9) |
| 전체 완료 시간 | 위 합계 |

DUO의 순수 오버헤드 = C 합계 − B 합계(같은 작업, 같은 반복의 짝 비교, 중앙값과 범위).

### 6.2 토큰과 비용

| 지표 | 출처 |
|---|---|
| 모델 입력·출력 토큰, 캐시된 입력 | `turn.completed` usage(Codex가 보고한 값) |
| DUO Context Packet 토큰 | C 저장소의 `.duo-project/runtime/metrics.jsonl` `contextTokens` |
| 추가 검증·재시도 토큰 | 조건 간 차이로만 보고(세션 안 구간별 토큰은 Codex가 보고하지 않음: NOT MEASURED) |
| 실제 과금액 | 실행 계정의 청구 자료로 확인할 수 있을 때만. 아니면 NOT MEASURED |

Context Packet 토큰은 DUO가 만든 문맥의 크기이다. 모델 사용량이나 비용 절감률로 바꿔 쓰지 않는다.

### 6.3 탐지 정확도

- 양성 = 위반을 막는 판정(B: ESLint 오류 또는 dependency 검사 실패, DUO: `--fail-on block` 종료 코드 4).
- TP, FP, TN, FN, Precision, Recall, F1, 오탐률은 도구가 문서로 밝힌 검사 범위 안의 사례로만 계산한다.
- 범위 밖 사례, WARN·ASK·UNKNOWN처럼 막지 않는 신호, 도구 오류는 따로 센다. 정상 판정에 섞지 않는다.
- Part 2에서는 oracle이 "새로 생긴 위반"을 센다(adoption 시점에 있던 위반은 세지 않음). oracle이 판단할 수 없는 경우는 사람이 검토한다.

### 6.4 재작업 비용

| 지표 | 출처 |
|---|---|
| 위반 발생 횟수 | 세션 중 check가 위반을 보고한 횟수와 최종 oracle 결과 |
| 발견 시점 | 세션 안(check, DUO), 세션 뒤(oracle), 놓침 |
| 재작업 횟수 | check 실패 뒤 파일 수정이 이어진 횟수(`reworkCycles`) |
| 재작업 시간 | §6.1 |
| 사용자 승인 요청 횟수 | 멈추고 물은 run(사람이 최종 메시지로 판정), DUO proposal 수 |
| 승인 대기·개발 중단 시간 | §9 |

## 7. 분석과 판정 규칙(사전 선언)

작업별로 A, B, C를 나란히 놓고 다음을 보고한다.

1. 남은 위반: oracle 기준 새 위반이 남은 run 수.
2. 비용: 시간(도구, 에이전트, 사람)과 토큰.
3. 작업 완료: 숨긴 acceptance test 통과 수.

판정:

- **C가 B보다 이득**: 같은 작업에서 C의 남은 위반이 B보다 적고, 그 차이를 얻는 데 든 추가 비용(시간, 토큰, 사람 개입)이 남은 위반 하나를 나중에 고치는 데 드는 측정된 비용보다 작을 때. 나중에 고치는 비용은 이 실험에서 남은 위반을 사람이 고친 시간(§9)으로 잰다.
- **B가 더 효율적**: C와 B의 남은 위반이 같거나 C가 더 많을 때. 이 경우 DUO의 추가 비용은 순손실로 보고한다.
- **판단 불가**: 차이가 반복 사이의 흔들림보다 작거나 run이 부족할 때.
- 범주별로 따로 보고하고, 하나로 합친 점수나 "몇 % 향상" 같은 수치는 만들지 않는다.

표본이 작으므로(작업 7개, 반복 3회) 통계적 유의성은 주장하지 않는다. 결과는 "이 fixture, 이 모델, 이 작업에서"로만 말한다.

## 8. Part 3: 실제 Codex MCP 발견률(Issue #8)

[discovery.mjs](../../../bench/value-validation/discovery.mjs)가 공개 0.3.2와 0.3.3을 registry에서 따로 설치하고, 버전마다 같은 작은 저장소를 준비한 뒤 같은 지시로 Codex 세션을 번갈아 실행한다. 기록하는 값:

- 발견: duo-director MCP 도구를 한 번이라도 부른 세션 수
- 첫 호출 성공: 첫 DUO 도구 호출이 오류 없이 끝난 세션 수
- fallback: MCP 없이 `duoctl` CLI만 쓴 세션 수
- 첫 DUO 도구 event까지의 시간, wall time, 토큰
- Codex 없이 잰 서버 `initialize` 시간(dry run에서 측정: 0.3.2 중앙값 804ms, 0.3.3 415ms, 6회씩, 이 기계)

기본 10회씩(세션 20개). 결과는 #8에 그대로 붙인다. 개선되지 않았으면 그렇게 보고한다.

## 9. 사람 단계의 시간 측정(Part 4)

harness가 잴 수 없는 사람의 시간은 실행하는 사람이 stopwatch로 재고 run ID와 함께 적는다.

| 단계 | 조건 | 재는 구간 |
|---|---|---|
| 처음 설치·설정 | B, C | 문서를 읽기 시작해서 check(B) 또는 `duoctl doctor`(C)가 정상일 때까지 |
| 규칙 변경 승인(T5, H1) | A, B, C | 요청을 읽고 판단해서 규칙 변경을 반영할 때까지(A: AGENTS.md, B: + 검사 설정, C: + Decision proposal 확정) |
| 남은 위반 수정 | A, B, C | oracle이 남은 위반을 보고한 run에서 사람이 고쳐 check를 통과시킬 때까지 |
| 최종 메시지 검토 | A, B, C | T5와 사람 검토가 필요한 run의 판정 시간 |

검토하는 사람은 가능하면 조건을 모른 채 판정한다(run ID에서 조건 표시를 가린 사본으로 본다). 이 실험에서는 같은 사람이 실행하고 검토하므로 완전한 blind는 아니다.

## 10. 기록과 공개

- 원본 log(`runs/<id>/session-*.events.jsonl`, 최종 메시지, stderr)와 요약(`runs.json`, 보고서)을 분리한다. 원본 log는 로컬에만 두고, 공개 보고서에는 요약과 집계만 싣는다.
- 성공, 실패, timeout, 중단을 모두 기록한다. 빠진 run은 빠진 이유와 함께 표에 남긴다.
- 내부 실험(이 문서)과 외부 사용자 결과([External Validation 02](../external-validation-02/README.md))는 섞지 않는다.
- 인증 정보, 토큰, 사용자 저장소 내용은 기록하지 않는다.

## 11. 필요 자원과 예상 사용량

실행 전 추정이며 측정값이 아니다. 근거는 이 기계의 이전 실제 Codex 세션 log이다. T75 계획 작성 세션 36개는 입력 토큰 중앙값 120,336(그중 캐시 103,273), 출력 2,741, 35~55초였다. T74 세션 10개는 입력 중앙값 121,243, 최대 510,544였다.

| 항목 | Part 2 에이전트 작업 | Part 3 발견률 |
|---|---|---|
| Codex 세션 | 72 | 20 |
| 세션당 입력 토큰(추정) | 18만~48만(구현 작업은 계획 세션의 1.5~4배로 가정) | 약 12만 |
| 전체 입력 토큰(추정) | 약 1,300만~3,500만(대부분 캐시) | 약 240만 |
| 전체 출력 토큰(추정) | 약 30만~80만 | 약 5.5만 |
| 기계 시간 | 약 3~6시간(순차 실행) | 약 20~30분 |
| 사람 시간 | 약 1~2시간(T5 판정, 사람 검토 run, 남은 위반 수정, 승인 단계) | 결과 확인 10분 |

금액: 실행 계정이 ChatGPT 요금제 한도를 쓰는지, API key로 토큰당 과금되는지, OpenCodex 경유 모델인지에 따라 달라 금액은 추정하지 않는다. API 과금이면 금액 = 위 토큰 × 그 모델의 공개 단가이며, 실제 청구액은 실행 뒤 청구 자료로만 적는다.

## 12. 역할 분담(6인 팀 기준)

| 역할 | 책임 | 결과를 보기 전에 할 일 |
|---|---|---|
| 실험 책임자 | protocol, 판정 규칙, 최종 분석. 결과 뒤 기준 변경 금지 | protocol 고정, 일정 공개 |
| 정답·oracle 담당 | 사례와 작업의 정답, oracle, 사람 검토(가능하면 조건을 모르는 상태) | 정답과 범위 선언 |
| 실행·환경 담당 | harness, 모델 고정, log 보관, 실패 기록 | dry run, 환경 기록 |
| 엔진 담당 | DUO의 FP·FN 원인 분석과 Issue 기록. 실험 중 제품 수정 금지 | 검사 범위 문서 확인 |
| 연동 담당 | Codex·Claude Code 설정, Part 3, 다른 에이전트로 이어받기 절차 | 공식 문서 확인 |
| UX·외부 검증 담당 | 사람 단계 시간 측정, External Validation 02 모집·인터뷰, 참가자 부담 기록 | 모집 문구 검토 |

## 13. 한계

- fixture 하나, JavaScript 하나, 규칙 세 개다. 큰 저장소, 다른 언어, 다른 종류의 규칙으로 일반화하지 않는다.
- 결정적 사례는 사람이 만든 것이다. 실제 에이전트가 같은 실수를 같은 비율로 하지 않는다.
- B의 설정 품질에 따라 결과가 바뀐다. 이 실험의 B는 규칙 세 개에 맞춘 설정이며, 실제 팀의 설정은 더 약하거나 강할 수 있다.
- 모델과 Codex version에 따라 결과가 바뀐다. 결과는 기록한 모델에만 해당한다.
- 같은 사람이 실행하고 검토한다.
- 사람 시간은 한 사람이 잰 값이다.

## 14. 개정 기록

| 버전 | 시점 | 바뀐 것 | 바뀌지 않은 것 |
|---|---|---|---|
| 1 | T81 | 최초 사전 등록 | |
| 1.1 | T82, Part 2·3 실행 전 | Codex 세션 수 계산을 70에서 72로 정정했다. T6 run 9개(조건 3 × 3회)가 세션을 하나씩 더 열기 때문이다([agent.mjs](../../../bench/value-validation/agent.mjs)의 `handoff`). 같은 이유로 Part 2 전체 입력 토큰 추정 상한을 3,400만에서 3,500만으로 고쳤다. | 조건, 작업, 지표, 판정 규칙, seed, Part 1 실측 결과. 결과를 보기 전의 산술 정정이라 새 Human Decision은 필요 없다. |

