# 04. Project Graph

상태: Draft

Project Graph의 1차 목적은 **Context Localisation**이다. Task나 변경 Symbol을 seed로 작은 Subgraph만 탐색한다. UI 시각화는 같은 데이터를 읽는 보조 기능이다([conflicts.md C3](conflicts.md)).

## Node

| Type | ID 형식 | 출처 | 주요 attrs |
|---|---|---|---|
| Project | `project:root` | project.yaml, vision.md | goal, status |
| Milestone | `ms:M1` | milestones/*.yaml | state, title |
| Requirement | `req:AUTH-03` | specs/*.md | status, priority, milestone, text |
| Decision | `dec:D-004`, `dec:CON-001` | decisions/, constraints.yaml | kind(decision/constraint), state, answer, enforcement |
| Issue | `issue:GAME-42` | milestones/*.yaml, 커밋 메시지 | status, commits[] |
| File | `file:src/auth/a.ts` | 스캔 | language, tokens, is_test |
| Symbol | `sym:src/auth/a.ts#AuthService.refresh` | LanguageAdapter | kind(function/class/method/variable), exported, signature |
| Test | `test:src/auth/a.test.ts#AuthService > refresh` | LanguageAdapter 테스트 탐지 | framework |

Proposal(P-*)은 Graph Node로 만들지 않는다. `duo_search_evidence`와 UI에서 파일로 조회한다.

## Edge

방향은 항상 `src → dst`이며 아래 표가 정규 방향이다.

| Type | src → dst | 생성 근거 |
|---|---|---|
| CONTAINS | Project → Milestone, Project → File, File → Symbol, Symbol(class) → Symbol(method), File → Test | 구조 |
| REQUIRES | Milestone → Requirement, Requirement → Requirement(depends_on) | declared |
| IMPLEMENTS | Symbol → Requirement, File → Requirement | declared(implements.paths/symbols), static(코드 주석 `duo: AUTH-03`), git(해당 ID를 언급한 커밋이 바꾼 파일), heuristic(이름 일치) |
| CALLS | Symbol → Symbol | static(이름 해석, 아래 한계 참조) |
| IMPORTS | File → File | static(상대 경로, tsconfig paths) |
| GOVERNS | Decision → Requirement / File / Symbol | declared(governs), 경로 패턴 매칭 |
| TRACKED_BY | Requirement → Issue | declared(milestones issues.requirements) |
| VALIDATED_BY | Symbol → Test, Requirement → Test | static(테스트가 Symbol을 import·호출), declared(tests 패턴) |
| CHANGED_WITH | File → File (양방향 두 개 저장) | git(최근 500 커밋 중 3회 이상 함께 변경, 대량 커밋 50파일 초과는 제외) |

개발 지시문 예시의 `GAME-42 --TRACKED_BY--> AUTH-03`는 이 표와 방향이 반대다. 정규 방향은 "Requirement가 Issue로 추적된다"이다([conflicts.md C15](conflicts.md)).

### provenance

Edge마다 `declared > static > git > heuristic` 중 하나를 기록한다. 수치 confidence는 쓰지 않는다. Review는 heuristic Edge만으로 BLOCK을 내지 않는다([ADR-007](adr/ADR-007-verdict-model.md)).

### 정적 분석 한계 (TS/JS)

CALLS는 타입 정보 없이 해석한다. 해석 순서: 같은 파일 Symbol → import된 이름 → `this.method`(같은 class) → 전역 이름이 유일한 경우. 해석되지 않은 참조는 `unresolved_refs`에 남긴다. 동적 호출, 인터페이스 구현체 선택, DI는 놓칠 수 있으며 이는 benchmark의 Coverage 지표로 드러난다.

## 탐색

`traverse(seeds, { maxDepth, edgeTypes, direction, nodeLimit })`는 BFS로 동작한다. 순서가 결정적이도록 같은 거리의 Node는 `(edge weight 내림차순, id 오름차순)`으로 방문한다.

Context용 기본 Edge weight(비교 순서로만 쓰며 점수로 노출하지 않는다):

| Edge | weight |
|---|---|
| GOVERNS, IMPLEMENTS, TRACKED_BY, VALIDATED_BY | 1.0 |
| REQUIRES, CALLS | 0.7 |
| CONTAINS(File → Symbol) | 0.6 |
| IMPORTS | 0.5 |
| CHANGED_WITH | 0.3 |

Node 점수 = seed 점수 × Π(경로의 edge weight). 여러 경로가 있으면 최댓값.

API:

- `trace(node, depth=2)`: Node에서 Requirement/Decision/Issue 방향(상위)과 Symbol/Test 방향(하위)을 모두 반환한다.
- `impact(symbol, depth=2)`: CALLS 역방향(호출자), VALIDATED_BY, IMPLEMENTS, GOVERNS, CHANGED_WITH를 따라 영향 범위를 반환한다.

## 증분 갱신

~~~text
변경 탐지 ─▶ 변경 파일 집합 F
  ─▶ owner_file ∈ F 인 Node/Edge/unresolved_refs 삭제
  ─▶ F 재파싱 ─▶ Node/Edge 추가
  ─▶ 영향 재연결: F를 import하던 파일과 F의 Symbol 이름을 가진 unresolved_refs 재해석
  ─▶ .duo 파일이 바뀌었으면 해당 파일의 declared Node/Edge 재생성
  ─▶ 경로 패턴 기반 Edge(GOVERNS, IMPLEMENTS declared paths)는 패턴이 바뀌었거나 F가 새로 매칭될 때 재계산
  ─▶ CHANGED_WITH는 새 커밋이 있을 때 그 커밋분만 누적
~~~

삭제된 파일은 삭제 단계만 수행한다. rename은 삭제 + 추가로 처리한다.

## 일관성 불변식

`graph.check()`가 검사하고 테스트가 강제한다.

1. 모든 Edge의 src/dst Node가 존재한다.
2. Edge type별 src/dst Node type이 위 표와 일치한다.
3. 모든 File Node는 fingerprints에 행이 있고, 그 역도 성립한다.
4. Symbol/Test Node는 자신을 CONTAINS하는 File이 정확히 하나다.
5. **증분 결과와 전체 재구축 결과가 같다**(Node/Edge 집합 비교).
