const maxFileBytes = 5 * 1024 * 1024;
const basics = [['company', '企业名称', 160, true], ['contact', '联系人', 80, true], ['phone', '联系电话', 30, true], ['note', '补交或其他说明', 1000, false]];
function textError(value, label, max, required) {
  if (typeof value !== 'string') return label + '格式不正确';
  if (required && !value.trim()) return '请填写' + label;
  if (value.trim().length > max) return label + '最多填写' + max + '字';
  return '';
}
function fieldError(id, data, config) {
  const basic = basics.find(item => item[0] === id);
  if (basic) {
    const error = textError(data[id], basic[1], basic[2], basic[3]);
    if (error) return error;
    if (id === 'phone' && (!/^\+?[0-9 ()-]{6,30}$/.test(data.phone.trim()) || data.phone.replace(/\D/g, '').length < 6)) return '请填写有效联系电话（至少6位数字，可含+、空格、括号或横线）';
    return '';
  }
  const field = config.fields.find(item => item.id === id);
  if (!field) return '';
  const value = data.answers[id];
  if (field.type === 'multi') {
    if (!Array.isArray(value) || (field.required && !value.length)) return '请选择' + field.label;
    if (value.length > field.maxChoices) return field.label + '最多选择' + field.maxChoices + '项';
    if (new Set(value).size !== value.length || value.some(item => !field.options.includes(item))) return '请重新选择' + field.label;
    if (value.includes(field.exclusive) && value.length !== 1) return field.label + '的待定选项不可与其他项同时选择';
    return '';
  }
  if (field.type === 'single') return field.options.includes(value) ? '' : '请选择' + field.label;
  return textError(value ?? '', field.label, field.maxLength, field.required);
}
function validate(data, config, file) {
  const errors = {};
  for (const id of [...basics.map(item => item[0]).filter(id => id !== 'note'), ...config.fields.map(field => field.id), 'note']) {
    const error = fieldError(id, data, config); if (error) errors[id] = error;
  }
  if (!file) errors.file = '请选择填写完成的Word或PDF文件';
  if (!data.legalReady) errors.policy = '请先读取当前协议后再提交';
  else if (data.legal) {
    if (!data.policy) errors.policy = '请阅读并同意会员服务协议和隐私政策';
    if (data.legal.requireHongKongConsent !== false && !data.hongKong) errors.hongKong = '请单独确认香港服务器存储和处理安排';
  }
  if (!data.consent) errors.consent = '请确认信息用途与上传授权';
  return errors;
}
function fileError(file) {
  if (!file) return '没有选中文件，请从微信聊天重新选择';
  if (typeof file.name !== 'string' || !/\.(docx|pdf)$/i.test(file.name) || /[\\/\x00-\x1f\x7f]/.test(file.name) || file.name.trim().length > 160) return '仅支持文件名有效的Word（.docx）或PDF（.pdf）文件';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return '文件为空或大小无法读取，请另存后重新选择';
  if (file.size > maxFileBytes) return '文件超过5MB，请在Word或WPS中压缩文件，或选择较小的Word/PDF重新上传。';
  if (typeof file.path !== 'string' || !file.path) return '文件读取路径无效，请重新选择材料';
  return '';
}
// Both persistence and restoration pass through this allowlist. Never copy a
// page, payload, attachment, authorization or session object into storage.
function draftValue(data, config) {
  const value = {templateVersion: config.templateVersion, answers: {}};
  const answers = data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers) ? data.answers : {};
  for (const [id, , max] of basics) value[id] = typeof data[id] === 'string' ? data[id].slice(0, max) : '';
  for (const field of config.fields) {
    const answer = answers[field.id];
    if (field.type === 'multi') value.answers[field.id] = Array.isArray(answer) ? field.options.filter(item => answer.includes(item)).slice(0, field.maxChoices) : [];
    else if (field.type === 'single') value.answers[field.id] = field.options.includes(answer) ? answer : '';
    else value.answers[field.id] = typeof answer === 'string' ? answer.slice(0, field.maxLength) : '';
  }
  return value;
}
function hasText(value) { return basics.some(([id]) => value[id]?.trim()) || Object.values(value.answers).some(answer => Array.isArray(answer) ? answer.length : answer.trim()); }
module.exports = {fieldError, validate, fileError, draftValue, hasText, maxFileBytes};
