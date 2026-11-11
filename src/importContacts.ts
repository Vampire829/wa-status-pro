import ExcelJS from 'exceljs'
import iconv from 'iconv-lite'
import path from 'node:path'

import { mergeContacts } from './contactsMerge.js'
import { ImportFormatError } from './errors.js'
import { PHONE_REASON_RU, normalizeRuPhone } from './phone.js'
import { foldText, normalizeTagList } from './tags.js'
import type { ContactDraft, ImportIssue } from './types.js'

export type RawContact = {
  phoneRaw: string
  name?: string
  tags?: string[]
  row?: number
}

export type ImportPlan = {
  contacts: ContactDraft[]
  issues: ImportIssue[]
  duplicatesMerged: number
}

type TableRow = { line: number; cells: string[] }
type HeaderKind = 'phone' | 'phone-skip' | 'name' | 'given' | 'family' | 'tags' | 'other'

export function decodeUpload(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  const asUtf8 = buffer.toString('utf8')
  if (asUtf8.includes('\uFFFD')) return iconv.decode(buffer, 'win1251')
  return asUtf8
}

export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 8)
  const score = (delimiter: string) => lines.reduce((sum, line) => sum + countOutsideQuotes(line, delimiter), 0)
  const commas = score(',')
  const semis = score(';')
  const tabs = score('\t')
  if (tabs > commas && tabs > semis) return '\t'
  if (semis > commas) return ';'
  return ','
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') i += 1
      else quoted = !quoted
    } else if (!quoted && ch === delimiter) count += 1
  }
  return count
}

export function parseDelimited(text: string, delimiter: string): TableRow[] {
  const rows: TableRow[] = []
  let cells: string[] = []
  let current = ''
  let quoted = false
  let line = 1
  let recordLine = 1

  const pushCell = () => {
    cells.push(current)
    current = ''
  }
  const pushRow = () => {
    if (cells.some((cell) => cell.trim())) rows.push({ line: recordLine, cells })
    cells = []
    recordLine = line
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"'
          i += 1
        } else quoted = false
      } else {
        if (ch === '\n') line += 1
        current += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === delimiter) pushCell()
    else if (ch === '\n') {
      pushCell()
      pushRow()
      line += 1
      recordLine = line
    } else if (ch !== '\r') current += ch
  }
  pushCell()
  pushRow()
  return rows
}

