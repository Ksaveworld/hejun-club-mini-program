// Presentation only: never rewrite identity or authentication fields.
function accountDisplayLabel(user) {
  if (!user) return '访客浏览';
  if (user.role === 'reviewer' || user.authMode === 'review') return '审核体验账号';
  const name = user.username;
  if (typeof name !== 'string' || !name.trim()) return '俱乐部用户';
  if ((name.length === 31 && /^wx_[0-9a-f]{28}$/.test(name)) || (name.length === 28 && /^wxh_[0-9a-f]{24}$/.test(name))) return '微信用户';
  return name;
}
module.exports = { accountDisplayLabel };
