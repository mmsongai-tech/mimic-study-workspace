import { useLang } from "@/hooks/use-lang";
import { formatCount } from "@/lib/utils";
import { Explain } from "@/components/detail/explain";
import type { PlanOutcome } from "@/lib/api-types";

// The order the extractor applies the steps (backend study-report/patient-flow.ts FLOW_STEP_KEYS); the model's own
// complete-case exclusion comes after the cohort.
const REASON_KEYS = ["no_time_zero", "ended_before_landmark", "outcome_before_landmark", "outcome_before_prediction_time", "not_in_population", "not_first_eligible_unit_of_patient", "incomplete_required_variables"] as const;

export function FlowPanel({ plan }: { plan: PlanOutcome }) {
  const { t } = useLang();
  const cohort = plan.cohort;
  if (!cohort) return <p className="text-sm text-muted-foreground">–</p>;

  let remaining = cohort.analysis_units;
  const steps = REASON_KEYS.filter((key) => cohort.exclusion_reasons?.[key]).map((key) => {
    remaining -= cohort.exclusion_reasons![key];
    return { key, count: cohort.exclusion_reasons![key], remaining: Math.max(remaining, 0) };
  });
  const modelRemoved = cohort.exclusion_reasons?.incomplete_model_variables ?? 0;
  const modelDiffers = plan.result?.status === "completed" && plan.result.n_analysed !== cohort.rows;
  // A prediction has predictors, not an exposure and adjustment variables (the report words these steps the same way).
  // An ICU question's analysis unit is the ICU stay, not the admission.
  const predicting = plan.chosen_method?.startsWith("prediction.");
  const icu = plan.study_spec.index_time?.event === "ICU admission";
  const reasons = { ...t.reasons, ...(predicting ? t.predictionReasons : {}), ...(icu ? t.icuReasons : {}), ...(icu && predicting ? t.icuPredictionReasons : {}) };

  return (
    <div className="space-y-2">
      <Explain id="patient_flow" />
      <div className="flex flex-wrap items-center gap-2">
      <FlowBox label={t.flowAssessed} value={cohort.analysis_units} />
      {steps.map((step) => (
        <div key={step.key} className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            − {t.excluded}: {reasons[step.key]} <b className="text-foreground">{formatCount(step.count)}</b>
          </span>
          <FlowBox label={t.remaining} value={step.remaining} />
        </div>
      ))}
      <FlowBox label={t.flowCohort} value={cohort.rows} strong />
      {modelRemoved > 0 && (
        <span className="text-sm text-muted-foreground">
          − {t.excluded}: {reasons.incomplete_model_variables} <b className="text-foreground">{formatCount(modelRemoved)}</b>
        </span>
      )}
      {modelDiffers && <FlowBox label={t.flowModel} value={plan.result!.n_analysed} strong />}
      </div>
    </div>
  );
}

function FlowBox({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${strong ? "border-primary/30 bg-primary/5 font-medium" : "bg-muted/30"}`}>
      {label}: {formatCount(value)}
    </div>
  );
}
