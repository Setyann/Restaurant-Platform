-- =====================================================================
-- Restaurant Platform: plans, 3 roles, secure admin, ordering, anti-spam
--
--   Roles
--     user  = guest, no account (anon). Reads the published menu; on the
--             Standard plan orders and sees order status.
--     staff = account with role 'staff'  -> sees/updates orders only.
--     owner = account with role 'owner'  -> edits menu, tables, staff.
--   Plans   free (view only) | standard (ordering + staff window). No payments.
--
-- Run ONCE in Supabase -> SQL Editor. Safe to re-run (idempotent).
-- READ FIRST: it REPLACES all RLS policies on the platform tables listed in
-- section 5, and turns old 'editor' members into 'staff'.
-- Test on a copy/test project before production.
-- =====================================================================
BEGIN;

-- 0. Private settings (keyed-hash secret for rate limiting) --------------
CREATE TABLE IF NOT EXISTS public.private_settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);
ALTER TABLE public.private_settings ENABLE ROW LEVEL SECURITY;      -- no policies = no access
REVOKE ALL ON public.private_settings FROM anon, authenticated;
INSERT INTO public.private_settings (key, value)
VALUES ('rate_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (key) DO NOTHING;

-- 1. restaurants: plan + mandatory 2FA switch -----------------------------
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS require_mfa boolean NOT NULL DEFAULT true;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'restaurants_plan_check'
                   AND conrelid = 'public.restaurants'::regclass) THEN
    ALTER TABLE public.restaurants
      ADD CONSTRAINT restaurants_plan_check CHECK (plan IN ('free', 'standard'));
  END IF;
END $$;

-- 2. Members: only 'owner' and 'staff' -------------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.restaurant_members'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.restaurant_members DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE public.restaurant_members SET role = 'staff' WHERE role NOT IN ('owner', 'staff');
ALTER TABLE public.restaurant_members
  ADD CONSTRAINT restaurant_members_role_check CHECK (role IN ('owner', 'staff'));

-- 3. Tables with QR tokens, audit log, orders -------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  label         text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 20),
  token         text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, label)
);

CREATE TABLE IF NOT EXISTS public.menu_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id uuid,
  user_id       uuid,
  table_name    text NOT NULL,
  action        text NOT NULL,
  row_id        text,
  old_row       jsonb,
  new_row       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS menu_audit_restaurant_idx
  ON public.menu_audit (restaurant_id, created_at DESC);

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
  name           jsonb NOT NULL,
  variant_name   jsonb,
  unit_price     numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 20)
);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS table_id    uuid REFERENCES public.restaurant_tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS request_id  uuid,
  ADD COLUMN IF NOT EXISTS client_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS orders_request_uidx
  ON public.orders (restaurant_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_board_idx  ON public.orders (restaurant_id, status, created_at);
CREATE INDEX IF NOT EXISTS orders_table_idx  ON public.orders (table_id, created_at);
CREATE INDEX IF NOT EXISTS orders_client_idx ON public.orders (restaurant_id, client_hash, created_at);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON public.order_items (order_id);

-- 4. Helper functions --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_owner_of(p_restaurant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.restaurant_id = p_restaurant AND m.user_id = auth.uid() AND m.role = 'owner')
$$;

CREATE OR REPLACE FUNCTION public.is_staff_of(p_restaurant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.restaurant_id = p_restaurant AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'staff'))
$$;

