import definition from '../shared/enterprise-fields.json' with {type:'json'};
export type EnterpriseField={id:string;label:string;type:string;required:boolean;options?:string[];maxChoices?:number;exclusive?:string;maxLength?:number};
export type EnterpriseAnswers=Record<string,string|string[]>;
export type EnterpriseSubmission={seq:number;id:string;company:string;contact:string;phone:string;note:string;filename:string;byte_size:number;submitted_at:string;template_version:string;answers:EnterpriseAnswers;fields:EnterpriseField[]};
export const enterpriseFields:EnterpriseField[]=definition.fields;
export const answerText=(value:string|string[]|undefined)=>Array.isArray(value)?value.join('；'):value??'';
export const beijingTime=(date:string)=>new Date(new Date(date).getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ');
export function enterpriseStatistics(rows:EnterpriseSubmission[]){
 const result:{field:string;option:string;count:number}[]=[];
 for(const f of enterpriseFields.filter(f=>f.options)){
  const options=new Set([...(f.options??[]),...rows.flatMap(r=>r.answers[f.id]??[])]);
  for(const option of options)result.push({field:f.label,option,count:rows.filter(r=>{const a=r.answers[f.id];return Array.isArray(a)?a.includes(option):a===option;}).length});
 }
 return result;
}
