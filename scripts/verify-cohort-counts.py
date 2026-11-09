#!/usr/bin/env python3
"""Independent check of a finished plan's cohort counts, recomputed from the raw MIMIC-IV archive with plain pandas.

It uses none of the platform's extraction code. It reads only the plan's own study definition (the population, exposure
and outcome conditions) and the code sets and drug labels the run recorded, rebuilds the cohort step by step, and prints
the counts beside the platform's: admissions assessed, units that ended before the follow-up start, units already dead
at it, units outside the population, repeat admissions of a patient, the cohort, the exposed and unexposed, and the
outcome events.

Supported design (hospital-admission index, first eligible admission per patient, binary outcome):
  population: a condition tree of diagnosis-code sets, drug labels in the first 24 hours, and sex (all / any / not);
  exposure:   the same kind of condition, present or not in the first 24 hours;
  outcome:    in-hospital all-cause death (date of death on or before the discharge day) or a diagnosis-code set.
ICU-indexed designs and continuous outcomes are not supported and are reported as such.
Aggregate counts only; no patient-level rows are written.

Usage: python3 scripts/verify-cohort-counts.py --archive mimic-iv-3.1.zip --run RUN_DIR [--plan f2]
"""
import argparse, gzip, json, os, sys, zipfile
import pandas as pd

LANDMARK_HOURS = 24
EXPOSURE_HOURS = 24


def read(archive, name, **kwargs):
    zf = zipfile.ZipFile(archive)
    member = next(n for n in zf.namelist() if n.endswith(f"/{name}.csv.gz"))
    return pd.read_csv(gzip.GzipFile(fileobj=zf.open(member)), **kwargs)


