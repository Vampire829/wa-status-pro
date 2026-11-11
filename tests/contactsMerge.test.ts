import assert from 'node:assert/strict'
import test from 'node:test'

import { extractWhatsAppPeers, filterAudience, matchesSourceFilter, mergeContacts } from '../src/contactsMerge.js'
import { openDatabase } from '../src/db.js'
import type { ContactDraft } from '../src/types.js'

function draft(partial: Partial<ContactDraft> & Pick<ContactDraft, 'phone'>): ContactDraft {
  return {
    phone: partial.phone,
    name: partial.name ?? '',
    nameRank: partial.nameRank ?? 0,
    tags: partial.tags ?? [],
    sources: partial.sources ?? ['phone'],
  }
}

test('склеивает дубли, источники и не затирает имя', () => {
  const merged = mergeContacts(
    [draft({ phone: '79280000001', name: 'Аминат', nameRank: 3, tags: ['vip'], sources: ['phone'] })],
    [
      draft({ phone: '79280000001', name: 'Ami', nameRank: 1, tags: ['грозный'], sources: ['whatsapp'] }),
      draft({ phone: '79280000001', name: '', nameRank: 0, tags: ['vip'], sources: ['whatsapp'] }),
      draft({ phone: '79280000002', name: 'Зарема', nameRank: 3, tags: [], sources: ['phone'] }),
    ],
  )
  assert.equal(merged.duplicatesMerged, 1)
  assert.equal(merged.added, 1)
  assert.equal(merged.updated, 1)
  const amina = merged.contacts.find((item) => item.phone === '79280000001')
  assert.ok(amina)
  assert.equal(amina.name, 'Аминат')
  assert.deepEqual(amina.sources, ['phone', 'whatsapp'])
  assert.deepEqual(amina.tags, ['vip', 'грозный'])
})

test('более точное имя заменяет пуш-имя, пустое имя не стирает карточку', () => {
  const filled = mergeContacts(
    [draft({ phone: '79280000003', name: '', nameRank: 0, sources: ['whatsapp'] })],
    [draft({ phone: '79280000003', name: 'Малика', nameRank: 3, sources: ['phone'] })],
  )
  assert.equal(filled.contacts[0]?.name, 'Малика')
  assert.equal(filled.updated, 1)

  const kept = mergeContacts(
    [draft({ phone: '79280000003', name: 'Малика', nameRank: 3, sources: ['phone'] })],
    [draft({ phone: '79280000003', name: 'Малика', nameRank: 3, sources: ['phone'] })],
  )
  assert.equal(kept.unchanged, 1)
  assert.equal(kept.updated, 0)
})

test('аудитория фильтруется по источнику и метке', () => {
  const contacts = [
    draft({ phone: '79280000001', sources: ['whatsapp'], tags: ['vip'] }),
    draft({ phone: '79280000002', sources: ['phone'], tags: ['vip'] }),
    draft({ phone: '79280000003', sources: ['phone', 'whatsapp'], tags: ['город'] }),
  ]
  assert.deepEqual(filterAudience(contacts, { source: 'whatsapp' }).map((item) => item.phone), ['79280000001', '79280000003'])
  assert.deepEqual(filterAudience(contacts, { source: 'phone', tag: 'vip' }).map((item) => item.phone), ['79280000002'])
  assert.deepEqual(filterAudience(contacts, { source: 'any', tag: 'город' }).map((item) => item.phone), ['79280000003'])
  assert.equal(matchesSourceFilter(['phone', 'whatsapp'], 'both'), true)
  assert.equal(matchesSourceFilter(['whatsapp'], 'both'), false)
  assert.equal(matchesSourceFilter(['phone'], 'phone'), true)
})

test('из событий WhatsApp берёт чаты и не берёт группы и чужие страны', () => {
  const extracted = extractWhatsAppPeers(
    [
      { id: '79280000001@s.whatsapp.net', name: 'Аминат', notify: 'A' },
      { id: '79280000001@s.whatsapp.net', chatName: 'короткое' },
      { id: '555@lid', jid: '79280000004@s.whatsapp.net', notify: 'Лид' },
      { id: '999@lid' },
      { id: '12025550143@s.whatsapp.net', name: 'Foreign' },
      { id: '1203630@g.us', name: 'Группа' },
      { id: 'status@broadcast' },
      { id: '79280000009@s.whatsapp.net', name: 'Я' },
    ],
    new Map([['777@lid', '79280000005']]),
    '79280000009',
  )
  const phones = extracted.contacts.map((item) => item.phone)
  assert.deepEqual(phones, ['79280000001', '79280000004'])
  assert.equal(extracted.contacts[0]?.name, 'Аминат')
  assert.equal(extracted.contacts[0]?.nameRank, 3)
  assert.deepEqual(extracted.contacts[0]?.sources, ['whatsapp'])
  assert.equal(extracted.skippedForeign, 1)
  assert.ok(extracted.lids.some((lid) => lid.lid === '999@lid' && lid.phone == null))
  const viaMap = extractWhatsAppPeers([{ id: '777@lid', notify: 'Из карты' }], new Map([['777@lid', '79280000005']]))
  assert.equal(viaMap.contacts[0]?.phone, '79280000005')
  assert.equal(viaMap.contacts[0]?.name, 'Из карты')
})

test('база хранит оба источника у одного номера и считает аудиторию', () => {
  const db = openDatabase(':memory:')
  db.applyMerge([draft({ phone: '79280000001', name: 'Аминат', nameRank: 3, tags: ['vip'], sources: ['phone'] })])
  const second = db.applyMerge([draft({ phone: '79280000001', name: 'Ami', nameRank: 1, tags: ['город'], sources: ['whatsapp'] })])
  assert.equal(second.added, 0)
  assert.equal(second.updated, 1)
  db.applyMerge([draft({ phone: '79280000002', name: '', nameRank: 0, sources: ['whatsapp'] })])
  const contact = db.searchContacts({ q: 'аминат', tag: '', source: 'both', limit: 10, offset: 0 })
  assert.equal(contact.total, 1)
  assert.equal(contact.items[0]?.name, 'Аминат')
  assert.deepEqual(contact.items[0]?.sources, ['phone', 'whatsapp'])
  assert.deepEqual(contact.items[0]?.tags.sort(), ['vip', 'город'].sort())
  assert.deepEqual(db.audiencePhones('whatsapp', null), ['79280000001', '79280000002'])
  assert.deepEqual(db.audiencePhones('phone', 'vip'), ['79280000001'])
  assert.deepEqual(db.audiencePhones('any', 'город'), ['79280000001'])
  const exported = db.listForExport({ q: '', tag: '', source: 'phone', limit: 10 })
  assert.deepEqual(exported.map((item) => item.phone), ['79280000001'])
  db.close()
})
