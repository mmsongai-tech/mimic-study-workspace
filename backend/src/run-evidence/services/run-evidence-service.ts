import { createHash, randomUUID } from "node:crypto";
import type { AssociationAnalysisResult } from "../../association-analysis/domain/association-analysis.js";
import type { PredictionAnalysisResult } from "../../prediction-analysis/domain/prediction-analysis.js";
import type { TreatmentEffectAnalysisResult } from "../../treatment-effect-analysis/domain/treatment-effect-analysis.js";
import type { ConfirmedStudySpec } from "../../research-design/design-session.js";
import type { PreflightResult } from "../../research-feasibility/domain/preflight.js";
import { RunEvidenceError, type RunArtifact, type RunEvidenceBundle } from "../domain/run-artifact.js";
import { assessStatisticalDiagnostics, selectStatisticalMethod, type StatisticalDiagnosticObservation } from "../../analysis-planning/index.js";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
  return value;
};

const format = (value: number): string => Number.isFinite(value) ? value.toFixed(3) : "not available";

export class RunEvidenceService {
  constructor(private readonly dependencies: { now: () => Date; createRunId?: () => string }) {}

  create(input: {
    study: ConfirmedStudySpec;
    preflight: PreflightResult;
    analysis: AssociationAnalysisResult | PredictionAnalysisResult | TreatmentEffectAnalysisResult;
  }): RunEvidenceBundle {
    if (
      input.preflight.status !== "supported" ||
      input.preflight.confirmed_study_integrity_id !== input.study.integrity_id ||
      input.analysis.study_integrity_id !== input.study.integrity_id ||
      input.preflight.capability_id !== input.analysis.capability_id
    ) throw new RunEvidenceError("Study, preflight, and analysis evidence do not match.");

    const base = {
      schema_version: "1.0.0" as const,
      run_id: this.dependencies.createRunId?.() ?? randomUUID(),
      created_at: this.dependencies.now().toISOString(),
      evidence_level: input.analysis.provenance.data_mode === "synthetic"
        ? "synthetic_execution" as const
        : "approved_safety_database_execution" as const,
      study: input.study,
      preflight: input.preflight,
      analysis: input.analysis,
      statistical_review: this.statisticalReview(input.study.spec, input.analysis),
    };
    const integrity = createHash("sha256")
      .update(JSON.stringify(canonicalize(base)))
      .digest("hex");
    const artifact: RunArtifact = { ...base, integrity_id: `sha256:${integrity}` };
    const reportMarkdown = this.report(artifact);
    return { artifact, report_markdown: reportMarkdown, report_rtf: this.rtf(reportMarkdown) };
  }

