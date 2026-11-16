# DUO UI 접근성 감사 (Jira 297)

## 목적과 판정

Playwright와 axe를 사용해 로컬 DUO UI의 접근성 상태를 재현 가능하게 확인한다. 자동 검사는 실행한 DOM 상태와 적용한 규칙만 다루며, 전체 WCAG 준수를 증명하지 않는다. 제품 문제는 감사 결과로 남기고 수정은 별도 작업으로 다룬다.

각 사례 결과는 `통과`, `제품 문제`, `도구 오류`, `미검증` 중 하나다. axe `violations`는 제품 문제로 분류한다. axe `incomplete`는 스크린샷과 함께 수동 확인 대상이며, 사람이 확인하지 못하면 미검증으로 남긴다. 제품 문제만으로 감사 완료를 막지는 않지만, 필수 사례가 도구 오류로 빠지면 조사는 미완료다.

## 실행

```powershell
pnpm test:ui:a11y
```

명령은 UI를 빌드한 뒤 전용 Vitest 설정으로 감사 E2E만 실행한다. 브라우저는 로컬 Chrome, Edge, Playwright Chromium 순으로 찾는다. 모두 실행할 수 없으면 도구 오류로 종료한다. 기본 테스트 설정은 감사 E2E를 제외한다.

각 실행은 `.duo-a11y-runs/<실행 ID>/` 아래에 `summary.json`, `cases.jsonl`, 사례별 `result.json`, 스크린샷을 기록한다. 이 경로는 Git에서 제외된다. 사례 결과는 검사 종료마다 원자적으로 저장하고, 실행이 끝나면 확정된 사례 파일에서 JSONL을 다시 만든다. 스크린샷은 `<caseId>/attempt-<n>/step-<n>.png`에 둔다. `summary.json`에는 실행 시각, 저장소 커밋과 작업 트리 상태, Node·pnpm·Playwright·axe·실제 브라우저 버전, fixture 조건, 규칙, 사례 집계가 담긴다.

## 기본 화면 검사표

아래 12개 화면 각각을 밝음/어두움 테마와 1280×800/320×800 크기로 검사한다. 기본 데이터 상태는 총 48개 조합이다.

| 화면 | 경로 | 기본 데이터 | 초기 비동기 상태 |
|---|---|---|---|
| Overview | `/overview` | 프로젝트 요약, index, 기록된 review | GET `/api/overview`의 loading/error |
| Direction | `/direction` | fixture의 vision·요구사항·Decision | GET `/api/direction`의 loading/error |
| Pending decisions | `/decisions` | pending proposal 2개 | GET `/api/proposals`의 loading/error |
| Work map | `/work` | 관련 작업 1개와 그래프 관계 | GET `/api/work-map`의 loading/error |
| Graph | `/graph?node=RPT-01` | seed와 연결 관계 | GET `/api/graph`의 loading/error |
| Analysis coverage | `/coverage` | fixture 언어 분석 통계 | GET `/api/overview`의 loading/error |
| Context | `/context` | 입력 전 빈 화면 | 초기 GET 없음; 폼 제출 후 POST 상태 검사 |
| Review | `/review` | 입력 폼 | 초기 GET 없음; 폼 제출 후 POST 상태 검사 |
| Review history | `/reviews` | 기록된 review 1개 | GET `/api/reviews`의 loading/error |
| Search | `/search?q=RPT-01` | 일치 결과 | GET `/api/search`의 loading/error |
| Entity detail | `/entity/RPT-01` | 요구사항 상세와 source | GET `/api/entity/RPT-01`의 loading/error |
| Review detail | `/reviews/<review ID>` | 기록 review의 claim과 evidence | GET `/api/reviews/<review ID>`의 loading/error |

추가 상태는 지원 여부를 코드에서 확인하고 밝은 테마·데스크톱에서 별도 기록한다. UI에서 실제로 지원하는 빈 상태는 Decision 제안 없음, Work 항목 없음, Graph 미선택/미발견, Review history 비어 있음, Search 결과 없음, Entity 미발견, Review 상세 미발견이다. Context와 Review는 초기 데이터 조회 대신 제출 결과를 표시한다. 성공 제출 결과와 필수 입력 검증도 검사한다.

Pending decisions의 Confirm·Reject 대화상자는 밝음/어두움과 두 화면 크기를 모두 검사한다. 키보드 동작 검사에서는 포커스 진입·초기 위치·Tab/Shift+Tab 순환·Escape/취소·트리거로 복귀를 별도 사례로 기록한다. Work map은 둘 이상의 노드 중 다른 노드를 키보드로 선택하고, 선택한 노드와 상세 패널 내용이 함께 바뀌는지 확인한다.

## 규칙 및 수동 확인

