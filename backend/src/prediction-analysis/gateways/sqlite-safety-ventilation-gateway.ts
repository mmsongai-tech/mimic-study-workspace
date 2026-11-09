import { DatabaseSync } from "node:sqlite";
import { PredictionAnalysisError,type PredictionGateway,type PredictionInput,type VentilationPredictionRecord } from "../domain/prediction-analysis.js";

export interface VentilationSafetyFieldMapping { table:string; subject_id:string; age:string; respiratory_rate:string; spo2_fio2_ratio:string; gcs:string; invasive_ventilation_24h:string }
const safeIdentifier=/^[A-Za-z_][A-Za-z0-9_]*$/u;
const quote=(value:string,name:string):string=>{if(!safeIdentifier.test(value))throw new PredictionAnalysisError("ANALYSIS_INPUT_INVALID",`${name} is not a safe SQLite identifier.`);return `"${value}"`;};

export class SqliteSafetyVentilationGateway implements PredictionGateway {
  constructor(private readonly settings:{database_path:string;data_source_id:string;data_source_version:string;mapping:VentilationSafetyFieldMapping;now?:()=>Date}){}
  async load():Promise<PredictionInput>{
    const m=this.settings.mapping; const table=quote(m.table,"table");
    const fields={subject:quote(m.subject_id,"subject_id"),age:quote(m.age,"age"),rr:quote(m.respiratory_rate,"respiratory_rate"),ratio:quote(m.spo2_fio2_ratio,"spo2_fio2_ratio"),gcs:quote(m.gcs,"gcs"),outcome:quote(m.invasive_ventilation_24h,"invasive_ventilation_24h")};
    let database:DatabaseSync|undefined;
    try{database=new DatabaseSync(this.settings.database_path,{readOnly:true});database.exec("PRAGMA query_only = ON");
      const rows=database.prepare(`SELECT ${fields.subject} AS subject_id, ${fields.age} AS age, ${fields.rr} AS rr, ${fields.ratio} AS ratio, ${fields.gcs} AS gcs, ${fields.outcome} AS outcome FROM ${table}`).all() as Array<Record<string,unknown>>;
      if(!rows.length)throw new Error("No eligible rows were returned.");
      return{records:rows.map((row,index)=>this.mapRow(row,index)),provenance:{data_source_id:this.settings.data_source_id,data_source_version:this.settings.data_source_version,data_mode:"approved_safety_database",retrieved_at:(this.settings.now?.()??new Date()).toISOString()}};
    }catch(error){if(error instanceof PredictionAnalysisError)throw error;throw new PredictionAnalysisError("ANALYSIS_DATA_UNAVAILABLE","The approved prediction database could not be read.");}finally{database?.close();}
  }
  private mapRow(row:Record<string,unknown>,index:number):VentilationPredictionRecord{
    const subject=row.subject_id,age=row.age,rr=row.rr,ratio=row.ratio,gcs=row.gcs,outcome=row.outcome;
    if((typeof subject!=="string"&&typeof subject!=="number")||typeof age!=="number"||age<18||age>120||typeof rr!=="number"||rr<=0||rr>100||typeof ratio!=="number"||ratio<=0||ratio>1000||typeof gcs!=="number"||gcs<3||gcs>15||(outcome!==0&&outcome!==1&&outcome!==false&&outcome!==true))throw new PredictionAnalysisError("ANALYSIS_INPUT_INVALID",`Approved prediction row ${index+1} is invalid.`);
    return{synthetic_subject_id:String(subject),age_years:age,respiratory_rate:rr,spo2_fio2_ratio:ratio,gcs,invasive_ventilation_24h:outcome===1||outcome===true};
  }
}