-- Owner AND (2FA verified session, unless the restaurant switched 2FA off).
-- A stolen password alone can therefore never change anything.
CREATE OR REPLACE FUNCTION public.owner_can_write(p_restaurant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_owner_of(p_restaurant)
     AND ( NOT coalesce((SELECT r.require_mfa FROM public.restaurants r WHERE r.id = p_restaurant), true)
           OR coalesce(auth.jwt() ->> 'aal', '') = 'aal2' )
$$;

CREATE OR REPLACE FUNCTION public.menu_restaurant(p_menu uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT restaurant_id FROM public.menus WHERE id = p_menu
$$;

CREATE OR REPLACE FUNCTION public.menu_published(p_menu uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.menus WHERE id = p_menu AND status = 'published')
$$;

-- i18n JSON: {"hy": "...", "ru": "...", "en": "..."}, strings only
CREATE OR REPLACE FUNCTION public.valid_i18n(v jsonb, p_max integer, p_required boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL
     AND jsonb_typeof(v) = 'object'
     AND char_length(v::text) <= p_max
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(v) e
                     WHERE e.key NOT IN ('hy', 'ru', 'en') OR jsonb_typeof(e.value) <> 'string')
     AND ( NOT p_required
           OR EXISTS (SELECT 1 FROM jsonb_each_text(v) e WHERE btrim(e.value) <> '') )
$$;

-- 5. Row Level Security: drop every old policy, then define exactly ours ------
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename IN ('restaurants', 'restaurant_members', 'menus', 'categories',
                               'subcategories', 'menu_items', 'item_variants', 'restaurant_tables',
                               'menu_audit', 'orders', 'order_items')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

ALTER TABLE public.restaurants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menus              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subcategories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_variants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_tables  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_audit         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items        ENABLE ROW LEVEL SECURITY;

-- restaurants / members / menus: read only (changes happen via SQL or RPC)
CREATE POLICY restaurants_read ON public.restaurants
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY members_read ON public.restaurant_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_owner_of(restaurant_id));

CREATE POLICY menus_read_published ON public.menus
  FOR SELECT TO anon, authenticated USING (status = 'published');
CREATE POLICY menus_read_owner ON public.menus
  FOR SELECT TO authenticated USING (public.is_owner_of(restaurant_id));

-- menu content: everyone reads published; only a 2FA-verified owner writes
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories', 'subcategories', 'menu_items', 'item_variants'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated
                    USING (public.menu_published(menu_id))', t || '_read_published', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
                    USING (public.is_owner_of(public.menu_restaurant(menu_id)))', t || '_read_owner', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
                    WITH CHECK (public.owner_can_write(public.menu_restaurant(menu_id)))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
                    USING (public.owner_can_write(public.menu_restaurant(menu_id)))
                    WITH CHECK (public.owner_can_write(public.menu_restaurant(menu_id)))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
                    USING (public.owner_can_write(public.menu_restaurant(menu_id)))', t || '_delete', t);
  END LOOP;
END $$;

-- tables (QR tokens): owner only
CREATE POLICY tables_read ON public.restaurant_tables
  FOR SELECT TO authenticated USING (public.is_owner_of(restaurant_id));
CREATE POLICY tables_insert ON public.restaurant_tables
  FOR INSERT TO authenticated WITH CHECK (public.owner_can_write(restaurant_id));
CREATE POLICY tables_update ON public.restaurant_tables
  FOR UPDATE TO authenticated
  USING (public.owner_can_write(restaurant_id)) WITH CHECK (public.owner_can_write(restaurant_id));
CREATE POLICY tables_delete ON public.restaurant_tables
  FOR DELETE TO authenticated USING (public.owner_can_write(restaurant_id));

-- audit log: owner reads, nobody writes directly (triggers do)
CREATE POLICY audit_read ON public.menu_audit
  FOR SELECT TO authenticated USING (public.is_owner_of(restaurant_id));

-- orders: staff and owner read; all changes go through functions
CREATE POLICY orders_read ON public.orders
  FOR SELECT TO authenticated USING (public.is_staff_of(restaurant_id));
CREATE POLICY order_items_read ON public.order_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o
                 WHERE o.id = order_items.order_id AND public.is_staff_of(o.restaurant_id)));

-- Table privileges (defence in depth on top of RLS)
REVOKE ALL ON public.restaurant_members, public.restaurant_tables, public.menu_audit,
              public.orders, public.order_items FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.restaurant_members, public.menu_audit,
              public.orders, public.order_items, public.menus FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.restaurants, public.menus FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.restaurants FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.categories, public.subcategories,
              public.menu_items, public.item_variants FROM anon;

