import assert from 'node:assert/strict'
import test from 'node:test'

import { formatRuPhone, normalizeRuPhone, phoneFromUserJid } from '../src/phone.js'

function reason(input: string): string {
  const phone = normalizeRuPhone(input)
  return phone.ok ? 'ok' : phone.reason
}

test('приводит российские номера к +7', () => {
  const samples = ['+7 (928) 000-00-01', '89280000002', '9280000003', '7 928 000 00 04', '+79280000005']
  const expected = ['79280000001', '79280000002', '79280000003', '79280000004', '79280000005']
  samples.forEach((sample, index) => {
    const phone = normalizeRuPhone(sample)
    assert.equal(phone.ok, true)
    if (phone.ok) {
      assert.equal(phone.digits, expected[index])
      assert.equal(phone.e164, `+${expected[index]}`)
      assert.equal(phone.jid, `${expected[index]}@s.whatsapp.net`)
    }
  })
})

test('отклоняет пустые, короткие, длинные и нероссийские номера', () => {
  assert.equal(normalizeRuPhone('   ').ok, false)
  assert.equal(reason('12345'), 'too_short')
  assert.equal(reason('792800000011'), 'too_long')
  assert.equal(reason('+1 202 555 0143'), 'not_ru')
  assert.equal(reason('+8 928 000-00-01'), 'not_ru')
  assert.equal(reason('4950001122'), 'ambiguous')
})

test('красиво показывает номер и разбирает JID', () => {
  assert.equal(formatRuPhone('79281234567'), '+7 928 123-45-67')
  assert.deepEqual(phoneFromUserJid('79281234567:12@s.whatsapp.net'), { kind: 'phone', digits: '79281234567' })
  assert.deepEqual(phoneFromUserJid('79281234567@c.us'), { kind: 'phone', digits: '79281234567' })
  assert.deepEqual(phoneFromUserJid('12345@lid'), { kind: 'lid', lid: '12345@lid' })
  assert.deepEqual(phoneFromUserJid('12025550143@s.whatsapp.net'), { kind: 'foreign' })
  assert.deepEqual(phoneFromUserJid('1203630@g.us'), { kind: 'skip' })
  assert.deepEqual(phoneFromUserJid('status@broadcast'), { kind: 'skip' })
})