  private statisticalReview(
    studySpec: ConfirmedStudySpec["spec"],
    analysis: AssociationAnalysisResult | PredictionAnalysisResult | TreatmentEffectAnalysisResult,
  ): NonNullable<RunArtifact["statistical_review"]> {
    const method = selectStatisticalMethod(studySpec);
    const observations = method.blocking_diagnostic_codes.map((code): StatisticalDiagnosticObservation => {
      if (code === "cohort_reconciliation") {
        const reconciled = "analysis_kind" in analysis && analysis.analysis_kind === "binary_prediction"
          ? analysis.counts.development + analysis.counts.validation === analysis.counts.total
          : "analysis_kind" in analysis && analysis.analysis_kind === "propensity_weighted_treatment_effect"
            ? analysis.counts.treated + analysis.counts.untreated === analysis.counts.total
            : analysis.counts.exposed + analysis.counts.unexposed === analysis.counts.total;
        return { code, state: reconciled ? "pass" : "fail", summary: reconciled ? "Analysis group denominators reconcile to the total." : "Analysis group denominators do not reconcile to the total." };
      }
      if (code === "model_convergence") {
        const converged = "analysis_kind" in analysis && analysis.analysis_kind === "binary_prediction"
          ? analysis.diagnostics.model_converged
          : "analysis_kind" in analysis && analysis.analysis_kind === "propensity_weighted_treatment_effect"
            ? analysis.diagnostics.propensity_model_converged
            : analysis.diagnostics?.model_converged;
        return { code, state: converged === undefined ? "not_evaluated" : converged ? "pass" : "fail", summary: converged === undefined ? "Model convergence was not recorded." : converged ? "The fitted model converged." : "The fitted model did not converge." };
      }
      if (code === "event_information") {
        const eventInformation = "analysis_kind" in analysis && analysis.analysis_kind === "binary_prediction"
          ? analysis.counts.validation_events
          : "analysis_kind" in analysis && analysis.analysis_kind === "propensity_weighted_treatment_effect"
            ? analysis.counts.treated_events + analysis.counts.untreated_events
            : analysis.diagnostics?.events_per_parameter;
        const adequate = eventInformation !== undefined && eventInformation >= 10;
        return { code, state: eventInformation === undefined ? "not_evaluated" : adequate ? "pass" : "fail", summary: eventInformation === undefined ? "Event information was not recorded." : adequate ? "The registered minimum event-information rule passed." : "Event information is below the registered minimum." };
      }
      if (code === "resampling_integrity" && "analysis_kind" in analysis && analysis.analysis_kind === "binary_prediction") {
        const valid = analysis.counts.development > 0 && analysis.counts.validation > 0;
        return { code, state: valid ? "pass" : "fail", summary: valid ? "Development and validation partitions are both present." : "The validation partition is invalid." };
      }
      if ("analysis_kind" in analysis && analysis.analysis_kind === "propensity_weighted_treatment_effect") {
        if (code === "treatment_timing") return { code, state: "pass", summary: "The registered capability uses a prespecified treatment window aligned to time zero." };
        if (code === "propensity_overlap") {
          const valid = analysis.diagnostics.extreme_weight_fraction <= 0.10;
          return { code, state: valid ? "pass" : "fail", summary: valid ? "The extreme-weight fraction is within the registered limit." : "Extreme weights indicate inadequate propensity overlap." };
        }
        if (code === "covariate_balance") {
          const valid = analysis.diagnostics.maximum_smd_after <= 0.10;
          return { code, state: valid ? "pass" : "fail", summary: valid ? "Post-weighting covariate balance meets the absolute SMD target." : "Residual covariate imbalance exceeds the absolute SMD target." };
        }
        if (code === "effective_sample_size") {
          const valid = analysis.diagnostics.effective_sample_size >= analysis.counts.total * 0.50;
          return { code, state: valid ? "pass" : "fail", summary: valid ? "Effective sample size remains at least half of the cohort." : "Weighting reduced the effective sample size below half of the cohort." };
        }
      }
      return { code, state: "not_evaluated", summary: "This critical diagnostic is not implemented for the registered executor." };
    });
    const diagnostics = assessStatisticalDiagnostics(method, observations);
    return {
      method,
      diagnostics,
      interpretation_status: diagnostics.decision === "blocked" ? "blocked" : diagnostics.decision === "reportable_with_warnings" ? "allowed_with_warnings" : "allowed",
    };
  }

  private statisticalReviewLines(artifact: RunArtifact): string[] {
    const review = artifact.statistical_review;
    if (!review) return [];
    return [
      "## Statistical review decision", "",
      `Method profile: ${review.method.method_id} (${review.method.method_version})`,
      `Interpretation status: ${review.interpretation_status}`,
      ...(review.diagnostics.blocking_reasons.length ? review.diagnostics.blocking_reasons.map((reason) => `- BLOCKING: ${reason}`) : ["- All implemented critical diagnostic gates passed."]),
      ...review.diagnostics.warnings.map((warning) => `- WARNING: ${warning}`),
      ...(review.interpretation_status === "blocked" ? ["- Primary interpretation is blocked; retain this artifact for diagnostic review only."] : []),
      "",
    ];
  }

