const MOSCOW = 'Europe/Moscow'

export function nowIso(date = new Date()): string {
  return date.toISOString()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Строка из datetime-local считается московским временем (UTC+3, без летнего перевода). */
export function moscowLocalToUtcIso(local: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? '0')
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const date = new Date(Date.UTC(year, month - 1, day, hour - 3, minute, second))
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MOSCOW,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  const pad = (n: number) => String(n).padStart(2, '0')
  if (
    get('year') !== String(year) ||
    get('month') !== pad(month) ||
    get('day') !== pad(day) ||
    get('hour') !== pad(hour) ||
    get('minute') !== pad(minute) ||
    get('second') !== pad(second)
  ) {
    return null
  }
  return date.toISOString()
}

export function formatMoscow(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const text = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MOSCOW,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
  return `${text} МСК`
}

export function moscowDayStartUtc(now = new Date()): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return moscowLocalToUtcIso(`${day}T00:00`) ?? now.toISOString()
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} с`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  return `${hours} ч ${minutes % 60} мин`
}
