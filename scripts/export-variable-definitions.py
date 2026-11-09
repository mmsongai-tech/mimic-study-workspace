#!/usr/bin/env python3
"""Writes the full variable definitions of a finished run: every code, drug label and item id behind each variable.

The run summary lists only the first values of a long list; the locked plan's execution manifest holds all of them.
Output (next to the run's reports, or in --out): variable-definitions.csv with one row per code, label or item id.
Definitions only: no patient data. Usage: python3 scripts/export-variable-definitions.py RUN_DIR [--out DIR]
"""
import argparse, csv, json, os, sys


def rows_for(plan_id, variable):
    rule = variable["value_rule"]; kind = rule["kind"]
    base = {"plan": plan_id, "role": variable["role"], "variable": variable["requested_label"], "source": variable["source_id"], "rule": kind,
            "aggregation": variable.get("aggregation") or "", "valid_range": json.dumps(variable["valid_range"]) if variable.get("valid_range") else ""}
    if kind == "codes":
        for c in rule["codes"]: yield {**base, "kind": "ICD code", "value": f"ICD-{c['version']} {c['code']}", "detail": ""}
    elif kind == "matching_values":
        for v in rule["values"]: yield {**base, "kind": f"{rule['column']} label", "value": v, "detail": ""}
        for extra in rule.get("also", []) or []:
            for v in extra.get("values", []): yield {**base, "kind": f"{extra['column']} label (also required)", "value": v, "detail": ""}
    elif kind == "item_ids":
        for i in rule["ids"]: yield {**base, "kind": "itemid", "value": str(i), "detail": f"value column {rule.get('value_column', '')}"}
    elif kind == "weighted_amount":
        for c in rule["conversions"]: yield {**base, "kind": "itemid (weighted)", "value": str(c["item_id"]), "detail": json.dumps({k: v for k, v in c.items() if k != "item_id"}, ensure_ascii=False)}
    elif kind == "code_score":
        for g in rule["groups"]:
            for c in g.get("code_prefixes", []): yield {**base, "kind": f"score group {g['group_id']} (code prefix)", "value": f"ICD-{c['version']} {c['prefix']}*", "detail": f"weight {g.get('weight', '')}"}
    else:
        yield {**base, "kind": "field", "value": rule.get("column", ""), "detail": json.dumps({k: v for k, v in rule.items() if k not in ('kind', 'column')}, ensure_ascii=False)[:300]}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("run"); parser.add_argument("--out")
    args = parser.parse_args()
    locked = json.load(open(os.path.join(args.run, "locked-plan.json")))
    rows = []
    for item in locked["draft"]["plans"]:
        manifest = item.get("manifest")
        if not manifest: continue
        seen = set()
        for variable in manifest["variables"]:
            key = (variable["role"], variable["requested_label"], json.dumps(variable["value_rule"], sort_keys=True))
            if key in seen: continue
            seen.add(key); rows.extend(rows_for(item["plan"]["plan_id"], variable))
    os.makedirs(args.out or args.run, exist_ok=True)
    out = os.path.join(args.out or args.run, "variable-definitions.csv")
    fields = ["plan", "role", "variable", "source", "rule", "kind", "value", "detail", "aggregation", "valid_range"]
    with open(out, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields); writer.writeheader(); writer.writerows(rows)
    print(f"{out}: {len(rows)} rows")


if __name__ == "__main__":
    sys.exit(main())
