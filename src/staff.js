import './staff.css'
import { supabase } from './services/supabaseClient.js'
import { hasFeature } from './utils/plans.js'
import { ACTIVE_STATUSES, nextStatus, canCancel } from './utils/orderStatus.js'

const slug = new URLSearchParams(window.location.search).get('restaurant') || 'demo'
const POLL_MS = 5000
const STAFF_ROLES = ['owner', 'staff']
const NEXT_LABEL = { new: 'Принять', preparing: 'Готово', ready: 'Выдано' }

const $ = (selector) => document.querySelector(selector)
const loginView = $('#login-view')
const boardView = $('#board-view')
const loginStatus = $('#login-status')
const boardStatus = $('#board-status')

let restaurant = null
let timer = null
let loading = false
let firstLoad = true
let soundOn = false
let audioContext = null
const seenNewIds = new Set()

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text // textContent: no HTML injection
  return node
}

function pickName(value) {
  if (!value || typeof value !== 'object') return ''
  return value.ru || value.en || value.hy || ''
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('ru', {
      style: 'currency', currency, maximumFractionDigits: 0
    }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
}

function beep() {
  if (!soundOn || !audioContext) return
  try {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.frequency.value = 880
    gain.gain.value = 0.08
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start()
    oscillator.stop(audioContext.currentTime + 0.25)
  } catch {
    // Sound is optional.
  }
}

function stopPolling() {
  clearInterval(timer)
  timer = null
}

function showLogin(message = '') {
  stopPolling()
  boardView.hidden = true
  loginView.hidden = false
  loginStatus.textContent = message
}

function showBoard(locked) {
  loginView.hidden = true
  boardView.hidden = false
  $('#locked-message').hidden = !locked
  $('#columns').hidden = locked
  $('#board-title').textContent = `Заказы · ${restaurant.slug}`
}

async function checkAccess(user) {
  try {
    const { data: found, error } = await supabase
      .from('restaurants').select('id, slug, plan').eq('slug', slug).maybeSingle()
    if (error) throw error
    if (!found) return showLogin('Ресторан не найден.')

    const { data: membership, error: memberError } = await supabase
      .from('restaurant_members').select('role')
      .eq('restaurant_id', found.id).eq('user_id', user.id).maybeSingle()
    if (memberError) throw memberError

    if (!membership || !STAFF_ROLES.includes(membership.role)) {
      return showLogin('У вашего аккаунта нет доступа к этому ресторану.')
    }

    restaurant = found
    const allowed = hasFeature(found.plan, 'staffWindow')
    showBoard(!allowed)

    if (allowed) {
      await loadOrders()
      stopPolling()
      timer = setInterval(() => { if (!document.hidden) loadOrders() }, POLL_MS)
    }
  } catch (error) {
    console.error('Access check failed:', error)
    showLogin('Не удалось проверить доступ. Попробуйте ещё раз.')
  }
}

async function loadOrders() {
  if (loading || !restaurant) return
  loading = true

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, table_label, note, status, currency, total, created_at, order_items(name, variant_name, quantity)')
      .eq('restaurant_id', restaurant.id)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: true })
      .limit(100)
    if (error) throw error

    const freshIds = data
      .filter((order) => order.status === 'new' && !seenNewIds.has(order.id))
      .map((order) => order.id)

    if (!firstLoad && freshIds.length > 0) beep()
    data.filter((order) => order.status === 'new').forEach((order) => seenNewIds.add(order.id))

    renderBoard(data, new Set(firstLoad ? [] : freshIds))
    firstLoad = false

    const newCount = data.filter((order) => order.status === 'new').length
    document.title = newCount > 0 ? `(${newCount}) Заказы` : 'Заказы'
    boardStatus.textContent = `Обновлено ${formatTime(new Date().toISOString())}`
  } catch (error) {
    console.error('Loading orders failed:', error)
    boardStatus.textContent = 'Нет связи. Пробуем снова…'
  } finally {
    loading = false
  }
}

function renderBoard(orders, freshIds) {
  document.querySelectorAll('.column').forEach((column) => {
    const status = column.dataset.status
    const cards = column.querySelector('.cards')
    const list = orders.filter((order) => order.status === status)
    cards.replaceChildren()

    if (list.length === 0) {
      cards.append(el('p', 'empty', 'Пусто'))
      return
    }

    list.forEach((order) => cards.append(orderCard(order, freshIds.has(order.id))))
  })
}

function orderCard(order, fresh) {
  const card = el('article', fresh ? 'card fresh' : 'card')

  const head = el('div', 'card-head')
  head.append(el('strong', '', `№${order.order_number} · стол ${order.table_label}`))
  head.append(el('span', 'muted', formatTime(order.created_at)))
  card.append(head)

  const items = el('ul')
  order.order_items.forEach((line) => {
    const variant = pickName(line.variant_name)
    items.append(el('li', '', `${line.quantity}× ${pickName(line.name)}${variant ? ` · ${variant}` : ''}`))
  })
  card.append(items)

  if (order.note) card.append(el('p', 'note', order.note))

  const foot = el('div', 'card-foot')
  foot.append(el('span', 'muted', formatMoney(order.total, order.currency)))

  const buttons = el('div', 'card-buttons')
  const target = nextStatus(order.status)

  if (canCancel(order.status)) {
    const cancel = el('button', 'danger', 'Отмена')
    cancel.type = 'button'
    cancel.addEventListener('click', () => {
      if (window.confirm(`Отменить заказ №${order.order_number}?`)) {
        changeStatus(order.id, 'cancelled', buttons)
      }
    })
    buttons.append(cancel)
  }

  if (target) {
    const advance = el('button', 'primary', NEXT_LABEL[order.status])
    advance.type = 'button'
    advance.addEventListener('click', () => changeStatus(order.id, target, buttons))
    buttons.append(advance)
  }

  foot.append(buttons)
  card.append(foot)
  return card
}

async function changeStatus(orderId, status, buttons) {
  buttons.querySelectorAll('button').forEach((button) => { button.disabled = true })

  try {
    const { error } = await supabase.rpc('set_order_status', { p_order: orderId, p_status: status })
    if (error) throw error
  } catch (error) {
    console.error('Status change failed:', error)
    boardStatus.textContent = 'Не удалось изменить статус. Обновите страницу.'
  }

  await loadOrders()
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = event.currentTarget.querySelector('button[type="submit"]')
  submit.disabled = true
  loginStatus.textContent = 'Выполняется вход…'

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: $('#email').value.trim(),
      password: $('#password').value
    })
    if (error) throw error
    await checkAccess(data.user)
  } catch (error) {
    console.error('Login failed:', error)
    showLogin('Войти не удалось. Проверьте email и пароль.')
  } finally {
    submit.disabled = false
  }
})

$('#logout-button').addEventListener('click', async () => {
  await supabase.auth.signOut()
  showLogin('Вы вышли из аккаунта.')
})

$('#sound-button').addEventListener('click', (event) => {
  soundOn = !soundOn
  if (soundOn) audioContext ??= new AudioContext() // needs a user gesture
  event.currentTarget.textContent = soundOn ? 'Звук: вкл' : 'Звук: выкл'
  event.currentTarget.setAttribute('aria-pressed', String(soundOn))
  if (soundOn) beep()
})

const { data: sessionData } = await supabase.auth.getSession()

if (sessionData?.session?.user) {
  await checkAccess(sessionData.session.user)
} else {
  showLogin()
}
