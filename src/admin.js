import './admin.css'
import { supabase } from './services/supabaseClient.js'
import {
  LANGUAGES, buildI18n, newSourceId, parsePrice, normalizeCurrency
} from './utils/i18n.js'

const slug = new URLSearchParams(window.location.search).get('restaurant') || 'demo'
const $ = (selector) => document.querySelector(selector)

let restaurant = null
let user = null
let role = null
let menuId = null
let data = { categories: [], subcategories: [], items: [], variants: [] }

// ---------- tiny DOM helper: everything is built with textContent, never innerHTML ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)

  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue
    if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : value)
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }

  return node
}

// replaceChildren/append stringify arrays, so lists must be flattened first
function fill(box, ...children) {
  box.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false))
}

const label = (value) => value?.ru || value?.en || value?.hy || '—'
const bySort = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)

// ---------- messages ----------

const MESSAGES = {
  name_required: 'Enter a name in at least one language.',
  too_long: 'The text is too long.',
  bad_price: 'The price is not valid.',
  bad_currency: 'Currency must be three Latin letters, for example AMD.',
  bad_number: 'Order must be a whole number from 0 to 100000.',
  forbidden: 'Not allowed, or 2FA is not active for this session. Sign out and sign in again.',
  not_allowed: 'Not allowed.',
  user_not_found: 'No account with this email. The platform administrator creates accounts.',
  already_member: 'This person is already on the team.',
  not_found: 'Item not found.',
  invalid_info: 'Check the details: the phone, email or website format is not valid, or a text is too long.'
}

function explain(error) {
  const text = String(error?.message ?? '')
  const known = Object.keys(MESSAGES).find((key) => text.includes(key))
  if (known) return MESSAGES[known]
  if (error?.code === '42501' || /row-level security|permission denied/i.test(text)) return MESSAGES.forbidden
  if (error?.code === '23505') return 'This value already exists.'
  if (error?.code === '23503') return 'Cannot delete: related items exist (for example, dishes in this category).'
  if (error?.code === '23514') return 'The data did not pass validation (length, format or price).'
  return 'The action failed. Please try again.'
}

let noticeTimer = null

function notify(message, isError = false) {
  const box = $('#notice')
  box.textContent = message
  box.className = isError ? 'notice error' : 'notice'
  box.hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { box.hidden = true }, 5000)
}

async function act(task, success) {
  try {
    await task()
    if (success) notify(success)
  } catch (error) {
    console.error(error)
    notify(explain(error), true)
  }
}

// ---------- database helpers (RLS hides rows => 0 rows, not an error, so we check) ----------

async function insertRow(table, prefix, payload) {
  const { data: rows, error } = await supabase
    .from(table)
    .insert({ menu_id: menuId, source_id: newSourceId(prefix), ...payload })
    .select('id')
  if (error) throw error
  if (!rows?.length) throw new Error('forbidden')
}

async function updateRow(table, id, payload) {
  const { data: rows, error } = await supabase.from(table).update(payload).eq('id', id).select('id')
  if (error) throw error
  if (!rows?.length) throw new Error('forbidden')
}

async function deleteRow(table, id) {
  const { data: rows, error } = await supabase.from(table).delete().eq('id', id).select('id')
  if (error) throw error
  if (!rows?.length) throw new Error('forbidden')
}

// ---------- generic form ----------

function i18nField(title, value, multiline) {
  const inputs = LANGUAGES.map((language) => ({
    language,
    control: multiline
      ? el('textarea', { rows: 2, maxlength: 600 }, value?.[language] ?? '')
      : el('input', { type: 'text', maxlength: 120, value: value?.[language] ?? '' })
  }))

  return {
    node: el('fieldset', { class: 'i18n' }, el('legend', {}, title),
      inputs.map(({ language, control }) =>
        el('label', { class: 'lang' }, el('span', {}, language.toUpperCase()), control))),
    read: () => Object.fromEntries(inputs.map(({ language, control }) => [language, control.value]))
  }
}

