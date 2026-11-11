import { phoneFromUserJid } from './phone.js'
import { foldText, normalizeTagList } from './tags.js'
import type { AudienceSource, ContactDraft, ContactSource, SourceFilter } from './types.js'

export type MergeResult = {
  contacts: ContactDraft[]
  added: number
  updated: number
  unchanged: number
  duplicatesMerged: number
}

export function uniqueSources(sources: ContactSource[]): ContactSource[] {
  const present = new Set(sources)
  const ordered: ContactSource[] = []
  if (present.has('phone')) ordered.push('phone')
  if (present.has('whatsapp')) ordered.push('whatsapp')
  return ordered
}

export function mergeName(
  current: { name: string; nameRank: number },
  incoming: { name: string; nameRank: number },
): { name: string; nameRank: number } {
  const nextName = incoming.name.trim()
  const currentName = current.name.trim()
  if (!nextName) return { name: currentName, nameRank: currentName ? current.nameRank : 0 }
  if (!currentName) return { name: nextName, nameRank: incoming.nameRank }
  if (incoming.nameRank > current.nameRank) return { name: nextName, nameRank: incoming.nameRank }
  return { name: currentName, nameRank: current.nameRank }
}

function cloneDraft(item: ContactDraft): ContactDraft {
  const name = item.name.trim()
  return {
    phone: item.phone,
    name,
    nameRank: name ? item.nameRank : 0,
    tags: normalizeTagList(item.tags),
    sources: uniqueSources(item.sources),
  }
}

function combine(left: ContactDraft, right: ContactDraft): ContactDraft {
  const name = mergeName(left, right)
  return {
    phone: left.phone,
    name: name.name,
    nameRank: name.nameRank,
    tags: normalizeTagList([...left.tags, ...right.tags]),
    sources: uniqueSources([...left.sources, ...right.sources]),
  }
}

function sameDraft(left: ContactDraft, right: ContactDraft): boolean {
  return (
    left.name === right.name &&
    left.nameRank === right.nameRank &&
    left.tags.join('\n') === right.tags.join('\n') &&
    left.sources.join('\n') === right.sources.join('\n')
  )
}

/**
 * Склеивает входящие карточки с уже сохранёнными.
 * Один телефон — одна карточка. Источники и метки объединяются.
 * Пустое имя не затирает уже записанное. Имя с более высоким рангом заменяет более слабое.
 */
export function mergeContacts(existing: ContactDraft[], incoming: ContactDraft[]): MergeResult {
  const incomingMap = new Map<string, ContactDraft>()
  let duplicatesMerged = 0
  for (const item of incoming) {
    const draft = cloneDraft(item)
    const prev = incomingMap.get(draft.phone)
    if (!prev) {
      incomingMap.set(draft.phone, draft)
      continue
    }
    duplicatesMerged += 1
    incomingMap.set(draft.phone, combine(prev, draft))
  }

  const result = new Map<string, ContactDraft>()
  for (const item of existing) result.set(item.phone, cloneDraft(item))

  let added = 0
  let updated = 0
  let unchanged = 0
  for (const item of incomingMap.values()) {
    const prev = result.get(item.phone)
    if (!prev) {
      result.set(item.phone, item)
      added += 1
      continue
    }
    const next = combine(prev, item)
    if (sameDraft(prev, next)) unchanged += 1
    else {
      result.set(item.phone, next)
      updated += 1
    }
  }

  const contacts = [...result.values()].sort((a, b) => a.phone.localeCompare(b.phone))
  return { contacts, added, updated, unchanged, duplicatesMerged }
}

export function matchesSourceFilter(sources: ContactSource[], filter: SourceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'whatsapp') return sources.includes('whatsapp')
  if (filter === 'phone') return sources.includes('phone')
  return sources.includes('whatsapp') && sources.includes('phone')
}

export function filterAudience(
  contacts: ContactDraft[],
  opts: { source: AudienceSource; tag?: string | null },
): ContactDraft[] {
  const tagFold = opts.tag?.trim() ? foldText(opts.tag) : ''
  return contacts.filter((contact) => {
    if (opts.source === 'whatsapp' && !contact.sources.includes('whatsapp')) return false
    if (opts.source === 'phone' && !contact.sources.includes('phone')) return false
    if (tagFold && !contact.tags.some((tag) => foldText(tag) === tagFold)) return false
    return true
  })
}

export type WaPeerInput = {
  id?: string | null
  jid?: string | null
  lid?: string | null
  name?: string | null
  notify?: string | null
  verifiedName?: string | null
  chatName?: string | null
}

export type LidNote = {
  lid: string
  phone: string | null
  name: string
  nameRank: number
}

export type ExtractResult = {
  contacts: ContactDraft[]
  lids: LidNote[]
  skippedForeign: number
  duplicatesMerged: number
}

function clean(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ')
}

export function bestWaName(parts: {
  name?: string | null
  verifiedName?: string | null
  notify?: string | null
  chatName?: string | null
}): { name: string; nameRank: number } {
  const saved = clean(parts.name)
  if (saved) return { name: saved, nameRank: 3 }
  const verified = clean(parts.verifiedName)
  if (verified) return { name: verified, nameRank: 2 }
  const notify = clean(parts.notify) || clean(parts.chatName)
  if (notify) return { name: notify, nameRank: 1 }
  return { name: '', nameRank: 0 }
}

function rememberLid(map: Map<string, LidNote>, note: LidNote): void {
  const prev = map.get(note.lid)
  if (!prev) {
    map.set(note.lid, note)
    return
  }
  const name = mergeName(prev, note)
  map.set(note.lid, {
    lid: note.lid,
    phone: note.phone ?? prev.phone,
    name: name.name,
    nameRank: name.nameRank,
  })
}

/**
 * Достаёт российские номера из событий Baileys (контакты, чаты, история).
 * Группы, рассылки и LID без пары «номер» пропускаются.
 */
export function extractWhatsAppPeers(
  peers: WaPeerInput[],
  lidToPhone: ReadonlyMap<string, string>,
  selfPhone?: string | null,
): ExtractResult {
  const drafts: ContactDraft[] = []
  const lids = new Map<string, LidNote>()
  let skippedForeign = 0

  for (const peer of peers) {
    const named = bestWaName(peer)
    const candidates = [peer.jid, peer.id, peer.lid]
    let phone: string | null = null
    let lid: string | null = null
    for (const candidate of candidates) {
      const parsed = phoneFromUserJid(candidate)
      if (parsed.kind === 'phone' && !phone) phone = parsed.digits
      else if (parsed.kind === 'foreign') skippedForeign += 1
      else if (parsed.kind === 'lid' && !lid) lid = parsed.lid
    }
    if (!phone && lid) {
      const mapped = lidToPhone.get(lid)
      if (mapped) phone = mapped
    }
    if (lid) rememberLid(lids, { lid, phone, name: named.name, nameRank: named.nameRank })
    if (!phone || phone === selfPhone) continue
    drafts.push({
      phone,
      name: named.name,
      nameRank: named.nameRank,
      tags: [],
      sources: ['whatsapp'],
    })
  }

  const merged = mergeContacts([], drafts)
  return {
    contacts: merged.contacts,
    lids: [...lids.values()],
    skippedForeign,
    duplicatesMerged: merged.duplicatesMerged,
  }
}
