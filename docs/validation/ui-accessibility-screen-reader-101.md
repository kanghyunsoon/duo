# Accessibility screen-reader review — Issue #101

## Scope

This report records the four-screen review for [GitHub issue #101](https://github.com/kanghyunsoon/duo/issues/101): Overview, Pending decisions, Review, and Work map. It covers actual NVDA announcements in Chrome and every axe `incomplete` result associated with those screens.

This is a targeted manual accessibility review. It is not a claim of WCAG conformance, and it does not change the audit classification code.

## Environment and evidence

| Field | Value |
|---|---|
| Tested code SHA | `6224610d96136798e3b516987305814b13cefbbb` (PR #80 head used as the assigned base) |
| Audit run ID | `2026-11-05T01-53-45-534Z-29560` |
| Operating system | Windows Enterprise 25H2, build `26200.9711` |
| Screen reader | NVDA `2026.2`, portable copy, add-ons disabled |
| Browser | Chrome `155.0.8059.85` |
| Runtime | Node `v24.18.0`, pnpm `11.25.0`, Playwright `1.63.0`, axe-core `4.14.0` |
| Viewports in the automated run | Desktop `1280×800` and mobile `320×800`, light and dark themes |

The automated audit used a copy of `fixtures/review/app` with an index, two pending proposals, one recorded review, and an uncommitted report change. The manual listening session used the same fixture basis and a locally built `duoctl ui` server on `127.0.0.1`. A human reviewer independently drove the documented Work map Tab, Enter, and Space interactions in Chrome while NVDA was running; the bounded NVDA log was used only to transcribe the resulting announcements.

`pnpm test:ui:a11y` completed all 120 expected cases: 12 automated pass cases, 108 mechanically unverified cases, 0 product findings, 0 tool errors, no missing or duplicate cases, and no cleanup errors. `executionComplete` was `true`. The raw run's `accessibilityVerificationComplete` remains `false` because the audit output does not ingest these later manual decisions and separately records screenshot-review findings.

Raw JSON, JSONL, screenshots, the local server session URL, and machine-specific paths remain in the ignored local audit directory and are not committed.

## NVDA results — Overview

The reviewer used NVDA Speech Viewer while the external Chrome window was focused. The table records the actual announcements relevant to the acceptance criteria. Text from other applications was excluded.

| Check | Actual announcement or observation | Decision |
|---|---|---|
| Browser and document title | `DUO — Project Direction Console - Chrome window`; `DUO — Project Direction Console document` | Pass — the window and document identify the product and page context. |
| Page heading | `Overview region heading level 1 Overview` | Pass — the page exposes one clear level-one heading. |
| Section headings | `Analysis coverage heading level 2 button expanded`; `Declared knowledge gaps (1) heading level 2 button expanded` | Pass — both disclosure headings expose their level, button role, name, count where applicable, and current state. |
| Disclosure state changes | Activating Analysis coverage announced `collapsed`, then `expanded`; repeated activation announced the same state changes. | Pass — expanded/collapsed state changes are announced. |
| Main landmark | `clickable main landmark Overview region Overview heading level 1` | Pass — main content and its Overview label are available through landmark navigation. |
| Navigation landmark | `DUO navigation landmark DUO Project Direction Console`; Tab traversal announced a list with 10 items. | Pass — the navigation landmark has a stable name and list structure. |
| Navigation links | `Overview` (current page), `Direction`, `Pending decisions`, `Work map`, `Graph`, `Analysis coverage`, `Context`, `Review`, `Review history`, and `Search` were announced as links. | Pass — all ten visible destinations have matching accessible names; Overview is announced as the current page. |
| Skip link | `Skip to content same page link` | Pass — keyboard users receive a named in-page skip link before navigation. |
| Refresh button | After navigation traversal entered main content, NVDA announced `Refresh button`. | Pass — the visible action has a matching accessible name and button role. |
| Local-only explanation | `Local only. Project Truth changes require human Decision actions; work activity is local runtime data.` | Pass — the scope and authority explanation is exposed as text. |

Initial forward quick-navigation attempts reported `no next landmark` and `no next button` because the virtual cursor was already after those targets. Reverse landmark navigation and full Tab traversal exposed the named main/navigation landmarks and Refresh button, so those messages are not product findings.

No missing, incorrect, or misleading Overview announcement was found in the reviewed flows. No product issue was opened for this screen.

## NVDA results — Pending decisions

| Check | Actual announcement or observation | Decision |
|---|---|---|
| Page and main content | `Pending decisions` was announced as the current navigation link, main landmark, region, and level-one heading. `Refresh` was announced as a button. | Pass — the route and main content are identifiable. |
| Introductory status | The human-decision explanation and the loading status were announced before the loaded content replaced the status. | Pass — purpose and asynchronous state are available. |
| Pending section | `Pending (2) heading level 2 button expanded` | Pass — the disclosure name, count, role, level, and state are exposed. |
| Proposal actions | `Confirm… button` and `Reject… button` | Pass — both human actions have visible matching names. |
| Confirm dialog | `Confirm P-001? dialog`, the confirmation consequence, and a form landmark were announced. The initial edit was announced as `Type P-001 to confirm`, blank. `Cancel` was announced as a button. | Pass — role, title, consequence, input label, and cancellation are available. |
| Confirm dialog close | Closing without submission returned traversal to the proposal's `Confirm…` and `Reject…` actions. | Pass — the trigger context is restored. |
| Reject dialog | `Reject P-001? dialog`, the permanent-record explanation, form landmark, and `Reason (optional) edit multi line blank` were announced. `Cancel` was announced as a button. | Pass — role, title, consequence, optional input, and cancellation are available. |
| Reject dialog close | Closing returned focus to `Reject… button`. | Pass — focus returns to the invoking action. |

Transient `unknown` speech while the native dialog opened and the Korean OneCore voice's `English (not supported)` language message did not replace or hide the subsequent dialog title, description, form, or controls. They are environment transitions rather than DUO product findings.

No missing or incorrect Pending decisions announcement was found. No action was submitted, and no Decision or rejection record was created during listening.

## NVDA results — Review

| Check | Actual announcement or observation | Decision |
|---|---|---|
| Page and form | `Review` was announced as the current link, main region, level-one heading, and form landmark. | Pass — route and form structure are identifiable. |
| Inputs | `From edit HEAD`, `To edit WORKTREE`, and `Task (optional) edit blank` | Pass — labels, current values, and optional state are available. |
| Semantic assistance | `Use semantic assistance check box not checked`; changing it announced `checked` and `not checked`. | Pass — name and state changes are announced. |
| Submission state | The action changed to `Reviewing… button unavailable`. | Pass — the busy label and unavailable state are announced. |
| Result | `Deterministic review: PASS heading level 2`, followed by the explanation of what PASS means and the diff metadata. | Pass — result and limitation are announced without relying on the decorative check mark. |
| Claims table | NVDA announced the `Review claims` region, table, six column headers, row numbers, and each cell under its column. Evidence counts were named collapsed buttons. | Pass — row/column associations and evidence actions are available. |
| Result sections | `Claims (3)` and `Knowledge gaps (0)` were level-two expanded buttons; `Limitations (2)` was a level-two collapsed button; Semantic assistance was a level-two expanded button and reported `disabled`. | Pass — section names, counts, and states are exposed. |

The observed review made zero LLM calls. No missing or incorrect Review announcement was found, and no product issue was opened.

## NVDA results — Work map

The Work map session used a dedicated NVDA debug log. Only the speech interval between entering the DUO Work map window and returning to the chat was assessed; unrelated application speech was excluded.

| Check | Actual announcement or observation | Decision |
|---|---|---|
| Page and form | `Work map` was announced as the current link, main landmark, region, and level-one heading. Agent and Work name were required edits, DUO Issue ID was optional, and Add work was a button. | Pass — page and form controls have matching names and required/optional information. |
| Summary | `1 work items`, `4 context nodes`, `5 links`, and `Index current` | Pass — graph scope and index state are text, not color-only information. |
| Graph region | `Work and DUO relationship graph region application` | Pass — the interactive graph has a stable region name. |
| Initial node | `AGENT WORK CURRENT [Audit] Keyboard graph selection Working now`, node, `pressed`, followed by Enter/Space instructions. | Pass — visible node content and selected state are announced. |
| Other nodes | Worktree, file, document, Decision, and specification nodes were announced with type, name, path or branch, node role, and `not pressed`. | Pass — nodes are distinguishable without visual position or color. |
| Keyboard selection | Selecting `OTHER D-004.yaml .duo-project/decisions` changed its state to `pressed`; other nodes became `not pressed`. Space selection also produced a `pressed` state change. | Pass — Enter and Space expose the selected state. |
| Detail synchronization | After D-004 selection, the complementary landmark changed to `SELECTED OTHER`, `Stateless refresh tokens` level-two heading, source path, link, Connections heading, and related actions. | Pass — selected-node state and detail content stay synchronized. |
| Graph controls | `Zoom In button`, `Zoom Out button`, and `Fit View button`; React Flow attribution was announced as a link. | Pass — each operation remains individually named even though the generic controls wrapper has no supported group role. |
| Detail region | `Selected node detail complementary landmark`, level-two selected title, level-three Connections heading, named connection buttons, and additional controls | Pass — detail and connection actions are navigable by landmark and control name. |

No missing or incorrect Work map announcement was found, and no product issue was opened.

## axe `incomplete` decisions

### Overview

The Overview screen has one repeated axe rule-result pattern across five case IDs. There are no Overview supplemental-table `incomplete` results.

| Case IDs | Rule and target | Manual decision | Reason |
|---|---|---|---|
| `base-Overview-light-desktop`, `base-Overview-light-mobile`, `base-Overview-dark-desktop`, `base-Overview-dark-mobile`, `keyboard-navigation` | `color-contrast`; `span[aria-hidden="true"]`; HTML `<span aria-hidden="true">✓ </span>`; axe message `Element content contains only non-text characters` | Pass | The check mark is a decorative, accessibility-hidden prefix inside the verdict badge. The same badge exposes the visible text `PASS`, so neither meaning nor state depends on the check mark's color or glyph. NVDA did not expose the decorative mark as separate content. The non-text-only target therefore does not represent a user-facing contrast defect. |

The other Overview records contain no axe `incomplete` item:

- `support-Overview`
- `로딩-Overview`
- `API 오류-Overview`

Those records may remain mechanically unverified for screenshot review tracked outside this screen-reader and axe-incomplete decision.

### Pending decisions

All Pending decisions `incomplete` results are `color-contrast` records that axe could not calculate while a native modal and backdrop overlapped the document. They cover 32 node records in 12 open-dialog and Escape-focus cases; there are no supplemental-table incomplete results.

| Case IDs | Targets | Decision and reason |
|---|---|---|
| `modal-confirm-{light,dark}-desktop` and the corresponding `-escape-focus` cases | Confirmation paragraph; two muted explanatory spans; confirmation label | Pass — axe reported background overlap rather than a measured failure. PR #80's manual screenshot review found no dialog clipping or overlap, and the reviewed text uses the dialog's normal text/muted token combinations. NVDA exposed the consequence, explanations, and input label. |
| `modal-confirm-{light,dark}-mobile` and the corresponding `-escape-focus` cases | `#c-P-001`; confirmation paragraph; `confirmed Decision` strong text | Pass — axe reported partial obstruction while the tall native dialog was inside a 320px viewport. The dialog is scrollable, PR #80's mobile capture review found no inaccessible clipping, and NVDA announced the title and consequence as dialog content. |
| `modal-reject-{light,dark}-mobile` and the corresponding `-escape-focus` cases | Rejection explanation paragraph | Pass — the result is the same modal/backdrop partial-overlap uncertainty, not a measured contrast failure. The paragraph was present in the reviewed captures and announced in full by NVDA. |

The base list, loading/error, empty, and modal-keyboard records contain no axe incomplete item for this screen.

### Review

| Case IDs | Rule and target | Decision | Reason |
|---|---|---|---|
| `form-review`, `form-review-validation` | `color-contrast`; `span[aria-hidden="true"]`; decorative `✓` | Pass | The check mark is accessibility-hidden and redundant with visible `PASS` text. NVDA announced `Deterministic review: PASS` without exposing the glyph. No meaning depends on the non-text character. |

No other Review case contains an axe or supplemental-table incomplete result.

### Work map

The seven populated Work map cases are `base-Work map-{light,dark}-{desktop,mobile}`, `workmap-keyboard`, `form-work-add`, and `form-work-validation`. There are no supplemental-table incomplete results.

| Rule and targets | Applicable cases | Decision and reason |
|---|---|---|
| `aria-prohibited-attr` on `.react-flow__controls` | All seven populated cases | Pass — React Flow places `aria-label="Control Panel"` on a generic `div`, so that wrapper name is not exposed as a group. The wrapper does not convey required state or instructions, and NVDA exposed its three child operations individually as `Zoom In`, `Zoom Out`, and `Fit View` buttons. The unsupported redundant wrapper label creates no user-facing barrier. |
| `color-contrast` on task/current/focus/muted node type, title, and subtitle elements, including `.work-node-live` | All seven populated cases, with focus/muted variants in `form-work-add` | Pass — axe could not calculate colors through the React Flow canvas composition. PR #80 separately measured the corrected selected-node endpoints at 6.37:1 and 8.02:1 and ordinary node text at 6.26:1 light and 6.74:1 dark. NVDA also exposed node type, name, subtitle, and selected state as text. |
| `color-contrast` on worktree, file, document, Decision, and specification node type/title/subtitle selectors | Desktop base cases, `workmap-keyboard`, `form-work-add`, and/or `form-work-validation` as listed in the raw records | Pass — these selectors use the same corrected node text/background tokens. The differences are graph visibility and generated node data, not distinct color pairs. PR #80's capture and ratio review covers the rendered node combinations, and NVDA announced each node's type, title, and secondary label. |
| `color-contrast` on `.work-detail-kicker` and the selected-detail `h2` | `form-work-add` | Pass — axe reported overlap uncertainty after adding and selecting work, not a measured low ratio. PR #80's screenshot review found the detail panel readable, and NVDA announced the selected kind and level-two detail title. |
| `color-contrast` on the React Flow attribution link | All seven populated cases | Pass — axe stopped at the SVG/image child. PR #80 measured the corrected link at 6.21:1 light and 4.76:1 dark; NVDA announced `React Flow attribution` as a link. |

These grouped rows cover all 110 Work map incomplete node records. The exact per-case selectors remain in the local run's `cases.jsonl`; grouping does not omit any distinct color or ARIA reason.

## Reviewer reproduction

1. Check out the tested code or a later `next` revision containing PR #80, then run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm test:ui:a11y` without a test-name filter.
2. Prepare any small repository with `duoctl init`, an index, two pending proposals, a recorded review, and one Work map task.
3. Start `duoctl ui`, open the four reviewed routes in Chrome, and run NVDA Speech Viewer or a bounded NVDA debug log.
4. On Overview, confirm headings, named landmarks, navigation links, Refresh, and disclosure states.
5. On Pending decisions, open Confirm and Reject without submitting either action; confirm dialog titles, explanations, inputs, cancellation, and trigger restoration.
6. On Review, submit the default deterministic review; confirm form names, busy state, result heading/verdict, claims table headers, and section states.
7. On Work map, Tab through the graph, select different nodes with Enter and Space, and confirm pressed state, detail synchronization, and the three named graph controls.
8. Compare the audit's incomplete records with the grouped decisions above and repeat at least one result independently.

## Completion status

All four screens assigned in issue #101 have actual NVDA results and a reasoned decision for every axe incomplete record. No product finding was identified, so no follow-up bug was opened.

The raw run's `accessibilityVerificationComplete` remains `false`: the generated artifacts preserve their original mechanical findings, and screenshot-only review is tracked separately. This report supplies the manual evidence for issue #101 without rewriting audit output or claiming WCAG conformance.
