# 05. Context Compiler

상태: Frozen (T00 final, 2026-09-27) · T10 구현 반영(2026-09-27) · T10.1 relevance policy, T11 Knowledge Gap 반영(2026-09-28) · 관련: REQ-CONTEXT-001~003, REQ-GAP-001, REQ-NFR-005, [ADR-005](adr/ADR-005-token-measurement.md), [ADR-008](adr/ADR-008-deterministic-first.md)

Context Compiler는 Task 하나에 대해 "이번 작업을 하는 Coding Agent에게 무엇을 보여줘야 하는가"를 결정적으로 답한다. 결과는 token budget 이하의 **Director Context Packet**이다. 전체 Repository 요약은 만들지 않고 LLM, embedding, vector DB를 쓰지 않는다. MCP의 `duo_get_context`가 주 사용자다(Context Gateway, [ADR-004](adr/ADR-004-mcp-context-gateway.md)). 구현은 `packages/director/src/context/`, 공식 토큰 측정은 `packages/director/src/tokens/`다.

## 입력

```ts
compileContext(root, { task, budget?, profile? }, { graph, registry?, historyWindow?, cache?, nodeLimit? })
```

| 입력 | 의미 | 기본값 |
|---|---|---|
| task | 자유 텍스트 또는 ID(`"AUTH-03"`, `"GAME-42 refresh token 만료 처리"`, `"D-004"`). 검색 입력일 뿐이며 shell, 경로, SQL에 넣지 않는다 | 필수 |
| budget | o200k_base token 상한. 1,000~1,000,000 | `context.default_budget_tokens`(6000) |
| profile | `default`(코딩 task) 또는 `review`(T13, Review의 맥락). 같은 packing 정책이며 Digest 입력 | `default` |
| explicitSeeds | 호출자가 직접 지정한 Entity(Review의 diff seed: 변경 Symbol·Test·File·Truth 정의). match `diff`인 explicit·필수 seed이고, 있으면 task 텍스트가 비어도 된다. 없으면 기존 결과가 byte 단위로 같다 | 없음 |
| graph | Project Graph. 읽기만 한다 | 필수 |
| cache | `.duo-project/cache/`의 Packet cache와 파일별 token 수 cache를 읽고 쓸지 | false |
| inspection | 호출자가 이미 한 current `inspectIndex` 결과(Review는 한 번 검사하고 두 번 compile). current가 아니면 무시하고 다시 검사 | 없음 |
| nodeLimit | 후보 상한. Digest 입력 | 200 |

빈 task, 범위 밖 budget, 모르는 profile, frame보다 작은 budget은 `CONTEXT_REQUEST_INVALID`(error, transient)다. 05의 초기 설계에 있던 `include_diff`는 T10에 없다(C85).

## 파이프라인

```text
freshness(읽기 전용 inspectIndex) → Project Truth → Seed 해석 → 가중 탐색 → 후보와 순위
  → Source slice → Packet Dependency Digest → [cache] → budget 배분 → Packet → 지표
```

결과는 `ContextResult { status, packet?, resolution, freshness, signals, metrics?, cache, performance, diagnostics }`이고 status는 네 가지다.

| status | 조건 | packet |
|---|---|---|
| `ready` | Index가 current이고 seed가 있음 | 있음 |
| `index-required` | `inspectIndex`가 stale, missing, incompatible. missing과 incompatible은 `freshness.fullRebuildRequired: true` | 없음 |
| `ambiguous` | 정확한 신호 없이 후보가 갈림 | 없음. `resolution.ambiguities`에 선택지 |
| `insufficient-context` | seed 없음 | 없음. `no-seed` signal |

## Freshness

Compiler는 시작할 때 `inspectIndex`(T08.1)를 부르고 current일 때만 Graph를 쓴다. stale Graph를 조용히 쓰지 않고, 스스로 Index하지 않는다. 읽기 조작이 쓰기를 하지 않는다는 원칙에 따라 Compiler가 쓰는 것은 `cache: true`일 때의 regenerable cache뿐이다.

## Seed 해석

결정적 신호만 쓴다(`context/seeds.ts`).

