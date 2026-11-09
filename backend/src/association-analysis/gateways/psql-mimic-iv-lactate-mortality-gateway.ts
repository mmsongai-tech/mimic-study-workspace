import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AssociationAnalysisError,
  type AssociationInput,
  type LactateMortalityRecord,
} from "../domain/association-analysis.js";
import type { LactateMortalityGateway } from "./lactate-mortality-gateway.js";

export interface PsqlLactateCohortRunner {
  run(input: {
    binary: string;
    arguments_: string[];
    environment: NodeJS.ProcessEnv;
  }): Promise<{ exitCode: number; stdout: string }>;
}

const defaultRunner: PsqlLactateCohortRunner = {
  run: async ({ binary, arguments_, environment }) => new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, {
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 10_000_000) chunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({
      exitCode: exitCode ?? 1,
      stdout: Buffer.concat(chunks).toString("utf8"),
    }));
  }),
};

const parseRecord = (line: string): LactateMortalityRecord => {
  const [recordType, recordId, rawLactate, rawDeath, rawAge, rawSex] = line.split(",");
  const lactate = Number(rawLactate);
  const death = Number(rawDeath);
  const age = Number(rawAge);
  if (
    recordType !== "RECORD"
    || !recordId?.match(/^ROW-\d{6}$/u)
    || !Number.isFinite(lactate)
    || lactate <= 0
    || lactate > 30
    || ![0, 1].includes(death)
    || !Number.isFinite(age)
    || age < 18
    || !["F", "M"].includes(rawSex ?? "")
  ) throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The MIMIC-IV cohort did not match its approved contract.");
  return {
    synthetic_subject_id: recordId,
    max_lactate_first_6h: lactate,
    in_hospital_death: death === 1,
    age_years: age,
    sex: rawSex === "F" ? "female" : "male",
  };
};

export class PsqlMimicIvLactateMortalityGateway implements LactateMortalityGateway {
  constructor(
    private readonly settings: {
      service: string;
      binary: string;
      connect_timeout_seconds: number;
      query_path?: string;
    },
    private readonly runner: PsqlLactateCohortRunner = defaultRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<AssociationInput> {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(this.settings.service)) {
      throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The PostgreSQL service name is invalid.");
    }
    const queryPath = this.settings.query_path ?? fileURLToPath(
      new URL("../sql/mimic-iv-lactate-mortality-cohort.sql", import.meta.url),
    );
    let result: { exitCode: number; stdout: string };
    try {
      result = await this.runner.run({
        binary: this.settings.binary,
        arguments_: ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-f", queryPath],
        environment: {
          ...process.env,
          PGSERVICE: this.settings.service,
          PGCONNECT_TIMEOUT: String(this.settings.connect_timeout_seconds),
        },
      });
    } catch {
      throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The approved MIMIC-IV cohort could not be loaded.");
    }
    if (result.exitCode !== 0 || result.stdout.length > 10_000_000) {
      throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The approved MIMIC-IV cohort could not be loaded.");
    }
    const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const headerIndex = lines.indexOf("record_type,analysis_record_id,max_lactate_first_6h,hospital_expire_flag,age_years,gender,eligible_first_admissions,missing_lactate,excluded_measurements");
    if (headerIndex < 0) throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The MIMIC-IV cohort response was missing its contract header.");
    const dataLines = lines.slice(headerIndex + 1);
    const auditFields = dataLines.find((line) => line.startsWith("AUDIT,"))?.split(",");
    const records = dataLines.filter((line) => line.startsWith("RECORD,")).map(parseRecord);
    const eligible = Number(auditFields?.[6]);
    const missing = Number(auditFields?.[7]);
    const excluded = Number(auditFields?.[8]);
    if (records.length === 0) throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The approved MIMIC-IV cohort was empty.");
    if (![eligible, missing, excluded].every(Number.isFinite) || eligible !== records.length + missing) {
      throw new AssociationAnalysisError("ANALYSIS_DATA_UNAVAILABLE", "The MIMIC-IV cohort audit did not reconcile.");
    }
    return {
      records,
      provenance: {
        data_source_id: "mimic-iv-company-readonly",
        data_source_version: "lactate-mortality-cohort-1.0.0",
        data_mode: "approved_safety_database",
        retrieved_at: this.now().toISOString(),
        cohort_audit: {
          eligible_first_admissions: eligible,
          missing_lactate: missing,
          excluded_measurements: excluded,
        },
      },
    };
  }
}
