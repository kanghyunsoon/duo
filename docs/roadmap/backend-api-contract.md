# Backend API 계약(로컬 UI 서버, T87, T94·T106 수정)

대상: `duoctl ui`가 띄우는 로컬 HTTP 서버(`packages/integration/src/http/server.ts`)와 FE(`packages/ui`). 표시 규칙:

- **IMPLEMENTED:** 공개 0.3.3에 있음
- **IMPLEMENTED(next):** `next`에 병합됐지만 아직 공개 릴리스에 없음(T106). 다음 릴리스에 들어갈 때 IMPLEMENTED로 바꾼다
- **PROPOSED:** 설계안이며 구현되지 않음. 대부분 [decision-rbac-design.md](decision-rbac-design.md)의 Human Decision을 기다린다

존재하지 않는 인증 서버나 엔드포인트를 구현된 것처럼 적지 않는다. OpenAPI 파일은 만들지 않았다. 서버가 하나의 프로세스 안에서 세션 쿠키와 CSRF로 동작하는 로컬 도구라, 별도 명세 파일이 실제 계약보다 앞서 나갈 위험이 더 크다. FE가 쓸 타입은 §7에 TypeScript로 둔다.

## 1. 공통 규칙(IMPLEMENTED)

| 항목 | 규칙 |
|---|---|
| 주소 | `127.0.0.1`의 임의 포트. Host 헤더는 `127.0.0.1:<port>` 또는 `localhost:<port>`만 |
| 세션 | launch URL의 `?session=`이 HttpOnly·SameSite=Strict 쿠키(`duo_ui_<port>`)가 됨. 모든 `/api/*`에 필요 |
| 변경 요청 | POST만. 같은 origin의 `Origin`, `Content-Type: application/json`, `X-DUO-CSRF`(`GET /api/session`에서 받은 값) 필수. 본문 최대 64 KiB |
| 성공 envelope | `{ "format": "duo.ui.<name>/1", "ok": true, "data": ..., "meta": { "durationMs" } }` |
| 도메인 결과 | HTTP 200. 실패도 `data.status: "failed"`와 `diagnostics[{code,message}]`. 초기화 전이면 `data.status: "not-initialized"` |
| 전송·보안 오류 | 4xx/5xx와 `{ "format": "duo.ui.error/1", "ok": false, "error": { code, message } }` |
| 버전 | `UI_API_VERSION = "1"`. 필드 추가는 같은 `/1` 안에서 additive로만 한다. 이름이나 의미를 바꾸면 `/2` |
| 권한 | 세션을 가진 같은 컴퓨터의 사용자. Decision actor는 `ui:<Git user.name>`이며 인증이 아님(docs/10-security.md) |

## 2. 현재 API 인벤토리(IMPLEMENTED)

