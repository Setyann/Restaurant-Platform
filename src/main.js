import './style.css'
import { getMenu } from './services/menuService.js'
import { validateMenu } from './utils/validateMenu.js'
import { getLocalizedText as localizeText } from './utils/getLocalizedText.js'
import { escapeHtml } from './utils/escapeHtml.js'

const { restaurant, menu } = getMenu()

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

const defaultLanguage = restaurant.primaryLanguage
const supportedLanguages = restaurant.supportedLanguages
const accentColor = restaurant.branding.accentColor

document.documentElement.style.setProperty('--color-accent', accentColor)

function getInitialLanguage() {
  try {
    const savedLanguage = localStorage.getItem('restaurant-menu-language')

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

function renderItem(item) {
  if (!item.isAvailable) return ''

  return `
    <article class="menu-item">
      <div class="menu-item-content">
        <h3>${getLocalizedText(item.name)}</h3>
        <p>${getLocalizedText(item.description)}</p>
        <span class="menu-item-price">
          ${escapeHtml(formatPrice(item.price, item.currency))}
        </span>
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

      <footer class="app-footer">
        Powered by Restaurant Platform
      </footer>
    </main>
  `

  app.querySelectorAll('[data-language]').forEach((button) => {
    button.addEventListener('click', () => {
      const selectedLanguage = button.dataset.language

      if (!supportedLanguages.includes(selectedLanguage)) return

      currentLanguage = selectedLanguage

      try {
        localStorage.setItem(
          'restaurant-menu-language',
          currentLanguage
        )
      } catch {
        // Language switching still works without persistent storage.
      }

      renderMenu()
    })
  })
}

renderMenu()