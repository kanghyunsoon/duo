# 04. Project Graph

상태: Frozen (T00 final, 2026-09-27) · 관련: REQ-GRAPH-001~003, REQ-INDEX-001~003, [ADR-002](adr/ADR-002-graph-storage.md), [ADR-003](adr/ADR-003-language-analysis.md)

Project Graph의 1차 목적은 **Context Localisation**이다. Task나 변경 Symbol을 seed로 작은 Subgraph만 탐색한다. UI 시각화는 같은 데이터를 읽는 보조 기능이다([conflicts.md C3](conflicts.md)).

## Node

Node ID는 core의 `nodeId(EntityRef)`만 만든다. 경로와 Symbol 구성 요소는 가역 escaping(`%` → `%25`, `#` → `%23`, 제어 문자 → `%XX`)을 거치며 Unicode와 대소문자는 그대로다. 규칙과 사례는 [03 ID와 EntityRef](03-data-model.md#id와-entityref)와 `fixtures/core/node-ids.json`에 있다.

| Type | ID 형식 | 출처 | payload(T07) |
|---|---|---|---|
| Project | `project:root` | project.yaml, vision.md | name, currentMilestone, git(headOid, branch, detached, branchIssueIds) |
| Milestone | `ms:M1` | milestones/*.yaml, Markdown `type: milestone` | title, state |
| Requirement | `req:AUTH-03` | specs/*.md, Markdown 정의 | title, status, milestone, priority |
| Decision | `dec:D-004`, `dec:CON-001`, `dec:ADR-005` | decisions/, constraints.yaml, frontmatter Markdown | decisionKind(decision, constraint), title, state, enforcement |
| Issue | `issue:GAME-42`, `issue:TASK-010` | milestones/*.yaml, Markdown `type: issue`. 커밋 메시지는 Node를 만들지 않고 provenance만 더함 | title, status, milestone, commits[](ID를 언급한 최근 커밋, 최대 20) |
| File | `file:src/auth/a.ts` | 스캔. `.duo-project/` 파일은 File Node가 아님(C47) | state(tracked, untracked), fingerprintMode, language, analysis(complete, partial, failed), analyzerVersion |
| Symbol | `sym:src/auth/a.ts#AuthService.refresh` | LanguageAnalyzer | name, qualifiedName, kind(`SymbolKind`), exported, memberScope, parent, additionalLocations, analyzerVersion |
| Test | `test:src/auth/a.test.ts#AuthService > refresh` | LanguageAnalyzer `tests`(T05.1)의 `kind: "test"`. ID는 RepoPath + fullName이며 위치를 넣지 않음 | name, fullName, frameworkHint, confidence, modifier, enclosingSuite, analyzerVersion |

payload는 종류별 zod strict schema(`NODE_PAYLOAD_SCHEMAS`, `packages/graph/src/build/payload.ts`)로 검증하는 lookup record다. 본문(Requirement text, Decision answer, acceptance)은 복사하지 않는다. 위치는 Node의 `source`, 내용 hash는 `contentHash` 칼럼에 두고 원문은 Source of Truth에서 다시 읽는다([03 Graph Build](03-data-model.md#graph-build)).

Proposal(P-*)은 Graph Node로 만들지 않는다. `duo_search_evidence`와 UI가 파일로 조회한다.

## Edge

방향은 항상 `src → dst`이며 아래 표가 정규 방향이다.

| Type | src → dst | 생성 근거 |
|---|---|---|
| CONTAINS | Project → Milestone, Project → File, File → Symbol, Symbol(class) → Symbol(member), File → Test | 구조 |
| REQUIRES | Milestone → Requirement, Requirement → Requirement(depends_on), Issue → Issue(depends_on) | declared |
| IMPLEMENTS | Symbol → Requirement, File → Requirement | declared(`implements.paths`, `implements.symbols`), static(코드 주석 `duo: AUTH-03`). 커밋과 이름 일치 근거는 만들지 않는다(C49) |
| CALLS | Symbol → Symbol | static, exact 해석만(아래 [CALLS 해석](#calls-해석task-007)). heuristic 결과는 저장하지 않는다(C48) |
| IMPORTS | File → File | static(TypeScript module resolution이 Repository 안의 indexed File 하나로 해석한 경우만) |
| GOVERNS | Decision → Requirement / Issue / File / Symbol | declared(governs, Task의 decisions, `governs.paths` 패턴, `governs.symbols`) |
| TRACKED_BY | Requirement → Issue | declared(Issue의 requirements) |
| VALIDATED_BY | Symbol → Test, Requirement → Test | static(test 범위 안 exact 호출의 대상, test에 붙은 annotation), declared(tests 패턴, 테스트 이름의 ID) |
| CHANGED_WITH | File → File(양방향 두 개 저장) | git(최근 500 커밋 중 3회 이상 함께 변경, 50파일 초과 커밋 제외, 두 파일 모두 indexed File. 후보 계산은 TASK-006 `computeCoChangeCandidates`). 의존 관계가 아닌 historical correlation |
| SUPERSEDES | Decision → Decision (new → old) | declared(`supersedes`). 대상이 존재해야 하고, 자기 대체와 순환은 금지(`DECISION_SUPERSEDES_SELF`, `DECISION_SUPERSEDE_CYCLE`). H-20으로 추가된 10번째 Edge Type. 순환에 속한 SUPERSEDES는 Graph에 넣지 않는다 |

이 표가 endpoint matrix다. Graph Builder와 `graph.check()`가 `EDGE_ENDPOINTS`(`packages/graph/src/build/endpoints.ts`) 한 곳으로 강제한다. GraphStore는 generic 저장소라 endpoint 의미를 검사하지 않는다. 허용되지 않은 endpoint나 없는 endpoint는 `EDGE_ENDPOINT_INVALID`(error)이며 plan 전체를 쓰지 않는다.

개발 지시문 예시의 `GAME-42 --TRACKED_BY--> AUTH-03`는 이 표와 방향이 반대다. 정규 방향은 "Requirement가 Issue로 추적된다"이다([conflicts.md C15](conflicts.md)).

### provenance와 confidence 정책

Edge metadata의 `provenance`는 `declared`, `static`, `git`, `heuristic` 중 하나다. 수치 confidence는 쓰지 않는다. heuristic Edge만을 근거로 한 Claim은 BLOCK에 기여할 수 없다([ADR-007](adr/ADR-007-verdict-model.md)).

T07부터 원칙은 **Evidence로 설명할 수 있는 관계만 저장한다**이다(H-24). 잘못된 Edge는 Context Compiler 입력을 오염시키므로 빠진 Edge보다 위험하게 다룬다.

- `declared`: Project Truth의 명시 참조(trace link, implements, governs, tests)와 그 경로·이름 매칭.
- `static`: 구조(CONTAINS), module resolution(IMPORTS), exact 호출 해석(CALLS), `duo:` annotation.
- `git`: CHANGED_WITH만 해당하며 `correlation: "historical"`과 `count`를 함께 둔다.
- `heuristic`: T07은 만들지 않는다. CALLS의 heuristic 해석 단계가 없어 통계의 heuristic 수는 항상 0이다.
- 같은 (src, type, dst)가 여러 근거에서 나오면 한 Edge로 합친다. 가장 강한 provenance(declared > static > git > heuristic)를 남기고 `basis` 목록(`implements.paths`, `annotation`, `exact-call` 등)을 합친다.
- 해석되지 않은 사실(unresolved, ambiguous, external module, unresolved call)은 Edge가 아니라 build plan의 `moduleResolutions`, `callResolutions`, `stats`에 남는다.

## SourceAnalysis

`LanguageAnalyzer.analyze()`의 반환 형식이다([ADR-003](adr/ADR-003-language-analysis.md), TASK-005, T05.1). 언어와 무관하게 같고 Tree-sitter 타입을 노출하지 않는다. 정렬, 위치 단위, partial, identity 규칙은 [03 Source analysis](03-data-model.md#source-analysis)에 있다.

```ts
interface SourceAnalysis {
  path: RepoPath;
  language: "typescript" | "tsx" | "javascript" | string;
  contentHash: string;                       // FileFingerprint.contentHash와 같음
  parseStatus: "complete" | "partial";
  symbols: { ref: SymbolRef; name: string; qualifiedName: string; kind: SymbolKind; exported: boolean;
             memberScope?: "static" | "instance"; parent?: string;
             location: SourceLocation; additionalLocations?: SourceLocation[] }[];
  moduleReferences: { specifier: string; kind: "import" | "export-from" | "dynamic-import" | "require";
                      typeOnly: boolean;
                      bindings: { local: string; imported: string | "default" | "*"; typeOnly: boolean }[];
                      reexports: { exported: string; imported: string | "*"; typeOnly: boolean }[];
                      location: SourceLocation }[];
  exports: { exported: string; local?: string; typeOnly: boolean; location: SourceLocation }[];   // v3
  callSites: { kind: "identifier" | "member" | "constructor"; calleeText: string;
               calleePath?: string[]; rootLocal?: true; thisBinding?: "member" | "other";   // v3
               enclosingSymbol?: SymbolRef; location: SourceLocation }[];
  annotations: { ids: string[]; location: SourceLocation }[];   // "duo: AUTH-03"
  tests: { name: string; fullName: string; kind: "test" | "suite";
           frameworkHint: "vitest" | "jest" | "node-test" | "unknown"; confidence: "explicit" | "heuristic";
           modifier?: "skip" | "only" | "todo"; enclosingSuite?: string; enclosingSymbol?: SymbolRef;
           location: SourceLocation }[];
}
type SymbolKind = "class" | "interface" | "type-alias" | "enum" | "function"
                | "method" | "constructor" | "getter" | "setter" | "accessor";
```

- **Symbol 범위**: top-level class, interface, type alias, enum, function 선언, initializer가 arrow function이나 function expression인 top-level 변수, 익명 default export(function, class, arrow), class의 method, constructor, getter, setter. 중첩 함수와 일반 상수(`const TIMEOUT = 5000`)는 Symbol이 아니다.
- **qualifiedName과 identity**: qualifiedName은 표시용이다. top-level은 이름, class member는 `Class.member`(private은 `AuthService.#refresh`), 익명 default export는 `default`(member는 `default.render`). identity(`ref.symbol`)는 static member만 `Class.static.member`이고 identifier가 아닌 이름은 `Class["a.b"]`다. computed name(`[Symbol.iterator]`)은 Symbol로 만들지 않는다.
- **overload와 병합**: 같은 identity는 한 Symbol이다. primary 위치는 본문이 있는 선언, 없으면 첫 선언이고 나머지는 `additionalLocations`다. getter와 setter는 같은 member scope 안에서만 `accessor` 한 개로 합친다(`static get name`과 `get name`은 다른 Symbol).
- **exported**: `export` 선언, `export default`, `export { a }` 목록. member는 class를 따른다.
- **ModuleReference**: 문자열 literal specifier만 기록하고 파일로 해석하지 않는다(상대 경로, tsconfig paths, package exports, node_modules 해석과 IMPORTS Edge는 TASK-007). `typeOnly`는 문장 전체가 `import type` / `export type ... from`일 때, binding의 `typeOnly`는 문장 또는 그 specifier가 type일 때다. `import x = require("y")`와 `require("y")`는 `require`다.
- **ImportBinding**: `import foo` → `foo → default`, `import { foo as bar }` → `bar → foo`, `import * as Ns` / `import Ns = require()` / `const Ns = require()` → `Ns → *`(CommonJS는 module 객체), `const { a, b: c } = require()` → `a → a`, `c → b`. side-effect import, dynamic import, 중첩 구조 분해는 binding이 없다. Graph Builder는 AST를 다시 읽지 않고 이 값만 쓴다.
- **ReExport**: `export ... from`은 local binding이 아니므로 `reexports`(`exported ← imported`, `export *`는 `* ← *`, `export * as ns`는 `ns ← *`)에 따로 둔다.
- **CallSite**: 이름이 있는 callee만 기록한다(identifier와 `super`는 identifier, member와 subscript는 member, `new`는 constructor). `calleeText`는 callee 원문에서 줄바꿈과 그 들여쓰기만 뺀 값이다. `enclosingSymbol`은 호출을 감싸는 가장 안쪽 Symbol이며 class field initializer는 class다.
- **CallSite 구조(v3)**: `calleePath`는 callee가 점으로 이은 이름일 때의 이름 목록(`["Auth", "login"]`, `["this", "#refresh"]`)이고 computed callee면 없다. `rootLocal`은 첫 이름이 감싸는 함수의 parameter나 지역 선언이라 module 수준 이름이 아님을 뜻한다. `thisBinding`은 `this`가 감싸는 class member의 것이면 `member`, 중첩 function 안이나 그 밖이면 `other`다. Builder가 원문을 다시 읽지 않고 해석하기 위한 syntax 사실이다(C51).
- **LocalExport(v3)**: 자기 선언을 내보내는 이름(`export function f`, `export { a as b }`, `export default X`)이다. `local`은 이름 없는 default expression이면 없다. re-export는 moduleReferences의 `reexports`에 있다.
- **Test**: literal 이름(문자열, substitution 없는 template literal)의 `test`, `it`, `describe`, `suite` 호출과 `.skip`, `.only`, `.todo`. `vitest`, `@jest/globals`, `node:test`에서 import한 binding(alias와 namespace 포함)이면 `explicit`과 그 framework, import 근거 없이 `*.test.*` / `*.spec.*` 파일의 전역 호출이면 `heuristic`과 `unknown`이다. 일반 source의 전역 `it()`이나 다른 곳에서 import했거나 선언한 같은 이름은 test가 아니다. `fullName`은 suite 이름을 ` > `로 이은 값이며 위치는 쓰지 않는다. 이름이 literal이 아니면 `TEST_NAME_DYNAMIC`(info)이고 기록하지 않으며 그 suite 안의 test도 기록하지 않는다. `enclosingSymbol`은 test 호출이 추출된 Symbol 안에 있을 때만 있다. Test Node와 VALIDATED_BY는 TASK-007이 만든다.
- **DuoAnnotation**: Tree-sitter comment 노드에서만 찾는다. 줄 주석 `// duo: AUTH-03`, block 주석의 각 줄(` * duo: AUTH-04, AUTH-05`)에서 `duo:`가 주석 줄의 시작에 있어야 한다. 앞쪽의 definition ID들이 ID 후보이고 첫 non-ID token부터는 설명이다(`// duo: AUTH-07 — 로그인 보조` → `["AUTH-07"]`). ID가 없으면 `DUO_ANNOTATION_INVALID`. 문자열 안의 `"duo: AUTH-03"`은 annotation이 아니다.

### Module resolution과 IMPORTS(TASK-007)

- Builder는 `ModuleResolver` interface만 쓴다. 구현은 `TypeScriptModuleResolver`이고 TypeScript Compiler API의 module resolution을 그대로 따른다(ADR-003). DUO는 NodeNext, 확장자 대체, `paths`, `baseUrl`, package `exports`/`imports` 규칙을 다시 구현하지 않는다.
- 결과는 다섯 가지다. `resolved`(path, `claim: "typescript-resolution"`, declarationOnly, extensionSubstituted, configPath), `external`(package, builtin, outside-repository), `unresolved`(not-found, not-indexed), `ambiguous`, `unsupported`(URL, 절대 경로).
- `resolved`는 "TypeScript가 이 파일로 해석했다"는 주장이다. Node runtime이 그 파일을 실행한다는 주장과 구분하려고 `claim`, `extensionSubstituted`(`./foo.js` → `foo.ts`), `declarationOnly`(`.d.ts`)를 metadata에 둔다.
- IMPORTS는 결과가 `resolved`이고 대상이 다른 indexed File일 때만 만든다. `node_modules`와 Repository 밖 경로는 File Node가 되지 않는다. re-export(`export ... from`)도 같은 조건이다. 한 파일 쌍의 여러 참조는 한 Edge이며 metadata에 `kinds`(import, export-from, dynamic-import, require), `typeOnly`(모든 참조가 type일 때), declarationOnly, extensionSubstituted, resolution claim을 둔다.
- `MODULE_UNRESOLVED`(warning)는 상대 경로가 not-found일 때만 낸다. 설치되지 않은 bare package는 TypeScript 결과로 external과 구별할 수 없어 external(package)로 센다. `MODULE_AMBIGUOUS`는 후보 파일이 둘 이상일 때다.

### CALLS 해석(TASK-007)

**CALLS extraction is syntactic (TASK-005). Target resolution happens once, in the Graph Builder, and only exact results become edges.** TypeScript Program과 Type Checker는 쓰지 않는다(ADR-003). 해석 결과는 `exact | heuristic | ambiguous | unresolved`이고 exact만 CALLS Edge가 된다. heuristic 단계는 구현하지 않았다(C48).

exact 규칙(callable은 일반 호출이면 function, member 호출이면 function이나 method, `new`면 class):

1. **같은 파일 identifier**: `b()`의 `b`가 지역 binding(`rootLocal`)도 import binding도 아니고 같은 파일 top-level의 callable 후보가 하나면 exact. 둘 이상이면 ambiguous.
2. **named, aliased, default import**: binding → ModuleReference → resolved File → ExportIndex에서 imported 이름(default 포함)이 callable Symbol 하나로 확정되면 exact. type-only binding은 unresolved.
3. **namespace import**: `import * as Auth`의 `Auth.login()`은 `login`이 대상 module의 unique export일 때만 exact. CommonJS module 객체(`const Auth = require()`)는 unresolved.
4. **`this.m()`**: `thisBinding`이 `member`이고 감싸는 Symbol이 instance member이며 같은 class의 instance method `m`이 있을 때만 exact. static member 안의 `this.m()`과 중첩 function 안의 `this`는 unresolved.
5. **class static**: 같은 파일 class 또는 import한 class `C`의 `C.m()`은 identity `C.static.m`이 method일 때만 exact.
6. 그 밖(`user.load()`, `service.login()`, `client.auth.refresh()`, `super`, 인터페이스 구현체, DI, `obj[name]()`, callback)은 unresolved이고 reason(receiver-type-unknown, local-binding, external-module, module-unresolved, type-only-binding, export-unresolved, no-candidate 등)을 남긴다.

ExportIndex는 파일별 export 이름 → Symbol 후보이며 build마다 cache한다. 조회 순서는 local export, import 후 export, 명시적 re-export, `export *`(default 제외)다. chain은 visited set과 `MAX_REEXPORT_DEPTH = 4`로 끊고 넘으면 unresolved다. implementation 후보가 있으면 `.d.ts`보다 우선하고, `.d.ts`만 있으면 exact이되 Edge metadata에 `declarationOnly: true`를 둔다. implementation 후보가 둘 이상이면 ambiguous이며 임의로 고르지 않는다.

CALLS Edge의 src는 Symbol이다. 감싸는 Symbol이 없는 module 수준 exact 호출(test callback 안 포함)은 `stats.calls.exactWithoutSourceSymbol`로만 세고 VALIDATED_BY 판단에 쓴다(C53). 같은 Symbol 쌍의 여러 호출은 한 Edge이며 metadata `callSites`에 횟수를 둔다. `CALL_AMBIGUOUS`는 info이고 unresolved 호출은 diagnostic 없이 통계로만 남긴다. 정확도는 benchmark의 Coverage로 드러나며, resolution 비율을 높이려고 heuristic을 더하지 않는다.

### Annotation attachment(TASK-007)

후보는 Symbol과 Test다. (1) annotation 끝과 다음 후보 시작 사이에 공백, 주석, 선언 keyword(`export`, `default`, `declare`, `const`, `let`, `var`, `abstract`, `async`)만 있고 빈 줄이 하나 이하면 그 후보, (2) 아니면 annotation을 감싸는 가장 작은 후보, (3) 둘 다 아니면 File. AST를 다시 읽지 않고 Analyzer 위치와 working-tree 원문으로 판정하며 CRLF는 LF로 본다.

ID는 Project Truth에 있는 것만 쓰고 annotation으로 정의를 만들지 않는다. Requirement ID만 연결한다(Symbol·File → Requirement IMPLEMENTS, Requirement → Test VALIDATED_BY). 다른 정의 ID는 `ANNOTATION_TARGET_UNSUPPORTED`(info), 없는 ID는 `ANNOTATION_TARGET_UNKNOWN`(warning)이다(C50).

### Test와 VALIDATED_BY(TASK-007)

- Test Node는 `kind: "test"`만 만든다(suite는 fullName에만 반영). 같은 파일에 같은 fullName이 둘 이상이면 `TEST_ID_CONFLICT`(warning)이고 그 이름의 Test Node를 하나도 만들지 않는다. 위치로 구별하지 않는다.
- VALIDATED_BY 근거는 Requirement `tests` 패턴과 test 이름 안의 Requirement ID(declared), test에 붙은 annotation(static), test 범위 안 exact 호출의 대상 Symbol(static, `basis: exact-call`)이다. 호출은 그 위치를 감싸는 가장 안쪽 test에 속한다.
- 호출 대상이 `*.test.*` / `*.spec.*` 파일이나 test를 정의한 파일에 있으면 helper로 보고 제외한다. 남은 exact 대상은 모두 VALIDATED_BY가 된다(04의 기존 의미 "테스트가 Symbol을 호출"). 이름만 보고 Symbol을 추측하지 않는다(C54).

### Git 사실(TASK-007)

- CHANGED_WITH는 `computeCoChangeCandidates` 후보 중 두 파일이 모두 indexed File일 때만 양방향으로 만들고 metadata는 `{ provenance: "git", correlation: "historical", count }`다. Context Compiler는 낮은 weight로 다룬다.
- 커밋 메시지와 branch 이름의 Issue key는 candidate다. Project Truth Issue ID와의 교집합만 Issue payload `commits`와 Project payload `git.branchIssueIds`에 provenance로 남긴다. Issue Node나 새 Edge Type은 만들지 않는다(C46).
- Git rename은 heuristic 사실이다. Node identity를 옮기거나 두 Symbol을 같은 개체로 확정하지 않는다(C45).

## 탐색

저장 계층(TASK-003)은 두 가지를 제공한다. `adjacentEdges(refs, { direction, types, limit })`는 인접 Edge를 `(from, type, to)` 순으로 limit까지 돌려주는 bounded lookup이다. `traverse(store, seeds, { maxDepth, nodeLimit, direction, edgeTypes })`는 이를 이용한 BFS이며 방문 순서는 `(depth, id)`로 결정적이다. nodeLimit이나 Edge 상한에 걸리면 `truncated`를 표시한다([conflicts.md C30](conflicts.md)).

Context Compiler(TASK-010)는 traverse 결과에 아래 Edge weight를 적용해 순위를 매긴다. weight는 비교 순서로만 쓰고 점수로 노출하지 않는다.

| Edge | weight |
|---|---|
| GOVERNS, IMPLEMENTS, TRACKED_BY, VALIDATED_BY | 1.0 |
| REQUIRES, CALLS | 0.7 |
| CONTAINS(File → Symbol) | 0.6 |
| IMPORTS | 0.5 |
| CHANGED_WITH | 0.3 |

Node 순위 값 = seed 값 × Π(경로의 edge weight). 경로가 여럿이면 최댓값을 쓴다.

- `trace(node, depth = 2)`: 상위(Requirement, Decision, Issue, Milestone)와 하위(Symbol, Test) 방향 경로를 모두 반환한다.
- `impact(symbol, depth = 2)`: CALLS 역방향(호출자), VALIDATED_BY, IMPLEMENTS, GOVERNS, CHANGED_WITH를 따라 영향 범위를 반환한다.

## 증분 갱신

```text
변경 탐지(compareFingerprints: CHANGED, ADDED, DELETED) ─▶ 변경 파일 집합 F
  ─▶ owner_file ∈ F 인 Node/Edge/unresolved_refs 삭제
  ─▶ F 재분석 ─▶ Node/Edge 추가
  ─▶ 재연결: F를 import하던 파일과 F의 Symbol 이름을 가진 unresolved_refs 재해석
  ─▶ 정의 파일(.duo-project, sources.markdown)이 바뀌었으면 그 파일의 declared Node/Edge 재생성
  ─▶ 경로 패턴 기반 Edge(GOVERNS, IMPLEMENTS paths)는 패턴이 바뀌었거나 F가 새로 매칭될 때 재계산
  ─▶ CHANGED_WITH는 새 커밋분만 누적
  ─▶ meta.graph_revision 증가
```

Node의 freshness(fresh, changed, deleted, unknown)는 이 비교 결과로 Indexer가 정한다. GraphStore는 판정하지 않는다([03 Freshness 책임](03-data-model.md#freshness-책임)). 삭제된 파일은 삭제 단계만 수행하고, rename은 삭제와 추가로 처리한다. Analyzer의 `version`이 바뀌면 그 Analyzer가 담당하는 파일 전체를 다시 분석한다.

## 일관성 불변식

`graph.check()`가 검사하고 테스트가 강제한다(REQ-GRAPH-003).

1. 모든 Edge의 src와 dst Node가 존재한다.
2. Edge type별 src/dst Node type이 위 표와 일치한다.
3. 모든 File Node는 `generated/fingerprints.json`에 항목이 있고, 그 역도 성립한다. `.duo-project/` 파일은 File Node가 아니므로 대응에서 뺀다(C47).
4. Symbol과 Test Node는 자신을 CONTAINS하는 File이 정확히 하나다.
5. **증분 결과와 전체 재구축 결과가 같다**(Node/Edge 집합 비교).
6. 정의 ID(Requirement, Decision, Issue, Milestone)는 전역에서 유일하다. 중복이면 두 정의를 모두 Knowledge Gap으로 보고한다.
7. SUPERSEDES Edge에는 자기 자신을 가리키는 Edge와 순환(직접, 여러 단계)이 없다.

T07 `checkGraph(store, { fingerprints })`가 1, 2(class가 아닌 Symbol의 CONTAINS 금지 포함), 3, 4, 6, 7을 검사하고 위반은 `GRAPH_INVARIANT_VIOLATED`(error)다. 5는 TASK-008이다.

