"""Build the core MIMIC-IV concept library into config/mappings/mimic-iv-core.json.

Definitions follow the MIT-LCP mimic-code concepts (vital-sign ranges, vasoactive agents, ventilation events,
CRRT items) and commonly used explicit ICD code sets. ICD items are written as prefixes or ranges and expanded to the
exact codes of the local d_icd_diagnoses dictionary; every item id is checked against d_items / d_labitems and must
carry the expected label, so a transcription error fails the build instead of producing an empty variable.

Usage:
  python3 scripts/build-core-concepts.py --dictionaries DIR [--write]
    DIR holds d_icd_diagnoses.csv, d_items.csv and d_labitems.csv extracted from the MIMIC-IV archive
    (dictionaries only, no patient data). Without --write the entries are printed; with it the pack is updated.
Status: written by the coding agent on 2026-09-27 from mimic-code and published definitions; pending clinical review.
"""
import argparse, re
import csv
import json
import os
import sys

PACK = os.path.join(os.path.dirname(__file__), "..", "config", "mappings", "mimic-iv-core.json")
PACK_VERSION = "1.11.3"
# Bump whenever a regenerated run's output actually differs from the last run that used this same version: the
# mapping store refuses to silently overwrite a stored row when its mapping_version matches but its content
# differs (by design, to catch accidental drift) — so a content change with no version bump gets stuck forever
# in any store that was already seeded from the pre-change pack. This bump (aggregation added to several EVENTS
# concepts, plus this run's new entries) is exactly that kind of change.
ENTRY_VERSION = "1.2.3"
# Items of the archive that hand-maintained pack entries lacked (counted in MIMIC-IV 3.1: 225309 and 225310 each have hundreds of thousands of records).
ITEM_PATCHES = {"systolic_blood_pressure": [225309], "diastolic_blood_pressure": [225310]}
REVIEW = "Core concept library 2026-09-27 (scripts/build-core-concepts.py); pending clinical review."

# (concept_id, en, zh, synonyms, ICD-9 items, ICD-10 items, note). Items: "038", "995.91", "250.1", "I48.1", "J12-J18".
DIAGNOSES = [
    ("sepsis", "Sepsis", "脓毒症", ["septicemia", "sepsis syndrome", "severe sepsis", "败血症", "脓毒血症", "感染性脓毒症"],
     ["038", "995.91", "995.92", "785.52"], ["A40", "A41", "A02.1", "A22.7", "A26.7", "A32.7", "A42.7", "B37.7", "R65.20", "R65.21", "T81.44", "A54.86"],
     "Explicit sepsis codes (septicemia, sepsis, severe sepsis, septic shock). Not the Sepsis-3 definition, which needs SOFA and suspected infection."),
    ("septic_shock", "Septic shock", "脓毒性休克", ["感染性休克", "sepsis with shock"], ["785.52", "998.02"], ["R65.21", "T81.12"], "Explicit septic shock codes (including postoperative septic shock)."),
    ("cirrhosis", "Liver cirrhosis", "肝硬化", ["cirrhosis", "hepatic cirrhosis", "alcoholic cirrhosis", "酒精性肝硬化"],
     ["571.2", "571.5", "571.6"], ["K70.3", "K74.3", "K74.4", "K74.5", "K74.6", "K71.7"], "Alcoholic, biliary, toxic and unspecified cirrhosis."),
    ("diabetic_ketoacidosis", "Diabetic ketoacidosis", "糖尿病酮症酸中毒", ["DKA", "ketoacidosis", "酮症酸中毒"],
     ["250.1", "249.1"], ["E08.1", "E09.1", "E10.1", "E11.1", "E13.1"], "Diabetes with ketoacidosis, any type (including secondary diabetes)."),
    ("diabetes_mellitus", "Diabetes mellitus", "糖尿病", ["diabetes", "DM", "type 2 diabetes", "type 1 diabetes", "糖尿病史", "2型糖尿病", "1型糖尿病"],
     ["249", "250"], ["E08", "E09", "E10", "E11", "E13"], "Any diabetes mellitus code on the admission (secondary diabetes included; gestational diabetes not)."),
    ("atrial_fibrillation", "Atrial fibrillation", "心房颤动", ["AF", "AFib", "房颤", "心房纤颤", "new-onset atrial fibrillation", "新发房颤"],
     ["427.31"], ["I48.0", "I48.1", "I48.2", "I48.91", "I48.9$"], "Atrial fibrillation (flutter excluded; I48.9, the unspecified atrial fibrillation-or-flutter code used until 2019, is included because it was the usual code for unspecified atrial fibrillation). Diagnosis codes cannot date onset within the stay."),
    ("myocardial_infarction", "Myocardial infarction", "心肌梗死", ["MI", "heart attack", "acute myocardial infarction", "心梗", "急性心肌梗死"],
     ["410"], ["I21", "I22"], "Acute myocardial infarction."),
    ("stroke", "Stroke", "卒中", ["cerebrovascular accident", "CVA", "ischemic stroke", "hemorrhagic stroke", "中风", "脑卒中", "脑梗死", "脑出血"],
     ["430", "431", "433.01", "433.11", "433.21", "433.31", "433.81", "433.91", "434.01", "434.11", "434.91", "436"], ["I60", "I61", "I63"],
     "Ischemic or hemorrhagic stroke (subarachnoid, intracerebral, cerebral infarction)."),
    ("heart_failure", "Heart failure", "心力衰竭", ["congestive heart failure", "CHF", "心衰", "充血性心力衰竭"],
     ["428", "402.01", "402.11", "402.91", "404.01", "404.03", "404.11", "404.13", "404.91", "404.93", "398.91"], ["I50", "I11.0", "I13.0", "I13.2", "I09.81", "I97.13"], "Heart failure including hypertensive, rheumatic and postprocedural heart failure."),
    ("acute_kidney_injury", "Acute kidney injury (diagnosis code)", "急性肾损伤（诊断编码）", ["AKI diagnosis code", "coded acute kidney injury", "急性肾损伤诊断编码"], ["584"], ["N17"], "Coded acute kidney injury (not KDIGO staging). It carries no date; the dated KDIGO definition is acute_kidney_injury_kdigo."),
    ("chronic_kidney_disease", "Chronic kidney disease", "慢性肾病", ["CKD", "chronic renal failure", "慢性肾脏病", "慢性肾衰竭"], ["585", "403", "404"], ["N18", "I12", "I13"], "Coded chronic kidney disease, any stage, including hypertensive chronic kidney disease."),
    ("end_stage_kidney_disease", "End-stage kidney disease", "终末期肾病", ["ESRD", "ESKD", "end stage renal disease", "uremia", "尿毒症", "终末期肾病", "尿毒症期"], ["585.6"], ["N18.6"], "Coded end-stage kidney disease (chronic kidney disease stage 5 requiring dialysis). Dialysis during the admission is a procedure, not this diagnosis."),
    ("copd", "Chronic obstructive pulmonary disease", "慢性阻塞性肺疾病", ["COPD", "慢阻肺", "emphysema", "chronic bronchitis"], ["491", "492", "496", "493.2"], ["J41", "J42", "J43", "J44"], "COPD, emphysema, chronic bronchitis and chronic obstructive asthma."),
    ("pneumonia", "Pneumonia", "肺炎", ["community-acquired pneumonia", "hospital-acquired pneumonia", "社区获得性肺炎", "医院获得性肺炎"], ["480-486", "487.0", "488.01", "488.11", "488.81", "507.0", "997.31"], ["J12-J18", "J10.0", "J11.0", "J69.0", "J95.851"], "Pneumonia of any organism, including influenza with pneumonia, aspiration pneumonia and ventilator-associated pneumonia."),
    ("ards", "Acute respiratory distress syndrome", "急性呼吸窘迫综合征", ["ARDS"], ["518.52", "518.82"], ["J80"], "Coded ARDS (ICD-9 518.52, ARDS after trauma or surgery, and 518.82, other pulmonary insufficiency, which names adult respiratory distress syndrome; other 518.5x are respiratory failure, not ARDS)."),
    ("acute_pancreatitis", "Acute pancreatitis", "急性胰腺炎", ["pancreatitis", "胰腺炎"], ["577.0"], ["K85"], "Acute pancreatitis."),
    ("lung_cancer", "Lung cancer", "肺癌", ["lung carcinoma", "bronchogenic carcinoma", "非小细胞肺癌", "小细胞肺癌"], ["162"], ["C34"], "Malignant neoplasm of bronchus and lung."),
    ("smoking", "Smoking", "吸烟", ["tobacco use", "tobacco use disorder", "smoker", "history of smoking", "吸烟史", "烟草使用"], ["305.1", "V15.82"], ["F17", "Z72.0", "Z87.891"],
     "Coded current or past tobacco use; under-recorded, so absence is not confirmed non-smoking."),
    ("hypertension", "Hypertension", "高血压", ["HTN", "high blood pressure", "essential hypertension", "高血压病", "高血压患者"],
     ["401", "402", "403", "404", "405"], ["I10", "I11", "I12", "I13", "I15", "I16"], "Any hypertension code on the admission, including hypertensive heart and kidney disease."),
    ("coronary_heart_disease", "Coronary heart disease", "冠心病", ["CHD", "coronary artery disease", "CAD", "ischemic heart disease", "冠状动脉疾病", "缺血性心脏病"],
     ["410-414"], ["I20-I25"], "Ischemic heart disease: acute and old myocardial infarction, angina and chronic coronary disease."),
    ("transient_ischemic_attack", "Transient ischemic attack", "短暂性脑缺血发作", ["TIA", "transient cerebral ischemia", "小中风"], ["435"], ["G45"], "Transient cerebral ischemic attacks and related syndromes."),
    ("intracerebral_hemorrhage", "Intracerebral hemorrhage", "脑出血", ["ICH", "cerebral hemorrhage", "脑内出血", "颅内出血"], ["431"], ["I61"], "Nontraumatic intracerebral hemorrhage."),
    ("dementia", "Dementia", "痴呆", ["Alzheimer disease", "vascular dementia", "senile dementia", "阿尔茨海默病", "老年痴呆", "血管性痴呆"],
     ["290", "294.1", "294.2", "331.0", "331.1", "331.82"], ["F01-F03", "G30", "G31.0", "G31.83"], "Dementia of any type, including Alzheimer, frontotemporal and Lewy body dementia. Diagnosis codes cannot date onset within the stay."),
    ("arrhythmia", "Cardiac arrhythmia", "心律失常", ["dysrhythmia", "arrhythmias", "心律不齐", "心律紊乱"], ["426", "427"], ["I44-I49"], "Conduction disorders and cardiac dysrhythmias, including atrial fibrillation and flutter, ventricular tachycardia and cardiac arrest."),
    ("benign_prostatic_hyperplasia", "Benign prostatic hyperplasia", "良性前列腺增生", ["BPH", "prostatic hyperplasia", "enlarged prostate", "前列腺增生", "前列腺肥大"], ["600"], ["N40"], "Hyperplasia of the prostate."),
]

