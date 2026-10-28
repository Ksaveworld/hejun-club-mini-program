// Device-local drafts are scoped to a verified member and API environment.
// They expire after a day and are removed on explicit logout.
const lifetime = 24 * 60 * 60 * 1000;
const key = scope => 'club-native-drafts:' + scope;
function readResult(scope, owner, slot) {
  if (!scope || !owner || !slot) return {status: 'missing', value: null};
  try {
    const record = wx.getStorageSync(key(scope));
    if (!record || record.owner !== owner) return {status: 'missing', value: null};
    const entry = record.entries && record.entries[slot];
    if (!entry) return {status: 'missing', value: null};
    if (!Number.isFinite(entry.at) || entry.at > Date.now() || Date.now() - entry.at >= lifetime) {
      return {status: write(scope, owner, slot, null) ? 'expired' : 'failed', value: null};
    }
    return {status: 'saved', at: entry.at, value: JSON.parse(JSON.stringify(entry.value))};
  } catch (error) { return {status: 'failed', value: null}; }
}
function read(scope, owner, slot) { return readResult(scope, owner, slot).value; }
function write(scope, owner, slot, value) {
  if (!scope || !owner || !slot) return false;
  try {
    const previous = wx.getStorageSync(key(scope));
    const entries = previous && previous.owner === owner ? JSON.parse(JSON.stringify(previous.entries || {})) : {};
    const now = Date.now();
    for (const name of Object.keys(entries)) if (!Number.isFinite(entries[name].at) || entries[name].at > now || now - entries[name].at >= lifetime) delete entries[name];
    if (value === null) delete entries[slot];
    else entries[slot] = { at: now, value: JSON.parse(JSON.stringify(value)) };
    const ordered = Object.keys(entries).sort((a,b) => entries[b].at - entries[a].at);
    for (const name of ordered.slice(12)) delete entries[name];
    wx.setStorageSync(key(scope), { owner, entries });
    return true;
  } catch (error) { return false; }
}
module.exports = { read, readResult, write, lifetime };