  private rtf(markdown: string): string {
    const body = markdown
      .replace(/^#{1,3} /gmu, "")
      .replace(/^[-*] /gmu, "• ")
      .split("\n")
      .map((line) => line.replace(/[\\{}]/gu, (value) => `\\${value}`)
        .replace(/[^\x00-\x7F]/gu, (value) => {
          const code = value.charCodeAt(0);
          return `\\u${code > 32_767 ? code - 65_536 : code}?`;
        }))
      .join("\\par\n");
    return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\fs22\\f0\n${body}\n}`;
  }

  private report(artifact: RunArtifact): string {
    if ("analysis_kind" in artifact.analysis && artifact.analysis.analysis_kind === "binary_prediction") {
      return this.predictionReport(artifact, artifact.analysis);
    }
    if ("analysis_kind" in artifact.analysis && artifact.analysis.analysis_kind === "propensity_weighted_treatment_effect") {
      return this.treatmentReport(artifact, artifact.analysis);
    }
    return this.associationReport(artifact, artifact.analysis);
  }

  private associationReport(artifact: RunArtifact, analysis: AssociationAnalysisResult): string {
    const { counts, estimates } = analysis;
    const runtime = analysis.runtime;
    const tableOne = analysis.publication_outputs?.tables?.find((table) => table.id === "table_1");
    const adjusted = analysis.adjusted_estimates;
    const diagnostics = analysis.diagnostics;
    const sensitivity = analysis.sensitivity_analyses;
    return [
      `# ${artifact.study.spec.title ?? "Research analysis"}`,
      "",
      "## Study design",
      "",
      `Research question: ${artifact.study.spec.research_question}`,
      `Population: ${artifact.study.spec.population?.description ?? "not recorded"}`,
      `Index time: ${artifact.study.spec.index_time?.event ?? "not recorded"}; ${artifact.study.spec.index_time?.selection_rule ?? "not recorded"}`,
      `Exposure: ${artifact.study.spec.exposure_or_predictors?.map((item) => item.name).join(", ") ?? "not recorded"}`,
      `Outcome: ${artifact.study.spec.outcome?.name ?? "not recorded"}`,
      "",
      "## Statistical methods",
      "",
      `Primary method: ${analysis.method.id} (version ${analysis.method.version})`,
      `Runtime: ${runtime ? `${runtime.language} ${runtime.version}` : "not recorded"}`,
      `Exposure threshold: > ${format(analysis.threshold_mmol_l)} mmol/L`,
      "Method rationale: a 2x2 analysis was selected because both the prespecified exposure contrast and outcome are binary. It directly reports absolute risk difference and odds ratio; the secondary logistic model examines whether the association persists after limited adjustment.",
      "Required conditions: one eligible record per patient, exposure measured before outcome ascertainment, correct binary classification, independent observations, adequate cell counts, and no uncontrolled confounding for any causal interpretation.",
      "The analysis reports group risks, an absolute risk difference, and a crude odds ratio with a 95% confidence interval.",
      "A Haldane–Anscombe correction of 0.5 is applied only if a 2×2 table cell is zero.",
      adjusted
        ? "The prespecified primary estimate is crude. A secondary logistic model adjusts for age and sex as a sensitivity analysis; no missing-data imputation or subgroup analysis is performed."
        : "No covariate adjustment, missing-data imputation, subgroup analysis, or sensitivity analysis was estimable for this run.",
      "",
      `Evidence: ${artifact.evidence_level}`,
      `Run ID: ${artifact.run_id}`,
      `Study integrity: ${artifact.study.integrity_id}`,
      `Data source: ${analysis.provenance.data_source_id} (${analysis.provenance.data_source_version})`,
      "",
      ...this.statisticalReviewLines(artifact),
      "## Results",
      "",
      `Total observations: ${counts.total}`,
      `Exposed events: ${counts.exposed_events}/${counts.exposed}`,
      `Unexposed events: ${counts.unexposed_events}/${counts.unexposed}`,
      `Exposed risk: ${format(estimates.exposed_risk)}`,
      `Unexposed risk: ${format(estimates.unexposed_risk)}`,
      `Risk difference: ${format(estimates.risk_difference)}`,
      `Odds ratio: ${format(estimates.odds_ratio)} (95% CI ${format(estimates.odds_ratio_ci_95[0])}–${format(estimates.odds_ratio_ci_95[1])})`,
      "",
      "## Table 1. Baseline characteristics",
      "",
      ...(tableOne ? [
        `| ${tableOne.columns.join(" | ")} |`,
        `| ${tableOne.columns.map(() => "---").join(" | ")} |`,
        ...tableOne.rows.map((row) => `| ${row.join(" | ")} |`),
      ] : ["Table 1 was not generated."]),
      "",
      "## Adjusted sensitivity analysis",
      "",
      ...(adjusted ? [
        `Adjusted exposure odds ratio: ${format(adjusted.exposure_odds_ratio)} (95% CI ${format(adjusted.exposure_odds_ratio_ci_95[0])}–${format(adjusted.exposure_odds_ratio_ci_95[1])})`,
        `Wald p-value: ${format(adjusted.p_value)}`,
        `Covariates: ${adjusted.covariates.join(", ")}`,
      ] : [`Not estimated: ${diagnostics?.adjusted_model_reason ?? "The registered adjusted model was not estimable."}`]),
      "",
      "## Model diagnostics and missing data",
      "",
      `Complete cases: ${diagnostics?.complete_cases ?? "not recorded"}`,
      `Records with missing adjustment variables: ${diagnostics?.missing_records ?? "not recorded"}`,
      `Total outcome events: ${diagnostics?.total_events ?? "not recorded"}`,
      `Events per fitted parameter: ${diagnostics ? format(diagnostics.events_per_parameter) : "not recorded"}`,
      `Adjusted model status: ${diagnostics?.adjusted_model_status ?? "not recorded"}`,
      `Model converged: ${diagnostics?.model_converged === undefined ? "not recorded" : diagnostics.model_converged}`,
      `Maximum variance inflation factor: ${diagnostics?.maximum_vif === undefined ? "not recorded" : format(diagnostics.maximum_vif)}`,
      `Crude OR confidence-interval width ratio: ${diagnostics?.confidence_interval_width_ratio === undefined ? "not recorded" : format(diagnostics.confidence_interval_width_ratio)}`,
      `Sparse-data warning: ${diagnostics?.sparse_data_warning === undefined ? "not recorded" : diagnostics.sparse_data_warning}`,
      "",
      "## Sensitivity analyses",
      "",
      ...(sensitivity?.threshold_results.map((result) =>
        `Threshold > ${format(result.threshold_mmol_l)} mmol/L: OR ${format(result.odds_ratio)} (95% CI ${format(result.odds_ratio_ci_95[0])}–${format(result.odds_ratio_ci_95[1])}); n=${result.exposed}/${result.unexposed}`) ?? ["Threshold sensitivity analysis was not generated."]),
      ...(sensitivity?.continuous_lactate ? [
        `Continuous lactate per 1 mmol/L: adjusted OR ${format(sensitivity.continuous_lactate.odds_ratio_per_mmol_l)} (95% CI ${format(sensitivity.continuous_lactate.odds_ratio_ci_95[0])}–${format(sensitivity.continuous_lactate.odds_ratio_ci_95[1])}); p=${format(sensitivity.continuous_lactate.p_value)}`,
      ] : ["The continuous-lactate sensitivity model was not estimable."]),
      "",
      "## Limitations",
      "",
      ...analysis.warnings.map((warning) => `- ${warning}`),
      "",
      `Artifact integrity: ${artifact.integrity_id}`,
    ].join("\n");
  }

  private predictionReport(artifact: RunArtifact, analysis: PredictionAnalysisResult): string {
    const e = analysis.estimates;
    return [
      `# ${artifact.study.spec.title ?? "24-hour invasive ventilation prediction"}`, "", "## Study design", "",
      `Research question: ${artifact.study.spec.research_question}`, `Population: ${artifact.study.spec.population?.description ?? "not recorded"}`,
      `Outcome: ${artifact.study.spec.outcome?.name ?? "not recorded"}`, "", "## Statistical methods", "",
      "Method rationale: logistic regression was selected because the prespecified outcome is binary and the analysis must return an individual 24-hour event probability. The model is intentionally simple and interpretable for this synthetic workflow check.",
      "Model specification: prespecified admission predictors; complete-case analysis; deterministic 70/30 development-validation split; probability threshold selected by Youden's index in the development set and evaluated once in the validation set.",
      "Required conditions: the outcome must occur after predictor measurement; one eligible record per patient; no predictor may contain post-outcome information; continuous predictors should be approximately linear on the logit scale; severe collinearity should be absent; and the number of outcome events must support the fitted parameters.",
      `Runtime: R ${analysis.runtime.version}`, `Evidence: ${artifact.evidence_level}`, `Run ID: ${artifact.run_id}`, "",
      ...this.statisticalReviewLines(artifact), "## Validation results", "",
      `Total observations: ${analysis.counts.total}`, `Development / validation: ${analysis.counts.development} / ${analysis.counts.validation}`,
      `Validation events: ${analysis.counts.validation_events}`, `AUROC: ${format(e.auroc)}`, `Brier score: ${format(e.brier_score)}`,
      `Calibration intercept / slope: ${format(e.calibration_intercept)} / ${format(e.calibration_slope)}`,
      `Sensitivity / specificity at ${format(e.probability_threshold)}: ${format(e.sensitivity)} / ${format(e.specificity)}`, "", "## Diagnostics", "",
      `Complete cases: ${analysis.diagnostics.complete_cases}`, `Missing records: ${analysis.diagnostics.missing_records}`,
      `Model converged: ${analysis.diagnostics.model_converged}`, `Events per parameter: ${format(analysis.diagnostics.events_per_parameter)}`,
      `Diagnostic interpretation: AUROC assesses discrimination, the Brier score assesses overall probabilistic error, and calibration intercept/slope assess agreement between predicted and observed risk. These measures do not establish clinical utility or external validity.`,
      "", "## Limitations", "",
      ...analysis.warnings.map((warning)=>`- ${warning}`), "", `Artifact integrity: ${artifact.integrity_id}`,
    ].join("\n");
  }

  private treatmentReport(artifact: RunArtifact, analysis: TreatmentEffectAnalysisResult): string {
    const e=analysis.estimates,d=analysis.diagnostics;
    return [
      `# ${artifact.study.spec.title ?? "Early vasopressor treatment effect"}`,"","## Study design","",`Research question: ${artifact.study.spec.research_question}`,
      `Population: ${artifact.study.spec.population?.description ?? "not recorded"}`,`Exposure: ${artifact.study.spec.exposure_or_predictors?.[0]?.name ?? "not recorded"}`,`Outcome: ${artifact.study.spec.outcome?.name ?? "not recorded"}`,"","## Statistical methods","",
      "Method rationale: stabilized inverse-probability-of-treatment weighting was selected to estimate a marginal average treatment effect while balancing prespecified measured baseline confounders between treatment groups.",
      "Model specification: a logistic propensity-score model uses age, sex, SOFA score, and baseline lactate; stabilized weights are truncated at the 1st and 99th percentiles; percentile bootstrap replicates quantify uncertainty.",
      "Required conditions: treatment consistency, no interference, correct temporal ordering of baseline covariates before treatment, conditional exchangeability given measured confounders, positivity, and adequate propensity-model specification. Causal interpretation is not justified if these conditions fail.",
      `Runtime: R ${analysis.runtime.version}`,`Evidence: ${artifact.evidence_level}`,`Run ID: ${artifact.run_id}`,"",
      ...this.statisticalReviewLines(artifact), "## Results","",
      `Total observations: ${analysis.counts.total}`,`Treated / untreated: ${analysis.counts.treated} / ${analysis.counts.untreated}`,
      `Weighted treated / untreated risk: ${format(e.weighted_treated_risk)} / ${format(e.weighted_untreated_risk)}`,
      `Risk difference: ${format(e.risk_difference)} (95% CI ${format(e.risk_difference_ci_95[0])}–${format(e.risk_difference_ci_95[1])})`,`Risk ratio: ${format(e.risk_ratio)}`,"","## Causal diagnostics","",
      `Maximum SMD before / after weighting: ${format(d.maximum_smd_before)} / ${format(d.maximum_smd_after)}`,`Effective sample size: ${format(d.effective_sample_size)}`,
      `Extreme-weight fraction: ${format(d.extreme_weight_fraction)}`,`Propensity model converged: ${d.propensity_model_converged}`,
      "Diagnostic interpretation: covariate balance after weighting is assessed with standardized mean differences; an absolute SMD below 0.10 is used as a practical target. Effective sample size and extreme weights describe precision loss and potential positivity problems.",
      "","## Limitations","",
      ...analysis.warnings.map((warning)=>`- ${warning}`),"",`Artifact integrity: ${artifact.integrity_id}`,
    ].join("\n");
  }
}
