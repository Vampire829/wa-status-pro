import https from 'node:https'
import type { Agent as HttpsAgent } from 'node:https'

import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const SCHEMES = ['http', 'https', 'socks5', 'socks5h'] as const
export type ProxyScheme = (typeof SCHEMES)[number]

export type ProxyConfig = {
  scheme: ProxyScheme
  hostname: string
  port: number
  username?: string
  password?: string
  /** Адрес без логина и пароля, его можно писать в журнал. */
  redacted: string
}

const DEFAULT_PORT: Record<ProxyScheme, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
}

export function parseProxyUrl(raw: string): ProxyConfig {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Адрес прокси пустой')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('WA_PROXY_URL не похож на адрес прокси')
  }
  const scheme = url.protocol.replace(/:$/, '')
  if (!SCHEMES.includes(scheme as ProxyScheme)) {
    throw new Error('WA_PROXY_URL поддерживает только http://, https://, socks5:// и socks5h://')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) throw new Error('В WA_PROXY_URL не указан хост')
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('В WA_PROXY_URL не нужны путь и параметры, только хост, порт и при необходимости логин')
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORT[scheme as ProxyScheme]
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('В WA_PROXY_URL указан неверный порт')
  }
  const username = url.username ? decodeURIComponent(url.username) : undefined
  const password = url.password ? decodeURIComponent(url.password) : undefined
  return {
    scheme: scheme as ProxyScheme,
    hostname,
    port,
    username: username || undefined,
    password: password || undefined,
    redacted: `${scheme}://${formatHost(hostname)}:${port}`,
  }
}

export function readProxyEnv(raw: string | undefined): { url: string; config: ProxyConfig } | null {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return null
  return { url: trimmed, config: parseProxyUrl(trimmed) }
}

export function createProxyAgent(proxyUrl: string): HttpsAgent {
  const parsed = parseProxyUrl(proxyUrl)
  const agent = parsed.scheme === 'socks5' || parsed.scheme === 'socks5h'
    ? new SocksProxyAgent(proxyUrl.trim())
    : new HttpsProxyAgent(proxyUrl.trim())
  return agent as unknown as HttpsAgent
}

export type ProxyProbe = {
  ok: boolean
  direct: boolean
  latencyMs: number
  status?: number
  error?: string
  at: string
}

/** Запрос к web.whatsapp.com тем же агентом, через который пойдёт сокет и медиа. */
export function probeWhatsApp(agent: HttpsAgent | undefined, timeoutMs = 12_000): Promise<ProxyProbe> {
  const started = Date.now()
  const direct = !agent
  return new Promise((resolve) => {
    const req = https.get(
      'https://web.whatsapp.com/',
      {
        agent,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0 WAStatusPro/0.1', Accept: 'text/html' },
      },
      (response) => {
        response.resume()
        const status = response.statusCode ?? 0
        resolve({
          ok: status > 0,
          direct,
          latencyMs: Date.now() - started,
          status,
          at: new Date().toISOString(),
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({
        ok: false,
        direct,
        latencyMs: Date.now() - started,
        error: 'Таймаут: web.whatsapp.com не ответил',
        at: new Date().toISOString(),
      })
    })
    req.on('error', (error) => {
      resolve({
        ok: false,
        direct,
        latencyMs: Date.now() - started,
        error: error.message.slice(0, 240),
        at: new Date().toISOString(),
      })
    })
  })
}

export function redactProxyMessage(message: string): string {
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1***@')
}

function formatHost(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname
}