# Variability of a repeated measurement: (concept_id, en, zh, synonyms, table, item ids, valid range, unit)
VARIABILITY = [
    ("sbp_variability", "Systolic blood pressure variability", "收缩压变异性", ["blood pressure variability", "BP variability", "SBP variability", "systolic BP variability", "systolic blood pressure variability", "血压变异性", "血压变异度", "血压波动", "收缩压波动", "收缩压变异度"], "chartevents", [220050, 220179, 224167, 227243, 225309], (0, 400), "mmHg"),
    ("map_variability", "Mean arterial pressure variability", "平均动脉压变异性", ["MAP variability", "mean blood pressure variability", "平均动脉压波动", "平均动脉压变异度"], "chartevents", [220052, 220181, 225312], (0, 300), "mmHg"),
    ("heart_rate_variability", "Heart rate variability", "心率变异性", ["HRV", "pulse variability", "心率波动", "心率变异度"], "chartevents", [220045], (0, 300), "bpm"),
    ("respiratory_rate_variability", "Respiratory rate variability", "呼吸频率变异性", ["breathing rate variability", "呼吸频率波动"], "chartevents", [220210], (0, 70), "breaths/min"),
    ("glucose_variability", "Blood glucose variability", "血糖变异性", ["glycemic variability", "glucose variability", "glucose fluctuation", "血糖波动", "血糖变异度"], "labevents", [50931], (0, 10000), "mg/dL"),
]

