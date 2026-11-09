"""First-day severity scores of an ICU stay: OASIS and SAPS II.

Both summarise the first 24 hours after ICU admission and are timed at ICU admission, like the first-day SOFA (see icu.py): they do
not follow a different exposure window. A variable with no measurement adds no points (the same convention as SOFA), which
understates a patient who was never measured.

OASIS (Johnson 2013), 10 variables, no laboratory values. Points:
  pre-ICU length of stay (hours) <0.17 5, <4.95 3, <24.01 0, <311.81 1, else 2;
  age <24 0, <54 3, <78 6, <90 9, else 7;
  lowest Glasgow coma score 3-7 10, 8-13 4, 14 3, 15 0;
  heart rate (highest) <33 4, 33-88 0, 89-106 1, 107-125 3, >=126 6;
  lowest mean arterial pressure <20.65 4, <51 3, <61.33 2, <143.45 0, else 3;
  respiratory rate lowest <6 10; highest >44 9, >30 6, >22 1; lowest <13 1; else 0;
  temperature (Celsius) highest >39.88 6; lowest >=33.22 and highest <=35.93 4; highest <33.22 3; lowest >36.39 and highest <36.89 0; else 2;
  urine output in 24 hours (mL) <671 10, <1427 5, <2544 1, <=6896 0, else 8;
  invasive ventilation in the first day 9; elective surgery 0, any other admission 6.
SAPS II (Le Gall 1993), 15 variables on the worst value of the first day. Points:
  age <40 0, <60 7, <70 12, <75 15, <80 16, else 18;
  heart rate lowest <40 11; highest >=160 7, >=120 4; lowest <70 2; else 0;
  systolic pressure lowest <70 13, <100 5; highest >=200 2; else 0;
  temperature highest >=39 3;
  PaO2/FiO2 (lowest, with invasive ventilation only) <100 11, <200 9, else 6;
  urine output (24 h, mL) <500 11, <1000 4;
  blood urea nitrogen (highest, mg/dL) >=84 10, >=28 6;
  white cells (K/uL) lowest <1 12; highest >=20 3;
  potassium lowest <3 or highest >=5 3; sodium lowest <125 5, highest >=145 1;
  bicarbonate (lowest, mEq/L) <15 6, <20 3; bilirubin (highest, mg/dL) >=6 9, >=4 4;
  lowest Glasgow coma score <6 26, <9 13, <11 7, <14 5;
  AIDS 17, haematologic malignancy 10, metastatic cancer 9 (diagnosis codes of the admission);
  admission scheduled surgical 0, medical 6, unscheduled surgical 8.
"""
import numpy as np
import pandas as pd
from common import read_table

SURGICAL = {"CSURG", "NSURG", "ORTHO", "PSURG", "SURG", "TRAUM", "TSURG", "VSURG", "GU", "ENT", "GYN", "OBS", "PSYCH_SURG"}
AIDS = ("042", "043", "044", "B20", "B21", "B22", "B23", "B24")
HEMATOLOGIC = tuple(f"20{n}" for n in range(0, 9)) + tuple(f"C{n}" for n in range(81, 97))
METASTATIC = ("196", "197", "198", "199", "C77", "C78", "C79", "C7B")


def _points(series, edges, scores, default=0):
    """Score of an ordered value: the first edge it lies below gives its score (edges ascending), otherwise the default."""
    result = pd.Series(default, index=series.index, dtype=float)
    assigned = pd.Series(False, index=series.index)
    for edge, score in zip(edges, scores):
        hit = series.notna() & (series < edge) & ~assigned
        result[hit] = score; assigned |= hit
    return result


