export type PhoneReason = 'empty' | 'too_short' | 'too_long' | 'not_ru' | 'ambiguous'

export type PhoneResult =
  | { ok: true; digits: string; e164: string; jid: string }
  | { ok: false; reason: PhoneReason }

export const PHONE_REASON_RU: Record<PhoneReason, string> = {
  empty: 'Пустой номер',
  too_short: 'Слишком мало цифр',
  too_long: 'Слишком много цифр',
  not_ru: 'Нужен российский номер в формате +7',
  ambiguous: 'Десять цифр без 9 в начале — неясно, как привести к +7',
}

export function normalizeRuPhone(input: string | null | undefined): PhoneResult {
  if (input == null) return { ok: false, reason: 'empty' }
  const raw = String(input).trim()
  if (!raw) return { ok: false, reason: 'empty' }

  const compact = raw.replace(/[\s\u00A0\u202F.\-()]/g, '')
  const hasPlus = compact.startsWith('+')
  const digits = compact.replace(/\D/g, '')
  if (!digits) return { ok: false, reason: 'empty' }
  if (digits.length < 10) return { ok: false, reason: 'too_short' }
  if (digits.length > 11) return { ok: false, reason: 'too_long' }
  if (hasPlus && digits.startsWith('8')) return { ok: false, reason: 'not_ru' }

  let national = ''
  if (digits.length === 11 && digits.startsWith('8')) national = `7${digits.slice(1)}`
  else if (digits.length === 11 && digits.startsWith('7')) national = digits
  else if (digits.length === 10 && digits.startsWith('9')) national = `7${digits}`
  else if (digits.length === 10) return { ok: false, reason: 'ambiguous' }
  else return { ok: false, reason: 'not_ru' }

  if (!/^7\d{10}$/.test(national)) return { ok: false, reason: 'not_ru' }
  return { ok: true, digits: national, e164: `+${national}`, jid: `${national}@s.whatsapp.net` }
}

export function formatRuPhone(digits: string): string {
  const parsed = normalizeRuPhone(digits)
  if (!parsed.ok) return digits
  const d = parsed.digits
  return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`
}

export type JidKind =
  | { kind: 'phone'; digits: string }
  | { kind: 'lid'; lid: string }
  | { kind: 'foreign' }
  | { kind: 'skip' }

/** Разбирает JID WhatsApp. Номер телефона берётся только из @s.whatsapp.net и @c.us. */
export function phoneFromUserJid(jid: string | null | undefined): JidKind {
  if (!jid) return { kind: 'skip' }
  const trimmed = jid.trim()
  if (!trimmed || trimmed === 'status@broadcast') return { kind: 'skip' }
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return { kind: 'skip' }
  const server = trimmed.slice(at + 1)
  const user = trimmed.slice(0, at).split(':')[0]?.split('_')[0] ?? ''
  if (!user) return { kind: 'skip' }
  if (server === 'g.us' || server === 'broadcast' || server === 'newsletter' || server === 'bot' || server === 'call') {
    return { kind: 'skip' }
  }
  if (server === 'lid') return { kind: 'lid', lid: `${user}@lid` }
  if (server === 's.whatsapp.net' || server === 'c.us') {
    const phone = normalizeRuPhone(user)
    if (phone.ok) return { kind: 'phone', digits: phone.digits }
    const rawDigits = user.replace(/\D/g, '')
    if (rawDigits.length >= 8) return { kind: 'foreign' }
    return { kind: 'skip' }
  }
  return { kind: 'skip' }
}