function buildForm(spec, { onSave, onDelete, saveLabel = 'Save' }) {
  const readers = []
  const form = el('form', { class: 'entity-form' })

  for (const field of spec) {
    if (field.kind === 'i18n' || field.kind === 'i18n-long') {
      const long = field.kind === 'i18n-long'
      const part = i18nField(field.label, field.value, long)
      form.append(part.node)
      readers.push([field.key, () => buildI18n(part.read(), {
        required: field.required, maxLength: long ? 600 : 120
      })])
    } else if (field.kind === 'checkbox') {
      const control = el('input', { type: 'checkbox', checked: Boolean(field.value) })
      form.append(el('label', { class: 'check' }, control, field.label))
      readers.push([field.key, () => control.checked])
    } else if (field.kind === 'select') {
      const control = el('select', {}, field.options.map((option) =>
        el('option', { value: option.value, selected: String(option.value) === String(field.value ?? '') }, option.label)))
      form.append(el('label', { class: 'field' }, el('span', {}, field.label), control))
      readers.push([field.key, () => control.value || null])
    } else {
      const control = el('input', {
        type: 'text', maxlength: field.maxLength ?? 20, value: field.value ?? '',
        placeholder: field.placeholder
      })
      form.append(el('label', { class: 'field' }, el('span', {}, field.label), control))

      if (field.kind === 'price') readers.push([field.key, () => parsePrice(control.value)])
      else if (field.kind === 'currency') readers.push([field.key, () => normalizeCurrency(control.value)])
      else if (field.kind === 'text') readers.push([field.key, () => control.value.trim()])
      else readers.push([field.key, () => {
        const number = Number.parseInt(control.value || '0', 10)
        if (!Number.isFinite(number) || number < 0 || number > 100000) throw new Error('bad_number')
        return number
      }])
    }
  }

  const buttons = el('div', { class: 'row' }, el('button', { type: 'submit', class: 'primary' }, saveLabel))

  if (onDelete) {
    buttons.append(el('button', {
      type: 'button',
      class: 'danger',
      onclick: () => {
        if (window.confirm('Delete? This cannot be undone.')) act(onDelete, 'Deleted')
      }
    }, 'Delete'))
  }

  form.append(buttons)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    act(async () => {
      const payload = {}
      for (const [key, read] of readers) payload[key] = read()
      await onSave(payload)
    }, 'Saved')
  })

  return form
}

function section(key, title, ...body) {
  return el('details', { class: 'entity', 'data-key': key },
    el('summary', {}, title), el('div', { class: 'body' }, body))
}

// ---------- menu editor ----------

