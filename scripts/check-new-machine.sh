#!/usr/bin/env bash
# Checks that this machine runs the platform the way the original machine did, before you rely on it.
# Plans questions without reading patient data, runs the unit tests, and (with RUN_ONE=1) answers one question end to end.
#
#   MIMIC_LOCAL_ARCHIVE=/path/to/mimic-iv-3.1.zip bash scripts/check-new-machine.sh
#   RUN_ONE=1 MIMIC_LOCAL_ARCHIVE=... bash scripts/check-new-machine.sh      # also runs one question on the archive (about 10 minutes)
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$root"
fail=0
step() { printf '\n== %s\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*"; fail=$((fail + 1)); }

step "1. Setup state"
bash scripts/setup-new-machine.sh >/tmp/setup-check.log 2>&1 && ok "setup script has nothing left to do" || { bad "setup script lists items to do (see /tmp/setup-check.log)"; grep -A1 '\[todo\]' /tmp/setup-check.log; }

step "2. Unit tests (about 830, a few minutes)"
npm test >/tmp/npm-test.log 2>&1; grep -E '^ℹ (tests|pass|fail|skipped)' /tmp/npm-test.log
grep -qE '^ℹ fail 0' /tmp/npm-test.log && ok "all tests pass" || bad "some tests fail (see /tmp/npm-test.log)"

step "3. Planning regression (two questions; the full set is: python3 scripts/regression-planning.py --out results/regression)"
if curl -s http://127.0.0.1:9000/api/runs >/dev/null 2>&1; then
  python3 scripts/regression-planning.py --out /tmp/regression --only T1,P2 >/tmp/regression.log 2>&1 && ok "planning matches the snapshot" || bad "planning differs from the snapshot (see /tmp/regression.log)"
else bad "the workspace is not running: start it with scripts/start-workspace.sh in another terminal, then run this again"; fi

if [ -n "${RUN_ONE:-}" ]; then
  step "4. One question end to end"
  python3 - <<'PY' || fail=$((fail + 1))
import json, sys, time, urllib.request
call = lambda path, body=None: json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9000" + path, data=None if body is None else json.dumps(body).encode(), headers={"content-type": "application/json"}), timeout=60))
run = call("/api/runs", {"question": "In ICU patients with heart failure, is beta-blocker use associated with lower in-hospital mortality?", "auto_confirm": True})
deadline = time.time() + 3600
while time.time() < deadline:
    state = call("/api/runs/" + run["id"])
    if state["status"] in ("completed", "failed"): break
    time.sleep(20)
print("  status:", state["status"], state.get("result_summary"))
sys.exit(0 if state["status"] == "completed" and (state.get("result_summary") or {}).get("completed", 0) >= 1 else 1)
PY
fi

printf '\n'
if [ "$fail" -eq 0 ]; then echo "All checks passed."; else echo "$fail check(s) failed."; fi
exit "$fail"