def compute(archive, stays, chart, lab, lowest_gcs, urine_total, ratio, ventilated_first_day, items):
    """Scores of every stay in `stays`. `chart` and `lab` hold first-day rows with stay_id; `ratio` is the lowest PaO2/FiO2 of a ventilated stay."""
    index = pd.Index(stays["stay_id"])
    values = lambda frame, ids, how: getattr(frame[frame["itemid"].isin(ids)].groupby("stay_id")["valuenum"], how)().reindex(index)
    hr_max, hr_min = values(chart, items["hr"], "max"), values(chart, items["hr"], "min")
    sbp_max, sbp_min = values(chart, items["sbp"], "max"), values(chart, items["sbp"], "min")
    map_min = values(chart, items["map"], "min")
    rr_max, rr_min = values(chart, items["rr"], "max"), values(chart, items["rr"], "min")
    temp_c = chart[chart["itemid"].isin(items["temp_c"])][["stay_id", "valuenum"]]
    temp_f = chart[chart["itemid"].isin(items["temp_f"])][["stay_id", "valuenum"]].assign(valuenum=lambda frame: (frame["valuenum"] - 32) * 5 / 9)
    temperature = pd.concat([temp_c, temp_f]); temperature = temperature[(temperature["valuenum"] > 10) & (temperature["valuenum"] < 50)]
    temp_max, temp_min = temperature.groupby("stay_id")["valuenum"].max().reindex(index), temperature.groupby("stay_id")["valuenum"].min().reindex(index)
    bun_max = values(lab, items["bun"], "max")
    wbc_min, wbc_max = values(lab, items["wbc"], "min"), values(lab, items["wbc"], "max")
    k_min, k_max = values(lab, items["potassium"], "min"), values(lab, items["potassium"], "max")
    na_min, na_max = values(lab, items["sodium"], "min"), values(lab, items["sodium"], "max")
    hco3_min = values(lab, items["bicarbonate"], "min")
    bili_max = values(lab, items["bilirubin"], "max")
    gcs = lowest_gcs.reindex(index); uo = urine_total.reindex(index)
    ventilated = pd.Series(index.isin(ventilated_first_day), index=index)

    admissions = read_table(archive, "admissions", usecols=["hadm_id", "admittime", "admission_type"])
    admissions["admittime"] = pd.to_datetime(admissions["admittime"])
    patients = read_table(archive, "patients", usecols=["subject_id", "anchor_age", "anchor_year"])
    services = read_table(archive, "services", usecols=["hadm_id", "transfertime", "curr_service"])
    services["transfertime"] = pd.to_datetime(services["transfertime"])
    first_service = services.sort_values("transfertime").groupby("hadm_id")["curr_service"].first()
    diagnoses = read_table(archive, "diagnoses_icd", usecols=["hadm_id", "icd_code"])
    codes = diagnoses["icd_code"].astype(str).str.strip()
    flag = lambda prefixes: set(diagnoses.loc[codes.str.startswith(prefixes), "hadm_id"].dropna().astype("int64"))
    aids, heme, mets = flag(AIDS), flag(HEMATOLOGIC), flag(METASTATIC)

    base = stays.merge(admissions, on="hadm_id", how="left").merge(patients, on="subject_id", how="left").set_index("stay_id").reindex(index)
    age = base["anchor_age"] + base["intime"].dt.year - base["anchor_year"]
    pre_icu_hours = (base["intime"] - base["admittime"]).dt.total_seconds() / 3600
    surgical = base["hadm_id"].map(first_service).isin(SURGICAL)
    elective = base["admission_type"].eq("ELECTIVE")

    # OASIS
    oasis_gcs = pd.Series(np.select([gcs <= 7, gcs <= 13, gcs == 14], [10, 4, 3], 0), index=index).where(gcs.notna(), 0)
    oasis_rr = pd.Series(np.select([rr_min < 6, rr_max > 44, rr_max > 30, rr_max > 22, rr_min < 13], [10, 9, 6, 1, 1], 0), index=index).where(rr_max.notna(), 0)
    oasis_temp = pd.Series(np.select([temp_max > 39.88, (temp_min >= 33.22) & (temp_max <= 35.93), temp_max < 33.22, (temp_min > 36.39) & (temp_max < 36.89)], [6, 4, 3, 0], 2), index=index).where(temp_max.notna(), 0)
    oasis_parts = pd.DataFrame({
        "pre_icu": np.select([pre_icu_hours < 0.17, pre_icu_hours < 4.95, pre_icu_hours < 24.01, pre_icu_hours < 311.81], [5, 3, 0, 1], 2),
        "age": np.select([age < 24, age < 54, age < 78, age < 90], [0, 3, 6, 9], 7),
        "gcs": oasis_gcs,
        "hr": np.select([hr_max < 33, hr_max <= 88, hr_max <= 106, hr_max <= 125], [4, 0, 1, 3], 6) * hr_max.notna(),
        "map": np.select([map_min < 20.65, map_min < 51, map_min < 61.33, map_min < 143.45], [4, 3, 2, 0], 3) * map_min.notna(),
        "rr": oasis_rr, "temp": oasis_temp,
        "urine": np.select([uo < 671, uo < 1427, uo < 2544, uo <= 6896], [10, 5, 1, 0], 8) * uo.notna(),
        "ventilation": np.where(ventilated, 9, 0),
        "surgery": np.where(elective & surgical, 0, 6),
    }, index=index)
    oasis_parts.loc[pre_icu_hours.isna(), "pre_icu"] = 0; oasis_parts.loc[age.isna(), "age"] = 0

    # SAPS II
    ratio_r = ratio.reindex(index)
    sapsii_parts = pd.DataFrame({
        "age": np.select([age < 40, age < 60, age < 70, age < 75, age < 80], [0, 7, 12, 15, 16], 18) * age.notna(),
        "hr": np.select([hr_min < 40, hr_max >= 160, hr_max >= 120, hr_min < 70], [11, 7, 4, 2], 0),
        "sbp": np.select([sbp_min < 70, sbp_min < 100, sbp_max >= 200], [13, 5, 2], 0),
        "temp": np.where(temp_max >= 39, 3, 0),
        "oxygenation": np.where(ventilated & ratio_r.notna(), np.select([ratio_r < 100, ratio_r < 200], [11, 9], 6), 0),
        "urine": np.select([uo < 500, uo < 1000], [11, 4], 0),
        "bun": np.select([bun_max >= 84, bun_max >= 28], [10, 6], 0),
        "wbc": np.select([wbc_min < 1, wbc_max >= 20], [12, 3], 0),
        "potassium": np.where((k_min < 3) | (k_max >= 5), 3, 0),
        "sodium": np.select([na_min < 125, na_max >= 145], [5, 1], 0),
        "bicarbonate": np.select([hco3_min < 15, hco3_min < 20], [6, 3], 0),
        "bilirubin": np.select([bili_max >= 6, bili_max >= 4], [9, 4], 0),
        "gcs": np.select([gcs < 6, gcs < 9, gcs < 11, gcs < 14], [26, 13, 7, 5], 0),
        "chronic": np.maximum.reduce([base["hadm_id"].isin(aids) * 17, base["hadm_id"].isin(heme) * 10, base["hadm_id"].isin(mets) * 9]),
        "admission": np.where(~surgical, 6, np.where(elective, 0, 8)),
    }, index=index)
    frame = pd.DataFrame({"oasis": oasis_parts.sum(axis=1), "sapsii": sapsii_parts.sum(axis=1)}, index=index).reset_index()
    return frame.merge(stays[["stay_id", "subject_id", "hadm_id", "intime"]], on="stay_id")