async function loadMenu() {
  const { data: menu, error } = await supabase
    .from('menus').select('id').eq('restaurant_id', restaurant.id).eq('status', 'published')
    .order('version', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error

  menuId = menu?.id ?? null
  if (!menuId) {
    data = { categories: [], subcategories: [], items: [], variants: [] }
    return
  }

  const query = (table, columns) => supabase.from(table).select(columns).eq('menu_id', menuId)
  const [categories, subcategories, items, variants] = await Promise.all([
    query('categories', 'id, name, sort_order'),
    query('subcategories', 'id, category_id, name, sort_order'),
    query('menu_items', 'id, category_id, subcategory_id, name, description, price, currency, is_available, sort_order'),
    query('item_variants', 'id, item_id, name, price, currency, sort_order')
  ])

  for (const result of [categories, subcategories, items, variants]) if (result.error) throw result.error

  data = {
    categories: categories.data, subcategories: subcategories.data,
    items: items.data, variants: variants.data
  }
}

async function refreshMenu() {
  await loadMenu()
  renderMenu()
}

function itemFields(item, subcategoryId, subs) {
  return [
    { key: 'name', kind: 'i18n', label: 'Name', value: item?.name, required: true },
    { key: 'description', kind: 'i18n-long', label: 'Description', value: item?.description },
    { key: 'price', kind: 'price', label: 'Price (leave empty if the dish has variants)', value: item?.price },
    { key: 'currency', kind: 'currency', label: 'Currency', value: item?.currency ?? 'AMD' },
    ...(subs ? [{
      key: 'subcategory_id', kind: 'select', label: 'Subcategory', value: item?.subcategory_id ?? subcategoryId ?? '',
      options: [{ value: '', label: '— no subcategory —' }, ...subs.map((s) => ({ value: s.id, label: label(s.name) }))]
    }] : []),
    { key: 'is_available', kind: 'checkbox', label: 'Available to guests', value: item?.is_available ?? true },
    { key: 'sort_order', kind: 'number', label: 'Order', value: item?.sort_order ?? 0 }
  ]
}

function variantBlock(item, variant) {
  return el('div', { class: 'variant' }, buildForm([
    { key: 'name', kind: 'i18n', label: 'Variant (for example, Large)', value: variant?.name, required: true },
    { key: 'price', kind: 'price', label: 'Price', value: variant?.price },
    { key: 'currency', kind: 'currency', label: 'Currency', value: variant?.currency ?? item.currency ?? 'AMD' },
    { key: 'sort_order', kind: 'number', label: 'Order', value: variant?.sort_order ?? 0 }
  ], {
    saveLabel: variant ? 'Save variant' : 'Add variant',
    onSave: async (payload) => {
      if (payload.price === null) throw new Error('bad_price')
      if (variant) await updateRow('item_variants', variant.id, payload)
      else await insertRow('item_variants', 'v', { item_id: item.id, ...payload })
      await refreshMenu()
    },
    onDelete: variant ? async () => { await deleteRow('item_variants', variant.id); await refreshMenu() } : null
  }))
}

function itemBlock(item, subs) {
  const variants = data.variants.filter((v) => v.item_id === item.id).sort(bySort)
  const price = variants.length ? `${variants.length} var.` : (item.price ?? '—')

  const summary = el('span', {}, `${label(item.name)} · ${price} ${item.currency ?? ''}`,
    item.is_available ? null : el('span', { class: 'badge' }, 'hidden'))

  return el('details', { class: 'entity', 'data-key': `i:${item.id}` },
    el('summary', {}, summary),
    el('div', { class: 'body' },
      buildForm(itemFields(item, null, subs), {
        onSave: async (payload) => { await updateRow('menu_items', item.id, payload); await refreshMenu() },
        onDelete: async () => { await deleteRow('menu_items', item.id); await refreshMenu() }
      }),
      el('h4', {}, 'Variants'),
      variants.map((variant) => variantBlock(item, variant)),
      section(`av:${item.id}`, '＋ Add variant', variantBlock(item, null))
    ))
}

function categoryBlock(category) {
  const subs = data.subcategories.filter((s) => s.category_id === category.id).sort(bySort)
  const items = data.items.filter((i) => i.category_id === category.id).sort(bySort)

  const addItem = (subcategoryId) => section(`ai:${category.id}:${subcategoryId ?? ''}`, '＋ Add dish',
    buildForm(itemFields(null, subcategoryId, null), {
      saveLabel: 'Add dish',
      onSave: async (payload) => {
        await insertRow('menu_items', 'i', { category_id: category.id, subcategory_id: subcategoryId, ...payload })
        await refreshMenu()
      }
    }))

  return section(`c:${category.id}`, label(category.name),
    buildForm([
      { key: 'name', kind: 'i18n', label: 'Category name', value: category.name, required: true },
      { key: 'sort_order', kind: 'number', label: 'Order', value: category.sort_order ?? 0 }
    ], {
      onSave: async (payload) => { await updateRow('categories', category.id, payload); await refreshMenu() },
      onDelete: async () => { await deleteRow('categories', category.id); await refreshMenu() }
    }),
    el('h4', {}, 'Dishes'),
    items.filter((i) => !i.subcategory_id).map((i) => itemBlock(i, subs)),
    addItem(null),
    subs.map((sub) => section(`s:${sub.id}`, `↳ ${label(sub.name)}`,
      buildForm([
        { key: 'name', kind: 'i18n', label: 'Subcategory name', value: sub.name, required: true },
        { key: 'sort_order', kind: 'number', label: 'Order', value: sub.sort_order ?? 0 }
      ], {
        onSave: async (payload) => { await updateRow('subcategories', sub.id, payload); await refreshMenu() },
        onDelete: async () => { await deleteRow('subcategories', sub.id); await refreshMenu() }
      }),
      items.filter((i) => i.subcategory_id === sub.id).map((i) => itemBlock(i, subs)),
      addItem(sub.id)
    )),
    section(`as:${category.id}`, '＋ Add subcategory',
      buildForm([
        { key: 'name', kind: 'i18n', label: 'Subcategory name', required: true },
        { key: 'sort_order', kind: 'number', label: 'Order', value: subs.length }
      ], {
        saveLabel: 'Add subcategory',
        onSave: async (payload) => {
          await insertRow('subcategories', 's', { category_id: category.id, ...payload })
          await refreshMenu()
        }
      }))
  )
}

function renderMenu() {
  const box = $('#tab-menu')
  const open = new Set(
    [...box.querySelectorAll('details[open][data-key]')].map((node) => node.dataset.key))

  if (!menuId) {
    fill(box, el('p', { class: 'empty' }, 'No published menu found. The platform administrator creates it.'))
    return
  }

  fill(
    box,
    section('add-category', '＋ Add category',
      buildForm([
        { key: 'name', kind: 'i18n', label: 'Category name', required: true },
        { key: 'sort_order', kind: 'number', label: 'Order', value: data.categories.length }
      ], {
        saveLabel: 'Add category',
        onSave: async (payload) => { await insertRow('categories', 'c', payload); await refreshMenu() }
      })),
    data.categories.sort(bySort).map(categoryBlock)
  )

  box.querySelectorAll('details[data-key]').forEach((node) => {
    if (open.has(node.dataset.key)) node.open = true
  })
}

// ---------- restaurant info (shown in the guest footer) ----------

function renderInfo() {
  const info = restaurant.info ?? {}

  const details = section('info-form', 'Details', buildForm([
      { key: 'about', kind: 'i18n-long', label: 'About the restaurant', value: info.about },
      { key: 'address', kind: 'text', label: 'Address', value: info.address, maxLength: 200 },
      { key: 'hours', kind: 'text', label: 'Opening hours (for example, Mon–Sun 09:00–22:00)', value: info.hours, maxLength: 200 },
      { key: 'phone', kind: 'text', label: 'Phone', value: info.phone, maxLength: 25, placeholder: '+374 10 123456' },
      { key: 'email', kind: 'text', label: 'Contact email', value: info.email, maxLength: 120 },
      { key: 'website', kind: 'text', label: 'Website', value: info.website, maxLength: 200, placeholder: 'https://' }
    ], {
      saveLabel: 'Save details',
      onSave: async (payload) => {
        const { error } = await supabase.rpc('update_restaurant_info', {
          p_restaurant: restaurant.id, p_info: payload
        })
        if (error) throw error
        restaurant.info = payload
      }
    }))
  details.open = true

  fill(
    $('#tab-info'),
    el('p', { class: 'muted' },
      'This is shown at the bottom of the guest menu. Leave a field empty to hide it. Links must start with https://.'),
    details
  )
}

// ---------- tables & QR links ----------

function tableLink(token) {
  const url = new URL('./', window.location.href)
  url.searchParams.set('restaurant', restaurant.slug)
  url.searchParams.set('t', token)
  return url.href
}

async function renderTables() {
  const box = $('#tab-tables')
  const { data: rows, error } = await supabase
    .from('restaurant_tables').select('id, label, token').eq('restaurant_id', restaurant.id).order('label')
  if (error) throw error

  const addForm = el('form', { class: 'inline-form' },
    el('input', { type: 'text', maxlength: 20, placeholder: 'Table name, for example 5', 'aria-label': 'Table name', required: true }),
    el('button', { type: 'submit', class: 'primary' }, 'Add table'))

  addForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const input = addForm.querySelector('input')
    act(async () => {
      const { data: created, error: insertError } = await supabase
        .from('restaurant_tables').insert({ restaurant_id: restaurant.id, label: input.value.trim() }).select('id')
      if (insertError) throw insertError
      if (!created?.length) throw new Error('forbidden')
      await renderTables()
    }, 'Table added')
  })

  fill(
    box,
    addForm,
    el('p', { class: 'muted' },
      'Each table has its own link. Turn it into a QR code with any QR generator and put it on the table. ' +
      'Guests without this link can view the menu but cannot order. “New code” invalidates the old QR.'),
    rows.length ? rows.map((row) => {
      const link = el('input', { type: 'text', readonly: true, value: tableLink(row.token), 'aria-label': `Link for table ${row.label}` })
      return el('div', { class: 'table-row' },
        el('strong', {}, row.label), link,
        el('button', {
          type: 'button', class: 'ghost',
          onclick: async () => {
            try { await navigator.clipboard.writeText(link.value); notify('Link copied') }
            catch { link.select(); notify('Copy the link manually', true) }
          }
        }, 'Copy'),
        el('button', {
          type: 'button', class: 'ghost',
          onclick: () => {
            if (window.confirm('The old QR will stop working. Continue?')) {
              act(async () => {
                const { error: rotateError } = await supabase.rpc('rotate_table_token', { p_table: row.id })
                if (rotateError) throw rotateError
                await renderTables()
              }, 'Code updated')
            }
          }
        }, 'New code'),
        el('button', {
          type: 'button', class: 'danger',
          onclick: () => {
            if (window.confirm(`Delete table ${row.label}?`)) {
              act(async () => { await deleteRow('restaurant_tables', row.id); await renderTables() }, 'Table deleted')
            }
          }
        }, 'Delete'))
    }) : el('p', { class: 'empty' }, 'No tables yet.'))
}

