"""ICU: first-day SOFA with its six components, and organ-support episodes (ventilation, vasopressors, kidney replacement).

First-day scores describe ICU stays and are timed at ICU admission, so they fall inside the window of an ICU-indexed analysis
(and of a hospital-indexed one only when the ICU stay starts inside its exposure window). They are summaries of the first 24
hours after ICU admission and do not follow a different window choice.

SOFA (Vincent 1996) on the worst value of the first 24 hours after ICU admission; a component with no measurement scores 0:
  respiratory  PaO2/FiO2 (the latest FiO2 within 4 hours before the PaO2): <400 1, <300 2, <200 with invasive ventilation 3,
               <100 with invasive ventilation 4;
  coagulation  platelets (K/uL): <150 1, <100 2, <50 3, <20 4;
  liver        bilirubin (mg/dL): >=1.2 1, >=2.0 2, >=6.0 3, >=12.0 4;
  circulation  lowest mean arterial pressure <70 1; dopamine <=5 or dobutamine 2; dopamine >5, epinephrine <=0.1 or norepinephrine
               <=0.1 3; dopamine >15, epinephrine >0.1 or norepinephrine >0.1 4 (mcg/kg/min);
  nervous      lowest Glasgow coma score (eye + verbal + motor charted in the same hour): 13-14 1, 10-12 2, 6-9 3, <6 4;
  kidney       creatinine (mg/dL): >=1.2 1, >=2.0 2, >=3.5 3, >=5.0 4, or 24-hour urine output <500 mL 3, <200 mL 4.
Episodes: each invasive ventilation, vasopressor and kidney-replacement period, timed at its start, value = hours; and the
ventilator-free days to day 28 (0 for a patient who died within 28 days of ICU admission).
"""
import numpy as np
import pandas as pd
import sepsis
import severity
from common import DERIVED_BASE, events, read_table

ITEMS = {
    "sofa_first_day": (DERIVED_BASE + 20, "SOFA score, first 24 hours of the ICU stay", "points 0-24", "Sum of the six components on the worst value of the first 24 hours; a component without a measurement scores 0."),
    "sofa_respiratory": (DERIVED_BASE + 21, "SOFA respiratory component", "points 0-4", "PaO2/FiO2 with invasive ventilation."),
    "sofa_coagulation": (DERIVED_BASE + 22, "SOFA coagulation component", "points 0-4", "Lowest platelets."),
    "sofa_liver": (DERIVED_BASE + 23, "SOFA liver component", "points 0-4", "Highest bilirubin."),
    "sofa_cardiovascular": (DERIVED_BASE + 24, "SOFA cardiovascular component", "points 0-4", "Lowest MAP and vasopressor doses."),
    "sofa_nervous": (DERIVED_BASE + 25, "SOFA central nervous system component", "points 0-4", "Lowest Glasgow coma score."),
    "sofa_renal": (DERIVED_BASE + 26, "SOFA renal component", "points 0-4", "Highest creatinine or low urine output."),
    "temperature_celsius": (DERIVED_BASE + 50, "Body temperature in Celsius (Fahrenheit charting converted)", "degrees Celsius", "Every charted temperature; Fahrenheit values are converted. Values outside 10 to 50 degrees are dropped."),
    "sepsis3_icu_admission": (DERIVED_BASE + 60, "Sepsis-3 at ICU admission (first-day approximation)", "event", "A suspected infection (systemic antibiotic and culture, Seymour 2016) within a day of ICU admission and a first-day SOFA of 2 or more. See sepsis.py."),
    "oasis_first_day": (DERIVED_BASE + 40, "OASIS score, first 24 hours of the ICU stay", "points 0-100", "Oxford Acute Severity of Illness Score on the first 24 hours; a variable with no measurement adds no points. See severity.py."),
    "sapsii_first_day": (DERIVED_BASE + 41, "SAPS II score, first 24 hours of the ICU stay", "points 0-163", "Simplified Acute Physiology Score II on the worst values of the first 24 hours; a variable with no measurement adds no points. See severity.py."),
    "invasive_ventilation_hours": (DERIVED_BASE + 30, "Invasive ventilation episode", "hours", "Timed at the start of the episode; value is its length in hours."),
    "vasopressor_hours": (DERIVED_BASE + 31, "Vasopressor episode", "hours", "Norepinephrine, epinephrine, dopamine, phenylephrine or vasopressin; timed at the start; value is the length in hours."),
    "kidney_replacement_hours": (DERIVED_BASE + 32, "Kidney replacement therapy episode", "hours", "Dialysis or CRRT; timed at the start; value is the length in hours."),
    "ventilator_free_days_28": (DERIVED_BASE + 33, "Ventilator-free days to day 28", "days", "28 minus the days on invasive ventilation in the first 28 days; 0 if the patient died within 28 days. Timed at ICU admission."),
}
GCS_EYE = {"Spontaneously": 4, "To Speech": 3, "To Pain": 2, "None": 1}
GCS_VERBAL = {"Oriented": 5, "Confused": 4, "Inappropriate Words": 3, "Incomprehensible sounds": 2, "No Response": 1, "No Response-ETT": 1}
GCS_MOTOR = {"Obeys Commands": 6, "Localizes Pain": 5, "Flex-withdraws": 4, "Abnormal Flexion": 3, "Abnormal Extension": 2, "No response": 1, "No Response": 1}
CHART = {"eye": 220739, "verbal": 223900, "motor": 223901, "fio2": 223835, "map": {220052, 220181, 225312}, "hr": {220045}, "sbp": {220050, 220179, 225309}, "rr": {220210, 224690}, "temp_c": {223762}, "temp_f": {223761}}
# Each measurement has the original item and, from MIMIC-IV 3.0, a newer item of the same test; both are read.
LAB = {"pao2": {50821}, "fio2": {50816}, "platelets": {51265, 53189}, "bilirubin": {50885, 53089}, "creatinine": {50912, 52546},
       "bun": {51006, 52647}, "wbc": {51300, 51301}, "potassium": {50971, 52610}, "sodium": {50983, 52623}, "bicarbonate": {50882}}
