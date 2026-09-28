# 03. Data Model

상태: Frozen (T00 final) · T02.1에서 구현과 동기화(H-20, C27) · 관련: [ADR-006](adr/ADR-006-duo-layout-git-policy.md), [ADR-013](adr/ADR-013-decision-lifecycle.md), [ADR-014](adr/ADR-014-traceability-ids.md)

이 문서는 `@duo-director/core`에 구현된 Core Data Contract를 설명한다. 문서와 구현이 다르면 [conflicts.md](conflicts.md)에 기록한다.

## Technical Namespace

표시 이름은 **DUO**다. 기술 식별자는 외부 AI coding 도구와의 충돌을 피하도록 정했고(H-20), 코드에서는 `packages/core/src/constants.ts` 한 곳에서만 관리한다.

| 항목 | 값 | 상수 |
|---|---|---|
| 제품 표시 이름 | DUO | `PRODUCT_NAME` |
| CLI 실행 파일 | `duoctl` | `CLI_NAME` |
| 프로젝트 상태 디렉터리 | `.duo-project/` | `STATE_DIR_NAME` |
| MCP 서버 이름 | `duo-director` | `MCP_SERVER_NAME` |
| workspace package scope | `@duo-director/*` | (package.json) |
| Markdown metadata block info string | `duo` | `METADATA_BLOCK_LANG` |

MCP Tool 이름(`duo_get_context` 등, [06](06-mcp-interface.md))은 서버 이름 아래에 있으므로 바꾸지 않았다. npm publish 가능 여부는 배포 단계에서 다시 확인한다.

## .duo-project 디렉터리

```text
.duo-project/
├─ project.yaml              Project Truth · tracked · schema_version
├─ .gitignore                init 생성 · tracked
├─ intent/
│  ├─ vision.md              Project Truth · tracked
│  └─ constraints.yaml       Project Truth · tracked
├─ specs/*.md                Project Truth · tracked · Requirement 등 Markdown 정의
├─ decisions/
│  ├─ D-###.yaml, *.md       Project Truth · tracked · Decision(YAML 또는 ADR 형식 Markdown)
│  └─ proposals/P-*.yaml     Project Truth · tracked · 제안과 거절 기록
├─ milestones/
│  ├─ *.yaml                 Project Truth · tracked · Milestone(Issue는 ID로만 참조)
│  └─ *.md                   Project Truth · tracked · Issue와 Milestone의 Markdown 정의
├─ integrations/             Project Truth · tracked · (Post-MVP) jira.yaml
├─ reviews/*.json            Human-approved History · tracked · Human이 보존·승인한 Review만
├─ generated/                Regenerable · ignored · graph.db, fingerprints.json, index-state.json, inferred.json
├─ cache/                    Regenerable · ignored · analysis/(SourceAnalysis cache), packets/(Context Packet), token-counts.json, llm/
└─ runtime/                  Runtime · ignored · reviews/(매 실행), metrics.jsonl, backup/
```

Git 정책은 "Truth / Human Decision → tracked, Derived / Runtime → ignored" 한 가지다([ADR-006](adr/ADR-006-duo-layout-git-policy.md)). 지시문 D§2의 `state/`, `evidence/`는 쓰지 않는다([conflicts.md C19](conflicts.md)).

## Write Boundary

DUO가 어디에 쓸 수 있는지는 core의 순수 정책 함수 `checkWriteBoundary(repositoryRoot, targetPath, writeKind, options?)`가 정한다(AC-002-04, REQ-SAFETY-001). 이 함수는 쓰지 않고 판정만 한다. 실제 파일 writer는 반드시 이 함수를 먼저 호출하고, symlink를 풀어(realpath) 다시 확인해야 한다.

| writeKind | 허용 영역(`.duo-project/` 기준) |
|---|---|
| `project-truth` | `project.yaml`, `.gitignore`(init, AC-014-05), `intent/`, `specs/`, `decisions/`, `milestones/`, `integrations/` |
| `human-history` | `reviews/` |
| `regenerable` | `generated/`, `cache/`, `runtime/` |

- Repository 밖 경로는 항상 `WRITE_OUTSIDE_REPOSITORY`로 거부한다(`..` 경로, 다른 저장소의 절대경로 포함).
- `.duo-project/` 밖(프로젝트 Source Code), 영역에 없는 경로(`.duo-project/unknown.txt`), 영역과 writeKind가 다른 쓰기는 `WRITE_NOT_ALLOWED`다.
- `options.restrictTo`로 호출 주체별 허용 경로를 더 좁힐 수 있다. 예: Agent는 `.duo-project/decisions/proposals/`만. 기본 영역을 넓힐 수는 없다.
- `duoctl install`이 설정하는 Agent 파일(AGENTS.md 등)은 TASK-017에서 별도 writeKind로 추가한다.
- 실제 writer는 core `guardWrite(root, path, kind, options?)`(boundary + 경로의 어떤 segment도 symlink가 아님)와 `guardDirectory`, `writeFileAtomic`(temp + rename), `createFileExclusive`(temp + hard link)를 쓴다(T13.1, DecisionService·Review Record·Init 공통).

## 소유권

| 경로 | DUO | Agent | Human |
|---|---|---|---|
| project.yaml, intent/, specs/, milestones/, integrations/ | init 시 초안 생성만 | 금지 | 수정 |
| decisions/D-*.yaml | DecisionService의 confirm/reject/supersede(Human 명령으로 실행) | 금지 | 명령 또는 수동 수정(fallback) |
| decisions/proposals/ | 새 파일 생성 | `duo_propose_decision`으로만 | 수정 가능 |
| reviews/ | `duoctl review --record`, Adoption Baseline(`duoctl init`) | 금지 | 삭제 가능 |
| generated/, cache/, runtime/ | 자유 | 금지 | 삭제 가능 |

## 스키마 공통 규칙

- **Strict**: 모든 스키마(zod `strictObject`)는 알 수 없는 필드를 오류(`SCHEMA_UNKNOWN_PROPERTY`)로 보고한다. `milstone: M1` 같은 오타가 조용히 무시되지 않는다.
- **extensions**: 사용자 정의 데이터는 각 객체의 `extensions:` 아래에만 둔다. 임의 필드는 허용하지 않는다.
- **schema_version**: `project.yaml`에만 있고 `.duo-project` 전체에 적용된다. 지원 버전은 `[1]`이다. 다른 값이면 `UNSUPPORTED_SCHEMA_VERSION`을 내고 프로젝트를 읽지 않는다. migration framework는 없다. Graph DB의 `graph_schema_version`과는 다른 개념이다(ADR-002).
- **이름 규칙**: 파일은 snake_case, domain model은 camelCase다. 변환 과정에서 경로를 정규화하고 모든 참조를 원문 위치와 함께 기록한다.
- **흐름**: 원문 → Source Parsing(YAML/Markdown AST, `src/source/` 안에서만) → unknown 데이터 → Zod 검증 → Domain Model. 라이브러리 타입은 `src/source/` 밖으로 나오지 않으며 lint로 강제한다.

## YAML 제한

`yaml` 2.x `parseDocument()`를 다음 설정으로 쓴다. 오류와 경고는 위치가 있는 diagnostic이 된다.

| 항목 | 정책 |
|---|---|
| Schema | YAML 1.2 core(타임스탬프 등 암묵 타입 변환 없음) |
| 중복 키 | 오류(`YAML_SYNTAX_ERROR`, DUPLICATE_KEY) |
| Merge key(`<<`) | 특별 취급하지 않음(일반 키) |
| 명시적 tag(`!!str`, `!custom`, `!!js/function`) | 모두 오류(`YAML_TAG_NOT_ALLOWED`) |
| Anchor, alias | 모두 오류(`YAML_ALIAS_NOT_ALLOWED`). alias 확장 방어(`maxAliasCount` 기본값)도 유지 |

## Markdown 정의 형식

