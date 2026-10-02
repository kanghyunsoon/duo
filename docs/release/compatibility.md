# 0.1.0 호환성 계약 (format freeze)

0.1.0 release candidate부터 아래 형식은 공개 계약이다. 0.x이어도 공개한 형식을 조용히 바꾸지 않는다.

## Freeze 대상

| 표면 | 형식 | 비고 |
|---|---|---|
| CLI `--json` | envelope `duo.cli.<command>/1` { format, command, ok, exitCode, result, diagnostics } | result는 아래 semantic payload |
| Semantic payload (CLI result, MCP structuredContent 공통) | `duo.status/1`, `duo.context/1`, `duo.context-packet/1`, `duo.gap-assessment/1`, `duo.review/1`, `duo.trace/1`, `duo.impact/1`, `duo.requirement/1`, `duo.decision/1`, `duo.evidence-search/1`, `duo.proposal/1`, `duo.not-initialized/1`, `duo.init-plan/1`, `duo.agent-integration-plan/1`, `duo.agent-integration-status/1`, `duo.agent-integration-verify/1` | wall-clock 성능 값은 payload 밖 metadata |
| Doctor (0.2.0 추가, T26.1) | `duoctl doctor --json` = envelope `duo.cli.doctor/1`, result `duo.doctor/1` `{ format, overall, checks, next }` | CLI 전용(MCP tool 없음). check ID, `group`, `status`(ok·info·warning·error·skipped), `reason`, `requires`, action ID·`commands`·`params`, facts 필드 이름이 계약이다. check·reason·action 추가는 additive이고 소비자는 모르는 값을 무시한다. 사람 문구는 계약이 아니다. 종료 코드 0(error 없음)·6(error check)·1(실행 오류) |
| MCP | tool 9개의 이름, input schema, `structuredContent` 형식(위 payload) | 서버 이름 `duo-director` |
| UI local API | `/api/*` 응답 `duo.ui.<name>/1`, 오류 `duo.ui.error/1` (`UI_API_VERSION` 1) | loopback 전용, 같은 버전의 UI만 사용 |
| Project Truth | `.duo-project/project.yaml` `schema_version: 1`과 intent·specs·decisions·milestones 문서 형식 | 사람이 소유한 파일 |
| Review Record | `duo.review-record/1` | `.duo-project/reviews/` |
| Adoption Baseline | `duo.adoption-baseline/2` | /1은 이미 incompatible로 읽음(재해석 없음) |

## Freeze 대상이 아닌 것

재생성 가능한 데이터(Graph DB schema, index state, analysis·packet·token·LLM cache, fingerprints)와 runtime metrics(`duo.metric/1`)는 공개 계약이 아니다. 형식이 달라지면 지금처럼 incompatible로 보고하고 다시 만든다(몰래 migration하지 않는다). 사람이 읽는 CLI 출력 문구도 계약이 아니다.

## Breaking change 정책

- 필드 추가처럼 기존 소비자가 계속 동작하는 변경(additive)은 같은 `/1`에서 한다.
- 필드 제거, 의미 변경, 타입 변경, 필수 필드 추가는 breaking이다. 새 형식 `/2`를 쓰고, 기존 `/1`을 읽는 쪽이 필요한 경우 한동안 함께 제공하거나 명시적 incompatible로 거절한다.
- 사람이 소유한 Project Truth의 breaking change는 `schema_version`을 올리고, 옛 version은 명확한 오류(지원 version 안내)로 거절한다. 자동 변환이 필요하면 별도 명령으로 사람 확인을 거친다. 범용 migration framework는 만들지 않는다.
- Review Record와 Adoption Baseline은 기록이므로 다시 쓰지 않는다. 새 형식은 새 기록부터 쓰고 옛 기록은 읽기 전용으로 둔다.
- 모든 breaking change는 release notes와 conflicts.md에 이유와 함께 남긴다.
