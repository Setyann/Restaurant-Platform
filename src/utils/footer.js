// Safe display helpers for the guest footer. Values come from the database,
// so every link is re-checked here before it becomes an href.

export function safeHttpsUrl(value) {
  const text = String(value ?? '').trim()
  return /^https:\/\/[^\s<>"']+$/.test(text) ? text : ''
}

export function telHref(phone) {
  const text = String(phone ?? '').trim()
  if (!/^\+?[0-9 ()-]{5,25}$/.test(text)) return ''
  const digits = text.replace(/[^0-9+]/g, '')
  return digits.length >= 5 ? `tel:${digits}` : ''
}

export function mailtoHref(email) {
  const text = String(email ?? '').trim()
  return /^[^@\s<>"']+@[^@\s<>"']+\.[^@\s<>"']+$/.test(text) && text.length <= 120
    ? `mailto:${text}`
    : ''
}

// Only fields that are actually filled in are shown.
export function visibleInfo(info) {
  const source = info && typeof info === 'object' ? info : {}
  return {
    address: String(source.address ?? '').trim(),
    hours: String(source.hours ?? '').trim(),
    phone: String(source.phone ?? '').trim(),
    email: String(source.email ?? '').trim(),
    website: String(source.website ?? '').trim(),
    about: source.about && typeof source.about === 'object' ? source.about : null
  }
}