| Method | Path | Request | Response(data) | 오류 | 권한 | Side effect | 멱등성 | 동시성 |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/session` | 없음 | `{ csrf, version, apiVersion, root }` | 세션 오류 | 세션 | 없음 | 예 | 없음 |
| GET | `/api/overview` | 없음 | 프로젝트 개요 | 도메인 실패 | 세션 | 없음 | 예 | 읽기 전용 그래프 |
| GET | `/api/direction` | 없음 | Requirement·Decision·Constraint·Milestone·proposal 목록(권한 상태 포함) | 같음 | 세션 | 없음 | 예 | 없음 |
| GET | `/api/proposals` | 없음 | `{ proposals[], previews: { [P-id]: ConfirmPreview \| {error[]} } }`(pending만 preview) | 같음 | 세션 | 없음 | 예 | 없음 |
| GET | `/api/proposals/{P-id}/preview` → `duo.ui.preview/1`(API-05, **IMPLEMENTED(next)**, #54 `81b1b95`) | 없음 | `{ status: "ready", preview: ConfirmPreview, warnings[] }`, 초기화 전이면 `{ status: "not-initialized", message }`, 그 밖에는 `{ status: "failed", diagnostics[] }`. `preview`는 `/api/proposals`의 `previews` 항목과 같고 `preview.digest`를 confirm의 `previewDigest`로 보낸다. 진단 메시지의 이 컴퓨터 절대 경로는 `<repository>`로 바꾼다 | proposal ID 형식(`P-…`)이 아니면 400 `UI_REQUEST_INVALID`. 도메인: `PROPOSAL_NOT_FOUND`, `PROPOSAL_NOT_PENDING`, Truth 권한 오류(`requireCompleteTruth`) | 세션 | 없음(lock·쓰기·repair 없음) | 예 | 없음. preview 뒤 proposal·대체 대상·Truth가 바뀌면 digest가 달라져 confirm이 `DECISION_CONFIRM_PREVIEW_CHANGED`로 거부됨 |
| GET | `/api/decisions` → `duo.ui.decisions/1`(API-02, **IMPLEMENTED(next)**, #53 `a0d4c92`) | `state?`(proposed·confirmed·superseded·rejected), `q?`(ID·제목의 대소문자 무시 부분 일치, 1~200자). 그 밖의 query 이름은 400 | `{ decisions: DecisionSummary[], actorLabelsAuthenticated: false, truth: { complete, problems[] } }`. 항목은 ID 순: `id, title, state, authority`(CONFIRMED·SUPERSEDED·REJECTED·PROPOSED), `locked, lockStatus`(valid·missing·mismatch·not-confirmed), `origin`(lifecycle·manual·null), `supersedes, supersededBy`, 파일에 있을 때만 `proposalId, confirmedAt, confirmedBy`(label, 인증 아님), `integrity`(ok·invalid)와 `problems[]`, `location`. 초기화 전이면 `{ status: "not-initialized", message }` | 400 `UI_REQUEST_INVALID`. 손상된 Truth는 200 + `truth.complete: false`와 `problems`(`path`·`line`은 저장소 상대 경로) | 세션 | 없음(lock·쓰기 없음) | 예 | 없음 |
| GET | `/api/decisions/{id}` → `duo.ui.decision-detail/1`(API-03, **IMPLEMENTED(next)**, #53 `a0d4c92`) | 없음. 경로 ID는 `[A-Za-z][A-Za-z0-9._-]{0,127}`(D-###만이 아니라 Markdown의 ADR-### 등도 됨) | `{ status: "found", id, decision, actorLabelsAuthenticated: false, truth }`. `decision`은 목록 항목 + `question, answer, rationale, governs, forbids`, 파일에 있을 때 `proposedAt, proposedBy, proposedByKind`, `lock: { id, status, expected, recorded? }`, `chain`(오래된 것부터, 없는 ID는 `{ id, missing: true }`, 순환은 `{ id, loop: true }`, 방향마다 최대 64 link), `truncated: { older, newer }`. 없는 ID는 `{ status: "not-found", id, truth }` | 형식이 아니거나 인코딩이 깨진 ID, 128자 초과는 400 `UI_REQUEST_INVALID`. 404를 쓰지 않음 | 세션 | 없음 | 예 | 없음 |
| POST | `/api/proposals/{P-id}/confirm` | `{ confirmId, previewDigest }`(둘 다 필수) | `{ status: "confirmed", result: { decisionId, path, from, supersedes?, stale?, indexRequired: true, repaired[] }, warnings[] }` 또는 `{ status: "failed", diagnostics[] }` | 400 `UI_CONFIRM_ID_MISMATCH`, `UI_REQUEST_INVALID`. 도메인: `DECISION_CONFIRM_PREVIEW_CHANGED`, `PROPOSAL_NOT_PENDING`, `DECISION_LOCK_BUSY` 등 | 세션 + CSRF. actor `ui:<user.name>`(human 고정) | `D-###.yaml` 생성, 대체 대상 표시, proposal 삭제, metrics 한 줄 | 아니오. 두 번째 호출은 `PROPOSAL_NOT_PENDING(... confirmed as D-###)` | decisions.lock(5000 ms). 본 digest와 다르면 아무것도 쓰지 않음 |
| POST | `/api/proposals/{P-id}/reject` | `{ reason? }`(최대 2000자) | `{ status: "rejected", result }` 또는 failed | `PROPOSAL_NOT_PENDING`, `DECISION_LOCK_BUSY` | 위와 같음 | proposal 파일에 rejected 기록 | 아니오. 두 번째는 `PROPOSAL_NOT_PENDING` | 같은 lock |
| GET | `/api/reviews`, `/api/reviews/{review-id}` | 없음 | 기록된 Review 목록·한 건 | 같음 | 세션 | 없음 | 예 | 없음 |
| GET | `/api/entity/{id}` | 없음 | Truth 정의(원문 slice) 또는 그래프 노드와 직접 관계 | 같음 | 세션 | 없음 | 예 | 없음 |
| GET | `/api/graph` | `node`, `kind=trace\|impact`, `depth 1~3` | 그래프 조회 | `UI_REQUEST_INVALID` | 세션 | 없음 | 예 | 없음 |
| GET | `/api/search` | `q`, `limit 1~50` | 근거 검색 | 같음 | 세션 | 없음 | 예 | 없음 |
| GET | `/api/source` | `path`, `start`, `end`(최대 120줄) | 인덱스된 파일의 줄 | 403 `UI_SOURCE_FORBIDDEN`(비밀 파일), 404 `UI_SOURCE_NOT_INDEXED` | 세션 | 없음 | 예 | 없음 |
| POST | `/api/context` | `{ task, budget? }` | Context 결과 | 도메인 실패(`index-required` 등) | 세션 + CSRF | metrics 한 줄 | 예(결과 동일) | 읽기 |
| POST | `/api/review` | `{ task?, from?, to?, includeSemanticAssist? }` | Review 결과 | 같음 | 세션 + CSRF | metrics 한 줄 | 예 | 읽기 |

