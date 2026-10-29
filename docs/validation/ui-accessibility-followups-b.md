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
| Chrome 브라우저 UI 경계 | Overview와 일반 HTML 대조 화면에서 Tab·Shift+Tab, 브라우저 UI로 이동 후 복귀 위치 | 미검증: 실제 표시 세션에서 브라우저 크롬의 포커스 이동을 관찰하지 않음 |
| 복잡한 표 4개 사례 | 실제 스크린리더의 행·열 헤더 연결 및 읽기 | 미검증: 자동 표 규칙 결과만으로 헤더 읽기를 확정할 수 없음 |

이 실행은 앱 내부 자동화 결과이며, 전체 캡처 126개를 전부 수동 판독했다거나 Narrator/TalkBack의 실제 음성 출력을 확인했다는 근거가 아니다. 브라우저 UI 경계 판별도 없으므로 해당 검증은 완료로 표시하지 않는다. Android의 기기 이미지/OS 세부 버전, Chrome·TalkBack 버전, 글자 크기와 화면 배율은 성공적으로 구동된 검증 세션에서 측정하지 못해 기록하지 않는다.

### 검증 결과와 다음 게이트

- `pnpm verify` — 통과: 146개 파일, 1,428 passed, 7 skipped, 5 TODO. 문서 검증 125개 파일 통과 (52 requirements, 14 decisions, 22 issues, 5 milestones, 94 acceptance criteria, 226 links).
- `pnpm test:ui:a11y` — 검증 코드 SHA `15f65d4be8441e1c90d3be98cd01d4f778814120`에서 2개 파일, 14개 테스트 통과. 감사 결과는 120개 사례, 누락·중복·도구·정리 오류 0, 전체 접근성 검증 미완료.
- 최초 `pnpm verify` 중 AVD 첫 부팅과 겹친 UI E2E 두 항목은 실패했으나, 두 항목을 격리 재실행해 통과했고 AVD를 중단한 뒤 전체 `pnpm verify`도 통과했다. 제품 결함으로 판단할 근거는 없으며 자원 경합 정황으로 기록한다.
- 문서 전용 커밋 SHA는 생성 후 PR 설명의 검증 링크와 함께 고정한다. 코드·감사 규칙·fixture는 검증 SHA와 동일하게 유지한다.
- `pnpm docs:validate`와 `git diff --check`는 문서 커밋 직전 다시 실행한다. 문서 커밋 뒤 최종 HEAD의 Ubuntu·Windows·macOS CI를 확인하고 CI 링크를 PR 설명에만 기록한다.
- PR #80 설명은 `Refs #73`을 유지하며 자동 종료 키워드를 넣지 않는다. #73은 열린 상태로 둔다. CI 및 모든 필수 수동 검증 결과가 확인되기 전에는 접근성 완료라고 표시하지 않는다.
