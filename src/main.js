import './style.css'
import { getMenu } from './services/menuService.js'
import { validateMenu } from './utils/validateMenu.js'
import { getLocalizedText as localizeText } from './utils/getLocalizedText.js'
import { escapeHtml } from './utils/escapeHtml.js'
import { hasFeature } from './utils/plans.js'
import { addToCart, changeQty, cartCount, cartTotal } from './utils/cart.js'
import { orderText as getOrderText, errorKey } from './utils/orderText.js'
import { STATUS_STEPS, statusStep, isFinalStatus } from './utils/orderStatus.js'
import { parseTableToken } from './utils/tableToken.js'
import { newRequestId, isUuid } from './utils/requestId.js'
import { placeOrder, getOrderStatus } from './services/orderService.js'
import { safeHttpsUrl, telHref, mailtoHref, visibleInfo } from './utils/footer.js'
import { footerText } from './utils/footerText.js'
import { CREATOR } from './utils/creator.js'

const restaurantSlug = new URLSearchParams(
  window.location.search
).get('restaurant') || 'demo'

const menuData = await getMenu(restaurantSlug)
const app = document.querySelector('#app')

if (!menuData) {
  app.innerHTML = `
    <main class="app">
      <section class="menu-empty">
        <h1>Restaurant not found</h1>
        <p>
          This restaurant does not exist or its menu is unavailable.
        </p>
      </section>
    </main>
  `

  throw new Error(`Restaurant not found: ${restaurantSlug}`)
}

const { restaurant, menu } = menuData

const validationErrors = validateMenu({ restaurant, menu })

if (validationErrors.length > 0) {
  console.error('Menu validation failed:', validationErrors)

  document.querySelector('#app').innerHTML = `
    <main class="app">
      <section class="menu-empty">
        <h1>Ошибка данных меню</h1>
        <p>Проверьте JSON-файл меню и исправьте ошибки.</p>
      </section>
    </main>
  `

  throw new Error('Menu validation failed.')
}

// Free plan: view only. Standard plan: ordering, but only from a table QR link
// (?t=<token>). The database re-checks the plan, the token and the limits.
const orderingEnabled = hasFeature(menuData.plan, 'ordering')
const tableToken = parseTableToken(window.location.search)
const canOrder = orderingEnabled && tableToken !== ''
const STATUS_POLL_MS = 5000
const TRACK_KEY = `restaurant-order:${restaurant.slug}`
const TRACK_MAX_AGE_MS = 12 * 60 * 60 * 1000

document.body.classList.toggle('has-ordering', canOrder)

function loadTracking() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRACK_KEY) ?? 'null')
    if (saved && isUuid(saved.id) && Date.now() - saved.savedAt < TRACK_MAX_AGE_MS) {
      return { id: saved.id, number: saved.number, table: saved.table, status: saved.status }
    }
  } catch {
    // storage unavailable: tracking just won't survive a reload
  }
  return null
}

function saveTracking() {
  try {
    if (orderState.tracking) {
      localStorage.setItem(TRACK_KEY, JSON.stringify({ ...orderState.tracking, savedAt: Date.now() }))
    } else {
      localStorage.removeItem(TRACK_KEY)
    }
  } catch {
    // ignore
  }
}

let cart = []
const orderState = {
  open: false,
  sending: false,
  error: '',
  result: null,
  note: '',
  requestId: null,
  tracking: orderingEnabled ? loadTracking() : null
}

const defaultLanguage = restaurant.primaryLanguage
const supportedLanguages = restaurant.supportedLanguages
const accentColor = restaurant.branding.accentColor

document.documentElement.style.setProperty('--color-accent', accentColor)

function getInitialLanguage() {
  try {
    const savedLanguage = localStorage.getItem(
      `restaurant-menu-language-${restaurant.slug}`
    )

    if (supportedLanguages.includes(savedLanguage)) {
      return savedLanguage
    }
  } catch {
    // Storage may be unavailable; use the default language.
  }

  return defaultLanguage
}

