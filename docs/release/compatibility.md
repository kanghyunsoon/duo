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

## 0.2.1 변경 분류 (T32.4, H-65)

0.2.0 → 0.2.1은 packaging-only patch다. 위 freeze 대상은 하나도 바뀌지 않았다.

| 분류 | 내용 |
|---|---|
| Packaging | runtime dependency 트리를 package가 직접 싣는다(`bundleDependencies`, `node_modules/` 67 package, `dist/runtime-tree.json`). `npm-shrinkwrap.json`은 package에 없고 저장소의 build-time release lock으로 남는다. 설치 트리 = runtime tree를 npm 10/11/12의 global·project-local 설치에서 검증한다(C242) |
| Unchanged | 모든 CLI·MCP·UI API 형식, MCP tool 9개와 input schema, `duo.review-record/1`, `duo.adoption-baseline/2`, project.yaml `schema_version: 1`, 명령·옵션·종료 코드, runtime 동작 |
| Runtime | Node.js `>=24.15.0`. runtime dependency version은 0.2.0 lock과 같다(release lock diff는 package version 두 곳) |
| Internal-only | `dist/runtime-tree.json`(`duo.runtime-tree/1`)은 release tooling metadata이며 공개 계약이 아니다. `.dist/release-candidate.json`은 `duo.release-candidate/2`, `.dist/release-audit.json`은 `duo.release-audit/2` |

**0.2.0에서 만든 index.** analysis identity(analyzer·resolution·relation rules version)가 같으므로 0.2.1의 첫 확인은 `current`이고, 그 뒤 `duoctl index`는 parse 0·Graph 쓰기 없이 끝난다. Truth, adoption baseline, agent 설정은 그대로이며 re-init·re-adoption·migration이 없다.

## 0.2.2 변경 분류 (T43, H-75)

0.2.1 → 0.2.2는 correctness·security patch다(C243, C244, H-77). Truth를 다 읽은 저장소에서는 위 freeze 대상이 하나도 바뀌지 않는다.

| 분류 | 내용 |
|---|---|
| Behavior correction | 권위 있는 작업(review, context, Adoption Baseline 캡처, Decision confirm·reject·repair·confirm preview)은 loader가 일부만 읽은 Project Truth에서 실행하지 않고 `PROJECT_TRUTH_INVALID`와 각 파일 오류로 실패한다(review·context 종료 코드 1, verdict·packet 없음). `BROKEN_REFERENCE`·`REFERENCE_TYPE_MISMATCH`만 예외. propose는 그대로 허용. doctor `truth.project`는 `invalid`, MCP review는 `isError`, UI review는 verdict 없이 오류 |
| Additive public | status `truth.errors`(CLI JSON, MCP `duo_get_status`), decision list `diagnostics`의 읽지 못한 파일, diagnostic code `PROJECT_TRUTH_INVALID`. 모두 같은 `/1` |
| Unchanged | Truth를 다 읽은 저장소의 review·context 결과와 JSON, 다른 모든 CLI·MCP·UI API 형식, MCP tool 9개와 input schema, `duo.review-record/1`, `duo.adoption-baseline/2`, project.yaml `schema_version: 1`, 명령·옵션, analysis identity |
| Dependency (security) | upstream High advisory GHSA-6qxp-vccf-f47h 때문에 MCP SDK release group(`@modelcontextprotocol/client`·`server`·`core`)을 2.1.0 → 2.2.0으로 올린다. 다른 bundled package·license·install script는 그대로(67 package). MCP protocol version, tool 9개와 schema, `duo_get_status`, stdio launch probe(install verify, doctor) 동작은 같다 |
| Downgrade | DUO 0.3이 쓴 저장소(예: `forbids.imported_paths`)를 열 수 있는 가장 낮은 버전은 0.2.2다. 0.2.2는 그 field를 이해하지 않고 review를 거부한다. 0.2.1 이하로 여는 것은 지원하지 않는다(C244) |

## 0.3.0 변경 분류 (T63, H-81)

