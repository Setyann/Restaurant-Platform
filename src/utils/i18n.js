export const LANGUAGES = ['hy', 'ru', 'en']

// {hy, ru, en} form values -> JSON for the database (empty languages are dropped).
export function buildI18n(values, { required = false, maxLength = 120 } = {}) {
  const result = {}

  for (const language of LANGUAGES) {
    const text = String(values?.[language] ?? '').trim()
    if (text.length > maxLength) throw new Error('too_long')
    if (text) result[language] = text
  }

  if (required && Object.keys(result).length === 0) throw new Error('name_required')
  return result
}

export function newSourceId(prefix, random = Math.random) {
  const suffix = Array.from({ length: 6 }, () => Math.floor(random() * 36).toString(36)).join('')
  return `${prefix}-${suffix}`
}

export function parsePrice(value) {
  const text = String(value ?? '').trim().replace(',', '.')
  if (text === '') return null
  const number = Number(text)
  if (!Number.isFinite(number) || number < 0 || number > 100000000) throw new Error('bad_price')
  return Math.round(number * 100) / 100
}

export function normalizeCurrency(value) {
  const code = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('bad_currency')
  return code
}
