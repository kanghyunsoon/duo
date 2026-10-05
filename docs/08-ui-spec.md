# 08. UI Spec

상태: T18.1 구현 기준 (2026-09-29) · 관련: REQ-UI-001, REQ-UI-002, REQ-REVIEW-004, [ADR-009](adr/ADR-009-ui-stack.md), [ADR-013](adr/ADR-013-decision-lifecycle.md)

## 원칙과 실행

`duoctl ui [--port N] [--open]`는 사용 가능한 포트를 골라 `127.0.0.1`에만 바인드하고 실제 URL을 출력한다. 브라우저 자동 열기는 선택 사항이다. React/TypeScript 앱은 CLI 배포 패키지의 정적 번들이며 별도의 개발 서버와 UI 저장소가 없다. `.duo-project`와 Graph/Director/Integration operation이 데이터 원본이다. 서버는 요청마다 현재 Graph를 열고 닫으므로 외부 `duoctl index` 결과가 Refresh 뒤 보인다.

UI에서 허용하는 쓰기는 Human의 Decision Proposal **Confirm**과 **Reject**뿐이다. 둘 다 core `DecisionService`를 호출한다. Index, Review Record, Truth 편집, Git 작업은 UI에서 수행하지 않는다.

## Versioned API

응답은 `duo.ui.<name>/1` envelope를 사용한다. Domain의 `index-required`, ASK, BLOCK은 HTTP 200의 Domain 결과이고 입력 오류만 4xx로 돌려준다.

| Method | Endpoint | 내용 |
|---|---|---|
| GET | `/api/session` | 실행별 CSRF token과 버전 |
| GET | `/api/overview` | 상태, 현재 milestone, freshness, baseline, coverage, Truth 수, gap, 최근 Review |
| GET | `/api/direction` | Vision, Milestone, Requirement, Constraint, Decision의 source 위치 |
| GET | `/api/proposals` | DecisionService의 pending/committed/rejected logical state |
| GET | `/api/graph?node=&kind=trace\|impact&depth=` | 기존 bounded trace/impact operation (기본 200 node) |
| GET | `/api/entity/:id` | Truth/Graph entity 상세와 source slice |
| GET | `/api/reviews`, `/api/reviews/:id` | Human 보존 Review Record와 Evidence pointer |
| GET | `/api/search?q=&limit=` | 기존 deterministic evidence search |
| GET | `/api/source?path=&start=&end=` | 인덱싱된 파일의 필요한 줄, 최대 120줄 |
| POST | `/api/context` | 기존 Context Compiler, `{ task, budget? }` |
| POST | `/api/review` | 기존 Review, `{ task?, from?, to?, includeSemanticAssist? }` |
| POST | `/api/proposals/:id/confirm` | `{ confirmId, previewDigest? }`. ID를 재입력하고 DecisionService.confirm 호출. `previewDigest`(T34.2)가 있으면 그 preview에 묶여, candidate가 바뀌었으면 `DECISION_CONFIRM_PREVIEW_CHANGED`로 아무것도 쓰지 않음 |
| POST | `/api/proposals/:id/reject` | `{ reason? }`로 DecisionService.reject 호출 |

입력은 서버에서 strict validation한다. POST는 같은 Origin, session cookie, `X-Duo-CSRF`, JSON content type을 요구한다. [보안 계약](10-security.md#로컬-http-api)을 따른다.

## 화면

- **Overview**: 프로젝트, milestone, index freshness, baseline, analysis coverage, Requirement/Decision 수, pending human decision, knowledge gap, 최근 Review verdict. 점수는 만들지 않는다.
- **Direction**: Vision, Milestone, Requirement, Constraint, active/superseded Decision을 ID·state·source 위치로 탐색한다. Sparse Truth도 정상 상태로 표시한다.
- **Decisions**: Proposal의 pending/committed/rejected state를 구분한다. Confirm은 내용·stale warning·supersede 대상을 modal에서 다시 보여주고 ID 재입력을 요구한다. modal의 내용은 CLI와 같은 `DecisionService.previewConfirm` candidate(Title, Question, Answer, Kind, Rationale, Governs, Forbids, Enforcement, Supersedes, Stale, Expected Decision ID)이고, 확정 요청은 그 preview의 digest를 함께 보낸다(T34.2). preview가 없으면 Confirm 버튼은 비활성이다. pending 카드에도 Forbids와 Enforcement를 보인다. Reject에는 선택적 사유를 받는다.
- **Graph**: 검색으로 seed를 고르고 기존 trace/impact operation으로 depth 1–3의 bounded 관계를 탐색한다. Node/edge 목록에서 entity 상세로 이동한다. 전체 Graph와 별도 force-directed engine을 사용하지 않는다.
- **Coverage**: 언어별 L0/L1/L2와 file, symbol, test, import, call, type resolution 범위 및 limitation을 표시한다. L0는 정상 file-level fallback이다.
- **Context**: 입력 task로 Packet을 생성하고 seed, confirmed intent, decision, code, test, gap, evidence, token metric, omitted candidate를 보여준다. Stale index는 명시적으로 `index-required`로 표시한다.
- **Review / Reviews / Evidence**: 현재 diff에 대한 결정적 verdict와 Claim/Evidence, baseline provenance, 선택적 semantic supplement를 분리한다. Review 실행은 Record를 자동 생성하지 않는다. 기록된 Review와 Evidence pointer는 별도로 탐색한다.
- **Search / Entity**: Requirement ID, Decision ID, Symbol, File, Review ID를 찾고 URL로 직접 열 수 있다. Source viewer는 evidence slice만 제공한다.

Refresh는 사용자 요청 또는 화면 전환 시에만 수행한다. 1초 polling, watcher, 자동 Index는 사용하지 않는다. 기본 LLM은 disabled이고, semantic Review는 사용자가 명시적으로 켤 때만 선택된 evidence slice를 전송한다.