PRESSOR_ITEMS = {"norepinephrine": 221906, "epinephrine": 221289, "dopamine": 221662, "dobutamine": 221653, "phenylephrine": 221749, "vasopressin": 222315}
URINE_ITEMS = {226559, 226560, 226561, 226563, 226567}
RRT_ITEMS = {225441, 225802, 225803, 225805, 225809, 225955}


def band(series, edges, descending=False):
    """Points 0..len(edges) for a worst value: how many edges it has crossed."""
    points = np.zeros(len(series), dtype=int)
    for edge in edges:
        points += (series <= edge).to_numpy() if descending else (series >= edge).to_numpy()
    return points


def build(archive, cache):
    stays = read_table(archive, "icustays", usecols=["subject_id", "hadm_id", "stay_id", "intime", "outtime"])
    stays["intime"] = pd.to_datetime(stays["intime"]); stays["outtime"] = pd.to_datetime(stays["outtime"])
    stays["end24"] = stays["intime"] + pd.Timedelta(hours=24)
    by_hadm = stays[["hadm_id", "stay_id", "intime", "end24"]]
    out, summary = [], {"stays": len(stays)}

    def first_day(frame, time_column="charttime"):
        merged = frame.merge(by_hadm, on="hadm_id", how="inner")
        return merged[(merged[time_column] >= merged["intime"]) & (merged[time_column] <= merged["end24"])]

    # laboratory values of the first day
    lab = read_table(archive, "labevents", usecols=["hadm_id", "itemid", "charttime", "valuenum"], filters={"itemid": set().union(*LAB.values())}).dropna(subset=["hadm_id", "valuenum"])
    lab["charttime"] = pd.to_datetime(lab["charttime"]); lab["hadm_id"] = lab["hadm_id"].astype("int64")
    lab = first_day(lab)
    worst = lambda item, how: getattr(lab[lab["itemid"].isin(LAB[item])].groupby("stay_id")["valuenum"], how)()
    platelets, bilirubin, creatinine = worst("platelets", "min"), worst("bilirubin", "max"), worst("creatinine", "max")

    # chart values of the first day
    chart_ids = {CHART["eye"], CHART["verbal"], CHART["motor"], CHART["fio2"], *CHART["map"], *CHART["hr"], *CHART["sbp"], *CHART["rr"], *CHART["temp_c"], *CHART["temp_f"]}
    chart = read_table(archive, "chartevents", usecols=["hadm_id", "stay_id", "itemid", "charttime", "value", "valuenum"], filters={"itemid": chart_ids})
    chart["charttime"] = pd.to_datetime(chart["charttime"]); chart["hadm_id"] = chart["hadm_id"].astype("int64"); chart["stay_id"] = chart["stay_id"].astype("int64")
    chart = chart.merge(stays[["stay_id", "intime", "end24"]], on="stay_id", how="inner")
    chart = chart[(chart["charttime"] >= chart["intime"]) & (chart["charttime"] <= chart["end24"])]
    lowest_map = chart[chart["itemid"].isin(CHART["map"])].groupby("stay_id")["valuenum"].min()
    hour = chart["charttime"].dt.floor("h")
    gcs = pd.DataFrame({"stay_id": chart["stay_id"], "hour": hour, "itemid": chart["itemid"], "value": chart["value"]})
    parts = []
    for name, itemid, table in (("eye", CHART["eye"], GCS_EYE), ("verbal", CHART["verbal"], GCS_VERBAL), ("motor", CHART["motor"], GCS_MOTOR)):
        part = gcs[gcs["itemid"] == itemid].copy(); part[name] = part["value"].map(table)
        parts.append(part.dropna(subset=[name]).groupby(["stay_id", "hour"])[name].min())
    total = pd.concat(parts, axis=1, join="inner").sum(axis=1)
    lowest_gcs = total.groupby("stay_id").min()

    # PaO2 / FiO2 with invasive ventilation
    vent = read_table(archive, "procedureevents", usecols=["stay_id", "starttime", "endtime", "itemid"], filters={"itemid": {225792}})
    vent["starttime"] = pd.to_datetime(vent["starttime"]); vent["endtime"] = pd.to_datetime(vent["endtime"])
    pao2 = lab[lab["itemid"].isin(LAB["pao2"])][["stay_id", "hadm_id", "charttime", "valuenum"]].rename(columns={"valuenum": "pao2"}).sort_values("charttime")
    fio2_lab = lab[lab["itemid"].isin(LAB["fio2"])][["hadm_id", "charttime", "valuenum"]].rename(columns={"valuenum": "fio2"})
    fio2_chart = chart[chart["itemid"] == CHART["fio2"]][["hadm_id", "charttime", "valuenum"]].rename(columns={"valuenum": "fio2"})
    fio2 = pd.concat([fio2_lab, fio2_chart]).dropna(); fio2["fio2"] = np.where(fio2["fio2"] > 1.0, fio2["fio2"] / 100.0, fio2["fio2"]); fio2 = fio2[(fio2["fio2"] >= 0.21) & (fio2["fio2"] <= 1.0)].sort_values("charttime")
    pair = pd.merge_asof(pao2, fio2, on="charttime", by="hadm_id", tolerance=pd.Timedelta(hours=4), direction="backward").dropna(subset=["fio2"])
    pair["ratio"] = pair["pao2"] / pair["fio2"]
    pair = pair.merge(vent[["stay_id", "starttime", "endtime"]], on="stay_id", how="left")
    pair["ventilated"] = (pair["charttime"] >= pair["starttime"]) & (pair["charttime"] <= pair["endtime"])
    pair = pair.groupby(["stay_id", "charttime", "ratio"], as_index=False)["ventilated"].max()
    pair["points"] = np.select([(pair["ratio"] < 100) & pair["ventilated"], (pair["ratio"] < 200) & pair["ventilated"], pair["ratio"] < 300, pair["ratio"] < 400], [4, 3, 2, 1], 0)
    resp = pair.groupby("stay_id")["points"].max()

    # vasopressor doses and urine output
    inputs = read_table(archive, "inputevents", usecols=["stay_id", "starttime", "endtime", "itemid", "rate", "rateuom"], filters={"itemid": set(PRESSOR_ITEMS.values())})
    inputs["starttime"] = pd.to_datetime(inputs["starttime"]); inputs["endtime"] = pd.to_datetime(inputs["endtime"])
    first = inputs.merge(stays[["stay_id", "intime", "end24"]], on="stay_id", how="inner")
    first = first[(first["starttime"] <= first["end24"]) & (first["endtime"] >= first["intime"])]
    peak = lambda item: first[(first["itemid"] == PRESSOR_ITEMS[item]) & first["rateuom"].eq("mcg/kg/min")].groupby("stay_id")["rate"].max()
    dopamine, dobutamine, epinephrine, norepinephrine = peak("dopamine"), peak("dobutamine"), peak("epinephrine"), peak("norepinephrine")
    urine = read_table(archive, "outputevents", usecols=["stay_id", "charttime", "itemid", "value"], filters={"itemid": URINE_ITEMS})
    urine["charttime"] = pd.to_datetime(urine["charttime"]); urine = urine.merge(stays[["stay_id", "intime", "end24"]], on="stay_id", how="inner")
    urine = urine[(urine["charttime"] >= urine["intime"]) & (urine["charttime"] <= urine["end24"])]
    urine_total = urine.groupby("stay_id")["value"].sum()

    index = stays.set_index("stay_id")
    frame = pd.DataFrame(index=index.index)
    frame["resp"] = resp.reindex(index.index).fillna(0).astype(int)
    frame["coag"] = pd.Series(band(platelets, [150, 100, 50, 20], True), index=platelets.index).reindex(index.index).fillna(0).astype(int)
    frame["liver"] = pd.Series(np.select([bilirubin >= 12, bilirubin >= 6, bilirubin >= 2, bilirubin >= 1.2], [4, 3, 2, 1], 0), index=bilirubin.index).reindex(index.index).fillna(0).astype(int)
    cv = pd.DataFrame(index=index.index)
    cv["map"] = (lowest_map.reindex(index.index) < 70).astype(int)
    drug = np.zeros(len(index), dtype=int)
    for series, rules in ((dobutamine, [(0, 2)]), (dopamine, [(0, 2), (5, 3), (15, 4)]), (epinephrine, [(0, 3), (0.1, 4)]), (norepinephrine, [(0, 3), (0.1, 4)])):
        values = series.reindex(index.index)
        for edge, points in rules: drug = np.maximum(drug, np.where(values.notna() & (values > edge), points, 0))
    frame["cv"] = np.maximum(cv["map"].to_numpy(), drug)
    frame["cns"] = pd.Series(np.select([lowest_gcs < 6, lowest_gcs < 10, lowest_gcs < 13, lowest_gcs < 15], [4, 3, 2, 1], 0), index=lowest_gcs.index).reindex(index.index).fillna(0).astype(int)
    creat_points = pd.Series(np.select([creatinine >= 5.0, creatinine >= 3.5, creatinine >= 2.0, creatinine >= 1.2], [4, 3, 2, 1], 0), index=creatinine.index).reindex(index.index).fillna(0)
    uo = urine_total.reindex(index.index)
    uo_points = np.where(uo.notna() & (uo < 200), 4, np.where(uo.notna() & (uo < 500), 3, 0))
    frame["renal"] = np.maximum(creat_points.to_numpy(), uo_points).astype(int)
    frame["sofa"] = frame[["resp", "coag", "liver", "cv", "cns", "renal"]].sum(axis=1)
    frame = frame.reset_index().merge(stays[["stay_id", "subject_id", "hadm_id", "intime"]], on="stay_id")
    for key, column in (("sofa_first_day", "sofa"), ("sofa_respiratory", "resp"), ("sofa_coagulation", "coag"), ("sofa_liver", "liver"), ("sofa_cardiovascular", "cv"), ("sofa_nervous", "cns"), ("sofa_renal", "renal")):
        out.append(events(frame, ITEMS[key][0], "intime", column, stay="stay_id"))
    # OASIS and SAPS II on the same first day
    in_day = vent.merge(stays[["stay_id", "intime", "end24"]], on="stay_id", how="inner")
    ventilated_first_day = set(in_day.loc[(in_day["starttime"] <= in_day["end24"]) & (in_day["endtime"] >= in_day["intime"]), "stay_id"])
    ventilated_ratio = pair[pair["ventilated"]].groupby("stay_id")["ratio"].min()
    first_day_lab = lab.drop_duplicates(["stay_id", "itemid", "charttime", "valuenum"])
    scores = severity.compute(archive, stays, chart, first_day_lab, lowest_gcs, urine_total, ventilated_ratio, ventilated_first_day, {**{key: CHART[key] for key in ("hr", "sbp", "map", "rr", "temp_c", "temp_f")}, "bun": LAB["bun"], "wbc": LAB["wbc"], "potassium": LAB["potassium"], "sodium": LAB["sodium"], "bicarbonate": LAB["bicarbonate"], "bilirubin": LAB["bilirubin"]})
    out.append(events(scores, ITEMS["oasis_first_day"][0], "intime", "oasis", stay="stay_id")); out.append(events(scores, ITEMS["sapsii_first_day"][0], "intime", "sapsii", stay="stay_id"))
    summary["oasis_mean"] = round(float(scores["oasis"].mean()), 2); summary["sapsii_mean"] = round(float(scores["sapsii"].mean()), 2)
    sepsis_events, sepsis_summary = sepsis.build(archive, stays, frame[["stay_id", "sofa"]], ITEMS["sepsis3_icu_admission"][0])
    out.append(sepsis_events); summary.update(sepsis_summary)
    summary["sofa_median"] = float(frame["sofa"].median()); summary["sofa_mean"] = round(float(frame["sofa"].mean()), 2)
    summary["sofa_distribution"] = frame["sofa"].clip(upper=12).value_counts(normalize=True).sort_index().round(3).to_dict()

    # episodes
    for key, table, ids, time_start, time_end in (("invasive_ventilation_hours", "procedureevents", {225792}, "starttime", "endtime"), ("kidney_replacement_hours", "procedureevents", RRT_ITEMS, "starttime", "endtime")):
        episodes = read_table(archive, table, usecols=["subject_id", "hadm_id", "stay_id", "itemid", time_start, time_end], filters={"itemid": ids})
        episodes[time_start] = pd.to_datetime(episodes[time_start]); episodes[time_end] = pd.to_datetime(episodes[time_end])
        episodes["hours"] = (episodes[time_end] - episodes[time_start]).dt.total_seconds() / 3600
        episodes = episodes[(episodes["hours"] > 0) & (episodes["hours"] < 24 * 365)]
        out.append(events(episodes, ITEMS[key][0], time_start, "hours", stay="stay_id"))
        summary[key] = len(episodes)
        if key == "invasive_ventilation_hours": vent_episodes = episodes
    # Infusion records change with every rate adjustment: records of any vasopressor are merged into one episode while the gap
    # between them is at most 6 hours.
    infusions = inputs.dropna(subset=["starttime", "endtime"]).sort_values(["stay_id", "starttime"]).reset_index(drop=True)
    previous_end = infusions.groupby("stay_id")["endtime"].transform(lambda column: column.cummax().shift())
    new_episode = previous_end.isna() | ((infusions["starttime"] - previous_end) > pd.Timedelta(hours=6))
    infusions["episode"] = new_episode.groupby(infusions["stay_id"]).cumsum()
    episodes_p = infusions.groupby(["stay_id", "episode"], as_index=False).agg(starttime=("starttime", "min"), endtime=("endtime", "max"))
    episodes_p["hours"] = (episodes_p["endtime"] - episodes_p["starttime"]).dt.total_seconds() / 3600
    episodes_p = episodes_p.merge(stays[["stay_id", "subject_id", "hadm_id"]], on="stay_id", how="inner")
    episodes_p = episodes_p[(episodes_p["hours"] > 0) & (episodes_p["hours"] < 24 * 365)]
    out.append(events(episodes_p, ITEMS["vasopressor_hours"][0], "starttime", "hours", stay="stay_id"))
    summary["vasopressor_episodes"] = len(episodes_p)

    # body temperature: four fifths of the records are charted in Fahrenheit
    temps = read_table(archive, "chartevents", usecols=["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"], filters={"itemid": {223761, 223762}}).dropna(subset=["valuenum"])
    temps["charttime"] = pd.to_datetime(temps["charttime"])
    temps["celsius"] = np.where(temps["itemid"] == 223761, (temps["valuenum"] - 32) * 5 / 9, temps["valuenum"])
    temps = temps[(temps["celsius"] > 10) & (temps["celsius"] < 50)]
    out.append(events(temps, ITEMS["temperature_celsius"][0], "charttime", "celsius", stay="stay_id"))
    summary["temperature_records"] = len(temps); summary["temperature_fahrenheit_share"] = round(float((temps["itemid"] == 223761).mean()), 3)

    # ventilator-free days to day 28
    patients = read_table(archive, "patients", usecols=["subject_id", "dod"]); patients["dod"] = pd.to_datetime(patients["dod"])
    vent_days = vent_episodes.merge(stays[["stay_id", "intime"]], on="stay_id", how="inner")
    vent_days["start"] = vent_days[["starttime", "intime"]].max(axis=1); vent_days["stop"] = vent_days["endtime"].clip(upper=vent_days["intime"] + pd.Timedelta(days=28))
    vent_days["days"] = ((vent_days["stop"] - vent_days["start"]).dt.total_seconds() / 86400).clip(lower=0)
    used = vent_days.groupby("stay_id")["days"].sum()
    vfd = stays.merge(patients, on="subject_id", how="left")
    vfd["vfd"] = (28 - vfd["stay_id"].map(used).fillna(0)).clip(lower=0)
    vfd.loc[vfd["dod"].notna() & (vfd["dod"] <= vfd["intime"].dt.normalize() + pd.Timedelta(days=28)), "vfd"] = 0
    out.append(events(vfd, ITEMS["ventilator_free_days_28"][0], "intime", "vfd", stay="stay_id"))
    summary["vfd_mean"] = round(float(vfd["vfd"].mean()), 2)
    return pd.concat(out, ignore_index=True), summary, ITEMS
