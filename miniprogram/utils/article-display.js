function displayScope(meta) {
  if (['info','activity','both'].includes(meta?.displayScope)) return meta.displayScope;
  return meta?.activityGroup ? 'both' : 'info';
}
function showsInfo(meta) { return displayScope(meta) !== 'activity'; }
function showsActivity(meta) { return displayScope(meta) !== 'info' && !!meta?.activityGroup; }
module.exports = {displayScope,showsInfo,showsActivity};
