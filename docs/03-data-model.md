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
├─ generated/                Regenerable · ignored · graph.db, fingerprints.json, gaps.json, inferred.json, index.json
├─ cache/                    Regenerable · ignored · tokenizer, Packet, llm/
└─ runtime/                  Runtime · ignored · reviews/(매 실행), metrics.jsonl, backup/
```

Git 정책은 "Truth / Human Decision → tracked, Derived / Runtime → ignored" 한 가지다([ADR-006](adr/ADR-006-duo-layout-git-policy.md)). 지시문 D§2의 `state/`, `evidence/`는 쓰지 않는다([conflicts.md C19](conflicts.md)).

## Write Boundary

DUO가 어디에 쓸 수 있는지는 core의 순수 정책 함수 `checkWriteBoundary(repositoryRoot, targetPath, writeKind, options?)`가 정한다(AC-002-04, REQ-SAFETY-001). 이 함수는 쓰지 않고 판정만 한다. 실제 파일 writer는 반드시 이 함수를 먼저 호출하고, symlink를 풀어(realpath) 다시 확인해야 한다.

| writeKind | 허용 영역(`.duo-project/` 기준) |
|---|---|
| `project-truth` | `project.yaml`, `intent/`, `specs/`, `decisions/`, `milestones/`, `integrations/` |
| `human-history` | `reviews/` |
| `regenerable` | `generated/`, `cache/`, `runtime/` |

- Repository 밖 경로는 항상 `WRITE_OUTSIDE_REPOSITORY`로 거부한다(`..` 경로, 다른 저장소의 절대경로 포함).
- `.duo-project/` 밖(프로젝트 Source Code), 영역에 없는 경로(`.duo-project/unknown.txt`), 영역과 writeKind가 다른 쓰기는 `WRITE_NOT_ALLOWED`다.
- `options.restrictTo`로 호출 주체별 허용 경로를 더 좁힐 수 있다. 예: Agent는 `.duo-project/decisions/proposals/`만. 기본 영역을 넓힐 수는 없다.
- `duoctl install`이 설정하는 Agent 파일(AGENTS.md 등)은 TASK-017에서 별도 writeKind로 추가한다.

## 소유권

| 경로 | DUO | Agent | Human |
|---|---|---|---|
| project.yaml, intent/, specs/, milestones/, integrations/ | init 시 초안 생성만 | 금지 | 수정 |
| decisions/D-*.yaml | DecisionService의 confirm/reject/supersede(Human 명령으로 실행) | 금지 | 명령 또는 수동 수정(fallback) |
| decisions/proposals/ | 새 파일 생성 | `duo_propose_decision`으로만 | 수정 가능 |
| reviews/ | `duoctl review --record` | 금지 | 삭제 가능 |
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

`UNKNOWN:` 줄(Knowledge Gap)은 아직 해석하지 않는다. 본문 텍스트로만 보존하며 TASK-011에서 다룬다([conflicts.md C28](conflicts.md)).

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
- **제외**(`ExclusionReason`): `.duo-project/generated|cache|runtime/`(duo-regenerable), 비밀 파일 패턴(secret, include보다 우선하고 대소문자 무시), `index.exclude`, `index.include` 불일치, symlink, working tree에 없는 tracked 파일(missing), submodule과 중첩 저장소, 일반 파일이 아닌 항목과 RepoPath로 표현할 수 없는 이름(unsupported-entry). tracked 파일은 .gitignore 패턴에 맞아도 포함한다.
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
| Indexer (TASK-008) | 저장된 fingerprint와 현재 fingerprint를 비교해 바뀐 파일만 다시 분석한다 |
| Freshness (TASK-008, 표시는 TASK-015/016) | Node마다 fresh / changed / deleted / unknown을 정한다. 인덱싱하지 못한 경우는 unknown |

WAL에서 다른 연결이 쓰는 동안 마지막 commit 상태를 읽는 것은 snapshot visibility이며 freshness 판정과 다르다(C31).


## Source analysis

¦LanguageAnalyzer¦의 결과 계약이다(TASK-005, [ADR-003](adr/ADR-003-language-analysis.md), 형식은 [04 SourceAnalysis](04-project-graph.md#sourceanalysis)). Graph를 만들지 않고 syntax 사실만 낸다.

- **대상**: 지원 확장자만 parse한다(.ts .mts .cts → TypeScript, .tsx → TSX, .js .mjs .cjs .jsx → JavaScript grammar). Scanner는 ¦.duo-project/¦의 Truth 파일도 찾지만 Markdown/YAML은 LanguageAnalyzer가 ¦supports() == false¦이며 parse하지 않는다. Project Truth parsing은 core가 맡는다.
- **입력과 hash**: 입력은 파일 bytes다. fingerprint와 같은 canonical bytes(normalized-text)를 UTF-8로 decode해 parse하므로 ¦SourceAnalysis.contentHash¦는 ¦FileFingerprint.contentHash¦와 같다. UTF-8이 아니면 ¦SOURCE_DECODE_ERROR¦. BOM은 그대로 두고 칸 수에 포함한다.
- **Symbol identity**: core ¦symbolRef(path, qualifiedName)¦와 ¦nodeId()¦만 쓴다. 위치나 byte offset은 ID에 넣지 않는다.
- **정렬**: 모든 목록은 ¦compareSourceLocations¦ 순서, 같으면 qualifiedName / specifier, kind / calleeText / ids(¦compareUtf8¦) 순서다. AST 순회 순서에 기대지 않는다.
- **partial**: 트리에 ERROR나 MISSING 노드가 있으면 ¦parseStatus: "partial"¦과 ¦AST_PARSE_ERROR¦(warning, 파일당 20개 + 요약 1개). ERROR 노드 안은 읽지 않고 나머지는 계속 추출한다. parse가 파일당 제한 시간(기본 2초)을 넘으면 ¦AST_PARSE_TIMEOUT¦이고 결과가 없다.

## SourceLocation

```ts
type SourceLocation = { path: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number };
```

- `path`는 RepoPath, 줄과 칸은 1부터 센다. `endColumn`은 exclusive(마지막 문자 다음 칸)다.
- Markdown 정의와 YAML 정의가 같은 계약을 쓴다. Markdown 정의는 Heading부터 섹션 끝까지, YAML 파일 전체가 정의인 경우(Decision, Milestone)는 문서 내용의 범위, 목록 항목(Constraint)은 그 항목의 범위다.
- 범위 끝을 알 수 없는 예외(파일 누락 등)에서만 end 필드를 생략한다.
- Evidence Pointer와 diagnostic이 이 위치를 그대로 쓴다.
- **단위**: 줄은 LF로 센다. 칸은 UTF-16 code unit(JS 문자열 index + 1)이다. YAML(`LineCounter`), Markdown, Tree-sitter(web-tree-sitter는 JS 문자열을 UTF-16으로 넘긴다) 모두 같은 단위이며 UTF-8 byte나 code point가 아니다. 예: `/* 😀😀 */ 표시()`의 `표시`는 12번째 칸이다(UTF-8 byte로는 16, code point로는 10). LF 앞의 CR은 그 줄 끝에 속하므로 LF와 CRLF checkout에서 같은 위치가 같은 텍스트를 가리킨다.
- core `sliceSourceLocation(text, location)`이 위치의 원문을 돌려주고(Evidence 재탐색), `compareSourceLocations`가 path(UTF-8), 시작, 끝 순으로 정렬한다.

## Diagnostics

```ts
type Diagnostic = { code: DiagnosticCode; severity: "error" | "warning" | "info"; message: string; source?: SourceLocation };
type ParseResult<T> = { value?: T; diagnostics: readonly Diagnostic[] };
```

Parser와 loader는 예외를 던지지 않고 모든 문제를 모은다. 일부 파일이 실패해도 읽을 수 있는 Project Truth는 value로 돌려준다. 코드와 기본 심각도는 `DIAGNOSTIC_SEVERITY`에 있다.

| 영역 | 코드 |
|---|---|
| 파일, 버전 | `FILE_READ_ERROR`, `PROJECT_FILE_MISSING`, `UNSUPPORTED_SCHEMA_VERSION` |
| 원문 파싱 | `MARKDOWN_PARSE_ERROR`, `YAML_SYNTAX_ERROR`, `YAML_WARNING`, `YAML_ALIAS_NOT_ALLOWED`, `YAML_TAG_NOT_ALLOWED` |
| 스키마 | `SCHEMA_UNKNOWN_PROPERTY`, `SCHEMA_MISSING_PROPERTY`, `SCHEMA_INVALID_VALUE`, `INVALID_ID` |
| 경로, 쓰기 | `INVALID_PATH`, `PATH_OUTSIDE_REPOSITORY`, `PATH_PORTABILITY_COLLISION`(warning), `WRITE_OUTSIDE_REPOSITORY`, `WRITE_NOT_ALLOWED` |
| 정의 구조 | `METADATA_BLOCK_WITHOUT_HEADING`, `METADATA_BLOCK_MISSING`(warning) |
| 추적성 | `DUPLICATE_ID`, `BROKEN_REFERENCE`, `REFERENCE_TYPE_MISMATCH`, `DECISION_SUPERSEDES_SELF`, `DECISION_SUPERSEDE_CYCLE`, `TRACE_MILESTONE_MISMATCH`(warning), `TRACE_DECISION_UNRELATED`(warning), `TRACE_REQUIREMENT_UNTRACKED`(info) |
| Graph DB | `GRAPH_SCHEMA_UNSUPPORTED`, `GRAPH_OPEN_FAILED` |

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
  max_calls_per_review: 3
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
supersedes: D-004          # SUPERSEDES: D-015 → D-004
superseded_by: null
evidence:
  - {kind: review, id: R-20260927-153012-91aca1}
confirmed_at: "2026-09-27T15:40:00+09:00"
confirmed_by: kanghyunsoon
lock:
  digest: "sha256:3f1c..."
```

