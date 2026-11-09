import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { AssociationAnalysisService, SyntheticLactateMortalityGateway } from "../association-analysis/index.js";
import { PredictionAnalysisService, PublicationSyntheticVentilationGateway, RVentilationPredictionExecutor } from "../prediction-analysis/index.js";
import type { ConfirmedStudySpec } from "../research-design/design-session.js";
import { createInitialResearchPreflightService } from "../research-feasibility/index.js";
import { ReportExportService } from "../report-export/index.js";
import { InMemoryRunEvidenceRepository, RunEvidenceService } from "../run-evidence/index.js";
import { PublicationSyntheticVasopressorGateway, RVasopressorTreatmentEffectExecutor, TreatmentEffectAnalysisService } from "../treatment-effect-analysis/index.js";
import { ResearchWorkflowService } from "./research-workflow-service.js";

const study=(intent:"prediction"|"treatment_effect"):ConfirmedStudySpec=>({schema_version:"1.0.0",session_id:intent,revision:1,confirmed_at:"2026-08-31T00:00:00.000Z",integrity_id:`sha256:${intent}`,spec:intent==="prediction"?{
  schema_version:"1.0.0",intent_family:"prediction",analysis_family:"binary_prediction",title:"Ventilation prediction",research_question:"Predict ventilation",population:{description:"Adults"},index_time:{event:"ICU admission",selection_rule:"First"},exposure_or_predictors:[{name:"Age and respiratory rate and SpO2/FiO2 and Glasgow Coma Scale",role:"predictor",operational_definition:"Admission predictors"}],outcome:{name:"Invasive mechanical ventilation within 24 hours",role:"outcome",operational_definition:"Ventilation start"},time_windows:[{purpose:"outcome",anchor:"index_time",start_offset:0,end_offset:24,unit:"hour"}],estimand:{target_population:"Adults",exposure_contrast:"Predicted probability",outcome_measure:"Ventilation",summary_measure:"AUROC and calibration"}
}:{schema_version:"1.0.0",intent_family:"treatment_effect",analysis_family:"propensity_weighted_treatment_effect",title:"Vasopressor effect",research_question:"Estimate treatment effect",population:{description:"Adults with hypotension"},index_time:{event:"Hypotension",selection_rule:"First"},exposure_or_predictors:[{name:"Early vasopressor initiation",role:"exposure",operational_definition:"Within six hours"}],outcome:{name:"In-hospital mortality",role:"outcome",operational_definition:"Death before discharge"},time_windows:[{purpose:"outcome",anchor:"index_time",start_offset:0,end_offset:1,unit:"month"}],estimand:{target_population:"Adults",exposure_contrast:"Early versus no early vasopressor",outcome_measure:"Mortality",summary_measure:"IPTW risk difference"}}});

