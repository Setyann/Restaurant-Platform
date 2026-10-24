const KNOWN_CODES = [
  'plan_not_allowed',
  'item_unavailable',
  'invalid_table_token',
  'invalid_items',
  'menu_not_published',
  'restaurant_not_found',
  'table_busy',
  'rate_limited',
  'restaurant_busy'
]

// Postgres exceptions arrive as error.message containing our code.
export function parseOrderError(error) {
  const message = String(error?.message ?? '')
  return KNOWN_CODES.find((code) => message.includes(code)) ?? 'unknown'
}
