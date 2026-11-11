import assert from 'node:assert/strict'
import test from 'node:test'

import ExcelJS from 'exceljs'

import { contactsToCsv, contactsToXlsx, type ExportRow } from '../src/exportContacts.js'

test('CSV и XLSX содержат источник', async () => {
  const rows: ExportRow[] = [{ phone: '79280000001', name: 'Аминат', tags: ['vip', 'грозный'], sources: ['phone', 'whatsapp'] }]
  const csv = contactsToCsv(rows)
  assert.ok(csv.startsWith('\uFEFF'))
  assert.match(csv, /телефон;имя;метки;источники/)
  assert.match(csv, /Аминат/)
  assert.match(csv, /Телефон, WhatsApp/)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await contactsToXlsx(rows) as unknown as Parameters<ExcelJS.Xlsx['load']>[0])
  const sheet = workbook.worksheets[0]
  assert.equal(sheet?.getRow(2).getCell(2).value, 'Аминат')
  assert.equal(sheet?.getRow(2).getCell(4).value, 'Телефон, WhatsApp')
})
