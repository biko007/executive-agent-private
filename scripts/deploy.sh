#!/usr/bin/env bash
# scripts/deploy.sh — Build, deploy, health-check, auto-rollback
#
# Usage: scripts/deploy.sh [<service>...] (default: openclaw-gateway)
#
# Flow:
#   1. dirty-tree check (abort if uncommitted tracked changes exist)
#   2. load LAST_GOOD from marker file (~/.deploy-markers/.deploy-last-good-<primary>)
#   3. build → verify:commands → npm test (executive-agent only)
#   4. restart ONLY the named services
#   5. health check (systemd is-active + port responds)
#   6. smoke test (bun run scripts/smoke-test.ts)
#   7. SUCCESS → update marker, notify "DEPLOY OK <sha>"
#   8. FAILURE → rollback to LAST_GOOD: checkout, rebuild, restart, health+smoke
#      ROLLBACK OK  → notify "ROLLBACK auf <sha>"; exit 1
#      ROLLBACK ROT → notify "ROLLBACK FAILED = ALARM!"; exit 2
#
# Exit codes: 0 = OK, 1 = deploy failed (service stable), 2 = rollback failed (ALARM)
#
# Test-hook (rollback bite-test only — no repo changes needed):
#   DEPLOY_SMOKE_INJECT_FAIL=1 scripts/deploy.sh openclaw-gateway
#   Forces smoke to fail so rollback path is exercised.
#   Unset afterwards: unset DEPLOY_SMOKE_INJECT_FAIL

set -uo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD_DIR="${AGENT_DIR}/../executive-dashboard"
TRADING_DIR="${AGENT_DIR}/../trading-agent"
MARKER_DIR="${HOME}/.deploy-markers"
NOTIFY_CMD="/home/biko/.scripts/notify"
SETTLE_SECS=5   # seconds to wait after restart before health check

# ── Services ───────────────────────────────────────────────────────────────

# Default to openclaw-gateway if no arguments given
if [[ $# -eq 0 ]]; then
  SERVICES=("openclaw-gateway")
else
  SERVICES=("$@")
fi

PRIMARY="${SERVICES[0]}"

# ── Helpers ────────────────────────────────────────────────────────────────

log()  { echo "[deploy $(date '+%H:%M:%S')] $*"; }
ts()   { date '+%Y-%m-%d %H:%M:%S'; }

notify() {
  # Usage: notify "message" [info|warn|error]
  local msg="$1" sev="${2:-info}"
  log "NOTIFY [$sev]: $msg"
  if [[ -x "$NOTIFY_CMD" ]]; then
    # Non-fatal — gateway may be down during rollback
    "$NOTIFY_CMD" "$msg" "$sev" dev 2>/dev/null || \
      log "WARNING: notify command failed (gateway may be restarting)"
  else
    log "WARNING: $NOTIFY_CMD not found or not executable"
  fi
}

# Map service name → build directory (empty = no build step)
build_dir_for() {
  case "$1" in
    openclaw-gateway|openclaw-pdf-worker) echo "$AGENT_DIR" ;;
    openclaw-dashboard)                   echo "$DASHBOARD_DIR" ;;
    openclaw-trading)                     echo "$TRADING_DIR" ;;
    *) echo "" ;;
  esac
}

# Map service name → TCP health-check port (empty = no port check)
port_for() {
  case "$1" in
    openclaw-gateway)   echo "18789" ;;
    openclaw-dashboard) echo "18800" ;;
    openclaw-trading)   echo "18793" ;;
    *)                  echo "" ;;
  esac
}

# ── Build ──────────────────────────────────────────────────────────────────

build_services() {
  # Build each unique build directory once.
  # For executive-agent: also runs verify:commands + npm test (gate chain).
  local -A built_dirs=()

  for svc in "$@"; do
    local bdir
    bdir="$(build_dir_for "$svc")"
    if [[ -z "$bdir" ]]; then
      log "WARNING: no build dir known for '$svc', skipping build step"
      continue
    fi

    # Skip if we already built this directory in this run
    if [[ -v built_dirs["$bdir"] ]]; then
      log "Build dir $bdir already built, skipping duplicate"
      continue
    fi
    built_dirs["$bdir"]=1

    log "--- Build: $bdir ---"
    if ! (cd "$bdir" && npm run build); then
      log "BUILD FAILED in $bdir"
      return 1
    fi

    # Additional gates — only executive-agent carries the full gate chain
    if [[ "$bdir" == "$AGENT_DIR" ]]; then
      log "--- verify:commands ---"
      if ! (cd "$bdir" && npm run verify:commands); then
        log "VERIFY:COMMANDS FAILED"
        return 1
      fi

      log "--- npm test ---"
      if ! (cd "$bdir" && npm test); then
        log "NPM TEST FAILED"
        return 1
      fi
    fi
  done
  return 0
}

