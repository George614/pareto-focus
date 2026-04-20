#!/usr/bin/env bash
# Pareto Focus installer — symlinks slash commands and bootstraps state.
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
COMMANDS="$CLAUDE/commands"
DATA_ROOT="$CLAUDE/projects/pareto-focus"

echo "[pareto-focus] installing from $REPO"

mkdir -p "$COMMANDS"
for cmd in focus.md focus-config.md; do
  target="$COMMANDS/$cmd"
  source="$REPO/commands/$cmd"
  if [ ! -e "$source" ]; then
    echo "  skip: $source missing"
    continue
  fi
  if [ -L "$target" ] || [ -f "$target" ]; then
    echo "  replacing $target"
    rm -f "$target"
  fi
  ln -s "$source" "$target"
  echo "  linked $cmd"
done

# Bootstrap runtime state (never committed to repo)
mkdir -p "$DATA_ROOT/state" "$DATA_ROOT/data/signals" "$DATA_ROOT/data/aggregates"
for f in goals.md expertise.md teammates.md proposals.md; do
  if [ ! -f "$DATA_ROOT/state/$f" ] && [ -f "$REPO/templates/$f" ]; then
    cp "$REPO/templates/$f" "$DATA_ROOT/state/$f"
    echo "  seeded state/$f"
  fi
done
if [ ! -f "$DATA_ROOT/config.yaml" ]; then
  cp "$REPO/templates/config.yaml" "$DATA_ROOT/config.yaml"
  echo "  seeded config.yaml"
fi
if [ ! -f "$DATA_ROOT/state/weights.json" ]; then
  cat > "$DATA_ROOT/state/weights.json" <<'WEIGHTS'
{
  "exec": {"strategic_fit":0.30,"execution_leverage":0.25,"urgency":0.20,"recency_decay_days":14,"effort_penalty":1.0},
  "lead": {"visibility":0.25,"novelty":0.25,"team_fit":0.20,"aspiration_match":0.20,"feasibility":0.10},
  "drift_penalty": {"threshold_pct":10,"boost_per_pct_under":0.05},
  "_meta": {"version":1}
}
WEIGHTS
  echo "  seeded state/weights.json"
fi

echo "[pareto-focus] install complete"
echo "  next: /focus-config  (edit config.yaml)"
echo "  then: /focus today   (first brief)"