function classifyHeader(cell: string): HeaderKind {
  const h = foldText(cell).replace(/^\uFEFF/, '')
  if (!h) return 'other'
  const phoneWord = h.includes('phone') || h.includes('mobile') || h.includes('телефон') || h.includes('ватсап') || h.includes('вацап') || h === 'tel' || h === 'whatsapp' || h === 'wa'
  const numberWord = h === 'номер' || h === 'мобильный' || h === 'number' || (h.includes('номер') && !h.includes('счет') && !h.includes('счёт'))
  if ((phoneWord || numberWord) && (h.includes('type') || h.includes('label') || h.includes('тип'))) return 'phone-skip'
  if (phoneWord || numberWord || h === 'telephone') return 'phone'
  if (h === 'given name' || h === 'first name') return 'given'
  if (h === 'family name' || h === 'last name' || h === 'фамилия') return 'family'
  if (['name', 'fullname', 'full name', 'file as', 'имя', 'фио', 'контакт', 'название'].includes(h)) return 'name'
  if (['tag', 'tags', 'labels', 'group', 'groups', 'group membership', 'метка', 'метки', 'тег', 'теги', 'группа'].includes(h)) return 'tags'
  return 'other'
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

export function tableToRawContacts(rows: TableRow[]): RawContact[] {
  if (rows.length === 0) return []
  const headerKinds = rows[0].cells.map((cell) => classifyHeader(cell))
  const hasHeader = headerKinds.some((kind) => kind === 'phone' || kind === 'name' || kind === 'tags' || kind === 'given')
  if (hasHeader) {
    const phoneCols = headerKinds.flatMap((kind, index) => (kind === 'phone' ? [index] : []))
    if (phoneCols.length === 0) {
      throw new ImportFormatError('В заголовке не найден столбец телефона (телефон, phone, номер).')
    }
    const nameCol = headerKinds.indexOf('name')
    const givenCol = headerKinds.indexOf('given')
    const familyCol = headerKinds.indexOf('family')
    const tagCol = headerKinds.indexOf('tags')
    const raws: RawContact[] = []
    for (const row of rows.slice(1)) {
      const name = buildName(row.cells, nameCol, givenCol, familyCol)
      const tags = tagCol >= 0 ? normalizeTagList([row.cells[tagCol] ?? '']) : []
      for (const col of phoneCols) {
        const phoneRaw = (row.cells[col] ?? '').trim()
        if (!phoneRaw) continue
        raws.push({ phoneRaw, name, tags, row: row.line })
      }
    }
    return raws
  }

  const width = Math.max(...rows.map((row) => row.cells.length))
  const scores = Array.from({ length: width }, (_, col) => {
    let hits = 0
    let filled = 0
    for (const row of rows.slice(0, 30)) {
      const value = (row.cells[col] ?? '').trim()
      if (!value) continue
      filled += 1
      if (looksLikePhone(value)) hits += 1
    }
    return filled === 0 ? 0 : hits / filled
  })
  let phoneCol = 0
  let best = -1
  scores.forEach((score, index) => {
    if (score > best) {
      best = score
      phoneCol = index
    }
  })
  const others = scores.map((_, index) => index).filter((index) => index !== phoneCol)
  const nameCol = others[0] ?? -1
  const tagCol = others[1] ?? -1
  return rows.flatMap((row) => {
    const phoneRaw = (row.cells[phoneCol] ?? '').trim()
    if (!phoneRaw) return []
    return [{
      phoneRaw,
      name: nameCol >= 0 ? (row.cells[nameCol] ?? '').trim() : '',
      tags: tagCol >= 0 ? normalizeTagList([row.cells[tagCol] ?? '']) : [],
      row: row.line,
    }]
  })
}

function buildName(cells: string[], nameCol: number, givenCol: number, familyCol: number): string {
  const named = nameCol >= 0 ? (cells[nameCol] ?? '').trim() : ''
  if (named) return named
  return [givenCol >= 0 ? cells[givenCol] : '', familyCol >= 0 ? cells[familyCol] : '']
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

export function parseCsv(text: string): RawContact[] {
  const normalized = text.replace(/^\uFEFF/, '')
  const delimiter = detectDelimiter(normalized)
  return tableToRawContacts(parseDelimited(normalized, delimiter))
}

function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '=' && /[0-9A-Fa-f]{2}/.test(input.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(input.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(input.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

function unfoldVcard(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').replace(/=\n/g, '')
}

export function parseVcf(text: string): RawContact[] {
  const unfolded = unfoldVcard(text)
  const cards = unfolded.split(/BEGIN:VCARD/i).slice(1)
  const raws: RawContact[] = []
  for (const card of cards) {
    const body = card.split(/END:VCARD/i)[0] ?? ''
    let name = ''
    let family = ''
    let given = ''
    const tags: string[] = []
    const phones: string[] = []
    for (const line of body.split('\n')) {
      if (!line.trim()) continue
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      const left = line.slice(0, colon)
      let value = line.slice(colon + 1).trim()
      const [property, ...paramParts] = left.split(';')
      const params = paramParts.join(';')
      if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) value = decodeQuotedPrintable(value).trim()
      const base = property.split('.').pop()?.toUpperCase() ?? ''
      if (base === 'FN' && value) name = value
      else if (base === 'N' && value) {
        const bits = value.split(';')
        family = bits[0] ?? ''
        given = bits[1] ?? ''
      } else if (base === 'TEL' && value) {
        const waid = /waid=(\d+)/i.exec(params)
        phones.push(waid?.[1] ?? value.replace(/^tel:/i, ''))
      } else if (base === 'CATEGORIES' && value) tags.push(value)
    }
    const display = name || [given, family].filter(Boolean).join(' ')
    for (const phoneRaw of phones) {
      if (phoneRaw.trim()) raws.push({ phoneRaw: phoneRaw.trim(), name: display, tags: normalizeTagList(tags) })
    }
  }
  return raws
}

function cellToString(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) return String(value)
    return String(value)
  }
  if (value instanceof Date) return ''
  if (typeof value === 'object') {
    const record = value as { text?: unknown; result?: unknown; richText?: { text?: unknown }[] }
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.richText)) return record.richText.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
    if ('result' in record) return cellToString(record.result)
  }
  return ''
}

export async function parseXlsx(buffer: Buffer): Promise<RawContact[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<ExcelJS.Xlsx['load']>[0])
  const sheet = workbook.worksheets[0]
  if (!sheet) return []
  const rows: TableRow[] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]
    const cells: string[] = []
    for (let index = 1; index < values.length; index += 1) cells.push(cellToString(values[index]))
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.some((cell) => cell.trim())) rows.push({ line: row.number, cells })
  })
  return tableToRawContacts(rows)
}

export async function parseContactFile(filename: string, buffer: Buffer): Promise<RawContact[]> {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.xls') throw new ImportFormatError('Старый формат .xls не читается. Сохраните книгу как .xlsx.')
  if (ext === '.vcf' || ext === '.vcard') return parseVcf(decodeUpload(buffer))
  if (ext === '.xlsx') return parseXlsx(buffer)
  if (ext === '.csv' || ext === '.txt' || ext === '') return parseCsv(decodeUpload(buffer))
  throw new ImportFormatError('Поддерживаются файлы CSV, TXT, XLSX и VCF.')
}

export function buildImportPlan(raws: RawContact[]): ImportPlan {
  const issues: ImportIssue[] = []
  const drafts: ContactDraft[] = []
  for (const raw of raws) {
    const phone = normalizeRuPhone(raw.phoneRaw)
    if (!phone.ok) {
      issues.push({ row: raw.row, raw: raw.phoneRaw, reason: PHONE_REASON_RU[phone.reason] })
      continue
    }
    const name = (raw.name ?? '').trim().slice(0, 80)
    drafts.push({
      phone: phone.digits,
      name,
      nameRank: name ? 3 : 0,
      tags: normalizeTagList(raw.tags ?? []),
      sources: ['phone'],
    })
  }
  const merged = mergeContacts([], drafts)
  return { contacts: merged.contacts, issues, duplicatesMerged: merged.duplicatesMerged }
}
