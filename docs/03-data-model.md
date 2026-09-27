# 03. Data Model

상태: Frozen (T00 final, 2026-09-27) · 관련: [ADR-006](adr/ADR-006-duo-layout-git-policy.md), [ADR-013](adr/ADR-013-decision-lifecycle.md), [ADR-014](adr/ADR-014-traceability-ids.md)

## .duo 디렉터리

```text
.duo/
├─ project.yaml              Human · tracked
├─ .gitignore                init 생성 · tracked
├─ intent/
│  ├─ vision.md              Human · tracked
│  └─ constraints.yaml       Human · tracked
├─ specs/*.md                Human · tracked · Requirement
├─ decisions/
│  ├─ D-###.yaml             Human 확정(DecisionService가 기록) · tracked
│  ├─ *.md                   Human이 작성한 ADR 형식 Decision · tracked
│  └─ proposals/P-*.yaml     DUO/Agent 제안, Human 거절 기록 · tracked
├─ milestones/*.yaml         Human · tracked · Milestone, 로컬 Issue
├─ integrations/             Human · tracked · (Post-MVP) jira.yaml
├─ reviews/*.json            Human이 보존·승인한 Review만 · tracked
├─ generated/                ignored · 재생성 가능(Derived)
│  ├─ graph.db               Project Graph, fingerprints
│  ├─ gaps.json              Knowledge Gap
│  ├─ inferred.json          구현 상태 추론
│  └─ index.json             마지막 인덱싱 commit, 파서 버전
├─ cache/                    ignored · 성능 목적(tokenizer, Packet, llm/)
└─ runtime/                  ignored · 로컬 실행 기록
   ├─ reviews/*.json         매 Review 결과
   ├─ metrics.jsonl          Context/Review/LLM 지표
   └─ backup/                duo install 백업
```

Git 정책은 "Truth / Human Decision → tracked, Derived / Runtime → ignored" 한 가지다. 분류 근거는 [ADR-006](adr/ADR-006-duo-layout-git-policy.md)에 있다. 지시문 D§2의 `state/`, `evidence/`는 쓰지 않는다([conflicts.md C19](conflicts.md)).

## 소유권

| 경로 | DUO | Agent | Human |
|---|---|---|---|
| project.yaml, intent/, specs/, milestones/, integrations/ | init 시 초안 생성만 | 금지 | 수정 |
| decisions/D-*.yaml | DecisionService의 confirm/reject/supersede만(Human 명령으로 실행) | 금지 | 명령 또는 수동 수정(fallback) |
| decisions/proposals/ | 새 파일 생성 | `duo_propose_decision`으로만 | 수정 가능 |
| reviews/ | `duo review --record` | 금지 | 삭제 가능 |
| generated/, cache/, runtime/ | 자유 | 금지 | 삭제 가능 |

## ID

형식과 규칙은 [ADR-014](adr/ADR-014-traceability-ids.md)에 있다. 공통 정규식은 `^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z]?|M\d+)$`이며, 모든 ID는 종류와 관계없이 전역에서 유일하다. 사용자 프로젝트는 `AUTH-03`, `D-004`, `GAME-42` 같은 형식을 쓸 수 있고, 이 저장소는 `REQ-*`, `ADR-*`, `TASK-*`를 쓴다. Proposal ID는 `P-YYYYMMDD-[a-z0-9]{6}`, Knowledge Gap ID는 `GAP-[0-9a-f]{8}`(hash 기반)이다.

## project.yaml

```yaml
schema_version: 1
name: auth-app
current_milestone: M1
sources:
  markdown: []                # External Evidence / Input Source(Truth 아님). 예: ["README.md", "docs/**/*.md"]
index:
  include: []                 # 비어 있으면 Git이 추적하는 모든 파일
  exclude: []                 # 기본 제외에 추가
  max_file_bytes: 1048576
context:
  default_budget_tokens: 6000
  max_depth: 2
review:
  warn_on_untested_change: true
  warn_on_unlinked_addition: true
test_command: null            # 설정 시에만 duo review --run-tests가 실행
llm:                          # ADR-012
  provider: none              # none | openai-responses
  model: null
  base_url: null              # null이면 OpenAI 기본 endpoint
  api_key_env: OPENAI_API_KEY
  max_calls_per_review: 3
  max_input_tokens: 4000
  timeout_ms: 30000
```

## Markdown 정의 형식

