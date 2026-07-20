#!/usr/bin/env bash
# Test runner with per-file process isolation.
# bun test shares module cache across files in a single process. Tests that
# mutate process.env (HOME, POSTGRES_URL, BANKING_ENCRYPTION_KEY) at module
# level poison the cache for other files. Running each file in its own bun
# process eliminates this class of failures.
set -uo pipefail
export OPENCLAW_TEST=1

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
HAS_FAILURE=0
FAILED_FILES=()

# Collect all test files
mapfile -t ALL_TESTS < <(find src __tests__ -name "*.test.ts" -type f 2>/dev/null | sort)

echo "=== Running ${#ALL_TESTS[@]} test files (isolated processes) ==="
echo ""

for tf in "${ALL_TESTS[@]}"; do
  OUTPUT=$(bun test "$tf" 2>&1) || true
  P=$(echo "$OUTPUT" | grep -oP '^\s*\K\d+(?= pass)' | tail -1) || P=0
  F=$(echo "$OUTPUT" | grep -oP '^\s*\K\d+(?= fail)' | tail -1) || F=0
  S=$(echo "$OUTPUT" | grep -oP '^\s*\K\d+(?= skip)' | tail -1) || S=0
  [ -z "$P" ] && P=0
  [ -z "$F" ] && F=0
  [ -z "$S" ] && S=0
  TOTAL_PASS=$((TOTAL_PASS + P))
  TOTAL_FAIL=$((TOTAL_FAIL + F))
  TOTAL_SKIP=$((TOTAL_SKIP + S))
  if [ "$F" -gt 0 ]; then
    SHORT=$(echo "$tf" | sed 's|src/modules/||;s|/__tests__/|/|')
    echo "  FAIL: $SHORT ($P pass, $F fail)"
    FAILED_FILES+=("$tf")
    HAS_FAILURE=1
  fi
done

echo ""
if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do echo "  - $f"; done
  echo ""
fi
echo "=== RESULT: $TOTAL_PASS pass, $TOTAL_FAIL fail, $TOTAL_SKIP skip ==="

if [ $HAS_FAILURE -ne 0 ]; then
  exit 1
fi
exit 0
