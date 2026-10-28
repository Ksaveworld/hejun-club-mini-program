const { normalizeOfficialArticleUrl } = require('./official-article');
const contractVersion = 'directory-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function utcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function normalizeEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !uuid.test(input.id)
    || !['enterprise', 'product'].includes(input.kind)
    || typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name.trim()).length > 120
    || typeof input.summary !== 'string' || Array.from(input.summary.trim()).length > 300
    || /[\x00-\x1f\x7f-\x9f]/.test(input.name + input.summary)
    || !normalizeOfficialArticleUrl(input.articleUrl) || !Number.isSafeInteger(input.revision) || input.revision < 1
    || !utcTimestamp(input.publishedAt)) throw new Error('名录数据返回不正确，请稍后重试。');
  return { id: input.id.toLowerCase(), kind: input.kind, name: input.name.trim(), summary: input.summary.trim(),
    articleUrl: normalizeOfficialArticleUrl(input.articleUrl), revision: input.revision, publishedAt: input.publishedAt };
}
function readDirectory(result) {
  if (!result || result.contractVersion !== contractVersion || typeof result.configured !== 'boolean'
    || !Array.isArray(result.entries) || (!result.configured && result.entries.length)) {
    throw new Error('名录数据返回不正确，请稍后重试。');
  }
  const entries = result.entries.map(normalizeEntry), ids = new Set(entries.map(entry => entry.id.toLowerCase()));
  if (ids.size !== entries.length) throw new Error('名录数据返回不正确，请稍后重试。');
  return { configured: result.configured, entries };
}
function searchDirectory(entries, query) {
  const keyword = query.trim().toLowerCase();
  return entries.filter(entry => (entry.name + ' ' + entry.summary).toLowerCase().includes(keyword));
}
module.exports = { contractVersion, normalizeEntry, readDirectory, searchDirectory };
