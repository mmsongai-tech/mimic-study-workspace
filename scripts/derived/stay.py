"""Across admissions: readmission, history of earlier admissions, discharge status and length of stay.

Every event belongs to the INDEX admission and is timed inside it, so the platform's windows (which end with the encounter)
include it:
  readmission, any cause, within 30, 90 or 365 days: at the index discharge, value = days from the index discharge to the start
    of the patient's next admission, present only when that is within the horizon (absent when there is none, or when the
    patient died in hospital: not at risk). One derived item per horizon.
  readmission with diagnosis X within 30, 90 or 365 days: the same, counting only a later admission that carries a diagnosis
    code of X (the first one that does).
  history of diagnosis X: at the index admission time, 1 when any EARLIER admission of the patient carries a code of X; used to
    approximate "new onset" (no earlier record), which diagnosis codes of the index admission alone cannot show.
  discharged alive: at the index discharge, 1 unless the admission ended in death (the population of a readmission analysis).
  hospital length of stay in days, at the discharge.
Only admissions of the same hospital are linked: a readmission elsewhere is not seen.
"""
import json, os
import numpy as np
import pandas as pd
from common import DERIVED_BASE, events, read_table

ITEMS = {
    "discharged_alive": (DERIVED_BASE + 10, "Discharged alive", "1", "At the discharge of an admission that did not end in death."),
    "hospital_los_days": (DERIVED_BASE + 11, "Hospital length of stay", "days", "Discharge time minus admission time, at the discharge."),
}
HORIZONS = (30, 90, 365)
for _index, _days in enumerate(HORIZONS):
    ITEMS[f"readmission_{_days}d"] = (DERIVED_BASE + 12 + _index, f"Readmission within {_days} days, any cause", "days", "Days from the index discharge to the next admission, when within the horizon; absent otherwise, or when the patient died in hospital.")
READMIT_BASE = DERIVED_BASE + 1000   # + 10 * position of the diagnosis concept + position of the horizon
HISTORY_BASE = DERIVED_BASE + 2000   # + position of the diagnosis concept
MAX_DAYS = max(HORIZONS)


def diagnosis_concepts(pack_path):
    pack = json.load(open(pack_path, encoding="utf-8"))
    out = []
    for m in pack["mappings"]:
        source = m["sources"][0]
        if source.get("kind") == "diagnosis_code" and source.get("codes"): out.append((m["concept_id"], {(c["version"], c["code"]) for c in source["codes"]}))
    # A fixed order, so an item id never depends on where an entry sits in the pack file or on which concepts exist.
    order = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "config", "derived", "diagnosis-order.json"), encoding="utf-8"))["order"]
    unknown = [concept for concept, _ in out if concept not in order]
    if unknown: raise SystemExit(f"Append {unknown} to config/derived/diagnosis-order.json before building the derived layer.")
    return sorted(out, key=lambda item: order.index(item[0]))


def build(archive, cache, pack_path):
    adm = read_table(archive, "admissions", usecols=["subject_id", "hadm_id", "admittime", "dischtime", "hospital_expire_flag"])
    adm["admittime"] = pd.to_datetime(adm["admittime"]); adm["dischtime"] = pd.to_datetime(adm["dischtime"])
    adm = adm.sort_values(["subject_id", "admittime"]).reset_index(drop=True)
    died = adm["hospital_expire_flag"].eq(1)
    out = []

    alive = adm[~died]
    out.append(events(alive, ITEMS["discharged_alive"][0], "dischtime"))
    los = adm.assign(los=(adm["dischtime"] - adm["admittime"]).dt.total_seconds() / 86400)
    out.append(events(los[los["los"] >= 0], ITEMS["hospital_los_days"][0], "dischtime", "los"))

    adm["next_admit"] = adm.groupby("subject_id")["admittime"].shift(-1)
    adm["next_hadm"] = adm.groupby("subject_id")["hadm_id"].shift(-1)
    follow = adm[~died & adm["next_admit"].notna()].copy()
    follow["days"] = (follow["next_admit"] - follow["dischtime"]).dt.total_seconds() / 86400
    follow = follow[(follow["days"] >= 0) & (follow["days"] <= MAX_DAYS)]
    for index, days in enumerate(HORIZONS):
        out.append(events(follow[follow["days"] <= days], ITEMS[f"readmission_{days}d"][0], "dischtime", "days"))

    diagnoses = read_table(archive, "diagnoses_icd", usecols=["hadm_id", "icd_code", "icd_version"], dtype={"icd_code": str})
    diagnoses["icd_code"] = diagnoses["icd_code"].str.strip()
    key = list(zip(diagnoses["icd_version"], diagnoses["icd_code"]))
    summary = {"admissions": len(adm), "died_in_hospital": int(died.sum()), "readmitted_365d": int(len(follow)), "readmitted_30d": int((follow["days"] <= 30).sum()), "readmitted_90d": int((follow["days"] <= 90).sum()), "per_diagnosis": {}}
    codes_by_hadm = None
    for position, (concept, codes) in enumerate(diagnosis_concepts(pack_path)):
        hit = np.fromiter(((v, c) in codes for v, c in key), dtype=bool, count=len(key))
        has = set(diagnoses.loc[hit, "hadm_id"].unique())
        carries = adm["hadm_id"].isin(has)
        # readmission with the diagnosis: the first LATER admission of the patient that carries it
        later = adm[["subject_id", "hadm_id", "admittime", "dischtime"]].copy(); later["carries"] = carries.values
        carrying = later[later["carries"]][["subject_id", "admittime"]].rename(columns={"admittime": "carry_time"})
        index_rows = adm[~died][["subject_id", "hadm_id", "dischtime"]].merge(carrying, on="subject_id", how="inner")
        index_rows = index_rows[index_rows["carry_time"] > index_rows["dischtime"]]
        first = index_rows.sort_values("carry_time").groupby("hadm_id", as_index=False).first()
        first["days"] = (first["carry_time"] - first["dischtime"]).dt.total_seconds() / 86400
        first = first[first["days"] <= MAX_DAYS].merge(adm[["hadm_id", "subject_id"]].rename(columns={"subject_id": "s2"}), on="hadm_id")
        for index, days in enumerate(HORIZONS): out.append(events(first[first["days"] <= days], READMIT_BASE + 10 * position + index, "dischtime", "days"))
        # history: any earlier admission carrying it
        earlier = later[later["carries"]][["subject_id", "dischtime"]].rename(columns={"dischtime": "prior_disch"})
        hist = adm[["subject_id", "hadm_id", "admittime"]].merge(earlier, on="subject_id", how="inner")
        hist = hist[hist["prior_disch"] <= hist["admittime"]].drop_duplicates("hadm_id")
        out.append(events(hist, HISTORY_BASE + position, "admittime"))
        summary["per_diagnosis"][concept] = {"readmitted_with_365d": int(len(first)), "with_history": int(len(hist))}
    items = {**{k: v for k, v in ITEMS.items()}}
    for position, (concept, _) in enumerate(diagnosis_concepts(pack_path)):
        for index, days in enumerate(HORIZONS): items[f"readmission_with_{concept}_{days}d"] = (READMIT_BASE + 10 * position + index, f"Readmission with {concept} within {days} days", "days", "Days from the index discharge to the first later admission carrying the diagnosis, when within the horizon.")
        items[f"history_of_{concept}"] = (HISTORY_BASE + position, f"History of {concept}", "1", "An earlier admission of the patient carries the diagnosis.")
    return pd.concat(out, ignore_index=True), summary, items