// ---------- staff ----------

async function renderStaff() {
  const box = $('#tab-staff')
  const { data: rows, error } = await supabase.rpc('list_staff', { p_restaurant: restaurant.id })
  if (error) throw error

  const addForm = el('form', { class: 'inline-form' },
    el('input', { type: 'email', placeholder: 'staff email', 'aria-label': 'Staff email', required: true }),
    el('button', { type: 'submit', class: 'primary' }, 'Add'))

  addForm.addEventListener('submit', (event) => {
    event.preventDefault()
    act(async () => {
      const { error: addError } = await supabase.rpc('add_staff', {
        p_restaurant: restaurant.id, p_email: addForm.querySelector('input').value
      })
      if (addError) throw addError
      await renderStaff()
    }, 'Staff member added')
  })

  fill(
    box,
    el('p', { class: 'muted' },
      'Staff only see the order window (staff.html). Accounts are created in advance by the platform administrator.'),
    addForm,
    rows.map((row) => el('div', { class: 'list-row' },
      el('span', {}, row.email), el('span', { class: 'badge' }, row.role === 'owner' ? 'owner' : 'staff'),
      row.role === 'staff'
        ? el('button', {
          type: 'button', class: 'danger',
          onclick: () => {
            if (window.confirm(`Remove ${row.email}?`)) {
              act(async () => {
                const { error: removeError } = await supabase.rpc('remove_staff', {
                  p_restaurant: restaurant.id, p_user: row.user_id
                })
                if (removeError) throw removeError
                await renderStaff()
              }, 'Access removed')
            }
          }
        }, 'Remove')
        : el('span', {})))
  )
}

