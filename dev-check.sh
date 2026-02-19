#!/usr/bin/env bash
set -euo pipefail
echo "== tsc =="
npx tsc --noEmit
echo "== restart service =="
systemctl --user restart openclaw-gateway.service
echo "== status =="
systemctl --user --no-pager status openclaw-gateway.service | sed -n '1,14p'
echo "OK"
