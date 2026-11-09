"""Kidney: acute kidney injury by the KDIGO creatinine criteria, and eGFR (CKD-EPI 2021, race-free).

KDIGO (Kidney Int Suppl 2012) creatinine criteria, evaluated at every creatinine measurement of an admission:
  stage 1: a rise of at least 0.3 mg/dL within 48 hours, or at least 1.5 times the lowest value of the previous 7 days;
  stage 2: at least 2.0 times; stage 3: at least 3.0 times, or a value of 4.0 mg/dL or more with a qualifying rise.
The urine-output criterion is not used. The reference value is the lowest creatinine of the same admission, so a patient whose
first creatinine is already raised is not detected. eGFR = 142 * min(Scr/k, 1)^a * max(Scr/k, 1)^-1.200 * 0.9938^age (* 1.012 if
female), k = 0.7 (female) or 0.9, a = -0.241 (female) or -0.302; age is the age at the measurement.
"""
import numpy as np
import pandas as pd
from common import DERIVED_BASE, events, read_table

ITEMS = {
    "aki_kdigo_stage": (DERIVED_BASE + 1, "Acute kidney injury, KDIGO stage (creatinine criteria)", "stage 1-3", "Event at each creatinine that meets a stage; value is the stage."),
    "egfr_ckdepi2021": (DERIVED_BASE + 2, "Estimated GFR, CKD-EPI 2021", "mL/min/1.73 m2", "Computed at each creatinine measurement from creatinine, age and sex."),
}
CREATININE = {50912, 52546}  # the original item and the newer item of the same test (MIMIC-IV 3.0 onward)


def build(archive, cache):
    lab = read_table(archive, "labevents", usecols=["subject_id", "hadm_id", "itemid", "charttime", "valuenum"], filters={"itemid": CREATININE})
    lab = lab.dropna(subset=["valuenum", "hadm_id"]); lab = lab[(lab["valuenum"] > 0) & (lab["valuenum"] < 30)]
    lab["charttime"] = pd.to_datetime(lab["charttime"]); lab["hadm_id"] = lab["hadm_id"].astype("int64")
    lab = lab.sort_values(["hadm_id", "charttime"]).reset_index(drop=True)
    # Lowest creatinine in the previous 48 hours and 7 days of the same admission (the measurement itself included).
    indexed = lab.set_index("charttime")
    grouped = indexed.groupby("hadm_id")["valuenum"]
    low48 = grouped.rolling("48h").min().reset_index(level=0, drop=True)
    low7d = grouped.rolling("7D").min().reset_index(level=0, drop=True)
    lab["low48"] = low48.values; lab["low7d"] = low7d.values
    rise = lab["valuenum"] - lab["low48"]; ratio = lab["valuenum"] / lab["low7d"]
    stage = np.zeros(len(lab), dtype=int)
    stage[(rise >= 0.3) | (ratio >= 1.5)] = 1
    stage[ratio >= 2.0] = 2
    stage[(ratio >= 3.0) | ((lab["valuenum"] >= 4.0) & ((rise >= 0.3) | (ratio >= 1.5)))] = 3
    lab["stage"] = stage
    aki = lab[lab["stage"] >= 1]
    out = [events(aki, ITEMS["aki_kdigo_stage"][0], "charttime", "stage")]

    patients = read_table(archive, "patients", usecols=["subject_id", "gender", "anchor_age", "anchor_year"])
    lab = lab.merge(patients, on="subject_id", how="inner")
    age = lab["anchor_age"] + (lab["charttime"].dt.year - lab["anchor_year"])
    female = lab["gender"].eq("F")
    kappa = np.where(female, 0.7, 0.9); alpha = np.where(female, -0.241, -0.302); scr = lab["valuenum"] / kappa
    lab["egfr"] = 142 * np.minimum(scr, 1) ** alpha * np.maximum(scr, 1) ** -1.200 * 0.9938 ** age * np.where(female, 1.012, 1.0)
    out.append(events(lab, ITEMS["egfr_ckdepi2021"][0], "charttime", "egfr"))
    summary = {"creatinine_measurements": len(lab), "admissions_with_creatinine": lab["hadm_id"].nunique(), "admissions_with_aki": aki["hadm_id"].nunique()}
    return pd.concat(out, ignore_index=True), summary, ITEMS
