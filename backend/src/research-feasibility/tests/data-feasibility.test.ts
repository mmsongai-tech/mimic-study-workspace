import assert from "node:assert/strict";
import test from "node:test";
import { assessDataFeasibility } from "../index.js";
import type { StudyVariableMappingReview } from "../../variable-mapping/index.js";

const mappings = (status: "ready" | "needs_confirmation" | "blocked") => ({
  schema_version: "1.0.0" as const, status, variables: status === "ready" ? [{ requested_term: "任意变量", role: "exposure" as const, status: "resolved" as const }] : [{ requested_term: "任意变量", role: "exposure" as const, status: "needs_confirmation" as const }],
  summary: { resolved: status === "ready" ? 1 : 0, needs_confirmation: status === "ready" ? 0 : 1, unmapped: 0 }, verification_available: true,
}) as unknown as StudyVariableMappingReview;

test("returns ready only when source, mappings and profile evidence exist", () => {
  const result = assessDataFeasibility({ data_source: { id: "local", version: "1", mode: "local_archive" }, mappings: mappings("ready"), catalog_integrity_id: "catalog:1", profile_id: "profile:1" });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.blockers, []);
});

test("reports the exact unresolved role and missing profile", () => {
  const result = assessDataFeasibility({ data_source: { id: "local", version: "1", mode: "local_archive" }, mappings: mappings("needs_confirmation") });
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0]?.role, "exposure");
  assert.equal(result.blockers[1]?.code, "PROFILE_MISSING");
});
