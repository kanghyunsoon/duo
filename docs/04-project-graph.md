# 04. Project Graph

상태: Frozen (T00 final, 2026-09-27) · 관련: REQ-GRAPH-001~003, REQ-INDEX-001~003, [ADR-002](adr/ADR-002-graph-storage.md), [ADR-003](adr/ADR-003-language-analysis.md)

Project Graph의 1차 목적은 **Context Localisation**이다. Task나 변경 Symbol을 seed로 작은 Subgraph만 탐색한다. UI 시각화는 같은 데이터를 읽는 보조 기능이다([conflicts.md C3](conflicts.md)).

## Node

Node ID는 core의 `nodeId(EntityRef)`만 만든다. 경로와 Symbol 구성 요소는 가역 escaping(`%` → `%25`, `#` → `%23`, 제어 문자 → `%XX`)을 거치며 Unicode와 대소문자는 그대로다. 규칙과 사례는 [03 ID와 EntityRef](03-data-model.md#id와-entityref)와 `fixtures/core/node-ids.json`에 있다.

| Type | ID 형식 | 출처 | 주요 attrs |
|---|---|---|---|
| Project | `project:root` | project.yaml, vision.md | goal, status |
| Milestone | `ms:M1` | milestones/*.yaml, Markdown `type: milestone` | state, title |
| Requirement | `req:AUTH-03` | specs/*.md, Markdown 정의 | status, priority, milestone, text |
| Decision | `dec:D-004`, `dec:CON-001`, `dec:ADR-005` | decisions/, constraints.yaml, frontmatter Markdown | kind(decision, constraint), state, answer, enforcement, lock |
| Issue | `issue:GAME-42`, `issue:TASK-010` | milestones/*.yaml, Markdown `type: issue`, 커밋 메시지 | status, acceptance[], commits[] |
| File | `file:src/auth/a.ts` | 스캔 | language, tokens, bytes, chars, is_test |
| Symbol | `sym:src/auth/a.ts#AuthService.refresh` | LanguageAnalyzer | kind(`SymbolKind`), exported, static, parent |
| Test | `test:src/auth/a.test.ts#AuthService > refresh` | LanguageAnalyzer `tests`(T05.1)를 Graph Builder가 Node로 만듦 | framework |

Proposal(P-*)은 Graph Node로 만들지 않는다. `duo_search_evidence`와 UI가 파일로 조회한다.

## Edge

방향은 항상 `src → dst`이며 아래 표가 정규 방향이다.

| Type | src → dst | 생성 근거 |
|---|---|---|
| CONTAINS | Project → Milestone, Project → File, File → Symbol, Symbol(class) → Symbol(method), File → Test | 구조 |
| REQUIRES | Milestone → Requirement, Requirement → Requirement(depends_on), Issue → Issue(depends_on) | declared |
| IMPLEMENTS | Symbol → Requirement, File → Requirement | declared(implements), static(코드 주석 `duo: AUTH-03`), git(해당 ID를 언급한 커밋이 바꾼 파일), heuristic(이름 일치) |
| CALLS | Symbol → Symbol | static 또는 heuristic(아래 한계 참조) |
| IMPORTS | File → File | static(상대 경로, tsconfig paths) |
| GOVERNS | Decision → Requirement / Issue / File / Symbol | declared(governs, Task의 decisions), 경로 패턴 매칭 |
| TRACKED_BY | Requirement → Issue | declared(Issue의 requirements) |
| VALIDATED_BY | Symbol → Test, Requirement → Test | static(테스트가 Symbol을 import·호출), declared(tests 패턴, 테스트 이름의 ID) |
| CHANGED_WITH | File → File(양방향 두 개 저장) | git(최근 500 커밋 중 3회 이상 함께 변경, 50파일 초과 커밋 제외. 후보 계산은 TASK-006 `computeCoChangeCandidates`) |
| SUPERSEDES | Decision → Decision (new → old) | declared(`supersedes`). 대상이 존재해야 하고, 자기 대체와 순환은 금지(`DECISION_SUPERSEDES_SELF`, `DECISION_SUPERSEDE_CYCLE`). H-20으로 추가된 10번째 Edge Type |

개발 지시문 예시의 `GAME-42 --TRACKED_BY--> AUTH-03`는 이 표와 방향이 반대다. 정규 방향은 "Requirement가 Issue로 추적된다"이다([conflicts.md C15](conflicts.md)).

### provenance

Edge마다 `declared`, `static`, `git`, `heuristic` 중 하나를 기록한다. 수치 confidence는 쓰지 않는다. heuristic Edge만을 근거로 한 Claim은 BLOCK에 기여할 수 없다([ADR-007](adr/ADR-007-verdict-model.md)).

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
  callSites: { kind: "identifier" | "member" | "constructor"; calleeText: string;
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
- **Test**: literal 이름(문자열, substitution 없는 template literal)의 `test`, `it`, `describe`, `suite` 호출과 `.skip`, `.only`, `.todo`. `vitest`, `@jest/globals`, `node:test`에서 import한 binding(alias와 namespace 포함)이면 `explicit`과 그 framework, import 근거 없이 `*.test.*` / `*.spec.*` 파일의 전역 호출이면 `heuristic`과 `unknown`이다. 일반 source의 전역 `it()`이나 다른 곳에서 import했거나 선언한 같은 이름은 test가 아니다. `fullName`은 suite 이름을 ` > `로 이은 값이며 위치는 쓰지 않는다. 이름이 literal이 아니면 `TEST_NAME_DYNAMIC`(info)이고 기록하지 않으며 그 suite 안의 test도 기록하지 않는다. `enclosingSymbol`은 test 호출이 추출된 Symbol 안에 있을 때만 있다. Test Node와 VALIDATED_BY는 TASK-007이 만든다.
- **DuoAnnotation**: Tree-sitter comment 노드에서만 찾는다. 줄 주석 `// duo: AUTH-03`, block 주석의 각 줄(` * duo: AUTH-04, AUTH-05`)에서 `duo:`가 주석 줄의 시작에 있어야 한다. 앞쪽의 definition ID들이 ID 후보이고 첫 non-ID token부터는 설명이다(`// duo: AUTH-07 — 로그인 보조` → `["AUTH-07"]`). ID가 없으면 `DUO_ANNOTATION_INVALID`. 문자열 안의 `"duo: AUTH-03"`은 annotation이 아니다.

### Graph Builder에 예약된 규칙(TASK-007)

Analyzer는 아래 규칙을 적용할 수 있을 만큼 위치를 보존할 뿐 적용하지 않는다.

- **Annotation attachment**: (1) annotation과 Symbol 선언 사이에 코드 token이 없고 빈 줄이 최대 한 개면 그 Symbol, (2) 아니면 annotation을 감싸는 가장 안쪽 Symbol, (3) 둘 다 아니면 File. ID가 Project Truth에 있는지도 이때 확인한다.
- **.d.ts**: 같은 이름의 implementation source Symbol이 있으면 `.d.ts` Symbol보다 우선한다. 후보가 둘 이상이고 확실히 정할 수 없으면 unresolved / ambiguous로 남기고 임의로 고르지 않는다.

### CALLS 해석과 한계

**CALLS extraction is syntactic. Call target resolution is not performed in TASK-005.** TASK-005는 CallSite 사실(`auth.login()`의 `calleeText: "auth.login"`)만 내고, 같은 파일의 명백한 호출(`function a() { b() }`)도 Edge로 만들지 않는다. 해석은 Graph Builder(TASK-007)가 한 곳에서 한다.

TS/JS CALLS는 정적 타입 정보 없이 **이름 기반 heuristic**으로 해석한다(REQ-INDEX-001).

해석 순서:

1. 같은 파일의 Symbol 이름(TASK-007)
2. import한 이름(named, default, namespace 접근 `ns.fn`)
3. `this.method()`, `super.method()`는 같은 class 계층
4. 위에서 찾지 못했고 Repository 전체에서 같은 이름의 exported Symbol이 **하나뿐**이면 연결(provenance: heuristic)
5. 그 밖에는 `unresolved_refs`에 남긴다

놓치거나 틀릴 수 있는 경우: 인스턴스 변수를 통한 호출(`this.repo.save()`의 대상 class), 인터페이스와 구현체 선택, DI 컨테이너, 동적 속성 접근(`obj[name]()`), 고차 함수로 전달된 콜백, 같은 이름의 메서드가 여러 class에 있는 경우. 정확도는 benchmark의 Coverage로 드러난다.

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
3. 모든 File Node는 `generated/fingerprints.json`에 항목이 있고, 그 역도 성립한다.
4. Symbol과 Test Node는 자신을 CONTAINS하는 File이 정확히 하나다.
5. **증분 결과와 전체 재구축 결과가 같다**(Node/Edge 집합 비교).
6. 정의 ID(Requirement, Decision, Issue, Milestone)는 전역에서 유일하다. 중복이면 두 정의를 모두 Knowledge Gap으로 보고한다.
7. SUPERSEDES Edge에는 자기 자신을 가리키는 Edge와 순환(직접, 여러 단계)이 없다.