# (concept_id, en, zh, synonyms, category, table, item ids with expected labels, value column, aggregation, valid range, unit note)
MEASUREMENTS = [
    ("heart_rate", "Heart rate", "心率", ["pulse", "脉搏"], "vital_sign", "chartevents", {220045: "Heart Rate"}, "valuenum", "mean", (0, 300), "bpm"),
    ("mean_arterial_pressure", "Mean arterial pressure", "平均动脉压", ["MAP", "mean blood pressure"], "vital_sign", "chartevents",
     {220052: "Arterial Blood Pressure mean", 220181: "Non Invasive Blood Pressure mean", 225312: "ART BP Mean"}, "valuenum", "mean", (0, 300), "mmHg"),
    ("respiratory_rate", "Respiratory rate", "呼吸频率", ["breathing rate", "呼吸"], "vital_sign", "chartevents", {220210: "Respiratory Rate", 224690: "Respiratory Rate (Total)"}, "valuenum", "mean", (0, 70), "breaths/min (monitor and ventilator-total rate)"),
    ("spo2", "Oxygen saturation", "血氧饱和度", ["SpO2", "pulse oximetry", "O2 saturation", "氧饱和度"], "vital_sign", "chartevents", {220277: "O2 saturation pulseoxymetry"}, "valuenum", "mean", (0, 100.1), "%"),
    ("lactate", "Lactate", "乳酸", ["lactic acid", "blood lactate", "serum lactate", "血乳酸"], "laboratory", "labevents", {50813: "Lactate"}, "valuenum", "maximum", (0, 50), "mmol/L"),
    ("creatinine", "Creatinine", "肌酐", ["serum creatinine", "Scr", "血肌酐"], "laboratory", "labevents", {50912: "Creatinine"}, "valuenum", "maximum", (0, 150), "mg/dL"),
    ("rdw", "Red cell distribution width", "红细胞分布宽度", ["RDW", "red blood cell distribution width"], "laboratory", "labevents", {51277: "RDW"}, "valuenum", "first", (0, 100), "%"),
    ("albumin", "Albumin", "白蛋白", ["serum albumin", "血清白蛋白"], "laboratory", "labevents", {50862: "Albumin"}, "valuenum", "first", (0, 10), "g/dL"),
    ("platelets", "Platelet count", "血小板", ["platelets", "PLT", "血小板计数"], "laboratory", "labevents", {51265: "Platelet Count"}, "valuenum", "minimum", (0, 10000), "K/uL"),
    ("hemoglobin", "Hemoglobin", "血红蛋白", ["Hb", "haemoglobin", "Hgb"], "laboratory", "labevents", {51222: "Hemoglobin"}, "valuenum", "minimum", (0, 50), "g/dL"),
    ("glucose", "Blood glucose", "血糖", ["glucose", "serum glucose"], "laboratory", "labevents", {50931: "Glucose"}, "valuenum", "mean", (0, 10000), "mg/dL"),
    ("wbc", "White blood cell count", "白细胞计数", ["WBC", "leukocyte count", "白细胞"], "laboratory", "labevents", {51301: "White Blood Cells"}, "valuenum", "maximum", (0, 1000), "K/uL"),
    ("bilirubin", "Total bilirubin", "总胆红素", ["bilirubin", "胆红素"], "laboratory", "labevents", {50885: "Bilirubin, Total"}, "valuenum", "maximum", (0, 150), "mg/dL"),
    ("sodium", "Sodium", "血钠", ["serum sodium", "钠"], "laboratory", "labevents", {50983: "Sodium"}, "valuenum", "first", (0, 200), "mEq/L"),
    ("potassium", "Potassium", "血钾", ["serum potassium", "钾"], "laboratory", "labevents", {50971: "Potassium"}, "valuenum", "first", (0, 30), "mEq/L"),
    ("bun", "Blood urea nitrogen", "尿素氮", ["BUN", "urea nitrogen", "血尿素氮"], "laboratory", "labevents", {51006: "Urea Nitrogen"}, "valuenum", "maximum", (0, 300), "mg/dL"),
    ("propofol_rate", "Propofol infusion rate", "丙泊酚输注速度", ["propofol dose", "propofol infusion", "丙泊酚剂量", "丙泊酚平均输注速度"], "medication", "inputevents", {222168: "Propofol"}, "rate", "mean", (0, 1000), "rate as charted (usually mcg/kg/min)"),
    ("pain_score", "Pain score", "疼痛评分", ["pain level", "pain intensity", "pain rating", "NRS pain", "疼痛程度", "疼痛强度", "疼痛分数"], "vital_sign", "chartevents", {223791: "Pain Level"}, "valuenum", "mean", (-1, 11),
     "0-10 as MIMIC codes the charted pain level: None 0, None to Mild 1, Mild 2, Mild to Moderate 3-4, Moderate 5, Moderate to Severe 6-7, Severe 8, Severe to Worse 9, Worst 10; 'Unable to Score' has no value; ICU stays only"),
    ("triglycerides", "Triglycerides", "甘油三酯", ["TG", "serum triglycerides", "血清甘油三酯"], "laboratory", "labevents", {51000: "Triglycerides"}, "valuenum", "first", (0, 10000), "mg/dL"),
    ("total_cholesterol", "Total cholesterol", "总胆固醇", ["cholesterol", "serum cholesterol", "TC", "血清总胆固醇", "胆固醇"], "laboratory", "labevents", {50907: "Cholesterol, Total"}, "valuenum", "first", (0, 1000), "mg/dL"),
    ("ldl_cholesterol", "LDL cholesterol", "低密度脂蛋白胆固醇", ["LDL", "LDL-C", "low-density lipoprotein cholesterol", "低密度脂蛋白", "坏胆固醇"], "laboratory", "labevents",
     {50905: "Cholesterol, LDL, Calculated", 50906: "Cholesterol, LDL, Measured"}, "valuenum", "first", (0, 600), "mg/dL (calculated and measured LDL)"),
    ("hdl_cholesterol", "HDL cholesterol", "高密度脂蛋白胆固醇", ["HDL", "HDL-C", "high-density lipoprotein cholesterol", "高密度脂蛋白", "好胆固醇"], "laboratory", "labevents", {50904: "Cholesterol, HDL"}, "valuenum", "first", (0, 300), "mg/dL"),
    ("urine_output", "Urine output", "尿量", ["urine volume", "urinary output", "diuresis", "24-hour urine output", "每日尿量", "尿液量"], "vital_sign", "outputevents",
     {226559: "Foley", 226560: "Void", 226561: "Condom Cath", 226563: "Suprapubic", 226567: "Straight Cath"}, "value", "sum", (0, 10000),
     "mL summed over the window from urinary catheter, voided, condom catheter, suprapubic and straight-catheter records; nephrostomy, stent and irrigant outputs are excluded; ICU stays only"),
    ("urine_albumin_creatinine_ratio", "Urine albumin/creatinine ratio", "尿白蛋白/肌酐比", ["UACR", "ACR", "albumin creatinine ratio", "尿白蛋白肌酐比", "尿微量白蛋白"], "laboratory", "labevents", {51070: "Albumin/Creatinine, Urine"}, "valuenum", "first", (0, 100000), "mg/g"),
]

# IV opioid amounts converted to IV morphine equivalents (mg): 10 mg IV morphine = 1.5 mg IV hydromorphone = 100 mcg IV fentanyl
# (widely used equianalgesic table; approximate, pending clinical review). The unit is read per row because it is charted per row
# (fentanyl is mostly mcg but sometimes mg). Oral, transdermal and other opioids (methadone, meperidine, remifentanil) are not counted.
IV_OPIOID_ITEMS = {225154: "Morphine Sulfate", 221833: "Hydromorphone (Dilaudid)", 221744: "Fentanyl", 225942: "Fentanyl (Concentrate)", 225972: "Fentanyl (Push)"}
IV_OPIOID_CONVERSIONS = [
    {"item_id": 225154, "unit": "mg", "factor": 1.0}, {"item_id": 221833, "unit": "mg", "factor": 6.67},
    {"item_id": 221744, "unit": "mcg", "factor": 0.1}, {"item_id": 221744, "unit": "mg", "factor": 100.0},
    {"item_id": 225942, "unit": "mcg", "factor": 0.1}, {"item_id": 225942, "unit": "mg", "factor": 100.0},
    {"item_id": 225972, "unit": "mcg", "factor": 0.1},
]

