# ADR-002: Graph 저장소

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 배경

외부 Neo4j를 필수로 만들지 않는다. Embedded storage가 필요하다. 네이티브 모듈 빌드는 Windows 설치 실패의 주된 원인이다.

## 선택지

| 후보 | 장점 | 단점 |
|---|---|---|
| `node:sqlite`(내장) | 추가 의존성과 네이티브 빌드 없음. Node 24.15.0 이상에서 플래그 없이 사용 가능 | Stability 1.2(Release Candidate)로 API 변경 가능 |
| better-sqlite3 | 성숙, 빠름 | 네이티브 모듈. prebuild가 없으면 컴파일 필요 |
| sql.js(WASM) | 순수 WASM | 메모리 DB 기반, 파일 영속화가 번거롭고 느림 |
| JSON 파일 | 단순 | 탐색 성능, 동시성 |
| Neo4j | Graph 질의 | 제외 목록 |

## 결정

`node:sqlite`를 사용하되 `GraphStore` interface 뒤에 숨긴다. SQL은 `graph` 패키지 밖으로 새지 않는다. 탐색(BFS)은 애플리케이션 코드에서 수행하고 SQLite는 인접 조회만 한다.

## 결과

- node:sqlite API가 바뀌면 GraphStore 구현만 고친다. 대체 구현은 better-sqlite3(API가 유사).
- `graph.db`는 generated 데이터라 schema 변경 시 재생성한다.
- 실험 기능 경고가 stderr로 출력될 수 있다. MCP stdout 순수성에는 영향이 없지만 CLI에서는 경고를 숨긴다.
