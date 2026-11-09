import type { ClinicalTermExpansion, MimicTerminologyMatch } from "./terminology-gateway.js";

export type MimicDataDomainId = "demographics" | "encounters" | "diagnoses" | "procedures" | "medications" | "laboratory" | "bedside_measurements" | "microbiology";

export interface MimicDataDomainDescriptor {
  id: MimicDataDomainId;
  categories: ClinicalTermExpansion["category"][];
  dictionaries: MimicTerminologyMatch["dictionary"][];
  source_tables: string[];
  grain: "patient" | "encounter" | "icu_stay" | "event";
  join_keys: Array<"subject_id" | "hadm_id" | "stay_id">;
  time_columns: string[];
}

/** Safe metadata routing catalog. It contains no patient rows or study-specific concepts. */
export const mimicDataDomainCatalog: MimicDataDomainDescriptor[] = [
  { id: "demographics", categories: ["demographic"], dictionaries: [], source_tables: ["mimiciv_hosp.patients"], grain: "patient", join_keys: ["subject_id"], time_columns: ["anchor_year"] },
  { id: "encounters", categories: ["encounter", "outcome"], dictionaries: [], source_tables: ["mimiciv_hosp.admissions", "mimiciv_icu.icustays"], grain: "encounter", join_keys: ["subject_id", "hadm_id", "stay_id"], time_columns: ["admittime", "dischtime", "intime", "outtime"] },
  { id: "diagnoses", categories: ["diagnosis", "outcome"], dictionaries: ["d_icd_diagnoses"], source_tables: ["mimiciv_hosp.diagnoses_icd"], grain: "encounter", join_keys: ["subject_id", "hadm_id"], time_columns: [] },
  { id: "procedures", categories: ["intervention"], dictionaries: ["d_icd_procedures"], source_tables: ["mimiciv_hosp.procedures_icd"], grain: "encounter", join_keys: ["subject_id", "hadm_id"], time_columns: ["chartdate"] },
  { id: "medications", categories: ["medication", "intervention"], dictionaries: ["prescriptions_drug"], source_tables: ["mimiciv_hosp.prescriptions", "mimiciv_hosp.emar", "mimiciv_icu.inputevents"], grain: "event", join_keys: ["subject_id", "hadm_id", "stay_id"], time_columns: ["starttime", "stoptime", "charttime"] },
  { id: "laboratory", categories: ["laboratory"], dictionaries: ["d_labitems"], source_tables: ["mimiciv_hosp.labevents"], grain: "event", join_keys: ["subject_id", "hadm_id"], time_columns: ["charttime", "storetime"] },
  { id: "bedside_measurements", categories: ["vital_sign", "score", "intervention"], dictionaries: ["d_items"], source_tables: ["mimiciv_icu.chartevents", "mimiciv_icu.outputevents", "mimiciv_icu.procedureevents"], grain: "event", join_keys: ["subject_id", "hadm_id", "stay_id"], time_columns: ["charttime", "starttime", "endtime"] },
  { id: "microbiology", categories: ["laboratory"], dictionaries: [], source_tables: ["mimiciv_hosp.microbiologyevents"], grain: "event", join_keys: ["subject_id", "hadm_id"], time_columns: ["chartdate", "charttime"] },
];

const allDictionaries = [...new Set(mimicDataDomainCatalog.flatMap(({ dictionaries }) => dictionaries))];

export const terminologyDictionariesForCategory = (category: ClinicalTermExpansion["category"]): MimicTerminologyMatch["dictionary"][] => {
  if (category === "unknown") return [...allDictionaries];
  const selected = mimicDataDomainCatalog.filter(({ categories }) => categories.includes(category)).flatMap(({ dictionaries }) => dictionaries);
  return [...new Set(selected)];
};

