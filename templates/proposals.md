# Proposals

Idea backlog. The Propose lane writes new candidates here as `draft`.
You promote them by running `/focus pitch <id>` (writes a 1-pager scaffold) and updating status as you act.

## Status legend
- `draft` — system-generated; you haven't reviewed
- `reviewed` — you read it, kept it alive
- `pitched` — you raised it with the team / wrote an RFC
- `accepted` — team agreed to scope/staff it
- `dropped` — not worth pursuing

## Backlog

<!-- entries appended here by detect_opportunities.js / draft_pitch.js -->

### Example: PROP-0001 — Long-context eval harness for slime checkpoints
- status: draft
- created: 2026-04-16
- lead_score: 0.74
- one_line: Build a shared eval harness that runs every slime checkpoint through a long-context benchmark suite, surfacing regressions per training step.
- why_gap:
  - 3 papers in last 30d on long-context eval (citations: ...)
  - nlp.slime has no long-context evals in its CI
  - your `expertise.md::known_for` lists "Long-context evaluation benchmarks"
- collaborator: <Name from teammates.md who works on slime infra>
- first_step: Draft a 1-pager defining 3 benchmark suites + integration point in slime CI
- artifact_target: RFC + draft PR in nlp.slime
