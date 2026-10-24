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
  name_required: 'Укажите название хотя бы на одном языке.',
  too_long: 'Текст слишком длинный.',
  bad_price: 'Цена указана неверно.',
  bad_currency: 'Валюта — три латинские буквы, например AMD.',
  bad_number: 'Порядок — целое число от 0 до 100000.',
  forbidden: 'Недостаточно прав или вход без 2FA. Выйдите и войдите заново.',
  not_allowed: 'Недостаточно прав.',
  user_not_found: 'Пользователь с таким email не зарегистрирован. Аккаунт создаёт администратор платформы.',
  already_member: 'Этот пользователь уже в команде.',
  not_found: 'Запись не найдена.'
}

function explain(error) {
  const text = String(error?.message ?? '')
  const known = Object.keys(MESSAGES).find((key) => text.includes(key))
  if (known) return MESSAGES[known]
  if (error?.code === '42501' || /row-level security|permission denied/i.test(text)) return MESSAGES.forbidden
  if (error?.code === '23505') return 'Такое значение уже существует.'
  if (error?.code === '23503') return 'Нельзя удалить: есть связанные записи (например, блюда в категории).'
  if (error?.code === '23514') return 'Данные не прошли проверку (длина, формат, цена).'
  return 'Не удалось выполнить действие. Попробуйте ещё раз.'
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

function buildForm(spec, { onSave, onDelete, saveLabel = 'Сохранить' }) {
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
      const control = el('input', { type: 'text', maxlength: 20, value: field.value ?? '' })
      form.append(el('label', { class: 'field' }, el('span', {}, field.label), control))

      if (field.kind === 'price') readers.push([field.key, () => parsePrice(control.value)])
      else if (field.kind === 'currency') readers.push([field.key, () => normalizeCurrency(control.value)])
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
        if (window.confirm('Удалить? Это действие нельзя отменить.')) act(onDelete, 'Удалено')
      }
    }, 'Удалить'))
  }

  form.append(buttons)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    act(async () => {
      const payload = {}
      for (const [key, read] of readers) payload[key] = read()
      await onSave(payload)
    }, 'Сохранено')
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
    { key: 'name', kind: 'i18n', label: 'Название', value: item?.name, required: true },
    { key: 'description', kind: 'i18n-long', label: 'Описание', value: item?.description },
    { key: 'price', kind: 'price', label: 'Цена (пусто, если у блюда есть варианты)', value: item?.price },
    { key: 'currency', kind: 'currency', label: 'Валюта', value: item?.currency ?? 'AMD' },
    ...(subs ? [{
      key: 'subcategory_id', kind: 'select', label: 'Подкатегория', value: item?.subcategory_id ?? subcategoryId ?? '',
      options: [{ value: '', label: '— без подкатегории —' }, ...subs.map((s) => ({ value: s.id, label: label(s.name) }))]
    }] : []),
    { key: 'is_available', kind: 'checkbox', label: 'Доступно гостям', value: item?.is_available ?? true },
    { key: 'sort_order', kind: 'number', label: 'Порядок', value: item?.sort_order ?? 0 }
  ]
}

