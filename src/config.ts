import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type AppConfig = {
  host: string
  port: number
  dataDir: string
  adminPassword: string
  sessionSecret: string
  sessionTtlHours: number
  cookieSecure: boolean
  trustProxy: boolean
  batchSize: number
  batchDelayMs: number
  minPublishIntervalMs: number
  maxUploadMb: number
  maxVideoSeconds: number
  ffmpegPath: string
  logLevel: string
  baileysLogLevel: string
  syncFullHistory: boolean
  warnDefaultPassword: boolean
  warnDefaultSecret: boolean
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`Переменная ${name} должна быть числом`)
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

function ensureSecret(dataDir: string): { secret: string; generated: boolean } {
  const fromEnv = process.env.SESSION_SECRET?.trim() ?? ''
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error('SESSION_SECRET должен быть не короче 16 символов')
    return { secret: fromEnv, generated: false }
  }
  const secretPath = path.join(dataDir, 'session.secret')
  if (fs.existsSync(secretPath)) {
    const stored = fs.readFileSync(secretPath, 'utf8').trim()
    if (stored.length >= 16) return { secret: stored, generated: true }
  }
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })
  return { secret, generated: true }
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.DATA_DIR || './data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true })

  const adminPassword = process.env.ADMIN_PASSWORD ?? ''
  if (adminPassword.length < 8) {
    throw new Error('Задайте ADMIN_PASSWORD длиной не меньше 8 символов')
  }
  const session = ensureSecret(dataDir)
  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: intEnv('PORT', 8080, 1, 65535),
    dataDir,
    adminPassword,
    sessionSecret: session.secret,
    sessionTtlHours: intEnv('SESSION_TTL_HOURS', 72, 1, 24 * 30),
    cookieSecure: boolEnv('COOKIE_SECURE', false),
    trustProxy: boolEnv('TRUST_PROXY', true),
    batchSize: intEnv('STATUS_BATCH_SIZE', 100, 1, 500),
    batchDelayMs: intEnv('STATUS_BATCH_DELAY_MS', 4000, 500, 120000),
    minPublishIntervalMs: intEnv('MIN_PUBLISH_INTERVAL_MS', 20000, 0, 600000),
    maxUploadMb: intEnv('MAX_UPLOAD_MB', 64, 1, 512),
    maxVideoSeconds: intEnv('MAX_VIDEO_SECONDS', 30, 1, 180),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    baileysLogLevel: process.env.BAILEYS_LOG_LEVEL?.trim() || 'silent',
    syncFullHistory: boolEnv('WA_SYNC_FULL_HISTORY', false),
    warnDefaultPassword: adminPassword === 'change-me-please',
    warnDefaultSecret: session.generated || (process.env.SESSION_SECRET ?? '').includes('замените'),
  }
}
