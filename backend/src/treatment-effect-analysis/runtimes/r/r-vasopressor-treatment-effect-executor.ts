import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TreatmentEffectAnalysisResult, TreatmentEffectInput, TreatmentEffectStatisticalExecutor } from "../../domain/treatment-effect-analysis.js";

const executeFile = promisify(execFile);
const parse = (value: string) => new Map(value.trim().split("\n").map((line) => { const at=line.indexOf("\t"); if(at<1) throw new Error("Malformed R output"); return [line.slice(0,at),line.slice(at+1)]; }));
const number = (values: Map<string,string>, key:string) => { const value=Number(values.get(key)); if(!Number.isFinite(value)) throw new Error(`Missing ${key}`); return value; };

export class RVasopressorTreatmentEffectExecutor implements TreatmentEffectStatisticalExecutor {
  constructor(private readonly options:{rscript_binary:string;script_path:string;timeout_ms:number;temporary_root?:string}) {}
  async execute(input:TreatmentEffectInput, studyIntegrityId:string):Promise<TreatmentEffectAnalysisResult>{
    const directory=await mkdtemp(join(this.options.temporary_root??tmpdir(),"mimic-r-treatment-"));
    try{
      const inputPath=join(directory,"input.csv"), outputPath=join(directory,"output.tsv"), balancePath=join(directory,"balance.svg"), effectsPath=join(directory,"effects.svg");
      const rows=input.records.map((r)=>[r.synthetic_subject_id,Number(r.early_vasopressor),Number(r.in_hospital_death),r.age_years,r.sofa_score,r.baseline_lactate,r.sex].join(","));
      await writeFile(inputPath,["subject_id,treated,outcome,age_years,sofa_score,baseline_lactate,sex",...rows].join("\n"),{mode:0o600});
      await executeFile(this.options.rscript_binary,["--vanilla",this.options.script_path,inputPath,outputPath,balancePath,effectsPath],{timeout:this.options.timeout_ms,maxBuffer:1_000_000});
      const [raw,balance,effects]=await Promise.all([readFile(outputPath,"utf8"),readFile(balancePath,"utf8"),readFile(effectsPath,"utf8")]); const values=parse(raw);
      return {
        capability_id:"treatment_effect.early_vasopressor.in_hospital_mortality.v1",analysis_kind:"propensity_weighted_treatment_effect",study_integrity_id:studyIntegrityId,
        counts:{total:number(values,"total"),treated:number(values,"treated"),untreated:number(values,"untreated"),treated_events:number(values,"treated_events"),untreated_events:number(values,"untreated_events")},
        estimates:{weighted_treated_risk:number(values,"risk_treated"),weighted_untreated_risk:number(values,"risk_untreated"),risk_difference:number(values,"risk_difference"),risk_ratio:number(values,"risk_ratio"),risk_difference_ci_95:[number(values,"ci_lower"),number(values,"ci_upper")]},
        diagnostics:{complete_cases:number(values,"total"),missing_records:number(values,"missing_records"),propensity_model_converged:number(values,"converged")===1,maximum_smd_before:number(values,"max_smd_before"),maximum_smd_after:number(values,"max_smd_after"),effective_sample_size:number(values,"effective_sample_size"),extreme_weight_fraction:number(values,"extreme_weight_fraction"),bootstrap_replicates:number(values,"bootstrap_replicates")},
        method:{id:"iptw_average_treatment_effect",version:"1.0.0",weight_strategy:"stabilized_truncated_1_99",uncertainty:"percentile_bootstrap"},runtime:{language:"r",version:values.get("r_version")??"unknown"},
        publication_outputs:{figures:[{id:"covariate_balance",title:"Covariate balance before and after IPTW",mime_type:"image/svg+xml",content:balance},{id:"weighted_risks",title:"IPTW-weighted mortality risks",mime_type:"image/svg+xml",content:effects}],tables:[{id:"balance_table",title:"Covariate balance",columns:["Covariate","Before IPTW","After IPTW"],rows:["Age","SOFA","Lactate","Female"].map((name,index)=>[name,(values.get("smd_before")??"").split(",")[index]??"—",(values.get("smd_after")??"").split(",")[index]??"—"])}]},
        provenance:input.provenance,warnings:["Synthetic IPTW estimate only; unmeasured confounding is not addressed.","This result is not a clinical treatment recommendation."],
      };
    }finally{await rm(directory,{recursive:true,force:true});}
  }
}