-- 6. Triggers: protect restaurant columns, table tokens, audit log -------------
DROP TRIGGER IF EXISTS protect_plan ON public.restaurants;

CREATE OR REPLACE FUNCTION public.protect_restaurant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND ( NEW.id IS DISTINCT FROM OLD.id OR NEW.slug IS DISTINCT FROM OLD.slug
        OR NEW.plan IS DISTINCT FROM OLD.plan
        OR NEW.require_mfa IS DISTINCT FROM OLD.require_mfa ) THEN
    RAISE EXCEPTION 'restricted_column';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_restaurant ON public.restaurants;
CREATE TRIGGER protect_restaurant BEFORE UPDATE ON public.restaurants
  FOR EACH ROW EXECUTE FUNCTION public.protect_restaurant();

CREATE OR REPLACE FUNCTION public.guard_table_token()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.token := replace(gen_random_uuid()::text, '-', '');   -- never client-chosen
    NEW.label := btrim(NEW.label);
  ELSIF NEW.token IS DISTINCT FROM OLD.token
        AND coalesce(current_setting('app.rotating', true), '') <> 'on' THEN
    NEW.token := OLD.token;                                    -- only rotate_table_token() may change it
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_table_token ON public.restaurant_tables;
CREATE TRIGGER guard_table_token BEFORE INSERT OR UPDATE ON public.restaurant_tables
  FOR EACH ROW EXECUTE FUNCTION public.guard_table_token();

CREATE OR REPLACE FUNCTION public.log_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_new  jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_old  jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_rest uuid;
BEGIN
  IF TG_TABLE_NAME IN ('restaurant_tables', 'restaurant_members') THEN
    v_rest := coalesce(v_new ->> 'restaurant_id', v_old ->> 'restaurant_id')::uuid;
  ELSE
    v_rest := public.menu_restaurant(coalesce(v_new ->> 'menu_id', v_old ->> 'menu_id')::uuid);
  END IF;

  IF TG_TABLE_NAME = 'restaurant_tables' THEN        -- tokens never go into the log
    v_new := v_new - 'token';
    v_old := v_old - 'token';
  END IF;

  INSERT INTO public.menu_audit (restaurant_id, user_id, table_name, action, row_id, old_row, new_row)
  VALUES (v_rest, auth.uid(), TG_TABLE_NAME, TG_OP,
          coalesce(v_new ->> 'id', v_old ->> 'id'), v_old, v_new);
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories', 'subcategories', 'menu_items', 'item_variants',
                           'restaurant_tables', 'restaurant_members'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS log_change ON public.%I', t);
    EXECUTE format('CREATE TRIGGER log_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.log_change()', t);
  END LOOP;
END $$;

-- 7. Data validation (NOT VALID = applies to new/changed rows, old data untouched)
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('categories',    'chk_categories_name',      'public.valid_i18n(name, 300, true)'),
    ('subcategories', 'chk_subcategories_name',   'public.valid_i18n(name, 300, true)'),
    ('menu_items',    'chk_items_name',           'public.valid_i18n(name, 300, true)'),
    ('menu_items',    'chk_items_description',    'description IS NULL OR public.valid_i18n(description, 1500, false)'),
    ('menu_items',    'chk_items_price',          'price IS NULL OR (price >= 0 AND price <= 100000000)'),
    ('menu_items',    'chk_items_currency',       $c$currency IS NULL OR currency ~ '^[A-Z]{3}$'$c$),
    ('menu_items',    'chk_items_image',          $c$image IS NULL OR (image ~ '^https://' AND char_length(image) <= 500)$c$),
    ('item_variants', 'chk_variants_name',        'public.valid_i18n(name, 300, true)'),
    ('item_variants', 'chk_variants_price',       'price >= 0 AND price <= 100000000'),
    ('item_variants', 'chk_variants_currency',    $c$currency ~ '^[A-Z]{3}$'$c$)
  ) AS v(tbl, cname, expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = c.cname AND conrelid = ('public.' || c.tbl)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tbl, c.cname, c.expr);
    END IF;
  END LOOP;
