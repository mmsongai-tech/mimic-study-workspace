import { PredictionAnalysisError,type PredictionAnalysisResult,type PredictionExecutionRequest,type PredictionGateway,type PredictionStatisticalExecutor } from "../domain/prediction-analysis.js";
export class PredictionAnalysisService {
  constructor(private readonly gateway:PredictionGateway,private readonly executor:PredictionStatisticalExecutor,private readonly capabilityId: string){}
  async execute(request:PredictionExecutionRequest):Promise<PredictionAnalysisResult>{
    if(request.preflight.status!=="supported"||request.preflight.capability_id!==this.capabilityId||request.preflight.confirmed_study_integrity_id!==request.study.integrity_id)throw new PredictionAnalysisError("ANALYSIS_UNSUPPORTED","The confirmed prediction study does not have a matching preflight.");
    let input;try{input=await this.gateway.load();}catch{throw new PredictionAnalysisError("ANALYSIS_DATA_UNAVAILABLE","Prediction data are unavailable.");}
    try{return await this.executor.execute(input,request.study.integrity_id);}catch(error){if(error instanceof PredictionAnalysisError)throw error;throw new PredictionAnalysisError("ANALYSIS_EXECUTION_FAILED","Prediction execution failed.");}
  }
}
