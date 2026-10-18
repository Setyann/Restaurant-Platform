import { escapeHtml } from './escapeHtml.js'

export function getLocalizedText(value, currentLanguage, defaultLanguage) {
  if (!value || typeof value !== 'object') {
    return ''
  }

  const text =
    value[currentLanguage] ||
    value[defaultLanguage] ||
    value.ru ||
    value.en ||
    value.hy ||
    ''

  return escapeHtml(text)
}