-- =====================================================================
-- Verification for 001_roles_security_orders.sql
-- Run in the Supabase SQL Editor AFTER the migration, on a TEST project.
-- Everything is rolled back at the end: no data is kept.
--
-- Before running: Dashboard -> Authentication -> Users -> Add user (create two users,
--   tick Auto Confirm):
--   owner-test@example.com   and   staff-test@example.com
-- and make sure the restaurant 'demo' has at least one published menu item
-- WITHOUT variants. Expected result: every row in the final table is TRUE.
-- =====================================================================
BEGIN;

CREATE TEMP TABLE results (n serial, name text, ok boolean);

DO $$
DECLARE
  v_rest uuid; v_menu uuid; v_item uuid; v_sid text; v_price numeric;
  v_owner uuid; v_staff uuid; v_tbl uuid; v_token text;
  v_req uuid := gen_random_uuid();
  v_cnt int; v_ok boolean; res jsonb; res2 jsonb; i int;
  v_owner_claims text; v_staff_claims text;
BEGIN
  SELECT id INTO v_rest  FROM restaurants WHERE slug = 'demo';
  SELECT id INTO v_menu  FROM menus WHERE restaurant_id = v_rest AND status = 'published'
                          ORDER BY version DESC LIMIT 1;
  SELECT id, source_id, price INTO v_item, v_sid, v_price FROM menu_items mi
   WHERE mi.menu_id = v_menu AND mi.price IS NOT NULL AND mi.is_available
     AND NOT EXISTS (SELECT 1 FROM item_variants v WHERE v.item_id = mi.id) LIMIT 1;
  SELECT id INTO v_owner FROM auth.users WHERE email = 'owner-test@example.com';
  SELECT id INTO v_staff FROM auth.users WHERE email = 'staff-test@example.com';

  -- Fail early with a clear message instead of inserting NULL user ids.
  IF v_rest IS NULL THEN
    RAISE EXCEPTION 'Restaurant with slug demo not found. Create it first.';
  END IF;
  IF v_menu IS NULL OR v_item IS NULL THEN
    RAISE EXCEPTION 'Demo restaurant needs a published menu with one item without variants, price and is_available = true.';
  END IF;
  IF v_owner IS NULL OR v_staff IS NULL THEN
    RAISE EXCEPTION 'Create users owner-test@example.com and staff-test@example.com first: Authentication -> Users -> Add user (set a password, tick Auto Confirm). Missing: owner=% staff=%', v_owner IS NULL, v_staff IS NULL;
  END IF;

  INSERT INTO restaurant_members (restaurant_id, user_id, role)
  VALUES (v_rest, v_owner, 'owner'), (v_rest, v_staff, 'staff');
  UPDATE restaurants SET plan = 'standard' WHERE id = v_rest;
  INSERT INTO restaurant_tables (restaurant_id, label) VALUES (v_rest, 'T-test')
  RETURNING id, token INTO v_tbl, v_token;

  v_owner_claims := json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal1')::text;
  v_staff_claims := json_build_object('sub', v_staff, 'role', 'authenticated', 'aal', 'aal1')::text;

  -- 1. guest reads the menu
  SET LOCAL ROLE anon;
  SELECT count(*) INTO v_cnt FROM menu_items WHERE menu_id = v_menu;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('guest can read published menu', v_cnt > 0);

  -- 2. guest cannot change the menu
  SET LOCAL ROLE anon;
  BEGIN UPDATE menu_items SET price = 1 WHERE id = v_item; GET DIAGNOSTICS v_cnt = ROW_COUNT;
  EXCEPTION WHEN others THEN v_cnt := 0; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('guest cannot edit menu', v_cnt = 0);

  -- 3. staff cannot change the menu
  PERFORM set_config('request.jwt.claims', v_staff_claims, true);
  SET LOCAL ROLE authenticated;
  BEGIN UPDATE menu_items SET price = 1 WHERE id = v_item; GET DIAGNOSTICS v_cnt = ROW_COUNT;
  EXCEPTION WHEN others THEN v_cnt := 0; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('staff cannot edit menu', v_cnt = 0);

  -- 4. owner WITHOUT 2FA (aal1) cannot change the menu
  PERFORM set_config('request.jwt.claims', v_owner_claims, true);
  SET LOCAL ROLE authenticated;
  BEGIN UPDATE menu_items SET price = 1 WHERE id = v_item; GET DIAGNOSTICS v_cnt = ROW_COUNT;
  EXCEPTION WHEN others THEN v_cnt := 0; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('owner without 2FA cannot edit menu', v_cnt = 0);

  -- 5. owner WITH 2FA (aal2) can, and the change is logged
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE menu_items SET price = price WHERE id = v_item; GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('owner with 2FA can edit menu', v_cnt = 1);
  SELECT count(*) INTO v_cnt FROM menu_audit WHERE row_id = v_item::text AND user_id = v_owner;
  INSERT INTO results (name, ok) VALUES ('change is written to audit log', v_cnt >= 1);

  -- 6. nobody can upgrade the plan through the API
  SET LOCAL ROLE authenticated;
  BEGIN UPDATE restaurants SET plan = 'free' WHERE id = v_rest; GET DIAGNOSTICS v_cnt = ROW_COUNT;
  EXCEPTION WHEN others THEN v_cnt := 0; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('plan cannot be changed via API', v_cnt = 0);

  -- 7. guest places an order; price comes from the database
  SET LOCAL ROLE anon;
  res := place_order('demo', v_token, 'test',
           jsonb_build_array(jsonb_build_object('item', v_sid, 'variant', null, 'qty', 2)), v_req);
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('order total is calculated by the server',
    (res ->> 'total')::numeric = 2 * v_price);

  -- 8. retry with the same request id does not create a duplicate
  SET LOCAL ROLE anon;
  res2 := place_order('demo', v_token, 'test',
            jsonb_build_array(jsonb_build_object('item', v_sid, 'variant', null, 'qty', 2)), v_req);
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('same request id returns the same order',
    res ->> 'order_id' = res2 ->> 'order_id');

  -- 9. wrong QR token is rejected
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM place_order('demo', 'wrong-token', null,
      jsonb_build_array(jsonb_build_object('item', v_sid, 'variant', null, 'qty', 1)), gen_random_uuid());
    v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%invalid_table_token%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('wrong table token is rejected', v_ok);

  -- 10. spam: a table can have at most 3 active orders
  v_ok := false;
  SET LOCAL ROLE anon;
  FOR i IN 1..4 LOOP
    BEGIN
      PERFORM place_order('demo', v_token, null,
        jsonb_build_array(jsonb_build_object('item', v_sid, 'variant', null, 'qty', 1)), gen_random_uuid());
    EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%table_busy%'; END;
  END LOOP;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('4th active order from one table is blocked', v_ok);

  -- 11. everybody can read the status by order id
  SET LOCAL ROLE anon;
  res2 := get_order_status((res ->> 'order_id')::uuid);
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('guest can see order status', res2 ->> 'status' = 'new');

  -- 12. guest cannot list orders directly
  SET LOCAL ROLE anon;
  BEGIN SELECT count(*) INTO v_cnt FROM orders;
  EXCEPTION WHEN others THEN v_cnt := 0; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('guest cannot read orders table', v_cnt = 0);

  -- 13. staff sees orders and can move one forward
  PERFORM set_config('request.jwt.claims', v_staff_claims, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_cnt FROM orders WHERE restaurant_id = v_rest;
  PERFORM set_order_status((res ->> 'order_id')::uuid, 'preparing');
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('staff reads orders', v_cnt >= 1);
  SELECT count(*) INTO v_cnt FROM orders WHERE id = (res ->> 'order_id')::uuid AND status = 'preparing';
  INSERT INTO results (name, ok) VALUES ('staff changes order status', v_cnt = 1);

  -- 14. staff cannot add staff / edit tables
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM add_staff(v_rest, 'owner-test@example.com'); v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%not_allowed%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('staff cannot manage staff', v_ok);

  -- 15. Free plan blocks ordering
  UPDATE restaurants SET plan = 'free' WHERE id = v_rest;
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM place_order('demo', v_token, null,
      jsonb_build_array(jsonb_build_object('item', v_sid, 'variant', null, 'qty', 1)), gen_random_uuid());
    v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%plan_not_allowed%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('Free plan cannot order', v_ok);
END $$;

-- ---- restaurant info (migration 003) ----
DO $$
DECLARE
  v_rest uuid; v_owner uuid; v_staff uuid; v_ok boolean; v_cnt int;
BEGIN
  SELECT id INTO v_rest  FROM restaurants WHERE slug = 'demo';
  SELECT id INTO v_owner FROM auth.users WHERE email = 'owner-test@example.com';
  SELECT id INTO v_staff FROM auth.users WHERE email = 'staff-test@example.com';

  -- staff cannot change restaurant info
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM update_restaurant_info(v_rest, '{"address":"X"}'::jsonb); v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%not_allowed%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('staff cannot change restaurant info', v_ok);

  -- owner WITHOUT 2FA cannot change restaurant info
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM update_restaurant_info(v_rest, '{"address":"X"}'::jsonb); v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%not_allowed%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('owner without 2FA cannot change restaurant info', v_ok);

  -- owner WITH 2FA saves valid info
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM update_restaurant_info(v_rest,
    '{"address":"Abovyan 1","website":"https://cafe.example","phone":"+374 10 123456","about":{"en":"A cafe"}}'::jsonb);
  RESET ROLE;
  SELECT (info ->> 'address') = 'Abovyan 1' AND (info ->> 'website') = 'https://cafe.example'
    INTO v_ok FROM restaurants WHERE id = v_rest;
  INSERT INTO results (name, ok) VALUES ('owner with 2FA saves restaurant info', v_ok);

  -- unsafe values are rejected
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM update_restaurant_info(v_rest, '{"website":"javascript:alert(1)"}'::jsonb); v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%invalid_info%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('javascript: website is rejected', v_ok);

  SET LOCAL ROLE authenticated;
  BEGIN PERFORM update_restaurant_info(v_rest, '{"is_admin":"true"}'::jsonb); v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%invalid_info%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('unknown field is rejected', v_ok);

  -- guests cannot call the function, but can read the info
  SET LOCAL ROLE anon;
  BEGIN PERFORM update_restaurant_info(v_rest, '{"address":"X"}'::jsonb); v_ok := false;
  EXCEPTION WHEN others THEN v_ok := SQLERRM LIKE '%permission denied%'; END;
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('guest cannot call update_restaurant_info', v_ok);

  SET LOCAL ROLE anon;
  SELECT count(*) INTO v_cnt FROM restaurants WHERE slug = 'demo' AND info ->> 'address' = 'Abovyan 1';
  RESET ROLE;
  INSERT INTO results (name, ok) VALUES ('guest can read restaurant info', v_cnt = 1);
END $$;

SELECT n, name, ok FROM results ORDER BY n;

ROLLBACK;
