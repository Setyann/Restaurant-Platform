import test from 'node:test'
import assert from 'node:assert/strict'

import { safeHttpsUrl, telHref, mailtoHref, visibleInfo } from '../src/utils/footer.js'
import { footerText, FOOTER_TEXT } from '../src/utils/footerText.js'

test('only https links are allowed on the website field', () => {
  assert.equal(safeHttpsUrl('https://cafe.example'), 'https://cafe.example')
  for (const bad of ['javascript:alert(1)', 'http://cafe.example', 'https://a b', 'https://x"onmouseover=1', '', null, 42]) {
    assert.equal(safeHttpsUrl(bad), '', String(bad))
  }
})

test('phone becomes tel: only when it looks like a phone number', () => {
  assert.equal(telHref('+374 10 123456'), 'tel:+37410123456')
  assert.equal(telHref('(010) 12-34-56'), 'tel:010123456')
  for (const bad of ['<img src=x>', 'javascript:1', '12', '', 'abc123456']) {
    assert.equal(telHref(bad), '', bad)
  }
})

test('email becomes mailto: only when it is a plausible address', () => {
  assert.equal(mailtoHref('cafe@x.test'), 'mailto:cafe@x.test')
  for (const bad of ['bad', 'a@b', 'x"@y.z', '<script>@a.b', 'a b@c.d', '']) {
    assert.equal(mailtoHref(bad), '', bad)
  }
})

test('visibleInfo keeps only known fields and trims them', () => {
  const info = visibleInfo({ address: '  Abovyan 1 ', hours: '', evil: '<img>', about: { en: 'Hi' } })
  assert.equal(info.address, 'Abovyan 1')
  assert.equal(info.hours, '')
  assert.equal('evil' in info, false)
  assert.deepEqual(info.about, { en: 'Hi' })
  assert.deepEqual(visibleInfo(null).about, null)
  assert.equal(visibleInfo('nonsense').phone, '')
})

test('footer labels exist in every language and fall back to English', () => {
  const keys = Object.keys(FOOTER_TEXT.en).sort()
  for (const language of ['hy', 'ru']) assert.deepEqual(Object.keys(FOOTER_TEXT[language]).sort(), keys)
  assert.equal(footerText('xx', 'address'), FOOTER_TEXT.en.address)
})
