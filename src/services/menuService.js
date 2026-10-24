
import { supabase } from './supabaseClient.js'

const menuFiles = import.meta.glob(
  '../data/restaurants/*/menu.json',
  {
    eager: true,
    import: 'default'
  }
)

const localMenus = Object.values(menuFiles)

function getLocalMenu(slug) {
  return localMenus.find(
    (data) => data.restaurant.slug === slug
  ) ?? null
}

export function getRestaurants() {
  return localMenus.map(({ restaurant }) => restaurant)
}

export async function getMenu(slug) {
  if (!slug) return null

  const localMenu = getLocalMenu(slug)

  try {
    const { data: restaurant, error: restaurantError } =
      await supabase
        .from('restaurants')
        .select('id, plan')
        .eq('slug', slug)
        .maybeSingle()

    if (restaurantError || !restaurant) {
      return localMenu
    }

    const { data: publishedMenu, error: menuError } =
      await supabase
        .from('menus')
        .select('id')
        .eq('restaurant_id', restaurant.id)
        .eq('status', 'published')
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (menuError || !publishedMenu) {
      return localMenu
    }

    const menuId = publishedMenu.id

    const [
      categoriesResult,
      subcategoriesResult,
      itemsResult,
      variantsResult
    ] = await Promise.all([
      supabase
        .from('categories')
        .select('id, source_id, name, sort_order')
        .eq('menu_id', menuId)
        .order('sort_order'),

      supabase
        .from('subcategories')
        .select('id, source_id, category_id, name, sort_order')
        .eq('menu_id', menuId)
        .order('sort_order'),

      supabase
        .from('menu_items')
        .select('id, source_id, category_id, subcategory_id, name, description, price, currency, image, is_available, sort_order')
        .eq('menu_id', menuId)
        .order('sort_order'),

      supabase
        .from('item_variants')
        .select('id, source_id, item_id, name, price, currency, sort_order')
        .eq('menu_id', menuId)
        .order('sort_order')
    ])

    const results = [
      categoriesResult,
      subcategoriesResult,
      itemsResult,
      variantsResult
    ]

    const failedQuery = results.find((result) => result.error)

    if (failedQuery) {
      console.error('Failed to load published menu:', failedQuery.error)
      return localMenu
    }

    const categories = categoriesResult.data.map((category) => ({
      id: category.source_id,
      name: category.name,
      sortOrder: category.sort_order
    }))

    const subcategories = subcategoriesResult.data.map((subcategory) => ({
      id: subcategory.source_id,
      parentCategoryId:
        categoriesResult.data.find(
          (category) => category.id === subcategory.category_id
        )?.source_id,
      name: subcategory.name,
      sortOrder: subcategory.sort_order
    }))

    const items = itemsResult.data.map((item) => ({
      id: item.source_id,
      categoryId:
        categoriesResult.data.find(
          (category) => category.id === item.category_id
        )?.source_id,
      subcategoryId:
        subcategoriesResult.data.find(
          (subcategory) => subcategory.id === item.subcategory_id
        )?.source_id ?? null,
      name: item.name,
      description: item.description,
      ...(item.price !== null
        ? { price: Number(item.price) }
        : {}),
      currency: item.currency,
      image: item.image,
      isAvailable: item.is_available,
      sortOrder: item.sort_order,
      variants: variantsResult.data
        .filter((variant) => variant.item_id === item.id)
        .map((variant) => ({
          id: variant.source_id,
          name: variant.name,
          price: Number(variant.price),
          currency: variant.currency,
          sortOrder: variant.sort_order
        }))
    }))

    return {
      plan: restaurant.plan ?? 'free',
      restaurant: localMenu?.restaurant ?? {
        slug,
        id: slug,
        name: { hy: slug, ru: slug, en: slug },
        description: { hy: '', ru: '', en: '' },
        primaryLanguage: 'hy',
        supportedLanguages: ['hy', 'ru', 'en'],
        branding: { logo: null, accentColor: '#386641' }
      },
      menu: {
        version: publishedMenu.version ?? 1,
        categories,
        subcategories,
        items
      }
    }
  } catch (error) {
    console.error('Supabase menu loading failed:', error)
    return localMenu
  }
}