자동 axe 검사에 `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` 태그를 적용한다. 설치된 axe-core에서 태그를 찾지 못하면 테스트 도구 설정 오류로 처리한다. axe `violations`와 `incomplete` 원본은 사례 결과에 모두 저장한다. 별도 구조 검사로 제목, h1, main landmark, 입력 이름, 간단한 데이터 표의 헤더 연결, 제목 단계 건너뜀을 확인한다. 단순 표에 `thead`나 `scope="col"`을 강제하지 않으며, 명시적 `role="presentation"`/`none` 표는 제외 사유를 기록한다. 복잡한 병합 표는 수동 검토 대상으로 남긴다.

설치된 axe-core `4.14.0`의 `td-has-header`는 기본 비활성 experimental 규칙이며 큰 표(최소 3×3)만 대상으로 하므로, 보조 검사에서 `td-has-header`, `td-headers-attr`, `th-has-data-cells`, `scope-attr-valid`, `empty-table-header`를 별도로 명시해 실행한다. WCAG 태그 결과와 이 보조 규칙 결과를 구분해 저장한다.

문서 전체와 Work map 캔버스의 가로 overflow를 각각 측정한다. 그래프 내부 overflow는 탐색 가능한 캔버스 동작과 구분해 스크린샷 확인을 요구한다. 사례 스크린샷의 겹침·잘림·포커스 가림을 사람이 확인하기 전까지 해당 사례를 `미검증`으로 기록한다. 실제 스크린리더 청취도 미검증이다.

키보드 순서는 제품 DOM으로 기대값을 만들지 않고 독립된 기대 배열과 실제 Tab 순서를 전체 길이·각 위치의 안정적인 식별자로 비교한다. 메뉴 10개와 Overview 본문 순서를 검사하고, Enter의 URL 이동과 summary의 Space 동작도 확인한다. 포커스 표시는 `:focus-visible`, 표시 스타일, 화면 영역, 스크롤 조상 클리핑 및 중심점 가림을 수집한다. 정방향·역방향 모달 순환은 명시한 BODY 경계 처리와 비교한다.

검사 실행기는 결과 반환 전에 난 오류만 새 컨텍스트·서버·fixture 복사본으로 한 번 재시도한다. 일부 증거는 보존한다. 첫 시도의 정리 오류도 재시도 결과와 함께 최종 사례의 도구 오류로 기록한다. 결과를 반환한 뒤 정리 오류가 나면 재시도하지 않고 원래 제품 finding과 도구 오류를 모두 기록한다. 실행 오류는 `name`, `message`, `stack`, `cause`, `AggregateError.errors`를 깊이·길이 제한과 순환 표시를 적용해 직렬화한다. 사례 ID 중복을 거부하고 사례·요약 파일을 임시 파일 교체 방식으로 저장한다.

요약은 `executionComplete`와 `accessibilityVerificationComplete`를 별도로 제공한다. 전자는 예상 사례가 하나씩 기록되고 해결되지 않은 도구 오류가 없어야 참이다. 후자는 필수 검사가 실제 수행되고 미검증이 없어야 참이다. 두 값 모두 WCAG 전체 준수를 뜻하지 않는다.

## 실행 결과 및 후속 확인

최종 전체 실행은 `2026-10-21 16:32:30 KST`에 시작해 `16:35:31 KST`에 끝났다. 산출물은 `.duo-a11y-runs/2026-10-21T07-32-30-472Z-14612/`이다. 저장소 커밋은 `ee19fe264bf3fdde5a2cb15ccf746a78919edc5c`이며 시작 당시 미커밋 파일 목록은 `summary.json`에 기록했다. Node `v24.18.0`, pnpm `11.25.0`, Playwright `1.63.0`, axe-core `4.14.0`, Chrome `155.0.8059.85`를 사용했다. 각 사례는 `fixtures/review/app`에서 독립 복사본을 만들고, index, pending proposal 2개, review 1개, Work map task 1개를 준비했다.

48개 기본 화면 조합을 포함해 총 120개 사례를 실행했다. 요약은 상태 지원 기록 12, 제품 문제 30, 도구 오류 0, 미검증 78이다. 제품 문제 finding이 있는 사례는 30개이며, 미검증 finding이 있는 사례는 108개다. 누락·중복·최종 자원 정리 오류가 없고, `executionComplete: true`, `accessibilityVerificationComplete: false`다. 후자 값은 사례의 최종 상태와 별도로 모든 미검증 finding을 세므로 제품 문제와 수동 확인이 함께 있는 사례도 완료로 잘못 처리하지 않는다. 스크린샷 육안 확인과 axe incomplete 판정, 실제 스크린리더 청취가 남아 있다. 제품 문제 30은 사례 수이며 같은 문제가 여러 화면·조건에 반복될 수 있다. 주요 관찰은 다음과 같다.