없는 것: 감사 이력, 현재 사용자·권한, proposal 생성·취소, D-### 제자리 confirm(CLI에만 있음). Decision 목록·상세(API-02·03, #53)와 단건 preview(API-05, #54)는 `next`에만 있고 공개 0.3.3에는 없다.

Decision 읽기 API의 규칙(API-02·03, `packages/integration/src/http/decisions.ts`, [08-ui-spec](../08-ui-spec.md)):

- **진단 귀속.** Decision별 `problems`에는 그 Decision의 error 진단만 들어간다. 메시지가 그 ID로 시작하는 진단(`D-001: …`), 또는 위치가 그 Decision의 원본 범위 안에 있는 진단이다. 같은 파일(예: Markdown)에 정의가 여럿이면, 진단 줄을 포함하는 가장 좁은 정의(Requirement·Decision·Constraint·Issue·Milestone 중)에 붙인다. 줄 정보가 없는 진단은 파일에 정의가 하나일 때만 붙인다. 같은 넓이의 범위가 겹쳐 정할 수 없으면 어느 Decision에도 붙이지 않는다. 붙지 않은 진단도 `truth.problems`에는 남는다.
- **대체 사슬 한도.** `chain`은 방향마다 64 link까지만 준다(`missing`·`loop` 표시도 1 link로 센다). `truncated.older`·`truncated.newer`는 그 방향에서 한도에 도달했는데, 마지막으로 반환된 Decision이 다음 link를 더 선언했을 때만 `true`다. 정확히 한도에서 끝나면 `false`다. 생략된 부분은 그 방향 끝 ID의 상세를 다시 요청해 이어 읽는다.
- **인증 아님.** `confirmedBy`·`proposedBy`는 파일에 적힌 label이다. `lockStatus: valid`는 confirm 절차를 거쳤다는 근거일 뿐 신원 증명이 아니다(ADR-013). 역할 검사는 없다(ADR-015 미승인).
- **요청 경계.** `/api/proposals/{id}/preview`와 같다. 세션과 허용 Host가 필요하고, Origin·CSRF는 GET에 요구하지 않으며, CORS 헤더를 주지 않는다. 이 경계를 고정하는 회귀 테스트는 PR #76(BE-API-10, 리뷰 중)에 있다.

## 3. Confirm 계약에서 반드시 지킬 것

