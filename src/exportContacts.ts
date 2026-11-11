import ExcelJS from 'exceljs'

import { sourceListLabel } from './labels.js'
import { formatRuPhone } from './phone.js'
import type { ContactSource } from './types.js'

export type ExportRow = {
  phone: string
  name: string
  tags: string[]
  sources: ContactSource[]
}

function csvCell(value: string): string {
  if (/[;"\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** CSV для русского Excel: UTF-8 с BOM и разделитель «;». */
export function contactsToCsv(rows: ExportRow[]): string {
  const lines = ['телефон;имя;метки;источники']
  for (const row of rows) {
    lines.push(
      [
        csvCell(formatRuPhone(row.phone)),
        csvCell(row.name),
        csvCell(row.tags.join(', ')),
        csvCell(sourceListLabel(row.sources)),
      ].join(';'),
    )
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export async function contactsToXlsx(rows: ExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'WA Status Pro'
  const sheet = workbook.addWorksheet('Контакты')
  sheet.columns = [
    { header: 'Телефон', key: 'phone', width: 22 },
    { header: 'Имя', key: 'name', width: 28 },
    { header: 'Метки', key: 'tags', width: 28 },
    { header: 'Источники', key: 'sources', width: 24 },
  ]
  sheet.getRow(1).font = { bold: true }
  for (const row of rows) {
    const added = sheet.addRow({
      phone: formatRuPhone(row.phone),
      name: row.name,
      tags: row.tags.join(', '),
      sources: sourceListLabel(row.sources),
    })
    added.getCell(1).numFmt = '@'
  }
  const out = await workbook.xlsx.writeBuffer()
  return Buffer.from(out)
}
