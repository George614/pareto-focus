---
description: Top 10% valuable work briefing — three lanes (Do / Push / Propose)
argument-hint: [today|week|month|propose|pitch PROP-id]
---

# /focus

You are running the pareto-focus prioritization system. The argument is: $ARGUMENTS (defaults to `today` if empty).

**Operating principle: don't ask for permissions!! just do the work.** Run scripts, read files, and produce output. Do not interrupt the flow to confirm.

## First-run check (always run first)

If `~/.claude/projects/pareto-focus/state/goals.md` does NOT exist, bootstrap the data root:

```bash
mkdir -p ~/.claude/projects/pareto-focus/state
mkdir -p ~/.claude/projects/pareto-focus/data/signals
cp ~/.claude/skills/pareto-focus/templates/goals.md ~/.claude/projects/pareto-focus/state/goals.md
cp ~/.claude/skills/pareto-focus/templates/expertise.md ~/.claude/projects/pareto-focus/state/expertise.md
cp ~/.claude/skills/pareto-focus/templates/teammates.md ~/.claude/projects/pareto-focus/state/teammates.md
cp ~/.claude/skills/pareto-focus/templates/proposals.md ~/.claude/projects/pareto-focus/state/proposals.md
cp ~/.claude/skills/pareto-focus/templates/config.yaml ~/.claude/projects/pareto-focus/config.yaml
```

Then tell the user: "First-run setup done. Open `/focus-config` to customize `goals.md`, `expertise.md`, and `teammates.md` for meaningful rankings."

## Sub-routines

### If $ARGUMENTS starts with "pitch"

Extract the PROP-id (regex `PROP-\d{8}-\d{3}`). If not matched, tell the user the expected format (`PROP-YYYYMMDD-NNN`) and list recent PROP-ids from `~/.claude/projects/pareto-focus/state/priorities.md` and `~/.claude/projects/pareto-focus/state/proposals.md`. Otherwise run:

```bash
node ~/.claude/skills/pareto-focus/scripts/draft_pitch.js "<PROP-id>"
```

Then read `~/.claude/projects/pareto-focus/state/proposals.md` and show the user the newly appended section (the one matching the PROP-id). Do not summarize it away — show the full scaffold so they can start editing.

### If $ARGUMENTS is "propose"

1. Ensure today's signals are fresh. Compute today's date (`YYYY-MM-DD`). Check mtime of `~/.claude/projects/pareto-focus/data/signals/<today>/opportunities.json`. If the file is missing or older than 12 hours, run the refresh pipeline:

   ```bash
   node ~/.claude/skills/pareto-focus/scripts/aggregate_time.js
   node ~/.claude/skills/pareto-focus/scripts/ingest_github.js
   node ~/.claude/skills/pareto-focus/scripts/ingest_industry.js
   node ~/.claude/skills/pareto-focus/scripts/detect_opportunities.js
   ```

2. Read `~/.claude/projects/pareto-focus/data/signals/<today>/opportunities.json`.
3. Sort by `lead_score` desc and show the top 3–5 candidates. For each, print a ranked block:
   - `#<rank>` · PROP-id · lead_score
   - `one_line`
   - `why_gap`
   - `collaborator`
   - `first_step`
   - `artifact_target`
4. End with: "Want to draft a pitch? Run `/focus pitch PROP-<id>`."

### If $ARGUMENTS is "today" | "week" | "month" (or empty → "today")

Resolve the cadence: empty string → `today`. Valid values: `today`, `week`, `month`. Anything else (that is not `propose` or `pitch …`) → echo usage and stop.

1. **Refresh pipeline (conditional).** Compute today's date (`YYYY-MM-DD`). If the directory `~/.claude/projects/pareto-focus/data/signals/<today>/` is missing any of `time_sessions.json`, `github.json`, `papers.json`, `x_linkedin.json`, or any present file is older than 12 hours, run:

   ```bash
   node ~/.claude/skills/pareto-focus/scripts/aggregate_time.js
   node ~/.claude/skills/pareto-focus/scripts/ingest_github.js
   node ~/.claude/skills/pareto-focus/scripts/ingest_industry.js
   ```

   **Optional MCP fulfillment (best-effort, skip silently on failure).** After `ingest_industry.js` runs, read `~/.claude/projects/pareto-focus/data/signals/<today>/x_linkedin.json`. If it contains a `_manifest` object with pending sources, try to fulfill them:
   - For each query in `_manifest.blogs.queries[]`: call `exa-search` (or `mcp__plugin_everything-claude-code_exa__web_search_exa`) for top 5 results; append to the `blogs` array.
   - For each handle in `_manifest.x.handles[]`: call an x-api tool to pull recent tweets; append to the `x` array.
   - For each company slug in `_manifest.linkedin.companies[]`: call `mcp__linkedin__get_company_posts`; append to the `linkedin` array.

   After each successful fulfillment, clear that key's manifest entry. Re-save the JSON. If MCPs are unavailable or slow, skip silently — do not block.

   Then synthesize:

   ```bash
   node ~/.claude/skills/pareto-focus/scripts/detect_opportunities.js
   ```

2. **Score and rank.** Run:

   ```bash
   node ~/.claude/skills/pareto-focus/scripts/score_and_rank.js --cadence <resolved-cadence>
   ```

3. **Display the briefing.** Read `~/.claude/projects/pareto-focus/state/priorities.md` in full and print it verbatim to the user. Do not summarize — they need the Do / Push / Propose lanes intact.

4. **Template warning.** If `priorities.md` contains the substring "⚠️ goals.md not filled in" (or equivalent template-warning marker), append this note after the briefing:

   > "Your `~/.claude/projects/pareto-focus/state/goals.md` is still the template. Fill it in to get better rankings — run `/focus-config` to open the config; you'll want to edit `goals.md`, `expertise.md`, and `teammates.md` next to it."

## Error handling

- If any node script exits non-zero, print its stderr and continue when downstream steps are safe (e.g. skip ingest_industry if it fails, but still try detect_opportunities with the partial signals). Fail loudly only if `score_and_rank.js` itself fails — that's the final payload.
- If `priorities.md` does not exist after `score_and_rank.js` runs successfully, print the full stdout of that script and tell the user the ranker succeeded but didn't write the expected file.