- confirm은 `previewDigest`가 lock 안에서 다시 읽은 candidate의 digest와 같을 때만 쓴다(`DECISION_CONFIRM_PREVIEW_CHANGED`). 새 API도 이 바인딩을 우회하는 경로를 만들지 않는다.
- digest에는 proposal의 제안자 표시값, stale 여부, 대체 대상의 현재 내용이 들어간다. 대상이 바뀌면 다시 preview해야 한다.
- 결과의 `decisionId`가 권위 있는 값이다. preview의 `expectedDecisionId`는 예상일 뿐이다.
- 확정 직후 그래프는 낡는다(`indexRequired: true`). FE는 "index 필요"를 보여 준다.

## 4. 제안 API(PROPOSED)

| ID | Method·Path | Request | Response(data) | 오류 | 권한 | Side effect | 멱등성·동시성 | 의존 |
|---|---|---|---|---|---|---|---|---|
| API-01 | GET `/api/me` → `duo.ui.me/1` | 없음 | `{ mode: "local"\|"team", actor: { kind: "human", label, source: "git-user-name", authenticated: false }, git: { name, email? }, roles[], capabilities: { confirm, reject, withdraw }, agentEnvironment: { detected, markers[] }, trust: TrustStatus }`. 각 capability는 `{ allowed, reason?, enforcement: "local-ux" \| "merge-review" }`. `trust`는 §7의 `TrustStatus`(T94) | 세션 오류 | 세션 | 없음 | 예. `trust`는 호출 때마다 다시 확인하고, 못 하면 `UNVERIFIED` | Local 부분은 BE-GOV-06, Team 부분과 `trust`는 H-88 |
| API-02 | GET `/api/decisions` | — | **IMPLEMENTED(next)**, §2로 옮김. 설계안보다 `integrity`·`problems`(Decision별), `truth`, `actorLabelsAuthenticated`가 더 있고, `origin`은 미확정이면 null이다 | — | — | — | — | #53 `a0d4c92` |
| API-03 | GET `/api/decisions/{id}` | — | **IMPLEMENTED(next)**, §2로 옮김. 응답은 `{ status, id, decision, … }`로 감싼다. `chain` 항목에는 `authority`와 `missing`·`loop` 표시가 있고, `truncated: { older, newer }`가 더 있다. 경로 ID는 D-###에 한정하지 않는다 | — | — | — | — | #53 `a0d4c92` |
| API-04 | GET `/api/decisions/{D-id}/history` → `duo.ui.decision-history/1` | 없음 | `DecisionHistoryData`(§7): 이벤트와 파일에서 추론한 항목(`derived: true`), 체인 상태, Team Mode 시작 시점. 표시 규칙은 §9 | 같음 | 세션 | 없음 | 예 | BE-AUD-01·05(H-88) |
| API-05 | GET `/api/proposals/{P-id}/preview` | — | **IMPLEMENTED(next)**, §2로 옮김. 응답은 `ConfirmPreview`를 그대로 주지 않고 `{ status, preview, warnings }`로 감싼다 | — | — | — | — | #54 `81b1b95` |
| API-06 | POST `/api/proposals/{P-id}/confirm`에 `reason?` 추가 | `{ confirmId, previewDigest, reason? }`(최대 2000자) | 지금과 같음 + `eventId?` | 지금과 같음 + Team Mode `DECISION_ROLE_FORBIDDEN`, `DECISION_AGENT_ENVIRONMENT` | 세션 + CSRF + (Team) 승인자 | 이벤트 1건 추가 | digest 바인딩 유지. 같은 요청 재시도는 `PROPOSAL_NOT_PENDING`이고 이벤트를 더 만들지 않음 | BE-AUD-02, H-88 |
| API-07 | POST `/api/proposals/{P-id}/withdraw` | `{ reason? }` | `{ status: "withdrawn", result }` | `PROPOSAL_NOT_PENDING`, `PROPOSAL_WITHDRAW_FORBIDDEN` | 세션 + CSRF, 제안자 또는 ADMIN(로컬 UX) | proposal 파일에 withdrawn 기록(스키마 확장 필요) + 이벤트 | 두 번째는 `PROPOSAL_NOT_PENDING` | 스키마 변경이라 H-88 |
| API-08 | POST `/api/proposals`(사람의 proposal 생성) | `ProposalInput` | `duo.proposal/1` | `PROPOSAL_INVALID` | 세션 + CSRF, actor human | proposal 생성 | 멱등 아님(호출마다 새 P) | ADR-009(UI 쓰기는 confirm·reject뿐) 변경이 필요해 1단계 범위에서 제외 권장 |

