---
name: pareto-focus
description: Top-10% valuable-work prioritization system. Surfaces three lanes — Do (existing high-leverage work), Push (in-flight strategic items), Propose (new project pitches that promote the user as a leader). Composes github-ops, exa-search, x-api, LinkedIn MCP. Anchored on user-maintained goals.md + expertise.md + teammates.md. Trigger when user invokes /focus, /focus-config, or asks "what should I work on", "what's most valuable", "what should I propose to the team".
---

# Pareto Focus

A composite prioritization system. Two jobs:

1. **Focus** — surface the top 10% of work that drives 80% of the outcome.
2. **Lead** — propose new ideas / scope new projects with teammates that add team value AND build the user's leadership reputation.

## Architecture

```
~/.claude/projects/pareto-focus/
├── config.yaml              # repos, topic queries, cadence toggles
├── data/
│   ├── time_log.jsonl       # passive PostToolUse hook output
│   ├── signals/YYYY-MM-DD/
│   │   ├── github.json
│   │   ├── papers.json
│   │   ├── x_linkedin.json
│   │   └── opportunities.json
│   └── briefs/YYYY-MM-DD.md
└── state/
    ├── goals.md             # personal_goals / team_alignment / leadership_aspirations
    ├── expertise.md         # what the user is known for + emerging strengths
    ├── teammates.md         # collaborators, their strengths, current work
    ├── priorities.md        # latest ranked priorities (regenerated)
    ├── proposals.md         # idea backlog with status: draft/pitched/accepted/dropped
    ├── weights.json         # tunable scoring weights
    └── decisions.log        # what was prioritized vs what user did (feedback)
```

## Pipeline

```
PostToolUse hook ────────► time_log.jsonl
                              │
                              ▼
ingest_github ──┐    aggregate_time
ingest_industry ┼────►  signals/*.json ──► detect_opportunities ──► opportunities.json
                              │                                          │
                              └──────────────► score_and_rank ◄──────────┘
                                                     │
                                                     ▼
                                           Do / Push / Propose
                                           today / week / month
```

## Scoring (the 20/80 + leadership-leverage core)

Two parallel scores per candidate:

```
exec_score = (strategic_fit × execution_leverage × urgency × recency_decay) / effort
lead_score = (visibility × novelty × team_fit × aspiration_match) × feasibility
```

Lane assignment:
| Lane | Source | Ranked by |
|---|---|---|
| **Do** | existing work + time_log + github | exec_score |
| **Push** | in-flight strategic items at drift risk | exec_score × drift_penalty |
| **Propose** | opportunities.json | lead_score |

Each Propose item carries: pitch, why-it's-the-gap (cited signals), suggested collaborator (from teammates.md), first concrete step.

## When invoked

1. **First-run check**: confirm `state/goals.md`, `state/expertise.md`, `state/teammates.md` are non-empty. If empty, prompt user to fill the templates.
2. **Refresh signals** as needed (call ingestors if today's signal files are stale or missing).
3. **Run scorer** → emit Do/Push/Propose lanes scoped to the requested cadence (today/week/month).
4. **Cite evidence** — every recommendation references the signal that surfaced it (paper title, PR id, time-log %).

## Quality bar (HARD REQUIREMENTS)

Every recommendation must clear these bars before being shown to the user. Trivial or low-value items are bugs in this skill, not acceptable output.

**Never recommend:**
- "Write ARCHITECTURE.md / README / docs" — chore-tier maintenance, not leadership.
- "Drive resolution on PR/issue #N" when the author is NOT the user (`config.user.github_handle`). Other people's PRs are theirs to land. The user can review, but framing it as "drive" or "own" is presumptuous and false.
- "Share paper X in team channel" with no concrete scope — that's a slack message, not a project.
- "Apply paper X to repo Y" when the paper topic does not actually overlap repo topics (e.g. 3D vision papers → long-context training repo). Require real keyword overlap, not freshness × name match.
- Stale TODO cleanup (single-line resolutions). They're noise.

**The Propose lane (5 items) MUST be a mix:**
- 2–3 **ambitious** items: new project pitches that combine the user's expertise + a real signal + multiple repos / a cross-cutting capability. They should produce a visible artifact (RFC, eval harness, new training recipe, internal demo) over 4–8 weeks.
- 2–3 **practical** items: scoped, week-shippable execution work the user can author themselves — a benchmark, an ablation, a specific PR landing the user's own branch, a measurement script. Each must tie to a concrete `team_alignment` or `personal_goals` line.

**If the candidate pool can't produce a real mix:** say so explicitly. Don't pad with chores. A short briefing with 2 great items beats 5 with filler.

**Each Propose item must answer:**
1. *What's the artifact?* (RFC name, eval harness module, PR title, benchmark report)
2. *Why is it your lane?* (cite expertise.md or current activity in time_log)
3. *What's the first concrete week?* (not "share in channel" — an actual deliverable)
4. *Who is the natural collaborator?* (from teammates.md, with a reason)

## Sub-commands

| Command | Behavior |
|---|---|
| `/focus today` | 3-lane briefing for today |
| `/focus week` | weekly 3-lane briefing + drift report |
| `/focus month` | monthly review + 1 RFC-grade proposal to draft |
| `/focus propose` | Propose lane only, deeper: 3–5 pitches with one-pager scaffolds |
| `/focus pitch <id>` | promote opportunity to draft RFC in `state/proposals.md` |
| `/focus-config` | open `config.yaml` |

## Composed skills (do NOT reimplement)

- `github-ops` — repo activity, PRs, issues, CI
- `exa-search` — papers, blogs, neural web search
- `x-api` — X/Twitter timeline + trends
- `mcp__linkedin__*` — LinkedIn company/person posts
- `knowledge-ops` — persist briefs, decisions
- `chief-of-staff` agent — orchestration pattern reference

## Cadence toggles (config.yaml)

```yaml
cadences:
  morning_brief:    { enabled: false, time: "07:00" }
  end_of_day:       { enabled: false }
  weekly_review:    { enabled: false, day: "fri", time: "16:00" }
  monthly_review:   { enabled: false, day: "last", time: "16:00" }
```

All four ship in v1; user enables individually via `/focus-config`.

## Drift detection

Cross-reference `time_log.jsonl` rollup against `goals.md`. Surface lines like:
> "Last week: 30% on `nlp.widgets`, 8% on `nlp.longcontext`. Your #1 leadership aspiration is 'drive long-context strategy' — consider rebalancing or surfacing widget work as a leadership artifact."

## Slack: phase 2

Not in v1 per scope decision. `ingest_slack.js` may be added later.
