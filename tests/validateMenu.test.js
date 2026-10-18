import test from 'node:test'
import assert from 'node:assert/strict'

import { validateMenu } from '../src/utils/validateMenu.js'
import { escapeHtml } from '../src/utils/escapeHtml.js'
import { readFile } from 'node:fs/promises'
import { getLocalizedText } from '../src/utils/getLocalizedText.js'

const menuUrl = new URL(
  '../src/data/restaurants/demo/menu.json',
  import.meta.url
)

const getMenu = async () =>
  JSON.parse(await readFile(menuUrl, 'utf8'))

test('demo menu passes validation', async () => {
  const data = await getMenu()

  assert.deepEqual(validateMenu(data), [])
})

test('missing restaurant is rejected', async () => {
  assert.ok(
    validateMenu({ menu: { categories: [], items: [] } })
      .some((error) => error.includes('Restaurant data is missing'))
  )
})

test('duplicate category IDs are detected', async () => {
  const data = structuredClone(await getMenu())

  data.menu.categories.push({
    ...data.menu.categories[0]
  })

  assert.ok(
    validateMenu(data).some((error) => error.includes('Duplicate category ID'))
  )
})

test('items referencing unknown categories are rejected', async () => {
  const data = structuredClone(await getMenu())

  data.menu.items[0].categoryId = 'missing-category'

  assert.ok(
    validateMenu(data).some((error) => error.includes('unknown category'))
  )
})

test('negative prices are rejected', async () => {
  const data = structuredClone(await getMenu())

  data.menu.items[0].price = -100

  assert.ok(
    validateMenu(data).some((error) => error.includes('invalid price'))
  )
})

test('HTML special characters are escaped', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  )
})

test('missing translation falls back to the default language', () => {
  assert.equal(
    getLocalizedText(
      { ru: 'Кофе', en: 'Coffee' },
      'hy',
      'ru'
    ),
    'Кофе'
  )
})

test('invalid primary language is rejected', async () => {
  const data = structuredClone(await getMenu())
  data.restaurant.primaryLanguage = 'fr'

  assert.ok(
    validateMenu(data).some((error) =>
      error.includes('Primary language must be hy, ru, or en')
    )
  )
})

test('duplicate menu item IDs are detected', async () => {
  const data = structuredClone(await getMenu())
  data.menu.items.push({ ...data.menu.items[0] })

  assert.ok(
    validateMenu(data).some((error) =>
      error.includes('Duplicate menu item ID')
    )
  )
})

test('invalid currency codes are rejected', async () => {
  const data = structuredClone(await getMenu())
  data.menu.items[0].currency = 'US'

  assert.ok(
    validateMenu(data).some((error) =>
      error.includes('invalid currency code')
    )
  )
})

test('duplicate subcategory IDs are detected', async () => {
  const data = await getMenu()
  data.menu.subcategories.push({
    ...data.menu.subcategories[0]
  })

  const errors = validateMenu(data)

  assert.ok(
    errors.some((error) => error.includes('Duplicate subcategory ID'))
  )
})

test('subcategories referencing unknown categories are rejected', async () => {
  const data = await getMenu()
  data.menu.subcategories[0].parentCategoryId = 'unknown-category'

  const errors = validateMenu(data)

  assert.ok(
    errors.some((error) =>
      error.includes('references an unknown parent category')
    )
  )
})

test('items referencing unknown subcategories are rejected', async () => {
  const data = await getMenu()
  data.menu.items[0].subcategoryId = 'unknown-subcategory'

  const errors = validateMenu(data)

  assert.ok(
    errors.some((error) =>
      error.includes('references an unknown subcategory')
    )
  )
})

test('items cannot reference subcategories from another category', async () => {
  const data = await getMenu()
  data.menu.items[0].subcategoryId = 'cakes'

  const errors = validateMenu(data)

  assert.ok(
    errors.some((error) =>
      error.includes('belonging to another category')
    )
  )
})

test('legacy menus without subcategories remain valid', async () => {
  const data = await getMenu()

  delete data.menu.subcategories

  for (const item of data.menu.items) {
    delete item.subcategoryId
  }

  assert.deepEqual(validateMenu(data), [])
})
