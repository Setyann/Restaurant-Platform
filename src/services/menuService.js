const menuFiles = import.meta.glob(
  '../data/restaurants/*/menu.json',
  {
    eager: true,
    import: 'default'
  }
)

const restaurants = Object.values(menuFiles)

export function getRestaurants() {
  return restaurants.map(({ restaurant }) => restaurant)
}

export function getMenu(slug) {
  if (!slug) {
    return null
  }

  return (
    restaurants.find(
      (data) => data.restaurant.slug === slug
    ) ?? null
  )
}