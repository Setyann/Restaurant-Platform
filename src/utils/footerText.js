// hy strings should be checked by a native speaker before launch.
export const FOOTER_TEXT = {
  hy: {
    about: 'Մեր մասին', address: 'Հասցե', hours: 'Աշխատանքային ժամեր', phone: 'Հեռախոս',
    email: 'Էլ. փոստ', website: 'Կայք', contact: 'Կապ', creator: 'Ստեղծող', platform: 'Մենյու՝ Restaurant Platform'
  },
  ru: {
    about: 'О ресторане', address: 'Адрес', hours: 'Часы работы', phone: 'Телефон',
    email: 'Почта', website: 'Сайт', contact: 'Контакты', creator: 'Создатель', platform: 'Меню на платформе Restaurant Platform'
  },
  en: {
    about: 'About', address: 'Address', hours: 'Hours', phone: 'Phone',
    email: 'Email', website: 'Website', contact: 'Contact', creator: 'Created by', platform: 'Menu powered by Restaurant Platform'
  }
}

export function footerText(language, key) {
  return FOOTER_TEXT[language]?.[key] ?? FOOTER_TEXT.en[key] ?? key
}
