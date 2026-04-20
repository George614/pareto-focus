# Pareto Focus — User Manual

A Claude Code skill that surfaces the top 10% of work driving 80% of your outcome, and proposes new projects that build your leadership reputation.

**Two jobs:**
1. **Focus** — rank what's already on your plate by Pareto leverage.
2. **Lead** — intersect industry signals × your team's repos × your expertise to suggest new work to pitch.

---

## TL;DR

```
/focus propose              # latest AI trends + ranked new-project pitches (arXiv + repo gaps)
/focus today                # three-lane briefing: Do / Push / Propose for today
/focus pitch PROP-20260417-142   # promote an idea → 1-pager scaffold
```

First run will prompt you to edit three files — do it once, ~3 minutes.

---

## Commands

All commands live in `~/.claude/commands/`. Type `/` in Claude Code to autocomplete.

| Command | What it does |
|---|---|
| `/focus today` | Three-lane briefing for today: **Do** (execute), **Push** (rescue drifted), **Propose** (pitch) |
| `/focus week` | Weekly rollup + drift report on leadership aspirations |
| `/focus month` | Monthly review + one RFC-grade proposal to draft |
| `/focus propose` | Propose lane only, deeper — 3–5 pitches with one-pager scaffolds |
| `/focus pitch <PROP-id>` | Promote an opportunity to a draft RFC in `proposals.md` |
| `/focus-config` | Open `config.yaml` + anchor files for editing |

### Which command for which question?

| You want to know… | Run |
|---|---|
| "What should I work on right now?" | `/focus today` |
| "What are the latest AI trends I should act on?" | `/focus propose` |
| "Am I drifting from my Q-goals?" | `/focus week` |
| "What RFC should I draft next month?" | `/focus month` |
| "Turn idea #5 into a 1-pager" | `/focus pitch PROP-20260417-005` |

---

## First-time setup (3 minutes — biggest quality unlock)

Without filling in three anchor files, the system warns `⚠️ goals.md not filled in — scoring uses keyword heuristics only`. Ranking still works, but it's rough.

Edit these three files in `~/.claude/projects/pareto-focus/state/`:

### `goals.md`
Three sections:
- `personal_goals` — what you want to ship this quarter
- `team_alignment` — your team's stated OKRs / priorities
- `leadership_aspirations` — directions you want to own (drives the Propose lane)

```markdown
## leadership_aspirations
- Become the go-to person on long-context strategy across teams
- Own the agent-UI direction for fs.action-ai
```

### `expertise.md`
- `known_for` — what people already credit you with
- `emerging_strengths` — areas you're building depth in (small score boost)
- `not_my_lane` — things NOT to propose even if trending

### `teammates.md`
2–6 collaborators. Each with strengths + current focus. The Propose lane suggests collaborators by matching candidate topics to teammate strengths.

```markdown
### Alice Chen — @alice
- strengths: distributed training, infra, perf optimization
- current_focus: scaling slime to multi-node
- complement: I bring algo/RL depth, they bring infra
- last_collab: 2026-03
```

### Quick edit path

Just run `/focus-config` — it opens config.yaml and tells you where the state files live.

---

## Configuration (`~/.claude/projects/pareto-focus/config.yaml`)

Pre-populated with your 4 active repos: `nlp.slime`, `nlp.widgets`, `nlp.longcontext`, `fs.action-ai`.

### Watched repos

```yaml
active_repos:
  - name: nlp.slime
    path: nlp.slime
    github: "your-org/nlp.slime"   # set this to enable gh CLI ingestion
    topics: ["RL fine-tuning", "post-training", "GRPO", "DPO"]
```

Fill in the `github:` slug (`owner/repo`) for each repo you want scanned via `gh` CLI. Without it, the ingestor uses local `git log` only (no PRs, no issues).

### Industry queries

```yaml
industry_topics:
  papers: ["RL fine-tuning LLM", "long-context attention transformer", ...]
  blogs: ["AI engineering best practices", ...]
  x_handles: ["karpathy", "_jasonwei", ...]
  linkedin_companies: ["anthropic", "openai", ...]
```

`papers` are queried directly against arXiv (no auth). `blogs`, `x_handles`, `linkedin_*` are fetched through Claude's MCP tools (exa-search, x-api, LinkedIn) — they only populate when you run the `/focus` command, not when you run the scripts standalone.

### Cadence toggles (all off by default)

```yaml
cadences:
  morning_brief:   { enabled: false, time: "07:00" }
  end_of_day:      { enabled: false }
  weekly_review:   { enabled: false, day: "fri", time: "16:00" }
  monthly_review:  { enabled: false, day: "last", time: "16:00" }
```

Toggle any to `true`, then ask Claude to register the cron — the system ships a `register_crons.js` helper that emits a plan Claude can execute via `CronCreate`.

