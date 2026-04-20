#!/usr/bin/env bash
# Safely commit+push changes to the pareto-focus repo.
# Refuses to commit anything that looks like user data.
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

MSG="${1:-update: skill improvements}"

# Safety guards — these paths should never be tracked
for forbidden in state data; do
  if git ls-files --error-unmatch "$forbidden" >/dev/null 2>&1; then
    echo "ERROR: $forbidden/ is tracked — .gitignore is not doing its job." >&2
    exit 1
  fi
done

# Scan staged+unstaged for suspicious user-data patterns
if git diff --cached --no-color 2>/dev/null | grep -E '(yangzhizhuo|@writer\.com|pengdurice|kiran@|sanderland|George614|WriterInternal|WriterColab|/Users/[^/]+/Projects)' >/dev/null; then
  echo "ERROR: staged diff contains user-identifying strings. Refusing to commit." >&2
  echo "Review with: git diff --cached | grep -E '...'" >&2
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "[publish] no changes."
  exit 0
fi

git add -A

# Re-check AFTER staging (git diff --cached picks up everything now)
if git diff --cached --no-color | grep -E '(yangzhizhuo|@writer\.com|pengdurice|kiran@|sanderland|George614|WriterInternal|WriterColab|/Users/[^/]+/Projects)' >/dev/null; then
  echo "ERROR: staged diff contains user-identifying strings. Unstaging." >&2
  git reset
  exit 1
fi

git commit -m "$MSG"
git push
echo "[publish] pushed."
