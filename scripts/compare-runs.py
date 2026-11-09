#!/usr/bin/env python3
"""Compares two sets of finished question runs and lists every analysis whose result changed.

A change in code, concept pack or derived layer can move a result without any warning: a plain diagnosis answered by a readmission
concept once changed the event count of an outcome about sixfold and every check still passed. Run this after any change and read
each line it prints: every change must have a reason you can state.

  python3 scripts/compare-runs.py --before-dir .local/team-test/final2 --before-ids ids-before.json \\
                                  --after-dir  .local/team-test/final3 --after-ids  ids-after.json [--fail-on-change]

The ids files map a question key to a run id ({"Q1": "2026-10-20-ab12cd34", ...}). Aggregate output only; no patient data.
"""
import argparse, collections, json, os, sys


def load(directory, run_id):
    path = os.path.join(directory, run_id, "run.json")
    return json.load(open(path)) if os.path.exists(path) else None


def summarize(plan):
    result = plan.get("result") or {}
    estimates = [(e["label"], None if e.get("estimate") is None else round(e["estimate"], 3), None if e.get("ci_low") is None else round(e["ci_low"], 3), None if e.get("ci_high") is None else round(e["ci_high"], 3))
                 for e in result.get("estimates", []) if "sensitivity" not in e["label"]][:2]
    variables = {(c.get("role"), c.get("label")): (c.get("mapping_id"), c.get("n_true"), c.get("n")) for c in plan.get("data_profile") or [] if c.get("role") in ("outcome", "exposure", "predictor")}
    return {"status": plan["status"], "n": result.get("n_analysed"), "estimates": estimates, "variables": variables, "rows": (plan.get("cohort") or {}).get("rows")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-dir", required=True); parser.add_argument("--before-ids", required=True)
    parser.add_argument("--after-dir", required=True); parser.add_argument("--after-ids", required=True)
    parser.add_argument("--fail-on-change", action="store_true")
    args = parser.parse_args()
    before_ids, after_ids = json.load(open(args.before_ids)), json.load(open(args.after_ids))
    counts = collections.Counter(); lines = []
    for key in sorted(set(before_ids) & set(after_ids)):
        before, after = load(args.before_dir, before_ids[key]), load(args.after_dir, after_ids[key])
        if not before or not after: lines.append(f"{key}: a run.json is missing"); counts["missing"] += 1; continue
        b = {p["plan_id"]: summarize(p) for p in before["plans"]}; a = {p["plan_id"]: summarize(p) for p in after["plans"]}
        for plan_id in sorted(set(a) | set(b)):
            if plan_id not in b: counts["new plan"] += 1; lines.append(f"{key} {plan_id}: new plan ({a[plan_id]['status']})"); continue
            if plan_id not in a: counts["plan gone"] += 1; lines.append(f"{key} {plan_id}: plan no longer present"); continue
            x, y = b[plan_id], a[plan_id]
            if x["status"] != y["status"]: counts["status"] += 1; lines.append(f"{key} {plan_id}: {x['status']} -> {y['status']}"); continue
            changed = []
            if x["rows"] != y["rows"]: changed.append(f"cohort {x['rows']} -> {y['rows']}")
            if x["n"] != y["n"]: changed.append(f"n analysed {x['n']} -> {y['n']}")
            for variable in sorted(set(x["variables"]) | set(y["variables"]), key=str):
                if x["variables"].get(variable) != y["variables"].get(variable):
                    changed.append(f"{variable[0]} {variable[1]}: {x['variables'].get(variable)} -> {y['variables'].get(variable)}")
            if x["estimates"] != y["estimates"]: changed.append(f"estimates {x['estimates']} -> {y['estimates']}")
            if changed: counts["changed"] += 1; lines.append(f"{key} {plan_id}: " + "; ".join(changed))
            else: counts["identical"] += 1
    print("\n".join(lines)); print(dict(counts))
    if args.fail_on_change and any(counts[name] for name in ("status", "changed", "new plan", "plan gone", "missing")): sys.exit(1)


if __name__ == "__main__":
    main()
