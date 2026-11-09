#!/usr/bin/env python3
"""Compares two planning runs of the same questions variable by variable, for example embedding search off and on.

Planning only: it reads the plan drafts of the two runs (run directories of a question workspace) and, for the variables whose
mapping changed, the dictionary entries of the chosen mapping from each run's mapping store. No patient data is read.
  python3 scripts/compare-planning-arms.py --off-results A/results.json --off-runs RUNS_A --off-store A.sqlite \
      --on-results B/results.json --on-runs RUNS_B --on-store B.sqlite --out DIR
Writes DIR/comparison.json (with the labels of the changed variables' entries: keep DIR under .local/) and prints counts only.
"""
import argparse, collections, json, os, sqlite3


def load_results(path):
    data = json.load(open(path))
    return data if isinstance(data, dict) else {row["key"]: row for row in data}


def draft(runs, run_id):
    path = os.path.join(runs, run_id or "-", "plan-draft.json")
    return json.load(open(path)) if run_id and os.path.exists(path) else None


def frames(plan_draft):
    def text(slot):
        return slot.get("text") if isinstance(slot, dict) else None
    out = []
    for frame in (plan_draft or {}).get("frame_set", {}).get("frames", []):
        out.append({"type": frame.get("study_type"), "population": text(frame.get("population")), "exposure": text(frame.get("exposure")), "outcome": text(frame.get("outcome")),
                    "predictors": [text(x) for x in frame.get("predictors", [])], "modifiers": [text(x) for x in frame.get("modifiers", [])]})
    return out


def variables(plan_draft):
    """(plan position, role, requested term) -> status and selected mapping; a term seen in several plans keeps each."""
    out = {}
    for index, plan in enumerate((plan_draft or {}).get("plans", [])):
        for item in plan.get("mapping", []):
            selected = item.get("selected") or {}
            out[(index, item.get("role"), item.get("requested_term"))] = {"status": item.get("status"), "mapping_id": selected.get("mapping_id"), "label": selected.get("label"),
                                                                          "mapping_status": selected.get("status"), "identifiers": selected.get("identifiers")}
    return out


def entries(store, mapping_id):
    if not store or not mapping_id or not os.path.exists(store):
        return None
    row = sqlite3.connect(f"file:{store}?mode=ro", uri=True).execute("SELECT json FROM variable_mapping WHERE mapping_id = ?", (mapping_id,)).fetchone()
    if not row:
        return None
    record = json.loads(row[0])
    listed = [{"dictionary": e.get("dictionary"), "identifier": e.get("identifier"), "label": e.get("label"), "code_version": e.get("code_version")} for e in record.get("evidence", {}).get("dictionary_entries", [])]
    selected = record.get("evidence", {}).get("automated_review", {}).get("selected_evidence_keys")
    return {"concept_id": record.get("concept_id"), "status": record.get("status"), "label": record.get("labels", {}).get("en"), "entries": listed[:60], "entry_count": len(listed),
            "sources": [{"kind": s.get("kind"), "table": s.get("table"), "items": len(s.get("item_ids") or []), "codes": len(s.get("codes") or []), "values": sum(len(v.get("values", [])) for v in s.get("value_filters") or [])} for s in record.get("sources", [])],
            **({"selected_keys": len(selected)} if selected else {})}


def main():
    parser = argparse.ArgumentParser()
    for arm in ("off", "on"):
        parser.add_argument(f"--{arm}-results", required=True); parser.add_argument(f"--{arm}-runs", required=True); parser.add_argument(f"--{arm}-store")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    off, on = load_results(args.off_results), load_results(args.on_results)
    report = {"questions": [], "totals": {}}
    totals = collections.Counter()
    for key in sorted(set(off) | set(on)):
        a, b = off.get(key, {}), on.get(key, {})
        da, db = draft(args.off_runs, a.get("run_id")), draft(args.on_runs, b.get("run_id"))
        va, vb = variables(da), variables(db)
        same_frames = frames(da) == frames(db)
        question = {"key": key, "status": [a.get("status"), b.get("status")], "plans": [sorted(p["status"] for p in a.get("plans", [])), sorted(p["status"] for p in b.get("plans", []))],
                    "unmapped": [sorted({t for p in a.get("plans", []) for t in p.get("unmapped", [])}), sorted({t for p in b.get("plans", []) for t in p.get("unmapped", [])})],
                    "same_frames": same_frames, "changes": []}
        for arm, row in (("off", a), ("on", b)):
            for plan in row.get("plans", []):
                totals[f"{arm}.{plan['status']}"] += 1
            totals[f"{arm}.unmapped_terms"] += len({t for p in row.get("plans", []) for t in p.get("unmapped", [])})
            totals[f"{arm}.questions_{row.get('status')}"] += 1
        if not same_frames:
            totals["questions_with_different_framing"] += 1
        for variable in sorted(set(va) | set(vb), key=str):
            x, y = va.get(variable), vb.get(variable)
            if x and y and x["status"] == y["status"] and x["mapping_id"] == y["mapping_id"]:
                continue
            kind = ("only_off" if not y else "only_on" if not x else "newly_resolved" if y["status"] == "resolved" and x["status"] != "resolved"
                    else "newly_unresolved" if x["status"] == "resolved" and y["status"] != "resolved" else "changed_mapping" if x["mapping_id"] != y["mapping_id"] else "changed_status")
            totals[f"variables.{kind}"] += 1
            question["changes"].append({"plan": variable[0], "role": variable[1], "term": variable[2], "kind": kind, "off": x, "on": y,
                                        "off_mapping": entries(args.off_store, (x or {}).get("mapping_id")) if kind in ("newly_resolved", "changed_mapping", "newly_unresolved", "changed_status") else None,
                                        "on_mapping": entries(args.on_store, (y or {}).get("mapping_id")) if kind in ("newly_resolved", "changed_mapping", "newly_unresolved", "changed_status") else None})
        report["questions"].append(question)
    report["totals"] = dict(sorted(totals.items()))
    os.makedirs(args.out, exist_ok=True)
    json.dump(report, open(os.path.join(args.out, "comparison.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(report["totals"], indent=1))
    for question in report["questions"]:
        if question["changes"] or not question["same_frames"] or question["plans"][0] != question["plans"][1]:
            print(f"{question['key']:5} frames {'same' if question['same_frames'] else 'DIFFER'}  plans {question['plans'][0]} -> {question['plans'][1]}  changes {collections.Counter(c['kind'] for c in question['changes'])}")


if __name__ == "__main__":
    main()