def leaves(condition):
    if condition["kind"] in ("all", "any"):
        for operand in condition["operands"]:
            yield from leaves(operand)
    elif condition["kind"] == "not":
        yield from leaves(condition["operand"])
    else:
        yield condition


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    run = json.load(open(os.path.join(args.run, "run.json")))
    plan = next(p for p in run["plans"] if p["plan_id"] == args.plan)
    spec = plan["study_spec"]
    print(f"Question: {run['question'][:90]}\nPlan {args.plan}: {spec['outcome']['name']} | exposure {spec['exposure_or_predictors'][0]['name']}")
    if "ICU" in spec["index_time"]["event"] or spec.get("outcome_structure") not in ("binary", None):
        print("Not supported by this verifier (ICU index or non-binary outcome)."); return 0
    selected = {}
    for m in plan["mapping"]:
        if m.get("selected"): selected.setdefault((m["role"], m["requested_term"].lower()), m["selected"])
    exposure_def = spec["exposure_or_predictors"][0]["definition"]
    population_def = (spec.get("population") or {}).get("criteria")
    outcome_def = spec["outcome"]["definition"]

    # The run summary lists only the first 60 values of a mapping; the locked plan's manifest holds the full lists.
    full = {}
    locked_file = os.path.join(args.run, "locked-plan.json")
    if os.path.exists(locked_file):
        locked = json.load(open(locked_file))
        manifest = next((q["manifest"] for q in locked["draft"]["plans"] if q["plan"]["plan_id"] == args.plan), None)
        for v in (manifest or {}).get("variables", []):
            rule = v["value_rule"]
            if rule["kind"] == "codes": full.setdefault(v["requested_label"].lower(), {"table": "diagnoses_icd", "values": [f"ICD-{c['version']} {c['code']}" for c in rule["codes"]]})
            elif rule["kind"] == "matching_values": full.setdefault(v["requested_label"].lower(), {"table": "prescriptions", "values": rule["values"]})

    def mapping_for(role, leaf):
        if leaf["concept"].lower() in full: return full[leaf["concept"].lower()]
        for r in (role, "population", "exposure", "outcome"):
            hit = selected.get((r, leaf["concept"].lower()))
            if hit: return hit
        raise KeyError(f"no recorded mapping for {leaf['concept']}")

    admissions = read(args.archive, "admissions", usecols=["subject_id", "hadm_id", "admittime", "dischtime"], parse_dates=["admittime", "dischtime"])
    patients = read(args.archive, "patients", usecols=["subject_id", "gender", "dod"], parse_dates=["dod"])
    admissions = admissions.merge(patients, on="subject_id", how="left").set_index("hadm_id", drop=False)
    admissions.index.name = None
    assessed = len(admissions)
    ended = admissions["dischtime"] < admissions["admittime"] + pd.Timedelta(hours=LANDMARK_HOURS)
    # A unit whose outcome is already recorded at the follow-up start is not followed from it: a date of death (the end of
    # that day) from time zero to the landmark. A date of death before time zero is reached through the patient, not this
    # admission, so it is history and excludes no one. A diagnosis code has no date and never is.
    death_outcome = next(sel for (r, _), sel in selected.items() if r == "outcome")["table"].endswith("patients")
    death_day_end = admissions["dod"].dt.normalize() + pd.Timedelta(days=1) - pd.Timedelta(milliseconds=1)
    early = (~ended & (death_day_end >= admissions["admittime"]) & (death_day_end < admissions["admittime"] + pd.Timedelta(hours=LANDMARK_HOURS))
             if death_outcome else pd.Series(False, index=admissions.index))
    after = admissions[~ended & ~early]

    # What each leaf needs from the archive.
    code_sets, drug_sets = {}, {}
    all_leaves = [leaf for tree in (population_def, exposure_def, outcome_def) if tree for leaf in leaves(tree)]
    for leaf in all_leaves:
        if leaf["kind"] == "category_comparison": continue
        sel = mapping_for("population", leaf)
        if sel["table"].endswith("diagnoses_icd"):
            code_sets[leaf["concept"]] = {tuple(v.split(" ", 1)) for v in sel["values"]}
        elif sel["table"].endswith("prescriptions"):
            drug_sets[leaf["concept"]] = set(sel["values"])
    code_hits = {name: set() for name in code_sets}
    for chunk in read(args.archive, "diagnoses_icd", usecols=["hadm_id", "icd_code", "icd_version"], dtype={"icd_code": str}, chunksize=2_000_000):
        for name, codes in code_sets.items():
            wanted = pd.DataFrame(sorted(codes), columns=["icd_version", "icd_code"]).assign(icd_version=lambda d: d["icd_version"].str.replace("ICD-", "").astype(int))
            code_hits[name].update(chunk.merge(wanted, on=["icd_version", "icd_code"])["hadm_id"].tolist())
    drug_hits = {name: set() for name in drug_sets}
    undated = {}
    if drug_sets:
        origin = admissions["admittime"]
        for chunk in read(args.archive, "prescriptions", usecols=["hadm_id", "drug", "starttime"], parse_dates=["starttime"], chunksize=2_000_000):
            for name, labels in drug_sets.items():
                wanted = {label.lower() for label in labels}
                part = chunk[chunk["drug"].astype(str).str.lower().isin(wanted)]  # the platform compares labels ignoring case
                start = part["hadm_id"].map(origin)
                inside = (part["starttime"] >= start) & (part["starttime"] < start + pd.Timedelta(hours=EXPOSURE_HOURS))
                drug_hits[name].update(part.loc[inside, "hadm_id"].tolist())
                undated.setdefault(name, set()).update(part.loc[part["starttime"].isna(), "hadm_id"].tolist())

    def evaluate(condition, index):
        kind = condition["kind"]
        if kind == "all": return pd.concat([evaluate(c, index) for c in condition["operands"]], axis=1).all(axis=1)
        if kind == "any": return pd.concat([evaluate(c, index) for c in condition["operands"]], axis=1).any(axis=1)
        if kind == "not": return ~evaluate(condition["operand"], index)
        if kind == "category_comparison":
            wanted = {v.upper() for v in condition["values"]}
            inside = admissions.loc[index, "gender"].astype(str).str.upper().isin(wanted)
            return inside if condition["operator"] == "in" else ~inside
        name = condition["concept"]
        if name in code_hits: present = pd.Series(index.isin(code_hits[name]), index=index)
        elif name in drug_hits: present = pd.Series(index.isin(drug_hits[name]), index=index)
        else: raise KeyError(name)
        return present if condition.get("assertion", condition.get("occurrence")) == "present" else ~present

    if population_def:
        in_population = evaluate(population_def, after.index)
        eligible = after[in_population.values]
    else:
        eligible = after
    not_in_population = len(after) - len(eligible)
    eligible = eligible.sort_values(["subject_id", "admittime", "hadm_id"])
    cohort = eligible.drop_duplicates("subject_id", keep="first")
    not_first = len(eligible) - len(cohort)
    exposed = evaluate(exposure_def, cohort.index)

    patients_table = "patients" in json.dumps(outcome_def) or any(sel["table"].endswith("patients") for (r, _), sel in selected.items() if r == "outcome")
    outcome_sel = next(sel for (r, _), sel in selected.items() if r == "outcome")
    if outcome_sel["table"].endswith("patients"):
        # A death (the end of its day) from the follow-up start to the discharge day; a date before time zero is history.
        died = cohort["dod"].dt.normalize() + pd.Timedelta(days=1) - pd.Timedelta(milliseconds=1)
        event = cohort["dod"].notna() & (died >= cohort["admittime"] + pd.Timedelta(hours=LANDMARK_HOURS)) & (cohort["dod"].dt.normalize() <= cohort["dischtime"].dt.normalize())
    else:
        event = pd.Series(cohort.index.isin(code_hits[outcome_def["concept"]]), index=cohort.index)

    theirs = plan["cohort"]; reasons = theirs.get("exclusion_reasons", {})
    group = next((c["observed"] for c in plan["quality"]["checks"] if c["check_id"] == "group_sizes"), "")
    events = next((c["observed"] for c in plan["quality"]["checks"] if c["check_id"] == "outcome_events"), "")
    rows = [
        ("Admissions assessed", assessed, theirs["analysis_units"]),
        ("Ended before follow-up start", int(ended.sum()), reasons.get("ended_before_landmark", 0)),
        ("Outcome before follow-up start", int(early.sum()), reasons.get("outcome_before_landmark", 0)),
        ("Not in population", not_in_population, reasons.get("not_in_population", 0)),
        ("Not first eligible admission", not_first, reasons.get("not_first_eligible_unit_of_patient", 0)),
        ("Cohort", len(cohort), theirs["rows"]),
    ]
    print(f"\n{'Step':34}{'Independent':>14}{'Platform':>14}  Match")
    for name, mine, platform in rows:
        print(f"{name:34}{mine:>14,}{format(platform, ','):>14}  {'yes' if mine == platform else 'NO'}")
    e, u, ev = int(exposed.sum()), int((~exposed).sum()), int(event.sum())
    # Diagnostic: cohort patients with a matching prescription that has no start time and no dated match in the window.
    if undated:
        extra = set().union(*undated.values()) & set(cohort.index[~exposed.values])
        print(f"Unexposed here but with a matching prescription that has no start time: {len(extra):,}")
    print(f"\nExposed / unexposed   independent {e:,} / {u:,}   platform: {group}")
    print(f"Outcome events        independent {ev:,} of {len(cohort):,}   platform: {events}")
    a, c = int((event & exposed).sum()), int((event & ~exposed).sum())
    if min(a, c) and e > a and u > c:
        print(f"Crude odds ratio (independent): {(a / (e - a)) / (c / (u - c)):.3f}   (exposed events {a:,}, unexposed events {c:,})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
