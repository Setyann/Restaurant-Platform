-- =====================================================================
-- Plans (free / standard) + ordering + staff window
-- Run in Supabase: SQL Editor -> paste -> Run.  Run ONCE.
-- Assumes existing tables: restaurants(id uuid, slug), restaurant_members
-- (restaurant_id, user_id, role), menus(id, restaurant_id, status, version),
-- menu_items, item_variants (as used by src/services/menuService.js).
-- =====================================================================
BEGIN;

-- 1. Plan on each restaurant -------------------------------------------
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free', 'standard'));

-- Restaurant staff must not be able to upgrade themselves through the API.
-- (The SQL editor and service role are not blocked.)
CREATE OR REPLACE FUNCTION public.protect_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan
     AND coalesce(auth.role(), '') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'plan_change_forbidden';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_plan ON public.restaurants;
CREATE TRIGGER protect_plan BEFORE UPDATE ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.protect_plan();

-- 2. Orders -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_number  integer NOT NULL,
  table_label   text NOT NULL CHECK (char_length(table_label) BETWEEN 1 AND 20),
  note          text CHECK (note IS NULL OR char_length(note) <= 300),
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'preparing', 'ready', 'served', 'cancelled')),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total         numeric(12, 2) NOT NULL CHECK (total >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, order_number)
);

CREATE TABLE IF NOT EXISTS public.order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  item_source_id text NOT NULL,
  name           jsonb NOT NULL,        -- snapshot: later menu edits don't rewrite history
  variant_name   jsonb,
  unit_price     numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 20)
);

CREATE INDEX IF NOT EXISTS orders_board_idx
  ON public.orders (restaurant_id, status, created_at);
CREATE INDEX IF NOT EXISTS order_items_order_idx
  ON public.order_items (order_id);

-- 3. Row Level Security: nobody writes directly, staff may read ---------
CREATE OR REPLACE FUNCTION public.is_staff_of(p_restaurant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.restaurant_id = p_restaurant
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'editor', 'staff')
  )
$$;

ALTER TABLE public.orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_select_staff ON public.orders;
CREATE POLICY orders_select_staff ON public.orders
  FOR SELECT TO authenticated
  USING (public.is_staff_of(restaurant_id));

DROP POLICY IF EXISTS order_items_select_staff ON public.order_items;
CREATE POLICY order_items_select_staff ON public.order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_items.order_id AND public.is_staff_of(o.restaurant_id)
  ));

REVOKE ALL ON public.orders, public.order_items FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.orders, public.order_items FROM authenticated;

-- 4. place_order: the ONLY way a guest creates an order -----------------
-- Prices come from the database, never from the browser.
CREATE OR REPLACE FUNCTION public.place_order(
  p_slug text, p_table text, p_note text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r          record;
  v_menu     uuid;
  v_num      integer;
  v_order    uuid;
  v_total    numeric(12, 2) := 0;
  v_currency text;
  v_lines    jsonb := '[]'::jsonb;
  line       jsonb;
  mi         record;
  vr         record;
  v_qty      integer;
  v_price    numeric;
  v_cur      text;
  v_vname    jsonb;
BEGIN
  SELECT id, plan INTO r FROM restaurants WHERE slug = p_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'restaurant_not_found'; END IF;
  IF r.plan <> 'standard' THEN RAISE EXCEPTION 'plan_not_allowed'; END IF;

  p_table := btrim(coalesce(p_table, ''));
  IF char_length(p_table) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_table'; END IF;
  p_note := nullif(left(btrim(coalesce(p_note, '')), 300), '');

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  SELECT id INTO v_menu FROM menus
   WHERE restaurant_id = r.id AND status = 'published'
   ORDER BY version DESC LIMIT 1;
  IF v_menu IS NULL THEN RAISE EXCEPTION 'menu_not_published'; END IF;

  FOR line IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_qty := (line->>'qty')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_items';
    END;
    IF v_qty IS NULL OR v_qty NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_items'; END IF;

    SELECT * INTO mi FROM menu_items
     WHERE menu_id = v_menu AND source_id = (line->>'item');
    IF NOT FOUND OR mi.is_available IS NOT TRUE THEN RAISE EXCEPTION 'item_unavailable'; END IF;

    IF nullif(line->>'variant', '') IS NOT NULL THEN
      SELECT * INTO vr FROM item_variants
       WHERE menu_id = v_menu AND item_id = mi.id AND source_id = (line->>'variant');
      IF NOT FOUND THEN RAISE EXCEPTION 'item_unavailable'; END IF;
      v_price := vr.price; v_cur := vr.currency; v_vname := vr.name;
    ELSE
      IF EXISTS (SELECT 1 FROM item_variants WHERE item_id = mi.id) THEN
        RAISE EXCEPTION 'invalid_items';
      END IF;
      IF mi.price IS NULL THEN RAISE EXCEPTION 'invalid_items'; END IF;
      v_price := mi.price; v_cur := mi.currency; v_vname := NULL;
    END IF;

    IF v_currency IS NULL THEN v_currency := v_cur;
    ELSIF v_currency <> v_cur THEN RAISE EXCEPTION 'invalid_items';
    END IF;

    v_total := v_total + v_price * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'item_source_id', mi.source_id, 'name', mi.name, 'variant_name', v_vname,
      'unit_price', v_price, 'quantity', v_qty);
  END LOOP;

  -- one order number at a time per restaurant
  PERFORM pg_advisory_xact_lock(hashtext(r.id::text));
  SELECT coalesce(max(o.order_number), 0) + 1 INTO v_num
    FROM orders o WHERE o.restaurant_id = r.id;

  INSERT INTO orders (restaurant_id, order_number, table_label, note, currency, total)
  VALUES (r.id, v_num, p_table, p_note, v_currency, v_total)
  RETURNING id INTO v_order;

  INSERT INTO order_items (order_id, item_source_id, name, variant_name, unit_price, quantity)
  SELECT v_order, x.item_source_id, x.name, x.variant_name, x.unit_price, x.quantity
    FROM jsonb_to_recordset(v_lines) AS x(
      item_source_id text, name jsonb, variant_name jsonb, unit_price numeric, quantity integer);

  RETURN jsonb_build_object(
    'order_id', v_order, 'order_number', v_num, 'total', v_total, 'currency', v_currency);
END $$;

-- 5. set_order_status: staff moves an order forward ---------------------
CREATE OR REPLACE FUNCTION public.set_order_status(p_order uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o  record;
  ok boolean;
BEGIN
  SELECT id, restaurant_id, status INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND OR NOT public.is_staff_of(o.restaurant_id) THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  ok := (o.status = 'new'       AND p_status IN ('preparing', 'cancelled'))
     OR (o.status = 'preparing' AND p_status IN ('ready', 'cancelled'))
     OR (o.status = 'ready'     AND p_status IN ('served', 'cancelled'));
  IF NOT ok THEN RAISE EXCEPTION 'invalid_transition'; END IF;

  UPDATE orders SET status = p_status, updated_at = now() WHERE id = p_order;
END $$;

-- 6. Who may call what ---------------------------------------------------
REVOKE ALL ON FUNCTION public.place_order(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_order_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_order_status(uuid, text) TO authenticated;

COMMIT;

-- =====================================================================
-- After running: give a restaurant the Standard plan (SQL editor only):
--   UPDATE public.restaurants SET plan = 'standard' WHERE slug = 'demo';
-- Back to Free:
--   UPDATE public.restaurants SET plan = 'free' WHERE slug = 'demo';
-- =====================================================================
