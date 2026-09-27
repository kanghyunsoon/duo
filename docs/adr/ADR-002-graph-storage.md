---
id: ADR-002
type: decision
title: Graph 저장소
state: confirmed
owner: human
question: graph_storage
answer: "GraphStore interface -> NodeSqliteGraphStore -> node:sqlite; node:sqlite only inside graph package; graph_schema_version"
governs:
  requirements: [REQ-GRAPH-001, REQ-INDEX-002]
supersedes: null
confirmed_by: human (H-13)
confirmed_at: 2026-09-27
---

# ADR-002: Graph 저장소

상태: **Accepted** (Human 결정 H-13)

## 배경

외부 Neo4j를 필수로 만들지 않는다(D§4). 네이티브 모듈 빌드는 Windows 설치 실패의 주된 원인이다(REQ-NFR-003).

## 선택지

| 후보 | 장점 | 단점 |
|---|---|---|
| `node:sqlite`(Node 내장) | 추가 의존성과 네이티브 빌드가 없음. Node 24.15.0 이상에서 플래그 없이 사용 | Release Candidate라 API가 바뀔 수 있음 |
| better-sqlite3 | 성숙하고 빠름 | 네이티브 모듈, prebuild가 없으면 컴파일 필요 |
| sql.js(WASM) | 순수 WASM | 메모리 DB 기반이라 파일 영속화가 번거로움 |
| JSON 파일 | 단순 | 탐색 성능과 동시성 |

## 결정

```text
Application (director, integration, apps/cli)
    ↓
GraphStore interface          packages/graph 공개 API
    ↓
NodeSqliteGraphStore          packages/graph/src/store/node-sqlite/
    ↓
node:sqlite
```

- `node:sqlite`는 `packages/graph/src/store/node-sqlite/` 밖에서 import하지 않는다. lint 규칙으로 강제한다.
- `GraphStore` 인터페이스는 Node, Edge, 조회 결과 같은 domain 타입만 쓴다. SQL 문자열, `DatabaseSync`, statement, row 타입 등 storage 전용 API를 domain layer에 노출하지 않는다.
- 스키마 버전 필드 `graph_schema_version`을 처음부터 `meta` 테이블에 둔다. 코드가 기대하는 버전과 다르면 `graph.db`를 지우고 재생성한다(재생성 가능한 generated 데이터이므로). 범용 migration framework는 만들지 않는다.
- BFS는 애플리케이션 코드에서 수행하고 SQLite는 인접 조회만 담당한다.

## 결과

- DB 구현을 바꿀 때는 `NodeSqliteGraphStore`만 대체한다. 대체 후보는 better-sqlite3다.
- `node:sqlite`가 경고를 내더라도 stderr로만 나가므로 MCP stdout 순수성에는 영향이 없다.
