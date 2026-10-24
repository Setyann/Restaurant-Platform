import fs from "node:fs";

const menuPath = "src/data/restaurants/demo/menu.json";
const outputPath = "scripts/import-demo-menu.sql";
const menuId = "b23f84c8-b9ca-43fa-9bea-bbccad88b001";

const data = JSON.parse(fs.readFileSync(menuPath, "utf8"));
const { categories = [], subcategories = [], items = [] } = data.menu;

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function jsonb(value) {
  return `${sql(JSON.stringify(value ?? {}))}::jsonb`;
}

function categoryId(sourceId) {
  return `(SELECT id FROM public.categories WHERE menu_id = '${menuId}' AND source_id = ${sql(sourceId)})`;
}

function subcategoryId(sourceId) {
  if (sourceId == null) return "NULL";
  return `(SELECT id FROM public.subcategories WHERE menu_id = '${menuId}' AND source_id = ${sql(sourceId)})`;
}

function itemId(sourceId) {
  return `(SELECT id FROM public.menu_items WHERE menu_id = '${menuId}' AND source_id = ${sql(sourceId)})`;
}

const lines = [
  "-- Generated from src/data/restaurants/demo/menu.json",
  "BEGIN;",
  "",
  `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.categories WHERE menu_id = '${menuId}') THEN
    RAISE EXCEPTION 'This menu already contains categories; import cancelled.';
  END IF;
END $$;`,
  "",
  "-- Categories"
];

for (const c of categories) {
  lines.push(
    `INSERT INTO public.categories (menu_id, source_id, name, sort_order) VALUES (` +
    `'${menuId}', ${sql(c.id)}, ${jsonb(c.name)}, ${Number(c.sortOrder ?? 0)});`
  );
}

lines.push("", "-- Subcategories");

for (const s of subcategories) {
  const parentId = s.parentCategoryId ?? s.categoryId;
  if (parentId == null) throw new Error(`No parent category for subcategory ${s.id}`);

  lines.push(
    `INSERT INTO public.subcategories (menu_id, category_id, source_id, name, sort_order) VALUES (` +
    `'${menuId}', ${categoryId(parentId)}, ${sql(s.id)}, ${jsonb(s.name)}, ${Number(s.sortOrder ?? 0)});`
  );
}

lines.push("", "-- Menu items");

for (const item of items) {
  if (item.categoryId == null) throw new Error(`No category for item ${item.id}`);

  const variants = Array.isArray(item.variants) ? item.variants : [];
  const price = variants.length ? "NULL" : (item.price == null ? "NULL" : Number(item.price));
  const currency = sql(item.currency ?? "AMD");
  const description = jsonb(item.description);
  const image = sql(item.image ?? null);
  const available = item.isAvailable === false ? "FALSE" : "TRUE";

  lines.push(
    `INSERT INTO public.menu_items ` +
    `(menu_id, category_id, subcategory_id, source_id, name, description, price, currency, image, is_available, sort_order) VALUES (` +
    `'${menuId}', ${categoryId(item.categoryId)}, ${subcategoryId(item.subcategoryId)}, ` +
    `${sql(item.id)}, ${jsonb(item.name)}, ${description}, ${price}, ${currency}, ${image}, ${available}, ${Number(item.sortOrder ?? 0)});`
  );
}

lines.push("", "-- Item variants");

for (const item of items) {
  for (const variant of item.variants ?? []) {
    lines.push(
      `INSERT INTO public.item_variants ` +
      `(menu_id, item_id, source_id, name, price, currency, sort_order) VALUES (` +
      `'${menuId}', ${itemId(item.id)}, ${sql(variant.id)}, ${jsonb(variant.name)}, ` +
      `${Number(variant.price)}, ${sql(variant.currency ?? item.currency ?? "AMD")}, ${Number(variant.sortOrder ?? 0)});`
    );
  }
}

lines.push("", "COMMIT;", "");
fs.writeFileSync(outputPath, lines.join("\n"), "utf8");

console.log(`SQL generated: ${outputPath}`);
console.log(`Categories: ${categories.length}`);
console.log(`Subcategories: ${subcategories.length}`);
console.log(`Items: ${items.length}`);
console.log(`Variants: ${items.reduce((n, item) => n + (item.variants?.length ?? 0), 0)}`);
