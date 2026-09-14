function normalizeCode(value) {
  return typeof value === 'string' && /^[a-z0-9]{6}$/i.test(value) ? value.toUpperCase() : '';
}
function contextChanged() {
  const error = new Error('账号或测试环境已变化，请刷新后继续。');
  error.code = 'CONTEXT_CHANGED';
  return error;
}

// Candidates belong to an API environment and, once identified, one member.
// Only server responses establish identity or a confirmed referral relationship.
function createReferralContext({ getScope, read, write, remove }) {
  let scope, state, generation = 0, activeOwner = null, flight = null;
  const key = () => 'club-native-referral:' + scope;
  function ensure() {
    const next = getScope();
    if (next !== scope) {
      scope = next; generation++; activeOwner = null; flight = null;
      const saved = read(key()) || {};
      state = {
        ownerId: typeof saved.ownerId === 'string' ? saved.ownerId : null,
        codes: Array.isArray(saved.codes) ? [...new Set(saved.codes.map(normalizeCode).filter(Boolean))].slice(0, 20) : []
      };
    }
  }
  function persist() { write(key(), { ownerId: state.ownerId, codes: state.codes.slice() }); }
  function snapshot() { ensure(); return { scope, generation, ownerId: state.ownerId, codes: state.codes.slice() }; }
  function assertCurrent(ticket) {
    ensure();
    if (scope !== ticket.scope || generation !== ticket.generation || activeOwner !== ticket.ownerId) throw contextChanged();
  }
  function capture(query = {}) {
    ensure();
    for (const value of [query.referral, query.ref]) {
      const code = normalizeCode(value);
      if (code && !state.codes.includes(code) && state.codes.length < 20) state.codes.push(code);
    }
    persist();
    return snapshot();
  }
  function identify(user) {
    ensure();
    if (!user || typeof user.id !== 'string' || !user.id) throw contextChanged();
    if (state.ownerId && state.ownerId !== user.id) state.codes = [];
    if (activeOwner !== user.id) { generation++; flight = null; }
    state.ownerId = user.id; activeOwner = user.id; persist();
    return { scope, generation, ownerId: user.id };
  }
  function invalidate() { ensure(); generation++; activeOwner = null; flight = null; }
  function clear() {
    ensure(); generation++; activeOwner = null; flight = null;
    state = { ownerId: null, codes: [] }; remove(key());
  }
  function synchronize(user, send) {
    const ticket = identify(user);
    if (flight && flight.generation === generation) return flight.promise;
    const job = { generation, promise: null };
    job.promise = (async () => {
      let notice = '';
      for (;;) {
        assertCurrent(ticket);
        if (user.referralSource === 'explicit' || user.referralLockedAt) {
          state.codes = []; persist(); return { user, notice };
        }
        const code = state.codes[0];
        if (!code) return { user, notice };
        try {
          const result = await send(code);
          assertCurrent(ticket);
          if (!result || result.id !== ticket.ownerId) throw contextChanged();
          user = result;
          if (user.referralSource === 'explicit' || user.referralLockedAt) notice = '';
          state.codes = state.codes.filter(value => value !== code); persist();
        } catch (error) {
          if (error.status === 401) { invalidate(); throw error; }
          assertCurrent(ticket);
          if (error.status === 400) {
            state.codes = state.codes.filter(value => value !== code); persist();
            notice = '入口推荐码未通过核验，已有推荐关系未被改变。';
          } else if (error.status === 409) {
            state.codes = []; persist();
            return { user, notice: '已有待处理订单，沿用订单保存的推荐来源。' };
          } else { throw error; }
        }
      }
    })().finally(() => { if (flight === job) flight = null; });
    flight = job;
    return job.promise;
  }
  return { capture, identify, invalidate, clear, synchronize, snapshot };
}
module.exports = { createReferralContext, normalizeCode, contextChanged };
