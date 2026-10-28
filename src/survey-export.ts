import ExcelJS from 'exceljs';

export type SurveyRecord = { seq: number; id: string; survey_id: string; version: string; submitted_at: string; answers: Record<string, string | string[]> };
export type SurveySchema = { version: string; title: string; fields: { id: string; number: number; label: string; options: string[] }[] };
const names: Record<string, string> = { 'general-demand':'通用采购需求', 'general-supply':'通用产品服务', salon: '沙龙参会反馈', demand: 'AI需求端', supply: 'AI供给端', singapore: '新加坡路演' };
const display = (value: string | string[] | undefined) => Array.isArray(value) ? value.join('；') : value ?? '';
const flagged = (r: SurveyRecord) => /部署验证|非真实/.test(JSON.stringify(r.answers));
const beijing = (s: string) => new Date(new Date(s).getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');

// Explicit string cell values keep phone numbers, line breaks and formula-like answers as text.
export async function buildSurveyWorkbook(input: SurveyRecord[], schemas: Record<string, SurveySchema>, selected = '') {
  const unique = new Map<string, SurveyRecord>();
  for (const r of input) {
    const prior = unique.get(r.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(r)) throw new Error('同一回执的数据不一致，请重新导出');
    unique.set(r.id, r);
  }
  const records = [...unique.values()].sort((a, b) => a.seq - b.seq);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '跨境企业家俱乐部';
  function sheet(name: string, headers: string[], rows: (string | number)[][], widths?: number[]) {
    const ws = workbook.addWorksheet(name);
    ws.columns = headers.map((header, i) => ({ header, width: widths?.[i] ?? 36 }));
    ws.addRows(rows);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: headers.length } };
    ws.eachRow((row, n) => {
      let lines = 1;
      row.eachCell((cell, column) => {
        const width = widths?.[column - 1] ?? 36;
        const count = String(cell.value ?? '').split('\n').reduce((total, text) => total + Math.max(1, Math.ceil([...text].reduce((size, char) => size + (char.charCodeAt(0) > 255 ? 2 : 1), 0) / Math.max(8, width - 2))), 0);
        lines = Math.max(lines, count);
      });
      row.height = Math.min(409, Math.max(n === 1 ? 60 : 48, lines * 16 + 8));
      row.eachCell(cell => { cell.font = { name: 'Microsoft YaHei', size: 11 }; cell.alignment = { vertical: 'top', wrapText: true }; if (typeof cell.value === 'string') cell.numFmt = '@'; });
    });
    ws.getRow(1).eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF164B3F' } }; cell.font = { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }; });
    return ws;
  }
  sheet('导出说明', ['项目', '说明'], [
    ['导出时间（北京时间）', beijing(new Date().toISOString())],
    ['导出范围', names[selected] || '全部问卷'], ['独立回执数', records.length],
    ['含测试标记的记录数', records.filter(flagged).length],
    ['数据性质', '保留全部记录；“含测试标记”仅按答案中的“部署验证/非真实”识别，其余记录仍需业务核实。'],
    ['阅读方式', '“逐份阅读”按回执编号筛选，一行一个问题；各“明细”表一行一份问卷，可按列筛选。'],
    ['完整性', '多选答案用中文分号分隔；补充说明独立列；未填写保持空白；手机号按文本保存。'],
    ['题目版本', '仅在问卷版本一致时对应中文题目。版本不一致或未知字段保留原题号和原答案，不猜测、不丢弃。'],
    ['数据使用', '此文件为导出时的快照，不自动同步。含联系信息，请仅交给获授权的活动办理人员。'],
  ], [30, 100]);
  const reading: (string | number)[][] = [];
  const types = selected ? [selected] : [...new Set([...Object.keys(schemas), ...records.map(r => r.survey_id)])];
  for (const type of types) {
    const versions = [...new Set(records.filter(r => r.survey_id === type).map(r => r.version))];
    if (!versions.length) versions.push(schemas[type]?.version || '未知');
    versions.forEach((version, vi) => {
      const schema = schemas[type]?.version === version ? schemas[type] : undefined;
      const group = records.filter(r => r.survey_id === type && r.version === version);
      const keys = new Set<string>();
      for (const f of schema?.fields || []) { keys.add(f.id); if (f.options.length) keys.add(f.id + 'Note'); }
      group.forEach(r => Object.keys(r.answers).forEach(key => keys.add(key)));
      const label = (key: string) => {
        const isNote = key.endsWith('Note');
        const f = schema?.fields.find(f => f.id === (isNote ? key.slice(0, -4) : key));
        return f ? `${f.number}. ${f.label}${isNote ? '【补充说明】' : ''}` : `原始字段 ${key}（未匹配题目版本）`;
      };
      const rows = group.map(r => {
        const nature = flagged(r) ? '含测试标记' : '未标记为测试（待核实）';
        for (const key of keys) reading.push([r.id, names[type] || type, version, nature, beijing(r.submitted_at), label(key), display(r.answers[key])]);
        return [r.seq, r.id, version, nature, beijing(r.submitted_at), ...[...keys].map(k => display(r.answers[k]))];
      });
      sheet(`${names[type] || '其他问卷'}明细${vi ? vi + 1 : ''}`, ['编号', '回执编号', '问卷版本', '数据标记', '提交时间（北京时间）', ...[...keys].map(label)], rows, [10, 40, 22, 28, 25]);
    });
  }
  sheet('逐份阅读', ['回执编号', '问卷类型', '问卷版本', '数据标记', '提交时间（北京时间）', '问题', '回答'], reading, [40, 20, 22, 28, 25, 55, 80]);
  return workbook.xlsx.writeBuffer();
}