`mdast-util-from-markdown`과 frontmatter 확장으로 구조를 읽는다. 정규식 파싱은 하지 않는다. `.duo-project/specs/`, `decisions/`, `milestones/` 안의 Markdown은 폴더와 관계없이 같은 규칙을 따른다. `sources.markdown`의 외부 문서도 같은 규칙으로 파싱할 수 있지만 정의가 아니라 External Evidence다([ADR-014](adr/ADR-014-traceability-ids.md#project-truth와-external-source)). 이 저장소의 docs/도 이 형식을 따르며, 테스트는 임시 `.duo-project/`로 복사해 self fixture로 쓴다.

정의로 인식하는 조건:

1. **Heading + metadata block**: 수준 2~4 Heading의 첫 단어가 ID이고, 그 Heading의 **바로 다음 블록**이 info string `duo`인 fenced code block이면 정의다. block의 `type`(`requirement` 기본, `issue`, `milestone`)이 종류를 정한다. Heading의 나머지는 title이다.
2. **Frontmatter**: 파일 첫 부분의 YAML frontmatter에 `type: decision`이 있으면 파일 전체가 Decision 하나다(ADR 형식).
3. **본문**: 정의의 설명은 metadata block 다음부터, 같은 수준 이하의 다음 Heading 전까지다.
4. **Acceptance Criteria**: Issue 본문의 목록 항목 중 첫 문단이 굵은 글씨 ID(`- **AC-010-01** 내용`)로 시작하는 것.

| 상황 | Diagnostic |
|---|---|
| metadata block 앞에 수준 2~4 Heading이 없음 | `METADATA_BLOCK_WITHOUT_HEADING` |
| Heading 첫 단어가 ID 형식이 아님 | `INVALID_ID` |
| ID로 시작하는 Heading 뒤에 metadata block이 없음 | `METADATA_BLOCK_MISSING`(warning, 정의 아님) |
| block YAML 오류, 스키마 위반 | YAML/SCHEMA 코드, Markdown 파일 기준 줄 |

`UNKNOWN:` 줄(Declared Knowledge Gap, TASK-011)은 Markdown AST의 문단(prose)에서만 찾는다. 문단의 한 줄이 `UNKNOWN: 내용` 또는 `UNKNOWN(key): 내용`으로 시작하면 gap이다(목록 항목, 인용, 굵은 글씨 안도 문단이다). fenced·indented code block, inline code, HTML, YAML frontmatter, `duo` metadata block 안의 문자열은 gap이 아니다. 원문 전체 정규식 검색은 하지 않는다. 모델과 ID는 [Knowledge Gap](#knowledge-gap)에 있다([conflicts.md C28](conflicts.md)).

### type별 block 필드

| type | 필드 |
|---|---|
| requirement | `status`(planned, in_progress, done, deferred), `milestone`, `priority`(must, should, could), `source`(인용 라벨 또는 `{path, hash, section?}`), `implements`({paths, symbols}), `tests`, `depends_on`, `extensions` |
| issue | `status`(todo, in_progress, review, done, 필수), `milestone`, `package`, `requirements`, `decisions`, `depends_on`, `extensions` |
| milestone | `title`, `state`(planned, active, done), `issues`(Issue ID 목록), `extensions` |

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
~~~~

## Issue 소유권

Issue의 내용과 AC는 **Markdown Issue 정의 한 곳**(`type: issue`)만 소유한다. Milestone은 Issue를 ID로만 참조하고 다시 정의하지 않는다.

```yaml
# milestones/M1.yaml
id: M1
title: Auth MVP
state: active
issues: [GAME-41, GAME-42]
```

Issue가 자기 `milestone`을 함께 적을 수 있다. Milestone 목록과 다르거나, 한 Issue를 두 Milestone이 나열하면 `TRACE_MILESTONE_MISMATCH`(warning)다.

## ID와 EntityRef

정의 ID 정규식: `^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z]?|M\d+)$`. 종류와 관계없이 전역에서 유일하다(`DUPLICATE_ID`). AC는 `AC-NNN[A-Z]?-NN`, Proposal은 `P-YYYYMMDD-xxxxxx`이다. 자세한 규칙은 [ADR-014](adr/ADR-014-traceability-ids.md)에 있다.

`EntityRef`는 모든 Graph entity를 가리키는 공통 참조다. 종류마다 구조화된 필드를 가지며 문자열을 이어 붙인 ID를 저장하지 않는다.

```ts
type EntityRef =
  | { type: "project" }
  | { type: "requirement" | "decision" | "issue" | "milestone"; id: string }
  | { type: "file"; path: RepoPath }
  | { type: "symbol"; path: RepoPath; symbol: string }
  | { type: "test"; path: RepoPath; name: string };
```

Node ID는 `nodeId(ref)`만 만든다. 구성 요소는 가역 escaping(`%` → `%25`, `#` → `%23`, 제어 문자 → `%XX`)을 거치므로 `parseNodeId(nodeId(ref))`가 항상 `ref`로 돌아온다. Unicode와 대소문자는 그대로 둔다. `parseNodeId`는 `nodeId`가 만들 수 없는 문자열(정규 형식이 아닌 escape, 정규화되지 않은 경로 등)을 거부한다.

| Entity | Node ID | 예 |
|---|---|---|
| Project | `project:root` | |
| Requirement / Decision / Issue / Milestone | `req:` / `dec:` / `issue:` / `ms:` + ID | `req:AUTH-03`, `dec:ADR-005`, `issue:TASK-012A`, `ms:M1` |
| File | `file:` + path | `file:docs/50%25 off %232.md` |
| Symbol | `sym:` + path + `#` + symbol | `sym:src/auth/AuthService.ts#AuthService.%23secret` |
| Test | `test:` + path + `#` + name | `test:src/한글 폴더/인증.test.ts#AuthService > refresh %232 (100%25)` |

Constraint는 Decision entity(`dec:CON-001`)다([conflicts.md C14](conflicts.md)). 사례 전체는 `fixtures/core/node-ids.json`에 있다.

## RepoPath

저장하는 모든 경로는 `RepoPath`다. `normalizeRepoPath`는 다음 세 가지만 한다.

1. 저장소 기준 상대경로로 만든다(절대경로는 root가 주어질 때만 변환하고, 저장소 밖이면 `PATH_OUTSIDE_REPOSITORY`).
2. 구분자를 POSIX `/`로 바꾼다(Windows `src\auth\a.ts` → `src/auth/a.ts`).
3. `.`과 `..` 세그먼트를 정리한다.

대소문자 변환, Unicode NFC/NFD 재작성, 앞뒤 공백 제거는 하지 않는다. Git과 파일 시스템의 실제 철자를 보존한다. 대신 case-insensitive이거나 Unicode를 정규화하는 파일 시스템에서 충돌할 경로(`Auth.ts`와 `auth.ts`, NFC와 NFD `café.ts`)는 `findPathPortabilityCollisions()`가 `PATH_PORTABILITY_COLLISION`(warning)으로 보고한다. 충돌 판정 키(`portablePathKey`: NFC + 소문자)는 비교에만 쓰고 저장하지 않는다. 저장소 스캔([Repository scan과 fingerprint](#repository-scan과-fingerprint))은 tracked 경로에 Git index 철자를 쓰고, 충돌 검사는 tracked와 untracked 경로 모두에 한다.

glob 패턴(`implements.paths`, `index.include/exclude` 등)은 구분자만 바꾸고 `**` 같은 세그먼트는 유지한다. 절대경로와 `..` 패턴은 거부한다. 매칭(`matchesRepoPattern`)은 저장소 root 기준이고 모든 OS에서 대소문자를 구분한다. 지원 문법은 세그먼트 안의 `*`와 `?`, 세그먼트 전체 `**`(0개 이상 디렉터리), 끝의 `/`(그 아래 전부)뿐이다. Node의 `path.matchesGlob`은 Windows와 macOS에서 대소문자를 무시해 OS마다 결과가 달라지므로 쓰지 않는다.

## 결정적 정렬

결정적 순서가 필요한 모든 곳(GraphStore, traverse, scanner, fingerprint 파일, diagnostic, trace link, canonical JSON 키)은 UTF-8 byte 사전순을 쓴다. 이 순서는 Unicode code point 순서, SQLite BINARY collation과 같다. JS 구현은 core `compareUtf8`다. JS 기본 비교(`<`, `sort()`)는 UTF-16 code unit 순서라 emoji 같은 보충 문자를 U+E000~U+FFFF보다 앞에 두고, `localeCompare`는 실행 환경의 locale에 따라 달라지므로 쓰지 않는다. 사례는 `fixtures/core/ordering.json`에 있고 core(`compareUtf8` = byte 비교)와 graph(SQLite 결과 = traverse 결과 = fixture) 테스트가 같은 fixture를 쓴다.

## Repository scan과 fingerprint

`@duo-director/analyzer`의 Scanner 계약이다(TASK-004). Graph Node payload(TASK-007)와는 별개다.

- **Git 필수**: DUO MVP는 Git 저장소를 전제로 한다(C36). Git이 아닌 디렉터리 fallback은 없다. scan root가 Git work tree가 아니면 `GIT_REPOSITORY_REQUIRED`, 최상위가 아니면 `SCAN_ROOT_INVALID`다. `duoctl init`(TASK-014)도 Git이 아닌 디렉터리에 같은 진단을 쓴다.
- **경로 출처**: tracked 파일은 Git index 철자, untracked 파일은 Git이 파일 시스템에서 읽은 철자를 RepoPath로 쓴다. 파일 시스템 `readdir()` 철자는 tracked 파일의 ID에 쓰지 않는다. Git 호출은 `rev-parse --show-prefix`, `ls-files -z --stage`, `ls-files -z --others --exclude-standard`, `diff-files -z --name-only --diff-filter=T` 네 번이고 파일마다 호출하지 않는다. Git CLI 세부는 analyzer 밖으로 export하지 않는다.
- **상태**: `RepositoryFileState = "tracked" | "untracked"`. ignored 파일과 `.git/`은 목록에 없다.
- **제외**(`ExclusionReason`): `.duo-project/generated|cache|runtime/`(duo-regenerable), `.duo-project/reviews/`(duo-history, T13.1: Review Record는 프로젝트 내용이 아니며 기록 때문에 index가 stale해지거나 다음 Review의 diff가 바뀌면 안 된다), 비밀 파일 패턴(secret, include보다 우선하고 대소문자 무시), `index.exclude`, `index.include` 불일치, symlink, working tree에 없는 tracked 파일(missing), submodule과 중첩 저장소, 일반 파일이 아닌 항목과 RepoPath로 표현할 수 없는 이름(unsupported-entry). tracked 파일은 .gitignore 패턴에 맞아도 포함한다.
- **Symlink**: 따라가지 않는다. index mode가 symlink(120000)면 checkout 형태(Windows `core.symlinks=false`의 일반 파일 포함)와 관계없이 symlink로 본다. 상위 디렉터리가 symlink인 파일도 제외한다. link 문자열만 읽어 대상이 저장소 밖이면 `SYMLINK_OUTSIDE_REPOSITORY`(warning), 안이면 `SYMLINK_SKIPPED`(info)를 낸다. 대상 파일은 읽지 않는다.
- **파일 타입 변경**(T04.1): index와 working tree의 symlink/일반 파일이 다르면 `FILE_TYPE_CHANGED`(info)와 `RepositoryScan.typeChanges`(`{ path, index, workingTree }`)에 사실만 남긴다. freshness 판정은 Indexer가 한다. index 일반 파일이 symlink가 되면 계속 symlink로 제외하고 대상을 읽지 않는다. index symlink가 일반 파일이 된 것은 Git이 typechange로 보고할 때만이다(Git이 `core.symlinks`를 반영하므로 Windows 기본 checkout은 해당하지 않음). 이 경우 일반 파일로 인덱싱하고 `gitBlobOid`는 붙이지 않는다(index blob은 이전 link 문자열).
- **충돌 검사**: 포함된 tracked와 untracked 경로 전체에 `PATH_PORTABILITY_COLLISION`을 적용한다.
- **Fingerprint mode**(C37): `fingerprintMode: "normalized-text" | "raw"`. hash 정책을 나타낼 뿐 파일의 실제 MIME/content type을 주장하지 않고, LanguageAnalyzer의 언어 지원 여부와도 별개다. 확장자와 파일 이름 목록(`NORMALIZED_TEXT_EXTENSIONS`, `NORMALIZED_TEXT_FILE_NAMES`, 소문자 비교)에 있으면 normalized-text, 없으면 raw다. 지원 source 확장자와 Project Truth 확장자(`.md`, `.yaml`, `.yml`, `.json`)는 모두 목록에 있다. 내용으로 추측하지 않는다.
- **`contentHash`** = `sha256:` + 64자리 hex. `normalized-text`는 CRLF(0x0D 0x0A)를 LF로 바꾼 bytes, `raw`는 원본 bytes를 hash한다. checkout EOL과 무관한 같은 hash는 normalized-text 파일에만 보장한다. 목록에 없는 텍스트 파일(예: `.log`)은 raw이므로 EOL 설정에 따라 hash가 달라질 수 있다. Unicode 정규화, trim, BOM 제거, 대소문자·공백·formatting 정규화는 하지 않고 lone CR도 그대로 둔다. bytes 단위로 처리하므로 decode/encode가 없다. `size`는 이 canonical bytes의 길이다.
- **`gitBlobOid`**: tracked 파일의 index blob OID(provenance)다. working tree 내용과 다를 수 있고 fingerprint로 쓰지 않으며 비교하지 않는다. untracked와 merge 충돌 파일에는 없다.
- **저장**: `.duo-project/generated/fingerprints.json`(graph.db와 분리). `{ format: "duo-fingerprints", version: 2, files: FileFingerprint[] }`이고 `FileFingerprint = { path, state, fingerprintMode, contentHash, size, gitBlobOid? }`다(version 2: T04.1의 `kind` → `fingerprintMode`). 경로는 UTF-8 순, 키 순서 고정, timestamp 없음. 쓰기는 `checkWriteBoundary(..., "regenerable")` 뒤 경로에 symlink가 없는지 확인하고 임시 파일 + rename으로 한다. 파일이 없으면 빈 cache, 읽을 수 없거나 형식·version이 다르면 `FINGERPRINT_CACHE_INVALID`(warning)와 빈 cache다. hash 규칙이나 normalized-text 목록을 바꾸면 version을 올린다.
- **mtime**: fingerprint에 없다. 이후 fast path hint로 쓰더라도 내용 동일성은 `contentHash`로만 판단한다.
- **비교**: `compareFingerprints(previous, current)`는 경로마다 `UNCHANGED | CHANGED | ADDED | DELETED`를 UTF-8 경로 순으로 돌려준다. CHANGED는 `contentHash`나 `fingerprintMode`가 다를 때다. state만 바뀌면 UNCHANGED, rename은 DELETED + ADDED다. Graph는 갱신하지 않는다.

### Freshness 책임

| 계층 | 책임 |
|---|---|
| GraphStore (TASK-003) | Node의 `contentHash`와 `source`를 손실 없이 저장하고 돌려준다. freshness를 판정하지 않는다 |
| Scanner (TASK-004) | 현재 파일 목록과 fingerprint를 계산하고 파일 단위 비교 primitive를 제공한다 |
| Indexer (TASK-008) | 저장된 state의 fingerprint·version·dependency와 현재 값을 비교해 바뀐 부분만 다시 분석·해석하고, 결과가 clean full rebuild와 같게 Graph를 갱신한다([증분 인덱싱](#증분-인덱싱)) |
| Freshness (TASK-008, 표시는 TASK-015/016) | 파일(fresh / changed / added / deleted / unknown), analysis(fresh / stale-content / stale-analyzer / missing / failed), resolution 수준으로 따로 정한다. 인덱싱하지 못한 경우는 unknown |

WAL에서 다른 연결이 쓰는 동안 마지막 commit 상태를 읽는 것은 snapshot visibility이며 freshness 판정과 다르다(C31).


## Source analysis

`LanguageAnalyzer`의 결과 계약이다(TASK-005, T05.1, [ADR-003](adr/ADR-003-language-analysis.md), 형식은 [04 SourceAnalysis](04-project-graph.md#sourceanalysis)). Graph를 만들지 않고 syntax 사실만 낸다.

- **대상**: 지원 확장자만 parse한다(.ts .mts .cts → TypeScript, .tsx → TSX, .js .mjs .cjs .jsx → JavaScript grammar). Scanner는 `.duo-project/`의 Truth 파일도 찾지만 Markdown/YAML은 LanguageAnalyzer가 `supports() == false`이며 parse하지 않는다. Project Truth parsing은 core가 맡는다. `.d.ts`도 TypeScript 파일로 분석하고 특별 취급하지 않는다.
- **입력과 hash**: 입력은 파일 bytes다. fingerprint와 같은 canonical bytes(normalized-text)를 UTF-8로 decode해 parse하므로 `SourceAnalysis.contentHash`는 `FileFingerprint.contentHash`와 같다. UTF-8이 아니면 `SOURCE_DECODE_ERROR`. contentHash는 BOM을 포함한 bytes로 계산하지만, parse하는 텍스트는 canonical source text(맨 앞 BOM 하나 제거)라서 BOM은 칸 수에 들어가지 않는다(T09.1, [SourceLocation](#sourcelocation)).
- **Symbol identity**: core `symbolRef(path, symbol)`와 `nodeId()`만 쓴다. `symbol`은 top-level과 instance member가 qualifiedName(`User.load`), static member가 `User.static.load`다. identifier가 아닌 member 이름은 JSON 문자열로 감싼다(`User["a.b"]`, `User.static["a.b"]`). 그래서 `static User.load` ≠ `instance User.load`이고 문자열 이름 안의 `.`이 static 접두사와 충돌하지 않는다. `qualifiedName`은 표시용이며 scope 간에 겹칠 수 있다. 위치나 byte offset은 ID에 넣지 않는다.
- **정렬**: 모든 목록은 `compareSourceLocations` 순서, 같으면 symbol identity / specifier, kind / calleeText / ids / fullName(`compareUtf8`) 순서다. AST 순회 순서에 기대지 않는다.
- **partial**: 트리에 ERROR나 MISSING 노드가 있으면 `parseStatus: "partial"`과 `AST_PARSE_ERROR`(warning, 파일당 20개 + 요약 1개). ERROR 노드 안은 읽지 않고 나머지는 계속 추출한다. parse가 파일당 제한 시간(기본 2초)을 넘으면 `AST_PARSE_TIMEOUT`이고 결과가 없다.
- **버전**: `TS_JS_ANALYZER_VERSION` 4(T05.1: static identity, binding, test. T07: `exports`, CallSite `calleePath` / `rootLocal` / `thisBinding`. T09.1: BOM 없는 canonical text). 버전이 바뀌면 그 Analyzer의 파일을 다시 분석한다(04).

## Git Provider

`openGitProvider(root)`가 돌려주는 read-only 사실이다(TASK-006). commit, checkout, add, reset, stash, merge, fetch 같은 쓰기는 없고, Graph 갱신과 freshness 판정도 하지 않는다. root가 Git work tree 최상위가 아니면 `GIT_REPOSITORY_REQUIRED` / `SCAN_ROOT_INVALID`다.

- **실행**: shell 없이 `git` 실행 파일과 인자 배열로 spawn한다. 환경은 `LC_ALL=C`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`로 고정하고 다른 저장소를 가리키는 변수와 `GIT_EXTERNAL_DIFF`를 지운다. diff 관련 사용자 설정(prefix, algorithm, external diff, textconv, color, submodule 표시)은 명령행 옵션과 `-c`로 덮어쓰며 설정 파일은 고치지 않는다. 경로는 `--literal-pathspecs` 뒤 `--` 다음에 넘기고, revision은 `-`로 시작하면 거부한 뒤 `rev-parse --verify <rev>^{commit}`로 OID로 바꿔 쓴다. 출력은 가능한 곳에서 모두 `-z` 형식이라 공백, tab, 줄바꿈, `#`, Unicode 경로를 그대로 다룬다. 파일마다 Git을 부르지 않는다.
- **`GitRepositoryState`**: `objectFormat`, `headOid?`, `branch?`(detached면 없음, unborn이면 첫 commit이 올라갈 이름), `detached`, `unborn`, `shallow`, `rootCommitOids`(HEAD에서 닿는 root commit, 저장소 identity). 절대 경로는 domain 값에 넣지 않고 `GitProvider.root`에만 둔다.
- **세 상태**: HEAD, Index, Working Tree는 서로 다르다. `GitBlobProvenance { path, headBlobOid?, indexBlobOid? }`는 두 OID를 섞지 않는다. T04 `gitBlobOid`는 계속 index 기준이고 working tree는 fingerprint `contentHash`다. `readBlob("HEAD" | "INDEX" | { commit }, path)`가 내용을 읽는다(Decision Lock 기준선, AC-006-02).
- **변경 모델**: `listWorkingTreeChanges()`(`status --porcelain=v2 -z`)는 path마다 `staged`(HEAD → Index)와 `unstaged`(Index → Working Tree)를 따로 둔다. 종류는 `added | modified | deleted | renamed | copied | type-changed | untracked | unmerged`이고 untracked는 unstaged 축에만 있다. mode와 HEAD/Index OID, 충돌 코드, submodule 여부를 함께 준다. `listChanges(from, to)`(`diff --raw -z`)는 두 endpoint 사이의 한 축 변경이다.
- **rename**: Git similarity heuristic(`-M`, 50%) 결과이며 `oldPath`, `path`, `similarity`로 준다. Graph Node ID는 옮기지 않고 Indexer가 판단한다. `git status`는 staged rename만 찾는다(C45).
- **Diff**: `listChanges`는 metadata만, `getDiff({ from, to, files, contextLines })`는 요청한 파일의 hunk(`oldStart, oldLines, newStart, newLines, section, lines`)만 준다. 파일 목록이 비면 `GIT_REQUEST_INVALID`이며 저장소 전체 diff 문자열은 만들지 않는다. endpoint 조합은 HEAD→INDEX, INDEX→WORKTREE, HEAD→WORKTREE, commit→INDEX|WORKTREE|HEAD|commit, HEAD→commit이다. unborn에서 HEAD는 빈 tree다. binary는 hunk 없이 `binary: true`, OID, 알 수 있으면 크기만 준다.
- **submodule**: gitlink entry는 `submodule: true`인 사실로만 기록하고 안으로 들어가지 않는다(T04 Scanner의 nested-repository 제외와 같은 정책).
- **history**: `listCommits({ maxCommits = 500 })`는 최신순 `{ oid, parents, message, files }`다(merge commit은 files 없음). `computeCoChangeCandidates`가 04의 CHANGED_WITH 규칙(3회 이상, 50파일 초과 commit 제외)으로 후보 쌍을 만들고(AC-006-03), `extractIssueKeys`가 commit message와 branch 이름에서 ID 후보를 뽑는다(AC-006-04). Project Truth와 대조는 TASK-007이다.
- **Evidence provenance primitives**: commit SHA(`headOid`, commit oid), RepoPath, HEAD blob OID, Index blob OID, working-tree `contentHash`(fingerprint), diff range(hunk의 new/old 줄 범위). Evidence 조립은 TASK-013이다.

## Graph Build

Project Graph를 만드는 계약이다(TASK-007, 관계 규칙은 [04](04-project-graph.md)). AST를 다시 parse하지 않고 T04~T06 사실만 쓰며 LLM을 호출하지 않는다.

```text
collectGraphFacts(root)      ProjectTruth + TraceModel, Scan/fingerprint, SourceAnalysis[], Git state + 최근 500 commit, ModuleResolver
  → buildGraphPlan(input)    GraphBuildPlan { nodes, edges, diagnostics, stats, moduleResolutions, callResolutions, valid }
  → applyGraphPlan(store, plan)   GraphStore transaction 하나
```

- **Plan**: nodes는 Node ID, edges는 (from, type, to)의 UTF-8 순서다. 입력 순서나 파일 시스템 순회 순서가 결과를 바꾸지 않는다. 같은 입력이면 같은 plan이다.
- **Validation**: 모든 Edge의 endpoint 존재와 04 endpoint matrix, Node payload schema, 같은 Node ID의 서로 다른 내용을 검사한다. 오류(`EDGE_ENDPOINT_INVALID`, `GRAPH_PAYLOAD_INVALID`, `GRAPH_NODE_CONFLICT`)가 하나라도 있으면 `valid: false`다.
- **Transaction**: `applyGraphPlan`은 invalid plan을 쓰지 않는다(`GRAPH_WRITE_REFUSED`). 쓰기는 한 transaction에서 기존 Node 전체 삭제(Edge는 cascade) 후 Node, Edge upsert이며 도중 실패는 rollback되어 DB가 반쯤 바뀐 상태로 남지 않는다. 이것이 clean full rebuild이고, 증분 갱신은 바뀐 scope만 고친다([증분 인덱싱](#증분-인덱싱)).
- **상태**: ExportIndex, module resolution cache, tsconfig cache는 build 호출 단위이며 전역 가변 상태가 없다. 증분 build는 이전 resolution 결과를 `ResolutionMemo`로 넘기고, memo가 없으면 모두 계산한다(같은 builder).
- **소유(T08)**: Symbol과 Test Node는 `ownerFile`(추출된 파일의 RepoPath, graph `owner_file` 칼럼)을 가진다. Project, Milestone, Requirement, Decision, Issue, File Node는 소유 파일이 없다. File Node가 자기 자신을 소유하지 않으며 Project Truth는 `source.path`로 원문을 찾는다.
- **Edge category(T08)**: Edge metadata `categories`는 그 Edge를 만든 입력의 종류다. `project-truth`(trace link, Project → Milestone, implements·tests·governs 참조), `source-analysis`(Project/File/class CONTAINS), `module-resolution`(IMPORTS), `call-resolution`(CALLS), `annotation`, `test`(test 안 exact 호출의 VALIDATED_BY), `git-history`(CHANGED_WITH). 여러 입력이 같은 Edge를 만들면 합집합이다.
- **History 입력(T08)**: builder는 commit 목록 대신 `HistorySummary`(window commit 수, window fingerprint, co-change 후보, Issue key 후보 → commit OID)를 받는다. commit message는 builder로 가지 않는다.
- **Node payload**: 종류별 zod strict schema(`NODE_PAYLOAD_SCHEMAS`)다. 목록은 [04 Node](04-project-graph.md#node). payload는 lookup record라 제목, 상태, 종류만 두고 본문을 복사하지 않는다. 위치는 Node `source`(`SourceLocation`), 내용 hash는 `contentHash` 칼럼이다(File은 fingerprint, Symbol·Test는 SourceAnalysis `contentHash`).
- **File Node 범위**: T04 fingerprint가 있는 파일 중 `.duo-project/` 밖의 파일이다. Project Truth 문서는 Requirement·Decision Node의 `source.path`로 찾으며 IMPORTS·CALLS graph에 섞지 않는다(C47).
- **Symbol 이름 참조**: `implements.symbols`, `governs.symbols`는 같은 정의의 `paths`에 맞는 파일 안에서 qualifiedName으로 찾는다. 후보가 없거나 둘 이상이면 `DECLARED_SYMBOL_UNRESOLVED`(warning)이고 Edge가 없다(C55).
- **Stats**: Node·Edge 종류별 수, module 결과(resolved, external, unresolved, ambiguous, unsupported), call 결과(exact, heuristic, ambiguous, unresolved, exactWithoutSourceSymbol), annotation 결과(symbol, test, file, unknownId, unsupportedId). Graph 품질 benchmark의 입력이다.

## 증분 인덱싱

`indexRepository(root, { store })`의 계약이다(TASK-008, 관계 규칙은 [04 증분 갱신](04-project-graph.md#증분-갱신)).

- **불변식**: **Incremental Result == Clean Full Rebuild Result.** 같은 Repository 상태에서 증분 결과는 `collectGraphFacts` → `buildGraphPlan` → `applyGraphPlan`으로 빈 DB에 만든 결과와 canonical Node/Edge 행(`dumpGraph`)이 같다. 속도를 위해 이 조건을 느슨하게 하지 않는다.
- **구조**: plan은 언제나 full builder(`buildGraphPlan`)가 만든다. Indexer는 비싼 결과만 재사용하고, 나머지(Project Truth 관계, annotation, VALIDATED_BY, CHANGED_WITH 필터, payload)는 매번 다시 계산한다.

| 재사용 대상 | 유효 조건 | 저장 위치 |
|---|---|---|
| SourceAnalysis(AST parse) | contentHash 같음 AND analyzer id·version 같음 AND cache 항목 있음 | `cache/analysis/<key>.json` |
| module resolution | analysis 재사용 AND indexed 파일 집합 변화 없음 AND config 범위 변화 없음 AND `ModuleResolver.version` 같음 | index-state `files[].resolution.modules` |
| call resolution | analysis 재사용 AND module 결과 같음 AND export dependency 파일의 analysis·module 결과 변화 없음 AND `CALL_RESOLUTION_VERSION` 같음 | `files[].resolution.calls`, `exportDependencies` |
| Git history window | HEAD OID와 shallow 여부 같음 | `history.summary` |

- **state**: `generated/index-state.json`(`duo-index-state` version 3. 2는 T08.1: config diagnostics와 `git` {headOid, branch, detached}. 3은 T13: 그 실행의 persistent diagnostics `diagnostics`, Review가 `DECLARED_SYMBOL_UNRESOLVED` 등을 다시 계산하지 않고 읽는다, C106). `token`, `graphSchemaVersion`, `moduleResolutionVersion`, `callResolutionVersion`, `historyWindow`, `files[]`(fingerprint 필드, `analysis` {analyzer, version, status ok·failed}, `resolution` {modules, calls, exportDependencies, configFiles}, scope digest), `configs`(resolver가 읽은 config 파일 → contentHash, 가장 가까운 config에는 그 diagnostics), `truthScope`, `history` {headOid, shallow, summary}. 원문, SourceAnalysis, commit message는 넣지 않는다. zod strict schema로 읽고 `token`(내용의 sha256)이 맞는지 확인한다.
- **analysis cache**: key는 sha256(path, contentHash, analyzer, analyzerVersion)이다. 항목은 불변이고 읽을 때 key 값을 다시 확인하며, 없거나 다르면 cache miss(analysis `missing`)로 다시 parse한다. syntax 사실과 그 diagnostics만 있고 원문은 없다. 성공한 실행 뒤 현재 파일이 쓰지 않는 항목을 지운다. 실패한 analysis는 cache하지 않고 매 실행 다시 시도한다(C58).
- **Scope와 diff**: Node와 Edge는 scope 하나에 속한다. File·Symbol·Test는 그 파일 scope(`file:<path>`)이고, Edge는 source 쪽 code Node의 파일, 없으면 target 쪽, 둘 다 아니면 Project Truth scope다. state는 scope마다 canonical 행의 sha256을 둔다. digest가 바뀐 scope만 DB에서 읽어(`listNodes({ ownerFile })`, 인접 Edge) 행 단위로 비교하고 추가·갱신·삭제를 계산한다(`diffScopes`). 바뀌지 않은 scope는 읽지도 쓰지도 않는다.
- **Atomicity**: Graph 변경과 `meta.index_state_token`(새 state의 token)을 한 transaction에 쓰고 commit 뒤 state 파일을 임시 파일 + rename으로 바꾼다. transaction 안에서 이전 token을 다시 확인해 다른 writer의 변경 위에 쓰지 않는다. Graph가 바뀌면 `meta.graph_revision`을 1 올린다. 그다음 `fingerprints.json`을 쓴다. 변경이 없으면 아무것도 쓰지 않는다(C59).
- **Recovery**: state 없음(`no-state`), 손상 또는 token이 내용과 다름(`state-invalid`, `INDEX_STATE_INVALID`), 다른 format·version(`state-unsupported`), DB token과 다름(`state-mismatch`: commit과 state 쓰기 사이의 중단), graph schema나 history window가 다름(`incompatible`), 요청(`requested`)이면 전체 재구축한다. 전체 재구축은 analysis cache를 쓰지 않는다. transaction이 실패하면 Graph와 state 모두 이전 그대로이고 다음 실행이 이어서 갱신한다. graph DB의 schema version이 다르면 `onUnsupportedSchema: "recreate"`로 다시 만든다.
- **Freshness**: 파일 `fresh | changed | added | deleted | unknown`, analysis `fresh | stale-content | stale-analyzer | missing | failed`, module `fresh | missing | stale-version | stale-source | stale-file-set | stale-config`, call `fresh | missing | stale-version | stale-source | stale-modules | stale-dependency`. 결과의 `freshness`는 실행 전 상태, 곧 무엇을 왜 다시 계산했는지다.
- **Metrics**: mode, fullRebuildReason, files(total, unchanged, changed, added, deleted, analyzed = parse 횟수, analysisReused, analysisFailed), resolution(module·call 재계산/재사용 수와 파일 수), history(recomputed, commits), graph(scopes, scopesChanged, Node·Edge 추가/갱신/삭제, written).
- **Diagnostics(T08.1)**: 결과 diagnostics는 canonical 순서다. persistent diagnostics는 clean full rebuild(`collectGraphFacts` + `buildGraphPlan`)와 같다. config 진단은 builder가 plan에 넣고, 이번 실행에서 config를 다시 읽지 않았으면 state에 저장된 것을 쓴다.
- **Read-only inspection(T08.1)**: `inspectIndex(root, { graph })`는 scan, fingerprint, Project Truth, config, version, history를 비교하고 invalidation을 계획하지만 쓰지 않는다(GraphStore 쓰기, state·fingerprint 파일, analysis cache, graph_revision 모두 없음). `graph`는 schema version과 meta 읽기만 받는다. 결과는 `status`(current = 실행해도 쓸 것이 없음, stale, missing, incompatible), `fullRebuildReason`, 경로별 freshness(파일·analysis·module은 Indexer와 같은 판정, call은 `predictedCalls`라는 상한 예측), 바뀐 Project Truth와 config, history(기록된·현재 HEAD, 재계산 여부), `wouldRebuild`(full, parse, modules, predictedCalls, history, projectTruth)다. call 쪽은 "다시 계산할 수 있음"이며 사용자에게 "다시 계산한다"로 표시하지 않는다. 판정 함수는 Indexer와 공유한다(`incremental/assess.ts`). `duoctl status`, MCP `duo_get_status`, UI가 이 결과를 쓰며 UI 전용 freshness 로직은 두지 않는다.
- **열기**: `openProjectGraphStore(root)`는 `generated/`를 만들고 graph DB를 열며 다른 schema version이면 다시 만든다.
- **한계(node_modules)**: `node_modules`와 index 대상이 아닌 파일은 fingerprint하지 않는다. `package.json`, lockfile, tsconfig/jsconfig 변경이 resolution 무효화 신호이며, 이 파일들을 바꾸지 않고 `node_modules`만 바뀌면(예: 다른 버전 설치, workspace link 변경) 저장된 resolution이 현재 환경과 다를 수 있다. 이때는 전체 재구축(`indexRepository(root, { full: true })`, 이후 `duoctl index --full`)으로 복구한다. `node_modules` 전체 fingerprint는 하지 않는다(C61).

## SourceLocation

```ts
type SourceLocation = { path: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number };
```

- `path`는 RepoPath, 줄과 칸은 1부터 센다. `endColumn`은 exclusive(마지막 문자 다음 칸)다.
- Markdown 정의와 YAML 정의가 같은 계약을 쓴다. Markdown 정의는 Heading부터 섹션 끝까지, YAML 파일 전체가 정의인 경우(Decision, Milestone)는 문서 내용의 범위, 목록 항목(Constraint)은 그 항목의 범위다.
- **canonical source text(T09.1)**: 모든 위치는 파일을 UTF-8로 읽고 맨 앞 BOM 하나를 지우고 CRLF를 LF로 바꾼 텍스트(`canonicalSourceText`)를 가리킨다. loader(Markdown, YAML)와 LanguageAnalyzer가 이 텍스트를 parse하므로, 만든 위치는 모두 정확히 잘린다.
- **범위는 [start, end)**: 줄바꿈 바로 뒤에서 끝나는 범위의 끝은 다음 줄 1열이다. 파일 끝까지 가는 정의(마지막 Markdown section, ADR 형식 Decision, vision)의 끝은 마지막 문자 다음 위치(offset `source.length`)이고, 존재하지 않는 줄이나 칸을 만들지 않는다. YAML 정의는 문서 내용의 범위이며 끝의 줄바꿈을 포함하지 않는다.
- **완전한 범위**: 정의와 분석 사실의 위치는 네 값을 모두 가진다. 경로만 있는 위치는 파일 전체를 뜻한다(진단용). 범위 끝을 알 수 없는 예외(파일 누락 등)에서만 end 필드를 생략하며, 그런 위치는 slice할 수 없다.
- **offset을 두지 않는 이유**: UTF-16 offset은 LF와 CRLF checkout에서 값이 달라진다. 줄·칸만 쓰면 같은 위치가 두 checkout에서 같은 텍스트를 가리킨다.
- Evidence Pointer와 diagnostic이 이 위치를 그대로 쓴다.
- **단위**: 줄은 LF로 센다. 칸은 UTF-16 code unit(JS 문자열 index + 1)이다. YAML(`LineCounter`), Markdown, Tree-sitter(web-tree-sitter는 JS 문자열을 UTF-16으로 넘긴다) 모두 같은 단위이며 UTF-8 byte나 code point가 아니다. 예: `/* 😀😀 */ 표시()`의 `표시`는 12번째 칸이다(UTF-8 byte로는 16, code point로는 10). LF 앞의 CR은 그 줄 끝에 속하므로 LF와 CRLF checkout에서 같은 위치가 같은 텍스트를 가리킨다.
- core `sliceSource(canonicalText, location)`이 위치의 정확한 원문을 돌려준다. 불완전한 범위나 원문 밖을 가리키는 위치는 잘라 맞추지 않고 `SOURCE_LOCATION_INVALID`(error, persistent)다. 잘못된 위치는 producer의 버그이며 Evidence로 쓰지 않는다. `readSourceFile` / `readSourceSlice(root, location)`는 저장소 경계와 symlink를 확인한 뒤 canonical text를 읽는다. Decision digest, Packet Dependency Digest, Evidence, UI source 이동이 모두 이 경로를 쓴다. 저수준 `sliceSourceLocation`은 같은 규칙으로 `undefined`를 돌려준다. `compareSourceLocations`가 path(UTF-8), 시작, 끝 순으로 정렬한다.

## Context Packet

Context Packet(T10)은 요청마다 만드는 값이며 저장소 파일이 아니다. 형식은 [05 Packet 모델](05-context-compiler.md#packet-모델)의 `ContextPacket`(`duo.context-packet/1`)이다.

- CONFIRMED INTENT는 Project Truth만 담는다: Requirement, confirmed이고 superseded_by가 없는 Decision, confirmed Constraint. superseded Decision은 `decisions.history`에 ID, 제목, superseded_by만 둔다.
- Proposal, proposed Decision, draft Constraint는 `pendingDecisions`(`confirmed: false`, `status: "PENDING / NOT CONFIRMED"`)에만 둔다. pending 판정은 `pendingDecisionProposals()`다.
- 원문은 이 문서의 [SourceLocation](#sourcelocation) 계약으로 slice한다. Packet의 `source`는 그 위치다.
- 같은 입력이면 JSON과 Markdown이 byte 단위로 같다. 시각과 실행 시간은 Packet에 없다.
- `CONTEXT_REQUEST_INVALID`(error, transient): 빈 task, 범위 밖 budget(1,000~1,000,000), 모르는 profile, frame보다 작은 budget.

## Knowledge Gap

TASK-011. Gap은 "지금 작업에 중요한데 아직 정해지지 않은 것"이다. 출처가 둘이며 섞지 않는다. 어느 쪽도 Graph Node가 아니고 파일로 저장하지 않는다(graph schema version 변경 없음, `generated/gaps.json` 없음, C94).

**Declared Gap**(`truth.gaps`, core `DeclaredGap`): Human이 Project Truth 문서에 쓴 `UNKNOWN:` 줄([Markdown 정의 형식](#markdown-정의-형식)).

| 필드 | 의미 |
|---|---|
| `id` | `gap-` + sha256(owner Node ID, key, 정규화한 text)의 앞 12자리. 정규화는 NFC, 공백 압축, trim, 소문자(locale 무관). 줄 번호는 identity가 아니다. 앞에 줄을 넣어도 ID가 같고, 내용을 바꾸면 다른 gap이다 |
| `owner` | gap을 포함한 가장 안쪽 정의(Requirement, Issue, Milestone의 section, ADR 형식 Decision 파일 전체)의 EntityRef. 정의 밖(vision.md, 정의가 없는 specs 문서)은 `project` |
| `key` | `UNKNOWN(key):`의 key. 해결 판정에만 쓴다 |
| `text`, `location` | 콜론 뒤 내용, `UNKNOWN`부터 그 줄 끝까지의 위치(정확히 slice됨) |

새 문서에는 `UNKNOWN(key): 내용` 형식을 권장한다. key가 있어야 Decision의 question으로 결정적으로 해결되고 Task가 key로 gap을 가리킬 수 있다. key 없는 `UNKNOWN:`도 계속 지원하지만 LLM이나 fuzzy 비교로 자동 해결하지 않으며, 줄을 지우기 전까지 unresolved다(C93).

같은 owner, key, text가 여러 곳에 있으면 gap 하나다(파일 순서상 첫 위치). YAML 파일(`decisions/D-###.yaml`, constraints, milestones YAML)은 prose가 아니라서 읽지 않는다(C92).

**해결 판정**(C93): key가 있는 gap은 question이 그 key와 같은 활성 Decision(confirmed, superseded_by 없음)이 owner를 다룰 때 resolved다. "다룬다"는 owner가 project면 항상, Requirement면 governs.requirements에 있을 때, Issue면 그 Issue의 decisions에 있거나 Issue의 Requirement를 governs할 때, Milestone이면 그 Milestone의 Requirement를 governs할 때, Decision이면 같은 Decision이거나 그것을 supersede(연쇄 포함)하거나 같은 Requirement를 governs할 때다. key가 없거나 그런 Decision이 없으면 unresolved다. 텍스트 의미는 해석하지 않는다. `UNKNOWN:` 줄을 지우면 gap은 더는 선언되지 않는다(AC-011-04).

**Runtime Gap**: 이번 요청을 평가하며 DUO가 찾은 불확실성이다. ID는 `rgap-` + sha256(kind, task, 관련 anchor ID)이며 그 평가 안에서만 안정적이다.

| kind | 출처 | 기본 action |
|---|---|---|
| `ambiguous-target` | Context `ambiguous`(선택지 포함) | ask |
| `unresolved-target` | Task에 쓴 ID가 Project Truth에 없음 | ask |
| `pending-decision` | Packet `pendingDecisions`. `requiresHumanDecision`이면 ask, 아니면 surface | ask / surface |
| `missing-intent` | seed 없음, 또는 `no-confirmed-intent` signal | surface |

모델 `KnowledgeGap { id, source, kind, text?(Declared만), anchors, location?, relevance, reasons, action, key?, resolution?, term?, options?, target?, pending? }`와 평가 결과 `KnowledgeGapAssessment`는 [05 Knowledge Gap assessment](05-context-compiler.md#knowledge-gap-assessment)에 있다.

## Diagnostics

```ts
type Diagnostic = { code: DiagnosticCode; severity: "error" | "warning" | "info"; message: string; source?: SourceLocation };
type ParseResult<T> = { value?: T; diagnostics: readonly Diagnostic[] };
```

Parser와 loader는 예외를 던지지 않고 모든 문제를 모은다. 일부 파일이 실패해도 읽을 수 있는 Project Truth는 value로 돌려준다. 코드와 기본 심각도는 `DIAGNOSTIC_SEVERITY`에 있다.

**Persistent / transient(T08.1)**: 코드마다 성격을 중앙 registry `DIAGNOSTIC_PERSISTENCE`에 둔다(`satisfies Record<DiagnosticCode, …>`라 새 코드는 분류 없이 컴파일되지 않는다).

- **persistent**: 저장소 내용, Project Truth, DUO 버전의 결정적 함수다. 예: `TSCONFIG_INVALID`, `MODULE_UNRESOLVED`, `MODULE_AMBIGUOUS`, `ANNOTATION_TARGET_UNKNOWN`, `DECLARED_SYMBOL_UNRESOLVED`, `PATH_PORTABILITY_COLLISION`, `AST_PARSE_ERROR`, 스키마·추적성 진단, `DECISION_LOCK_MISMATCH`.
- **transient**: 실행 환경이나 요청한 조작의 결과다. 예: IO(`FILE_READ_ERROR`, `FILE_WRITE_ERROR`), Git 프로세스 실패(`GIT_COMMAND_FAILED` 등), 잠금·쓰기 거부(`GRAPH_WRITE_REFUSED`, `DECISION_LOCK_BUSY`), 로컬 generated 상태(`INDEX_STATE_INVALID`, `FINGERPRINT_CACHE_INVALID`, `GRAPH_OPEN_FAILED`), parse 시간 초과, write boundary와 DecisionService 조작 결과.
- **불변식**: 동일 Repository + 동일 Project Truth + 동일 DUO Version이면 persistent diagnostics가 같다. `persistentDiagnostics()`는 persistent만 골라 canonical 순서(위치, code, severity, message)로 정렬하고 중복을 없앤다. 증분 실행이 계산을 재사용해도 그 계산의 persistent diagnostics는 함께 재사용한다(analysis cache 항목, index-state의 config diagnostics). diagnostic을 다시 만들려고 parse나 resolution을 하지 않는다.

| 영역 | 코드 |
|---|---|
| 파일, 버전 | `FILE_READ_ERROR`, `PROJECT_FILE_MISSING`, `UNSUPPORTED_SCHEMA_VERSION` |
| 원문 파싱 | `MARKDOWN_PARSE_ERROR`, `YAML_SYNTAX_ERROR`, `YAML_WARNING`, `YAML_ALIAS_NOT_ALLOWED`, `YAML_TAG_NOT_ALLOWED` |
| 스키마 | `SCHEMA_UNKNOWN_PROPERTY`, `SCHEMA_MISSING_PROPERTY`, `SCHEMA_INVALID_VALUE`, `INVALID_ID` |
| 경로, 쓰기 | `INVALID_PATH`, `PATH_OUTSIDE_REPOSITORY`, `PATH_PORTABILITY_COLLISION`(warning), `WRITE_OUTSIDE_REPOSITORY`, `WRITE_NOT_ALLOWED` |
| 정의 구조 | `METADATA_BLOCK_WITHOUT_HEADING`, `METADATA_BLOCK_MISSING`(warning) |
| 추적성 | `DUPLICATE_ID`, `BROKEN_REFERENCE`, `REFERENCE_TYPE_MISMATCH`, `DECISION_SUPERSEDES_SELF`, `DECISION_SUPERSEDE_CYCLE`, `TRACE_MILESTONE_MISMATCH`(warning), `TRACE_DECISION_UNRELATED`(warning), `TRACE_REQUIREMENT_UNTRACKED`(info) |
| Graph DB | `GRAPH_SCHEMA_UNSUPPORTED`, `GRAPH_OPEN_FAILED` |
| Indexer(T08) | `INDEX_STATE_INVALID`(warning, 전체 재구축) |
| DecisionService(T09) | `DECISION_ACTOR_FORBIDDEN`, `PROPOSAL_NOT_FOUND`, `PROPOSAL_NOT_PENDING`, `PROPOSAL_INVALID`, `PROPOSAL_STALE`(warning), `DECISION_LOCKED`, `DECISION_TARGET_UNSUPPORTED`, `DECISION_SUPERSEDE_TARGET_INVALID`, `DECISION_LOCK_BUSY`(모두 transient), `DECISION_LOCK_MISMATCH`(warning, persistent) |
| Graph build(T07) | `TSCONFIG_INVALID`(warning), `MODULE_UNRESOLVED`(warning), `MODULE_AMBIGUOUS`(warning), `CALL_AMBIGUOUS`(info), `CALL_UNRESOLVED`(info, 통계로만), `ANNOTATION_TARGET_UNKNOWN`(warning), `ANNOTATION_TARGET_UNSUPPORTED`(info), `TEST_ID_CONFLICT`(warning), `DECLARED_SYMBOL_UNRESOLVED`(warning), `EDGE_ENDPOINT_INVALID`, `GRAPH_NODE_CONFLICT`, `GRAPH_PAYLOAD_INVALID`, `GRAPH_WRITE_REFUSED`, `GRAPH_INVARIANT_VIOLATED` |

## 추적 관계

정의 안의 참조는 원문 위치와 함께 기록되고(`DeclaredReference`), `analyzeTrace`가 존재와 종류를 확인한 뒤 정규 방향의 링크를 만든다.

| 선언 | 링크 |
|---|---|
| Decision `governs.requirements` | Decision GOVERNS Requirement |
| Issue `decisions` | Decision GOVERNS Issue |
| Issue `requirements` | Requirement TRACKED_BY Issue |
| Issue `depends_on` | Issue REQUIRES Issue |
| Requirement `milestone` | Milestone REQUIRES Requirement |
| Requirement `depends_on` | Requirement REQUIRES Requirement |
| Decision `supersedes` | **new Decision SUPERSEDES old Decision** |
| Milestone `issues`, Issue `milestone`, Decision `superseded_by`, Proposal의 참조, `project.yaml current_milestone` | 존재와 종류만 확인 |

SUPERSEDES는 대상 Decision이 있어야 하고, 자기 자신을 대체할 수 없으며(`DECISION_SUPERSEDES_SELF`), 직접 또는 여러 단계를 거친 순환이 없어야 한다(`DECISION_SUPERSEDE_CYCLE`).

## project.yaml

```yaml
schema_version: 1
name: auth-app
current_milestone: M1
sources:
  markdown: [README.md]       # External Evidence / Input Source(Truth 아님)
index:
  include: []                 # 비어 있으면 Git이 추적하는 모든 파일
  exclude: []
  max_file_bytes: 1048576
context:
  default_budget_tokens: 6000
  max_depth: 2
review:
  warn_on_untested_change: true
  warn_on_unlinked_addition: true
test_command: null            # 설정 시에만 duoctl review --run-tests가 실행
llm:                          # ADR-012
  provider: none              # none | openai-responses
  model: null
  api_key_env: OPENAI_API_KEY
  base_url: null              # null이면 OpenAI 기본 endpoint
  max_calls_per_review: 1
  max_input_tokens: 4000
  timeout_ms: 30000
extensions: {}
```

## intent/vision.md

```markdown
---
status: draft            # draft | confirmed
owner: human
---
# Goal
...
```

## intent/constraints.yaml

```yaml
constraints:
  - id: CON-001
    statement: OAuth is outside MVP.
    state: confirmed          # draft | confirmed | retired
    enforcement: warn         # warn | block
    match:
      paths: ["src/**/oauth/**"]
      symbols: ["*OAuth*"]
      dependencies: ["passport-google-oauth20"]
      keywords: ["oauth"]
    source: [{path: README.md, hash: "sha256:abc123", section: Scope}]   # 선택: 외부 출처(ADR-014)
```

## decisions/D-###.yaml

```yaml
id: D-015
title: JWT with refresh rotation
kind: decision
state: confirmed          # proposed | confirmed | superseded | rejected
question: auth_mechanism
answer: jwt_rotating_refresh
rationale: Limit the damage of a leaked refresh token.
owner: human
governs:
  requirements: [AUTH-01, AUTH-03]
  paths: ["src/auth/**"]
forbids:
  dependencies: ["express-session"]
enforcement: block        # warn | block (선택, Review가 TASK-013에서 사용)
supersedes: D-004          # SUPERSEDES: D-015 → D-004
superseded_by: null
evidence:
  - {kind: review, id: R-20260927-153012-91aca1}
proposal: P-007            # DecisionService가 확정한 proposal(감사 기록)
proposed_by: codex
proposed_by_kind: agent    # human | agent | system
proposed_at: "2026-09-27T06:10:00.000Z"
confirmed_at: "2026-09-27T06:40:00.000Z"
confirmed_by: kanghyunsoon
lock:
  digest: "sha256:3f1c..."
```

ADR 형식 Markdown Decision은 같은 필드를 frontmatter에 두고 `type: decision`을 붙인다.

## decisions/proposals/P-*.yaml

Proposal은 Project Truth가 아니고 Graph Node도 아니다. Human이 confirm해야 Decision이 된다([ADR-013](adr/ADR-013-decision-lifecycle.md), TASK-009).

```yaml
id: P-007                  # DecisionService가 P-### 순서로 할당. 예전 P-YYYYMMDD-xxxxxx 형식도 읽는다
title: Passkey login
state: proposed            # proposed | rejected
question: login_mechanism
answer: passkey
governs: {requirements: [AUTH-01]}
enforcement: warn
supersedes: D-004          # 선택. 존재하는 confirmed YAML Decision만
proposed_by: codex
proposed_by_kind: agent
proposed_at: "2026-09-27T06:10:00.000Z"
based_on:                  # stale 탐지용 provenance
  truth_digest: "sha256:…"   # proposals를 뺀 Project Truth 파일 내용
  refs: [{id: AUTH-01, digest: "sha256:…"}, {id: D-004, digest: "sha256:…"}]
# reject 후: state: rejected, rejected_at, rejected_by, reason(선택)
```

- Decision과 같은 내용 필드(title, kind, question, answer, rationale, governs, forbids, enforcement, supersedes, evidence, source, extensions)를 쓴다. `owner`는 confirm이 `human`으로 기록한다.
- **propose**: agent, system, human 모두 가능하다. 쓰기 전에 loader와 같은 schema와 core 추적성 규칙(없는 참조, 대상 타입)으로 검사하고, 통과하면 `decisions/proposals/P-###.yaml` 하나만 새로 만든다. supersede 대상은 confirmed Decision이어야 한다.
- **confirm**(human만): 다음 `D-###`으로 새 `decisions/D-###.yaml`을 exclusive하게 만들고 `proposal`, proposer, `confirmed_by/at`, `lock.digest`를 기록한다. 이 파일 생성이 commit 지점이다. 이어서 supersede 대상의 `state`와 `superseded_by`만 바꾸고 proposal 파일을 지운다. 이 두 단계가 실패하면 다음 DecisionService 조작이 먼저 마무리한다(repair). Project Truth가 proposal 이후 바뀌었으면 `PROPOSAL_STALE`(warning)와 바뀐 참조 목록을 돌려주고 확정은 진행한다.
- **reject**(human만): 파일을 지우지 않고 `state: rejected`, `rejected_at`, `rejected_by`, `reason`을 기록한다. 다른 필드와 주석은 그대로다.
- Proposal의 `supersedes`는 SUPERSEDES 링크를 만들지 않고 존재만 확인한다.
- **조회(T09.1)**: 어느 proposal이 pending인지는 core `listDecisionProposals(truth)` 하나가 정한다. pending = `state: proposed` AND 그 proposal ID를 `proposal`로 가진 Decision이 없음이다. Decision이 있으면 파일이 남아 있어도 `committed`(`cleanupPending`)이고, `state: rejected`면 `rejected`다. 파일이 있다고 pending은 아니다. 조회는 읽기만 하고 repair하지 않는다. 남은 파일 정리는 명시적 mutation `repairDecisionState()`이며, DecisionService의 쓰기 조작(propose, confirm, reject)도 lock 안에서 먼저 repair한다. `duoctl status`, MCP `duo_get_status`, UI, Context Compiler는 `pendingDecisionProposals()`를 쓴다.
- 시각은 주입 가능한 clock으로 기록하며 ID나 identity로 쓰지 않는다.

## Review 결과 (runtime/reviews/, reviews/)

TASK-013. `reviewChanges(root, request, options)`의 결과는 `ReviewResult`(`duo.review/1`)이고, 실행 시간(`ReviewPerformance`)은 결과 밖에 따로 둔다. LLM이 꺼져 있으면 같은 Project Truth, Graph, Git 상태, diff, 요청에 대해 결과가 byte 단위로 같다. Review 실행은 아무것도 쓰지 않는다. `runtime/reviews/`(모든 실행)는 호출자(TASK-015, 016)가 쓰고, `reviews/`에는 Human이 명시적으로 `recordReview()`를 호출한 Review만 남는다([Review Record](#review-record-reviews), T13.1). Record는 원본을 복사하지 않고 Evidence Pointer만 담는다([ADR-006](adr/ADR-006-duo-layout-git-policy.md)).

```ts
ReviewRequest { task?, diff: { from, to, files? }, budget?, includeSemanticAssist?, testResults? }   // endpoint 기본값 없음(caller가 정함)
ReviewResult {
  format: "duo.review/1"; status: "ready" | "index-required"; freshness
  request: { identity, task, from, to, files?, budget?, testRun? }   // T13.1: 결정적 결과를 정하는 요청 입력과 그 sha256. includeSemanticAssist는 제외
  baseline: { status: "missing" | "present" | "incompatible", id? }  // T14.1 Adoption Baseline
  diff?: { identity, from, to, files: ChangedFile[] }          // identity: endpoint(HEAD는 commit), 경로별 kind·blob·hunk hash
  seeds: DiffSeed[]                                            // hunk-overlap | file-changed | truth-changed
  verdict?: "PASS" | "WARN" | "BLOCK" | "ASK"; verdictBasis: { blocking, ask, warn }
  claims: ReviewClaim[]; evidence: Evidence[]                  // claim은 evidenceIds로 evidence를 가리킴(중복 없음, ID 순)
  gaps?: KnowledgeGapAssessment; context?: { review?, task?, profile: "review", seeds }
  limitations; semanticAssist; metrics; diagnostics
}
ReviewClaim { id, rule, subject, expected, observed, alignment, evidenceIds(≥1), basis[], reason, enforced, blockEligible, drift, semanticCandidate, violationKey?, provenance? }   // T14.1: baseline 규칙(decision-forbids, declared-reference, external-source-drift)
```

- Claim ID는 `claim-` + hash(rule, subject, 구분 key, diff identity)이며 실행 시각이나 발견 순서를 쓰지 않는다.
- PASS는 "DUO가 현재 Evidence 범위에서 방향 위반을 찾지 못했다"는 뜻이지 버그가 없다는 뜻이 아니다.
- T13.1 규칙: `unlinked-addition`(R-SCOPE, task가 있을 때 task 맥락 밖이고 IMPLEMENTS가 없는 추가 application 파일 → UNKNOWN drift, 의미 후보, BLOCK 불가), `external-source-drift`(R-DRIFT, 명시적 `{path, hash, section?}`의 hash 불일치 → PARTIAL). limitation `external-source-unavailable`(원격·저장소 밖·secret·없는 파일), `external-source-hash-invalid`.
- `semanticAssist.provider`: 호출한 Provider의 `id`, 보고된 `model`, `cacheIdentity`(secret 없음).

### Review Record (reviews/)

T13.1. director `recordReview(result, { root, actor, clock? })`만 `reviews/`에 쓴다. CLI `--record`, Web UI 같은 Human 승인 화면이 같은 service를 쓰며 MCP·Agent는 쓸 수 없다(`REVIEW_RECORD_FORBIDDEN`). write kind `human-history`, `restrictTo: reviews/`, 경로의 symlink 거부, 새 파일은 exclusive create.

```ts
// .duo-project/reviews/review-<16 hex>.json
{ id, recorded: { by, at },                       // recorded는 identity 밖(injectable clock)
  format: "duo.review-record/1",
  review: { format, verdict, verdictBasis }, request,                    // ReviewResult.request
  diff: { identity, from, to, files: [{ path, oldPath?, kind, similarity?, binary, oldBlob?, newBlob?, hunks: [{ oldStart, oldLines, newStart, newLines, evidenceId }], evidenceIds }] },
  claims: [{ id, rule, subject, alignment, reason, evidenceIds, basis, enforced, blockEligible, drift, semanticCandidate }],
  evidence: [{ id, basis, kind, contentHash?, pointer, metadata? }],     // summary·본문 없음
  gaps: { requiresHumanInput, primary?, gaps: [{ id, source, kind, action, relevance, key?, location?, resolution? }] } | null,
  context: { review?, task?, profile, seeds } | null, limitations: string[] }
```

- ID는 `review-` + sha256(record body, `id`·`recorded` 제외)의 16 hex. 같은 결정적 Review를 다시 기록하면 같은 파일이므로 no-op(`unchanged`)이고, 같은 ID인데 내용이 다르거나 ID가 내용과 맞지 않으면 `REVIEW_RECORD_INTEGRITY`로 거부하며 덮어쓰지 않는다. `verifyReviewRecord(text)`로 검사한다.
- Claim 문장(expected, observed)과 Evidence summary는 저장하지 않는다(언어 중립, renderer는 TASK-015·018).
- 의미 보조가 성공했으면 별도 supplement `reviews/<review-id>.assist-<16 hex>.json`(`duo.review-assist/1`: provider, claims, llm evidence pointer, verdict, skippedChecks)을 쓴다. 결정적 record는 LLM 사용 여부와 상관없이 같은 ID다.
- index-required Review는 기록하지 않는다(`REVIEW_NOT_RECORDABLE`).

## Init (TASK-014)

director `planInit(root, options?)`는 읽기 전용으로 `InitPlan`(`duo.init-plan/1`)을 만들고, `applyInitPlan(root, plan, answers, { repair?, fs? })`가 계획된 파일만 쓴다. Indexing은 하지 않고 `indexRequired: true`를 돌려준다. LLM 호출 0회.

| 상태 | 조건 | apply |
|---|---|---|
| not-initialized | `.duo-project` 없음, 또는 Truth·history 파일이 없음 | 가능 |
| initialized | `project.yaml`을 이 build가 읽음 | 거부 `INIT_ALREADY_INITIALIZED`(아무것도 바꾸지 않음) |
| partial | `project.yaml` 없이 파일이 있음 | `repair: true`일 때만 없는 파일 생성, 기존 파일 유지 |
| incompatible | `project.yaml`을 읽을 수 없음(schema version, 문법, schema) | 거부 `INIT_INCOMPATIBLE` |

- Git 필수: Git이 아니면 `GIT_REPOSITORY_REQUIRED`, work tree의 하위 디렉터리면 `SCAN_ROOT_INVALID`(nested Truth Layer 금지).
- `observed`(`provenance: observed`): 이름(package.json name 또는 디렉터리), Git branch·HEAD, 파일 수와 제외 사유별 수, 언어(확장자), manifest, package, workspace, packageManager, script 이름과 실행 방법(명령 원문은 복사하지 않음), 기술 metadata(engines 등, Constraint가 아님), source·test root.
- `documents`: Scanner 목록에서 경로만으로 순위를 매긴 후보(root README 100, CONTRIBUTING·ARCHITECTURE 80, 그 밖의 root 문서와 docs/ 60(docs/는 깊이마다 -5), 하위 README 40, architecture·design·spec·requirements·adr·기획·설계 같은 keyword +20(한글 keyword는 token 안에서도 일치, 예: 기획서), 기본 상한 20개, 256 KiB). 비밀 파일은 Scanner가 이미 제외한다. `importCandidates`: 후보 문서의 DUO metadata block 정의(쓰지 않음).
- `questions`: `project_goal`(required, 제안값: README 첫 문단 또는 package.json description), `current_milestone`, `critical_constraints`. `InitAnswer`로 답한다. 제안값은 Human이 `acceptSuggestion`으로 받아들일 때만 confirmed이고, README 제안은 `source: {path, hash}`를 남긴다.
- 생성: `project.yaml`(schema_version, name, current_milestone), `.gitignore`, `intent/vision.md`(goal이 있으면 confirmed, 없으면 draft), `intent/constraints.yaml`(Human이 준 것만 confirmed, enforcement warn), 답이 있을 때 `milestones/<M#>.yaml`(ID는 plan이 배정). 답하지 않은 질문은 vision.md의 `UNKNOWN(<id>): …` 줄(Declared Gap). 빈 디렉터리(specs, decisions/proposals, milestones, integrations, reviews, generated, cache, runtime)는 로컬에만 만들고 `.gitkeep`은 두지 않는다. `generated/gaps.json`은 없다(C94).
- apply: plan digest와 알려진 경로 검사(`INIT_PLAN_INVALID`) → basis(regenerable 영역을 뺀 `.duo-project` 내용 digest) 비교(`INIT_PLAN_STALE`) → 답 검사(`INIT_ANSWER_INVALID`) → 모든 경로 `guardWrite` → `runtime/init-*`에 staging → core loader로 검증(`INIT_VALIDATION_FAILED`) → 파일 배치(exclusive, project.yaml 마지막) → staging 삭제. 실패하면 만든 파일과 디렉터리를 모두 지운다(`INIT_APPLY_FAILED`).

### Evidence

core `Evidence { id, basis, kind, entity?, source?, contentHash?, summary?, pointer, metadata? }`(C44). `basis`는 `project-truth`, `repository`, `git`, `test`, `llm`이다. ID는 `ev-` + hash(basis, kind, key)이고 key는 내용 기반이다: Truth는 정의 ID + 정확한 slice hash, repository는 Node ID + slice hash, Git hunk는 경로 + 이전 경로 + hunk 줄 hash, test는 command + test + 상태. 줄 번호만으로 identity를 만들지 않는다.

| basis | 내용 | pointer |
|---|---|---|
| project-truth | Requirement·Decision·Constraint의 정확한 정의 slice(T09.1). diff 이전 쪽 정의는 `metadata.side` | kind, id, path, lines, content_hash |
| repository | 변경 후 Symbol·Test slice, File(내용은 참조만) | kind, path, symbol, lines, commit, content_hash |
| git | hunk 하나(전체 diff 문자열이 아님), 또는 hunk 없는 변경 기록(삭제, binary, rename: oldPath, similarity, old/new blob) | kind diff, path, lines, change, commit |
| test | 호출자가 준 테스트 실행 결과. Test Node의 존재와 실행 성공은 다른 사실이다 | kind test, path, symbol(test 이름) |
| llm | Provider 답변(`semanticAssist.evidence`에만) | kind llm |

EvidencePointer 필드: `kind`(requirement, decision, constraint, issue, milestone, file, symbol, test, commit, diff, document, review, llm), `id`, `path`, `symbol`, `lines`, `commit`, `content_hash`, `change`.

## Adoption Baseline (T14.1)

기존 저장소에 DUO를 중간 설치할 때 "DUO가 이 프로젝트를 관리하기 시작한 시점의 저장소 상태"를 남기는 provenance다. 기존 코드가 옳다거나 Human Intent와 맞다거나 기술 부채를 승인한다는 뜻이 아니다. 목적은 DUO 이전부터 있던 것과 이후에 생긴 것을 가르는 것이다.

- **시점**: init apply → Truth → 첫 Index → index current 확인 → `captureAdoptionBaseline(root, { graph, actor, policy?, clock? })`(director, 별도 Domain Service). `applyInitPlan()`과 읽기 호출은 baseline을 만들지 않는다. CLI `duoctl init`이 순서대로 orchestrate한다([07](07-cli-interface.md#duoctl-init)).
- **저장**: `.duo-project/reviews/adoption-<16 hex>.json`, format `duo.adoption-baseline/1`, human-history(tracked), Review Record와 같은 content-addressed writer(`writeHistoryRecord`: exclusive create, 같으면 `unchanged`, 다르면 integrity error). ID는 body(`id`·`recorded` 제외)의 sha256이며 `recorded: {by, at}`(injectable clock)는 identity 밖이다. 같은 저장소·Truth·Index 상태의 재캡처는 같은 ID(no-op)이고, 다른 baseline이 이미 있으면 `ADOPTION_BASELINE_EXISTS`로 거부한다(나중 캡처가 새 위반을 pre-existing으로 바꾸지 못하게).
- **내용**: `project {name, rootCommits}`, `git {headOid, branch?, detached}`, `truth {digest}`(truthDigest), `index {graphSchemaVersion, stateToken}`, `workingTree {dirty, policy: HEAD_BASELINE, staged[{path, indexBlob?}], unstaged[{path, contentHash?}], untracked[{path, contentHash?}], conflicted, counts, excludedSecrets, truncated}`(경로와 hash만, 내용·diff 없음, 목록 1,000개 상한), `findings[]`, `limitations[]`.
- **거부**: actor가 human이 아님(`ADOPTION_FORBIDDEN`), index가 current가 아님(`ADOPTION_INDEX_REQUIRED`), commit 없음(`ADOPTION_HEAD_REQUIRED`), dirty인데 정책 없음(`ADOPTION_DIRTY_POLICY_REQUIRED`).
- **Dirty policy**: `HEAD_BASELINE`(baseline commit = HEAD, staged·unstaged·untracked 변경은 adoption 이후 Review 대상으로 남음), `ABORT_AND_CLEAN`(아무것도 쓰지 않고 `aborted`). dirty working tree 전체를 snapshot으로 삼는 정책(`ADOPT_CURRENT_DIRTY`)은 MVP에 없다. working tree 관찰(`observeWorkingTree`)은 `.duo-project/`와 secret 파일(개수만)을 뺀다. `InitPlan.observed.workingTree`에도 같은 값(`workingTreeDirty`, 목록 50개 상한)이 있다.
- **Findings**(결정적, LLM 없음, task가 필요한 R-SCOPE 제외): 활성 Decision의 `forbids` 일치(File, Symbol, package.json dependency), `DECLARED_SYMBOL_UNRESOLVED`, 로컬 External Source drift. dirty 경로의 finding은 baseline에 넣지 않는다(`dirty-paths-not-baselined`).
- **Violation key**: `vk-` + 16 hex of sha256(rule, governing Truth entity, offending). offending은 node ID, `dep:<manifest>#<name>`, `ref:<field>:<name>`, `src:<path>#<section>`. 줄 번호·diff·시각을 넣지 않는다. Review의 baseline 규칙 claim은 `violationKey`를 가진다.
- **Provenance**(Review): baseline에 key가 없으면 `introduced`(기존 BLOCK 정책), 있고 이번 diff가 위반 entity를 직접 바꿨으면 `pre-existing-touched`(blockEligible 아님, WARN), 있고 바꾸지 않았으면 `pre-existing`(historical, BLOCK·WARN 없음). 기존 forbidden Symbol의 내부가 바뀌었다고 "위반이 커졌다"고 추측하지 않는다. baseline이 없거나(`missing`) 읽을 수 없으면(`incompatible`, limitation `adoption-baseline-unusable`) provenance를 붙이지 않는다. `ReviewResult.baseline = { status: missing|present|incompatible, id? }`.
- **Read model**: `getAdoptionBaselineStatus(root)` → `missing`(T14.1 이전 project 포함, 자동 캡처하지 않음), `current`(HEAD = baseline commit), `advanced`(baseline commit이 HEAD history에 있음), `repository-diverged`(history에 없거나 root commit이 다름), `incompatible`(손상, 변조, 여러 개). `loadAdoptionBaseline(root)`는 Git 없이 파일만 검증한다. 둘 다 쓰기 0이며 repair·재캡처를 하지 않는다.

## generated/, runtime/

| 파일 | 내용 | Task |
|---|---|---|
| `generated/graph.db` | Project Graph(ADR-002, [04](04-project-graph.md)) | TASK-003, 007 |
| `generated/index-state.json` | 증분 인덱싱 state([증분 인덱싱](#증분-인덱싱)) | TASK-008 |
| `generated/inferred.json` | (예약) 구현 상태 추론. T14 Init은 만들지 않는다(C123) | - |
| `cache/analysis/*.json` | SourceAnalysis cache(content-addressed) | TASK-008 |
| `cache/packets/<digest>.json` | Context Packet cache. key는 Packet Dependency Digest([05](05-context-compiler.md#packet-dependency-digest와-cache)) | TASK-010 |
| `cache/llm/<key>.json` | 검증된 성공 LLM 답변. key = hash(provider cacheIdentity, purpose, instructions, input, output spec, maxOutputTokens). identity가 없으면 쓰지 않음(C113) | TASK-013 |
| `cache/token-counts.json` | 파일 content hash → o200k_base token 수와 code point 수. tokenizer identity가 다르면 버림 | TASK-010 |
| `runtime/metrics.jsonl` | CLI(와 이후 MCP)가 명령마다 덧붙이는 `duo.metric/1` 한 줄: command, status, exitCode, durationMs, at과 해당 필드(indexMode, contextTokens, reviewVerdict, llmCalls 등). secret·본문·task 원문 없음. director `appendRuntimeMetric`·`readRuntimeMetrics`([07](07-cli-interface.md#runtimemetricsjsonl), C83) | TASK-015 |

Graph DB 스키마와 transaction·제약·index 정책은 [ADR-002](adr/ADR-002-graph-storage.md#sqlite-스키마)에 있다.