---

## What's tracked automatically

### Passive time-tracking

A PostToolUse hook logs every `Bash|Edit|Write|Read|MultiEdit|NotebookEdit` you run whose cwd is under `~/Projects/`. Writes to `~/.claude/projects/pareto-focus/data/time_log.jsonl`:

```json
{"ts":"2026-04-17T14:32:11Z","cwd":"~/Projects/nlp.slime","tool":"Edit","project":"nlp.slime","session_id":"..."}
```

`aggregate_time.js` rolls entries into sessions per project per day (15-min inactivity gap). Feeds the drift warning in `/focus week`.

### Filtered out
- cwds under `/tmp`, `~/.claude` (configurable in `time_tracking.ignore_paths`)
- Tools other than the allow-list above

---

## How ranking works

Every candidate gets two scores:

```
exec_score = (strategic_fit × execution_leverage × urgency × recency_decay) / effort
lead_score = (visibility × novelty × team_fit × aspiration_match) × feasibility
```

### Three lanes per briefing

| Lane | Source | Ranked by |
|---|---|---|
| **Do** | github.json (open issues, stale PRs, stale TODOs, active repos) | `exec_score` |
| **Push** | in-flight items matching a drifted leadership aspiration | `exec_score × drift_penalty` |
| **Propose** | `opportunities.json` (papers × repos × expertise) | `lead_score` |

### Lane sizes

| Cadence | Do | Push | Propose |
|---|---|---|---|
| today | 3 | 1–2 | 0–1 |
| week  | 5 | 2–3 | 1–2 |
| month | 3 focus areas | 2 | 1 RFC |

### Diversity guard

Stale TODOs are capped at ~half the Do lane (prevents degenerate TODO-only output). Non-TODO items preferred when available.

### Drift warning

If a leadership aspiration keyword gets <10% of your week's time coverage (from `time_log.jsonl` aggregate), its matching items get a boost in the Push lane, and a warning appears: *"'Drive long-context strategy' — 8% time coverage this week (target >10%)"*.

---

## The pitch workflow

1. **`/focus propose`** — get 3–5 opportunity candidates with IDs like `PROP-20260417-142`.
2. **`/focus pitch PROP-20260417-142`** — appends a 1-pager scaffold to `state/proposals.md`:

```markdown
### PROP-20260417-142 — <title from one_line>
- status: draft
- created: 2026-04-17
- lead_score: 0.74
- one_line: ...
- why_gap: ...
- collaborator: @alice
- first_step: ...
- artifact_target: RFC + draft PR in nlp.slime

#### 1-pager scaffold
**Problem** — ...
**Proposal** — ...
**Why now** — ...
...
```

3. **Edit it manually** — replace placeholder bullets with real content, update status to `pitched` when you raise it with the team.
4. **Status lifecycle**: `draft` → `reviewed` → `pitched` → `accepted` / `dropped`.

---

## Data layout

```
~/.claude/projects/pareto-focus/
├── config.yaml                   # repos, topics, cadences, weights
├── data/
│   ├── time_log.jsonl            # passive hook output (append-only)
│   ├── aggregates/YYYY-MM-DD.json
│   ├── signals/YYYY-MM-DD/
│   │   ├── github.json           # PRs, issues, CI, gaps, contributors
│   │   ├── papers.json           # arXiv hits, ranked by freshness
│   │   ├── x_linkedin.json       # (populated by /focus via MCP)
│   │   └── opportunities.json    # synthesis output, candidates[]
│   └── briefs/
│       ├── 2026-04-17.md         # daily morning brief (cron)
│       ├── week-2026-16.md       # weekly review
│       └── month-2026-04.md      # monthly review
└── state/
    ├── goals.md                  # YOU edit — 3 sections
    ├── expertise.md              # YOU edit — 3 sections
    ├── teammates.md              # YOU edit — collaborators
    ├── proposals.md              # grows as you pitch ideas
    ├── priorities.md             # regenerated each run
    ├── priorities.json           # machine-readable mirror
    ├── weights.json              # scoring weights (tunable)
    └── decisions.log             # (when end_of_day enabled) what you did vs planned
```

---

## Manual script invocation

If you want to run pieces directly (e.g., for debugging):

```bash
node ~/.claude/skills/pareto-focus/scripts/aggregate_time.js
node ~/.claude/skills/pareto-focus/scripts/ingest_github.js
node ~/.claude/skills/pareto-focus/scripts/ingest_industry.js       # arXiv only (standalone)
node ~/.claude/skills/pareto-focus/scripts/detect_opportunities.js
node ~/.claude/skills/pareto-focus/scripts/score_and_rank.js --cadence today
node ~/.claude/skills/pareto-focus/scripts/weekly_review.js
node ~/.claude/skills/pareto-focus/scripts/monthly_review.js
node ~/.claude/skills/pareto-focus/scripts/morning_brief.js         # full pipeline
node ~/.claude/skills/pareto-focus/scripts/draft_pitch.js PROP-20260417-142
node ~/.claude/skills/pareto-focus/scripts/register_crons.js        # prints cron plan
```

