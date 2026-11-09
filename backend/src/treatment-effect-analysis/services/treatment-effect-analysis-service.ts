import { TreatmentEffectAnalysisError,type TreatmentEffectAnalysisResult,type TreatmentEffectExecutionRequest,type TreatmentEffectGateway,type TreatmentEffectStatisticalExecutor } from "../domain/treatment-effect-analysis.js";
export class TreatmentEffectAnalysisService {
  constructor(private readonly gateway:TreatmentEffectGateway,private readonly executor:TreatmentEffectStatisticalExecutor,private readonly capabilityId: string){}
  async execute(request:TreatmentEffectExecutionRequest):Promise<TreatmentEffectAnalysisResult>{
    if(request.preflight.status!=="supported"||request.preflight.capability_id!==this.capabilityId||request.preflight.confirmed_study_integrity_id!==request.study.integrity_id)throw new TreatmentEffectAnalysisError("ANALYSIS_UNSUPPORTED","The confirmed treatment-effect study does not have a matching preflight.");
    let input;try{input=await this.gateway.load();}catch{throw new TreatmentEffectAnalysisError("ANALYSIS_DATA_UNAVAILABLE","Treatment-effect data are unavailable.");}
    try{return await this.executor.execute(input,request.study.integrity_id);}catch(error){if(error instanceof TreatmentEffectAnalysisError)throw error;throw new TreatmentEffectAnalysisError("ANALYSIS_EXECUTION_FAILED","Treatment-effect execution failed.");}
  }
}
