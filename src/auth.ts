import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE = 'wsp_session'

export function passwordsMatch(input: string, expected: string): boolean {
  const left = createHash('sha256').update(input).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

export function issueSession(secret: string, ttlMs: number, now = Date.now()): { token: string; csrf: string; maxAgeSec: number } {
  const csrf = randomBytes(18).toString('base64url')
  const body = Buffer.from(JSON.stringify({ exp: now + ttlMs, csrf })).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return { token: `${body}.${sig}`, csrf, maxAgeSec: Math.floor(ttlMs / 1000) }
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): { csrf: string } | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  if (!body || !sig) return null
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const left = Buffer.from(sig)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: unknown; csrf?: unknown }
    if (typeof payload.exp !== 'number' || typeof payload.csrf !== 'string') return null
    if (payload.exp < now || payload.csrf.length < 8) return null
    return { csrf: payload.csrf }
  } catch {
    return null
  }
}

export function csrfOk(sessionCsrf: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || !provided) return false
  const left = createHash('sha256').update(sessionCsrf).digest()
  const right = createHash('sha256').update(provided).digest()
  return timingSafeEqual(left, right)
}

export function readCookie(header: string | undefined, name = COOKIE): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

type Bucket = { fails: number; until: number }

export function createLoginGuard() {
  const buckets = new Map<string, Bucket>()
  return {
    allowed(ip: string, now = Date.now()): boolean {
      const bucket = buckets.get(ip)
      if (!bucket) return true
      if (bucket.until <= now) {
        buckets.delete(ip)
        return true
      }
      return bucket.fails < 5
    },
    fail(ip: string, now = Date.now()): void {
      const bucket = buckets.get(ip)
      if (!bucket || bucket.until <= now) {
        buckets.set(ip, { fails: 1, until: now + 15 * 60 * 1000 })
        return
      }
      bucket.fails += 1
    },
    succeed(ip: string): void {
      buckets.delete(ip)
    },
  }
}
