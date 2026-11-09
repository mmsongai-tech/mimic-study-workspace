import { createHash } from "node:crypto";

export interface BinaryContingencyTable { exposed_events: number; exposed_non_events: number; unexposed_events: number; unexposed_non_events: number; }
export interface AggregateBinaryAssociationResult {
  schema_version: "1.0.0"; status: "completed"; method_id: "aggregate_binary_association.v1"; input_integrity_id: string;
  counts: BinaryContingencyTable;
  estimates: { exposed_risk: number; unexposed_risk: number; risk_difference: number; risk_ratio: number | null; odds_ratio: number | null };
  model: { input: "aggregate_2x2"; formula: string; estimands: string[]; limitations: string[] };
}

/** Executes a reproducible binary association from aggregate counts only. */
export const executeAggregateBinaryAssociation = (counts: BinaryContingencyTable): AggregateBinaryAssociationResult => {
  for (const [key, value] of Object.entries(counts)) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid aggregate count: ${key}`);
  const exposedTotal = counts.exposed_events + counts.exposed_non_events;
  const unexposedTotal = counts.unexposed_events + counts.unexposed_non_events;
  if (!exposedTotal || !unexposedTotal) throw new Error("Both exposure groups must contain at least one record.");
  const exposedRisk = counts.exposed_events / exposedTotal;
  const unexposedRisk = counts.unexposed_events / unexposedTotal;
  return { schema_version: "1.0.0", status: "completed", method_id: "aggregate_binary_association.v1", input_integrity_id: `sha256:${createHash("sha256").update(JSON.stringify(counts)).digest("hex")}`, counts, estimates: { exposed_risk: exposedRisk, unexposed_risk: unexposedRisk, risk_difference: exposedRisk - unexposedRisk, risk_ratio: unexposedRisk ? exposedRisk / unexposedRisk : null, odds_ratio: counts.exposed_non_events && counts.unexposed_events ? (counts.exposed_events * counts.unexposed_non_events) / (counts.exposed_non_events * counts.unexposed_events) : null }, model: { input: "aggregate_2x2", formula: "risk = events / (events + non_events); OR = (a*d)/(b*c)", estimands: ["exposed risk", "unexposed risk", "risk difference", "risk ratio", "odds ratio"], limitations: ["Crude aggregate association; no covariate adjustment.", "Temporal ordering and confounding require separate study validation."] } };
};