let currentLanguage = getInitialLanguage()

function getLocalizedText(value) {
  return localizeText(value, currentLanguage, defaultLanguage)
}

function formatPrice(price, currency) {
  return new Intl.NumberFormat(currentLanguage, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(price)
}

function renderFooter() {
  const info = visibleInfo(menuData.info)
  const t = (key) => footerText(currentLanguage, key)
  const about = info.about ? getLocalizedText(info.about) : ''

  const rows = []
  if (info.address) rows.push(['address', escapeHtml(info.address)])
  if (info.hours) rows.push(['hours', escapeHtml(info.hours)])
  if (info.phone) {
    const href = telHref(info.phone)
    rows.push(['phone', href ? `<a href="${escapeHtml(href)}">${escapeHtml(info.phone)}</a>` : escapeHtml(info.phone)])
  }
  if (info.email) {
    const href = mailtoHref(info.email)
    rows.push(['email', href ? `<a href="${escapeHtml(href)}">${escapeHtml(info.email)}</a>` : escapeHtml(info.email)])
  }
  if (info.website) {
    const href = safeHttpsUrl(info.website)
    rows.push(['website', href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(info.website)}</a>` : ''])
  }

  const hasInfo = Boolean(about) || rows.some(([, value]) => value)

  return `
    <footer class="app-footer">
      ${hasInfo ? `
        <div class="footer-block">
          ${about ? `<h2 class="footer-title">${escapeHtml(t('about'))}</h2>
            <p class="footer-about">${escapeHtml(about)}</p>` : ''}
          ${rows.filter(([, value]) => value).length ? `<dl class="footer-facts">
            ${rows.filter(([, value]) => value).map(([key, value]) => `
              <div><dt>${escapeHtml(t(key))}</dt><dd>${value}</dd></div>
            `).join('')}
          </dl>` : ''}
        </div>
      ` : ''}
      <div class="footer-bottom">
        <span>${escapeHtml(t('platform'))}</span>
        <span>${escapeHtml(t('creator'))}
          <a href="${escapeHtml(CREATOR.portfolio)}" target="_blank" rel="noopener noreferrer">${escapeHtml(CREATOR.name)}</a>
          · <a href="${escapeHtml(CREATOR.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>
        </span>
      </div>
    </footer>
  `
}

function orderText(key) {
  return getOrderText(currentLanguage, key)
}

function addButton(item, variant) {
  if (!canOrder) return ''

  return `
    <button
      class="add-button"
      type="button"
      data-add-item="${escapeHtml(item.id)}"
      ${variant ? `data-add-variant="${escapeHtml(variant.id)}"` : ''}
      aria-label="${escapeHtml(orderText('add'))}"
    >+</button>
  `
}

function renderItem(item) {
  if (!item.isAvailable) return ''

  const variants = Array.isArray(item.variants)
    ? item.variants
    : []

  const priceContent = variants.length > 0
    ? `
      <ul class="menu-item-variants">
        ${variants.map((variant) => `
          <li class="menu-item-variant">
            <span class="menu-item-variant-name">
              ${getLocalizedText(variant.name)}
            </span>
            <span class="menu-item-buy">
              <span class="menu-item-price">
                ${escapeHtml(formatPrice(variant.price, variant.currency))}
              </span>
              ${addButton(item, variant)}
            </span>
          </li>
        `).join('')}
      </ul>
    `
    : `
      <div class="menu-item-buy">
        <span class="menu-item-price">
          ${escapeHtml(formatPrice(item.price, item.currency))}
        </span>
        ${addButton(item)}
      </div>
    `

  return `
    <article class="menu-item">
      <div class="menu-item-content">
        <h3>${getLocalizedText(item.name)}</h3>
        <p>${getLocalizedText(item.description)}</p>
        ${priceContent}
      </div>
    </article>
  `
}

function renderCategory(category) {
  const items = menu.items
    .filter((item) => item.categoryId === category.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const availableItems = items.filter((item) => item.isAvailable)

  if (availableItems.length === 0) return ''

  const subcategories = (menu.subcategories ?? [])
    .filter((subcategory) => subcategory.parentCategoryId === category.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  // Keep items without a subcategory visible for older menu data.
  const uncategorizedItems = availableItems.filter(
    (item) => !item.subcategoryId
  )

  const uncategorizedSection = uncategorizedItems.length > 0
    ? `
      <div class="menu-items">
        ${uncategorizedItems.map(renderItem).join('')}
      </div>
    `
    : ''

  const subcategorySections = subcategories.map((subcategory) => {
    const subcategoryItems = availableItems.filter(
      (item) => item.subcategoryId === subcategory.id
    )

    if (subcategoryItems.length === 0) return ''

    return `
      <section class="menu-subcategory">
        <h3 class="menu-subcategory-title">
          ${getLocalizedText(subcategory.name)}
        </h3>
        <div class="menu-items">
          ${subcategoryItems.map(renderItem).join('')}
        </div>
      </section>
    `
  }).join('')

  return `
    <section class="menu-category">
      <h2>${getLocalizedText(category.name)}</h2>
      ${uncategorizedSection}
      ${subcategorySections}
    </section>
  `
}

function renderMenu() {
  const categories = [...menu.categories]
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const app = document.querySelector('#app')

  app.innerHTML = `
    <main class="app">
      <header class="restaurant-header">
        <span class="restaurant-label">RESTAURANT PLATFORM</span>
        <h1>${getLocalizedText(restaurant.name)}</h1>
        <p>
          ${getLocalizedText(restaurant.description) ||
            ({
              hy: 'Թվային մենյու',
              ru: 'Цифровое меню заведения',
              en: 'Digital restaurant menu'
            }[currentLanguage] || 'Digital restaurant menu')}
        </p>
      </header>

      <nav class="language-switcher" aria-label="Язык меню">
        ${supportedLanguages.map((code) => `
          <button
            class="language-button ${code === currentLanguage ? 'active' : ''}"
            type="button"
            data-language="${code}"
            aria-pressed="${code === currentLanguage}"
          >
            ${code.toUpperCase()}
          </button>
        `).join('')}
      </nav>

      <div class="menu-content">
        ${categories.map(renderCategory).join('') || `
          <section class="menu-empty">
            <h2>
              ${
                {
                  hy: 'Մենյուն դեռ դատարկ է',
                  ru: 'Меню пока пустое',
                  en: 'The menu is empty'
                }[currentLanguage]
              }
            </h2>
            <p>
              ${
                {
                  hy: 'Ուտեստները կհայտնվեն այստեղ ավելի ուշ։',
                  ru: 'Блюда появятся здесь после добавления данных.',
                  en: 'Dishes will appear here once added.'
                }[currentLanguage]
              }
            </p>
          </section>
        `}
      </div>

      <div id="order-root"></div>

      ${renderFooter()}
    </main>
  `

  app.querySelectorAll('[data-language]').forEach((button) => {
    button.addEventListener('click', () => {
      const selectedLanguage = button.dataset.language

      if (!supportedLanguages.includes(selectedLanguage)) return

      currentLanguage = selectedLanguage

      try {
        localStorage.setItem(
          `restaurant-menu-language-${restaurant.slug}`,
          currentLanguage
        )
      } catch {
        // Language switching still works without persistent storage.
      }

      renderMenu()
    })
  })

  bindAddButtons()
  renderOrderUI()
}

function bindAddButtons() {
  if (!canOrder) return

  app.querySelectorAll('[data-add-item]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = menu.items.find((entry) => entry.id === button.dataset.addItem)
      if (!item) return

      const variant = button.dataset.addVariant
        ? (item.variants ?? []).find((entry) => entry.id === button.dataset.addVariant)
        : null

      cart = addToCart(cart, {
        itemId: item.id,
        variantId: variant?.id ?? null,
        name: item.name,
        variantName: variant?.name ?? null,
        price: variant ? variant.price : item.price,
        currency: variant ? variant.currency : item.currency
      })

      orderState.error = ''
      orderState.requestId = null
      renderOrderUI()
    })
  })
}

function statusText(status) {
  return orderText(`status_${status}`)
}

function statusBanner() {
  const tracking = orderState.tracking
  if (!tracking) return ''

  const step = statusStep(tracking.status)
  const finished = isFinalStatus(tracking.status)

  const steps = tracking.status === 'cancelled'
    ? ''
    : `<ol class="order-steps">${STATUS_STEPS.map((status, index) => `
        <li class="${index <= step ? 'done' : ''}">${escapeHtml(statusText(status))}</li>
      `).join('')}</ol>`

  return `
    <aside class="order-status" role="status" data-status="${escapeHtml(tracking.status)}">
      <div class="order-status-head">
        <strong>${escapeHtml(orderText('orderNumber'))}${escapeHtml(tracking.number)}
          · ${escapeHtml(orderText('table'))} ${escapeHtml(tracking.table)}</strong>
        <span class="order-status-label">${escapeHtml(statusText(tracking.status))}</span>
        ${finished ? `<button type="button" class="order-close" data-track-dismiss
          aria-label="${escapeHtml(orderText('dismiss'))}">×</button>` : ''}
      </div>
      ${steps}
    </aside>
  `
}

function bindBanner(root) {
  root.querySelector('[data-track-dismiss]')?.addEventListener('click', () => {
    orderState.tracking = null
    saveTracking()
    renderOrderUI()
  })
}

function renderOrderUI() {
  const root = document.querySelector('#order-root')
  if (!root || !orderingEnabled) return

  document.body.classList.toggle('has-tracking', Boolean(orderState.tracking))

  if (!canOrder) {
    root.innerHTML = `
      ${statusBanner()}
      <p class="order-notice">${escapeHtml(orderText('scanToOrder'))}</p>
    `
    bindBanner(root)
    return
  }

  const count = cartCount(cart)
  const currency = cart[0]?.currency

  const bar = count > 0 && !orderState.open
    ? `
      <div class="cart-bar">
        <button type="button" class="cart-bar-button" data-cart-open>
          <span>${escapeHtml(orderText('viewOrder'))} · ${count}</span>
          <span>${escapeHtml(formatPrice(cartTotal(cart), currency))}</span>
        </button>
      </div>
    `
    : ''

  let sheet = ''

  if (orderState.open && orderState.result) {
    const { number, total, currency: resultCurrency, table } = orderState.result

    sheet = `
      <div class="order-overlay" data-order-close></div>
      <section class="order-sheet" role="dialog" aria-modal="true">
        <h2>${escapeHtml(orderText('orderSent'))}</h2>
        <p class="order-number">
          ${escapeHtml(orderText('orderNumber'))}${escapeHtml(number)}
        </p>
        <p>${escapeHtml(orderText('table'))} ${escapeHtml(table)} ·
          ${escapeHtml(formatPrice(total, resultCurrency))}</p>
        <p>${escapeHtml(orderText('staffWillBring'))}</p>
        <button type="button" class="order-submit" data-order-close>
          ${escapeHtml(orderText('done'))}
        </button>
      </section>
    `
  } else if (orderState.open) {
    sheet = `
      <div class="order-overlay" data-order-close></div>
      <section class="order-sheet" role="dialog" aria-modal="true"
        aria-label="${escapeHtml(orderText('yourOrder'))}">
        <header class="order-sheet-header">
          <h2>${escapeHtml(orderText('yourOrder'))}</h2>
          <button type="button" class="order-close" data-order-close
            aria-label="${escapeHtml(orderText('close'))}">×</button>
        </header>

        <ul class="order-lines">
          ${cart.map((line) => `
            <li class="order-line">
              <div class="order-line-name">
                ${getLocalizedText(line.name)}${line.variantName
                  ? ` · ${getLocalizedText(line.variantName)}`
                  : ''}
              </div>
              <div class="order-line-controls">
                <button type="button" data-qty="${escapeHtml(line.key)}"
                  data-delta="-1" aria-label="−">−</button>
                <span>${line.qty}</span>
                <button type="button" data-qty="${escapeHtml(line.key)}"
                  data-delta="1" aria-label="+">+</button>
              </div>
              <span class="order-line-price">
                ${escapeHtml(formatPrice(line.price * line.qty, line.currency))}
              </span>
            </li>
          `).join('')}
        </ul>

        <label class="order-field">
          <span>${escapeHtml(orderText('comment'))}</span>
          <textarea id="order-note" maxlength="300" rows="2">${escapeHtml(orderState.note)}</textarea>
        </label>

        <p class="order-error" role="alert">${escapeHtml(orderState.error)}</p>

        <div class="order-total">
          <span>${escapeHtml(orderText('total'))}</span>
          <strong>${escapeHtml(formatPrice(cartTotal(cart), currency))}</strong>
        </div>

        <button type="button" class="order-submit" id="order-submit"
          ${orderState.sending ? 'disabled' : ''}>
          ${escapeHtml(orderText(orderState.sending ? 'sending' : 'send'))}
        </button>
      </section>
    `
  }

  root.innerHTML = statusBanner() + bar + sheet
  bindBanner(root)

  root.querySelector('[data-cart-open]')?.addEventListener('click', () => {
    orderState.open = true
    renderOrderUI()
  })

  root.querySelectorAll('[data-order-close]').forEach((element) => {
    element.addEventListener('click', () => {
      orderState.open = false
      orderState.result = null
      renderOrderUI()
    })
  })

  root.querySelectorAll('[data-qty]').forEach((button) => {
    button.addEventListener('click', () => {
      cart = changeQty(cart, button.dataset.qty, Number(button.dataset.delta))
      orderState.requestId = null // a different order is a different submission
      if (cart.length === 0) orderState.open = false
      renderOrderUI()
    })
  })

  root.querySelector('#order-note')?.addEventListener('input', (event) => {
    orderState.note = event.target.value
  })

  root.querySelector('#order-submit')?.addEventListener('click', submitOrder)
}

async function submitOrder() {
  if (orderState.sending || cart.length === 0) return

  orderState.requestId ??= newRequestId()
  orderState.sending = true
  orderState.error = ''
  renderOrderUI()

  try {
    const result = await placeOrder({
      slug: restaurant.slug,
      token: tableToken,
      note: orderState.note,
      cart,
      requestId: orderState.requestId
    })

    orderState.result = {
      number: result.order_number,
      total: result.total,
      currency: result.currency,
      table: result.table_label
    }
    orderState.tracking = {
      id: result.order_id,
      number: result.order_number,
      table: result.table_label,
      status: 'new'
    }
    saveTracking()
    cart = []
    orderState.note = ''
    orderState.requestId = null
  } catch (error) {
    console.error('Order failed:', error)
    orderState.error = orderText(errorKey(error.code))
  } finally {
    orderState.sending = false
    renderOrderUI()
  }
}

async function refreshTracking() {
  const tracking = orderState.tracking
  if (!tracking || isFinalStatus(tracking.status)) return

  try {
    const data = await getOrderStatus(tracking.id)

    if (!data) {
      orderState.tracking = null
    } else if (data.status !== tracking.status) {
      tracking.status = data.status
    } else {
      return
    }

    saveTracking()
    renderOrderUI()
  } catch (error) {
    console.error('Status refresh failed:', error) // keep the last known status
  }
}

if (orderingEnabled) {
  refreshTracking()
  setInterval(() => {
    if (!document.hidden) refreshTracking()
  }, STATUS_POLL_MS)
}

renderMenu()
