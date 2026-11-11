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

export function statusDeleteKey(messageId: string): { remoteJid: 'status@broadcast'; fromMe: true; id: string } {
  return { remoteJid: 'status@broadcast', fromMe: true, id: messageId }
}

function positiveSeconds(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return value
}