0.2.2 → 0.3.0. 0.3.0은 검증한 0.3.0-rc.6의 제품 source(`d0f29a5`)를 그대로 승격한다. 아래는 rc.1~rc.6 누적이며 개별 변경은 각 rc notes와 아래 H-80 절에 있다. format major bump는 없다.

| 분류 | 내용 |
|---|---|
| Additive Truth | Decision·proposal `forbids.imported_paths`(H-72), Issue `implements.paths`(H-78). `schema_version: 1` 그대로. 새 field가 없는 Decision의 lock digest는 같다 |
| Additive public | MCP `duo_propose_decision`의 `forbids`·`enforcement`·`supersedes`(H-71, 0.2.x 입력 그대로 허용, tool 9개). review rule 값 `decision-forbids-import`, Decision claim의 `decisionAuthority`(C241). Adoption Baseline 새 capture의 `evaluatedRules`. CLI `duoctl decision review-pending`. diagnostic `DECISION_CONFIRM_PREVIEW_CHANGED`·`DECISION_SESSION_CONFLICT`, context limitation `explicit-seed-truncated`. 모두 같은 `/1`·`/2` |
| Behavior correction | Context seed 정밀도(명시 seed 보존 H-76, exact path·symbol의 BM25 재사용 제거 C249·C251, `./`·역슬래시·leading-dot·root file 경로 C252·C256·H-79). missing-intent gap 단독은 WARN이 아님(H-80, C239). invalid Truth fail-closed는 0.2.2와 같음 |
| Regenerated | `CONTEXT_POLICY_VERSION` 2 → 8, Graph relation rules 1 → 2. cache와 index가 한 번 다시 만들어진다(`duoctl index` 1회) |
| 사람이 읽는 출력 | provenance 표시 용어(H-73), MCP review text의 Knowledge gap, missing-intent 문구(C258). `duo.context/1`의 렌더된 `gaps.surfaced[].note` 값 |
| Local UI API | proposal confirm에 preview digest가 필요(번들 UI가 보냄) |
| Review Record | 형식 `duo.review-record/1` 그대로. H-80 때문에 missing-intent가 있는 Review를 새로 기록하면 ID가 달라질 수 있고 기존 Record는 다시 쓰지 않는다 |
| Unchanged | `duo.review/1`·`duo.gap-assessment/1`·`duo.context-packet/1`·`duo.review-record/1`·`duo.adoption-baseline/2` 형식, project.yaml `schema_version: 1`, CLI 종료 코드, MCP tool 수(9) |
| Downgrade | floor는 0.2.2. 0.3 전용 Truth를 쓰는 저장소를 0.2.2는 `PROJECT_TRUTH_INVALID`로 거부한다. 0.2.1 이하는 지원하지 않는다(C244) |
| Known limitation | `outside-current-milestone` PARTIAL WARN noise(C259, 0.2.x와 같은 동작) |

## 0.4.0-rc.1 변경 분류 (T134, branch `next`, dist-tag `next`)

