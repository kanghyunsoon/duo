# 03. Data Model

상태: Draft

## .duo 디렉터리

~~~text
.duo/
├─ project.yaml            # Human  · Git 관리
├─ .gitignore              # DUO 생성 · state/ evidence/ generated/ 제외
├─ intent/
│  ├─ vision.md            # Human  · Git 관리
│  └─ constraints.yaml     # Human  · Git 관리
├─ specs/*.md              # Human  · Git 관리 · Requirement 정의
├─ decisions/
│  ├─ D-###.yaml           # Human  · Git 관리
│  └─ proposals/P-*.yaml   # DUO/Agent 제안 · Git 관리
├─ milestones/*.yaml       # Human  · Git 관리 · Milestone, 로컬 Issue
├─ integrations/           # Human  · Git 관리 · (Post-MVP) jira.yaml
├─ state/                  # 자동 · gitignore · gaps.json, inferred.json, metrics.jsonl
├─ evidence/               # 자동 · gitignore · reviews/*.json
└─ generated/              # 자동 · gitignore · graph.db, cache/
~~~

`state/`와 `generated/`는 삭제해도 `duo init --reindex`로 재생성된다. `evidence/`는 과거 Review 기록이라 재생성되지 않는다([conflicts.md C13](conflicts.md)).

## 소유권 규칙

| 경로 | DUO 쓰기 | Agent 쓰기 | Human 쓰기 |
|---|---|---|---|
| project.yaml, intent/, specs/, decisions/D-*, milestones/, integrations/ | init 시 초안 생성만 | 금지 | 허용 |
| decisions/proposals/ | `duo_propose_decision`으로 새 파일 생성만 | DUO를 통해서만 | 허용 |
| state/, evidence/, generated/ | 허용 | 금지 | 필요 없음 |

init 이후 DUO는 Human-owned 파일을 수정하지 않는다. 초안 파일은 `status: draft`를 가지며 Human이 `confirmed`로 바꾼다.

## ID 규칙

| 대상 | 형식 | 예 |
|---|---|---|
| Requirement | `[A-Z][A-Z0-9]*-[0-9]+` | AUTH-03 |
| Decision | `D-[0-9]{3,}` | D-004 |
| Proposal | `P-YYYYMMDD-[a-z0-9]{6}` | P-20260927-k3f9qa |
| Constraint | `CON-[0-9]{3,}` | CON-001 |
| Milestone | `M[0-9]+` | M1 |
| Issue | 외부 키 그대로 | GAME-42 |
| Knowledge Gap | `GAP-[0-9]{3,}` | GAP-007 |

Requirement와 Issue는 형식이 같을 수 있다. 둘 다 존재하면 Requirement가 우선하고 충돌을 Knowledge Gap으로 기록한다.

## project.yaml

~~~yaml
schema_version: 1
name: auth-app
current_milestone: M1
index:
  include: []            # 비어 있으면 Git이 추적하는 모든 파일
  exclude: []            # 기본 제외에 추가
  max_file_bytes: 1048576
  languages: [typescript, javascript]
context:
  default_budget_tokens: 6000
  max_depth: 2
review:
  warn_on_untested_change: true
  warn_on_unlinked_addition: true
test_command: null       # 설정 시에만 duo review --run-tests가 실행
llm:
  provider: none
~~~

## intent/vision.md

Markdown 본문과 YAML frontmatter.

~~~markdown
---
status: draft            # draft | confirmed
owner: human
---
# Goal
...
# In Scope (MVP)
...
# Out of Scope
- OAuth
UNKNOWN: Maximum concurrent players
~~~

`UNKNOWN: <질문>` 줄은 Knowledge Gap이 된다. 어느 파일, 어느 Requirement 섹션에서든 쓸 수 있다.

## intent/constraints.yaml

~~~yaml
constraints:
  - id: CON-001
    statement: OAuth is outside MVP.
    state: confirmed          # draft | confirmed | retired
    enforcement: warn         # warn | block
    match:                    # 결정적 판정용 패턴(하나 이상)
      paths: ["src/**/oauth/**"]
      symbols: ["*OAuth*"]
      dependencies: ["passport-google-oauth20"]
      keywords: ["oauth"]     # 새로 추가된 Symbol 이름과 파일 경로에만 적용
~~~

Constraint는 Graph에서 `Decision` Node(`attrs.kind = constraint`)로 표현한다([conflicts.md C14](conflicts.md)).

## specs/*.md (Requirement)

Requirement는 Heading과 그 아래의 `duo` fenced block으로 정의한다. 렌더링된 문서에서도 보이도록 HTML 주석을 쓰지 않는다.

~~~~markdown
## AUTH-03 Refresh Token

```duo
status: planned        # planned | in_progress | done
milestone: M1
priority: must         # must | should | could
implements:            # 선택: 명시적 연결
  paths: ["src/auth/**"]
  symbols: ["AuthService.refresh"]
tests: ["AuthService refresh*"]
depends_on: [AUTH-01]
```

Access token이 만료되면 refresh token으로 재발급한다.

UNKNOWN: Refresh token 만료 기간
~~~~

Heading 정규식: `^#{2,4}\s+([A-Z][A-Z0-9]*-\d+)\s*[:\-]?\s*(.+)$`. `duo` block은 선택이며, 없으면 `status: planned`로 간주한다. 섹션 본문(다음 같은 수준 Heading 전까지)이 Requirement 설명이다.

## decisions/D-###.yaml

~~~yaml
id: D-004
title: JWT Authentication
kind: decision            # decision (constraint는 constraints.yaml)
state: confirmed          # proposed | confirmed | superseded | rejected
question: auth_mechanism
answer: jwt
rationale: Stateless API servers.
owner: human
supersedes: null
superseded_by: null
governs:
  requirements: [AUTH-01, AUTH-03]
  paths: ["src/auth/**"]
  symbols: []
forbids:                  # 선택: 이 결정과 충돌하는 패턴
  dependencies: ["express-session"]
  symbols: ["*Session*Store*"]
confirmed_at: 2026-09-27
~~~

## decisions/proposals/P-*.yaml

`duo_propose_decision`이 생성한다. D-###.yaml과 같은 필드에 `proposed_by`(agent 이름), `proposed_at`, `evidence`(참조 목록)를 추가하고 `state`는 항상 `proposed`다. Human이 파일을 `decisions/D-###.yaml`로 옮기고 `state: confirmed`로 바꾸면 확정된다([conflicts.md Q1](conflicts.md)).

## Decision Lock

- Lock 기준선은 **Git HEAD의 내용**이다. 별도 잠금 DB를 두지 않는다.
- Working tree 또는 검토 범위에서 HEAD 기준 `state: confirmed`인 Decision/Constraint의 내용이 바뀌면 `R-LOCK` 규칙이 **BLOCK**을 낸다.
- 예외: `confirmed → superseded` 전환이면서, 같은 변경 안에 `supersedes`로 이 결정을 가리키는 `confirmed` 결정이 있으면 **ASK**(Human 승인 확인)로 낮춘다.
- `proposed → confirmed` 전환이 검토 범위에 있으면 **ASK**를 낸다. 커밋은 Human의 승인 행위로 간주한다.
- DUO 코드에는 `state: confirmed`를 쓰는 경로가 없다. 이는 단위 테스트로 검증한다.

## milestones/*.yaml

~~~yaml
id: M1
title: Auth MVP
state: active              # planned | active | done
requirements: [AUTH-01, AUTH-03]
issues:                    # 외부 Tracker가 없는 MVP의 로컬 Issue
  - id: GAME-42
    title: Refresh token
    status: open           # open | in_progress | done
    requirements: [AUTH-03]
~~~

커밋 메시지와 브랜치 이름의 Issue 키(`[A-Z][A-Z0-9]*-\d+`)는 Git Provider가 수집해 Issue Node의 근거로 붙인다.

## state/ 파일

| 파일 | 내용 |
|---|---|
| `gaps.json` | Knowledge Gap 목록: id, question, source(파일:줄 또는 규칙 ID), anchor(node id 목록), tags, status(open/resolved) |
| `inferred.json` | 구현 상태 추론: 언어, 디렉터리별 파일/Symbol 수, entrypoint, 테스트 존재 여부, Requirement별 연결 현황 |
| `metrics.jsonl` | Context/Review 요청마다 한 줄: 시각, 종류, 지표([09](09-token-strategy.md)) |
| `index.json` | 마지막 인덱싱 commit, 시각, 파서 버전 |

Knowledge Gap ID는 `source`와 `question`의 hash로 안정적으로 매기고, 해당 `UNKNOWN:` 줄이 사라지거나 규칙이 더 이상 성립하지 않으면 `resolved`가 된다.

## evidence/reviews/<review-id>.json

~~~json
{
  "id": "R-20260927-153012-91aca1",
  "base": "HEAD", "head": "WORKTREE",
  "verdict": "WARN",
  "claims": [{
    "id": "C1", "rule": "R-CONSTRAINT",
    "claim": "OAuth implementation is outside the current MVP.",
    "alignment": "CONFLICT",
    "expected": "MVP에서는 OAuth를 지원하지 않는다.",
    "observed": "GoogleOAuthService가 새로 추가되었다.",
    "evidence": [
      {"kind": "constraint", "ref": "CON-001"},
      {"kind": "symbol", "ref": "src/auth/GoogleOAuthService.ts#GoogleOAuthService", "lines": [1, 42]},
      {"kind": "commit", "ref": "91aca1"}
    ]
  }],
  "metrics": {"changed_files": 2, "changed_symbols": 3, "llm_calls": 0}
}
~~~

## SQLite 스키마 (generated/graph.db)

~~~sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,          -- 예: sym:src/auth/a.ts#AuthService.refresh
  type TEXT NOT NULL,           -- Project|Milestone|Requirement|Decision|Issue|File|Symbol|Test
  name TEXT NOT NULL,
  path TEXT,                    -- POSIX 상대경로
  start_line INTEGER, end_line INTEGER,
  owner_file TEXT,              -- 이 Node를 만든 파일(증분 삭제 단위)
  attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE edges (
  src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL,
  provenance TEXT NOT NULL,     -- declared|static|git|heuristic
  owner_file TEXT,
  attrs TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (src, dst, type)
);
CREATE TABLE fingerprints (
  path TEXT PRIMARY KEY, size INTEGER, mtime_ms INTEGER,
  sha256 TEXT NOT NULL, tokens INTEGER NOT NULL,
  adapter TEXT, adapter_version TEXT, indexed_at TEXT
);
CREATE TABLE unresolved_refs (   -- 다른 파일이 바뀌면 다시 연결을 시도할 참조
  from_node TEXT NOT NULL, kind TEXT NOT NULL,  -- call|import
  name TEXT NOT NULL, module TEXT, owner_file TEXT NOT NULL
);
CREATE INDEX edges_dst ON edges(dst, type);
CREATE INDEX nodes_owner ON nodes(owner_file);
CREATE INDEX edges_owner ON edges(owner_file);
CREATE INDEX nodes_name ON nodes(type, name);
~~~

스키마 버전은 `meta.schema_version`에 저장하고, 버전이 다르면 migration 대신 재생성한다(generated 데이터이므로).
