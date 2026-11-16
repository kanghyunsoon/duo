# Accessibility follow-up B: Overview focus boundary (#73)

## Scope and evidence

This report records the #73 investigation separately from the source audit output. The committed report contains a sanitized summary; raw JSON, JSONL, screenshots, and other run evidence stay in the ignored `.duo-a11y-runs/<runId>/` directory.

| Field | Value |
| --- | --- |
| Base SHA | `3a20e9a3b6813957887e38f5426b50399757b384` (`next`, second parent of merge) |
| Tested code SHA | `f4404f3b3f2206c9c6cfb6dbea8c75c242b00f24` (merge of PR #80 head and current `next`) |
| Audit schema / rules | schema version 3; WCAG 2 A/AA, WCAG 2.1 A/AA, WCAG 2.2 AA; supplemental table rules enabled |
| Run ID | `2026-10-24T11-48-41-835Z-29304` |
| Environment | Windows 11 Enterprise; Node `v24.18.0`; pnpm `11.25.0`; Playwright `1.63.0`; axe-core `4.14.0`; Chrome `155.0.8059.85` |
| Viewports | 1280px desktop and 320px mobile viewport emulation in desktop Chrome; no physical device or external keyboard was used |

The raw run contains 120 cases: 12 passed, 0 with product findings, 0 tool errors, and 108 unverified. There are no missing or duplicate cases, no cleanup errors, and execution completed. Accessibility verification remains incomplete because manual review is outstanding.

## Comparison with the previous run

The previous run was `2026-10-23T08-27-38-864Z-20224` at tested code SHA `73ec8ecb6d0d5568f65cb1148e97d92cbc7da01d` (12 passed, 29 product findings, 0 tool errors, 79 unverified). This run has the same 120 case IDs. All 29 cases previously classified as product issues are now unverified; 12 remain passed and 79 other cases remain unverified. The detailed finding changes support the following attribution:

| Finding change | Cases | Evidence and attribution |
| --- | ---: | --- |
| Mobile document horizontal overflow no longer reported | 22 | `base-Direction-light-mobile`, `base-Direction-dark-mobile`, `base-Pending decisions-light-mobile`, `base-Pending decisions-dark-mobile`, `base-Graph-light-mobile`, `base-Graph-dark-mobile`, `base-Analysis coverage-light-mobile`, `base-Analysis coverage-dark-mobile`, `base-Review history-light-mobile`, `base-Review history-dark-mobile`, `base-Search-light-mobile`, `base-Search-dark-mobile`, `base-Review detail-light-mobile`, `base-Review detail-dark-mobile`, all four `modal-confirm-*mobile*` cases, and all four `modal-reject-*mobile*` cases. The new run has 320px document and client widths in these cases. This matches #79's responsive layout, wrapping, dialog sizing, and table-scroll changes; the two Analysis coverage cases still require manual review of complex table associations. |
| `nested-interactive` finding on `.work-canvas` no longer reported | 6 | Four `base-Work map-{light,dark}-{desktop,mobile}` cases plus `form-work-add` and `form-work-validation`. #79 changes the canvas from `role="img"` to a named `role="region"` and adds keyboard handling; the old finding targeted `.work-canvas`, and it is absent in all six new results. |
| Work map keyboard selection assertion no longer fails | 1 | `workmap-keyboard`. #79 adds Enter/Space handling that selects the focused React Flow node; the old `before` and `after` selection labels were identical, while the new result has no product finding for this assertion. |

These 29 case-level changes are attributable to findings and code paths touched by #79. The two table-association findings remain **unverified**; their status changed because the associated overflow finding disappeared, not because the table associations were proven accessible.

## #73 audit-rule effect

`keyboard-navigation` is unverified in both the previous run and this rerun. Its forward and reverse page-internal sequences pass at desktop and mobile sizes, and the page's `BODY` boundary matches a plain HTML control. Browser UI focus leaving and returning remains unobservable. Because the #73 classification rule was already present in the previous run, this comparison does not measure a new #73 rule effect; no new status change is attributed to #73 here. The earlier finding-level comparison recorded in the prior report remains separate evidence.

The current run does not establish the browser chrome boundary or returning focus from browser UI. That portion remains **unverified** and is not counted as a pass. No artificial focus loop was added. The audit's `accessibilityVerificationComplete` remains `false`.

## Verification

- `pnpm verify` — passed: 146 test files; 1,423 passed, 7 skipped, 5 TODO; documentation validation passed for 125 files (52 requirements, 14 decisions, 22 issues, 5 milestones, 94 acceptance criteria, 226 links).
- `pnpm test:ui:a11y` at the tested code SHA — 2 test files and 14 tests passed; audit execution completed with 120 cases, 0 missing, duplicate, tool, or cleanup errors; `accessibilityVerificationComplete: false`.
- `git diff --check` — passed before report update.

This is a viewport-emulation result. Physical mobile device and browser UI boundary checks still require manual evidence. Final-head Ubuntu, Windows, and macOS CI is required before marking the PR Ready.

## PR #80 최신 실행 및 수동 검증 기록

| 항목 | 값 |
| --- | --- |
| 검증 제품·감사 코드 SHA | `15f65d4be8441e1c90d3be98cd01d4f778814120` (PR 브랜치에 `origin/next` 병합한 커밋) |
| 보고서 커밋 SHA | 보고서 커밋 SHA는 PR 설명에 기록 (내용에 자기 자신의 SHA를 넣을 수 없어 외부 연결로 고정) |
| 실행 ID | `2026-10-24T13-48-30-602Z-30952` |
| 자동 감사 환경 | Windows 11 Enterprise; Node `v24.18.0`; pnpm `11.25.0`; Playwright `1.63.0`; axe-core `4.14.0`; Chrome `155.0.8059.85` |
| 결과 | 120개 사례; 통과 12, 제품 finding 0, 도구 오류 0, 미검증 108; 누락·중복·정리 오류 0; 실행 완료 |
| 감사 완료 상태 | `accessibilityVerificationComplete: false` |

원본 `cases.jsonl`과 `summary.json`은 수정하지 않았다. 같은 실행 폴더의 `manual-review.json`은 120개 사례 각각을 사례 ID, 상태, 화면 크기·테마, 캡처 경로와 연결한다. 아직 실제 화면·음성·상호작용 검토가 이뤄지지 않은 항목은 미검증으로 남겼다. 이 기록은 수동 검증을 완료했다는 뜻이 아니다.

### 기준값과 새 원본의 차이

기존 보고서에서 인용된 108개 미검증 사례, 80개 axe 미판정 항목, 4개 복잡한 표 사례는 이전 실행의 기준값으로만 취급한다. 새 실행은 기존과 같은 120개 사례 ID와 같은 4개 `Analysis coverage` 조합(밝음·어두움 × 데스크톱·모바일)을 포함한다. 사례 수의 차이는 없다.

새 원본의 `result.json`을 직접 집계한 결과 axe `incomplete` 배열은 92개 rule-result 레코드다. 이 중 `aria-prohibited-attr` 44건/44개 대상, `color-contrast` 36건/152개 대상이며, 나머지 12건은 규칙 ID가 비어 있고 각 1개 대상이 있어 원시 데이터만으로 규칙을 특정할 수 없다. 따라서 식별 가능한 규칙의 대상 수는 196개이고, 전체 incomplete 대상은 208개다. 별도 표 규칙 결과에는 12개 화면의 미판정이 기록되어 있다. 규칙 레코드·대상 요소·표 화면은 서로 겹칠 수 있으므로 합산한 총량으로 해석하지 않는다. 이전 80개와 새 92개는 집계 단위가 같다고 확인할 근거가 없어 증감으로 단정하지 않는다. 사례 ID, 규칙 ID, 대상 선택자 및 표 결과 연결은 원본 실행 폴더의 결과 파일에서 확인한다.

### 고정 검증 행렬 및 미완료 항목

| 환경·조건 | 대상 및 확인 내용 | 상태 / 근거 |
| --- | --- | --- |
| 자동 Chrome, 데스크톱 1280px 및 모바일 320px 뷰포트 | 기존 120개 사례, 캡처, 포커스 단계, axe와 표 규칙 원시 결과 | 실행 완료. 수동 시각 검토 및 스크린리더 판정은 미검증 |
| Narrator + Chrome, 1280×800, 밝음·어두움 | 12개 화면마다 제목, 주 탐색·본문, 첫 조작 요소 이름·상태, 주요 결과; 공통 대화상자·폼 오류·노드 선택·표 헤더 동작 | 미검증: 실제 표시 브라우저 및 Narrator 음성 청취 기록 없음 |
| TalkBack + Chrome, 복제 AVD, 기본·1.3배 글자 크기, 밝음·어두움 | 12개 화면과 터치 탐색, 폼 오류, 대화상자, Work map 선택, 표 헤더 | 미검증: 복제 AVD가 안정적으로 부팅되지 않아 상호작용/음성 검증을 수행하지 않음. 원본 `Medium_Phone` AVD는 변경하지 않음 |
| Chrome 브라우저 UI 경계 | Overview와 일반 HTML 대조 화면에서 Tab·Shift+Tab, 브라우저 UI로 이동 후 복귀 위치 | 당시 자동 실행에서는 미검증. 최신 수동 확인은 아래 2026-11-03 기록 참조 |
| 복잡한 표 4개 사례 | 실제 스크린리더의 행·열 헤더 연결 및 읽기 | 미검증: 자동 표 규칙 결과만으로 헤더 읽기를 확정할 수 없음 |

이전 실행은 앱 내부 자동화 결과이며, 전체 캡처 126개를 전부 수동 판독했다거나 Narrator/TalkBack의 실제 음성 출력을 확인했다는 근거가 아니다. 그 실행은 브라우저 UI 경계 판별을 포함하지 않았다. Android의 기기 이미지/OS 세부 버전, Chrome·TalkBack 버전, 글자 크기와 화면 배율은 성공적으로 구동된 검증 세션에서 측정하지 못해 기록하지 않는다.

## 2026-11-03 최신 실행 및 #73 수동 확인

| 항목 | 값 |
| --- | --- |
| 최신 `next` 기준 SHA | `1306dba542394d38fd358a21b837b0a196860ec9` |
| PR 테스트 코드 SHA | `16643c73a22ba397a28121fa635bcb8712f08d17` (위 `next`에 PR 변경을 유지하고 테마별 캡처·결과 구분을 추가) |
| 전체 감사 실행 ID | `2026-11-03T05-47-24-464Z-15456` |
| 환경 | Node `v24.18.0`; pnpm `11.25.0`; Playwright `1.63.0`; axe-core `4.14.0`; Chrome `156.0.8078.80` |
| 전체 결과 | 120개 사례, 12 통과, 제품 문제 0, 도구 오류 0, 미검증 108; 누락·중복·정리 오류 0; `executionComplete: true`, `accessibilityVerificationComplete: false` |

최신 감사는 `keyboard-navigation` 안에서 `1280×800`·`320×800`, 밝음·어두움 네 조합을 각각 기록했다. 독립적으로 정의한 Overview의 7개 페이지 대상 정방향·역방향 순서는 네 조건 모두 기대값과 일치했다. Skip link와 본문 재진입도 통과했고, 마지막 대상 다음의 BODY 및 이어지는 역방향은 일반 HTML 대조 페이지와 일치했다. 조건별 정·역방향 배열, 경계 비교와 스크린샷 경로는 해당 실행의 `cases.jsonl` 및 `keyboard-navigation/attempt-1/`에 남아 있다.

실행 후 사용자가 Chrome에서 수동으로 확인했다(2026-11-03, `http://127.0.0.1:49673/overview`; viewport/theme은 별도 기록하지 않음). 마지막 페이지 항목 `Declared knowledge gaps (1)` 뒤 `Tab`은 Chrome 왼쪽 상단 브라우저 UI 드롭다운으로 이동했고, `Shift+Tab`은 해당 버튼으로 돌아왔다. `Ctrl+L` 뒤 `Esc`를 두 번 눌러도 같은 버튼에 복귀했다. 이 관찰은 BODY가 페이지 내부에서 중간 포커스 대상이 아니라 페이지 끝의 정상 브라우저 경계 sentinel임을 확인한다. 따라서 #73의 BODY finding은 감사 오탐이며, 제품 UI 변경이나 인위적인 포커스 순환은 필요하지 않다.

수동 확인은 #73의 브라우저 UI 경계 항목만 판정한다. 전체 접근성 감사는 별도 axe incomplete, 시각 검토, 스크린리더 항목이 남아 여전히 미완료다. 기존 실행의 전체 미검증 수 108개를 해결했다고 해석하지 않는다.

## 2026-11-03: Full review of all 108 unverified cases

`108`은 자동 감사의 120개 사례 중 검토 전부가 끝나지 않았다고 표시된 사례 행이다. 아래 표처럼 108개 행을 모두 상태별로 다시 확인했다. 캡처 검토와 기존 자동 상호작용 assertions를 대조해 각 행의 판정을 기록했다. 이 숫자는 108개의 독립된 버그를 뜻하지 않는다.

| 범위 | 사례 수 | 검토 결과 |
| --- | ---: | --- |
| 기본 화면: 12개 화면 × 2개 테마 × 2개 뷰포트 | 48 | Overview, Direction, Pending decisions, Work map, Graph, Analysis coverage, Context, Review, Review history, Search, Entity detail, Review detail 캡처 확인. 아래 표 문제와 Work map 대비 문제를 수정했고, 나머지 캡처에서 추가 겹침·잘림은 찾지 못했다. |
| 초기 로딩 및 API 오류: Overview, Direction, Pending decisions, Work map, Graph, Analysis coverage, Review history, Search, Entity detail, Review detail × 각 2상태 | 20 | 10개 로딩 사례 모두 `role=status`, 10개 API 오류 사례 모두 `role=alert` 표시 assertions 통과. 캡처에서 표시 실패나 레이아웃 겹침 없음. |
| 빈 상태: Pending decisions, Work map, Graph, Review history, Search, Entity detail, Review detail | 7 | 빈 상태 화면이 끝까지 렌더링되고 해당 안내가 표시됨. 추가 시각 문제 없음. |
| 확인·거절 대화상자: 열기 8, Escape 후 복귀 8, 전체 키보드 순환 1 | 17 | 초기 포커스, Tab 순환, Cancel/Escape 닫기와 트리거 복귀 assertions 모두 통과. 열린 대화상자 캡처에서 대화상자 내용 잘림·겹침 없음. axe의 배경막 미판정은 아래에 따로 분류. |
| 폼 및 Work map: 정상 제출 5, POST 로딩·오류 4, 검증/no-op 5, 노드 키보드 선택 1 | 15 | 결과 표시, `status`/`alert`, 빈 입력 차단, 공백 검색 no-op, 노드 선택·상세 갱신 assertions 통과. 추가 제품 finding 없음. |
| 전체 페이지 키보드 순서 | 1 | 내부 7개 대상의 정·역방향 순서 및 Skip link assertions 통과. Chrome UI 경계는 사용자가 직접 확인해 Tab/Shift+Tab 및 Ctrl+L 후 복귀 위치가 정상임을 확인했다. |
| **합계** | **108** | **모든 행의 자동 assertions와 연결된 캡처를 유형별로 검토했다.** |

### 확인된 제품 문제와 수정 결과

시각 검토에서 모바일 표와 Work map 대비 결함을 발견해 PR 코드에서 수정했다.

| 사례·요소 | 발견 | 수정 및 재확인 |
| --- | --- | --- |
| `base-Analysis coverage-{light,dark}-mobile`, `base-Review history-{light,dark}-mobile`, `base-Review detail-{light,dark}-mobile` | 320×800에서 표가 컨테이너 폭에 눌려 글자가 한 자씩 세로로 쪼개졌다. | 초기에 추가한 전역 `min-width: max-content`가 긴 데스크톱 표를 본문보다 넓게 만드는 리뷰가 있어 제거했다. 셀에 `overflow-wrap: break-word`를 적용해 보통 단어는 유지하면서 긴 문자열은 셀 안에서 줄바꿈하게 했다. 최신 감사의 전체 크기 캡처를 확인했다. 1280px Review detail과 Review history 표는 본문 폭에 맞고 값이 여러 줄로 읽힌다. 320px의 세 표는 단어가 글자 단위로 쪼개지지 않으며, 컨테이너 안에서 표를 가로 탐색할 수 있다. |
| Work map 선택 노드, 비선택 노드, React Flow 출처 링크 | 선택 노드의 흰 글자가 그라데이션 배경에서 최소 3.86:1, 비선택 노드의 `.44` 불투명도 때문에 본문 대비가 낮았고 출처 링크 기본 회색도 흐렸다. | 선택 배경을 어둡게 하고 글자를 흰색으로 고정했다(양 끝점 대비 6.37:1, 8.02:1). 비선택 노드의 불투명도 저하를 제거했다(일반 본문 대비 6.26:1 light, 6.74:1 dark). 출처 링크를 테마별 `--muted`로 지정했다(6.21:1 light, 4.76:1 dark). 수정 후 Work map 캡처를 다시 확인했다. |
| 페이지 처리 시간 레이블 | 일반 `span`의 `aria-label="server time"`은 기본 generic role에서 지원되지 않는 ARIA 이름이었다. | 화면에 이미 보이는 처리 시간 텍스트를 유지하고 중복 `aria-label`을 제거했다. 이에 해당하던 37개 반복 `aria-prohibited-attr` 결과가 최신 실행에서 사라졌다. |

### 최신 axe 미판정의 사례별 판정

수정 코드 `f0f196865df5209c52c8c5cba593516008a26b3d`에서 최신 실행은 120개 행 전체를 완료했다. axe `violations`는 0개다. `incomplete`는 49개 rule-result(색 대비 42, ARIA 속성 7)와 331개 대상 노드 참조다. 이는 49개 확정 위반이 아니다.

| axe 메시지 | 노드 참조 수 | 검토 판정 |
| --- | ---: | --- |
| `elmPartiallyObscured` | 182 | 표 스크롤 영역 바깥에 있는 셀 또는 모달 배경막 아래의 원 페이지 요소다. 스크롤 영역의 실제 이동을 확인했고 모달 내부 텍스트는 캡처에서 가려지지 않았다. |
| `bgOverlap` | 96 | Work map 노드의 배경색을 React Flow 캔버스 합성 때문에 axe가 계산하지 못했다. 선택·비선택 노드의 실제 CSS 색과 대비를 위에서 별도로 계산했고 수정 후 AA 기준을 만족한다. |
| `elmPartiallyObscuring` | 22 | 열린 native dialog가 뒤쪽 페이지를 덮는 상태다. 의도된 modal 배경막이며 dialog 내부 콘텐츠의 겹침은 아니다. |
| `nonBmp` | 15 | `aria-hidden="true"`인 체크 표시 장식 문양으로, 본문 텍스트 대비 검사 대상이 아니다. |
| `imgNode` | 7 | React Flow 출처 링크 내부 SVG 때문에 자동 판정되지 않았다. 링크 텍스트는 존재하며 색은 테마별 muted 색으로 수정했고 대비를 별도 확인했다. |
| `shortTextContent` | 2 | 짧은 숫자 셀이라 axe가 대비 판정을 보류했다. 일반 테이블 본문 색상/배경 조합을 별도로 확인했다. |
| `noRoleSingular` | 7 | React Flow가 생성한 `.react-flow__controls` generic `div`에 `aria-label="Control Panel"`이 붙어 있다. 각 자식 버튼에는 개별 접근성 이름이 있어 조작은 가능하지만, 컨테이너 그룹 이름은 유효하게 전달되지 않는다. 라이브러리 마크업 한계로 미완료 항목에 남긴다. |

Analysis coverage의 병합 셀 때문에 표 연결 검사가 복잡하다고 표시한 4개 기본 사례(테마 × 뷰포트)는 별도다. 캡처와 `scope`/`colSpan` 구조상 헤더가 시각적으로는 정상 연결됐지만, 실제 스크린리더의 행·열 헤더 발화는 이 환경에서 실행하지 않아 검증 완료로 처리하지 않았다. 물리 모바일 기기도 사용하지 않았다(320px Chrome 뷰포트 에뮬레이션만 사용).

수정된 표 CSS 코드 SHA는 `1f0b5557b8f6470bfc84d38701ac4c4d984d91e3`다. 이후 전체 실행 ID `2026-11-05T00-08-40-978Z-42916`에서 Node `v24.18.0`, pnpm `11.25.0`, Playwright `1.63.0`, axe-core `4.14.0`, Chrome `156.0.8078.80`으로 `pnpm test:ui:a11y` 2개 파일/14개 테스트가 통과했다. 사례 실행 결과는 제품 finding 0, 도구 오류 0, 120개 중 자동 상태 통과 12·미검증 108이고 `accessibilityVerificationComplete: false`다. 이 108개 상태는 감사기가 각 사례에 수동 판정 기록이 없어 붙인 상태이며, 위 표의 개별 검토 결과와 남은 항목을 구분해 읽어야 한다. 수정 후 전체 크기 캡처도 다시 확인했으며, 원 결과는 로컬 `.duo-a11y-runs/<runId>/cases.jsonl`에 보존했다.

### 검증 결과와 다음 게이트

- `pnpm verify` — 통과: 146개 파일, 1,428 passed, 7 skipped, 5 TODO. 문서 검증 125개 파일 통과 (52 requirements, 14 decisions, 22 issues, 5 milestones, 94 acceptance criteria, 226 links).
- `pnpm test:ui:a11y` — UI 코드 SHA `f0f196865df5209c52c8c5cba593516008a26b3d`에서 2개 파일, 14개 테스트 통과. 전체 실행 ID와 사례별 판정은 위 최신 기록 참조. 전체 접근성 검증은 미완료.
- 최초 `pnpm verify` 중 AVD 첫 부팅과 겹친 UI E2E 두 항목은 실패했으나, 두 항목을 격리 재실행해 통과했고 AVD를 중단한 뒤 전체 `pnpm verify`도 통과했다. 제품 결함으로 판단할 근거는 없으며 자원 경합 정황으로 기록한다.
- `pnpm docs:validate`와 `git diff --check`는 문서 변경 전 통과했다. 최종 문서 수정 후 다시 실행한다.
- 최종 코드·문서 커밋을 PR에 푸시한 뒤 Ubuntu·Windows·macOS CI를 확인하고 PR 설명을 갱신한다.
- PR #80 설명은 `Refs #73`을 유지하며 자동 종료 키워드를 넣지 않는다. #73은 열린 상태로 둔다. CI 및 모든 필수 수동 검증 결과가 확인되기 전에는 접근성 완료라고 표시하지 않는다.
