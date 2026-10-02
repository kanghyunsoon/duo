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
| Project Truth | `.duo-project/project.yaml` `schema_version: 1`과 intent·specs·decisions·milestones 문서 형식 | 사람이 소유한 파일. 0.2.0(T27.1): `llm.provider`에 `openai-compatible`, `llm.transport`, `llm.structured_output`을 더했다(additive). 기존 `none`·`openai-responses` 설정은 그대로 유효하고 의미도 같다 |
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

## 0.2.0 변경 분류 (T28, H-62)

0.1.2 → 0.2.0에서 위 freeze 대상 중 바뀐 것은 additive 추가뿐이다. 근거는 RC 설치본 conformance와 upgrade journey(`pnpm release:upgrade`: 공개 0.1.2가 도입한 저장소를 RC가 이어받음)다.

| 분류 | 내용 |
|---|---|
| Additive public | `duoctl doctor`: envelope `duo.cli.doctor/1`, result `duo.doctor/1`(CLI 전용). project.yaml `llm.provider: openai-compatible`과 `llm.base_url`·`llm.transport`·`llm.api_key_env`·`llm.structured_output`. compatible provider의 doctor facts `endpoint`(origin)·`transport`·`structuredOutput` |
| Behavior correction | overload의 모든 위치를 Context·Evidence·Review seed가 읽음(Java·C#·C++), Python 실효 정의를 primary 위치로(Evidence pointer·검색 위치·Packet item `source`), Python source-root 발견, 증명된 C++ 선언·정의 쌍을 Context 대상 하나로, 그 쌍 하나로만 일치하는 Truth qualifiedName 참조 해석, ambiguous 안내 문구(구조화 payload 불변), freshness 확인 속도(판정 불변). 모두 형식 변경이 아니며 기존 `/1` 소비자는 그대로 읽는다 |
| Internal-only | index state의 `relationRulesVersion`, index metadata `declaration_links`, analyzer·analysis cache identity, benchmark 결과 형식(`bench/`). 재생성 가능한 데이터이며 다르면 stale·incompatible로 보고하고 다시 만든다 |
| Unchanged | 다른 모든 CLI·MCP `/1` 형식, MCP tool 9개와 input schema, UI API, `duo.review-record/1`, `duo.adoption-baseline/2`, project.yaml `schema_version: 1`, 명령·옵션·종료 코드 |
| Runtime | Node.js `>=24.15.0`(Node 22 지원 선언 없음). runtime dependency 트리는 0.1.2와 같다(shrinkwrap diff는 package version 두 곳) |
| Known limitations | C224 overload member identity(Deferred), C229 polyglot Context ranking(Deferred to 0.2.x Context Quality / strategy validation), C232 C++ IMPORTS include path(문서화된 L1 한계), L2는 TypeScript/JavaScript만, openai-compatible은 local loopback endpoint로만 검증 |

**Doctor `/1`과 additive 필드.** `duo.doctor/1`은 0.2.0에서 처음 공개되는 형식이다. T26.1 뒤 T27.1에서 facts에 `endpoint`·`transport`·`structuredOutput`을 더한 것은 공개 전 변경이라 `/1` 초판에 포함된다. 공개 뒤에도 같은 종류의 필드 추가는 위 Breaking change 정책의 "필드 추가(additive)는 같은 `/1`"에 해당하고, doctor 행에 적힌 대로 소비자는 모르는 check·reason·action 값을 무시한다. 따라서 `/1`을 유지한다.

**0.1.x project.yaml.** llm 절 없음, `provider: none`, `provider: openai-responses`(key 없으면 LLM만 unavailable) 모두 0.2.0에서 그대로 parse되고 status·doctor·index·context·review가 동작한다. 새 필드는 `openai-compatible`에서만 필수다.

**0.1.2에서 만든 index.** 첫 확인은 `stale`이다(silent current 없음). `duoctl index` 한 번(incremental, 유효한 analysis cache 재사용)으로 `current`가 된다. Truth 파일, Requirement·Decision 상태, adoption baseline은 그대로 읽히며 re-init·re-adoption·migration이 없다.
