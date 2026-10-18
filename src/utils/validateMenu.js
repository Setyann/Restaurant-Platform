const SUPPORTED_LANGUAGES = ['hy', 'ru', 'en']

export function validateMenu(data) {
  const errors = []

  if (!data || typeof data !== 'object') {
    return ['Menu data must be an object.']
  }

  const { restaurant, menu } = data

  if (!restaurant || typeof restaurant !== 'object') {
    errors.push('Restaurant data is missing.')
  } else {
    if (!restaurant.id) {
      errors.push('Restaurant ID is missing.')
    }

    if (!restaurant.name || typeof restaurant.name !== 'object') {
      errors.push('Restaurant name is missing.')
    }

    if (!SUPPORTED_LANGUAGES.includes(restaurant.primaryLanguage)) {
      errors.push('Primary language must be hy, ru, or en.')
    }

    if (
      !Array.isArray(restaurant.supportedLanguages) ||
      restaurant.supportedLanguages.length === 0
    ) {
      errors.push('Supported languages must be a non-empty array.')
    } else {
      for (const language of restaurant.supportedLanguages) {
        if (!SUPPORTED_LANGUAGES.includes(language)) {
          errors.push(`Unsupported language: ${language}`)
        }
      }

      if (!restaurant.supportedLanguages.includes(restaurant.primaryLanguage)) {
        errors.push('Primary language must be supported.')
      }
    }
  }

  if (!menu || typeof menu !== 'object') {
    errors.push('Menu data is missing.')
    return errors
  }

  if (!Array.isArray(menu.categories)) {
    errors.push('Menu categories must be an array.')
  }

  if (!Array.isArray(menu.items)) {
    errors.push('Menu items must be an array.')
  }

  if (
    !Array.isArray(menu.categories) ||
    !Array.isArray(menu.items)
  ) {
    return errors
  }

  if (
    menu.subcategories !== undefined &&
    !Array.isArray(menu.subcategories)
  ) {
    errors.push('Menu subcategories must be an array when provided.')
  }

  const categories = menu.categories
  const subcategories = Array.isArray(menu.subcategories)
    ? menu.subcategories
    : []

  const categoryIds = new Set()

  for (const category of categories) {
    if (!category || !category.id || typeof category.id !== 'string') {
      errors.push('Every category must have a string ID.')
      continue
    }

    if (categoryIds.has(category.id)) {
      errors.push(`Duplicate category ID: ${category.id}`)
    }

    categoryIds.add(category.id)

    if (!category.name || typeof category.name !== 'object') {
      errors.push(`Category "${category.id}" has no valid name.`)
    }
  }

  const subcategoryIds = new Set()
  const subcategoriesById = new Map()

  for (const subcategory of subcategories) {
    if (
      !subcategory ||
      !subcategory.id ||
      typeof subcategory.id !== 'string'
    ) {
      errors.push('Every subcategory must have a string ID.')
      continue
    }

    if (subcategoryIds.has(subcategory.id)) {
      errors.push(`Duplicate subcategory ID: ${subcategory.id}`)
    }

    subcategoryIds.add(subcategory.id)
    subcategoriesById.set(subcategory.id, subcategory)

    if (!categoryIds.has(subcategory.parentCategoryId)) {
      errors.push(
        `Subcategory "${subcategory.id}" references an unknown parent category.`
      )
    }

    if (!subcategory.name || typeof subcategory.name !== 'object') {
      errors.push(`Subcategory "${subcategory.id}" has no valid name.`)
    }
  }

  const itemIds = new Set()

  for (const item of menu.items) {
    if (!item || !item.id || typeof item.id !== 'string') {
      errors.push('Every menu item must have a string ID.')
      continue
    }

    if (itemIds.has(item.id)) {
      errors.push(`Duplicate menu item ID: ${item.id}`)
    }

    itemIds.add(item.id)

    if (!categoryIds.has(item.categoryId)) {
      errors.push(`Item "${item.id}" references an unknown category.`)
    }

    if (item.subcategoryId !== undefined && item.subcategoryId !== null) {
      const subcategory = subcategoriesById.get(item.subcategoryId)

      if (!subcategory) {
        errors.push(
          `Item "${item.id}" references an unknown subcategory.`
        )
      } else if (subcategory.parentCategoryId !== item.categoryId) {
        errors.push(
          `Item "${item.id}" references a subcategory belonging to another category.`
        )
      }
    }

    if (!item.name || typeof item.name !== 'object') {
      errors.push(`Item "${item.id}" has no valid name.`)
    }

    if (
      typeof item.price !== 'number' ||
      !Number.isFinite(item.price) ||
      item.price < 0
    ) {
      errors.push(`Item "${item.id}" has an invalid price.`)
    }

    if (
      typeof item.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(item.currency)
    ) {
      errors.push(`Item "${item.id}" has an invalid currency code.`)
    }

    if (typeof item.isAvailable !== 'boolean') {
      errors.push(
        `Item "${item.id}" must define isAvailable as a boolean.`
      )
    }
  }

  return errors
}