`.duo/specs/`, `.duo/decisions/`, `.duo/milestones/`의 Markdown 파일은 이 규칙으로 읽는다. `sources.markdown`의 외부 문서도 같은 규칙으로 파싱하지만 정의가 아니라 External Evidence로만 쓴다([ADR-014](adr/ADR-014-traceability-ids.md#project-truth와-external-source)). 이 저장소의 docs/도 이 형식을 따르며, 테스트에서 임시 `.duo/`로 복사해 self fixture로 쓴다.

1. **Heading + duo block**: `#` 2~4개 Heading이 ID로 시작하고, 바로 아래(빈 줄 허용)에 info string이 `duo`인 fenced block이 있으면 정의다. Heading 정규식은 `^#{2,4}\s+(<ID>)\s+(.+)$`이다. block의 `type`이 Node 종류를 정하고, 생략하면 `requirement`다.
2. **Frontmatter**: 파일 첫 줄의 `---` YAML frontmatter에 `id`와 `type: decision`이 있으면 파일 전체가 Decision 하나다(ADR 형식).
3. **본문**: 정의의 설명은 Heading 다음부터 같은 수준 이상의 다음 Heading 전까지다.
4. **Acceptance Criteria**: Issue 정의 본문에서 `- **AC-NNN-NN** 내용` 형식의 목록 항목이다.
5. **Knowledge Gap**: 어느 정의 본문에서든 `UNKNOWN: <질문>` 줄은 그 정의를 anchor로 하는 Gap이다.

### type별 block 필드

| type | 필드 |
|---|---|
| requirement | `status`(planned, in_progress, done, deferred), `milestone`, `priority`(must, should, could), `source`(인용 라벨 문자열 또는 외부 출처 `{path, hash, section?}`), `implements`({paths, symbols}), `tests`(이름 패턴), `depends_on` |
| issue | `status`(todo, in_progress, review, done), `milestone`, `package`, `requirements`, `decisions`, `depends_on` |
| milestone | `state`(planned, active, done), `title` |

예:

~~~~markdown
### AUTH-03 Refresh Token

```duo
status: planned
milestone: M1
priority: must
implements:
  paths: ["src/auth/**"]
  symbols: ["AuthService.refresh"]
```

Access token이 만료되면 refresh token으로 재발급한다.

UNKNOWN: Refresh token 만료 기간
~~~~

## intent/vision.md

```markdown
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
```

## intent/constraints.yaml

```yaml
constraints:
  - id: CON-001
    statement: OAuth is outside MVP.
    state: confirmed          # draft | confirmed | retired
    enforcement: warn         # warn | block
    source: [{path: README.md, hash: "sha256:abc123", section: Scope}]   # 선택: 외부 출처(ADR-014)
    match:                    # 결정적 판정용 패턴(하나 이상)
      paths: ["src/**/oauth/**"]
      symbols: ["*OAuth*"]
      dependencies: ["passport-google-oauth20"]
      keywords: ["oauth"]     # 새로 추가된 Symbol 이름과 파일 경로에만 적용
```

Constraint는 Graph에서 Decision Node(`attrs.kind = constraint`)로 표현한다([conflicts.md C14](conflicts.md)). Constraint의 confirm도 DecisionService를 거치며, 이 경우 파일 안의 해당 항목에 lock이 기록된다.

## decisions/D-###.yaml

```yaml
id: D-004
title: JWT Authentication
kind: decision
state: confirmed          # proposed | confirmed | superseded | rejected
question: auth_mechanism
answer: jwt
rationale: Stateless API servers.
owner: human
governs:
  requirements: [AUTH-01, AUTH-03]
  paths: ["src/auth/**"]
  symbols: []
forbids:                  # 선택: 이 결정과 충돌하는 패턴
  dependencies: ["express-session"]
  symbols: ["*Session*Store*"]
supersedes: null
superseded_by: null
evidence:                 # proposal에서 옮겨진 근거 참조
  - {kind: review, id: R-20260927-153012-91aca1}
confirmed_at: 2026-09-27T15:40:00+09:00
confirmed_by: kanghyunsoon
lock:
  digest: sha256:3f1c...  # ADR-013의 내용 필드 정규화 JSON hash
```

## decisions/proposals/P-*.yaml

D-###.yaml과 같은 내용 필드에 `proposed_by`(agent 이름 또는 duo), `proposed_at`, `evidence`를 더한다. `state`는 `proposed`로 시작한다. reject되면 `state: rejected`, `rejected_at`, `rejected_by`, `reason`이 기록되고 파일은 그대로 남는다. confirm되면 파일은 `decisions/D-###.yaml`로 옮겨진다.

## milestones/*.yaml

```yaml
id: M1
title: Auth MVP
state: active              # planned | active | done
issues:                    # 외부 Tracker가 없는 MVP의 로컬 Issue
  - id: GAME-42
    title: Refresh token
    status: todo
    requirements: [AUTH-03]
```

Requirement와 Milestone의 연결은 Requirement의 `milestone` 필드가 정규 원본이다. 커밋 메시지와 브랜치 이름의 Issue 키는 GitEvidenceProvider가 수집해 Issue Node의 근거로 붙인다.

## Review 결과 (runtime/reviews/, reviews/)

두 위치의 스키마는 같다. `runtime/reviews/`에는 모든 실행 결과가, `reviews/`에는 Human이 `duo review --record`로 보존한 Review만 저장된다([ADR-006](adr/ADR-006-duo-layout-git-policy.md)). Record에는 `recorded_by`, `recorded_at`이 추가되고, Evidence는 원본을 복사하지 않는 Pointer만 담는다.

```json
{
  "id": "R-20260927-153012-91aca1",
  "base": "HEAD", "base_sha": "72d066d", "head": "WORKTREE",
  "verdict": "BLOCK",
  "claims": [{
    "id": "C1", "rule": "R-CONSTRAINT",
    "claim": "OAuth implementation is outside the current MVP.",
    "alignment": "CONFLICT", "blocking": true, "ask": false, "basis": "static",
    "expected": "MVP에서는 OAuth를 지원하지 않는다.",
    "observed": "GoogleOAuthService가 새로 추가되었다.",
    "evidence": [
      {"kind": "constraint", "id": "CON-001"},
      {"kind": "symbol", "path": "src/auth/GoogleOAuthService.ts", "symbol": "GoogleOAuthService", "lines": [1, 42], "commit": "WORKTREE", "content_hash": "sha256:7d9e…"},
      {"kind": "diff", "path": "src/auth/GoogleOAuthService.ts", "change": "added"}
    ]
  }],
  "skipped_checks": [{"rule": "R-INTENT", "reason": "llm_unavailable"}],
  "metrics": {"changed_files": 2, "changed_symbols": 3, "llm_calls": 0, "llm_input_tokens": 0, "llm_output_tokens": 0}
}
```

EvidenceRef는 `kind`와 Pointer 필드(`id`, `path`, `symbol`, `lines`, `commit`, `content_hash`) 중 해당하는 것을 가진다. `kind`: requirement, decision, constraint, issue, milestone, file, symbol, test, commit, diff, document, review, llm.

## generated/gaps.json

Gap마다 `id`, `question`, `source`(파일:줄 또는 규칙 ID), `anchors`(Node ID 목록), `tags`, `status`(open, resolved)를 가진다. ID는 source와 question의 hash라 재생성해도 같다. `UNKNOWN:` 줄이 사라지거나 규칙이 더 이상 성립하지 않으면 resolved가 된다.

## runtime/metrics.jsonl

요청마다 한 줄. 필드는 [09-token-strategy.md](09-token-strategy.md#지표)에 정의되어 있다.

## SQLite 스키마 (generated/graph.db)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- graph_schema_version, graph_revision
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,          -- 예: sym:src/auth/a.ts#AuthService.refresh
  type TEXT NOT NULL,           -- Project|Milestone|Requirement|Decision|Issue|File|Symbol|Test
  name TEXT NOT NULL,
  path TEXT, start_line INTEGER, end_line INTEGER,
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
  path TEXT PRIMARY KEY, size INTEGER, mtime_ms INTEGER, sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL, chars INTEGER NOT NULL, tokens INTEGER NOT NULL, estimator TEXT NOT NULL,
  analyzer TEXT, analyzer_version TEXT, indexed_at TEXT
);
CREATE TABLE unresolved_refs (
  from_node TEXT NOT NULL, kind TEXT NOT NULL,  -- call|import
  name TEXT NOT NULL, module TEXT, owner_file TEXT NOT NULL
);
CREATE INDEX edges_dst ON edges(dst, type);
CREATE INDEX nodes_owner ON nodes(owner_file);
CREATE INDEX edges_owner ON edges(owner_file);
CREATE INDEX nodes_name ON nodes(type, name);
```

`meta.graph_schema_version`이 코드가 기대하는 값과 다르면 migration 대신 재생성한다([ADR-002](adr/ADR-002-graph-storage.md)). 범용 migration framework는 만들지 않는다.
