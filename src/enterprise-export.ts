import ExcelJS from 'exceljs';
import {enterpriseFields,enterpriseStatistics,answerText,beijingTime,type EnterpriseSubmission} from './enterprise-data.ts';

export async function buildEnterpriseList(rows:EnterpriseSubmission[]){
 const w=new ExcelJS.Workbook();const s=w.addWorksheet('企业需求明细');
 const fields=[...enterpriseFields];
 for(const row of rows)for(const f of row.fields)if(!fields.some(x=>x.id===f.id))fields.push(f);
 s.columns=['企业名称','联系人','联系电话',...fields.map(f=>f.label),'文件名','提交时间（北京时间）','回执编号','补交或其他说明','文件大小（字节）','表单版本'].map(header=>({header,width:header==='核心产品或服务'||header==='最希望优先解决的问题及其他说明'?55:30}));
 rows.forEach(r=>s.addRow([r.company,r.contact,r.phone,...fields.map(f=>answerText(r.answers[f.id])),r.filename,beijingTime(r.submitted_at),r.id,r.note,r.byte_size,r.template_version]));
 s.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,s.rowCount),column:s.columnCount}};
 const stats=w.addWorksheet('分类汇总');stats.columns=[{header:'统计维度',width:40},{header:'分类',width:55},{header:'提交份数',width:20}];
 stats.addRow(['总计','提交份数（包含独立修订记录）',rows.length]);
 for(const r of enterpriseStatistics(rows))stats.addRow([r.field,r.option,r.count]);
 const reading=w.addWorksheet('逐份阅读');reading.columns=[{header:'回执编号',width:40},{header:'企业名称',width:36},{header:'字段',width:40},{header:'内容',width:80}];
 for(const r of rows){for(const [label,value] of [['联系人',r.contact],['联系电话',r.phone],...r.fields.map(f=>[f.label,answerText(r.answers[f.id])]),['附件文件名',r.filename],['提交时间（北京时间）',beijingTime(r.submitted_at)],['补交或其他说明',r.note],['表单版本',r.template_version]])reading.addRow([r.id,r.company,label,value]);}
 const notes=w.addWorksheet('说明');notes.columns=[{header:'项目',width:28},{header:'说明',width:100}];notes.addRows([
  ['统计来源','企业自行填写的网页关键字段。Word/PDF内部的其他答案没有自动识别或计入统计。'],
  ['统计口径','按本次导出的提交记录计数，不等于去重企业数量。多选项分别计数，分类之和可能大于提交份数。'],
  ['修订版本','每次新提交保留独立回执，修订不会覆盖原记录。正式业务统计前请根据回执与说明确认采用哪一版，系统不按同名企业自动合并。'],
  ['完整材料','附件通过后台受保护的下载入口查看，Excel不嵌入附件。可按回执编号核对。'],
  ['空白项','仅选填字段允许空白；空白不代表“无需求”。'],
  ['其他类别','选择“其他”的具体细节请结合问题说明与附件核对。'],
  ['隐私','含企业联系资料，仅供获授权的工作人员使用。']]);
 for(const sheet of w.worksheets){sheet.views=[{state:'frozen',ySplit:1}];sheet.eachRow((r,i)=>{r.height=i===1?45:60;r.eachCell(c=>{c.font={name:'Microsoft YaHei',size:11};c.alignment={wrapText:true,vertical:'top'};if(typeof c.value==='string')c.numFmt='@';});});sheet.getRow(1).eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF164B3F'}};c.font={bold:true,color:{argb:'FFFFFFFF'}};});}
 return w.xlsx.writeBuffer();
}
