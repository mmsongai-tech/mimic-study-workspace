import { DatabaseSync } from "node:sqlite";
import { AssociationAnalysisError, type AssociationInput, type LactateMortalityRecord } from "../domain/association-analysis.js";
import type { LactateMortalityGateway } from "./lactate-mortality-gateway.js";

export interface SafetyDatabaseFieldMapping {
  table: string;
  subject_id: string;
  lactate: string;
  in_hospital_death: string;
  age: string;
  sex: string;
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const validateIdentifier = (value: string, name: string): string => {
  if (!identifier.test(value)) {
    throw new AssociationAnalysisError("ANALYSIS_INPUT_INVALID", `${name} is not a safe SQLite identifier.`);
  }
  return `"${value}"`;
};

export class SqliteSafetyLactateMortalityGateway implements LactateMortalityGateway {
  constructor(private readonly settings: {
    database_path: string;
    data_source_id: string;
    data_source_version: string;
    mapping: SafetyDatabaseFieldMapping;
    now?: () => Date;
  }) {}

  async load(): Promise<AssociationInput> {
    const mapping = this.settings.mapping;
    const table = validateIdentifier(mapping.table, "table");
    const fields = {
      subject: validateIdentifier(mapping.subject_id, "subject_id"),
      lactate: validateIdentifier(mapping.lactate, "lactate"),
      death: validateIdentifier(mapping.in_hospital_death, "in_hospital_death"),
      age: validateIdentifier(mapping.age, "age"),
      sex: validateIdentifier(mapping.sex, "sex"),
    };
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.settings.database_path, { readOnly: true });
      database.exec("PRAGMA query_only = ON");
      const rows = database.prepare(
        `SELECT ${fields.subject} AS subject_id, ${fields.lactate} AS lactate, ` +
        `${fields.death} AS death, ${fields.age} AS age, ${fields.sex} AS sex FROM ${table}`,
      ).all() as Array<Record<string, unknown>>;
      if (rows.length === 0) throw new Error("No eligible rows were returned.");
      const records = rows.map((row, index) => this.mapRow(row, index));
      return {
        records,
        provenance: {
          data_source_id: this.settings.data_source_id,
          data_source_version: this.settings.data_source_version,
          data_mode: "approved_safety_database",
          retrieved_at: (this.settings.now?.() ?? new Date()).toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof AssociationAnalysisError) throw error;
      throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The approved safety database could not be read.");
    } finally {
      database?.close();
    }
  }

  private mapRow(row: Record<string, unknown>, index: number): LactateMortalityRecord {
    const subject = row.subject_id;
    const lactate = row.lactate;
    const death = row.death;
    const age = row.age;
    const sex = typeof row.sex === "string" ? row.sex.trim().toLowerCase() : row.sex;
    if (
      (typeof subject !== "string" && typeof subject !== "number") ||
      typeof lactate !== "number" || !Number.isFinite(lactate) || lactate < 0 ||
      (death !== 0 && death !== 1 && death !== false && death !== true) ||
      typeof age !== "number" || !Number.isFinite(age) || age < 18 || age > 120 ||
      (sex !== "female" && sex !== "male")
    ) {
      throw new AssociationAnalysisError("ANALYSIS_INPUT_INVALID", `The approved safety database row ${index + 1} is invalid.`);
    }
    return {
      synthetic_subject_id: String(subject),
      max_lactate_first_6h: lactate,
      in_hospital_death: death === 1 || death === true,
      age_years: age,
      sex,
    };
  }
}