# ── Restart ────────────────────────────────────────────────────────────────

restart_services() {
  for svc in "$@"; do
    log "Restart: ${svc}.service"
    if ! systemctl --user restart "${svc}.service"; then
      log "RESTART FAILED: ${svc}.service"
      return 1
    fi
  done
  log "Settle: ${SETTLE_SECS}s"
  sleep "$SETTLE_SECS"
  return 0
}

# ── Health check ───────────────────────────────────────────────────────────

health_check_one() {
  local svc="$1"

  # 1. systemd is-active
  if ! systemctl --user is-active --quiet "${svc}.service"; then
    local actual_state
    actual_state="$(systemctl --user is-active "${svc}.service" 2>/dev/null || echo unknown)"
    log "HEALTH FAIL: $svc not active (state: $actual_state)"
    return 1
  fi

  # 2. Port check (if applicable)
  local port
  port="$(port_for "$svc")"
  if [[ -n "$port" ]]; then
    # Capture curl output and exit code separately.
    # Do NOT use || echo "000" inside $() — that doubles the output on failure.
    local code curl_rc
    code="$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" \
            "http://127.0.0.1:${port}/" 2>/dev/null)"
    curl_rc=$?
    if [[ "$curl_rc" -ne 0 || "$code" == "000" ]]; then
      log "HEALTH FAIL: $svc port $port not responding (curl exit=$curl_rc, http_code=$code)"
      return 1
    fi
    log "HEALTH OK: $svc → active, port $port HTTP $code"
  else
    log "HEALTH OK: $svc → active (no HTTP port)"
  fi
  return 0
}

health_check_all() {
  local all_ok=0
  for svc in "$@"; do
    health_check_one "$svc" || all_ok=1
  done
  return $all_ok
}

# ── Smoke test ─────────────────────────────────────────────────────────────

run_smoke() {
  # Test-hook: inject failure for rollback bite-test without repo changes
  # Usage: DEPLOY_SMOKE_INJECT_FAIL=1 scripts/deploy.sh <service>
  if [[ "${DEPLOY_SMOKE_INJECT_FAIL:-}" == "1" ]]; then
    log "⚠ SMOKE INJECTION ACTIVE (DEPLOY_SMOKE_INJECT_FAIL=1) — simulating failure"
    return 1
  fi

  log "--- Smoke test ---"
  (cd "$AGENT_DIR" && bun run scripts/smoke-test.ts)
}

# ── Main ───────────────────────────────────────────────────────────────────

mkdir -p "$MARKER_DIR"

# Resolve primary build directory for git operations
PRIMARY_BUILD_DIR="$(build_dir_for "$PRIMARY")"
if [[ -z "$PRIMARY_BUILD_DIR" ]]; then
  log "ERROR: Unknown service '${PRIMARY}'. Known: openclaw-gateway, openclaw-pdf-worker, openclaw-dashboard, openclaw-trading"
  exit 1
fi

log "=== DEPLOY [${SERVICES[*]}] $(ts) ==="
log "Primary build dir: $PRIMARY_BUILD_DIR"

# ── Dirty-tree guard ───────────────────────────────────────────────────────
# Abort if tracked files have uncommitted changes.
# Untracked files (lines starting with '??') are ignored — they don't affect
# git checkout during rollback.

DIRTY="$(git -C "$PRIMARY_BUILD_DIR" status --porcelain 2>/dev/null | grep -v '^??')"
if [[ -n "$DIRTY" ]]; then
  log "Dirty working tree detected:"
  echo "$DIRTY" | while IFS= read -r line; do log "  $line"; done
  notify "DEPLOY ABORTED [${PRIMARY}]: uncommitted changes in $PRIMARY_BUILD_DIR — commit or stash first" warn
  exit 1
fi

# ── Capture deploy SHA ─────────────────────────────────────────────────────

