# 14-day event log

Write an entry only when something happens; no daily diary. Times are estimates. Answers may be in English or Korean. Do not paste source code or secrets; summarize instead. [Protocol §9–§13](README.md#9-14-day-observation)

**Event types:** Decision proposed · Decision confirmed · Decision rejected · Decision superseded · Review run · Useful finding · Noisy/false finding · Knowledge Gap · Context use · Agent switch · Truth maintenance · Author assistance · DUO skipped · Alternative tool used · Abandonment

**Useful finding** = something DUO showed made you fix code, revise or re-confirm a Decision, stop a change, investigate a problem, or write down missing intent. "Sounds right" is not enough.
**Noise** = a finding, WARN or gap with no action value for the task at hand (your judgment).

| Date | Event type | What happened | What you did | Time spent (min, approx.) | Useful / neutral / noisy | Would your alternative have handled it? (yes / no / partly / don't know) | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Optional, if they happen:

- **C239**: a WARN from a knowledge gap on a change you consider fine. Was it noise?
- **C240**: did the label `introduced` make you think this change added a violation that was already there?
- **C241**: after superseding a Decision, did you want the review to show which Decision is current and which was replaced?
- **Agent switch**: did the second agent see the same Decisions? Any mismatch or friction?
- **Context use**: why you used `duoctl context` or the agent's context tool, and whether the agent searched or read less.

## End of period (day 14)

| Field | Answer |
|---|---|
| Confirmed Decisions in `.duo-project/decisions/` (count) | |
| Added or superseded during the 14 days (count) | |
| Is `.duo-project/` up to date with your real decisions? If not, why | |
| Truth/Decision maintenance minutes (approx., total) | |
| Review interpretation minutes (approx., total) | |
| Author-help minutes (approx., total) | |