// ---------- change log ----------

async function renderLog() {
  const box = $('#tab-log')
  const { data: rows, error } = await supabase
    .from('menu_audit').select('id, user_id, table_name, action, created_at, old_row, new_row')
    .eq('restaurant_id', restaurant.id).order('created_at', { ascending: false }).limit(50)
  if (error) throw error

  const ACTIONS = { INSERT: 'added', UPDATE: 'changed', DELETE: 'deleted' }
  const TABLES = {
    categories: 'category', subcategories: 'subcategory', menu_items: 'dish', item_variants: 'variant',
    restaurant_tables: 'table', restaurant_members: 'access'
  }

  fill(
    box,
    el('p', { class: 'muted' }, 'The last 50 changes. The log cannot be edited.'),
    rows.length ? rows.map((row) => {
      const record = row.new_row ?? row.old_row ?? {}
      const title = label(record.name) !== '—' ? label(record.name) : (record.label ?? '')
      return el('div', { class: 'log-row' },
        new Date(row.created_at).toLocaleString('en-GB'),
        `${TABLES[row.table_name] ?? row.table_name}`,
        `${ACTIONS[row.action] ?? row.action} ${title} · ${row.user_id === user.id ? 'you' : (row.user_id ? row.user_id.slice(0, 8) : 'platform')}`)
    }) : el('p', { class: 'empty' }, 'No changes yet.'))
}

// ---------- security ----------

function renderSecurity() {
  fill(
    $('#tab-security'),
    el('p', {}, `Plan: ${restaurant.plan === 'standard' ? 'Standard' : 'Free'} (changed only by the platform administrator).`),
    el('p', {}, restaurant.require_mfa
      ? 'Two-factor protection is on: changes are possible only after signing in with an app code.'
      : 'Two-factor protection is turned off by the platform administrator.'),
    el('ul', { class: 'tips' },
      el('li', {}, 'Only the owner changes the menu, tables and staff. Staff see only orders.'),
      el('li', {}, 'Every change is written to the log together with the account.'),
      el('li', {}, 'If you suspect a password leak, change the password and press “New code” for each table.'),
      el('li', {}, 'Do not share your account with staff: give each person their own account.')))
}

// ---------- tabs ----------

const loaders = {
  menu: async () => { await loadMenu(); renderMenu() },
  info: async () => renderInfo(),
  tables: renderTables,
  staff: renderStaff,
  log: renderLog,
  security: async () => renderSecurity()
}

