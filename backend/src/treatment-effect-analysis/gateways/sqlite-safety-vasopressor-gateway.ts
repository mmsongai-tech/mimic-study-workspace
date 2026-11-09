import { DatabaseSync } from "node:sqlite";
import { TreatmentEffectAnalysisError,type TreatmentEffectGateway,type TreatmentEffectInput,type VasopressorTreatmentRecord } from "../domain/treatment-effect-analysis.js";

export interface VasopressorSafetyFieldMapping { table:string; subject_id:string; early_vasopressor:string; in_hospital_death:string; age:string; sex:string; sofa:string; lactate:string }
const safeIdentifier=/^[A-Za-z_][A-Za-z0-9_]*$/u;
const quote=(value:string,name:string):string=>{if(!safeIdentifier.test(value))throw new TreatmentEffectAnalysisError("ANALYSIS_INPUT_INVALID",`${name} is not a safe SQLite identifier.`);return `"${value}"`;};

export class SqliteSafetyVasopressorGateway implements TreatmentEffectGateway {
  constructor(private readonly settings:{database_path:string;data_source_id:string;data_source_version:string;mapping:VasopressorSafetyFieldMapping;now?:()=>Date}){}
  async load():Promise<TreatmentEffectInput>{
    const m=this.settings.mapping,table=quote(m.table,"table");const fields={subject:quote(m.subject_id,"subject_id"),treated:quote(m.early_vasopressor,"early_vasopressor"),death:quote(m.in_hospital_death,"in_hospital_death"),age:quote(m.age,"age"),sex:quote(m.sex,"sex"),sofa:quote(m.sofa,"sofa"),lactate:quote(m.lactate,"lactate")};let database:DatabaseSync|undefined;
    try{database=new DatabaseSync(this.settings.database_path,{readOnly:true});database.exec("PRAGMA query_only = ON");const rows=database.prepare(`SELECT ${fields.subject} AS subject_id, ${fields.treated} AS treated, ${fields.death} AS death, ${fields.age} AS age, ${fields.sex} AS sex, ${fields.sofa} AS sofa, ${fields.lactate} AS lactate FROM ${table}`).all() as Array<Record<string,unknown>>;if(!rows.length)throw new Error("No eligible rows were returned.");return{records:rows.map((row,index)=>this.mapRow(row,index)),provenance:{data_source_id:this.settings.data_source_id,data_source_version:this.settings.data_source_version,data_mode:"approved_safety_database",retrieved_at:(this.settings.now?.()??new Date()).toISOString()}};
    }catch(error){if(error instanceof TreatmentEffectAnalysisError)throw error;throw new TreatmentEffectAnalysisError("ANALYSIS_DATA_UNAVAILABLE","The approved treatment-effect database could not be read.");}finally{database?.close();}
  }
  private mapRow(row:Record<string,unknown>,index:number):VasopressorTreatmentRecord{
    const subject=row.subject_id,treated=row.treated,death=row.death,age=row.age,sofa=row.sofa,lactate=row.lactate,sex=typeof row.sex==="string"?row.sex.trim().toLowerCase():row.sex;
    if((typeof subject!=="string"&&typeof subject!=="number")||(treated!==0&&treated!==1&&treated!==false&&treated!==true)||(death!==0&&death!==1&&death!==false&&death!==true)||typeof age!=="number"||age<18||age>120||typeof sofa!=="number"||sofa<0||sofa>24||typeof lactate!=="number"||lactate<0||lactate>50||(sex!=="female"&&sex!=="male"))throw new TreatmentEffectAnalysisError("ANALYSIS_INPUT_INVALID",`Approved treatment-effect row ${index+1} is invalid.`);
    return{synthetic_subject_id:String(subject),early_vasopressor:treated===1||treated===true,in_hospital_death:death===1||death===true,age_years:age,sofa_score:sofa,baseline_lactate:lactate,sex};
  }
}
