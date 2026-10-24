import test from 'node:test'
import assert from 'node:assert/strict'

import { hasFeature, normalizePlan } from '../src/utils/plans.js'
import {
  addToCart, changeQty, cartCount, cartTotal, toOrderItems,
  normalizeNote, MAX_QTY, MAX_LINES
} from '../src/utils/cart.js'
import { nextStatus, canCancel, isFinalStatus, statusStep, STATUS_STEPS } from '../src/utils/orderStatus.js'
import { parseTableToken } from '../src/utils/tableToken.js'
import { newRequestId, isUuid } from '../src/utils/requestId.js'
import { buildI18n, newSourceId, parsePrice, normalizeCurrency } from '../src/utils/i18n.js'
import { parseOrderError } from '../src/utils/orderErrors.js'
import { orderText, errorKey, ORDER_TEXT } from '../src/utils/orderText.js'

const espresso = {
  itemId: 'espresso', variantId: null, name: { en: 'Espresso' },
  price: 800, currency: 'AMD'
}
const latte = { ...espresso, itemId: 'latte', variantId: 'small', price: 1000 }

test('free plan has no ordering and no staff window', () => {
  assert.equal(hasFeature('free', 'ordering'), false)
  assert.equal(hasFeature('free', 'staffWindow'), false)
})

test('standard plan has ordering and staff window', () => {
  assert.equal(hasFeature('standard', 'ordering'), true)
  assert.equal(hasFeature('standard', 'staffWindow'), true)
})

test('unknown or missing plan falls back to free', () => {
  for (const plan of [undefined, null, '', 'premium', 'constructor', 42]) {
    assert.equal(normalizePlan(plan), 'free')
    assert.equal(hasFeature(plan, 'ordering'), false)
  }
})

test('adding the same line increases quantity', () => {
  let cart = addToCart([], espresso)
  cart = addToCart(cart, espresso)
  assert.equal(cart.length, 1)
  assert.equal(cart[0].qty, 2)
})

test('same item with different variants are separate lines', () => {
  let cart = addToCart([], latte)
  cart = addToCart(cart, { ...latte, variantId: 'large', price: 1500 })
  assert.equal(cart.length, 2)
})

test('quantity is capped and lines are removed at zero', () => {
  let cart = addToCart([], espresso)
  cart = changeQty(cart, cart[0].key, 100)
  assert.equal(cart[0].qty, MAX_QTY)
  cart = changeQty(cart, cart[0].key, -MAX_QTY)
  assert.deepEqual(cart, [])
})

test('invalid price or mixed currency is rejected', () => {
  assert.deepEqual(addToCart([], { ...espresso, price: NaN }), [])
  assert.deepEqual(addToCart([], { ...espresso, price: -5 }), [])
  const cart = addToCart([], espresso)
  assert.equal(addToCart(cart, { ...latte, currency: 'USD' }), cart)
})

test('cart is limited to MAX_LINES distinct lines', () => {
  let cart = []
  for (let i = 0; i < MAX_LINES + 5; i++) {
    cart = addToCart(cart, { ...espresso, itemId: `item-${i}` })
  }
  assert.equal(cart.length, MAX_LINES)
})

test('count and total are computed from lines', () => {
  let cart = addToCart([], espresso)
  cart = addToCart(cart, espresso)
  cart = addToCart(cart, latte)
  assert.equal(cartCount(cart), 3)
  assert.equal(cartTotal(cart), 2600)
  assert.equal(cartTotal([{ price: 0.1, qty: 3 }]), 0.3)
})

test('order payload contains only ids and quantities', () => {
  let cart = addToCart([], espresso)
  cart = addToCart(cart, latte)
  assert.deepEqual(toOrderItems(cart), [
    { item: 'espresso', variant: null, qty: 1 },
    { item: 'latte', variant: 'small', qty: 1 }
  ])
})

test('note is trimmed and limited to 300 characters', () => {
  assert.equal(normalizeNote('  no sugar  '), 'no sugar')
  assert.equal(normalizeNote('x'.repeat(500)).length, 300)
  assert.equal(normalizeNote(null), '')
})

test('order statuses move forward only', () => {
  assert.equal(nextStatus('new'), 'preparing')
  assert.equal(nextStatus('preparing'), 'ready')
  assert.equal(nextStatus('ready'), 'served')
  assert.equal(nextStatus('served'), null)
  assert.equal(nextStatus('cancelled'), null)
  assert.equal(canCancel('new'), true)
  assert.equal(canCancel('served'), false)
})