END $$;

-- 8. place_order: the ONLY way a guest creates an order -------------------------
DROP FUNCTION IF EXISTS public.place_order(text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.place_order(
  p_slug text, p_table_token text, p_note text, p_items jsonb, p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r          record;
  t          record;
  ex         record;
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
  v_headers  jsonb;
  v_ip       text;
  v_client   text;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'invalid_items'; END IF;

  SELECT id, plan INTO r FROM restaurants WHERE slug = p_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'restaurant_not_found'; END IF;
  IF r.plan <> 'standard' THEN RAISE EXCEPTION 'plan_not_allowed'; END IF;

  -- one order at a time per restaurant: consistent limits and numbering
  PERFORM pg_advisory_xact_lock(hashtext(r.id::text));

  -- retry of the same submission returns the same order (no duplicates)
  SELECT o.id, o.order_number, o.total, o.currency, o.table_label INTO ex
    FROM orders o WHERE o.restaurant_id = r.id AND o.request_id = p_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object('order_id', ex.id, 'order_number', ex.order_number,
      'total', ex.total, 'currency', ex.currency, 'table_label', ex.table_label);
  END IF;

  -- the table comes from the QR token, not from free text
  SELECT id, label INTO t FROM restaurant_tables
   WHERE restaurant_id = r.id AND token = p_table_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_table_token'; END IF;

  p_note := nullif(left(btrim(coalesce(p_note, '')), 300), '');
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  -- caller fingerprint (keyed hash; best effort, a whole restaurant may share one IP)
  BEGIN
    v_headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  EXCEPTION WHEN others THEN
    v_headers := '{}'::jsonb;
  END;
  v_ip := coalesce(nullif(v_headers ->> 'cf-connecting-ip', ''),
                   nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
                   'unknown');
  v_client := md5(v_ip || coalesce((SELECT value FROM private_settings WHERE key = 'rate_secret'), ''));

  -- anti-spam limits
  IF (SELECT count(*) FROM orders
       WHERE table_id = t.id AND status IN ('new', 'preparing', 'ready')) >= 3 THEN
    RAISE EXCEPTION 'table_busy';
  END IF;
  IF (SELECT count(*) FROM orders
       WHERE table_id = t.id AND created_at > now() - interval '1 hour') >= 12 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT count(*) FROM orders
       WHERE restaurant_id = r.id AND client_hash = v_client
         AND created_at > now() - interval '10 minutes') >= 40 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT count(*) FROM orders WHERE restaurant_id = r.id AND status = 'new') >= 60 THEN
    RAISE EXCEPTION 'restaurant_busy';
  END IF;

  SELECT id INTO v_menu FROM menus
   WHERE restaurant_id = r.id AND status = 'published'
   ORDER BY version DESC LIMIT 1;
  IF v_menu IS NULL THEN RAISE EXCEPTION 'menu_not_published'; END IF;

  FOR line IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_qty := (line ->> 'qty')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_items';
    END;
    IF v_qty IS NULL OR v_qty NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_items'; END IF;

    SELECT * INTO mi FROM menu_items WHERE menu_id = v_menu AND source_id = (line ->> 'item');
    IF NOT FOUND OR mi.is_available IS NOT TRUE THEN RAISE EXCEPTION 'item_unavailable'; END IF;

    IF nullif(line ->> 'variant', '') IS NOT NULL THEN
      SELECT * INTO vr FROM item_variants
       WHERE menu_id = v_menu AND item_id = mi.id AND source_id = (line ->> 'variant');
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

  SELECT coalesce(max(o.order_number), 0) + 1 INTO v_num
    FROM orders o WHERE o.restaurant_id = r.id;

  INSERT INTO orders (restaurant_id, order_number, table_id, table_label, note,
                      currency, total, request_id, client_hash)
  VALUES (r.id, v_num, t.id, t.label, p_note, v_currency, v_total, p_request_id, v_client)
  RETURNING id INTO v_order;

  INSERT INTO order_items (order_id, item_source_id, name, variant_name, unit_price, quantity)
  SELECT v_order, x.item_source_id, x.name, x.variant_name, x.unit_price, x.quantity
    FROM jsonb_to_recordset(v_lines) AS x(
      item_source_id text, name jsonb, variant_name jsonb, unit_price numeric, quantity integer);

  RETURN jsonb_build_object('order_id', v_order, 'order_number', v_num,
    'total', v_total, 'currency', v_currency, 'table_label', t.label);
