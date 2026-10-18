import test from 'node:test'
import assert from 'node:assert/strict'

import { validateMenu } from '../src/utils/validateMenu.js'
import { escapeHtml } from '../src/utils/escapeHtml.js'
import { readFile } from 'node:fs/promises'

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