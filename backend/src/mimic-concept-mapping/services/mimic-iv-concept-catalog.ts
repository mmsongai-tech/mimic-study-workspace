import type { MimicConceptDefinition } from "../domain/mimic-concept.js";

export const initialMimicIvConceptCatalog: MimicConceptDefinition[] = [
  {
    id: "icu_stay",
    label: "ICU stay",
    synonyms: ["icu admission", "icu stay", "icu 入科", "icu 入院", "重症监护"],
    field_candidates: [{ module: "icu", table: "icustays", columns: ["subject_id", "hadm_id", "stay_id", "intime", "outtime", "los"] }],
    requires_dictionary_resolution: false,
  },
  {
    id: "mortality",
    label: "Mortality",
    synonyms: ["mortality", "death", "死亡", "院内死亡", "28 天死亡", "28-day mortality"],
    field_candidates: [{ module: "hosp", table: "admissions", columns: ["subject_id", "hadm_id", "deathtime", "hospital_expire_flag", "dischtime"] }],
    requires_dictionary_resolution: false,
  },
  {
    id: "fluid_balance",
    label: "Fluid balance",
    synonyms: ["fluid balance", "positive fluid balance", "液体平衡", "液体正平衡", "出入量"],
    field_candidates: [
      { module: "icu", table: "inputevents", columns: ["stay_id", "itemid", "starttime", "endtime", "amount", "amountuom"], dictionary_table: "d_items" },
      { module: "icu", table: "outputevents", columns: ["stay_id", "itemid", "charttime", "value", "valueuom"], dictionary_table: "d_items" },
    ],
    requires_dictionary_resolution: true,
  },
  {
    id: "acute_kidney_injury",
    label: "Acute kidney injury",
    synonyms: ["acute kidney injury", "aki", "急性肾损伤"],
    field_candidates: [
      { module: "hosp", table: "labevents", columns: ["subject_id", "hadm_id", "itemid", "charttime", "valuenum", "valueuom"], dictionary_table: "d_labitems" },
      { module: "icu", table: "outputevents", columns: ["stay_id", "itemid", "charttime", "value", "valueuom"], dictionary_table: "d_items" },
    ],
    requires_dictionary_resolution: true,
  },
  {
    id: "antibiotic_exposure",
    label: "Antibiotic exposure",
    synonyms: ["antibiotic", "antimicrobial", "抗菌药", "抗生素"],
    field_candidates: [
      { module: "hosp", table: "prescriptions", columns: ["subject_id", "hadm_id", "starttime", "stoptime", "drug", "route"] },
      { module: "hosp", table: "emar", columns: ["subject_id", "hadm_id", "charttime", "medication", "event_txt"] },
    ],
    requires_dictionary_resolution: false,
  },
  {
    id: "sepsis",
    label: "Sepsis",
    synonyms: ["sepsis", "septic", "脓毒症", "感染性休克"],
    field_candidates: [{ module: "hosp", table: "diagnoses_icd", columns: ["subject_id", "hadm_id", "icd_code", "icd_version", "seq_num"] }],
    requires_dictionary_resolution: false,
  },
  {
    id: "sofa_score",
    label: "SOFA score",
    synonyms: ["sofa", "序贯器官衰竭", "器官功能评分"],
    field_candidates: [{ module: "icu", table: "chartevents", columns: ["stay_id", "itemid", "charttime", "valuenum", "valueuom"], dictionary_table: "d_items" }],
    requires_dictionary_resolution: true,
  },
  {
    id: "length_of_stay",
    label: "Length of stay",
    synonyms: ["length of stay", "los", "住院时长", "住院时间", "icu 时长"],
    field_candidates: [
      { module: "hosp", table: "admissions", columns: ["subject_id", "hadm_id", "admittime", "dischtime"] },
      { module: "icu", table: "icustays", columns: ["stay_id", "intime", "outtime", "los"] },
    ],
    requires_dictionary_resolution: false,
  },
  {
    id: "red_blood_cell_transfusion",
    label: "Red blood cell transfusion",
    synonyms: ["red blood cell", "rbc transfusion", "blood transfusion", "红细胞输血", "输血"],
    field_candidates: [{ module: "icu", table: "inputevents", columns: ["stay_id", "itemid", "starttime", "endtime", "amount", "amountuom"], dictionary_table: "d_items" }],
    requires_dictionary_resolution: true,
  },
];

