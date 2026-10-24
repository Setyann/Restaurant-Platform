export const ACTIVE_STATUSES = ['new', 'preparing', 'ready']
export const STATUS_STEPS = ['new', 'preparing', 'ready', 'served']

const NEXT = { new: 'preparing', preparing: 'ready', ready: 'served' }

export function nextStatus(status) {
  return NEXT[status] ?? null
}

export function canCancel(status) {
  return ACTIVE_STATUSES.includes(status)
}

export function isFinalStatus(status) {
  return status === 'served' || status === 'cancelled'
}

// Position in the progress bar; -1 for cancelled / unknown.
export function statusStep(status) {
  return STATUS_STEPS.indexOf(status)
}
