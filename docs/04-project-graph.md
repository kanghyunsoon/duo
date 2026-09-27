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
| Symbol | `sym:src/auth/a.ts#AuthService.refresh` | LanguageAnalyzer | kind(function, class, method, variable), exported, signature |
| Test | `test:src/auth/a.test.ts#AuthService > refresh` | LanguageAnalyzer 테스트 탐지 | framework |

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
| CHANGED_WITH | File → File(양방향 두 개 저장) | git(최근 500 커밋 중 3회 이상 함께 변경, 50파일 초과 커밋 제외) |
| SUPERSEDES | Decision → Decision (new → old) | declared(`supersedes`). 대상이 존재해야 하고, 자기 대체와 순환은 금지(`DECISION_SUPERSEDES_SELF`, `DECISION_SUPERSEDE_CYCLE`). H-20으로 추가된 10번째 Edge Type |

개발 지시문 예시의 `GAME-42 --TRACKED_BY--> AUTH-03`는 이 표와 방향이 반대다. 정규 방향은 "Requirement가 Issue로 추적된다"이다([conflicts.md C15](conflicts.md)).

### provenance

Edge마다 `declared`, `static`, `git`, `heuristic` 중 하나를 기록한다. 수치 confidence는 쓰지 않는다. heuristic Edge만을 근거로 한 Claim은 BLOCK에 기여할 수 없다([ADR-007](adr/ADR-007-verdict-model.md)).

## AnalysisResult

`LanguageAnalyzer.analyze()`의 반환 형식이다([ADR-003](adr/ADR-003-language-analysis.md)). 언어와 무관하게 같다.

```ts
interface AnalysisResult {
  symbols: { name: string; qualifiedName: string; kind: SymbolKind; exported: boolean;
             signature: string; startLine: number; endLine: number; parent?: string }[];
  imports: { module: string; names: string[]; resolvedPath?: string; line: number }[];
  references: { from: string; name: string; receiver?: string; line: number }[];  // call 후보
  tests: { name: string; path: string[]; startLine: number; endLine: number; framework: string }[];
  diagnostics: { line: number; message: string }[];
}
```

### CALLS 해석과 한계

TS/JS CALLS는 정적 타입 정보 없이 **이름 기반 heuristic**으로 해석한다(REQ-INDEX-001).

해석 순서:

1. 같은 파일의 Symbol 이름
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
변경 탐지 ─▶ 변경 파일 집합 F
  ─▶ owner_file ∈ F 인 Node/Edge/unresolved_refs 삭제
  ─▶ F 재분석 ─▶ Node/Edge 추가
  ─▶ 재연결: F를 import하던 파일과 F의 Symbol 이름을 가진 unresolved_refs 재해석
  ─▶ 정의 파일(.duo-project, sources.markdown)이 바뀌었으면 그 파일의 declared Node/Edge 재생성
  ─▶ 경로 패턴 기반 Edge(GOVERNS, IMPLEMENTS paths)는 패턴이 바뀌었거나 F가 새로 매칭될 때 재계산
  ─▶ CHANGED_WITH는 새 커밋분만 누적
  ─▶ meta.graph_revision 증가
```

삭제된 파일은 삭제 단계만 수행하고, rename은 삭제와 추가로 처리한다. Analyzer의 `version`이 바뀌면 그 Analyzer가 담당하는 파일 전체를 다시 분석한다.

## 일관성 불변식

`graph.check()`가 검사하고 테스트가 강제한다(REQ-GRAPH-003).

1. 모든 Edge의 src와 dst Node가 존재한다.
2. Edge type별 src/dst Node type이 위 표와 일치한다.
3. 모든 File Node는 fingerprints에 행이 있고, 그 역도 성립한다.
4. Symbol과 Test Node는 자신을 CONTAINS하는 File이 정확히 하나다.
5. **증분 결과와 전체 재구축 결과가 같다**(Node/Edge 집합 비교).
6. 정의 ID(Requirement, Decision, Issue, Milestone)는 전역에서 유일하다. 중복이면 두 정의를 모두 Knowledge Gap으로 보고한다.
7. SUPERSEDES Edge에는 자기 자신을 가리키는 Edge와 순환(직접, 여러 단계)이 없다.