Supersede 전용 엔드포인트는 만들지 않는다. `supersedes`가 있는 proposal의 confirm이 곧 supersede이고, preview의 `supersedes` 항목이 대상을 보여 준다.

## 5. 오류 코드

IMPLEMENTED(전송·보안, HTTP 상태와 함께):

| code | HTTP | 뜻 |
|---|---|---|
| `UI_HOST_REJECTED` | 403 | Host가 이 서버가 아님(DNS rebinding 방지) |
| `UI_SESSION_REQUIRED` / `UI_SESSION_REJECTED` | 401 / 403 | 세션 쿠키 없음 / launch URL의 세션이 틀림 |
| `UI_ORIGIN_REJECTED`, `UI_CSRF_REJECTED` | 403 | 다른 origin, CSRF 토큰 없음·틀림 |
| `UI_CONTENT_TYPE` | 415 | JSON이 아님 |
| `UI_METHOD_NOT_ALLOWED` | 405 | 메서드 불일치 |
| `UI_REQUEST_INVALID`, `UI_REQUEST_TOO_LARGE` | 400, 413 | 입력 검증 실패, 64 KiB 초과 |
| `UI_CONFIRM_ID_MISMATCH` | 400 | 확정할 ID를 다시 입력하지 않음(실수 방지) |
| `UI_NOT_FOUND`, `UI_SOURCE_*` | 404, 403 | 경로 없음, 원문 열람 제한 |
| `UI_INTERNAL_ERROR` | 500 | 서버 내부 오류(콘솔에만 상세) |

IMPLEMENTED(도메인, HTTP 200 + `data.status: "failed"`): `DECISION_CONFIRM_PREVIEW_CHANGED`, `DECISION_LOCK_BUSY`, `DECISION_LOCKED`, `DECISION_ACTOR_FORBIDDEN`, `PROPOSAL_NOT_FOUND`, `PROPOSAL_NOT_PENDING`, `PROPOSAL_INVALID`, `DECISION_SUPERSEDE_TARGET_INVALID`, `DECISION_TARGET_UNSUPPORTED`, `BROKEN_REFERENCE`, `INVALID_ID`, Truth 권한 오류(`DECISION_INTEGRITY_INVALID` 등, `requireCompleteTruth`).

PROPOSED(도메인, 같은 방식): `DECISION_ROLE_FORBIDDEN`(Team Mode, 범위 밖 승인자), `DECISION_AGENT_ENVIRONMENT`(agent 실행 환경 감지, 실수 방지), `DECISION_TEAM_LOCK_REQUIRED`(Team Mode, lock 없는 Decision), `DECISION_EVENT_MISSING`(Team Mode, 확정 이벤트 없음), `PROPOSAL_WITHDRAW_FORBIDDEN`.

권한 부족을 HTTP 403으로 바꾸지 않는다. 기존 FE와 CLI·MCP가 같은 진단 코드를 공유하고, 도메인 판단은 200 + failed라는 현재 계약을 유지한다.

## 6. 동시성·복구 시나리오