- Work map에서 Tab·Enter로 그래프의 Worktree 노드를 선택하면 React Flow는 선택 상태를 갱신하지만 상세 패널은 이전 작업을 표시한다. 새 키보드 사례에서 이를 재현해 제품 문제로 기록했다.
- Overview 본문의 마지막 포커스 대상 뒤에 Chromium `BODY` sentinel이 나타났다. BODY sentinel은 모달 경계에서만 허용하도록 한 검사 기준에 따라 제품 문제로 기록했다.
- axe가 Work map의 `nested-interactive`도 검출했다. `role="img"`인 `.work-canvas` 안에 키보드 포커스 가능한 자손이 있다는 결과로, 제품 후속 조사 대상이다.
- 모달은 확인 버튼의 입력 전·후 활성 상태와 거절 버튼 상태를 네 가지 테마·크기 조합에서 검사했다. 각 Escape 사례에는 열린 상태와 닫은 상태의 별도 스크린샷이 있고, 모든 조합에서 트리거 포커스 복귀를 확인했다.
- Context의 빈 Task 차단, Review의 선택 Task 생략, Search/Graph의 공백 입력 no-op, Work map의 필수 이름 검증을 별도 사례로 추가했다.
- 12개 기본 화면의 문서 가로 overflow와 Work map 캔버스 내부 폭을 각각 기록한다. 실제 스크린샷의 겹침·잘림·포커스 가림은 아직 육안 확인하지 않아 해당 캡처 사례는 미검증이다. axe incomplete와 스크린리더 청취도 미검증이다.

감사 전용 Vitest 12개 테스트가 통과했다. 회귀 검사 9개는 일부 증거 후 재시도, 재시도 뒤에도 남는 정리 오류, 반환 후 정리 오류 시 무재시도, 오류 증거 수집 실패 후 정리, 원자 파일 보존, 중첩·순환·제한 오류 직렬화, 여러 표 구조, 포커스 순서 삽입·누락·중복·역순 실패, 제품 문제와 미검증 finding의 동시 보존을 확인한다. 감사 3개 테스트는 120개 결과 누락·중복·도구 오류가 없는지 확인했다. 기존 UI 브라우저 E2E도 이번 변경 후 skip 없이 6/6 통과했다. `pnpm typecheck`, `pnpm lint`, `git diff --check`, `pnpm test:ui:a11y`가 통과했다. 자동 검사 실행 완료는 WCAG 전체 준수 판정이 아니다.

Jira 이슈 `S15P31A106-297`은 조회 가능했다. 앞서 단축 키 `297`로 조회해 404라고 기록한 것은 잘못이었다. 2026-10-21 16:36 KST에 최신 실행 결과와 보고서 경로를 Jira 댓글로 남겼다. 이슈는 진행 중으로 유지했다. 실행은 완료됐지만 스크린샷 육안 확인, axe incomplete 수동 판정, 스크린리더 청취가 남아 있어 `accessibilityVerificationComplete: false`다. 구현 추적은 GitHub 이슈 [#62](https://github.com/kanghyunsoon/duo/issues/62)에 남겼다.

## 실행 기록

| 실행 ID | 결과 | 필수 화면 누락 | 제품 문제 | 미검증 | Jira 반영 |
|---|---|---:|---:|---:|---|
| `2026-10-21T07-32-30-472Z-14612` | 실행 완료; `accessibilityVerificationComplete: false` | 0 | 30 사례 | 78 사례, 108개 미검증 finding 및 스크린리더 | `S15P31A106-297`에 기록; 수동 확인 후 상태 결정 |

## 공유 산출물 정제 (2026-10-23)

공유 요약과 사례 JSON/JSONL은 `schemaVersion: 3`이다. 공유본은 `cwd`, `gitStatus`, 오류 메시지·스택·중첩 오류 원문을 제거하며 오류 메시지는 `[redacted]`로 표시한다. 로컬 원본 진단은 `DUO_A11Y_LOCAL_DIAGNOSTICS=1`을 설정한 경우에만 `.duo-a11y-runs/local-diagnostics/<runId>/`에 저장한다. 스크린샷은 고정 감사 fixture에서 생성하며 외부 공유 전에 사람이 화면 내용을 확인해야 한다.

최신 실행 `2026-10-23T00-08-53-025Z-30420`: 총 120건, 누락 0, 중복 0, 도구 오류 0, 제품 문제 30건, 미검증 상태 78건(미검증 finding이 포함된 사례 108개). `executionComplete: true`, `accessibilityVerificationComplete: false`.

정제 요약 예시: `{"schemaVersion":3,"caseCount":120,"executionComplete":true,"accessibilityVerificationComplete":false}`.


## 제품 문제 후속 이슈

감사에서 발견한 제품 문제는 별도 이슈로 추적한다.

- 모바일 화면 및 Decision 대화상자 가로 overflow: [#70](https://github.com/kanghyunsoon/duo/issues/70)
- Work map 키보드 선택 후 상세 패널 미갱신: [#71](https://github.com/kanghyunsoon/duo/issues/71)
- Work map `nested-interactive` 위반: [#72](https://github.com/kanghyunsoon/duo/issues/72)
- Overview 키보드 순서의 BODY sentinel: [#73](https://github.com/kanghyunsoon/duo/issues/73)
