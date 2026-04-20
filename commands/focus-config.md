---
description: Open pareto-focus config for editing
argument-hint:
---

# /focus-config

**Operating principle: don't ask for permissions!! just do the work.** Run the bootstrap, print the paths, show the cadences. Don't block on confirmation.

## Steps

1. **Bootstrap if missing.** If `~/.claude/projects/pareto-focus/config.yaml` does NOT exist, copy from the template:

   ```bash
   mkdir -p ~/.claude/projects/pareto-focus/state
   mkdir -p ~/.claude/projects/pareto-focus/data/signals
   cp ~/.claude/skills/pareto-focus/templates/config.yaml ~/.claude/projects/pareto-focus/config.yaml
   ```

   Also ensure each of `state/goals.md`, `state/expertise.md`, `state/teammates.md`, `state/proposals.md` exists. For any that's missing, copy from `~/.claude/skills/pareto-focus/templates/<filename>`.

2. **Print the edit paths.** Tell the user:

   > "Edit: `~/.claude/projects/pareto-focus/config.yaml`"
   > "And the anchor files:"
   > "  - `~/.claude/projects/pareto-focus/state/goals.md`"
   > "  - `~/.claude/projects/pareto-focus/state/expertise.md`"
   > "  - `~/.claude/projects/pareto-focus/state/teammates.md`"

3. **Show the current `cadences` block.** Read `~/.claude/projects/pareto-focus/config.yaml`, locate the `cadences:` YAML block, and print it verbatim inside a fenced code block so the user can see which cadences are enabled and their cron expressions.

4. **Offer cadence toggle.** End with:

   > "Flip a cadence on? Tell me which one (`daily`, `weekly`, or `monthly`) and I'll toggle `enabled: true` in config.yaml, then register the cron via `CronCreate`."

   If the user responds with a cadence name in a follow-up turn, edit the `cadences.<name>.enabled` field in `config.yaml` to `true` and call `CronCreate` with the cron expression from that same block and the command `/focus <name-mapped>` (mapping: `daily`→`today`, `weekly`→`week`, `monthly`→`month`). If they ask to disable, flip to `false` and call `CronDelete`.