| 상황 | 현재 동작(IMPLEMENTED) | 새 API에서 지킬 것 |
|---|---|---|
| 두 사람이 같은 proposal을 동시에 확정 | decisions.lock으로 직렬화. 먼저 끝난 쪽이 D-###를 만들고, 나중 쪽은 lock 안에서 다시 읽어 `PROPOSAL_NOT_PENDING(... confirmed as D-###)` | 이벤트는 성공한 쪽만 1건. 실패 쪽은 실패 이벤트(선택)로 남김 |
| 같은 요청 재전송(네트워크 재시도) | 위와 같음 | 중복 이벤트 없음(요청 ID 또는 proposal 상태로 판단) |
| 두 proposal이 같은 Decision을 supersede | 첫 확정 뒤 대상이 superseded가 되어 두 번째는 `DECISION_SUPERSEDE_TARGET_INVALID`. 세션 계획은 미리 거부(`DECISION_SESSION_CONFLICT`) | 같음 |
| 오래된 proposal(Truth가 바뀜) | `PROPOSAL_STALE` warning과 `stale` 정보. digest가 바뀌므로 다시 preview 필요 | Team Mode에서 stale 확정을 막을지는 H-88 이후 결정 |
| preview 뒤 내용 변경 | `DECISION_CONFIRM_PREVIEW_CHANGED`, 쓰기 없음 | 유지 |
| lock을 오래 잡은 다른 프로세스 | 5000 ms 뒤 `DECISION_LOCK_BUSY`. 같은 host의 죽은 pid lock은 깨뜨림 | 유지. 다른 host(공유 드라이브)의 lock은 깨뜨리지 않음 |
| commit 지점 뒤 실패(대체 표시·proposal 삭제) | 성공 + warning, 다음 쓰기 조작이 repair | repair도 이벤트로 기록(BE-DATA-02) |
| 권한이 없는 사용자 | Local: kind만 검사. Team: PROPOSED `DECISION_ROLE_FORBIDDEN` | 실수 방지라고 명시하고, 강제는 병합 리뷰 |

## 7. FE용 타입(PROPOSED, mock 작업용)

T94에서 감사 이벤트 설계(rbac 설계 §14)와 신뢰 상태(§12)에 맞춰 고쳤다. 모두 PROPOSED이며 구현되지 않았다.

```ts
export type Enforcement = "local-ux" | "merge-review";
export interface Capability { readonly allowed: boolean; readonly reason?: string; readonly enforcement: Enforcement }
export type TrustState = "LOCAL" | "VERIFIED" | "NOT_MET" | "UNVERIFIED";
export interface TrustStatus {
  readonly state: TrustState;
  readonly host: "github" | "unsupported" | "unknown";
  readonly checkedAt?: string;
  /** Conditions that are missing (NOT_MET) or could not be read (UNVERIFIED). */
  readonly reasons: readonly string[];
  /** DUO never verifies that agents lack approval credentials; always false. */
  readonly credentialSeparationVerified: false;
}
export interface MeData {
  readonly mode: "local" | "team";
  readonly actor: { readonly kind: "human"; readonly label: string; readonly source: "git-user-name"; readonly authenticated: false };
  readonly git: { readonly name: string | null };
  readonly roles: readonly ("ADMIN" | "APPROVER" | "DEVELOPER" | "AI_AGENT" | "READ_ONLY")[];
  readonly capabilities: { readonly confirm: Capability; readonly reject: Capability; readonly withdraw: Capability };
  readonly agentEnvironment: { readonly detected: boolean; readonly markers: readonly string[] };
  readonly trust: TrustStatus;
}
export type DecisionEventOp =
  | "propose" | "confirm" | "reject" | "withdraw" | "supersede-mark" | "repair"
  | "confirm-failed" | "confirm-interrupted" | "adopt";
export interface DecisionEvent {
  readonly format: "duo.decision-event/1";
  readonly eventId: string;
  readonly at: string;
  readonly op: DecisionEventOp;
  readonly subject: { readonly decisionId?: string; readonly proposalId?: string; readonly supersedes?: string };
  readonly actor: { readonly kind: "human" | "agent" | "system"; readonly label: string; readonly surface: "cli" | "ui" | "mcp" | "session" | "repair" };
  readonly reviewedDigest?: string;
  readonly lockDigest?: string;
  readonly basedOn: string | null;
  readonly prevHash: string | null;
  readonly requestId?: string;
  readonly reason?: string;
  readonly diagnostics?: readonly string[];
}
export interface TimelineEntry {
  readonly at: string;
  readonly op: DecisionEventOp | "derived-confirm" | "derived-supersede";
  readonly actorLabel: string | null;
  readonly surface: string | null;
  readonly derived: boolean;
  readonly reviewedDigest?: string;
  readonly reason?: string;
  readonly problem?: "chain-broken" | "event-missing" | "repair-only";
}
export interface DecisionHistoryData {
  readonly id: string;
  readonly mode: "local" | "team";
  readonly teamModeSince?: string;
  readonly entries: readonly TimelineEntry[];
  readonly events: readonly DecisionEvent[];
  readonly integrity: { readonly chain: "valid" | "broken" | "absent"; readonly missingConfirm: boolean };
}
```

