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

    if (
      !SUPPORTED_LANGUAGES.includes(restaurant.primaryLanguage)
    ) {
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

      if (
        !restaurant.supportedLanguages.includes(
          restaurant.primaryLanguage
        )
      ) {
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

  if (!Array.isArray(menu.categories) || !Array.isArray(menu.items)) {
    return errors
  }

  const categoryIds = new Set()

  for (const category of menu.categories) {
    if (!category.id || typeof category.id !== 'string') {
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

  const itemIds = new Set()

  for (const item of menu.items) {
    if (!item.id || typeof item.id !== 'string') {
      errors.push('Every menu item must have a string ID.')
      continue
    }

    if (itemIds.has(item.id)) {
      errors.push(`Duplicate menu item ID: ${item.id}`)
    }

    itemIds.add(item.id)

    if (!categoryIds.has(item.categoryId)) {
      errors.push(
        `Item "${item.id}" references an unknown category.`
      )
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