DEPLOY_SHA="$(git -C "$PRIMARY_BUILD_DIR" rev-parse HEAD 2>/dev/null)" || {
  log "ERROR: cannot read HEAD in $PRIMARY_BUILD_DIR — not a git repository?"
  exit 1
}
DEPLOY_SHORT="${DEPLOY_SHA:0:12}"

# ── Load LAST_GOOD from marker ─────────────────────────────────────────────

MARKER="${MARKER_DIR}/.deploy-last-good-${PRIMARY}"
LAST_GOOD=""
if [[ -f "$MARKER" ]]; then
  LAST_GOOD="$(cat "$MARKER")"
  LAST_GOOD_SHORT="${LAST_GOOD:0:12}"
  log "LAST_GOOD: $LAST_GOOD_SHORT (from $MARKER)"
else
  log "No LAST_GOOD marker — first deploy, rollback not available"
fi

log "Deploy SHA: $DEPLOY_SHORT"

# ── Build + Gates ──────────────────────────────────────────────────────────

if ! build_services "${SERVICES[@]}"; then
  notify "DEPLOY FAILED [${PRIMARY}] ${DEPLOY_SHORT}: build/gate error — see logs" error
  exit 1
fi

# ── Restart ────────────────────────────────────────────────────────────────

if ! restart_services "${SERVICES[@]}"; then
  notify "DEPLOY FAILED [${PRIMARY}] ${DEPLOY_SHORT}: restart error — see logs" error
  exit 1
fi

# ── Health + Smoke ─────────────────────────────────────────────────────────

DEPLOY_OK=0
if health_check_all "${SERVICES[@]}" && run_smoke; then
  DEPLOY_OK=1
fi

if [[ "$DEPLOY_OK" -eq 1 ]]; then
  echo "$DEPLOY_SHA" > "$MARKER"
  notify "DEPLOY OK ${DEPLOY_SHORT} — Smoke: ALL PASS" info
  log "=== DEPLOY OK ==="
  exit 0
fi

# ── Rollback ───────────────────────────────────────────────────────────────

log "=== ROLLBACK TRIGGERED [${SERVICES[*]}] ==="

if [[ -z "$LAST_GOOD" ]]; then
  notify "DEPLOY FAILED [${PRIMARY}] ${DEPLOY_SHORT} — kein LAST_GOOD verfügbar, manuell prüfen!" error
  exit 1
fi

LAST_GOOD_SHORT="${LAST_GOOD:0:12}"
log "Rollback: checkout $LAST_GOOD_SHORT in $PRIMARY_BUILD_DIR"

# Restore working tree to last-good state (only working tree, HEAD stays at DEPLOY_SHA)
if ! git -C "$PRIMARY_BUILD_DIR" checkout "$LAST_GOOD" -- .; then
  notify "ROLLBACK FAILED [${PRIMARY}]: git checkout ${LAST_GOOD_SHORT} fehlgeschlagen — ALARM, manueller Eingriff erforderlich!" error
  exit 2
fi

log "Rollback: rebuilding at $LAST_GOOD_SHORT"
if ! build_services "${SERVICES[@]}"; then
  notify "ROLLBACK FAILED [${PRIMARY}]: rebuild ${LAST_GOOD_SHORT} fehlgeschlagen — ALARM!" error
  exit 2
fi

log "Rollback: restarting services"
if ! restart_services "${SERVICES[@]}"; then
  notify "ROLLBACK FAILED [${PRIMARY}]: restart ${LAST_GOOD_SHORT} fehlgeschlagen — ALARM!" error
  exit 2
fi

# Health + smoke on rollback state (no injection — always run real smoke here)
unset DEPLOY_SMOKE_INJECT_FAIL 2>/dev/null || true

RB_OK=0
if health_check_all "${SERVICES[@]}" && run_smoke; then
  RB_OK=1
fi

if [[ "$RB_OK" -eq 1 ]]; then
  notify "ROLLBACK auf ${LAST_GOOD_SHORT} — Service stabil, Smoke grün" warn
  log "=== ROLLBACK OK ==="
  exit 1
else
  notify "ROLLBACK FAILED [${PRIMARY}] ${LAST_GOOD_SHORT} — Health/Smoke rot — ALARM, manueller Eingriff erforderlich!" error
  log "=== ROLLBACK FAILED ==="
  exit 2
fi
