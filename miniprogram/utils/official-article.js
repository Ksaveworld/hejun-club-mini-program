// URL/URLSearchParams are not guaranteed in the mini-program runtime.
function safeDecoded(value) {
  let current = value;
  for (let index = 0; index < 4; index++) {
    if (/[\x00-\x20\x7f-\x9f\\]/.test(current)
      || /(?:https?:)?\/\/|(?:javascript|data):/i.test(current)) return null;
    let next;
    try { next = decodeURIComponent(current); } catch (error) { return null; }
    if (next === current) return current;
    current = next;
  }
  return null;
}
function normalizeOfficialArticleUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096
    || /[\x00-\x20\x7f-\x9f\\]/.test(value)) return null;
  const match = /^https:\/\/mp\.weixin\.qq\.com(?::443)?(\/s(?:\/[a-zA-Z0-9_-]{1,200})?)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
  if (!match || !/^\/s(?:\/[a-zA-Z0-9_-]{1,200})?$/.test(match[1])
    || ![undefined, '', 'rd', 'wechat_redirect'].includes(match[3])) return null;
  for (const part of (match[2] || '').split('&')) {
    if (!part) continue;
    const equal = part.indexOf('='), name = equal < 0 ? part : part.slice(0, equal);
    let key, data;
    try {
      key = decodeURIComponent(name.replace(/\+/g, ' '));
      data = decodeURIComponent((equal < 0 ? '' : part.slice(equal + 1)).replace(/\+/g, ' '));
    } catch (error) { return null; }
    key = safeDecoded(key); data = safeDecoded(data);
    if (key === null || data === null || ['temp_url', 'url', 'redirect', 'redirect_url', 'redirect_uri',
      'target', 'next', 'continue', 'return', 'return_url', 'destination', 'link'].includes(key.toLowerCase())) return null;
  }
  return value.replace(/^https:\/\/mp\.weixin\.qq\.com(?::443)?/i, 'https://mp.weixin.qq.com');
}
function isOfficialArticleUrl(value) { return normalizeOfficialArticleUrl(value) !== null; }
function openOfficialArticle({ platform, url, isCurrent, onFailure }) {
  if (!isOfficialArticleUrl(url)) return 'invalid';
  if (!isCurrent()) return 'stale';
  const fail = reason => { if (isCurrent()) onFailure(reason); };
  let supported = typeof platform.openOfficialAccountArticle === 'function';
  try {
    if (supported && typeof platform.canIUse === 'function') supported = platform.canIUse('openOfficialAccountArticle');
  } catch (error) { supported = false; }
  if (!isCurrent()) return 'stale';
  if (!supported) { fail('unsupported'); return 'unsupported'; }
  // Stay synchronous inside the user's tap; do not request data first or
  // silently navigate to a web-view or another mini-program.
  try {
    platform.openOfficialAccountArticle({ url, fail: () => fail('failed') });
    return 'opened';
  } catch (error) { fail('failed'); return 'failed'; }
}
module.exports = { isOfficialArticleUrl, normalizeOfficialArticleUrl, openOfficialArticle };
