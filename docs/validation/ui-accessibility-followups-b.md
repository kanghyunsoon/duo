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
