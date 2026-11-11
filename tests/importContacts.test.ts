import assert from 'node:assert/strict'
import test from 'node:test'

import ExcelJS from 'exceljs'
import iconv from 'iconv-lite'

import { buildImportPlan, parseContactFile, parseCsv, parseVcf } from '../src/importContacts.js'

test('читает CSV с точкой с запятой, кавычками и дублями', () => {
  const text = 'телефон;имя;метки\n+7 (928) 000-00-01;Аминат;vip|грозный\n89280000001;Амина;"vip,друг"\nне номер;x;\n9280000003;;\n'
  const plan = buildImportPlan(parseCsv(text))
  assert.equal(plan.contacts.length, 2)
  assert.equal(plan.duplicatesMerged, 1)
  const first = plan.contacts.find((item) => item.phone === '79280000001')
  assert.equal(first?.name, 'Аминат')
  assert.ok(first?.tags.includes('vip'))
  assert.ok(first?.tags.includes('друг'))
  assert.deepEqual(first?.sources, ['phone'])
  assert.equal(plan.contacts.find((item) => item.phone === '79280000003')?.name, '')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0]?.row, 4)
})

test('читает выгрузку Google CSV и win1251', () => {
  const google = 'Name,Given Name,Family Name,Phone 1 - Type,Phone 1 - Value,Group Membership\nАминат,Амина,,Mobile,+7 928 000-00-06,* myContacts ::: vip\n'
  const plan = buildImportPlan(parseCsv(google))
  assert.equal(plan.contacts[0]?.phone, '79280000006')
  assert.equal(plan.contacts[0]?.name, 'Аминат')
  assert.deepEqual(plan.contacts[0]?.tags, ['vip'])

  const buffer = iconv.encode('телефон;имя\n89280000007;Зарема\n', 'win1251')
  return parseContactFile('book.csv', buffer).then((raws) => {
    const decoded = buildImportPlan(raws)
    assert.equal(decoded.contacts[0]?.name, 'Зарема')
    assert.equal(decoded.contacts[0]?.phone, '79280000007')
  })
})

test('читает VCF с quoted-printable и waid', () => {
  const name = Buffer.from('Аминат').toString('hex').replace(/(..)/g, '=$1')
  const text = `BEGIN:VCARD\nVERSION:3.0\nFN;ENCODING=QUOTED-PRINTABLE:${name}\nTEL;TYPE=CELL;WAID=79280000008:+7 928 000-00-08\nCATEGORIES:vip,город\nEND:VCARD\nBEGIN:VCARD\nFN:Без телефона\nEND:VCARD\n`
  const plan = buildImportPlan(parseVcf(text))
  assert.equal(plan.contacts.length, 1)
  assert.equal(plan.contacts[0]?.phone, '79280000008')
  assert.equal(plan.contacts[0]?.name, 'Аминат')
  assert.deepEqual(plan.contacts[0]?.tags, ['vip', 'город'])
})

test('читает xlsx', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Книга')
  sheet.addRow(['телефон', 'имя', 'метки'])
  sheet.addRow(['8 928 000-00-09', 'Малика', 'чечня'])
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  const raws = await parseContactFile('book.xlsx', buffer)
  const plan = buildImportPlan(raws)
  assert.equal(plan.contacts[0]?.phone, '79280000009')
  assert.equal(plan.contacts[0]?.name, 'Малика')
  assert.deepEqual(plan.contacts[0]?.tags, ['чечня'])
})
