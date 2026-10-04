# Cohort evaluation (template)

Filled in once, after every primary participant has finished or dropped out. Criteria are those of [protocol §16–§18](README.md#16-continue-criteria) and must not be changed here. The participant's own answers decide useful, noise, acceptable and chosen; the evaluator does not reinterpret them. Items that cannot be checked after redaction are **Unverifiable** and do not count in DUO's favor. Exit answers not received within 7 days of the request are **Missing**: the alternative is not assumed and exit-dependent Continue conditions are not met ([protocol §27](README.md#27-pre-participant-clarifications-h-69)).

## Round

| Field | Value |
|---|---|
| recruitment_opened_at | |
| recruitment_deadline | |
| Eligible participants who started Day 0 by the deadline | |
| DUO version(s) used (with dates of any hotfix) | |
| Paused? (reason, Human Decision) | |

## Participants

| Field | P1 | P2 | P3 |
|---|---|---|---|
| Day 0 / observation start / end | | | |
| Pre-declared alternative | | | |
| Completed 14 days? (or dropout day and reason) | | | |
| Minimum usage met? (within days 1–14: 3 confirmed Decisions, 1 add/supersede, reviews; end check) | | | |
| Useful findings | | | |
| Noisy findings (of which C239) | | | |
| Truth abandoned? (§13) | | | |
| Maintenance acceptable? (participant) | | | |
| Ongoing maintainer help needed? (log + participant) | | | |
| Author interventions (count / minutes) | | | |
| Final choice: DUO or alternative | | | |
| Critical correctness/security problem? | | | |
| Unverifiable items | | | |

## Continue (all five for at least 2 of 3, and no critical problem in the cohort)

| Condition | P1 | P2 | P3 |
|---|---|---|---|
| Completed the 14-day workflow | | | |
| Used without ongoing maintainer help | | | |
| At least one real useful finding | | | |
| Truth maintenance acceptable | | | |
| Keeps choosing DUO over the pre-declared alternative | | | |

No critical correctness/security problem in the cohort: yes / no

## Kill (any one)

| ID | Condition | Met? | Evidence |
|---|---|---|---|
| A | fewer than 3 eligible participants started by the deadline | | |
| B | 2 or more of 3 stopped using DUO during observation (including onboarding dropout) | | |
| C | 2 or more of 3 chose the pre-declared alternative at the end | | |
| D | useful findings = 0 across the cohort | | |
| E | 2 or more of 3 found Truth maintenance unacceptable or abandoned Truth | | |
| F | 2 or more of 3 had more noise than useful findings and named the noise as a reason not to continue | | |
| G | a critical correctness/security issue made continued use impossible | | |

## Result

**External Validation Gate:** CONTINUE / KILL / INCONCLUSIVE

- CONTINUE: candidate only; feature work resumes only with a new Human Decision.
- KILL: recommend Option E.
- INCONCLUSIVE: one more round (external-validation-02) with the same criteria; a second INCONCLUSIVE means Option E.

## Observations (not gate criteria)

| Topic | Summary |
|---|---|
| C239 knowledge-gap WARN as noise | |
| C240 `introduced` misread | |
| C241 wish to see current/superseded authority in review | |
| Multi-agent use (or Untested) | |
| Context use (or not used) | |
| Most common friction | |
| Feature requests recorded (not built) | |

Human Decision recording the result: H-__

