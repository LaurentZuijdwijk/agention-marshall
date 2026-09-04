#!/usr/bin/env bash
# Builds the fixture for the 'real-repo-fix' bench task: a full snapshot of
# this monorepo with exactly one deliberately broken, pre-existing test.
#
# Not committed to the repo — a full monorepo copy is too big and too stale
# the moment source drifts. Regenerate it locally before running that task.
#
# The break is a one-line edit to a tested pure function
# (packages/engine/src/usage.ts's formatRate), chosen because it's narrow and
# directly exercised by one assertion. This script *proves* that before
# leaving the fixture in place — it runs the engine suite twice (once broken,
# once as a sanity baseline) and refuses to hand you a fixture unless exactly
# one test failed. If usage.ts changes shape later and this stops being true,
# you'll get a loud error here instead of a benchmark task that silently
# means something different than its prompt says.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="${1:-/tmp/marshall-realrepo-baseline}"
TARGET_FILE="packages/engine/src/usage.ts"
BEFORE='return `${perSecond.toFixed(1)}/s`;'
AFTER='return `${perSecond.toFixed(0)}/s`;'

echo "Building real-repo-fix fixture at $FIXTURE_DIR from $REPO_ROOT"

rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

# Copy source, excluding what's either huge (node_modules, dist, .git) or
# would make the fixture non-reproducible / leak unrelated state (bench/runs,
# .marshall). node_modules is symlinked back below instead of copied — a full
# reinstall here would take far longer than the task itself.
rsync -a \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='bench/runs' \
  --exclude='.marshall' \
  --exclude='*.tsbuildinfo' \
  "$REPO_ROOT/" "$FIXTURE_DIR/"

# Symlink node_modules at every depth the copy has one, so npm/tsx resolve
# packages exactly as they do in the real checkout.
find "$REPO_ROOT" -maxdepth 3 -type d -name node_modules | while read -r nm; do
  rel="${nm#"$REPO_ROOT"/}"
  ln -s "$nm" "$FIXTURE_DIR/$rel"
done

# Sanity baseline: confirm the untouched copy passes in full before breaking
# anything. A fixture built from a repo that was already red would make the
# task's prompt ("has one failing test") a lie from the start.
echo "Verifying the unmodified copy is fully green..."
if ! (cd "$FIXTURE_DIR/packages/engine" && node --import tsx/esm --test 'src/**/*.test.ts' > /tmp/real-repo-fixture-baseline.log 2>&1); then
  echo "FAILED: the unmodified copy is not green — cannot build a trustworthy fixture from it." >&2
  tail -30 /tmp/real-repo-fixture-baseline.log >&2
  exit 1
fi

# Apply the break.
if ! grep -qF "$BEFORE" "$FIXTURE_DIR/$TARGET_FILE"; then
  echo "FAILED: expected line not found in $TARGET_FILE — usage.ts has changed shape." >&2
  echo "Update BEFORE/AFTER in this script to a still-narrow, still-tested target." >&2
  exit 1
fi
sed -i.bak "s|$BEFORE|$AFTER|" "$FIXTURE_DIR/$TARGET_FILE"
rm -f "$FIXTURE_DIR/$TARGET_FILE.bak"

# Prove the break is exactly one test, no more, no less.
echo "Verifying the break is exactly one failing test..."
set +e
(cd "$FIXTURE_DIR/packages/engine" && node --import tsx/esm --test 'src/**/*.test.ts' > /tmp/real-repo-fixture-broken.log 2>&1)
set -e
FAIL_COUNT=$(grep -E "^ℹ fail " /tmp/real-repo-fixture-broken.log | grep -oE "[0-9]+" || echo "?")
if [ "$FAIL_COUNT" != "1" ]; then
  echo "FAILED: expected exactly 1 failing test, got $FAIL_COUNT." >&2
  echo "The chosen line no longer isolates to one assertion — pick a narrower target." >&2
  tail -40 /tmp/real-repo-fixture-broken.log >&2
  exit 1
fi

echo "OK: fixture built, verified exactly 1 failing test (formatRate rounding, usage.test.ts)."
