-- =====================================================================
-- 002: explicit table privileges. RLS policies only apply on top of GRANTs.
-- Safe to run more than once. Run after 001_roles_security_orders.sql.
-- =====================================================================
BEGIN;

-- Guests: read the published menu (RLS limits rows to published menus)
GRANT SELECT ON public.restaurants, public.menus, public.categories,
               public.subcategories, public.menu_items, public.item_variants TO anon;

-- Signed-in users (owner / staff): read what their RLS policies allow
GRANT SELECT ON public.restaurants, public.restaurant_members, public.menus,
               public.categories, public.subcategories, public.menu_items,
               public.item_variants, public.restaurant_tables,
               public.menu_audit, public.orders, public.order_items TO authenticated;

-- Owner menu editing: RLS (owner_can_write) decides which rows; privileges just allow the verbs
GRANT INSERT, UPDATE, DELETE ON public.categories, public.subcategories,
               public.menu_items, public.item_variants,
               public.restaurant_tables TO authenticated;

COMMIT;