# (concept_id, en, zh, synonyms, category, table, item ids with expected labels, note) — recorded presence.
EVENTS = [
    ("norepinephrine", "Norepinephrine", "去甲肾上腺素", ["noradrenaline", "levophed", "去甲肾"], "medication", "inputevents", {221906: "Norepinephrine"}, "ICU infusion of norepinephrine."),
    ("vasopressors", "Vasopressors", "血管活性药物", ["vasopressor", "vasoactive agents", "pressors", "升压药", "血管加压药"], "medication", "inputevents",
     {221906: "Norepinephrine", 221289: "Epinephrine", 221662: "Dopamine", 222315: "Vasopressin", 221749: "Phenylephrine"}, "ICU infusion of any vasopressor (mimic-code vasoactive agents without inotropes)."),
    ("propofol", "Propofol", "丙泊酚", ["propofol use", "diprivan", "丙泊酚镇静"], "medication", "inputevents", {222168: "Propofol"}, "ICU infusion of propofol."),
    ("invasive_ventilation", "Invasive mechanical ventilation", "有创机械通气", ["mechanical ventilation", "invasive ventilation", "intubation", "ventilated", "机械通气", "插管", "呼吸机"], "intervention", "procedureevents",
     {225792: "Invasive Ventilation"}, "ICU procedure event 'Invasive Ventilation'."),
    ("noninvasive_ventilation", "Non-invasive ventilation", "无创通气", ["NIV", "BiPAP", "CPAP", "无创呼吸机"], "intervention", "procedureevents", {225794: "Non-invasive Ventilation"}, "ICU procedure event 'Non-invasive Ventilation'."),
    ("crrt", "Continuous renal replacement therapy", "连续性肾脏替代治疗", ["CRRT", "CVVHD", "CVVHDF", "CVVH", "连续性血液净化"], "intervention", "procedureevents",
     {225802: "Dialysis - CRRT", 225803: "Dialysis - CVVHD", 225809: "Dialysis - CVVHDF", 225955: "Dialysis - SCUF"}, "ICU CRRT procedure events (mimic-code rrt items)."),
    ("renal_replacement_therapy", "Renal replacement therapy", "肾脏替代治疗", ["RRT", "dialysis", "hemodialysis", "haemodialysis", "透析", "血液透析", "腹膜透析"], "intervention", "procedureevents",
     {225802: "Dialysis - CRRT", 225803: "Dialysis - CVVHD", 225809: "Dialysis - CVVHDF", 225955: "Dialysis - SCUF", 225441: "Hemodialysis", 225805: "Peritoneal Dialysis"},
     "ICU renal replacement: CRRT, intermittent hemodialysis or peritoneal dialysis procedure events."),
]

SYSTEMIC_HYDROCORTISONE = ["Hydrocortisone Na Succ.", "Hydrocortisone Na Succ", "Hydrocortisone Na Succinate", "Hydrocortisone", "Hydrocortisone ", "INV-Hydrocortisone",
                           "hydrocorTISone Sod Succinate", "hydrocorTISone Sod Succ (PF)", "Hydrocortisone SR", "Cortisone (hydrocortisone)"]
SYSTEMIC_ROUTES = ["IV", "PO", "PO/NG", "IM"]


def expand(item):
    """'250.1' -> '2501'; 'J12-J18' -> ['J12', ..., 'J18'] (same letter, numeric parts)."""
    if "-" not in item:
        return [item.replace(".", "")]
    start, end = item.split("-")
    prefix = start.rstrip("0123456789.")
    a, b = start[len(prefix):].replace(".", ""), end[len(prefix):].replace(".", "")
    return [f"{prefix}{str(n).zfill(len(a))}" for n in range(int(a), int(b) + 1)]


def load(directory, name):
    with open(os.path.join(directory, name), newline="") as handle:
        return list(csv.DictReader(handle))


def codes_for(dictionary, version, items):
    codes = []
    for item in items:
        exact = item.endswith("$")  # "I48.9$" is that code alone, not its subcodes
        for prefix in expand(item[:-1] if exact else item):
            matched = sorted(code for code in dictionary[version] if (code == prefix if exact else code.startswith(prefix)))
            if not matched:
                sys.exit(f"ICD-{version} prefix {prefix} (from {item}) matches no code in d_icd_diagnoses")
            codes.extend(matched)
    return sorted(set(codes))


def check_items(labels, items, table):
    for item_id, expected in items.items():
        row = labels.get(str(item_id))
        if not row or row["label"].strip() != expected:
            sys.exit(f"item {item_id} is not '{expected}' in the {table} dictionary (found {row and row['label']})")