ADR 형식 Markdown Decision은 같은 필드를 frontmatter에 두고 `type: decision`을 붙인다.

## decisions/proposals/P-*.yaml

Decision과 같은 내용 필드에 `proposed_by`(agent 이름 또는 `duoctl`), `proposed_at`, `evidence`를 더한다. `state`는 `proposed`로 시작한다. reject되면 `state: rejected`, `rejected_at`, `rejected_by`, `reason`이 기록되고 파일은 남는다. confirm되면 파일은 `decisions/D-###.yaml`로 옮겨진다([ADR-013](adr/ADR-013-decision-lifecycle.md)). Proposal의 `supersedes`는 SUPERSEDES 링크를 만들지 않고 존재만 확인한다.

## Review 결과 (runtime/reviews/, reviews/)

두 위치의 스키마는 같다. `runtime/reviews/`에는 모든 실행 결과가, `reviews/`에는 Human이 `duoctl review --record`로 보존한 Review만 저장된다([ADR-006](adr/ADR-006-duo-layout-git-policy.md)). Record는 원본을 복사하지 않고 Evidence Pointer만 담는다.

```json
{
  "id": "R-20260927-153012-91aca1",
  "base": "HEAD", "base_sha": "72d066d", "head": "WORKTREE",
  "verdict": "BLOCK",
  "claims": [{
    "id": "C1", "rule": "R-CONSTRAINT",
    "claim": "OAuth implementation is outside the current MVP.",
    "alignment": "CONFLICT", "blocking": true, "ask": false, "basis": "static",
    "evidence": [
      {"kind": "constraint", "id": "CON-001"},
      {"kind": "symbol", "path": "src/auth/GoogleOAuthService.ts", "symbol": "GoogleOAuthService", "lines": [1, 42], "commit": "WORKTREE", "content_hash": "sha256:7d9e…"},
      {"kind": "diff", "path": "src/auth/GoogleOAuthService.ts", "change": "added"}
    ]
  }],
  "skipped_checks": [{"rule": "R-INTENT", "reason": "llm_unavailable"}],
  "metrics": {"changed_files": 2, "changed_symbols": 3, "llm_calls": 0}
}
```

EvidencePointer 필드: `kind`(requirement, decision, constraint, issue, milestone, file, symbol, test, commit, diff, document, review, llm), `id`, `path`, `symbol`, `lines`, `commit`, `content_hash`, `change`.

## generated/, runtime/

| 파일 | 내용 | Task |
|---|---|---|
| `generated/graph.db` | Project Graph(ADR-002, [04](04-project-graph.md)) | TASK-003, 007 |
| `generated/gaps.json` | Knowledge Gap | TASK-011 |
| `generated/inferred.json`, `index.json` | 구현 상태 추론, 마지막 인덱싱 상태 | TASK-008, 014 |
| `runtime/metrics.jsonl` | Context, Review, LLM 지표([09](09-token-strategy.md#지표)) | TASK-010 |

Graph DB 스키마와 transaction·제약·index 정책은 [ADR-002](adr/ADR-002-graph-storage.md#sqlite-스키마)에 있다.
