// Device-local drafts are scoped to a verified member and API environment.
// They expire after a day and are removed on explicit logout.
const lifetime = 24 * 60 * 60 * 1000;
const key = scope => 'club-native-drafts:' + scope;
function read(scope, owner, slot) {
  try {
    const record = wx.getStorageSync(key(scope));
    if (!record || record.owner !== owner) return null;
    const entry = record.entries && record.entries[slot];
    if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > lifetime) return null;
    return JSON.parse(JSON.stringify(entry.value));
  } catch (error) { return null; }
}
function write(scope, owner, slot, value) {
  if (!scope || !owner || !slot) return false;
  try {
    const previous = wx.getStorageSync(key(scope));
    const entries = previous && previous.owner === owner ? previous.entries || {} : {};
    const now = Date.now();
    for (const name of Object.keys(entries)) if (!Number.isFinite(entries[name].at) || now - entries[name].at > lifetime) delete entries[name];
    if (value === null) delete entries[slot];
    else entries[slot] = { at: now, value: JSON.parse(JSON.stringify(value)) };
    const ordered = Object.keys(entries).sort((a,b) => entries[b].at - entries[a].at);
    for (const name of ordered.slice(12)) delete entries[name];
    wx.setStorageSync(key(scope), { owner, entries });
    return true;
  } catch (error) { return false; }
}
module.exports = { read, write };