function variantBlock(item, variant) {
  return el('div', { class: 'variant' }, buildForm([
    { key: 'name', kind: 'i18n', label: 'Вариант (например, Большой)', value: variant?.name, required: true },
    { key: 'price', kind: 'price', label: 'Цена', value: variant?.price },
    { key: 'currency', kind: 'currency', label: 'Валюта', value: variant?.currency ?? item.currency ?? 'AMD' },
    { key: 'sort_order', kind: 'number', label: 'Порядок', value: variant?.sort_order ?? 0 }
  ], {
    saveLabel: variant ? 'Сохранить вариант' : 'Добавить вариант',
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
  const price = variants.length ? `${variants.length} вар.` : (item.price ?? '—')

  const summary = el('span', {}, `${label(item.name)} · ${price} ${item.currency ?? ''}`,
    item.is_available ? null : el('span', { class: 'badge' }, 'скрыто'))

  return el('details', { class: 'entity', 'data-key': `i:${item.id}` },
    el('summary', {}, summary),
    el('div', { class: 'body' },
      buildForm(itemFields(item, null, subs), {
        onSave: async (payload) => { await updateRow('menu_items', item.id, payload); await refreshMenu() },
        onDelete: async () => { await deleteRow('menu_items', item.id); await refreshMenu() }
      }),
      el('h4', {}, 'Варианты'),
      variants.map((variant) => variantBlock(item, variant)),
      section(`av:${item.id}`, '＋ Добавить вариант', variantBlock(item, null))
    ))
}

function categoryBlock(category) {
  const subs = data.subcategories.filter((s) => s.category_id === category.id).sort(bySort)
  const items = data.items.filter((i) => i.category_id === category.id).sort(bySort)

  const addItem = (subcategoryId) => section(`ai:${category.id}:${subcategoryId ?? ''}`, '＋ Добавить блюдо',
    buildForm(itemFields(null, subcategoryId, null), {
      saveLabel: 'Добавить блюдо',
      onSave: async (payload) => {
        await insertRow('menu_items', 'i', { category_id: category.id, subcategory_id: subcategoryId, ...payload })
        await refreshMenu()
      }
    }))

  return section(`c:${category.id}`, label(category.name),
    buildForm([
      { key: 'name', kind: 'i18n', label: 'Название категории', value: category.name, required: true },
      { key: 'sort_order', kind: 'number', label: 'Порядок', value: category.sort_order ?? 0 }
    ], {
      onSave: async (payload) => { await updateRow('categories', category.id, payload); await refreshMenu() },
      onDelete: async () => { await deleteRow('categories', category.id); await refreshMenu() }
    }),
    el('h4', {}, 'Блюда'),
    items.filter((i) => !i.subcategory_id).map((i) => itemBlock(i, subs)),
    addItem(null),
    subs.map((sub) => section(`s:${sub.id}`, `↳ ${label(sub.name)}`,
      buildForm([
        { key: 'name', kind: 'i18n', label: 'Название подкатегории', value: sub.name, required: true },
        { key: 'sort_order', kind: 'number', label: 'Порядок', value: sub.sort_order ?? 0 }
      ], {
        onSave: async (payload) => { await updateRow('subcategories', sub.id, payload); await refreshMenu() },
        onDelete: async () => { await deleteRow('subcategories', sub.id); await refreshMenu() }
      }),
      items.filter((i) => i.subcategory_id === sub.id).map((i) => itemBlock(i, subs)),
      addItem(sub.id)
    )),
    section(`as:${category.id}`, '＋ Добавить подкатегорию',
      buildForm([
        { key: 'name', kind: 'i18n', label: 'Название подкатегории', required: true },
        { key: 'sort_order', kind: 'number', label: 'Порядок', value: subs.length }
      ], {
        saveLabel: 'Добавить подкатегорию',
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
    fill(box, el('p', { class: 'empty' }, 'Опубликованное меню не найдено. Его создаёт администратор платформы.'))
    return
  }

  fill(
    box,
    section('add-category', '＋ Добавить категорию',
      buildForm([
        { key: 'name', kind: 'i18n', label: 'Название категории', required: true },
        { key: 'sort_order', kind: 'number', label: 'Порядок', value: data.categories.length }
      ], {
        saveLabel: 'Добавить категорию',
        onSave: async (payload) => { await insertRow('categories', 'c', payload); await refreshMenu() }
      })),
    data.categories.sort(bySort).map(categoryBlock)
  )

  box.querySelectorAll('details[data-key]').forEach((node) => {
    if (open.has(node.dataset.key)) node.open = true
  })
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
    el('input', { type: 'text', maxlength: 20, placeholder: 'Название стола, например 5', 'aria-label': 'Название стола', required: true }),
    el('button', { type: 'submit', class: 'primary' }, 'Добавить стол'))

  addForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const input = addForm.querySelector('input')
    act(async () => {
      const { data: created, error: insertError } = await supabase
        .from('restaurant_tables').insert({ restaurant_id: restaurant.id, label: input.value.trim() }).select('id')
      if (insertError) throw insertError
      if (!created?.length) throw new Error('forbidden')
      await renderTables()
    }, 'Стол добавлен')
  })

  fill(
    box,
    addForm,
    el('p', { class: 'muted' },
      'У каждого стола своя ссылка. Сделайте из неё QR-код (любым генератором QR) и поставьте на стол. ' +
      'Гости без такой ссылки смотрят меню, но заказать не могут. «Новый код» отзывает старый QR.'),
    rows.length ? rows.map((row) => {
      const link = el('input', { type: 'text', readonly: true, value: tableLink(row.token), 'aria-label': `Ссылка стола ${row.label}` })
      return el('div', { class: 'table-row' },
        el('strong', {}, row.label), link,
        el('button', {
          type: 'button', class: 'ghost',
          onclick: async () => {
            try { await navigator.clipboard.writeText(link.value); notify('Ссылка скопирована') }
            catch { link.select(); notify('Скопируйте ссылку вручную', true) }
          }
        }, 'Копировать'),
        el('button', {
          type: 'button', class: 'ghost',
          onclick: () => {
            if (window.confirm('Старый QR перестанет работать. Продолжить?')) {
              act(async () => {
                const { error: rotateError } = await supabase.rpc('rotate_table_token', { p_table: row.id })
                if (rotateError) throw rotateError
                await renderTables()
              }, 'Код обновлён')
            }
          }
        }, 'Новый код'),
        el('button', {
          type: 'button', class: 'danger',
          onclick: () => {
            if (window.confirm(`Удалить стол ${row.label}?`)) {
              act(async () => { await deleteRow('restaurant_tables', row.id); await renderTables() }, 'Стол удалён')
            }
          }
        }, 'Удалить'))
    }) : el('p', { class: 'empty' }, 'Столов пока нет.'))
}

// ---------- staff ----------

async function renderStaff() {
  const box = $('#tab-staff')
  const { data: rows, error } = await supabase.rpc('list_staff', { p_restaurant: restaurant.id })
  if (error) throw error

  const addForm = el('form', { class: 'inline-form' },
    el('input', { type: 'email', placeholder: 'email сотрудника', 'aria-label': 'Email сотрудника', required: true }),
    el('button', { type: 'submit', class: 'primary' }, 'Добавить'))

  addForm.addEventListener('submit', (event) => {
    event.preventDefault()
    act(async () => {
      const { error: addError } = await supabase.rpc('add_staff', {
        p_restaurant: restaurant.id, p_email: addForm.querySelector('input').value
      })
      if (addError) throw addError
      await renderStaff()
    }, 'Сотрудник добавлен')
  })

  fill(
    box,
    el('p', { class: 'muted' },
      'Сотрудник видит только окно заказов (staff.html). Аккаунт нужно создать заранее — это делает администратор платформы.'),
    addForm,
    rows.map((row) => el('div', { class: 'list-row' },
      el('span', {}, row.email), el('span', { class: 'badge' }, row.role === 'owner' ? 'владелец' : 'сотрудник'),
      row.role === 'staff'
        ? el('button', {
          type: 'button', class: 'danger',
          onclick: () => {
            if (window.confirm(`Убрать ${row.email}?`)) {
              act(async () => {
                const { error: removeError } = await supabase.rpc('remove_staff', {
                  p_restaurant: restaurant.id, p_user: row.user_id
                })
                if (removeError) throw removeError
                await renderStaff()
              }, 'Доступ снят')
            }
          }
        }, 'Убрать')
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

  const ACTIONS = { INSERT: 'добавлено', UPDATE: 'изменено', DELETE: 'удалено' }
  const TABLES = {
    categories: 'категория', subcategories: 'подкатегория', menu_items: 'блюдо', item_variants: 'вариант',
    restaurant_tables: 'стол', restaurant_members: 'доступ'
  }

  fill(
    box,
    el('p', { class: 'muted' }, 'Последние 50 изменений. Журнал нельзя редактировать.'),
    rows.length ? rows.map((row) => {
      const record = row.new_row ?? row.old_row ?? {}
      const title = label(record.name) !== '—' ? label(record.name) : (record.label ?? '')
      return el('div', { class: 'log-row' },
        new Date(row.created_at).toLocaleString('ru'),
        `${TABLES[row.table_name] ?? row.table_name}`,
        `${ACTIONS[row.action] ?? row.action} ${title} · ${row.user_id === user.id ? 'вы' : (row.user_id ? row.user_id.slice(0, 8) : 'платформа')}`)
    }) : el('p', { class: 'empty' }, 'Изменений пока нет.'))
}

// ---------- security ----------

function renderSecurity() {
  fill(
    $('#tab-security'),
    el('p', {}, `Тариф: ${restaurant.plan === 'standard' ? 'Standard' : 'Free'} (меняется только администратором платформы).`),
    el('p', {}, restaurant.require_mfa
      ? 'Двухфакторная защита включена: изменения возможны только после входа с кодом из приложения.'
      : 'Двухфакторная защита отключена администратором платформы.'),
    el('ul', { class: 'tips' },
      el('li', {}, 'Меню, столы и сотрудников меняет только владелец; сотрудники видят только заказы.'),
      el('li', {}, 'Каждое изменение записывается в журнал вместе с аккаунтом.'),
      el('li', {}, 'Если подозреваете утечку пароля — смените пароль и нажмите «Новый код» у столов.'),
      el('li', {}, 'Не давайте свой аккаунт сотрудникам: добавьте им отдельные аккаунты.')))
}

// ---------- tabs ----------

const loaders = {
  menu: async () => { await loadMenu(); renderMenu() },
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
  $('#panel-title').textContent = `Админ-панель · ${restaurant.slug}`
  $('#panel-meta').textContent = `${user.email} · ${restaurant.plan === 'standard' ? 'Standard' : 'Free'}`
  await openTab('menu')
}

async function startMfa(mode) {
  show('mfa-view')
  $('#mfa-status').textContent = ''
  $('#mfa-code').value = ''
  $('#mfa-enroll').hidden = mode !== 'enroll'

  if (mode === 'verify') {
    $('#mfa-text').textContent = 'Введите код из приложения-аутентификатора.'
    return
  }

  $('#mfa-text').textContent =
    'Для защиты меню нужна двухфакторная аутентификация. Отсканируйте QR-код приложением (Google Authenticator, Aegis, 1Password) и введите код.'

  const { data: factors } = await supabase.auth.mfa.listFactors()
  for (const factor of factors?.all ?? []) {
    if (factor.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: factor.id })
  }

  const { data: enrolled, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Admin panel' })
  if (error) {
    $('#mfa-status').textContent = 'Не удалось начать настройку 2FA. Обновите страницу.'
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
    .from('restaurants').select('id, slug, plan, require_mfa').eq('slug', slug).maybeSingle()
  if (error || !found) return showLogin('Ресторан не найден.')

  const { data: membership } = await supabase
    .from('restaurant_members').select('role').eq('restaurant_id', found.id).eq('user_id', user.id).maybeSingle()

  if (!membership) return showLogin('У этого аккаунта нет доступа к ресторану.')
  if (membership.role !== 'owner') {
    return showLogin('Админ-панель доступна только владельцу. Сотрудникам — окно заказов (staff.html).')
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
  $('#login-status').textContent = 'Выполняется вход…'

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
    showLogin('Войти не удалось. Проверьте email и пароль.')
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
    $('#mfa-status').textContent = 'Код не подошёл. Проверьте время на телефоне и попробуйте ещё раз.'
  } finally {
    submit.disabled = false
  }
})

async function logout() {
  await supabase.auth.signOut()
  user = null
  restaurant = null
  showLogin('Вы вышли из аккаунта.')
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
