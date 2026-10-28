// Display/consumption only. Payment, renewal and rewards keep session.membership.
function consumptionMembership(session, now = Date.now()) {
  if (!session || session.user?.role !== 'member') return null;
  if (session.effectiveEntitlements === undefined) return session.membership || null;
  const membership = session.displayMembership;
  return membership?.active === true && Date.parse(membership.startsAt) <= now &&
    now < Date.parse(membership.expiresAt) ? membership : null;
}
function hasConsumptionPlan(session, planId, now = Date.now()) {
  if (session?.user?.role !== 'member') return false;
  const plans = session.effectiveEntitlements === undefined ? [session.membership] : session.effectiveEntitlements?.byPlan;
  return Array.isArray(plans) && plans.some(plan => plan?.planId === planId && plan.active === true &&
    Date.parse(plan.startsAt) <= now && now < Date.parse(plan.expiresAt));
}
module.exports = { consumptionMembership, hasConsumptionPlan };