0.3.4 → 0.4.0-rc.1. prerelease이며 stable `latest`는 0.3.4다. 0.3.4의 보안 dependency update(#88·#89: MCP SDK 2.3.1, zod 4.6.7)를 같은 version으로 포함한다. 포함: #52·#79·#85·#86 Work map, #53·#54·#76·#78 UI local API, #61 MCP annotation, #75·#81 launcher 검사(#40). review·context·Decision 확정의 결과는 같은 입력에서 0.3.4와 같다.

| 분류 | 내용 |
|---|---|
| Additive public | UI local API `duo.ui.decisions/1`·`duo.ui.decision-detail/1`·`duo.ui.preview/1`과 Work map route(`work-map`·`work-revision`·`work-expand`·`work-tasks`·`work-task-complete`·`work-events`). install verify JSON의 선택 필드 `verify.warnings`(`launcher-version-mismatch`), doctor warning `version-mismatch`(facts `cliVersion`·`serverVersion`·`resolved`, action `align-launcher`) |
| MCP annotation | `duo_get_context`·`duo_review_changes`가 `readOnlyHint: false`·`idempotentHint: false`·`destructiveHint: true`(0.3.4까지 read-only). metrics와 Work map 활동 파일을 쓰기 때문이다. tool 이름·input schema·결과는 같다. 실제 Codex·Claude Code 승인 UX는 측정하지 않았다 |
| Behavior correction | install plan은 agent의 실효 PATH에서 launcher를 찾지 못하면 exit 6으로 멈추고 쓰지 않는다(0.3.4까지 `Verify: ok`). `/api/decisions/{id}`·`/api/proposals/{id}/preview`의 query, `/api/decisions`의 반복 query 이름은 400 `UI_REQUEST_INVALID`(#77). Work map task 이름·agent label은 저장·표시 전에 secret redaction(#84) |
| Internal-only | `runtime/work-tasks.json`(`duo.work-tasks/2`, 128 KiB), `cache/work-map.json`. 재생성 가능한 local 파일이며 init의 `.gitignore`에 이미 있다 |
| Unchanged | Truth schema(`schema_version: 1`), Decision Lock 형식과 digest, `duo.review/1`·`duo.context/1`·`duo.context-packet/1`·`duo.gap-assessment/1`·`duo.review-record/1`·`duo.adoption-baseline/2`, `CONTEXT_POLICY_VERSION`, Graph 형식, MCP tool 9개, install plan 외 CLI 종료 코드, runtime dependency 트리(0.3.4 대비 shrinkwrap diff는 version 두 곳, 67 packages) |
| Migration | 없음. Truth·lock·Record·agent 설정을 다시 쓰지 않는다. launcher 검사를 쓰려면 사람이 `duoctl install <agent>`를 다시 실행한다 |
| Downgrade | 0.3.4는 같은 Truth를 읽고 Work map 파일을 무시한다. 0.3 Truth의 floor는 그대로 0.2.2 |
| Known limitation | launcher PATH는 Windows에서만 측정(pnpm dlx 식별 불가, npm test/start·run-script·pnpm run 미측정, Yarn Classic 부분), redaction은 알려진 credential 형식만, 접근성 수동 검증 미완료(#73), C259·C260·#7·#4 그대로 |

## 0.3.3 변경 분류 (T78, H-87)

0.3.2 → 0.3.3. UX·안정성 patch(H-87). 새 규칙과 새 검사 종류, dependency 변경, 형식 major 변경은 없다. review의 verdict·claim·evidence·gap, context, Decision 결과는 0.3.2와 같다(T77에서 같은 저장소·같은 변경으로 나란히 확인).

| 분류 | 내용 |
|---|---|
| Additive 필드 | `duo.status/1` `truth.unscopedConstraints`(match 범위 없는 confirmed Constraint ID, 없으면 빈 배열), `duo.doctor/1` `truth.project` facts `unscopedConstraints`, `duo.review/1` limitation `constraints-unscoped`(verdict 입력 아님). MCP `duo_get_status` text에 `constraints not checked` 부분(#14) |
| 오류 분류 | `duoctl init --answers -`의 잘못된 answer 모양은 `INIT_ANSWER_INVALID`(질문·필드·예). 0.3.2는 `CLI_USAGE_INVALID: a.statements is not iterable`. 종료 코드 1, 쓰기 0은 같다(#15) |
| 사람 출력 | review의 CONFLICT claim 아래 `observed:` 한 줄(#16). init constraint 질문 문구와 안내 줄, status·doctor·review의 미검사 constraint 줄(#14). install의 Codex trust·Claude Code 승인 안내 문구(`warnings`·`nextActions` 문자열, #3(a)) |
| 생성 문구 | Agent bridge block에 tool 목록 재확인 한 줄(9줄). 설치된 0.3.2 block은 `outdated`, `duoctl install <agent>`가 사람 확인 뒤 block만 갱신(#8 M2) |
| 시작 동작 | `duoctl mcp`는 typescript·gpt-tokenizer·MCP client·yaml·Markdown parser를 처음 쓸 때 읽는다. tool 9개의 이름·schema·annotation과 결과는 같고 token 수도 같다. `duoctl`은 시작할 때 선언된 runtime dependency를 resolve만 해서 빠진 dependency를 incomplete installation으로 보고한다(#8 M1). 측정값은 환경에 따라 다르며 보장값이 아니다 |
| Unchanged | Truth schema(`schema_version: 1`), Decision Lock 형식, Adoption Baseline, `duo.context/1`·`duo.context-packet/1`·`duo.gap-assessment/1`·`duo.review-record/1`·`duo.adoption-baseline/2`, `CONTEXT_POLICY_VERSION` 8, Graph 형식, MCP tool 9개, CLI 종료 코드 표, H-80, C261~C265, R-DRIFT(#7), Constraint를 결정적으로 검사하지 않는다는 계약(ADR-007, C107/H-33) |
| Migration | 없음. re-init 불필요. bridge block은 사람이 install을 다시 실행할 때만 바뀐다 |
| Downgrade | 0.3.2는 같은 Truth를 읽는다. 0.3 Truth의 floor는 그대로 0.2.2 |
| Known limitation | Constraint 미검사(C-C·C-D는 0.4), 실제 Codex MCP 발견률 NOT TESTED(#8 Open), #7 README drift, C259·C260 WARN noise, stale index 수동 갱신, 여러 단계의 처음 설정, `.mcp.json` 재직렬화 |

## 0.3.2 변경 분류 (T73, H-86)

0.3.1 → 0.3.2. UX patch(H-84, H-85, H-86). 새 기능, 형식 변경, dependency 변경은 없다. review·context·Decision 결과는 0.3.1과 같다.

| 분류 | 내용 |
|---|---|
| Behavior correction | `duoctl install remove <agent>`: DUO가 만든 설정 파일(`.codex/config.toml`, `.mcp.json`)을 계획대로 지우고 결과를 `delete`로 보고하며 status는 `not-configured`(#6, C266). 0.3.1은 파일을 그대로 다시 쓰고 `modify`로 보고했다 |
| 생성 문구 | Agent bridge block(AGENTS.md, CLAUDE.md)에 두 줄: duo-director MCP server tool 찾기와 CLI fallback, proposal tool이 없을 때 사람에게 알림(#8). 설치된 0.3.1 block은 `outdated`, `duoctl install <agent>`가 block만 갱신 |
| Unchanged | Truth schema(`schema_version: 1`), Decision Lock 형식, `duo.review/1`·`duo.context/1`·`duo.context-packet/1`·`duo.gap-assessment/1`·`duo.review-record/1`·`duo.adoption-baseline/2`, `CONTEXT_POLICY_VERSION` 8, Graph 형식, MCP tool 9개, CLI 종료 코드 표, H-80, C261~C265 동작, R-DRIFT(#7은 그대로) |
| Migration | 없음. re-init 불필요. bridge block은 사람이 install을 다시 실행할 때만 바뀐다 |
| Downgrade | 0.3.1은 같은 Truth를 읽는다. 0.3 Truth의 floor는 그대로 0.2.2 |
| Known limitation | #7 README external-source-drift, C259·C260 WARN noise, stale index 수동 갱신, 여러 단계의 처음 설정, client별 MCP discovery 차이 |

## 0.3.1 변경 분류 (T68, H-83)

0.3.0 → 0.3.1. Correctness patch(H-82, C261~C265). 새 기능과 format major bump는 없다. 정상 Project Truth와 정상 입력의 결과는 0.3.0과 같다.

| 분류 | 내용 |
|---|---|
| Behavior correction | 이전에 verdict(대개 PASS)가 나던 다음 경우가 이제 verdict 없는 작업 실패다(CLI 1, MCP `isError`, Review Record 없음). (1) Decision authority가 온전하지 않음: 현재 상태의 lock 불일치(범위 밖 commit 포함), lifecycle·supersession 모순, Decision처럼 보이지만 읽히지 않는 Markdown(C261~C263, `PROJECT_TRUTH_INVALID`). (2) `--staged`·`--to <commit>`의 reviewed snapshot이 바뀐 경로나 Project Truth에서 working tree와 다름(C264). (3) 필수 review·task Context 컴파일 실패(C265). 범위 안에서 confirmed Decision이 proposed·rejected가 되면 blocking claim `confirmed-decision-retired` |
| Additive public | diagnostic `DECISION_INTEGRITY_INVALID`·`DECISION_SOURCE_INVALID`·`REVIEW_SNAPSHOT_MISMATCH`·`REVIEW_ANALYSIS_INCOMPLETE`, claim reason `confirmed-decision-retired`, limitation `reviewed-side-context-from-working-tree`. 모두 같은 `/1` |
| 사람이 읽는 출력 | status·decision list·doctor·`PROJECT_TRUTH_INVALID` 문구가 읽지 못한 Truth와 모순된 Truth를 함께 설명 |
| Unchanged | Truth schema(`schema_version: 1`), Decision Lock 형식과 digest 대상 field, `duo.review/1`·`duo.context/1`·`duo.context-packet/1`·`duo.gap-assessment/1`·`duo.review-record/1`·`duo.adoption-baseline/2`, `CONTEXT_POLICY_VERSION` 8, Graph 형식(0.3.0 index가 그대로 current), MCP tool 9개, CLI 종료 코드 표, H-80 |
| Migration | 없음. Truth·lock·Record를 다시 쓰지 않고 re-init이 필요 없다 |
| Downgrade | 0.3.0은 같은 Truth를 읽지만 다섯 결함이 돌아온다. 0.3 Truth의 floor는 그대로 0.2.2 |
| Known limitation | C259(그대로). C264는 정확한 snapshot 분석이 아니라 fail closed. lock으로 보이지 않는 것(범위 밖 삭제, digest 재계산, lock 삭제) |

## 0.3.0 개발 변경: missing-intent verdict (branch `next`, T58, H-80)

0.3.0-rc.5 뒤 `next`의 변경이며 0.3.0-rc.6에 들어간다. 형식 변경이 아니라 같은 `/1`의 판정 정정이다(C239, C110).

| 분류 | 내용 |
|---|---|
| Behavior correction | Review는 surface된 `missing-intent` Knowledge Gap 하나만으로 WARN을 내지 않는다. 그 gap은 `verdictBasis.warn`에 들어가지 않고, 다른 WARN·ASK·BLOCK 근거가 없으면 verdict는 PASS다. 다른 surface gap(검색으로만 닿은 pending Decision, related declared UNKNOWN)은 계속 WARN이고 ASK·BLOCK·claim 판정은 그대로다. missing-intent만 있는 Review에서 `--fail-on warn`·`--strict`는 2 대신 0으로 끝난다 |
| Unchanged | `duo.review/1`(ReviewResult 형식, verdict enum, claim schema, `verdictBasis` 형식), `duo.gap-assessment/1`(gap kind·relevance·reasons·action `surface`·metrics), `duo.review-record/1` 형식, CLI·MCP·UI API 형식, MCP tool 9개와 input schema, 명령·옵션·종료 코드의 의미, `CONTEXT_POLICY_VERSION` 8 |
| Review Record | Record body에 verdict와 verdictBasis가 들어가고 ID는 body의 hash다. 그래서 missing-intent gap이 있는 Review를 새로 기록하면 이전 정책의 같은 Review와 다른 ID가 난다(WARN → PASS인 경우와, verdict는 같고 verdictBasis.warn만 바뀐 경우 모두). 기존 Record는 다시 쓰지 않으며 그대로 읽힌다 |
| 사람이 읽는 출력 | MCP `duo_review_changes` text 요약에 CLI와 같은 Knowledge gap 문구를 붙인다(문구는 계약이 아니다). CLI·UI 표시는 그대로다 |
| 사람이 읽는 문구 (T59, C258) | missing-intent 문구를 en "The context DUO assembled contains no confirmed Requirement or Decision intent.", ko "DUO가 구성한 Context에 확정된 Requirement/Decision intent가 없습니다."로 바꿨다(옛 문구는 "this task"와 Decision 부재를 과장했다). CLI review·context 출력, MCP review·context text, `duo.context/1`의 렌더된 문장 필드(`gaps.surfaced[].note`) 값이 바뀐다. 형식, gap 데이터, verdict, Review Record body·ID, Context Packet은 그대로다 |
| External Validation | External Validation 01은 정확히 0.2.1이며 그 버전의 기존 WARN 동작이 계속 관찰된다 |