test('database error codes are recognised', () => {
  assert.equal(parseOrderError({ message: 'plan_not_allowed' }), 'plan_not_allowed')
  assert.equal(parseOrderError({ message: 'ERROR: item_unavailable (P0001)' }), 'item_unavailable')
  assert.equal(parseOrderError({ message: 'table_busy' }), 'table_busy')
  assert.equal(parseOrderError({ message: 'rate_limited' }), 'rate_limited')
  assert.equal(parseOrderError({ message: 'invalid_table_token' }), 'invalid_table_token')
  assert.equal(parseOrderError(new Error('network down')), 'unknown')
  assert.equal(parseOrderError(null), 'unknown')
})

test('every language has the same order texts', () => {
  const keys = Object.keys(ORDER_TEXT.en).sort()
  for (const language of ['hy', 'ru']) {
    assert.deepEqual(Object.keys(ORDER_TEXT[language]).sort(), keys)
  }
  assert.equal(orderText('xx', 'send'), ORDER_TEXT.en.send)
  assert.equal(errorKey('item_unavailable'), 'errUnavailable')
  assert.equal(errorKey('plan_not_allowed'), 'errClosed')
  assert.equal(errorKey('unknown'), 'errGeneric')
  assert.equal(errorKey('invalid_table_token'), 'errBadTable')
  assert.equal(errorKey('table_busy'), 'errTableBusy')
  assert.equal(errorKey('rate_limited'), 'errRate')
  assert.equal(errorKey('restaurant_busy'), 'errBusy')
})

test('every order status has a text in every language', () => {
  for (const language of ['hy', 'ru', 'en']) {
    for (const status of [...STATUS_STEPS, 'cancelled']) {
      assert.ok(ORDER_TEXT[language][`status_${status}`], `${language}:${status}`)
    }
  }
})

test('final statuses and progress steps', () => {
  assert.equal(isFinalStatus('served'), true)
  assert.equal(isFinalStatus('cancelled'), true)
  assert.equal(isFinalStatus('new'), false)
  assert.equal(statusStep('new'), 0)
  assert.equal(statusStep('served'), 3)
  assert.equal(statusStep('cancelled'), -1)
})

test('table token comes only from a well-formed ?t= parameter', () => {
  const token = 'a'.repeat(32)
  assert.equal(parseTableToken(`?restaurant=demo&t=${token}`), token)
  for (const bad of ['', '?t=', '?t=abc', `?t=${token}z`, `?t=${token.toUpperCase()}`, '?table=5', `?t=${token}${token}`]) {
    assert.equal(parseTableToken(bad), '', bad)
  }
})

test('request ids are valid, unique UUIDs', () => {
  const first = newRequestId()
  assert.equal(isUuid(first), true)
  assert.notEqual(first, newRequestId())
  assert.equal(isUuid('not-a-uuid'), false)
  assert.equal(isUuid(null), false)
})

test('i18n builder drops empty languages and enforces rules', () => {
  assert.deepEqual(buildI18n({ hy: '', ru: ' Кофе ', en: 'Coffee' }, { required: true }), { ru: 'Кофе', en: 'Coffee' })
  assert.deepEqual(buildI18n({}, { required: false }), {})
  assert.throws(() => buildI18n({ ru: '  ' }, { required: true }), /name_required/)
  assert.throws(() => buildI18n({ ru: 'x'.repeat(121) }), /too_long/)
  assert.deepEqual(buildI18n({ xx: 'ignored', en: 'ok' }), { en: 'ok' })
})

test('admin input parsing: prices, currency, source ids', () => {
  assert.equal(parsePrice('1 200'.replace(' ', '')), 1200)
  assert.equal(parsePrice('12,5'), 12.5)
  assert.equal(parsePrice(''), null)
  for (const bad of ['abc', '-1', '1e9']) assert.throws(() => parsePrice(bad), /bad_price/, bad)
  assert.equal(normalizeCurrency(' amd '), 'AMD')
  assert.throws(() => normalizeCurrency('AMDD'), /bad_currency/)
  assert.throws(() => normalizeCurrency('12'), /bad_currency/)
  assert.match(newSourceId('i'), /^i-[a-z0-9]{6}$/)
})
