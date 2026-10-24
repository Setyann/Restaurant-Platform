export const MAX_QTY = 20
export const MAX_LINES = 30

export function lineKey(itemId, variantId) {
  return `${itemId}::${variantId ?? ''}`
}

// line: { itemId, variantId, name, variantName, price, currency }
export function addToCart(cart, line) {
  const price = Number(line.price)
  if (!line.itemId || !Number.isFinite(price) || price < 0) return cart
  if (cart.length > 0 && cart[0].currency !== line.currency) return cart

  const key = lineKey(line.itemId, line.variantId)
  const existing = cart.find((entry) => entry.key === key)

  if (existing) {
    return cart.map((entry) =>
      entry.key === key
        ? { ...entry, qty: Math.min(entry.qty + 1, MAX_QTY) }
        : entry
    )
  }

  if (cart.length >= MAX_LINES) return cart

  return [
    ...cart,
    {
      key,
      itemId: line.itemId,
      variantId: line.variantId ?? null,
      name: line.name,
      variantName: line.variantName ?? null,
      price,
      currency: line.currency,
      qty: 1
    }
  ]
}

export function changeQty(cart, key, delta) {
  return cart
    .map((entry) =>
      entry.key === key
        ? { ...entry, qty: Math.min(entry.qty + delta, MAX_QTY) }
        : entry
    )
    .filter((entry) => entry.qty > 0)
}

export function cartCount(cart) {
  return cart.reduce((sum, entry) => sum + entry.qty, 0)
}

export function cartTotal(cart) {
  const total = cart.reduce((sum, entry) => sum + entry.price * entry.qty, 0)
  return Math.round(total * 100) / 100
}

// Only ids and quantities go to the server; it looks prices up itself.
export function toOrderItems(cart) {
  return cart.map((entry) => ({
    item: entry.itemId,
    variant: entry.variantId,
    qty: entry.qty
  }))
}

export function normalizeNote(value) {
  return String(value ?? '').trim().slice(0, 300)
}
