// hy strings should be reviewed by a native speaker before launch.
export const ORDER_TEXT = {
  hy: {
    scanToOrder: 'Պատվիրելու համար սկանավորեք QR կոդը ձեր սեղանին։',
    status_new: 'Ընդունվել է',
    status_preparing: 'Պատրաստվում է',
    status_ready: 'Պատրաստ է',
    status_served: 'Մատուցված է',
    status_cancelled: 'Չեղարկված է',
    dismiss: 'Թաքցնել',
    errBadTable: 'Սեղանի կոդը վավեր չէ։ Սկանավորեք QR կոդը նորից։',
    errRate: 'Չափազանց շատ հարցումներ։ Փորձեք մի փոքր ուշ։',
    errTableBusy: 'Այս սեղանից արդեն կան ակտիվ պատվերներ։ Սպասեք դրանց կատարմանը։',
    errBusy: 'Խոհանոցը ծանրաբեռնված է։ Փորձեք մի փոքր ուշ։',
    add: 'Ավելացնել',
    viewOrder: 'Դիտել պատվերը',
    yourOrder: 'Ձեր պատվերը',
    table: 'Սեղան',
    comment: 'Մեկնաբանություն',
    send: 'Ուղարկել պատվերը',
    sending: 'Ուղարկվում է…',
    close: 'Փակել',
    tableRequired: 'Նշեք սեղանի համարը։',
    orderSent: 'Պատվերն ուղարկված է',
    orderNumber: 'Պատվեր №',
    staffWillBring: 'Անձնակազմը շուտով կմոտենա։',
    done: 'Պատրաստ է',
    total: 'Ընդամենը',
    errGeneric: 'Չհաջողվեց ուղարկել պատվերը։ Փորձեք կրկին։',
    errUnavailable: 'Որոշ ուտեստներ այլևս հասանելի չեն։ Թարմացրեք էջը։',
    errClosed: 'Առցանց պատվերը հասանելի չէ։'
  },
  ru: {
    scanToOrder: 'Чтобы заказать, отсканируйте QR-код на вашем столе.',
    status_new: 'Принят',
    status_preparing: 'Готовится',
    status_ready: 'Готов',
    status_served: 'Подан',
    status_cancelled: 'Отменён',
    dismiss: 'Скрыть',
    errBadTable: 'Код стола недействителен. Отсканируйте QR-код ещё раз.',
    errRate: 'Слишком много запросов. Попробуйте чуть позже.',
    errTableBusy: 'С этого стола уже есть активные заказы. Дождитесь их выполнения.',
    errBusy: 'Кухня перегружена. Попробуйте чуть позже.',
    add: 'Добавить',
    viewOrder: 'Мой заказ',
    yourOrder: 'Ваш заказ',
    table: 'Стол',
    comment: 'Комментарий',
    send: 'Отправить заказ',
    sending: 'Отправляем…',
    close: 'Закрыть',
    tableRequired: 'Укажите номер стола.',
    orderSent: 'Заказ отправлен',
    orderNumber: 'Заказ №',
    staffWillBring: 'Сотрудник скоро подойдёт.',
    done: 'Готово',
    total: 'Итого',
    errGeneric: 'Не удалось отправить заказ. Попробуйте ещё раз.',
    errUnavailable: 'Некоторые блюда больше недоступны. Обновите страницу.',
    errClosed: 'Онлайн-заказ сейчас недоступен.'
  },
  en: {
    scanToOrder: 'Scan the QR code on your table to order.',
    status_new: 'Received',
    status_preparing: 'Preparing',
    status_ready: 'Ready',
    status_served: 'Served',
    status_cancelled: 'Cancelled',
    dismiss: 'Dismiss',
    errBadTable: 'This table code is not valid. Please scan the QR code again.',
    errRate: 'Too many requests. Please try again in a moment.',
    errTableBusy: 'This table already has active orders. Please wait for them.',
    errBusy: 'The kitchen is overloaded. Please try again shortly.',
    add: 'Add',
    viewOrder: 'View order',
    yourOrder: 'Your order',
    table: 'Table',
    comment: 'Comment',
    send: 'Send order',
    sending: 'Sending…',
    close: 'Close',
    tableRequired: 'Enter your table number.',
    orderSent: 'Order sent',
    orderNumber: 'Order #',
    staffWillBring: 'A staff member will be with you shortly.',
    done: 'Done',
    total: 'Total',
    errGeneric: 'Could not send the order. Please try again.',
    errUnavailable: 'Some dishes are no longer available. Please refresh the page.',
    errClosed: 'Online ordering is currently unavailable.'
  }
}

export function orderText(language, key) {
  return ORDER_TEXT[language]?.[key] ?? ORDER_TEXT.en[key] ?? key
}

const ERROR_KEYS = {
  item_unavailable: 'errUnavailable',
  plan_not_allowed: 'errClosed',
  menu_not_published: 'errClosed',
  invalid_table_token: 'errBadTable',
  table_busy: 'errTableBusy',
  rate_limited: 'errRate',
  restaurant_busy: 'errBusy'
}

export function errorKey(code) {
  return ERROR_KEYS[code] ?? 'errGeneric'
}