| 신호 | 규칙 | 강도 |
|---|---|---|
| ID | Task의 정의 ID(Requirement, Decision, Constraint, Issue, Milestone). Issue key는 대소문자 무관(`game-42`). Graph에 없으면 `unresolvedIds` | 1.0 |
| 경로 | 구분자(`/` 또는 `\`)가 있는 저장소 상대 경로 token이 core `normalizeRepoPath`로 정규화한 뒤 존재하는 File Node 경로와 같음. task에는 POSIX·역슬래시 구분자와 선택적 `./`·`.\`를 쓸 수 있고 저장되는 RepoPath는 POSIX다(C252, T47). 첫 directory가 `.`으로 시작해도(`.github/workflows/ci.yml`) 그대로 읽는다(C256, T54). 절대 경로·저장소 밖 경로·구분자 없는 root 파일은 경로 신호가 아니다. seed `term`은 task의 표기, `ref`는 canonical 경로 | 1.0 |
| Symbol | token이 qualifiedName과 정확히 같은 Symbol 하나 | 1.0 |
| Symbol 이름 | token이 이름과 같은 Symbol 하나 | 0.9 |
| diff | `explicitSeeds`의 Entity(Graph에 있을 때). explicit(T13) | 1.0 |
| 키워드 | Task를 검색어로 나눠(camelCase·snake_case 분해, 소문자, 불용어 제거, 한글은 공백 단위) Requirement 제목·본문, Decision 제목·question·answer, Constraint statement·keywords, Issue 제목·본문, Milestone 제목, Symbol 이름, 파일 경로에 BM25(k1 1.2, b 0.75). 최고값의 30% 이상인 상위 8개를 최고값으로 정규화해 × 0.6. ID token과, exact ID·path·Symbol seed로 소비된 token은 같은 요청의 BM25 검색어에 넣지 않는다: 존재하는 File로 exact path seed가 된 token(C249, T46), 유일한 qualified name·유일한 이름·하나의 callable group으로 Symbol seed가 된 token(C251, T50). 그 token의 단어(`src`·`auth`, `session`·`open`)가 이름이 겹치는 무관한 파일·Symbol과 그것을 governs하는 Decision을 끌어오지 않도록 한다. 각 신호의 해석 조건은 위 행 그대로이고, 해석되지 않거나 모호한 token과 나머지 단어는 그대로 검색어다 | ≤ 0.6 |

Proposal ID(`P-018`)는 seed가 아니라 그 proposal을 PENDING HUMAN DECISIONS에 넣는 신호다.

**모호함**(C87): ID, 경로, 유일한 이름처럼 정확한 신호가 하나라도 있으면 그것을 쓴다. 정확한 신호가 없고 (1) 같은 이름의 Symbol이 2~5개이거나, (2) 같은 qualifiedName이 여러 파일에 있거나, (3) 키워드 최고점이 Requirement 둘 이상에서 같으면 `ambiguous`이고 선택지를 돌려준다. 6개 이상과 맞는 이름은 너무 일반적이라 seed도 모호함도 아니다. 예외(T24.3, C218): 후보가 모두 Indexer가 기록한 C++ 선언·정의 쌍 하나의 그룹이면 같은 callable이므로 모호함이 아니고 구성원 모두가 seed다. 그 Symbol item은 그룹의 선언과 구현 범위를 함께 보이며(머리줄 `경로:줄 + 경로:줄`, 부분마다 `// 경로:줄`) 같은 그룹 item은 하나만 남는다([T24.3](roadmap/0.2.0-t24-cpp-declarations.md)). LLM으로 억지 seed를 고르지 않는다.

## 가중 탐색

`traverse()`의 BFS가 아니라 seed에서 시작하는 best-first 탐색이다(`context/expand.ts`, C80). 후보의 순서 값은 seed 강도 × 경로 hop weight의 곱이고 경로가 여럿이면 최댓값이다. nodeLimit은 먼저 방문한 것이 아니라 값이 큰 것을 남긴다.

| Edge | hop weight |
|---|---|
| GOVERNS | 1.0 |
| IMPLEMENTS, TRACKED_BY | 0.9 |
| VALIDATED_BY | 0.8 |
| REQUIRES, CALLS | 0.7 |
| CONTAINS | 0.6 |
| IMPORTS | 0.5 |
| CHANGED_WITH | 0.3 |

- `maxDepth = context.max_depth`(기본 2, 최대 3), nodeLimit 200, 확장한 Node마다 Edge 2000개까지. 한도에 걸리면 `traversal-truncated` limitation이다.
- Project Node는 지나가지 않는다. Milestone, Decision, Issue는 자기 seed 항목(depth 0)일 때만 확장한다. Decision 하나가 여러 Requirement를 governs하거나 Milestone이 모든 Requirement를 requires해도 형제 Requirement가 최고 weight로 끌려오지 않는다.
- SUPERSEDES는 따라가지 않는다. 활성 Decision은 Project Truth의 `superseded_by`로 찾는다.
- **언어 친화(T18.0)**: code 후보(File, Symbol, Test)가 자기를 데려온 code seed와 다른 언어 계열이면 순서 값에 `CROSS_LANGUAGE_FACTOR`(0.5)를 곱한다. Java Symbol이 seed면 Java subgraph가 먼저이고, 같은 Requirement를 구현한 Python·TypeScript 코드는 그 뒤에 남는다. TypeScript·TSX·JavaScript는 한 계열이고 Truth seed와 Analyzer 없는 파일은 언어가 없어 곱하지 않는다(TS만 있는 저장소의 순서는 그대로).
- weight는 비교 순서로만 쓰고 Packet에 노출하지 않는다. Packet의 `rank`는 순서다. 정책을 바꾸면 `CONTEXT_POLICY_VERSION`(현재 "7": 3은 T42 H-76 explicit primary seed 우선, 4는 T46 C249 exact path token을 BM25 입력에서 제외, 5는 T47 C252 `./`·역슬래시 경로 표기를 canonical RepoPath로 해석, 6은 T50 C251 exact Symbol token을 BM25 입력에서 제외, 7은 T54 C256 첫 directory의 앞 `.` 보존)을 올린다.

## 후보 분류

| Node | Packet 위치 | tier |
|---|---|---|
| Requirement | CONFIRMED INTENT · Requirements | requirement |
| Decision(confirmed, superseded_by 없음) | CONFIRMED INTENT · Active Decisions | decision |
| Decision(superseded) | Decision History(ID, 제목, superseded_by만). 후계 활성 Decision을 같은 순서 값으로 넣고 `SUPERSEDED_BY` 근거를 붙임 | - |
| Decision(proposed), Constraint(draft) | PENDING HUMAN DECISIONS | pending |
| Decision(rejected), Constraint(retired) | 넣지 않음 | - |
| Constraint(confirmed) | CONFIRMED INTENT · Constraints | decision |
| Symbol, File | RELEVANT CODE. 근거 경로에 CHANGED_WITH가 있으면 historical, depth ≤ 1이거나 마지막 Edge가 IMPLEMENTS·GOVERNS면 direct, 나머지 structural | code-direct, code-structural, code-historical |
| Test | TESTS | test |
| Issue, Milestone | ISSUES / MILESTONE | issue |

Constraint는 Graph Edge가 없다(T07). confirmed와 draft Constraint는 공통 relevance policy의 `matchConstraint`로 판정해 `none`이 아니면 넣는다(`MATCHES` 근거, [Intent relevance policy](#intent-relevance-policy), C84).

**필수 항목**: 정확한 seed(키워드 seed 제외), 활성 Decision, 맞은 confirmed Constraint는 budget보다 먼저 L1로 넣는다. pending decision은 frame에 L1로 항상 들어간다.

## Pending Human Decision

Proposal은 Project Truth가 아니다(T09.1). pending 여부는 core `pendingDecisionProposals()`만 정하며 Compiler가 파일을 해석하지 않는다.

- 넣는 조건: proposal이 참조하는 ID(`governs.requirements`, `supersedes`, references, evidence)가 seed 또는 depth ≤ 1의 Truth 후보이거나 활성 Decision이거나, Task가 proposal ID를 적었을 때. 관계없는 proposal은 넣지 않는다.
- 각 항목은 `confirmed: false`, `status: "PENDING / NOT CONFIRMED"`, `relatesTo`, `requiresHumanDecision`(정확한 seed나 depth ≤ 1의 Truth를 참조하거나 활성 Decision을 supersede할 때)을 가진다. Packet의 `requiresHumanDecision`은 그중 하나라도 true인지다.
- ranking 후보가 아니고 CONFIRMED INTENT에 들어가지 않는다. Markdown은 "Not confirmed … do not implement them as decided"로 시작한다.

## Intent relevance policy

T10.1. "이 intent가 현재 Task와 관련 있는가"를 한 곳(`packages/director/src/relevance/`, `RELEVANCE_POLICY_VERSION` "2", T11.1)에서 정한다. Context Compiler(Constraint 선택), Knowledge Gap(Declared Gap), 이후 Review가 같은 함수를 쓰고 각자 matcher를 두지 않는다. 점수는 없고 결과는 `direct | related | none`과 근거 목록(`reasons: { code, ref?, detail? }[]`), 근거가 된 scope 항목(`matched`)이다.

scope는 Task의 후보 맥락을 순위 순으로 늘어놓은 목록이다(`ScopeEntry { id, ref, type, hops, seed, path?, qualifiedName? }`). Compiler는 탐색 후보 전체를, Gap assessment는 Packet 항목과 `omittedCandidates`(hops 없음)를 넘긴다.

| 함수 | direct | related | none |
|---|---|---|---|
| `matchConstraint` | `match.paths`·`match.symbols`에 맞는 코드 항목이 seed이거나 seed에서 1 Edge(`match-path`, `match-symbol`) | 그 코드 항목이 더 멀리 있음, 또는 Task 텍스트에 `match.keywords`가 있음(`match-keyword`) | 둘 다 아님 |
| `matchDeclaredGap` | Task가 gap 자체를 가리킴(key token, 또는 정규화한 gap text 전체 포함, 4자 이상, `gap-mentioned`. project gap 포함), owner가 explicit seed(`task-seed`), explicit seed에서 1 Edge인 Requirement·Decision(`near-intent`), explicit seed에서 닿은 Requirement를 맥락 안 활성 Decision이 governs(`governed-by-active-decision`) | owner가 retrieved seed이거나 그것에서 닿음(`retrieved-seed`), 맥락의 다른 곳(Issue·Milestone, 2 Edge 이상, budget으로 생략, `in-context`), project gap이 Task와 검색어를 공유(`keyword-overlap`) | 그 외 |

**Seed provenance**(T11.1, C99): seed의 `match`가 id, path, symbol, symbol-name이면 **explicit**, keyword(BM25)면 **retrieved**다(`SEED_PROVENANCE`). scope 항목은 자기 seed 여부(`seed`)와 최선 경로가 시작한 seed의 provenance(`origin`, `originRef`)를 가진다. Context retrieval relevance와 Human-blocking confidence는 다르다: retrieved seed는 후보 탐색에 그대로 쓰지만, 그것만으로 gap이 direct(ask)가 되지 않는다. Packet 구조와 T10 선택 결과는 바뀌지 않는다(provenance는 `match`에서 파생).

첫 번째로 맞는 항목이 근거다. T10.1은 기존 판정을 옮기기만 했고 T10 fixture의 13개 요청에서 Packet JSON, Markdown, digest, token 수, 선택된 Constraint가 byte 단위로 같았다.

## Knowledge Gap signal

TASK-011이 쓸 구조화 신호만 낸다. 질문은 만들지 않는다.

| signal | 조건 |
|---|---|
| `no-seed` | seed 없음(insufficient-context) |
| `unresolved-id` | Task의 ID가 Graph에 없음 |
| `no-confirmed-intent` | Requirement와 활성 Decision·Constraint가 하나도 없음 |
| `unconfirmed-decision` | `requiresHumanDecision`인 pending decision이 있음 |

## Knowledge Gap assessment

TASK-011. Compiler는 무엇을 보여줄지 고르고, 무엇이 아직 정해지지 않았는지는 별도 서비스 `assessKnowledgeGaps({ request, result, truth })`(`packages/director/src/gap/`)가 정한다. Compiler는 질문을 만들지 않고 Packet 구조도 바뀌지 않는다. 입력은 Compiler 결과(status, resolution, Packet의 signals·pendingDecisions·limitations·항목)와 Project Truth(`truth.gaps`, Decision)다. 계산이 가벼워 cache하지 않는다. Compiler와 평가 모두 LLMProvider를 받지 않는다(T12A). Packet cache가 hit여도 같은 Packet으로 다시 평가하면 된다. LLM은 쓰지 않는다(`metrics.llmCalls: 0`).

- `index-required`면 판단하지 않는다: `status: "index-required"`, gap 없음, `requiresHumanInput: false`.
- Runtime Gap과 Declared Gap의 정의·ID는 [03 Knowledge Gap](03-data-model.md#knowledge-gap)이다.
- Declared Gap: resolved면 ignore. 아니면 relevance policy로 direct → ask, related → surface, none → ignore. direct라도 이미 결정된 gap은 다시 묻지 않는다. retrieved seed만으로는 related다(T11.1).
- Pending decision: Packet의 `requiresHumanDecision`은 "이 맥락에 닿는 미결정"이라는 context 표시다. ask는 명시적 연결(관련 ID가 explicit seed이거나 explicit seed에서 1 Edge, 또는 Task에 proposal ID)이 있을 때만이고, 검색으로만 닿았으면 surface다(C100).
- 기술적 불확실성(unresolved call·module, `.d.ts` 모호함, instance receiver, partial parse)은 gap이 아니다. `technicalLimitations`(Packet limitation 코드에서 intent 관련 `no-confirmed-intent`를 뺀 것)로만 남는다.
- `requiresHumanInput`은 ask gap이 하나라도 있을 때만 true다: 모호한 대상, 없는 ID, Task가 의존하는 pending decision, 직접 관련된 미해결 Declared Gap. intent 없음은 surface라 false다.
- 순서: action(ask, surface, ignore), kind 우선순위(ambiguous-target, unresolved-target, pending-decision, declared, missing-intent), 그 안에서 발견 순서 또는 owner의 Packet 순위, 마지막으로 ID. 첫 ask가 `primary`, 나머지 ask가 `additional`이다. 한 답이 다른 gap을 바꿀 수 있으므로 한 번에 하나를 먼저 묻는다(대화 loop는 MCP·CLI).
- 결과: `KnowledgeGapAssessment { format: "duo.gap-assessment/1", status, gaps, requiresHumanInput, primary?, additional, technicalLimitations, metrics }`. metrics는 declaredConsidered, runtime, direct, related, none, ask, surface, ignore, llmCalls이며 품질 지표가 아닌 관찰값이다.
- 문구: `renderGapQuestions(assessment, { locale })`가 고정 template로 `primaryQuestion`, `additionalQuestions`, surface gap의 `notes`를 만든다. locale은 `en`(기본)과 `ko`이고 호출자(CLI, MCP, UI)가 정한다. 언어를 추측하지 않는다. 선택·관련성·primary·filtering 로직은 없고 같은 assessment와 locale이면 byte 단위로 같다. Gap domain은 언어 중립 데이터(kind, anchors, options, reasons, action)이며 문장은 Declared Gap의 사람이 쓴 `text`뿐이다. pending proposal은 "확정되지 않은 제안"으로만 부르고 제안된 답은 쓰지 않는다.
- 같은 Task, Project Truth, Graph, proposal 상태, Packet이면 결과와 문구가 byte 단위로 같다(시각, locale, 파일 순회 순서에 의존하지 않음).

## 표현 단계

| Node | L1 | L2 | L3 |
|---|---|---|---|
| Requirement | ID 제목 (status, milestone, priority) | + 설명 첫 문단 | + 정의 slice(Markdown section) |
| Decision | ID 제목 = answer [state, enforcement] | + question, rationale | + 정의 slice(YAML 또는 ADR 파일) |
| Constraint | ID statement [state, enforcement] | - | + 정의 slice(목록 항목, 줄 처음부터) |
| Symbol | qualifiedName (kind) 경로:줄(위치가 여럿이면 `경로:4-6,8-10`) | + 위치마다 선언 첫 줄과 주석 첫 줄(빈 줄로 구분) | + 위치마다 Symbol 범위와 바로 위 주석·decorator(최대 12줄), source 순서, 빈 줄로 구분 |
| Test | fullName 경로:줄 | - | + test 호출 범위와 바로 위 주석 |
| Issue | ID 제목 (status, milestone) | + AC 목록 | + 정의 slice와 관련 커밋 3개(12자) |
| Milestone | ID 제목 (state) | - | - |
| File | 경로 (language) | Analyzer 없는 파일만(T18.0): head window. 처음 40줄과 2,000자 중 먼저 닿는 곳까지의 온전한 줄(한 줄이 더 길면 그 줄을 자름) | - |

- 모든 원문은 `readSourceFile`/`sliceSource`(T09.1)로 읽어 저장소 경계와 symlink를 다시 확인하고, 맞지 않는 위치는 잘라 맞추지 않는다(`SOURCE_LOCATION_INVALID`). slice가 실패한 후보는 L1만 남는다.
- **위치가 여럿인 Symbol(T24.1, C217)**: overload나 signature를 합친 Symbol은 primary와 `additionalLocations` 전체를 보여 준다(graph `nodeLocations`). 같은 줄은 두 번 나오지 않는다. 위치 하나라도 slice되지 않으면 L1만 남는다(본문 일부만 보여 주지 않음). level은 item 전체에 적용되고 item의 공개 `source`는 primary 하나다(Python은 확실할 때 실효 정의, T24.4, C226; 위치 순서는 그대로 source 순서). 위치가 하나인 Symbol의 text는 T24.1 이전과 같고, 그래서 `CONTEXT_POLICY_VERSION`은 2 그대로다(C225).
- 파일 전체는 기본으로 넣지 않는다. 멤버가 후보인 class는 L3를 빼고, Symbol이나 Test가 후보인 File은 따로 나열하지 않는다(정확한 seed인 File은 예외, C89).
- **Generic file(T18.0)**: Symbol이 없다고 파일 전체를 넣지 않는다. L2 head window가 상한이고 텍스트를 읽을 수 없으면(binary, UTF-8 아님) L1만 남는다. Python은 `#` 주석 줄도 바로 위 주석으로 센다.
- **Capability limitation(T18.0)**: 후보 코드의 언어가 가진 한계를 limitation으로 알린다. `structural-analysis-unavailable`(Analyzer 없는 파일: 경로와 head window만), `imports-syntactic`(Java, C#: import가 파일을 잇지 않음), `imports-partial`(C++, Python: 확실한 대상만), `calls-unresolved`(Java, C#: CALLS 없음), `calls-same-file`(C++, Python: 같은 파일의 유일한 함수만). CALLS Edge가 없다는 것이 호출이 없다는 뜻이 아님을 Agent가 알 수 있게 한다. 언어의 capability는 File payload의 language와 기본 Analyzer profile(analyzer `DEFAULT_LANGUAGE_PROFILES`)에서 읽는다.
- 알려진 비밀 형식은 측정 전에 `[REDACTED]`로 바꾼다([10](10-security.md)). Task 텍스트도 같고 200 token까지 인용한다.

## Budget 배분

`context/pack.ts`. 앞에서부터 자르지 않는다. 항목은 어떤 표현 단계로 들어가거나 들어가지 않는다.

1. **frame(reserved)**: header, TASK, section heading, pending decision L1, limitation. frame이 budget보다 크면 `CONTEXT_REQUEST_INVALID`.
2. **필수 항목** L1.
2a. **explicit primary seed(H-76, T42, F-23)**: task 문자열에 정확한 Definition ID로 적혀 seed match가 `id`인 Requirement 또는 Issue는 필수 항목 다음, 다른 어떤 승격보다 먼저 한 단계씩 들어가는 가장 높은 표현까지 올린다(Issue L3 = 본문과 Acceptance Criteria 전체가 든 source slice, Requirement L3 = 설명 전체). 그 대가로 test, code, evidence, 다른 issue가 빠질 수 있다. keyword·path·symbol seed, Review의 diff seed(`explicitSeeds`, match `diff`), traversal로 찾은 항목은 이 우선권이 없다. 여럿이면 plan 순서(tier, 순서값, 깊이, ID)로 처리해 task에 적힌 순서와 무관하다. full 표현이 들어가지 않으면 들어가는 가장 높은 단계(L1·L2·L3 중 하나, AC를 일부만 자른 표현은 만들지 않는다)를 넣고 limitation `explicit-seed-truncated`(seed ID, budget, full 표현의 token 수, 보인 단계)를 붙인다. 이 limitation은 frame 예약에 최악의 길이로 포함한다. 필수 항목 L1을 먼저 두는 것은 active Decision과 confirmed Constraint가 빠지지 않게 하려는 것이다.
3. **상한 있는 단계**: tier 순서 requirement > decision > pending > code-direct > test > issue > code-structural > code-historical로, tier마다 L0→L1, L1→L2, L2→L3 순서로 한 단계씩 올린다. tier는 남은 승격 budget의 몫(25%, 15%, 5%, 30%, 12%, 5%, 6%, 2%)까지만 쓰고, L3는 파일마다 2개까지다. 한 파일의 Symbol이 Packet을 채우지 않게 하는 장치다.
4. **상한 없는 단계**: 같은 순서로 남은 budget을 쓴다. 비용이 남은 budget보다 크면 그 항목을 건너뛴다(작은 하위 항목은 들어갈 수 있다).
5. **정확한 확인**: 렌더링한 Markdown 전체를 o200k_base로 다시 센다. 넘으면 마지막 승격부터 되돌린다. 일반 승격이 먼저 되돌려지고 explicit primary seed의 승격은 그 뒤다. budget은 넘지 않는다(AC-010-02).

항목 비용은 항목 block과 EVIDENCE 줄의 token 수다. 들어가지 못한 후보는 `omittedCandidates`(id, ref, rank, tier, reason)에 남고, 하나라도 있으면 `truncated: true`다. 표현이 최대 단계보다 낮은 항목 수는 `summarized` limitation으로 알린다.

## Packet 모델

```ts
ContextPacket {
  format: "duo.context-packet/1"
  request: { task, taskTruncated, budget, profile }
  seeds: { id, ref, match, term }[]
  intent: { requirements: PacketItem[], constraints: PacketItem[] }
  decisions: { active: PacketItem[], history: { id, title, state: "superseded", supersededBy }[] }
  code: PacketItem[]; tests: PacketItem[]; issues: PacketItem[]
  pendingDecisions: { id, kind, title, confirmed: false, status: "PENDING / NOT CONFIRMED", requiresHumanDecision, relatesTo, level, text, tokens, source? }[]
  evidence: { id, ref, via }[]
  limitations: { code, message }[]
  signals: KnowledgeSignal[]
  omittedCandidates: { id, ref, rank, tier, reason: "budget" }[]
  truncated, requiresHumanDecision
  metrics: { estimator, budget: { total, reserved, used, remaining }, candidates, selected, omitted,
             candidateTokens, selectedTokens, rendered: { tokens, estimator, bytes, chars }, redactions, llmCalls: 0 }
  dependencyDigest
}
PacketItem { id, ref, kind, rank, tier, level, text, tokens, source?, via: { seed, steps: { from, type, to, provenance }[] }, state? }
```

CLI, MCP, UI는 이 구조를 쓴다. 시각처럼 바뀌는 값은 Packet에 없고, 같은 입력이면 JSON과 Markdown이 byte 단위로 같다(REQ-NFR-005, AC-010-03). 단계별 시간(`performance`)은 결과에만 있다.

## Markdown 출력

`renderContextMarkdown(packet)`은 형식만 만든다. 선택 로직이 없고 budget은 이 텍스트로 잰다. Section 순서는 고정이며 잘 변하지 않는 항목을 앞에 둔다.

```text
# DUO CONTEXT PACKET
budget 6000 tokens (o200k_base) · profile default · llm_calls 0
Task-scoped subset of the project graph. It is not the whole project context.
## TASK            AUTH-03 / seeds: AUTH-03 (id)
## CONFIRMED INTENT
### Requirements   - AUTH-03 Refresh Token (planned, M1, must) + 정의 slice
### Constraints    - CON-001 Tokens are never written to logs. [confirmed, block]
### Active Decisions - D-015 Short-lived JWT with refresh token = … [confirmed, block]
### Decision History (superseded, not active) - D-004 … — superseded by D-015
## RELEVANT CODE   - AuthService.refresh (method) src/auth/AuthService.ts:28-34 + 코드
## TESTS           - AuthService > refresh returns a new access token …
## ISSUES / MILESTONE - GAME-42 Refresh token expiry (todo, M1)
## PENDING HUMAN DECISIONS
Not confirmed. These are open questions for a human, not instructions; do not implement them as decided.
- P-018 Refresh token rotation — PENDING / NOT CONFIRMED · requires human decision
## EVIDENCE        - AuthService.refresh: AuthService.refresh IMPLEMENTS AUTH-03 [declared]
## LIMITATIONS     - CALLS edges exist only for exactly resolved calls; …
```

header에 used 값은 없다. 자기 길이를 포함하는 숫자라 JSON(`metrics.budget.used`)에만 둔다(C88). EVIDENCE는 항목마다 마지막 Edge와 hop 수 한 줄이고 전체 경로는 JSON `via`에 있다.

## Packet Dependency Digest와 cache

`packetDependencyDigest`는 Packet을 만든 입력 전체의 sha256이다(C81).

- 포함: task(인용 텍스트의 hash, 잘림 여부), budget, profile, `CONTEXT_POLICY_VERSION`, tokenizer identity(`o200k_base@gpt-tokenizer@4.0.0`), 탐색 한도, seed, 순위가 매겨진 **모든 후보**(Node ID, tier, rank, 필수 여부, 위치, 근거 경로의 Edge 종류·끝점·provenance, 표현 단계별 텍스트 hash), pending decision, superseded history, signal.
- 제외: `graph_revision`, `index_state_token`, 후보 Subgraph 밖 파일.
- 선택되지 않은 후보도 넣는다. `omittedCandidates`로 Packet에 나오고, 그 크기가 무엇이 빠질지를 정했기 때문이다.
- Digest는 packing 전에 계산한다. packing과 렌더링은 이 입력의 순수 함수이므로 같은 Digest면 같은 Packet이다. 그래서 cache hit는 새로 만든 결과와 같다.

| 변경 | Digest | 이유 |
|---|---|---|
| 후보 Subgraph 밖 파일 | 같음(cache hit) | 입력이 아님 |
| 후보 파일에서 선택된 범위 밖이고 줄 위치를 바꾸지 않는 변경 | 같음 | File은 L1(경로)만, Symbol은 자기 범위와 줄 번호만 입력 |
| 선택된 Requirement 본문 | 바뀜 | 정의 slice. Graph topology와 graph_revision은 그대로일 수 있음 |
| 선택된 Symbol 내용 또는 줄 위치 | 바뀜 | slice와 L1의 줄 번호 |
| budget, profile, 정책·tokenizer version | 바뀜 | 직접 입력 |
| 새 관련 proposal, Decision supersede | 바뀜 | pending, history, 활성 Decision |

cache는 `.duo-project/cache/packets/<digest>.json`(`duo.packet-cache/1`)이고 `checkWriteBoundary(..., "regenerable")` 뒤 임시 파일 + rename으로 쓴다. 없거나 손상됐거나 digest가 다른 항목은 miss이고 miss는 시간만 더 든다. 기본은 꺼져 있다(C83).

## 지표

Packet 안(`packet.metrics`)은 그 Packet에 대한 값만 둔다: budget(total, reserved, used, remaining), 후보·선택·생략 수, candidateTokens(모든 후보의 최대 표현 비용 합, frame 제외), selectedTokens(= used), 렌더링 텍스트의 bytes·chars, 치환 수, `llmCalls: 0`.

요청 단위 값(`result.metrics`)은 Packet 밖에 둔다(C82): Repository files·tokens·bytes·chars, Files Considered, rawCandidateTokens(후보가 있는 파일 전체의 token 합), Files Loaded, reduction(vsRepository, vsRawCandidates, 소수 둘째 자리). Repository 합계는 관계없는 파일에도 바뀌므로 Packet에 넣으면 모든 cache가 무효가 된다. 정의는 [09](09-token-strategy.md#지표)다. 요청마다 `runtime/metrics.jsonl`에 기록하는 일은 호출자가 한다: CLI `duoctl context`는 status, Packet token 수와 budget, llmCalls, 소요 시간만 덧붙이고 task 원문은 쓰지 않는다(T15, C83). CLI는 index가 current가 아니면 자동으로 index하지 않고 `INDEX_REQUIRED`(종료 코드 6)를 보이며 `--refresh`일 때만 index 후 compile한다. 기본 출력은 `renderContextMarkdown`, `--json`은 `ContextResult` 그대로다([07](07-cli-interface.md)).

`performance`는 freshness, seed, traversal, ranking, retrieval, tokenization, packing, metrics, total의 ms다.

## Review용 소형 Packet

Review의 의미 판정([ADR-008](adr/ADR-008-deterministic-first.md), T13·T12B)은 Context Packet을 LLM에 보내지 않는다. 의미 후보 claim(ID, rule, expected, observed)과 Review가 이미 수집한 Evidence 발췌(Truth slice, 바뀐 코드 slice, diff hunk)를 `llm.max_input_tokens` 안에서 발췌당 잘라 한 batch로 보낸다. 파일 전체, 저장소, Graph는 보내지 않는다. Context Compiler와 Knowledge Gap 평가는 T12B 뒤에도 Provider를 받지 않는다(`llmCalls: 0`).
