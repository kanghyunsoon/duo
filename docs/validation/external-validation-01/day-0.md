# Day 0: Pre-registration and onboarding

Send Part A privately before your first DUO command; keep the rest and send it when asked. Answers may be in English or Korean. Approximate values are fine. Do not include source code, keys, tokens, credentials, personal email or customer data. [Protocol §8](README.md#8-day-0)

## Part A — before installing DUO

Fill in Part A completely and send it privately before running any DUO command. It is not edited after it is sent. Your participant ID is assigned when you start installing ([protocol §27](README.md#27-pre-participant-clarifications-h-69)).

| Field | Answer |
|---|---|
| Date and time (with time zone) | |
| Study time zone (observation days are counted in it) | |
| Repository type (application, library, service, game, tool, other) | |
| Main language(s) | |
| Repository age (approx.) | |
| People working in it (approx.) | |
| Coding agent(s) you use there, and since when | |
| Public or private | |

**Pre-declared alternative.** If DUO did not exist, how would you keep coding agents (and people) aligned with your engineering decisions in this repository over the next two weeks? Describe what you would actually do, even if it is "nothing". Examples, for reference only: `AGENTS.md`, `CLAUDE.md`, ADRs or docs, a linter rule, a CI script, PR review, agent memory, nothing, other.

> 

**Why are you trying DUO?**

> 

**Engineering decisions you expect to matter in the next 14 days** (summaries are fine, at least three if you can):

1. 
2. 
3. 

## Part B — onboarding

Use only the public README, the npm package and `duoctl doctor`. Ask for help if you are stuck; it will be logged.

| Step | Time (start / end) | Worked? | Notes |
|---|---|---|---|
| Install (`npm install -g @duo-director/cli`) | | | |
| First successful `duoctl init` (onboarding complete) | | | |
| Agent connected (`duoctl install codex` / `claude-code`) | | | |
| `duoctl doctor` result | | | |
| First Decision confirmed | | | |
| First review | | | |

| Field | Answer |
|---|---|
| Participant ID (assigned when you start installing) | P_ |
| Verified CLI version (`duoctl --version`) | |
| Verified agent-invoked DUO version (`duoctl doctor --json`, agent check `version`) | |
| Help from the DUO author (what, how long) | |
| Setup minutes (approx., total) | |
| Initial friction (what was confusing or annoying) | |
| Observation day 1 (= day after first successful init, in your study time zone) | |
| Observation day 14 | |

