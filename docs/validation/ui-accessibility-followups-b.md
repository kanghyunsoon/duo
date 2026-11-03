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

This is a viewport-emulation result. Physical mobile device and browser UI boundary checks still require manual evidence. Final-head Ubuntu, Windows, and macOS CI is required before marking the PR Ready.`r`n`r`n## PR #80 최신 실행 및 수동 검증 기록

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

## 2026-11-03: Unverified 108-case screenshot triage

`108`은 서로 다른 결함 108개가 아니라, 전체 120개 감사 사례 중 자동 판정 후 검토 기록이 없어 `미검증`으로 남은 사례 행의 수다. 최신 원본에서 axe의 실제 `violations`는 0개다. axe `incomplete` 결과는 80개( `aria-prohibited-attr` 44개, `color-contrast` 36개)이며, axe가 결론을 내리지 못한 결과이지 위반으로 확정된 결과는 아니다.

최신 실행이 참조한 캡처 124장을 화면 축소 이미지로 분류했고, 모바일 표 화면 세 곳은 원본 크기로 확인했다. 여섯 캡처에서 실제 가독성 문제가 보인다.

| 사례 | 조건 | 관찰 |
| --- | --- | --- |
| `base-Analysis_coverage-light-mobile`, `base-Analysis_coverage-dark-mobile` | 320×800, 밝음·어두움 | 9열 표의 머리글과 셀 문자가 한두 글자 단위로 세로 줄바꿈되어 읽기 어렵다. |
| `base-Review history-light-mobile`, `base-Review history-dark-mobile` | 320×800, 밝음·어두움 | 이력 표의 열 제목과 값이 매우 좁은 열로 압축되어 단어가 여러 줄로 쪼개진다. |
| `base-Review detail-light-mobile`, `base-Review detail-dark-mobile` | 320×800, 밝음·어두움 | Claims 표가 같은 방식으로 압축되어 머리글과 값의 가독성이 떨어진다. |

여섯 사례 모두 문서 너비는 320px로 측정되어 페이지 자체의 가로 넘침은 없지만, 그 측정만으로 표가 읽을 수 있는지는 보장되지 않았다. 원인은 표가 기본 `width: 100%`로 스크롤 컨테이너 폭에 맞춰 축소되는 것이었다. `.table-scroll > table { min-width: max-content; }`를 적용해 표의 콘텐츠 너비를 유지하고, 좁은 화면에서는 기존 스크롤 컨테이너가 가로 탐색을 맡도록 수정했다.

수정 후 실제 Chrome에서 여섯 조합(세 화면 × 밝음·어두움)을 다시 확인했다. 320×800에서 Analysis coverage 표는 1000px, Review history는 1095px, Review detail은 1197px가 되었고, 각 스크롤 컨테이너의 너비는 288px, 288px, 262px였다. 여섯 경우 모두 `scrollWidth > clientWidth`였으며 컨테이너를 끝까지 움직일 수 있었다(최대 `scrollLeft`: 각각 712px, 807px, 935px). 문서 `scrollWidth`는 계속 320px로 유지됐다. 새 전체 감사 캡처에서도 세 표의 머리글과 값이 더는 글자 단위로 쪼개지지 않고, 나머지 열은 표 안에서 가로 스크롤해 볼 수 있다.

수정 코드 SHA는 `1db86c655eff3cee7c0464e64e0d3d91eb24314f`, 전체 재검증 실행 ID는 `2026-11-03T06-28-23-736Z-8248`이다. Node `v24.18.0`, pnpm `11.25.0`, Playwright `1.63.0`, axe-core `4.14.0`, Chrome `156.0.8078.80` 환경에서 120개 사례 전체 실행이 완료됐고 2개 파일/14개 테스트가 통과했다. 최신 실행 결과는 제품 문제 0, 도구 오류 0, 미검증 108이며 `accessibilityVerificationComplete: false`다. 캡처 경로와 원 결과는 로컬 `.duo-a11y-runs/<runId>/cases.jsonl`에 보존했다.

이번 분류와 수정은 캡처에서 확인된 표 가독성 문제를 해결했지만, 실제 스크린리더의 표 헤더 연결·발화, 나머지 axe `incomplete` 항목의 최종 판정, 실제 모바일 기기 동작은 검증하지 않았다. 따라서 108개 상태를 통과로 바꾸거나 전체 접근성 검증을 완료했다고 주장하지 않는다. 남은 수동 검증은 108개를 각각 다시 실행하는 방식이 아니라, 공통 동작별 대표 사례와 식별된 예외를 대상으로 좁혀야 한다.

### 검증 결과와 다음 게이트

- `pnpm verify` — 통과: 146개 파일, 1,428 passed, 7 skipped, 5 TODO. 문서 검증 125개 파일 통과 (52 requirements, 14 decisions, 22 issues, 5 milestones, 94 acceptance criteria, 226 links).
- `pnpm test:ui:a11y` — 검증 코드 SHA `15f65d4be8441e1c90d3be98cd01d4f778814120`에서 2개 파일, 14개 테스트 통과. 감사 결과는 120개 사례, 누락·중복·도구·정리 오류 0, 전체 접근성 검증 미완료.
- 최초 `pnpm verify` 중 AVD 첫 부팅과 겹친 UI E2E 두 항목은 실패했으나, 두 항목을 격리 재실행해 통과했고 AVD를 중단한 뒤 전체 `pnpm verify`도 통과했다. 제품 결함으로 판단할 근거는 없으며 자원 경합 정황으로 기록한다.
- 문서 전용 커밋 SHA는 생성 후 PR 설명의 검증 링크와 함께 고정한다. 코드·감사 규칙·fixture는 검증 SHA와 동일하게 유지한다.
- `pnpm docs:validate`와 `git diff --check`는 문서 커밋 직전 다시 실행한다. 문서 커밋 뒤 최종 HEAD의 Ubuntu·Windows·macOS CI를 확인하고 CI 링크를 PR 설명에만 기록한다.
- PR #80 설명은 `Refs #73`을 유지하며 자동 종료 키워드를 넣지 않는다. #73은 열린 상태로 둔다. CI 및 모든 필수 수동 검증 결과가 확인되기 전에는 접근성 완료라고 표시하지 않는다.
