# Value Validation 01: 토큰·시간 측정 근거

Codex와 Claude Code가 어떤 토큰·시간 값을 내는지, 그 값을 이 실험에서 어떻게 분류하는지 정리한다(S15P31A106-280, Issue #28). 이 문서는 [protocol](README.md)의 조건, 지표, 판정 규칙을 바꾸지 않는다. protocol 의미를 바꿔야 할 내용은 [§8](#8-protocol-개정-제안으로-남길-사항)에 제안으로만 남긴다.

벤치마크 실행은 하지 않았다. 아래 내용은 공식 문서, CLI `--help`, 저장소 코드, 공식 문서 형식을 따른 샘플, 그리고 출력 형식 확인을 위해 승인받아 실행한 작은 `claude -p` 로그 두 개(인증 실패 1, 성공 1, [§6](#6-검증에-쓴-샘플))로 확인했다.

## 1. 분류 기준

| 상태 | 뜻 | 예 |
|---|---|---|
| `MEASURED` | CLI나 harness가 실행 중에 직접 관측해 기록한 값 | Codex `turn.completed` usage, Claude Code 최종 `result`의 `usage`, harness wall time |
| `ESTIMATED` | 근거는 있지만 직접 관측하지 않은 값. 보고서에서 측정값과 같은 칸에 두지 않는다 | Claude Code `total_cost_usd`, protocol §11의 실행 전 예상 사용량 |
| `NOT MEASURED` | 믿을 수 있는 값이 없음. 코드에서는 `null`이며 `0`으로 바꾸지 않는다 | 잘린 출력, 일부 run의 값 누락, CLI가 내지 않는 지표 |

규칙:

- 값이 없으면 `null`이다. 유효한 `0`은 측정값으로 남는다.
- run 하나라도 값이 없으면 합계와 중앙값은 `null`이고, 측정된 run 수를 함께 보고한다([measure.mjs](../../../bench/value-validation/measure.mjs)의 `sumAll`, `medianAll`, `countMeasured`).
- 일부만 관측한 합계(부분합)는 측정값이 아니다. 조건의 비용을 실제보다 작게 보이게 하므로 `NOT MEASURED`로 둔다.

## 2. 확인한 버전과 자료

| 대상 | 버전·시점 | 자료 |
|---|---|---|
| Codex CLI | `codex-cli 0.149.1` | `codex exec --help`(`--json`: "Print events to stdout as JSONL"), [measure.mjs](../../../bench/value-validation/measure.mjs) `parseEvents`, PR #24 |
| Claude Code CLI | `2.1.263 (Claude Code)` | `claude --help`(`--output-format`, `--print`, `--verbose`, `--include-partial-messages`, `--max-budget-usd`) |
| Claude Code 문서 | 2026-10-23 확인 | Run Claude Code programmatically(`code.claude.com/docs/en/headless`), Agent SDK Track cost and usage(`code.claude.com/docs/en/agent-sdk/cost-tracking`), Agent SDK TypeScript reference의 `SDKResultMessage`(`code.claude.com/docs/en/agent-sdk/typescript`) |

CLI 버전이 바뀌면 필드가 달라질 수 있다. 실제 실행 결과를 보고할 때는 실행에 쓴 CLI 버전을 다시 적고, 이 문서와 다르면 파서 테스트를 먼저 갱신한다.

## 3. 출력 방식

### Codex

`codex exec --json`이 JSONL event를 낸다. 토큰은 `turn.completed` event의 `usage`(`input_tokens`, `cached_input_tokens`, `output_tokens`)에 있다. `parseEvents`는 모든 `turn.completed`를 합하며, 하나라도 입력·출력 토큰이 없으면 usage 전체를 `null`로, 하나라도 `cached_input_tokens`가 없으면 `cached`를 `null`로 둔다. 시간은 Codex가 내지 않으며 harness가 잰다.

### Claude Code

`claude -p`에 `--output-format`을 준다.

- `json`: 실행이 끝나면 `result` 메시지 하나를 JSON 문서로 낸다.
- `stream-json`(`--verbose` 필요): 줄마다 event 하나. 보통 `system/init`, `assistant`·`user` 메시지가 이어지고 `result`가 온다. 문서는 마지막 줄이 `result`라고 하지만, CLI 2.1.263 실제 실행에서는 `result` 뒤에 `system/task_summary` 줄이 하나 더 나왔다. 설정된 hook이 있으면 `init` 앞에 `system/hook_started`, `system/hook_response`가 나온다. 그래서 줄 위치가 아니라 `type`으로 `result`를 찾는다.

`result`의 형식(문서의 `SDKResultMessage`): `subtype`(`success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`), `is_error`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `modelUsage`.

## 4. 지표별 출처·정밀도·가용성

| 지표 | Codex | Claude Code | 분류 |
|---|---|---|---|
| 입력 토큰 | `turn.completed.usage.input_tokens`의 합. 정수, 세션 단위 | 최종 `result.usage.input_tokens`. 정수, 호출 단위(주 agent loop만) | MEASURED. event·필드가 없으면 NOT MEASURED |
| 캐시 입력 토큰 | `cached_input_tokens`(입력 토큰에 포함된 캐시분) | `cache_creation_input_tokens`(캐시 쓰기)와 `cache_read_input_tokens`(캐시 읽기)를 따로 보고 | MEASURED. 필드가 없으면 그 값만 NOT MEASURED |
| 출력 토큰 | `turn.completed.usage.output_tokens`의 합 | 최종 `result.usage.output_tokens` | MEASURED |
| 전체 실행 시간 | harness wall time(`performance.now()`, 0.1초 단위, 프로세스 시작부터 종료까지) | harness wall time. 추가로 CLI가 낸 `duration_ms`, `duration_api_ms`(ms) | MEASURED(각 출처를 따로 적는다) |
| 도구별 실행 시간 | CLI가 내지 않음 | CLI가 내지 않음 | NOT MEASURED(Part 1 검증 도구 시간은 harness가 따로 잼) |
| 사람 개입 시간 | 자동 측정 불가 | 자동 측정 불가 | protocol §9 양식으로 사람이 잰 값만 MEASURED, 없으면 NOT MEASURED |
| 사용자 승인 요청 | 최종 메시지를 사람이 판정(`askedHuman`) | 같음 | 판정하지 않은 run이 있으면 NOT MEASURED |
| 실제 과금액 | 내지 않음 | `total_cost_usd`는 클라이언트 추정값 | 청구 자료가 있을 때만 MEASURED. `total_cost_usd`는 ESTIMATED |
| 세션 안 구간별 토큰 | 내지 않음 | assistant event의 usage는 있으나 중복·placeholder가 있음([§5](#5-claude-code-집계-규칙)) | NOT MEASURED |

### 시간 값의 차이

- harness wall time: 프로세스를 띄운 순간부터 끝날 때까지. CLI 시작, 인증, MCP 연결, background 작업 대기까지 포함한다. 조건 간 비교에는 이 값을 쓴다.
- `duration_ms`: Claude Code가 잰 호출 전체 시간. 시작 시점은 CLI 내부 기준이므로 harness wall time보다 짧을 수 있다.
- `duration_api_ms`: 모델 API 요청에 쓴 시간. 도구 실행과 대기 시간은 빠진다. 문서에 따르면 background subagent를 기다리는 동안의 작업도 포함된다.
- 공식 문서는 `duration_ms`와 `duration_api_ms`의 시작·종료 지점을 정확히 정의하지 않는다. 그래서 두 값은 서로 더하거나 wall time과 바꿔 쓰지 않고 각각 따로 보고한다.

## 5. Claude Code 집계 규칙

[claude-measure.mjs](../../../bench/value-validation/claude-measure.mjs)의 `parseClaudeResult`가 이 규칙을 구현한다. 아직 harness 실행 경로에는 연결하지 않았다(검증용 순수 함수).

1. **최종 `result`만 읽는다.** `assistant` event의 usage는 더하지 않는다. 문서에 따르면 한 응답에서 여러 assistant 메시지가 같은 message id와 같은 usage를 반복하고, assistant 메시지의 `output_tokens`는 응답 시작 시점의 placeholder이다.
2. **`result`가 정확히 하나일 때만 값을 낸다.** 없으면(잘린 stream, 실행 실패) 모든 값이 `null`이다. 둘 이상이면 turn마다 범위가 다르므로(`usage`는 turn 단위, `total_cost_usd`는 누적) 더하지 않고 `null`로 둔다.
3. **필드는 하나씩 판단한다.** 숫자가 아닌 필드는 그 값만 `null`이다. `usage` 객체가 없으면 usage 전체가 `null`이다. 유효한 `0`은 그대로 둔다.
4. **캐시 쓰기와 캐시 읽기를 합치지 않는다.** 단가와 의미가 다르다. Codex의 `cached`와 같은 칸에 넣는 규칙은 정하지 않았다([§8](#8-protocol-개정-제안으로-남길-사항)).
5. **`error_during_execution`, `error_max_budget_usd` 결과의 usage와 cost는 `null`이다.** 문서상 앞의 것은 session crash 때 비용 필드가 0으로 채워질 수 있고, 뒤의 것은 `usage`에서 예산을 넘긴 응답이 빠진다. 시간 값(`duration_ms`, `duration_api_ms`)은 남긴다.
6. **API 오류로 끝난 결과의 usage와 cost도 `null`이다.** `terminal_reason`이 `api_error`이거나, `subtype`이 `success`인데 `is_error`가 `true`인 경우다. 실제 CLI 2.1.263 실행에서 인증이 실패하자(모델 호출 없음) `result`는 `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`였고 토큰과 `total_cost_usd`가 모두 `0`이었다. `subtype`만 보면 정상 실행의 측정값 `0`으로 잘못 읽힌다.
7. **`total_cost_usd`는 `costUsdEstimate`(ESTIMATED)로만 둔다.** 문서는 이 값이 빌드 시점의 가격표로 계산한 클라이언트 추정값이며 실제 청구와 다를 수 있다고 밝힌다.

알려진 한계(코드로 막지 않았다):

- `result.usage`는 주 agent loop만 센다. subagent가 쓴 토큰은 빠지고 `modelUsage`와 `total_cost_usd`에만 들어간다. subagent를 쓰는 run에서는 `usage`가 실제보다 작다.
- `--continue`, `--resume`으로 이어 받은 세션의 `total_cost_usd`와 `modelUsage`는 이전 실행 비용을 포함한다. 독립 run에서만 run 단위 값으로 볼 수 있다.

## 6. 검증에 쓴 샘플

공식 문서 형식 샘플 3개와 실제 실행 로그 2개로 검증했다. 실제 실행은 모두 2026-10-23, CLI 2.1.263, 구독 로그인(claude.ai), 빈 임시 폴더에서 `claude -p "<파일 두 개를 병렬로 읽고 한 줄로 답하라>" --allowedTools Read --output-format stream-json --verbose --max-budget-usd 0.5`로 했다. 첫 실행은 OAuth 세션 만료로 모델 호출 없이 끝났고(비용 0, [§5](#5-claude-code-집계-규칙) 6번 검증), 다시 로그인한 뒤의 실행은 성공했다.

| fixture | 출처 | 내용 |
|---|---|---|
| [result.json](../../../bench/value-validation/fixtures/claude/result.json) | 문서 형식, 만든 숫자 | `--output-format json`의 성공 결과 |
| [stream.jsonl](../../../bench/value-validation/fixtures/claude/stream.jsonl) | 문서 형식, 만든 숫자 | `system/init`, 같은 id를 공유하는 병렬 tool 호출 assistant 메시지 2개, tool result, 두 번째 응답, 최종 `result` |
| [truncated.jsonl](../../../bench/value-validation/fixtures/claude/truncated.jsonl) | 문서 형식, 만든 숫자 | 위 stream이 `result` 줄 중간에서 끊긴 것 |
| [auth-failed.real.jsonl](../../../bench/value-validation/fixtures/claude/auth-failed.real.jsonl) | 실제 실행(인증 실패) | hook event, `system/init`, 합성 assistant 메시지, `subtype: "success"`·`is_error: true`·`terminal_reason: "api_error"`·모든 토큰 `0`인 `result` |
| [real-stream.jsonl](../../../bench/value-validation/fixtures/claude/real-stream.jsonl) | 실제 실행(성공) | hook event, 같은 id의 assistant 메시지 3개(thinking, tool_use 2), tool result 2, 응답, `result`, 그 뒤 `system/task_summary` |

성공 실행에서 관측한 값:

| 값 | 출처 | 관측 |
|---|---|---|
| 입력 / 캐시 생성 / 캐시 읽기 / 출력 토큰 | 최종 `result.usage` | 4 / 60,177 / 59,856 / 184 |
| 같은 값을 assistant event에서 단순 합산 | assistant 메시지 4개 | 8 / 179,889 / 59,856 / 7 |
| harness wall time | 셸에서 잰 프로세스 시작~종료 | 12,360 ms |
| `duration_ms` / `duration_api_ms` | 최종 `result` | 8,857 ms / 4,920 ms |
| `total_cost_usd` | 최종 `result`(ESTIMATED) | 0.2545 |

assistant event를 단순 합산하면 캐시 생성 토큰은 같은 message id가 세 번 반복돼 약 3배가 되고, 출력 토큰은 placeholder(2, 1)라 실제 184 대신 7이 된다. 세 시간 값은 서로 크게 다르므로 바꿔 쓰지 않는다.

비식별 처리: 문서 형식 샘플의 숫자는 만든 값이고, 프롬프트·응답 본문은 `<redacted>`, 세션 ID는 `session-redacted`, 모델 이름은 `<model>`로 바꿨다. 실제 로그는 허용 목록 방식으로 줄였다. event의 `type`·`subtype`·`parent_tool_use_id`, 내용 블록의 `type`, message id(`msg_1`처럼 바꿈, 중복 관계는 유지), 토큰·시간·비용 숫자와 상태 필드만 남기고 프롬프트, 응답, 파일 내용, 세션 ID, 경로, 계정·rate limit 정보는 모두 버렸다(`auth-failed.real.jsonl`은 assistant의 `model`과 `error`도 남겼고 message id는 `msg-redacted`). 원본 로그는 저장소 밖 로컬에만 둔다. 회귀 테스트는 [claude-measure.test.mjs](../../../bench/value-validation/claude-measure.test.mjs)에 있다.

Codex 파서의 샘플과 회귀 테스트는 [measure.test.mjs](../../../bench/value-validation/measure.test.mjs)에 있다.

## 7. 반드시 NOT MEASURED로 남기는 값

- CLI가 내지 않는 도구별 실행 시간, 세션 안 구간별 토큰
- 사람이 재지 않은 사람 단계 시간, 판정하지 않은 승인 요청 여부
- 청구 자료가 없는 실제 과금액(`total_cost_usd`를 대신 쓰지 않는다)
- usage event가 하나라도 불완전한 Codex 세션의 토큰, `result`가 없거나 둘 이상인 Claude Code 실행의 값, API 오류·crash·예산 초과로 끝난 Claude Code 실행의 토큰과 비용
- 값이 빠진 run이 하나라도 있는 조건의 합계·중앙값

## 8. protocol 개정 제안으로 남길 사항

결과를 보기 전이지만 판정 규칙에 닿을 수 있어 protocol은 고치지 않고 제안으로만 남긴다.

1. **Claude Code를 Part 2·3에 넣는다면** 캐시 토큰을 어떻게 표에 둘지 정해야 한다. 현재 지표 "캐시된 입력"은 Codex의 `cached_input_tokens` 하나를 전제한다. Claude Code는 캐시 쓰기와 읽기를 따로 내므로 두 칸으로 보고하는 안을 제안한다.
2. **subagent를 쓰는 Claude Code run의 토큰**을 `usage`로 볼지 `modelUsage` 합으로 볼지 정해야 한다. 정하기 전에는 subagent가 있었던 run의 토큰을 NOT MEASURED로 두는 편이 protocol의 부분합 금지 규칙에 맞다.