async function openTab(name) {
  document.querySelectorAll('.tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name)
  })
  document.querySelectorAll('.tab').forEach((tab) => { tab.hidden = tab.id !== `tab-${name}` })

  try {
    await loaders[name]()
  } catch (error) {
    console.error(error)
    notify(explain(error), true)
  }
}

// ---------- screens & authentication ----------

function show(view) {
  for (const id of ['login-view', 'mfa-view', 'panel-view']) $(`#${id}`).hidden = id !== view
}

function showLogin(message = '') {
  show('login-view')
  $('#login-status').textContent = message
}

async function showPanel() {
  show('panel-view')
  $('#panel-title').textContent = `Admin panel · ${restaurant.slug}`
  $('#panel-meta').textContent = `${user.email} · ${restaurant.plan === 'standard' ? 'Standard' : 'Free'}`
  await openTab('menu')
}

async function startMfa(mode) {
  show('mfa-view')
  $('#mfa-status').textContent = ''
  $('#mfa-code').value = ''
  $('#mfa-enroll').hidden = mode !== 'enroll'

  if (mode === 'verify') {
    $('#mfa-text').textContent = 'Enter the code from your authenticator app.'
    return
  }

  $('#mfa-text').textContent =
    'Two-factor authentication is required to protect the menu. Scan the QR code with an authenticator app (Google Authenticator, Aegis, 1Password) and enter the code.'

  const { data: factors } = await supabase.auth.mfa.listFactors()
  for (const factor of factors?.all ?? []) {
    if (factor.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: factor.id })
  }

  const { data: enrolled, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Admin panel' })
  if (error) {
    $('#mfa-status').textContent = 'Could not start 2FA setup. Please refresh the page.'
    return
  }

  mfaFactorId = enrolled.id
  $('#mfa-qr').src = enrolled.totp.qr_code
  $('#mfa-secret').textContent = enrolled.totp.secret
}

let mfaFactorId = null
let mfaMode = 'verify'

async function afterAuth(sessionUser) {
  user = sessionUser

  const { data: found, error } = await supabase
    .from('restaurants').select('id, slug, plan, require_mfa, info').eq('slug', slug).maybeSingle()
  if (error || !found) return showLogin('Restaurant not found.')

  const { data: membership } = await supabase
    .from('restaurant_members').select('role').eq('restaurant_id', found.id).eq('user_id', user.id).maybeSingle()

  if (!membership) return showLogin('This account has no access to this restaurant.')
  if (membership.role !== 'owner') {
    return showLogin('The admin panel is for owners only. Staff use the order window (staff.html).')
  }

  restaurant = found
  role = membership.role

  if (restaurant.require_mfa) {
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

    if (level?.currentLevel !== 'aal2') {
      mfaMode = level?.nextLevel === 'aal2' ? 'verify' : 'enroll'
      return startMfa(mfaMode)
    }
  }

  await showPanel()
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = event.currentTarget.querySelector('button[type="submit"]')
  submit.disabled = true
  $('#login-status').textContent = 'Signing in…'

  try {
    const { data: session, error } = await supabase.auth.signInWithPassword({
      email: $('#email').value.trim(),
      password: $('#password').value
    })
    if (error) throw error
    $('#password').value = ''
    await afterAuth(session.user)
  } catch (error) {
    console.error('Login failed:', error)
    showLogin('Sign-in failed. Check your email and password.')
  } finally {
    submit.disabled = false
  }
})

$('#mfa-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = event.currentTarget.querySelector('button[type="submit"]')
  submit.disabled = true

  try {
    let factorId = mfaFactorId
    if (mfaMode === 'verify') {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      factorId = factors?.totp?.[0]?.id
    }

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: $('#mfa-code').value.trim() })
    if (error) throw error
    await afterAuth(user)
  } catch (error) {
    console.error('2FA failed:', error)
    $('#mfa-status').textContent = 'The code did not match. Check the time on your phone and try again.'
  } finally {
    submit.disabled = false
  }
})

async function logout() {
  await supabase.auth.signOut()
  user = null
  restaurant = null
  showLogin('You have signed out.')
}

$('#logout').addEventListener('click', logout)
$('#mfa-logout').addEventListener('click', logout)

document.querySelectorAll('.tabs button').forEach((button) => {
  button.addEventListener('click', () => openTab(button.dataset.tab))
})

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') showLogin()
})

const { data: sessionData } = await supabase.auth.getSession()

if (sessionData?.session?.user) await afterAuth(sessionData.session.user)
else showLogin()
