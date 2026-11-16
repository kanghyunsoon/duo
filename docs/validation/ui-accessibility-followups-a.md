# Accessibility follow-up report — PR A (#70–#72)

This report covers the mobile layout, Work map selection, and Work map accessibility changes in PR A. It has its own baseline, result, and raw run ID so a later PR can keep its evidence separate.

## Reproduction basis

- Base branch: `next`
- Base SHA: `0521fd77c0681988a09a27f0ea826d983bb52563` (includes merged PR #63)
- Tested HEAD: `d2904dfd67a22a62e50cc2b65cfdc0cdb42d76dc`
- Audit run ID: `2026-10-23T07-52-30-814Z-24016`
- Started: `2026-10-23 07:52:30 UTC`
- Environment: Windows, Node `v24.18.0`, pnpm `11.25.0`, Playwright `1.63.0`, Chrome `155.0.8059.85`, axe-core `4.14.0`
- Audit rules: artifact schema 3; WCAG 2 A/AA, WCAG 2.1 A/AA, WCAG 2.2 AA; supplemental table rules `td-has-header`, `td-headers-attr`, `th-has-data-cells`, `scope-attr-valid`, `empty-table-header`
- Fixture: `fixtures/review/app`, indexed with two pending proposals, one recorded review, and one Work map task

Raw JSONL and screenshots stay in the ignored local audit run directory and are not part of the PR. The report records the run ID without publishing a machine-specific path.

## Result

The audit recorded all 120 expected cases with no missing or duplicate IDs, tool errors, or cleanup errors. The summary reports 12 pass cases, 1 case with a product finding, and 107 cases whose overall status remains unverified. A total of 108 cases still contain an unverified finding, so `executionComplete` is `true` and `accessibilityVerificationComplete` is `false`.

The remaining product finding is `keyboard-navigation` and is tracked separately by [#73](https://github.com/kanghyunsoon/duo/issues/73). The seven expected Overview targets were found once, in order, and all had visible, unobscured focus. The audit still observes `BODY` after the final target; PR B will compare forward and reverse traversal with a normal HTML page before revising this classification. Browser chrome boundary movement and return have not been observed and remain unverified.

## Per-case finding changes

Compared with audit run `2026-10-23T07-36-04-993Z-25256` on the same 120 case IDs, 29 cases lost their previous product finding:

- **#70, 22 mobile overflow cases:** document width is now `320/320` in every listed case. This includes seven screens in both themes (`base-Direction-*`, `base-Pending decisions-*`, `base-Graph-*`, `base-Analysis coverage-*`, `base-Review history-*`, `base-Search-*`, `base-Review detail-*`) and the eight mobile Confirm/Reject dialog cases (`modal-confirm-{light,dark}-mobile`, each with `-escape-focus`, and `modal-reject-{light,dark}-mobile`, each with `-escape-focus`).
- **#72, 7 Work map cases:** `label-content-name-mismatch` no longer appears in `base-Work map-{light,dark}-{desktop,mobile}`, `workmap-keyboard`, `form-work-add`, or `form-work-validation`. Work map nodes expose their visible contents as button names and keep `aria-pressed` synchronized with the selected state; the canvas is a named region.
- **#71:** `workmap-keyboard` no longer has a product finding. The browser regression checks Tab focus without detail changes, Enter/Space, mouse and connection selection, clearing, multi-selection, deletion, and refresh preservation.

The 1280px screens and both themes are included in the full audit. A separate browser regression checks all 12 routes at 320px in light and dark themes, both Decision dialogs with long unbroken content, and those routes at 1280px.

## Code verification

- `pnpm verify`: passed; 142 test files, 1,331 passed, 7 skipped, 5 TODO; documentation validation passed for 151 files.
- `pnpm exec vitest run tests/ui/ui.browser.e2e.test.ts --reporter=verbose`: passed, 8/8 tests. This includes the mobile layout, Decision dialog, Work map keyboard selection, and Work map axe `nested-interactive` checks.
- `pnpm test:ui:a11y`: passed at the tested HEAD; 120 cases, 0 missing/duplicate IDs, 0 tool errors, 0 cleanup errors, `executionComplete: true`, `accessibilityVerificationComplete: false`.

## Issue links

- [#70 Mobile horizontal overflow](https://github.com/kanghyunsoon/duo/issues/70)
- [#71 Work map selection and detail synchronization](https://github.com/kanghyunsoon/duo/issues/71)
- [#72 Work map accessible structure](https://github.com/kanghyunsoon/duo/issues/72)
- [#73 Overview focus-order classification](https://github.com/kanghyunsoon/duo/issues/73), still under separate investigation