Full pipeline wall-time: **~2.6s** (parallelized ingestion).

---

## Tuning the scorer

Edit `~/.claude/projects/pareto-focus/state/weights.json`:

```json
{
  "exec": {
    "strategic_fit": 0.30,
    "execution_leverage": 0.25,
    "urgency": 0.20,
    "recency_decay_days": 14,
    "effort_penalty": 1.0
  },
  "lead": {
    "visibility": 0.25,
    "novelty": 0.25,
    "team_fit": 0.20,
    "aspiration_match": 0.20,
    "feasibility": 0.10
  },
  "drift_penalty": {
    "threshold_pct": 10,
    "boost_per_pct_under": 0.05
  }
}
```

Bump `aspiration_match` and `visibility` if you want the Propose lane to skew more toward leadership-building artifacts.

---

## Troubleshooting

### "⚠️ goals.md not filled in" keeps appearing
Edit `~/.claude/projects/pareto-focus/state/goals.md`. The warning triggers when any section contains the placeholder string `(replace with yours)` or the section is empty.

### Propose lane shows "No opportunities detected yet"
Run the full pipeline once to populate today's signals:
```bash
/focus today    # this refreshes signals under the hood
```
Or run `node ingest_github.js && node ingest_industry.js && node detect_opportunities.js` manually.

### GitHub signals are sparse (no PR/issue data)
The `github:` field in `config.yaml` for each repo is empty. Fill in `owner/repo` slugs. Requires `gh auth login` once beforehand.

### `x_linkedin.json` has empty arrays and a `_manifest` block
Expected. The standalone script can't call MCP tools. Run `/focus propose` or `/focus today` (via Claude Code, not shell) to fulfill blog/X/LinkedIn via `exa-search`, `x-api`, and `mcp__linkedin__*`.

### Do lane is all stale TODOs
Means your active repos have been quiet this week and `goals.md` is still template. Fill in goals, get some PRs in flight, or accept — those old TODOs genuinely are your best ROI right now.

### Time tracking isn't capturing anything
Check `~/.claude/settings.json` — `hooks.PostToolUse` should include an entry pointing to `time_log_hook.js`. Check `~/.claude/projects/pareto-focus/data/time_log.jsonl` exists. Check `data/time_log_hook.err` for silent failures.

### Morning brief cron isn't firing
Flip `cadences.morning_brief.enabled: true` in config, then ask Claude: "register the pareto-focus cron plan." It runs `node register_crons.js` and applies via `CronCreate`.

---

## Performance profile

| Script | Typical time |
|---|---|
| `time_log_hook.js` (per tool call) | <5 ms |
| `aggregate_time.js` | ~50 ms |
| `ingest_github.js` | 2.5 s (4 repos × git + gh) |
| `ingest_industry.js` | 2.0 s (arXiv network) |
| `detect_opportunities.js` | ~30 ms |
| `score_and_rank.js` | ~25 ms |
| `morning_brief.js` (full, parallel) | **~2.6 s** |

Scoring is pure compute (no LLM calls) — that's why every run is deterministic except for timestamps.

---

## Phase 2 (not in v1)

- Slack ingestion (deferred — can scaffold `ingest_slack.js` when Slack MCP is wired)
- MCP fulfillment auto-cached between `/focus` runs
- Auto weight-tuning from `decisions.log` (reinforcement from what you actually acted on)
- Mobile/email delivery of morning brief
- Auto-converting accepted proposals into Linear/Jira tickets via `jira-integration`

---

## File locations (quick reference)

| Purpose | Path |
|---|---|
| Skill definition | `~/.claude/skills/pareto-focus/SKILL.md` |
| Scripts | `~/.claude/skills/pareto-focus/scripts/*.js` |
| Templates | `~/.claude/skills/pareto-focus/templates/*.{md,yaml}` |
| Slash commands | `~/.claude/commands/focus*.md` |
| Your config | `~/.claude/projects/pareto-focus/config.yaml` |
| Your anchor files | `~/.claude/projects/pareto-focus/state/{goals,expertise,teammates}.md` |
| Signal cache | `~/.claude/projects/pareto-focus/data/signals/YYYY-MM-DD/` |
| Briefs | `~/.claude/projects/pareto-focus/data/briefs/` |
| Hooks registered in | `~/.claude/settings.json` (`PostToolUse`, `Stop`) |