test("dispatches prediction and treatment-effect capabilities into immutable evidence",async()=>{
  const runs=new InMemoryRunEvidenceRepository(); const workflow=new ResearchWorkflowService({preflight:createInitialResearchPreflightService(),analysis:new AssociationAnalysisService(new SyntheticLactateMortalityGateway()),prediction:new PredictionAnalysisService(new PublicationSyntheticVentilationGateway(),new RVentilationPredictionExecutor({rscript_binary:"Rscript",script_path:fileURLToPath(new URL("../prediction-analysis/runtimes/r/ventilation_prediction.R",import.meta.url)),timeout_ms:10_000}),"prediction.invasive_ventilation_24h.v1"),treatmentEffect:new TreatmentEffectAnalysisService(new PublicationSyntheticVasopressorGateway(),new RVasopressorTreatmentEffectExecutor({rscript_binary:"Rscript",script_path:fileURLToPath(new URL("../treatment-effect-analysis/runtimes/r/vasopressor_iptw.R",import.meta.url)),timeout_ms:10_000}),"treatment_effect.early_vasopressor.in_hospital_mortality.v1"),evidence:new RunEvidenceService({now:()=>new Date("2026-08-31T00:00:00.000Z")}),runs});
  const concepts=["icu_admission_time","age","sex","respiratory_rate","spo2_fio2_ratio","gcs","invasive_ventilation_start","hypotension_time","vasopressor_start","hospital_discharge_status","sofa","lactate"];
  const prediction=await workflow.execute({study:study("prediction"),data_source:{id:"synthetic",version:"1",data_mode:"synthetic",available_concepts:concepts},threshold_mmol_l:2});
  const treatment=await workflow.execute({study:study("treatment_effect"),data_source:{id:"synthetic",version:"1",data_mode:"synthetic",available_concepts:concepts},threshold_mmol_l:2});
  assert.equal(prediction.artifact.analysis.capability_id,"prediction.invasive_ventilation_24h.v1"); assert.equal(treatment.artifact.analysis.capability_id,"treatment_effect.early_vasopressor.in_hospital_mortality.v1");
  assert.match(prediction.report_markdown,/Method rationale: logistic regression/u);
  assert.match(prediction.report_markdown,/Required conditions:/u);
  assert.match(prediction.report_markdown,/AUROC/u);
  assert.match(treatment.report_markdown,/Method rationale: stabilized inverse-probability/u);
  assert.match(treatment.report_markdown,/conditional exchangeability/u);
  assert.match(treatment.report_markdown,/Maximum SMD/u);
  assert.equal(prediction.artifact.statistical_review?.interpretation_status,"allowed");
  assert.equal(treatment.artifact.statistical_review?.interpretation_status,"allowed");
  assert.match(prediction.report_markdown,/Statistical review/u);
  assert.match(treatment.report_markdown,/Statistical review/u);
  assert.notEqual(prediction.artifact.integrity_id,treatment.artifact.integrity_id);
  const schema=JSON.parse(await readFile(new URL("../../../contracts/research-execution/run-evidence.schema.json",import.meta.url),"utf8")) as object;
  const validate=new Ajv2020({allErrors:true,formats:{"date-time":true}}).compile(schema);
  assert.equal(validate(prediction),true,JSON.stringify(validate.errors)); assert.equal(validate(treatment),true,JSON.stringify(validate.errors));

  // Real document rendering is part of the end-to-end check when the pinned
  // report runtime is explicitly supplied; ordinary Node-only checks remain portable.
  if (!process.env.REPORT_PYTHON) return;
  const exports = new ReportExportService({
    runs,
    python_binary: process.env.REPORT_PYTHON,
    builder_path: fileURLToPath(new URL("../report-export/runtimes/python/build_clinical_report.py", import.meta.url)),
    timeout_ms: 60_000,
  });
  const predictionDocx = await exports.create(prediction.artifact.run_id, "docx", "zh");
  const predictionPdf = await exports.create(prediction.artifact.run_id, "pdf", "zh");
  const treatmentDocx = await exports.create(treatment.artifact.run_id, "docx", "zh");
  const treatmentPdf = await exports.create(treatment.artifact.run_id, "pdf", "en");
  assert.equal(predictionDocx.content.subarray(0, 2).toString("ascii"), "PK");
  assert.equal(predictionPdf.content.subarray(0, 4).toString("ascii"), "%PDF");
  assert.equal(treatmentDocx.content.subarray(0, 2).toString("ascii"), "PK");
  assert.equal(treatmentPdf.content.subarray(0, 4).toString("ascii"), "%PDF");
  assert.ok(predictionDocx.content.length > 10_000);
  assert.ok(predictionPdf.content.length > 10_000);
  assert.ok(treatmentDocx.content.length > 10_000);
  assert.ok(treatmentPdf.content.length > 10_000);
  if (process.env.REPORT_OUTPUT_DIR) {
    await mkdir(process.env.REPORT_OUTPUT_DIR, { recursive: true });
    await Promise.all([
      writeFile(join(process.env.REPORT_OUTPUT_DIR, "prediction-report-zh.docx"), predictionDocx.content),
      writeFile(join(process.env.REPORT_OUTPUT_DIR, "prediction-report-zh.pdf"), predictionPdf.content),
      writeFile(join(process.env.REPORT_OUTPUT_DIR, "treatment-report-zh.docx"), treatmentDocx.content),
      writeFile(join(process.env.REPORT_OUTPUT_DIR, "treatment-report-en.pdf"), treatmentPdf.content),
    ]);
  }
});