DERIVED_SOURCE = {"kind": "dictionary_item", "schema": "mimiciv_derived", "table": "derived_events", "columns": ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"], "dictionary_table": "derived_items"}
DERIVED_BASE = 9_000_000
HORIZONS = (30, 90, 365)
DERIVED_NOTE = " Derived layer: computed once from the raw archive by scripts/derived (definition in derived_items.csv); pending clinical review."


def derived_source(item_ids):
    return {**DERIVED_SOURCE, "item_ids": sorted(item_ids)}


def derived_entries(entries):
    """Concepts of the derived-variable layer. Item ids must match scripts/derived (kidney.py, stay.py)."""
    out = []
    out.append(entry("acute_kidney_injury_kdigo", "Acute kidney injury (KDIGO)", "急性肾损伤（KDIGO，按肌酐）",
                     ["AKI", "acute kidney injury", "acute renal failure", "KDIGO acute kidney injury", "kidney injury", "急性肾损伤", "急性肾衰竭", "肾损伤", "急性肾功能损伤", "肾脏不良结局"], "outcome", "binary",
                     "Acute kidney injury by the KDIGO creatinine criteria, dated at the measurement that meets them." + DERIVED_NOTE,
                     "Any creatinine meeting a stage within the study window relative to time zero.",
                     "A rise of at least 0.3 mg/dL within 48 hours or at least 1.5 times the lowest creatinine of the previous 7 days of the admission (stage 1); 2.0 times (stage 2); 3.0 times or 4.0 mg/dL or more with a rise (stage 3). Urine output is not used.",
                     "No qualifying creatinine means no AKI was detected; a patient with one creatinine, or a raised first creatinine, cannot be detected.",
                     derived_source({DERIVED_BASE + 1})))
    out.append(entry("egfr", "Estimated glomerular filtration rate (CKD-EPI 2021)", "估算肾小球滤过率（eGFR，CKD-EPI 2021）",
                     ["eGFR", "estimated GFR", "glomerular filtration rate", "GFR", "肾小球滤过率", "估算肾小球滤过率", "肾功能"], "laboratory", "continuous",
                     "eGFR from creatinine, age and sex by the race-free CKD-EPI 2021 equation (mL/min/1.73 m2)." + DERIVED_NOTE,
                     "Computed at every creatinine measurement in the study window relative to time zero.",
                     "142 x min(Scr/k, 1)^a x max(Scr/k, 1)^-1.200 x 0.9938^age (x 1.012 if female); k 0.7 or 0.9, a -0.241 or -0.302.",
                     "No creatinine in the window means no eGFR.", derived_source({DERIVED_BASE + 2}), "mean", (0, 200)))
    out.append(entry("temperature", "Body temperature", "体温", ["temperature", "fever", "body temperature", "发热", "体温"], "vital_sign", "continuous",
                     "Body temperature in Celsius; Fahrenheit charting (four fifths of the ICU records) is converted." + DERIVED_NOTE,
                     "Every charted temperature in the study window relative to time zero; ICU patients only.", "Celsius items as charted and Fahrenheit items converted to Celsius; values outside 10 to 50 degrees are ignored as artifacts.",
                     "Patients without a charted temperature in the window have no measurement; they are not assumed normal.", derived_source({DERIVED_BASE + 50}), "maximum", (10, 50)))
    out.append(entry("discharged_alive", "Discharged alive", "存活出院", ["alive at discharge", "survived to discharge", "survived the admission", "survivors", "hospital survivors", "survivors to discharge", "discharge survivors", "出院存活者"], "encounter", "binary",
                     "The admission did not end in death." + DERIVED_NOTE, "At the discharge of the admission.", "Admission with hospital_expire_flag 0.", "No record means the patient died in hospital.", derived_source({DERIVED_BASE + 10})))
    out.append(entry("hospital_length_of_stay", "Hospital length of stay", "住院时间", ["hospital length of stay", "hospital stay length", "hospital LOS", "total length of stay", "prolonged hospital stay", "prolonged length of stay", "总住院时间", "住院总天数", "住院总时长"], "outcome", "continuous",
                     "Days from admission to discharge." + DERIVED_NOTE, "At the discharge of the admission.", "Discharge time minus admission time, in days.", "Always present for a discharged admission.",
                     derived_source({DERIVED_BASE + 11}), "last", (0, 1000)))
    sofa_note = " First-day scores summarise the 24 hours after ICU admission and are timed at ICU admission."
    out.append(entry("sofa_score", "SOFA score (first 24 hours of the ICU stay)", "SOFA评分（ICU入住首24小时）", ["SOFA", "sequential organ failure assessment", "SOFA score", "organ failure score", "SOFA评分", "SOFA分数", "序贯器官衰竭评分", "器官功能衰竭评分"], "score", "continuous",
                     "Sequential Organ Failure Assessment on the worst values of the first 24 hours after ICU admission, 0 to 24." + DERIVED_NOTE + sofa_note,
                     "Timed at ICU admission.", "Sum of the respiratory, coagulation, liver, cardiovascular, nervous system and kidney components (Vincent 1996); a component with no measurement scores 0.",
                     "No ICU stay means no score.", derived_source({DERIVED_BASE + 20}), "first", (-1, 25)))
    out.append(entry("sepsis3_icu_admission", "Sepsis (Sepsis-3)", "脓毒症（Sepsis-3）", ["Sepsis-3", "Sepsis 3", "sepsis3", "Sepsis-3 sepsis", "Sepsis-3 definition", "sepsis according to Sepsis-3", "脓毒症3.0", "Sepsis-3脓毒症", "Sepsis-3定义的脓毒症", "脓毒症（Sepsis-3）"], "diagnosis", "binary",
                     "Sepsis by the Sepsis-3 definition applied at ICU admission: a suspected infection within a day of ICU admission and a first-day SOFA of 2 or more." + DERIVED_NOTE + sofa_note,
                     "Timed at ICU admission.", "A systemic antibiotic and a culture of the same admission (antibiotic first with a culture within 24 hours, or culture first with an antibiotic within 72 hours), the suspicion between 24 hours before and 24 hours after the ICU stay starts, and a first-day SOFA of 2 or more; the baseline SOFA is taken as 0.",
                     "No record means no sepsis at ICU admission by this definition; sepsis that begins later in the stay is not counted.", derived_source({DERIVED_BASE + 60})))
    out.append(entry("oasis_score", "OASIS score (first 24 hours of the ICU stay)", "OASIS评分（ICU入住首24小时）", ["OASIS", "Oxford Acute Severity of Illness Score", "OASIS score", "OASIS评分", "OASIS分数", "牛津急性疾病严重程度评分"], "score", "continuous",
                     "Oxford Acute Severity of Illness Score (Johnson 2013) on the first 24 hours after ICU admission: ten variables and no laboratory value, 0 to 100." + DERIVED_NOTE + sofa_note,
                     "Timed at ICU admission.", "Pre-ICU length of stay, age, lowest Glasgow coma score, highest heart rate, lowest mean arterial pressure, respiratory rate, temperature, urine output, invasive ventilation and elective surgery; a variable with no measurement adds no points.",
                     "No ICU stay means no score.", derived_source({DERIVED_BASE + 40}), "first", (-1, 101)))
    out.append(entry("sapsii_score", "SAPS II score (first 24 hours of the ICU stay)", "SAPS II评分（ICU入住首24小时）", ["SAPS II", "SAPS2", "Simplified Acute Physiology Score II", "SAPS II score", "SAPS II评分", "SAPS II分数", "简化急性生理学评分"], "score", "continuous",
                     "Simplified Acute Physiology Score II (Le Gall 1993) on the worst values of the first 24 hours after ICU admission, 0 to 163." + DERIVED_NOTE + sofa_note,
                     "Timed at ICU admission.", "Age, heart rate, systolic pressure, temperature, PaO2/FiO2 with ventilation, urine output, urea nitrogen, white cells, potassium, sodium, bicarbonate, bilirubin, Glasgow coma score, chronic disease and admission type; a variable with no measurement adds no points.",
                     "No ICU stay means no score.", derived_source({DERIVED_BASE + 41}), "first", (-1, 164)))
    for number, (key, en, zh, words) in enumerate((("respiratory", "respiratory", "呼吸", ["PaO2/FiO2"]), ("coagulation", "coagulation", "凝血", ["platelets"]), ("liver", "liver", "肝脏", ["bilirubin"]), ("cardiovascular", "cardiovascular", "循环", ["MAP and vasopressors"]), ("nervous", "nervous system", "神经系统", ["Glasgow coma score"]), ("renal", "kidney", "肾脏", ["creatinine and urine output"])), start=1):
        out.append(entry(f"sofa_{key}", f"SOFA {en} component (first 24 hours)", f"SOFA{zh}评分", [f"SOFA {en}", f"SOFA {en} score", f"SOFA{zh}", f"SOFA{zh}分数"], "score", "continuous",
                         f"The {en} component of the first-day SOFA ({words[0]}), 0 to 4." + DERIVED_NOTE + sofa_note, "Timed at ICU admission.", f"{words[0]} on the worst value of the first 24 hours.", "No ICU stay means no score.", derived_source({DERIVED_BASE + 20 + number}), "first", (-1, 5)))
    for key, item, en, zh, synonyms, unit in (
        ("invasive_ventilation_hours", 30, "Invasive ventilation duration", "有创机械通气时长", ["ventilator hours", "duration of invasive ventilation", "ventilation duration", "机械通气时间", "呼吸机使用时间", "有创通气时间"], "hours"),
        ("vasopressor_hours", 31, "Vasopressor duration", "血管活性药使用时长", ["duration of vasopressors", "vasopressor hours", "血管活性药物使用时间", "升压药使用时间"], "hours"),
        ("kidney_replacement_hours", 32, "Kidney replacement therapy duration", "肾脏替代治疗时长", ["duration of renal replacement therapy", "dialysis duration", "CRRT duration", "肾脏替代治疗时间", "透析时间"], "hours")):
        out.append(entry(key, en, zh, synonyms, "intervention", "continuous", f"Length of each episode in hours, timed at the start of the episode." + DERIVED_NOTE, "Episodes starting in the study window relative to time zero.", "Episode end minus episode start, in hours.", "No episode means the support was not given.", derived_source({DERIVED_BASE + item}), "sum", (0, 8760)))
    out.append(entry("ventilator_free_days_28", "Ventilator-free days to day 28", "28天无呼吸机天数", ["VFD", "ventilator free days", "ventilator-free days", "VFD28", "无呼吸机天数", "无机械通气天数"], "outcome", "continuous",
                     "28 minus the days on invasive ventilation in the first 28 days after ICU admission; 0 for a patient who died within 28 days." + DERIVED_NOTE, "Timed at ICU admission.", "28 - invasive ventilation days (capped at 28 days from ICU admission); 0 if death within 28 days.", "No ICU stay means no value.", derived_source({DERIVED_BASE + 33}), "first", (-1, 29)))
    for index, days in enumerate(HORIZONS):
        out.append(entry(f"readmission_any_{days}d", f"Readmission within {days} days", f"{days}天内再入院",
                         [f"{days}-day readmission", f"{days} day readmission", f"readmission within {days} days", f"unplanned readmission within {days} days", f"{days}日再入院", f"{days}天再入院", f"出院后{days}天内再入院"] + (["readmission", "hospital readmission", "re-hospitalization", "rehospitalization", "再入院", "重复入院", "再次住院", "再住院"] if days == 365 else []),
                         "outcome", "binary",
                         f"A later admission to the same hospital within {days} days of discharge; patients who died in hospital are not at risk." + DERIVED_NOTE,
                         "Event at the index discharge when a next admission follows within the horizon.", f"Next admission starts at most {days} days after the discharge.",
                         "No record means no readmission was seen at this hospital (a readmission elsewhere is not seen).", derived_source({DERIVED_BASE + 12 + index})))
    order = json.load(open(os.path.join(os.path.dirname(__file__), "..", "config", "derived", "diagnosis-order.json"), encoding="utf-8"))["order"]
    coded = [e for e in entries if e["sources"][0].get("kind") == "diagnosis_code" and e["sources"][0].get("codes")]
    unknown = [e["concept_id"] for e in coded if e["concept_id"] not in order]
    if unknown: sys.exit(f"Append {unknown} to config/derived/diagnosis-order.json (the position fixes the derived item ids).")
    dx = sorted(coded, key=lambda e: order.index(e["concept_id"]))
    han = re.compile(r"[\u4e00-\u9fff]")
    for position, concept in enumerate(dx):
        label, zh = concept["labels"]["en"], concept["labels"]["zh"]
        zh_names = [zh] + [name for name in concept["synonyms"] if han.search(name) and len(name) >= 2]
        en_names = [label.lower()] + [name.lower() for name in concept["synonyms"] if not han.search(name) and len(name) >= 4]
        for index, days in enumerate(HORIZONS):
            long = days == 365
            synonyms = [f"readmission for {n} within {days} days" for n in en_names] + [f"{days}-day readmission for {n}" for n in en_names] + [f"{days}天内因{n}再入院" for n in zh_names] + [f"{days}天内{n}再入院" for n in zh_names] + [f"{days}天因{n}再入院" for n in zh_names]
            if long:
                for n in en_names:
                    synonyms += [f"readmission for {n}", f"hospitalization for {n}", f"hospitalisation for {n}", f"hospitalization due to {n}", f"hospitalisation due to {n}", f"{n} readmission", f"admission for {n}", f"admission due to {n}"]
                for n in zh_names:
                    synonyms += [f"{n}再入院", f"因{n}再入院", f"因{n}入院", f"因{n}住院", f"{n}再住院"]
            out.append(entry(f"readmission_for_{concept['concept_id']}_{days}d", f"Readmission for {label} within {days} days", f"{days}天内因{zh}再入院", list(dict.fromkeys(synonyms)), "outcome", "binary",
                             f"A later admission within {days} days of discharge that carries a diagnosis code of {label}; patients who died in hospital are not at risk." + DERIVED_NOTE,
                             "Event at the index discharge when such an admission follows within the horizon.", f"The first later admission carrying the diagnosis starts at most {days} days after the discharge.",
                             "No record means no such readmission was seen at this hospital.", derived_source({DERIVED_BASE + 1000 + 10 * position + index})))
        history = [f"prior {n}" for n in en_names] + [f"previous {n}" for n in en_names] + [f"history of {n}" for n in en_names] + [f"既往{n}" for n in zh_names] + [f"{n}病史" for n in zh_names] + [f"既往有{n}" for n in zh_names]
        out.append(entry(f"history_of_{concept['concept_id']}", f"History of {label} (earlier admission)", f"既往{zh}（既往住院）", list(dict.fromkeys(history)), "diagnosis", "binary",
                         f"An earlier admission of the patient carries a diagnosis code of {label}; used to approximate new onset." + DERIVED_NOTE,
                         "Event at the index admission time.", "Any admission that ended before the index admission began carries the diagnosis.",
                         "No record means no earlier admission at this hospital carries the diagnosis (history before the first admission is not seen).", derived_source({DERIVED_BASE + 2000 + position})))
    return out


def entry(concept_id, en, zh, synonyms, category, value_type, summary, temporal, value_rule, missing, source, aggregation=None, valid_range=None, category_values=None):
    definition = {"summary": summary, "temporal_rule": temporal, "value_rule": value_rule, "missingness_rule": missing}
    if aggregation:
        definition["aggregation"] = aggregation
    if valid_range:
        definition["valid_range"] = {"min": valid_range[0], "max": valid_range[1]}
    if category_values:
        definition["category_values"] = category_values
    return {"mapping_id": f"mimic-iv.{concept_id.replace('_', '-')}.v1", "concept_id": concept_id, "mapping_version": ENTRY_VERSION,
            "labels": {"en": en, "zh": zh}, "synonyms": synonyms, "category": category, "value_type": value_type,
            "definition": definition, "sources": [source], "status": "validated"}


def build(directory):
    dictionary = {9: set(), 10: set()}
    for row in load(directory, "d_icd_diagnoses.csv"):
        dictionary[int(row["icd_version"])].add(row["icd_code"].strip())
    icu_items = {row["itemid"]: row for row in load(directory, "d_items.csv")}
    lab_items = {row["itemid"]: row for row in load(directory, "d_labitems.csv")}
    entries = []
    for concept_id, en, zh, synonyms, icd9, icd10, note in DIAGNOSES:
        codes = [{"code": code, "version": 9} for code in codes_for(dictionary, 9, icd9)] + [{"code": code, "version": 10} for code in codes_for(dictionary, 10, icd10)]
        entries.append(entry(concept_id, en, zh, synonyms, "diagnosis", "binary", f"{en}: {note}", "Diagnosis codes of the admission (assigned at discharge).",
                             f"Any of {len(codes)} ICD codes (ICD-9 {', '.join(icd9)}; ICD-10 {', '.join(icd10)}).", "No listed code means not recorded, not confirmed absent.",
                             {"kind": "diagnosis_code", "schema": "mimiciv_hosp", "table": "diagnoses_icd", "columns": ["subject_id", "hadm_id", "icd_code", "icd_version"],
                              "dictionary_table": "d_icd_diagnoses", "codes": codes}))
    for concept_id, en, zh, synonyms, category, table, items, column, aggregation, valid_range, unit in MEASUREMENTS:
        icu = table != "labevents"
        check_items(icu_items if icu else lab_items, items, "d_items" if icu else "d_labitems")
        time_column = "starttime" if table == "inputevents" else "charttime"
        ids_column = ["subject_id", "hadm_id", "stay_id"] if icu else ["subject_id", "hadm_id"]
        entries.append(entry(concept_id, en, zh, synonyms, category, "continuous", f"{en} ({unit})", "Values recorded in the study window relative to time zero.",
                             f"{column} of items {', '.join(map(str, items))}; values outside ({valid_range[0]}, {valid_range[1]}) ignored as artifacts.", "No value in the window means not measured.",
                             {"kind": "dictionary_item", "schema": "mimiciv_icu" if icu else "mimiciv_hosp", "table": table, "columns": [*ids_column, "itemid", time_column, column],
                              "dictionary_table": "d_items" if icu else "d_labitems", "item_ids": sorted(items)}, aggregation, valid_range))
    for concept_id, en, zh, synonyms, table, item_ids, valid_range, unit in VARIABILITY:
        dictionary = icu_items if table != "labevents" else lab_items
        items = {item_id: dictionary[str(item_id)]["label"] for item_id in item_ids}
        entries.append(entry(concept_id, en, zh, synonyms, "vital_sign" if table != "labevents" else "laboratory", "continuous",
                             f"{en}: the standard deviation of every recorded value in the study window ({unit}). A patient with a single value has none.", "Values recorded in the study window relative to time zero.",
                             f"Sample standard deviation of valuenum of items {', '.join(map(str, item_ids))}; values outside ({valid_range[0]}, {valid_range[1]}) ignored as artifacts.", "Fewer than two values in the window means no variability.",
                             {"kind": "dictionary_item", "schema": "mimiciv_icu" if table != "labevents" else "mimiciv_hosp", "table": table, "columns": ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "valuenum"] if table != "labevents" else ["subject_id", "hadm_id", "itemid", "charttime", "valuenum"],
                              "dictionary_table": "d_items" if table != "labevents" else "d_labitems", "item_ids": sorted(items)}, "standard_deviation", valid_range))
    for concept_id, en, zh, synonyms, category, table, items, note in EVENTS:
        check_items(icu_items, items, "d_items")
        entries.append(entry(concept_id, en, zh, synonyms, category, "binary", note, "Any recorded event in the study window relative to time zero.",
                             f"Any record of items {', '.join(map(str, items))}.", "No record means not given during the ICU stay.",
                             {"kind": "dictionary_item", "schema": "mimiciv_icu", "table": table, "columns": ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "amount" if table == "inputevents" else "value"],
                              "dictionary_table": "d_items", "item_ids": sorted(items)}, "any"))
    check_items(icu_items, IV_OPIOID_ITEMS, "d_items")
    entries.append(entry("icu_iv_opioid_morphine_equivalents", "ICU IV opioid dose (morphine equivalents)", "ICU静脉阿片类药物剂量（吗啡当量）",
                         ["opioid dose", "opioid analgesic dose", "opioid analgesia dose", "opioid morphine equivalents", "morphine equivalent dose", "MME", "IV morphine equivalents", "镇痛剂量", "阿片类药物剂量", "阿片类药物镇痛剂量", "吗啡当量"],
                         "medication", "continuous",
                         "Total IV opioid given in the ICU (morphine, hydromorphone, fentanyl) as IV morphine equivalents in mg; summed over the study window.",
                         "Infusion and bolus records starting in the study window relative to time zero, summed.",
                         "inputevents.amount of items 225154, 221833, 221744, 225942, 225972 times a per-item, per-unit factor (10 mg IV morphine = 1.5 mg hydromorphone = 100 mcg fentanyl); "
                         "rows whose unit is not listed are ignored; a single record outside (0, 1000) mg is ignored as an artifact. Oral, transdermal, methadone, meperidine and remifentanil are not counted.",
                         "No record means no counted IV opioid was given in the ICU; that is not the same as no opioid (oral and other opioids are not counted).",
                         {"kind": "dictionary_item", "schema": "mimiciv_icu", "table": "inputevents", "columns": ["subject_id", "hadm_id", "stay_id", "itemid", "starttime", "amount", "amountuom"],
                          "dictionary_table": "d_items", "item_ids": sorted(IV_OPIOID_ITEMS), "amount_conversions": IV_OPIOID_CONVERSIONS}, "sum", (0, 1000)))
    check_items(icu_items, {228332: "Delirium assessment"}, "d_items")
    entries.append(entry("delirium", "Delirium", "谵妄", ["delirium incidence", "CAM-ICU positive", "ICU delirium", "谵妄发生", "谵妄发生率"], "outcome", "binary",
                         "Delirium: a positive CAM-ICU delirium assessment (item 228332).", "Any assessment in the study window relative to time zero.",
                         "Item 228332 'Delirium assessment' with value 'Positive'.", "Patients never assessed count as not positive; assessment is not universal.",
                         {"kind": "dictionary_item", "schema": "mimiciv_icu", "table": "chartevents", "columns": ["subject_id", "hadm_id", "stay_id", "itemid", "charttime", "value"],
                          "dictionary_table": "d_items", "value_filters": [{"column": "value", "values": ["Positive"]}, {"column": "itemid", "values": ["228332"]}]}))
    entries.append(entry("hydrocortisone_systemic", "Hydrocortisone", "氢化可的松", ["systemic hydrocortisone", "hydrocortisone sodium succinate", "stress-dose steroids", "氢化可的松琥珀酸钠"], "medication", "binary",
                         "Systemic hydrocortisone: intravenous, intramuscular or enteral orders (creams, suppositories and enemas excluded).", "Orders starting in the study window relative to time zero.",
                         f"Prescription labels {', '.join(SYSTEMIC_HYDROCORTISONE)} with route {', '.join(SYSTEMIC_ROUTES)}.", "No order means not ordered during the admission.",
                         {"kind": "medication_label", "schema": "mimiciv_hosp", "table": "prescriptions", "columns": ["subject_id", "hadm_id", "starttime", "drug", "route"],
                          "value_filters": [{"column": "drug", "values": SYSTEMIC_HYDROCORTISONE}, {"column": "route", "values": SYSTEMIC_ROUTES}]}))
    entries.append(entry("emergency_admission", "Emergency admission", "急诊入院", ["emergency admission type", "urgent admission", "unplanned admission", "非计划入院", "急诊住院"], "encounter", "binary",
                         "Emergency or urgent hospital admission (admission_type EW EMER., DIRECT EMER. or URGENT), a marker of acute illness.", "The admission of the analysis unit.",
                         "admissions.admission_type in EW EMER., DIRECT EMER., URGENT.", "Every admission has an admission type.",
                         {"kind": "direct_field", "schema": "mimiciv_hosp", "table": "admissions", "columns": ["subject_id", "hadm_id", "admission_type"],
                          "value_filters": [{"column": "admission_type", "values": ["EW EMER.", "DIRECT EMER.", "URGENT"]}]}))
    entries.append(entry("icu_length_of_stay", "ICU length of stay", "ICU住院时长", ["ICU LOS", "length of ICU stay", "ICU stay duration", "prolonged ICU stay", "prolonged ICU length of stay", "ICU住院时间", "ICU停留时间"], "outcome", "continuous",
                         "ICU length of stay in days (icustays.los).", "The index ICU stay.", "icustays.los (fractional days).", "Every ICU stay has a length of stay.",
                         {"kind": "direct_field", "schema": "mimiciv_icu", "table": "icustays", "columns": ["subject_id", "hadm_id", "stay_id", "los"]}))
    entries.append(entry("race_ethnicity", "Race/ethnicity", "种族/族裔", ["race", "ethnicity", "racial group", "种族", "族裔", "少数族裔"], "demographic", "categorical",
                         "Source-recorded race/ethnicity (admissions.race), grouped only by consolidating MIMIC's own sub-categories of the same self-identified group "
                         "(e.g. \"BLACK/CAPE VERDEAN\" and \"BLACK/AFRICAN\" under Black or African American); ambiguous entries (Other, Unknown, Unable to obtain, "
                         "Declined, Multiple, South American, Portuguese) are kept as their own distinct values, never merged into a race group they did not state.",
                         "Admission-level attribute; re-recorded at every admission and may differ between admissions for the same patient.",
                         "admissions.race grouped into source families; see category_values for the exact source strings each group covers.",
                         "Every admission has a race value; Unknown/Unable to obtain/Declined are themselves explicit values, not treated as missing.",
                         {"kind": "direct_field", "schema": "mimiciv_hosp", "table": "admissions", "columns": ["subject_id", "hadm_id", "race"]},
                         category_values=[
                             {"source_value": "WHITE", "labels": ["White", "WHITE", "WHITE - OTHER EUROPEAN", "WHITE - RUSSIAN", "WHITE - EASTERN EUROPEAN", "WHITE - BRAZILIAN", "白人"]},
                             {"source_value": "BLACK/AFRICAN AMERICAN", "labels": ["Black or African American", "BLACK/AFRICAN AMERICAN", "BLACK/CAPE VERDEAN", "BLACK/CARIBBEAN ISLAND", "BLACK/AFRICAN", "黑人", "非裔美国人"]},
                             {"source_value": "HISPANIC OR LATINO", "labels": ["Hispanic or Latino", "HISPANIC OR LATINO", "HISPANIC/LATINO - PUERTO RICAN", "HISPANIC/LATINO - DOMINICAN", "HISPANIC/LATINO - GUATEMALAN", "HISPANIC/LATINO - SALVADORAN", "HISPANIC/LATINO - COLUMBIAN", "HISPANIC/LATINO - MEXICAN", "HISPANIC/LATINO - HONDURAN", "HISPANIC/LATINO - CUBAN", "HISPANIC/LATINO - CENTRAL AMERICAN", "西班牙裔", "拉丁裔"]},
                             {"source_value": "ASIAN", "labels": ["Asian", "ASIAN", "ASIAN - CHINESE", "ASIAN - SOUTH EAST ASIAN", "ASIAN - ASIAN INDIAN", "ASIAN - KOREAN", "亚裔"]},
                             {"source_value": "AMERICAN INDIAN/ALASKA NATIVE", "labels": ["American Indian or Alaska Native", "AMERICAN INDIAN/ALASKA NATIVE", "美洲原住民"]},
                             {"source_value": "NATIVE HAWAIIAN OR OTHER PACIFIC ISLANDER", "labels": ["Native Hawaiian or Other Pacific Islander", "NATIVE HAWAIIAN OR OTHER PACIFIC ISLANDER", "太平洋岛民"]},
                             {"source_value": "OTHER", "labels": ["Other", "OTHER"]},
                             {"source_value": "UNKNOWN", "labels": ["Unknown", "UNKNOWN"]},
                             {"source_value": "UNABLE TO OBTAIN", "labels": ["Unable to obtain", "UNABLE TO OBTAIN"]},
                             {"source_value": "PATIENT DECLINED TO ANSWER", "labels": ["Patient declined to answer", "PATIENT DECLINED TO ANSWER"]},
                             {"source_value": "MULTIPLE RACE/ETHNICITY", "labels": ["Multiple race/ethnicity", "MULTIPLE RACE/ETHNICITY"]},
                             {"source_value": "SOUTH AMERICAN", "labels": ["South American", "SOUTH AMERICAN"]},
                             {"source_value": "PORTUGUESE", "labels": ["Portuguese", "PORTUGUESE"]},
                         ]))
    for item in entries:
        item["definition"]["summary"] += f" {REVIEW}"
    entries.extend(derived_entries(entries))
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dictionaries", required=True)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    entries = build(args.dictionaries)
    if not args.write:
        print(json.dumps(entries, ensure_ascii=False, indent=2))
        return
    with open(PACK, encoding="utf-8") as handle:
        pack = json.load(handle)
    ids = {item["concept_id"] for item in entries}
    # Candidates superseded by a validated definition of the same concept are replaced.
    superseded = {"diabetes_history": "diabetes_mellitus", "invasive_ventilation": "invasive_ventilation", "lactate": "lactate",
                  "creatinine": "creatinine", "heart_rate": "heart_rate", "mean_arterial_pressure": "mean_arterial_pressure"}
    kept = [item for item in pack["mappings"] if item["concept_id"] not in ids and superseded.get(item["concept_id"]) not in ids]
    # Hand-maintained entries gain the items found by auditing the archive (ART BP systolic and diastolic).
    for item in kept:
        for concept, extra in ITEM_PATCHES.items():
            if item["concept_id"] == concept:
                ids = item["sources"][0]["item_ids"]; added = [i for i in extra if i not in ids]
                if added: item["sources"][0]["item_ids"] = sorted([*ids, *added]); item["mapping_version"] = ENTRY_VERSION
    pack["mappings"] = kept + entries
    pack["pack_version"] = PACK_VERSION
    # The pack keeps one compact mapping per line.
    header = {key: value for key, value in pack.items() if key != "mappings"}
    lines = ",\n".join("    " + json.dumps(item, ensure_ascii=False, separators=(",", ":")) for item in pack["mappings"])
    head = json.dumps(header, ensure_ascii=False, indent=2)[:-2]
    with open(PACK, "w", encoding="utf-8") as handle:
        handle.write(f"{head},\n  \"mappings\": [\n{lines}\n  ]\n}}\n")
    print(f"pack {PACK_VERSION}: {len(kept)} kept, {len(entries)} core concepts written")


if __name__ == "__main__":
    main()
