export const STATUS_TTL_MS = 24 * 60 * 60 * 1000

/** `79990001122:17@s.whatsapp.net` → `79990001122@s.whatsapp.net`. */
export function normalizeOwnJid(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'status@broadcast') return null
  const at = trimmed.lastIndexOf('@')
  const server = at >= 0 ? trimmed.slice(at + 1) : ''
  if (server === 'lid' || server === 'g.us' || server === 'broadcast' || server === 'newsletter') return null
  const user = (at >= 0 ? trimmed.slice(0, at) : trimmed).split(':')[0]?.split('_')[0]?.replace(/\D/g, '') ?? ''
  if (!/^\d{8,15}$/.test(user)) return null
  return `${user}@s.whatsapp.net`
}

/** В каждую пачку добавляет JID владельца, чтобы статус появился в «Моём статусе» на телефоне. */
export function withOwnJid(batches: string[][], ownJid: string | null): string[][] {
  if (!ownJid) return batches.map((batch) => [...batch])
  return batches.map((batch) => (batch.includes(ownJid) ? [...batch] : [ownJid, ...batch]))
}

export function audienceCount(jids: string[], ownJid: string | null): number {
  return jids.filter((jid) => jid !== ownJid).length
}

export function cooldownRemainingMs(lastFinishedIso: string | null, intervalMs: number, nowMs: number): number {
  if (!lastFinishedIso || intervalMs <= 0) return 0
  const last = new Date(lastFinishedIso).getTime()
  if (Number.isNaN(last)) return 0
  return Math.max(0, last + intervalMs - nowMs)
}

export function statusExpiresAt(baseIso: string | null | undefined): string | null {
  if (!baseIso) return null
  const time = new Date(baseIso).getTime()
  if (Number.isNaN(time)) return null
  return new Date(time + STATUS_TTL_MS).toISOString()
}

export type VideoFacts = {
  videoCodec: string
  profile: string
  pixFmt: string
  width: number
  height: number
  duration: number
  audioCodec: string | null
  format: string
}

/** Уже подходящий ролик не перекодируем: так не тратим память на VPS. */
export function videoNeedsTranscode(facts: VideoFacts, maxSeconds: number): boolean {
  const profile = facts.profile.trim().toLowerCase()
  const audioOk = facts.audioCodec == null || facts.audioCodec === 'aac'
  return !(
    facts.videoCodec === 'h264' &&
    profile === 'high' &&
    facts.pixFmt === 'yuv420p' &&
    facts.width > 0 &&
    facts.width <= 720 &&
    facts.height > 0 &&
    facts.height <= 1280 &&
    facts.duration > 0 &&
    facts.duration <= maxSeconds + 0.25 &&
    audioOk &&
    facts.format.toLowerCase().includes('mp4')
  )
}

export type ReceiptInput = {
  remoteJid?: string | null
  messageId?: string | null
  userJid?: string | null
  readTimestamp?: number | null
  playedTimestamp?: number | null
  status?: number | null
}

/** Квитанция просмотра статуса. Доставка без read/played не считается. */
export function viewFromReceipt(input: ReceiptInput, nowMs = Date.now()): { messageId: string; viewerJid: string; viewedAt: string } | null {
  if (input.remoteJid !== 'status@broadcast') return null
  const messageId = input.messageId?.trim()
  const viewerJid = normalizeOwnJid(input.userJid)
  if (!messageId || !viewerJid) return null
  const read = positiveSeconds(input.readTimestamp)
  const played = positiveSeconds(input.playedTimestamp)
  const status = input.status ?? null
  const viewed = status === 4 || status === 5 || read != null || played != null
  if (!viewed) return null
  const seconds = played ?? read
  const viewedAt = seconds != null ? new Date(seconds * 1000).toISOString() : new Date(nowMs).toISOString()
  return { messageId, viewerJid, viewedAt }
}

export type AudienceMode = 'all' | 'exclude' | 'only'

export type AudienceSpec = {
  mode: AudienceMode
  excludeTags: string[]
  excludePhones: string[]
  includeTags: string[]
  includeSources: Array<'whatsapp' | 'phone'>
  includePhones: string[]
}

export type AudienceContact = {
  phone: string
  tags: string[]
  sources: Array<'whatsapp' | 'phone'>
}

export function emptyAudience(mode: AudienceMode = 'all'): AudienceSpec {
  return { mode, excludeTags: [], excludePhones: [], includeTags: [], includeSources: [], includePhones: [] }
}

export function parseAudienceSpec(raw: unknown): AudienceSpec {
  const source = raw && typeof raw === 'object' ? raw as Partial<AudienceSpec> : {}
  const mode = source.mode === 'exclude' || source.mode === 'only' ? source.mode : 'all'
  return {
    mode,
    excludeTags: stringList(source.excludeTags),
    excludePhones: stringList(source.excludePhones).map((phone) => phone.replace(/\D/g, '')),
    includeTags: stringList(source.includeTags),
    includeSources: stringList(source.includeSources).filter((item): item is 'whatsapp' | 'phone' => item === 'whatsapp' || item === 'phone'),
    includePhones: stringList(source.includePhones).map((phone) => phone.replace(/\D/g, '')),
  }
}

export function matchAudience(contact: AudienceContact, spec: AudienceSpec): boolean {
  const tags = new Set(contact.tags.map((tag) => tag.trim().toLocaleLowerCase('ru-RU')))
  const phones = new Set([contact.phone, contact.phone.replace(/\D/g, '')])
  if (spec.mode === 'exclude') {
    if (spec.excludePhones.some((phone) => phones.has(phone))) return false
    if (spec.excludeTags.some((tag) => tags.has(tag.trim().toLocaleLowerCase('ru-RU')))) return false
    return true
  }
  if (spec.mode === 'only') {
    if (spec.includePhones.some((phone) => phones.has(phone))) return true
    if (spec.includeTags.some((tag) => tags.has(tag.trim().toLocaleLowerCase('ru-RU')))) return true
    if (spec.includeSources.some((source) => contact.sources.includes(source))) return true
    return false
  }
  return true
}

export function planVideoSegments(duration: number, maxSeconds: number): { start: number; end: number }[] {
  const max = Math.max(1, maxSeconds)
  if (!Number.isFinite(duration) || duration <= 0) return [{ start: 0, end: max }]
  if (duration <= max + 0.05) return [{ start: 0, end: roundSeconds(duration) }]
  const parts: { start: number; end: number }[] = []
  for (let start = 0; start < duration - 0.05; start += max) {
    parts.push({ start: roundSeconds(start), end: roundSeconds(Math.min(duration, start + max)) })
  }
  return parts
}

export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ')
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 100)
}

function roundSeconds(value: number): number {
  return Math.round(value * 10) / 10
}

export function statusDeleteKey(messageId: string): { remoteJid: 'status@broadcast'; fromMe: true; id: string } {
  return { remoteJid: 'status@broadcast', fromMe: true, id: messageId }
}

function positiveSeconds(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return value
}
