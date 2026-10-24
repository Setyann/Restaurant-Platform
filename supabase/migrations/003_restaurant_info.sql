-- =====================================================================
-- 003: restaurant info for the guest footer (address, hours, contacts, about)
-- Owner edits it through update_restaurant_info(); guests read it via restaurants.
-- Run after 002_grants.sql. Safe to run more than once.
-- =====================================================================
BEGIN;

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS info jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'restaurants_info_is_object'
                   AND conrelid = 'public.restaurants'::regclass) THEN
    ALTER TABLE public.restaurants
      ADD CONSTRAINT restaurants_info_is_object CHECK (jsonb_typeof(info) = 'object');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.update_restaurant_info(p_restaurant uuid, p_info jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k     text;
  v     jsonb;
  clean jsonb := '{}'::jsonb;
  s     text;
BEGIN
  IF NOT public.owner_can_write(p_restaurant) THEN RAISE EXCEPTION 'not_allowed'; END IF;
  IF p_info IS NULL OR jsonb_typeof(p_info) <> 'object' THEN RAISE EXCEPTION 'invalid_info'; END IF;

  FOR k, v IN SELECT key, value FROM jsonb_each(p_info) LOOP
    IF k = 'about' THEN
      IF v IS NULL OR jsonb_typeof(v) = 'null' THEN CONTINUE; END IF;
      IF NOT public.valid_i18n(v, 1500, false) THEN RAISE EXCEPTION 'invalid_info'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each_text(v) e WHERE btrim(e.value) <> '') THEN
        clean := clean || jsonb_build_object('about',
          (SELECT jsonb_object_agg(e.key, btrim(e.value))
             FROM jsonb_each_text(v) e WHERE btrim(e.value) <> ''));
      END IF;
      CONTINUE;
    END IF;

    IF k NOT IN ('address', 'hours', 'phone', 'email', 'website') THEN RAISE EXCEPTION 'invalid_info'; END IF;
    IF v IS NULL OR jsonb_typeof(v) = 'null' THEN CONTINUE; END IF;
    IF jsonb_typeof(v) <> 'string' THEN RAISE EXCEPTION 'invalid_info'; END IF;

    s := btrim(v #>> '{}');
    IF s = '' THEN CONTINUE; END IF;

    CASE k
      WHEN 'address', 'hours' THEN
        IF char_length(s) > 200 THEN RAISE EXCEPTION 'invalid_info'; END IF;
      WHEN 'phone' THEN
        IF s !~ '^\+?[0-9 ()-]{5,25}$' THEN RAISE EXCEPTION 'invalid_info'; END IF;
      WHEN 'email' THEN
        IF char_length(s) > 120 OR s !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
          RAISE EXCEPTION 'invalid_info';
        END IF;
      WHEN 'website' THEN
        IF char_length(s) > 200 OR s !~ '^https://[^[:space:]]+$' THEN RAISE EXCEPTION 'invalid_info'; END IF;
    END CASE;

    clean := clean || jsonb_build_object(k, s);
  END LOOP;

  UPDATE public.restaurants SET info = clean WHERE id = p_restaurant;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.update_restaurant_info(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_restaurant_info(uuid, jsonb) TO authenticated;

COMMIT;
