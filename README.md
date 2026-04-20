# Pareto Focus

A prioritization system for Claude Code that surfaces the top 10% of
valuable work and pitches new projects for leadership leverage.

**Three lanes per brief:**
- **Do** — existing high-leverage work ranked by execution score
- **Push** — in-flight strategic items at drift risk
- **Propose** — new project pitches ranked by leadership-leverage score,
  blending paper/industry signals × your repos × your expertise

## Install

```bash
# 1. Clone into your skills dir
git clone git@github.com:YOUR_USER/pareto-focus.git ~/.claude/skills/pareto-focus

# 2. Run the installer (symlinks slash commands into ~/.claude/commands/,
#    bootstraps state files)
cd ~/.claude/skills/pareto-focus && ./install.sh
```

## First-run setup

```bash
# Open the config and fill in:
#  - projects_root        (default ~/Projects)
#  - user.github_handle   (used to filter "drive resolution" to YOUR PRs)
#  - active_repos[]       (the 2–4 repos you actually work on)
#  - industry_topics      (paper/blog/X/LinkedIn queries)
/focus-config

# Then fill goals.md / expertise.md / teammates.md (3 files in state/)
#   state/goals.md       personal_goals | team_alignment | leadership_aspirations
#   state/expertise.md   known_for | emerging_strengths | not_my_lane
#   state/teammates.md   collaborators, strengths, current focus

# Generate your first briefing
/focus today
```

## Commands

| Command | What it does |
|---|---|
| `/focus today` | 3-lane briefing for today |
| `/focus week` | Weekly 3-lane briefing + drift report |
| `/focus month` | Monthly review + 1 RFC-grade proposal |
| `/focus propose` | Propose lane only, 3–5 pitches with 1-pager scaffolds |
| `/focus pitch PROP-YYYYMMDD-NNN` | Promote a pitch to a draft RFC in `state/proposals.md` |
| `/focus-config` | Open `config.yaml` |

## Architecture

```
PostToolUse hook ─► time_log.jsonl
                      │
ingest_github ──┐  aggregate_time
ingest_industry ┼─► signals/*.json ──► detect_opportunities ──► opportunities.json
                │           │                                         │
                └───────────┴───► score_and_rank ◄────────────────────┘
                                        │
                                        ▼
                             Do / Push / Propose (today/week/month)
```

**Scoring:**
```
exec_score = (strategic_fit × execution_leverage × urgency × recency_decay) / effort
lead_score = (visibility × novelty × team_fit × aspiration_match) × feasibility
```

## Quality bar (what this skill will NOT recommend)

- Writing ARCHITECTURE.md / README / docs (chore-tier, not leadership)
- "Drive resolution on PR #N" for PRs **not authored by you**
  (filters via `config.user.github_handle`)
- "Apply paper X to repo Y" without real topic overlap
- Stale-TODO single-line cleanups

Every Propose lane is required to be a **mix of 2–3 ambitious projects +
2–3 practical week-shippable items**. See `SKILL.md` "Quality bar" section.

## Syncing improvements back

After making changes locally:

```bash
cd ~/.claude/skills/pareto-focus
./publish.sh "fix: <description>"
```

`publish.sh` runs a guard that refuses to commit any file that looks like
user data (state/, data/, or paths matching your `user.github_handle`),
then pushes.

## Directory layout

```
pareto-focus/                     <- this repo
├── SKILL.md                      # skill prompt + quality bar
├── scripts/                      # 12 Node scripts (ingestion, scoring, hooks)
├── templates/                    # starter config.yaml, goals.md, etc.
├── commands/                     # /focus and /focus-config (symlinked into ~/.claude/commands/)
├── docs/manual.md                # full user manual
├── install.sh                    # first-time setup
├── publish.sh                    # safe commit+push helper
└── .gitignore                    # excludes state/, data/, runtime files
```

Runtime data (goals, time logs, generated briefs, proposals) lives at
`~/.claude/projects/pareto-focus/` — **never** in this repo.

## License

MIT
