# The derived-variable layer / 推导变量层

MIMIC-IV has no ready-made "acute kidney injury", "eGFR", "SOFA" or "readmission". The platform computes them once from the raw archive
(`scripts/derived/build_derived.py`) into a table of events and then reads that table like any other MIMIC table, so its time windows,
options and result checks apply unchanged. Adding a derived variable means adding a definition to the build script and a concept to the pack
(`scripts/build-core-concepts.py`), not changing the analysis engine.
MIMIC-IV 没有现成的"急性肾损伤""eGFR""SOFA""再入院"。平台从原始压缩包一次性算出它们，存成事件表，运行时当作普通 MIMIC 表读取，所以时间窗口、选项和结果检查都直接适用。新增一个推导变量只需在构建脚本和概念包里加一条定义，不需要改分析引擎。

**Status / 状态:** the definitions follow the public definitions of the MIMIC community (MIT-LCP `mimic-code`, MIT licence) and the original papers, rewritten
for this platform; they have been checked against published ranges below but **not reviewed by a clinician**. 定义参照 MIMIC 社区公开定义（MIT-LCP mimic-code，MIT 许可）和原始文献并为本平台重写；已与已发表的范围核对，**但尚未经临床医生审核**。

**Privacy / 隐私:** the output is a table of patient-level events derived from MIMIC-IV. It stays with the archive (same folder), is git-ignored and may only be shared with credentialed people.
输出是由 MIMIC-IV 派生的患者级事件表，与压缩包放在一起，不进 git，只能给有授权的人。

## Build and use / 构建与使用

```bash
python3 scripts/derived/build_derived.py --archive /path/to/mimic-iv-3.1.zip --out .local/derived     # about 15 minutes, once
cp .local/derived/mimic-iv-3.1-derived.zip /path/to/                                                     # next to the archive
```

The platform finds `<archive name>-derived.zip` next to the archive. A question that needs a derived variable stops with an explicit message when the file is missing.
平台在压缩包旁边找 `<压缩包名>-derived.zip`；缺失时，需要推导变量的问题会明确报错。

## What is in it / 内容

| Family | Concepts (pack ids) | Definition | Check against the literature |
|---|---|---|---|
| Kidney | `acute_kidney_injury_kdigo`, `egfr` | KDIGO creatinine criteria at every creatinine of an admission (rise ≥0.3 mg/dL in 48 h or ≥1.5× the lowest of the previous 7 days; stage 2 ≥2.0×; stage 3 ≥3.0× or ≥4.0 mg/dL with a rise); eGFR by CKD-EPI 2021 (race-free) at every creatinine | 16.8% of admissions with a creatinine meet a stage; stages 61% / 12% / 27%; median eGFR 78 |
| Across admissions | `readmission_any_{30,90,365}d`, `readmission_for_<diagnosis>_{30,90,365}d`, `history_of_<diagnosis>`, `discharged_alive`, `hospital_length_of_stay` | Next admission of the same patient to this hospital after a live discharge, any cause or carrying a diagnosis of the 24 coded concepts; an earlier admission carrying the diagnosis (approximate "new onset"); alive at discharge; discharge minus admission | 30-day readmission 20% of live discharges, 365-day 44% |
| ICU first day | `sofa_score` and six components | SOFA (Vincent 1996) on the worst value of the first 24 hours after ICU admission; a component without a measurement scores 0 | median 4, mean 4.9 |
| Severity | `oasis_score`, `sapsii_score` | OASIS (Johnson 2013, ten variables, no laboratory value) and SAPS II (Le Gall 1993, fifteen variables) on the first 24 hours after ICU admission; a variable with no measurement adds no points (`scripts/derived/severity.py` lists every cut-off) | mean 31 and 37.5; area under the curve for in-hospital death 0.73 and 0.78 (SOFA 0.73) |
| Sepsis | `sepsis3_icu_admission` | A first-day approximation of Sepsis-3: a suspected infection (systemic antibiotic and a culture of the same admission, Seymour 2016) within a day of ICU admission and a first-day SOFA of 2 or more, the baseline SOFA taken as 0 (`scripts/derived/sepsis.py`) | see the build summary |
| Temperature | `temperature` | Every charted temperature in Celsius; Fahrenheit charting, four fifths of the records, is converted | – |
| Organ support | `invasive_ventilation_hours`, `vasopressor_hours`, `kidney_replacement_hours`, `ventilator_free_days_28` | Episode lengths in hours timed at the start (vasopressor records merged while the gap is ≤6 h); 28 minus ventilator days, 0 after death within 28 days | mean ventilator-free days 23 |
| Variability | `sbp_variability`, `map_variability`, `heart_rate_variability`, `respiratory_rate_variability`, `glucose_variability` | Sample standard deviation of every value in the study window (a built-in aggregation of the analysis engine, so it follows the exposure window) | – |

## Known limits / 已知限制

- **Acute kidney injury** uses creatinine only; urine output is not used. The reference is the lowest creatinine of the same admission, so a patient whose first creatinine is already raised is not detected, and a patient with one creatinine cannot be classified.
- **Readmission and history** see only this hospital. A readmission elsewhere is not seen; "no earlier record" is not "never had it".
- **First-day SOFA** is a fixed summary of the 24 hours after ICU admission timed at ICU admission: it does not follow a different exposure window, and a hospital-indexed analysis sees it only when the ICU stay starts inside its exposure window. A component with no measurement scores 0, which understates missing data. PaO2/FiO2 pairs a PaO2 with the latest FiO2 within 4 hours.
- **OASIS and SAPS II** follow the published point tables and the public mimic-code conventions; first-day only, like SOFA. SAPS II needs the admission type and the first hospital service (scheduled surgery, unscheduled surgery, medicine) and the chronic-disease flags (AIDS, haematologic malignancy, metastatic cancer) come from diagnosis codes. Temperature in Fahrenheit is converted. Urine output sums the first 24 hours of the listed urine outputs. APS III is not built.
- **Sepsis-3 here is a first-day approximation.** Sepsis that begins later in the ICU stay, a suspected infection more than a day before ICU admission, and a patient whose first-day SOFA is 1 or less are not counted; the baseline SOFA is assumed 0. It is not the hourly mimic-code `sepsis3`. A plain request for "sepsis" still means the coded diagnosis; the concept answers only a request that names Sepsis-3.
- **A stale layer is refused.** The layer records a fingerprint of the diagnosis definitions it was built from (`derived/layer.json`); the platform compares it with the current pack and stops with a message to rebuild when they differ. The position of each diagnosis concept (which fixes its readmission and history item ids) is kept in `config/derived/diagnosis-order.json`, append-only.
- **Vasopressor episodes** merge records of any vasopressor; doses are not summarised.
- Concepts of the layer are validated pack entries but carry the note "pending clinical review" in their definition.