FE는 이 타입으로 mock을 만들어 화면(Jira S15P31A106-311·312·315·316)을 먼저 개발할 수 있다. 백엔드가 API-01·04를 구현하면 mock을 실제 호출로 바꾼다. Git email은 기본 응답에 없다(opt-in, rbac 설계 §14.2).


## 8. 표면별 대응

| 조작 | CLI | UI API | MCP |
|---|---|---|---|
| 목록·대기 | `decision list` | `GET /api/proposals`, `/api/direction` | `duo_get_status`, `duo_get_decision` |
| 제안 | 없음 | 없음(API-08 PROPOSED, 1단계 제외) | `duo_propose_decision`(agent) |
| preview | confirm·reject 안에서 표시 | `/api/proposals`의 `previews`, `GET /api/proposals/{P-id}/preview`(API-05, IMPLEMENTED(next)) | 없음 |
| 확정 | `decision confirm`(TTY), `review-pending` | `POST .../confirm` | **없음(유지)** |
| 거절 | `decision reject --reason` | `POST .../reject` | **없음(유지)** |
| 이력 | PROPOSED `decision history` | API-04 PROPOSED | `duo_get_decision`에 이력 요약 추가는 AI-2와 협의(스키마 additive) |
| 검증 | PROPOSED `decision verify [--ci]` | 없음 | 없음 |

## 9. 역할별 접근(PROPOSED, Team Mode)

Local Mode에서는 지금처럼 세션을 가진 같은 컴퓨터의 사용자가 UI가 제공하는 모든 조작을 한다. 아래 표는 Team Mode의 제안이다. **로컬 서버가 보는 역할은 Git `user.name`/`user.email` 같은 인증되지 않은 label에서 나오므로 실수 방지(`local-ux`)일 뿐이다.** 실제 강제는 병합 리뷰(`merge-review`)다.

| 조작(엔드포인트) | READ_ONLY | DEVELOPER | APPROVER(자기 범위) | 강제 |
|---|---|---|---|---|
| 조회(`GET` 전부, API-02~05 포함) | O | O | O | 없음 |
| Context·Review 실행(`POST /api/context`, `/api/review`) | O | O | O | 없음(읽기 조작) |
| proposal 확정(`POST …/confirm`) | X | X | O | 로컬 거부 `DECISION_ROLE_FORBIDDEN` + 병합 리뷰 |
| proposal 거절(`POST …/reject`) | X | X | O | 같음 |
| proposal 취소(API-07) | X | 자기 것 | 자기 것 | 로컬 |

- READ_ONLY는 원래 저장소 쓰기 권한이 없는 사람이다. 로컬 UI는 그것을 알 수 없으므로, READ_ONLY 표시는 `governance.yaml` 매핑에서 나온 안내다.
- 권한 부족은 지금 계약대로 HTTP 200 + `failed`다(§5).

## 10. 승인 실패와 충돌의 화면 표현

