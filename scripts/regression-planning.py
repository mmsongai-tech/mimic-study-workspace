#!/usr/bin/env python3
"""Plans every question of the regression set and compares what the platform understood with the stored snapshot.

The set is the planning batch (23 questions, including the prediction ones) plus any extra question set placed beside it
(*-questions-*.json); without one the planning batch alone is compared.
Planning only: no analysis runs and no patient data is read, so the snapshot holds framing and mapping outcomes only.
Start the workspace first (see run-planning-batch.py), then:
  python3 scripts/regression-planning.py --out results/regression            # compare with the snapshot
  python3 scripts/regression-planning.py --out results/regression --update   # accept the new outcome as the snapshot
Exit status 1 when a question got worse (a plan that was ready is blocked or missing, or its study type changed).
"""
import argparse, glob, importlib.util, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "backend", "src", "validation-fixtures", "planning-batch")
SNAPSHOT = os.path.join(FIXTURES, "snapshot.json")
spec = importlib.util.spec_from_file_location("batch", os.path.join(HERE, "run-planning-batch.py"))
batch = importlib.util.module_from_spec(spec); spec.loader.exec_module(batch)


def questions():
    rows = []
    # questions.json, then any further question sets (*-questions-*.json) present in this checkout.
    for path in [os.path.join(FIXTURES, "questions.json")] + sorted(glob.glob(os.path.join(FIXTURES, "*-questions-*.json"))):
        rows += json.load(open(path))["questions"]
    return rows


def outcome(row):
    """What matters for stability: the study type, each plan's status and which terms stayed unmapped."""
    return {"status": row.get("status"), "types": [f["type"] for f in row.get("frames", [])],
            "plans": sorted(p["status"] for p in row.get("plans", [])),
            "unmapped": sorted({t for p in row.get("plans", []) for t in p.get("unmapped", [])})}


RANK = {"ready": 2, "needs_confirmation": 1, "blocked": 0}


def worse(old, new):
    reasons = []
    if old["types"] != new["types"]: reasons.append(f"study type {old['types']} → {new['types']}")
    ready = lambda o: sum(1 for s in o["plans"] if s == "ready")
    if ready(new) < ready(old): reasons.append(f"ready plans {ready(old)} → {ready(new)}")
    if new["status"] in ("failed", None) and old["status"] != new["status"]: reasons.append(f"status {old['status']} → {new['status']}")
    return reasons


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:9000")
    parser.add_argument("--out", required=True)
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--only", help="comma-separated keys")
    args = parser.parse_args()
    keys = set(args.only.split(",")) if args.only else None
    os.makedirs(args.out, exist_ok=True)
    results = {}
    for item in questions():
        if keys and item["key"] not in keys: continue
        started = time.time(); row = {}
        try:
            record = batch.call(args.base_url, "/api/runs", {"question": item["question"]})
            run_id = record.get("id") or record.get("run_id"); status = None
            while time.time() - started < args.timeout:
                time.sleep(5); status = batch.call(args.base_url, "/api/runs/" + run_id).get("status")
                if status in ("awaiting_confirmation", "failed", "completed"): break
            row.update({"run_id": run_id, "status": status})
            if status == "awaiting_confirmation": row.update(batch.summarise(batch.call(args.base_url, "/api/runs/" + run_id + "/plan")))
        except Exception as error:
            row["status"] = "error"; row["error"] = str(error)
        results[item["key"]] = row
        json.dump(results, open(os.path.join(args.out, "results.json"), "w"), ensure_ascii=False, indent=1)
        print(f"{item['key']:4} {row.get('status')} {outcome(row)['types']} {outcome(row)['plans']}", flush=True)
    new = {key: outcome(row) for key, row in results.items()}
    if args.update:
        old = json.load(open(SNAPSHOT)) if os.path.exists(SNAPSHOT) else {}
        json.dump({**old, **new}, open(SNAPSHOT, "w"), ensure_ascii=False, indent=1, sort_keys=True)
        print("Snapshot updated:", SNAPSHOT); return 0
    old = json.load(open(SNAPSHOT)) if os.path.exists(SNAPSHOT) else {}
    bad = 0
    for key, now in new.items():
        before = old.get(key)
        if before is None: print(f"NEW      {key}"); continue
        reasons = worse(before, now)
        if reasons: bad += 1; print(f"WORSE    {key}: {'; '.join(reasons)}")
        elif before != now: print(f"CHANGED  {key}: {before['plans']} {before['unmapped']} → {now['plans']} {now['unmapped']}")
    print(f"{len(new)} questions, {bad} worse than the snapshot")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