END $$;

-- 9. Order status: visible to everyone who knows the (unguessable) order id ------
CREATE OR REPLACE FUNCTION public.get_order_status(p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('order_number', o.order_number, 'status', o.status,
                            'table_label', o.table_label, 'updated_at', o.updated_at)
    FROM orders o WHERE o.id = p_order
$$;

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

-- 10. Owner functions: staff and QR tokens ------------------------------------------
CREATE OR REPLACE FUNCTION public.list_staff(p_restaurant uuid)
RETURNS TABLE (user_id uuid, email text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_owner_of(p_restaurant) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  RETURN QUERY
    SELECT m.user_id, u.email::text, m.role
      FROM public.restaurant_members m
      JOIN auth.users u ON u.id = m.user_id
     WHERE m.restaurant_id = p_restaurant
     ORDER BY m.role, u.email;
END $$;

CREATE OR REPLACE FUNCTION public.add_staff(p_restaurant uuid, p_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid;
BEGIN
  IF NOT public.owner_can_write(p_restaurant) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  SELECT id INTO v_user FROM auth.users WHERE lower(email) = lower(btrim(p_email));
  IF v_user IS NULL THEN RAISE EXCEPTION 'user_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.restaurant_members
              WHERE restaurant_id = p_restaurant AND user_id = v_user) THEN
    RAISE EXCEPTION 'already_member';
  END IF;
  INSERT INTO public.restaurant_members (restaurant_id, user_id, role)
  VALUES (p_restaurant, v_user, 'staff');
END $$;

CREATE OR REPLACE FUNCTION public.remove_staff(p_restaurant uuid, p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.owner_can_write(p_restaurant) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  DELETE FROM public.restaurant_members
   WHERE restaurant_id = p_restaurant AND user_id = p_user AND role = 'staff';
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rotate_table_token(p_table uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rest  uuid;
  v_token text := replace(gen_random_uuid()::text, '-', '');
BEGIN
  SELECT restaurant_id INTO v_rest FROM public.restaurant_tables WHERE id = p_table;
  IF v_rest IS NULL OR NOT public.owner_can_write(v_rest) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  PERFORM set_config('app.rotating', 'on', true);
  UPDATE public.restaurant_tables SET token = v_token WHERE id = p_table;
  PERFORM set_config('app.rotating', 'off', true);
  RETURN v_token;
END $$;

-- 11. Who may call which function --------------------------------------------------------
REVOKE ALL ON FUNCTION public.place_order(text, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_status(uuid)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_order_status(uuid, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_staff(uuid)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_staff(uuid, text)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_staff(uuid, uuid)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_table_token(uuid)                   FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.place_order(text, text, text, jsonb, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_status(uuid)                     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_order_status(uuid, text)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_staff(uuid)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_staff(uuid, text)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_staff(uuid, uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_table_token(uuid)                   TO authenticated;


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

-- =====================================================================
-- Afterwards (SQL editor only — the API cannot do these):
--   Standard plan:  UPDATE public.restaurants SET plan = 'standard' WHERE slug = 'demo';
--   Free plan:      UPDATE public.restaurants SET plan = 'free'     WHERE slug = 'demo';
--   Make an owner:  INSERT INTO public.restaurant_members (restaurant_id, user_id, role)
--                   SELECT r.id, u.id, 'owner' FROM public.restaurants r, auth.users u
--                   WHERE r.slug = 'demo' AND u.email = 'owner@example.com';
--   Dashboard: Authentication -> disable "Allow new users to sign up".
-- =====================================================================