| 코드 | 상태 | 화면에 보일 것 | 사용자의 다음 행동 |
|---|---|---|---|
| `DECISION_CONFIRM_PREVIEW_CHANGED` | IMPLEMENTED | "확인한 뒤 내용이 바뀌어 아무것도 쓰지 않았습니다" | 새 preview를 보고 다시 확정 |
| `PROPOSAL_NOT_PENDING` | IMPLEMENTED | "이미 처리된 proposal입니다(D-### 또는 rejected)" | 목록 새로 고침 |
| `DECISION_LOCK_BUSY` | IMPLEMENTED | "다른 확정 작업이 진행 중입니다" | 잠시 뒤 재시도 |
| `DECISION_SUPERSEDE_TARGET_INVALID` | IMPLEMENTED | "대체할 Decision이 이미 바뀌었습니다" | 대상 확인 뒤 새 proposal |
| `DECISION_SESSION_CONFLICT` | IMPLEMENTED(CLI 세션) | 같은 대상의 두 proposal | 하나만 확정 |
| `PROPOSAL_STALE`(warning) | IMPLEMENTED | "Truth가 바뀐 뒤의 proposal입니다" 배지 | preview 확인 |
| `UI_CONFIRM_ID_MISMATCH` | IMPLEMENTED | "확정할 ID를 다시 입력하세요" | ID 재입력 |
| Truth 권한 오류(`DECISION_INTEGRITY_INVALID` 등) | IMPLEMENTED | 확정 버튼 비활성, 원인 진단 | doctor 안내 |
| `DECISION_ROLE_FORBIDDEN` | PROPOSED | "이 범위의 승인자가 아닙니다(실수 방지)" | 승인자에게 요청 |
| `DECISION_AGENT_ENVIRONMENT` | PROPOSED | "agent 실행 환경에서는 확정하지 않습니다(실수 방지)" | 사람의 터미널·브라우저에서 확정 |
| `DECISION_EVENT_MISSING`, `DECISION_TEAM_LOCK_REQUIRED` | PROPOSED | Team Mode 무결성 오류 | 전환·repair 절차 안내 |
| stale 승인(같은 `basedOn`) | PROPOSED, CI 전용 | UI에는 없음. PR의 CI 결과에 나옴 | rebase 뒤 다시 확정 |

## 11. Audit Timeline 표시 데이터

- 한 줄 = `TimelineEntry` 하나. 시각, 조작, actor label, 표면, 본 preview digest(앞 12자), 사유.
- actor label 옆에는 항상 "인증 아님" 표시를 둔다. Team Mode에서 병합 리뷰어 정보는 DUO가 아니라 호스팅의 PR 화면에 있다. UI는 PR 링크를 보여 주지 않는다(DUO가 PR을 알지 못함).
- `derived: true` 항목은 "파일에서 추론, Team Mode 이전"으로 구분해 표시하고 확정 승인처럼 보이게 하지 않는다.
- `problem`이 있으면 줄을 경고 색으로 표시한다(`chain-broken`, `event-missing`, `repair-only`).
- 상단에 `TrustStatus`를 보여 준다. `UNVERIFIED`·`NOT_MET`이면 "팀 권한이 보장된다고 표시하지 않습니다"를 함께 쓴다.

## 12. 프론트엔드가 Mock으로 먼저 할 수 있는 범위

| 범위 | Mock 가능 | 근거 |
|---|---|---|
| Decision 목록·상세(API-02·03) | O, `next` 빌드의 실제 서버로도 확인 가능 | §2의 응답. `truncated`, Decision별 `integrity`·`problems`, `truth.complete`를 화면에 반영 |
| 단건 preview(API-05) | O, `next` 빌드의 실제 서버로도 확인 가능 | `{ status: "ready", preview: ConfirmPreview, warnings }` wrapper |
| 오류 표현(§10의 IMPLEMENTED 코드) | O, 실제 서버로도 확인 가능 | 지금 서버가 냄 |
| `/api/me`와 신뢰 상태 배지(API-01) | O(mock만) | 필드 이름은 H-88 뒤 확정 |
| Audit Timeline(API-04) | O(mock만) | 이벤트 형식은 H-88 뒤 확정 |
| 역할별 버튼 비활성(§9) | O(mock만) | Team Mode 미구현 |
| proposal 생성·취소(API-07·08) | 하지 않음 | 스키마·ADR-009 변경 필요 |

Mock 화면은 "PROPOSED" 표시를 달고, 실제 구현된 기능처럼 문서나 데모에 쓰지 않는다.

