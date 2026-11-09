export interface ClinicalTermExpansion {
  normalized_label_en: string;
  synonyms: string[];
  code_hints?: string[];
  category: "demographic" | "encounter" | "vital_sign" | "laboratory" | "medication" | "intervention" | "diagnosis" | "score" | "outcome" | "unknown";
  ambiguities: Array<{ label: string; explanation: string }>;
}

export interface ClinicalTermExpander {
  expand(input: { term: string; role: string }): Promise<ClinicalTermExpansion>;
}

export interface MimicTerminologyMatch {
  dictionary: "d_items" | "d_labitems" | "d_icd_diagnoses" | "d_icd_procedures" | "prescriptions_drug";
  identifier: string;
  label: string;
  category?: string;
  source_table?: string;
  code_version?: 9 | 10;
  /**
   * Set only on an entry that embedding search added (its label is near the term's meaning but need not contain its words).
   * Rules that trust an entry because text search found it, such as the drug-label exemption, do not apply to it.
   */
  retrieved_by?: "embedding";
}

export interface MimicTerminologySearchGateway {
  search(term: string): Promise<MimicTerminologyMatch[]>;
  searchByCategory?(term: string, category: ClinicalTermExpansion["category"]): Promise<MimicTerminologyMatch[]>;
  searchMedication?(term: string): Promise<MimicTerminologyMatch[]>;
  searchCodePrefix?(prefix: string): Promise<MimicTerminologyMatch[]>;
  searchNonMedication?(term: string): Promise<MimicTerminologyMatch[]>;
}
