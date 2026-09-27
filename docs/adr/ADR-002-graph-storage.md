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

## SQLite 스키마

TASK-003에서 구현하고 TASK-008에서 `graph_schema_version` 2로 올린 스키마다(`packages/graph/src/store/node-sqlite/schema.ts`). 모든 테이블은 STRICT다.

```sql
CREATE TABLE graph_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('project', 'milestone', 'requirement', 'decision', 'issue', 'file', 'symbol', 'test')),
  source_path TEXT,
  source_start_line INTEGER,
  source_start_column INTEGER,
  source_end_line INTEGER,
  source_end_column INTEGER,
  content_hash TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  -- File that a derived node (Symbol, Test) belongs to. NULL for Project Truth and File nodes.
  owner_file TEXT
) STRICT;

-- listNodes({ type }) ordered by id. Lookups by id use the primary key.
CREATE INDEX graph_nodes_type ON graph_nodes (type, id);
-- listNodes({ ownerFile }) ordered by id (incremental rebuild of one file's nodes).
CREATE INDEX graph_nodes_owner ON graph_nodes (owner_file, id) WHERE owner_file IS NOT NULL;

CREATE TABLE graph_edges (
  from_id TEXT NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  type TEXT NOT NULL CHECK (type IN ('CONTAINS', 'REQUIRES', 'IMPLEMENTS', 'CALLS', 'IMPORTS', 'GOVERNS', 'TRACKED_BY', 'VALIDATED_BY', 'CHANGED_WITH', 'SUPERSEDES')),
  to_id TEXT NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  metadata TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (from_id, type, to_id)
) STRICT, WITHOUT ROWID;

-- The primary key serves edge.from and edge(from, type). This index serves edge.to and edge(to, type).
CREATE INDEX graph_edges_to ON graph_edges (to_id, type, from_id);
```

`graph_nodes.id`와 `graph_edges.from_id/to_id`는 core `nodeId(EntityRef)`가 만든 Node ID다. GraphStore는 별도 ID 규칙을 만들지 않는다. `payload`와 `metadata`는 키를 정렬한 canonical JSON이라 같은 입력은 같은 바이트가 된다.

## Transaction, 제약, Index 정책

| 항목 | 정책 |
|---|---|
| Transaction | 모든 쓰기는 transaction 안에서 한다. transaction 밖의 쓰기 호출은 각자 자기 transaction을 연다. `BEGIN IMMEDIATE`로 writer lock을 먼저 잡고, 얻지 못하면 `busy_timeout`(기본 5000ms) 뒤 `BUSY`다. `tryTransaction`은 이 경우를 값(`{ status: "busy" }`)으로 돌려준다. 콜백이 throw하면 rollback한다. 재진입과 비동기 콜백은 금지한다 |
| Foreign key | `graph_edges`의 두 끝은 `graph_nodes(id)`를 참조하고 `ON DELETE CASCADE`, `DEFERRABLE INITIALLY DEFERRED`다. 검사는 commit 시점이므로 한 transaction 안에서 Node와 Edge를 어떤 순서로 써도 된다. 없는 Node를 가리키는 Edge가 남으면 commit이 `CONSTRAINT`로 실패하고 전체가 rollback된다. Node를 지우면 양방향 Edge가 함께 지워진다. 연결마다 `PRAGMA foreign_keys = ON` |
| CHECK | Node type은 core `ENTITY_TYPES`, Edge type은 `GRAPH_EDGE_TYPES`(10종)만 허용한다 |
| Idempotency | Node는 id로, Edge는 `(from_id, type, to_id)`로 upsert한다. 같은 Edge를 여러 번 넣어도 한 행이다 |
| Index | node.id는 primary key, node.type은 `(type, id)`, node.owner_file은 `(owner_file, id)`(partial, T08), edge.from과 edge(from, type)은 primary key `(from_id, type, to_id)`의 앞부분, edge.to와 edge(to, type)은 `graph_edges_to(to_id, type, from_id)`가 맡는다. edge.type 단독 조회는 없어서 index를 두지 않는다 |
| 정렬 | Node는 id, Edge는 `(from, type, to)` 순서다. 비교는 SQLite BINARY(UTF-8 바이트 순)다. JS 쪽(traverse, canonical JSON 키)은 core `compareUtf8`로 같은 순서를 쓴다(`fixtures/core/ordering.json`) |
| 동시성 | 파일 DB는 WAL 모드다. 다른 연결이 쓰는 동안에도 읽기는 마지막 commit 상태를 본다(snapshot visibility). 이것은 freshness 판정이 아니다. GraphStore는 Node의 `contentHash`와 `source`를 저장만 하고 stale을 만들지 않는다([03 Freshness 책임](../03-data-model.md#freshness-책임), C31) |
| Endpoint 타입 규칙 | Edge 종류별 허용 endpoint(04의 표)는 저장 계층이 아니라 Graph builder와 `graph.check()`(TASK-007)가 검사한다 |

## Graph Schema Version과 수명 주기

- `graph_meta.graph_schema_version`은 Graph DB 스키마 버전이다. Project Truth의 `schema_version`과 다른 개념이다.
- 빈 파일을 열면 스키마를 만들고 현재 버전(2)을 기록한다. 여러 프로세스가 동시에 만들 수 있도록 생성 여부를 lock 안에서 다시 확인한다.
- 다른 버전인 DUO graph DB는 `GRAPH_SCHEMA_UNSUPPORTED`와 `regenerable: true`를 돌려준다(generated 데이터라 지우고 다시 만들 수 있음). `onUnsupportedSchema: "recreate"`를 주면 DB 파일(`-wal`, `-shm` 포함)을 지우고 빈 graph를 만든다. `graph_meta`가 없는 외부 SQLite 파일은 `regenerable: false`이고 지우지 않는다.
- 손상된 파일은 `GRAPH_OPEN_FAILED`이며, 연결을 닫아 파일 잠금을 남기지 않는다.
- 범용 migration framework는 만들지 않는다. 스키마를 바꾸면 버전을 올리고 재생성한다.
- 파일 fingerprint는 graph.db에 넣지 않는다. Repository scan cache는 `generated/fingerprints.json`에 따로 두어 Graph 스키마와 수명 주기를 분리한다(TASK-004, H-21).
- TASK-008(버전 2): `graph_nodes.owner_file`(Symbol·Test의 소유 파일)과 `graph_nodes_owner` index를 더했다. GraphStore API에는 `NodeQuery.ownerFile`, `GraphNode.ownerFile`, `readMeta(key)`/`writeMeta(key, value)`(예약 키 `graph_schema_version`은 쓰기 금지)가 생겼다. meta에는 `graph_revision`과 `index_state_token`이 있다. 미해결 참조 테이블은 두지 않는다. resolution 결과와 dependency는 Graph가 아니라 `generated/index-state.json`에 둔다(C32, [03 증분 인덱싱](../03-data-model.md#증분-인덱싱)).
- 버전 1 DB는 regenerable이다. Indexer는 `onUnsupportedSchema: "recreate"`로 열어 다시 만든다.

## 결과

- DB 구현을 바꿀 때는 `NodeSqliteGraphStore`만 대체한다. 대체 후보는 better-sqlite3다.
- `node:sqlite`가 경고를 내더라도 stderr로만 나가므로 MCP stdout 순수성에는 영향이 없다.
