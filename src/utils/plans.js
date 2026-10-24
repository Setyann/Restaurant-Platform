// Plan -> features. The database enforces the same rules (place_order checks the
// plan); this file only decides what the UI shows.
export const PLANS = {
  free: { label: 'Free', ordering: false, staffWindow: false },
  standard: { label: 'Standard', ordering: true, staffWindow: true }
}

export function normalizePlan(plan) {
  return typeof plan === 'string' && Object.hasOwn(PLANS, plan) ? plan : 'free'
}

export function hasFeature(plan, feature) {
  return PLANS[normalizePlan(plan)][feature] === true
}
