import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAVersion,
} from '@whiskeysockets/baileys'
import makeWASocket from '@whiskeysockets/baileys'
import type { Agent as HttpsAgent } from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'

import type { AppConfig } from './config.js'
import { extractWhatsAppPeers, type WaPeerInput } from './contactsMerge.js'
import type { AppDb } from './db.js'
import { WaSendError } from './errors.js'
import { createProxyAgent, probeWhatsApp, redactProxyMessage, type ProxyProbe } from './proxy.js'
import { planReconnect } from './reconnect.js'
import { normalizeOwnJid, viewFromReceipt } from './statusLogic.js'
import type { AccountStatus } from './types.js'
import { sleep } from './time.js'

type Logger = (level: 'info' | 'warn' | 'error', message: string, accountId?: string | null) => void

type Sock = ReturnType<typeof makeWASocket>

type Session = {
  sock: Sock | null
  generation: number
  state: AccountStatus
  qrDataUrl: string | null
  phone: string | null
  lastError: string | null
  suppressReconnect: boolean
  backoffMs: number
  timer: NodeJS.Timeout | null
  booting: boolean
  wasConnected: boolean
  qrSeq: number
  qrAnnounced: boolean
  qrRefreshStrikes: number
  lastWarnWait: number
  discoveredCount: number
  updates: Promise<void>
}

export type RuntimeSnapshot = {
  status: AccountStatus
  qrDataUrl: string | null
  phone: string | null
  lastError: string | null
  discovered: number
  historyComplete: boolean
}

export type SyncResult =
  | { ok: true; added: number; updated: number; unchanged: number; discovered: number }
  | { ok: false; reason: 'offline' | 'empty' }

export type StatusContent =
  | { kind: 'text'; text: string; backgroundColor: string; font: number }
  | { kind: 'image'; filePath: string; caption: string; jpegThumbnail?: string; width?: number; height?: number }
  | { kind: 'video'; filePath: string; caption: string; jpegThumbnail?: string; width?: number; height?: number }

export class WaManager {
  private readonly sessions = new Map<string, Session>()
  private version: WAVersion | undefined
  private readonly logger: pino.Logger
  readonly proxyAgent: HttpsAgent | undefined
  readonly proxyLabel: string | null
  lastProxyProbe: ProxyProbe | null = null

  constructor(
    private readonly db: AppDb,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {
    this.logger = pino({ level: config.baileysLogLevel })
    this.proxyLabel = config.waProxyLabel
    this.proxyAgent = config.waProxyUrl ? createProxyAgent(config.waProxyUrl) : undefined
  }

  async checkProxy(): Promise<ProxyProbe> {
    const result = await probeWhatsApp(this.proxyAgent)
    if (result.error) result.error = redactProxyMessage(result.error)
    this.lastProxyProbe = result
    const where = this.proxyLabel ? `через ${this.proxyLabel}` : 'напрямую, прокси не задан'
    this.log(
      result.ok ? 'info' : 'warn',
      result.ok
        ? `Проверка web.whatsapp.com ${where}: ответ ${result.status} за ${result.latencyMs} мс`
        : `Проверка web.whatsapp.com ${where} не удалась за ${result.latencyMs} мс: ${result.error ?? 'ошибка'}`,
    )
    return result
  }

  async restore(): Promise<void> {
    await this.resolveVersion()
    const accounts = this.db.listAccounts().filter((account) => account.autoConnect)
    for (const account of accounts) {
      try {
        await this.start(account.id)
      } catch (error) {
        this.log('error', `Не удалось поднять сессию: ${messageOf(error)}`, account.id)
      }
      await sleep(400)
    }
  }

  async start(accountId: string, opts: { keepQr?: boolean } = {}): Promise<void> {
    const account = this.db.getAccount(accountId)
    if (!account) return
    const session = this.ensure(accountId)
    if (session.booting || session.sock) return
    session.booting = true
    session.suppressReconnect = false
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    const generation = ++session.generation
    if (!opts.keepQr) {
      session.qrDataUrl = null
      session.qrAnnounced = false
      session.state = 'connecting'
      session.lastError = null
      this.persist(accountId, { status: 'connecting', lastError: null, autoConnect: true })
    }
    try {
      const dir = this.sessionDir(accountId)
      await fs.promises.mkdir(dir, { recursive: true })
      const { state, saveCreds } = await useMultiFileAuthState(dir)
      const sock = makeWASocket({
        version: this.version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        logger: this.logger,
        browser: Browsers.ubuntu('WA Status Pro'),
        syncFullHistory: this.config.syncFullHistory,
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 30_000,
        qrTimeout: 60_000,
        ...(this.proxyAgent
          ? {
              agent: this.proxyAgent,
              fetchAgent: this.proxyAgent,
              options: { httpsAgent: this.proxyAgent, httpAgent: this.proxyAgent, proxy: false as const },
            }
          : {}),
        getMessage: async () => undefined,
        shouldIgnoreJid: (jid) => jid.endsWith('@g.us') || jid.endsWith('@newsletter'),
      })
      if (session.generation !== generation) {
        sock.end(undefined)
        return
      }
      session.sock = sock
      sock.ev.on('creds.update', saveCreds)
      this.bindContacts(accountId, generation, sock)
      sock.ev.on('message-receipt.update', (updates) => {
        for (const update of updates) this.rememberView(accountId, {
          remoteJid: update.key.remoteJid,
          messageId: update.key.id,
          userJid: update.receipt.userJid,
          readTimestamp: update.receipt.readTimestamp,
          playedTimestamp: 'playedTimestamp' in update.receipt ? Number(update.receipt.playedTimestamp) : null,
        })
      })
      sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
          const status = typeof update.update.status === 'number' ? update.update.status : null
          this.rememberView(accountId, {
            remoteJid: update.key.remoteJid,
            messageId: update.key.id,
            userJid: update.key.participant,
            status,
          })
        }
      })
      sock.ev.on('connection.update', (update) => {
        if (session.generation !== generation) return
        session.updates = session.updates
          .then(() => this.onConnection(accountId, generation, update))
          .catch((error: unknown) => {
            this.log('error', redactProxyMessage(messageOf(error)), accountId)
          })
      })
    } catch (error) {
      session.state = 'error'
      session.lastError = redactProxyMessage(messageOf(error))
      this.persist(accountId, { status: 'error', lastError: session.lastError })
      this.log('error', session.lastError, accountId)
    } finally {
      session.booting = false
    }
  }

  async restart(accountId: string): Promise<void> {
    await this.stop(accountId, false)
    await this.start(accountId)
  }

  async logout(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    if (session) session.state = 'logged_out'
    await this.stop(accountId, true)
    await fs.promises.rm(this.sessionDir(accountId), { recursive: true, force: true })
    this.persist(accountId, {
      status: 'logged_out',
      autoConnect: false,
      lastError: 'Устройство отвязано из панели',
      historyComplete: false,
    })
    this.log('info', 'Сессия WhatsApp отвязана', accountId)
  }

  async remove(accountId: string): Promise<void> {
    await this.logout(accountId)
    this.db.deleteAccount(accountId)
    this.sessions.delete(accountId)
  }

  snapshot(accountId: string): RuntimeSnapshot {
    const account = this.db.getAccount(accountId)
    const session = this.sessions.get(accountId)
    return {
      status: session?.state ?? account?.status ?? 'created',
      qrDataUrl: session?.qrDataUrl ?? null,
      phone: session?.phone ?? account?.phone ?? null,
      lastError: session?.lastError ?? account?.lastError ?? null,
      discovered: session?.discoveredCount ?? this.db.countDiscovered(accountId),
      historyComplete: account?.historyComplete ?? false,
    }
  }

  ownJid(accountId: string): string | null {
    const session = this.sessions.get(accountId)
    const fromSocket = normalizeOwnJid(session?.sock?.user?.id)
    if (fromSocket) return fromSocket
    const phone = session?.phone ?? this.db.getAccount(accountId)?.phone
    return phone ? `${phone.replace(/\D/g, '')}@s.whatsapp.net` : null
  }

  isReady(accountId: string): boolean {
    return this.sessions.get(accountId)?.state === 'connected'
  }

  isBlocked(accountId: string): boolean {
    const state = this.sessions.get(accountId)?.state ?? this.db.getAccount(accountId)?.status
    return state === 'logged_out'
  }

  syncContacts(accountId: string): SyncResult {
    const discovered = this.db.listDiscovered(accountId)
    const snap = this.snapshot(accountId)
    if (discovered.length === 0) {
      return { ok: false, reason: snap.status === 'connected' || snap.status === 'qr' ? 'empty' : 'offline' }
    }
    const result = this.db.applyMerge(discovered)
    this.log(
      'info',
      `Синхронизация контактов WhatsApp: добавлено ${result.added}, обновлено ${result.updated}, без изменений ${result.unchanged}`,
      accountId,
    )
    return { ok: true, ...result, discovered: discovered.length }
  }

  async sendStatus(accountId: string, content: StatusContent, jids: string[]): Promise<{ messageId: string | null }> {
    const session = this.sessions.get(accountId)
    if (!session?.sock || session.state !== 'connected') {
      throw new WaSendError('Номер не подключён', { pause: true })
    }
    try {
      const own = this.ownJid(accountId)
      const statusJidList = own && !jids.includes(own) ? [own, ...jids] : jids
      const result = await session.sock.sendMessage('status@broadcast', contentPayload(content), {
        statusJidList,
        broadcast: true,
        backgroundColor: content.kind === 'text' ? content.backgroundColor : undefined,
        font: content.kind === 'text' ? content.font : undefined,
      })
      const messageId = result?.key.id ?? null
      if (!messageId) throw new WaSendError('WhatsApp не подтвердил публикацию статуса')
      this.log('info', `Статус отправлен, id ${messageId}, в списке ${statusJidList.length} jid`, accountId)
      return { messageId }
    } catch (error) {
      const code = statusCodeOf(error)
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        throw new WaSendError('WhatsApp отклонил отправку. Сессия могла быть сброшена или номер ограничен.', { code })
      }
      const stillUp = this.sessions.get(accountId)?.state === 'connected'
      throw new WaSendError(messageOf(error), { code, pause: !stillUp })
    }
  }

  async deleteStatus(accountId: string, messageId: string, jids: string[]): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session?.sock || session.state !== 'connected') {
      throw new WaSendError('Номер не подключён', { pause: true })
    }
    const own = this.ownJid(accountId)
    const statusJidList = own && !jids.includes(own) ? [own, ...jids] : jids
    await session.sock.sendMessage('status@broadcast', {
      delete: { remoteJid: 'status@broadcast', fromMe: true, id: messageId },
    }, { statusJidList, broadcast: true })
  }

  async shutdown(): Promise<void> {
    for (const [accountId, session] of this.sessions) {
      session.suppressReconnect = true
      session.generation += 1
      if (session.timer) clearTimeout(session.timer)
      try {
        session.sock?.end(undefined)
      } catch (error) {
        this.log('warn', `Закрытие сокета: ${messageOf(error)}`, accountId)
      }
    }
  }

  private async stop(accountId: string, logoutRemote: boolean): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session) return
    session.suppressReconnect = true
    session.generation += 1
    if (session.timer) clearTimeout(session.timer)
    const sock = session.sock
    session.sock = null
    session.qrDataUrl = null
    if (!sock) return
    if (logoutRemote) {
      try {
        await sock.logout()
      } catch {
        sock.end(undefined)
      }
      return
    }
    sock.end(undefined)
  }

  private ensure(accountId: string): Session {
    const existing = this.sessions.get(accountId)
    if (existing) return existing
    const account = this.db.getAccount(accountId)
    const session: Session = {
      sock: null,
      generation: 0,
      state: account?.status ?? 'created',
      qrDataUrl: null,
      phone: account?.phone ?? null,
      lastError: account?.lastError ?? null,
      suppressReconnect: false,
      backoffMs: 2000,
      timer: null,
      booting: false,
      wasConnected: account?.status === 'connected' || Boolean(account?.phone),
      qrSeq: 0,
      qrAnnounced: false,
      qrRefreshStrikes: 0,
      lastWarnWait: 0,
      discoveredCount: this.db.countDiscovered(accountId),
      updates: Promise.resolve(),
    }
    this.sessions.set(accountId, session)
    return session
  }

  private sessionDir(accountId: string): string {
    return path.join(this.config.dataDir, 'sessions', accountId)
  }

  private persist(accountId: string, patch: Parameters<AppDb['updateAccount']>[1]): void {
    if (!this.db.getAccount(accountId)) return
    this.db.updateAccount(accountId, patch)
  }

  private bindContacts(accountId: string, generation: number, sock: Sock): void {
    const session = this.sessions.get(accountId)
    const alive = () => session?.generation === generation
    const take = (peers: WaPeerInput[], historyDone = false) => {
      if (!alive() || peers.length === 0) return
      this.ingest(accountId, peers)
      if (historyDone) this.persist(accountId, { historyComplete: true })
    }
    sock.ev.on('contacts.upsert', (contacts) => take(contacts))
    sock.ev.on('contacts.update', (contacts) => take(contacts))
    sock.ev.on('chats.upsert', (chats) => take(chats.map((chat) => ({ id: chat.id, chatName: chat.name }))))
    sock.ev.on('chats.update', (chats) => take(chats.map((chat) => ({ id: chat.id, chatName: chat.name }))))
    sock.ev.on('messaging-history.set', (payload) => {
      const peers: WaPeerInput[] = [
        ...payload.contacts,
        ...payload.chats.map((chat) => ({ id: chat.id, chatName: chat.name })),
      ]
      take(peers, Boolean(payload.isLatest))
    })
    sock.ev.on('chats.phoneNumberShare', (share) => {
      if (!alive()) return
      this.ingest(accountId, [{ lid: share.lid, jid: share.jid }])
    })
  }

  private rememberView(accountId: string, input: { remoteJid?: string | null; messageId?: string | null; userJid?: string | null; readTimestamp?: number | Long | null; playedTimestamp?: number | null; status?: number | null }): void {
    const readTimestamp = typeof input.readTimestamp === 'number' ? input.readTimestamp : input.readTimestamp ? Number(input.readTimestamp) : null
    const event = viewFromReceipt({ ...input, readTimestamp })
    if (!event) return
    const self = this.ownJid(accountId)
    if (self && event.viewerJid === self) return
    const postId = this.db.findPostByMessage(event.messageId)
    if (!postId) return
    const phone = event.viewerJid.split('@')[0] ?? ''
    this.db.recordStatusView({
      postId,
      viewerJid: event.viewerJid,
      phone,
      name: this.db.contactNameByPhone(phone),
      viewedAt: event.viewedAt,
    })
  }

  private ingest(accountId: string, peers: WaPeerInput[]): void {
    const account = this.db.getAccount(accountId)
    const extracted = extractWhatsAppPeers(peers, this.db.lidPhoneMap(accountId), account?.phone)
    for (const lid of extracted.lids) {
      this.db.upsertLid(accountId, lid.lid, { phone: lid.phone, name: lid.name, nameRank: lid.nameRank })
    }
    if (extracted.contacts.length > 0) this.db.upsertDiscovered(accountId, extracted.contacts)
    const session = this.sessions.get(accountId)
    if (session) session.discoveredCount = this.db.countDiscovered(accountId)
  }

  private async onConnection(accountId: string, generation: number, update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session || session.generation !== generation) return
    if (update.qr) {
      session.qrRefreshStrikes = 0
      session.backoffMs = 2000
      session.state = 'qr'
      session.lastError = null
      const seq = ++session.qrSeq
      if (!session.qrAnnounced) {
        session.qrAnnounced = true
        this.log('info', 'QR готов к сканированию', accountId)
      }
      this.persist(accountId, { status: 'qr', lastError: null })
      void QRCode.toDataURL(update.qr, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
        .then((url) => {
          if (session.generation !== generation || session.qrSeq !== seq) return
          session.qrDataUrl = url
        })
        .catch((error: unknown) => {
          this.log('warn', `Не удалось нарисовать QR: ${messageOf(error)}`, accountId)
        })
    }
    if (update.connection === 'open') {
      session.state = 'connected'
      session.qrDataUrl = null
      session.qrAnnounced = false
      session.wasConnected = true
      session.backoffMs = 2000
      session.qrRefreshStrikes = 0
      session.lastError = null
      const rawId = session.sock?.user?.id
      const phone = rawId ? rawId.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? null : null
      session.phone = phone
      this.persist(accountId, { status: 'connected', phone, lastError: null, connectedAt: new Date().toISOString(), autoConnect: true })
      this.log('info', phone ? `Номер подключён: +${phone}` : 'Номер подключён', accountId)
    }
    if (update.connection === 'close') {
      const plan = planReconnect({
        code: statusCodeOf(update.lastDisconnect?.error),
        showingQr: session.state === 'qr' || Boolean(session.qrDataUrl),
        wasConnected: session.wasConnected,
        backoffMs: session.backoffMs,
        qrRefreshStrikes: session.qrRefreshStrikes,
      })
      session.sock = null
      if (session.suppressReconnect) return
      if (!plan.keepQr) {
        session.qrDataUrl = null
        session.qrAnnounced = false
      }
      session.qrRefreshStrikes = plan.countStrike ? session.qrRefreshStrikes + 1 : 0
      session.backoffMs = plan.nextBackoffMs
      if (plan.action === 'stop') {
        const loggedOut = plan.reason === 'logged_out'
        session.state = loggedOut ? 'logged_out' : 'error'
        session.lastError = plan.message
        this.persist(accountId, { status: session.state, lastError: plan.message, autoConnect: !loggedOut })
        this.log('warn', plan.message, accountId)
        return
      }
      session.state = plan.keepQr ? 'qr' : 'reconnecting'
      session.lastError = plan.keepQr ? 'Обновляем QR. Предыдущий код ещё можно сканировать.' : plan.message
      this.persist(accountId, { status: session.state, lastError: session.lastError })
      const repeat = plan.log === 'warn' && plan.waitMs === session.lastWarnWait
      this.log(repeat ? 'info' : plan.log, plan.message, accountId)
      if (plan.log === 'warn') session.lastWarnWait = plan.waitMs
      if (session.timer) clearTimeout(session.timer)
      session.timer = setTimeout(() => {
        if (session.generation !== generation || session.suppressReconnect) return
        void this.start(accountId, { keepQr: plan.keepQr })
      }, plan.waitMs)
    }
  }

  private async resolveVersion(): Promise<void> {
    try {
      const fetched = await fetchLatestBaileysVersion({ timeout: 10_000 })
      this.version = fetched.version
      this.log('info', `Версия протокола WhatsApp Web: ${fetched.version.join('.')}`)
    } catch (error) {
      this.log('warn', `Не удалось узнать свежую версию WhatsApp Web, берём встроенную: ${messageOf(error)}`)
    }
  }
}

function contentPayload(content: StatusContent):
  | { text: string }
  | { image: { url: string }; caption?: string; mimetype: string; jpegThumbnail?: string; width?: number; height?: number }
  | { video: { url: string }; caption?: string; mimetype: string; jpegThumbnail?: string; width?: number; height?: number } {
  if (content.kind === 'text') return { text: content.text }
  const shared = {
    caption: content.caption || undefined,
    jpegThumbnail: content.jpegThumbnail,
    width: content.width || undefined,
    height: content.height || undefined,
  }
  if (content.kind === 'image') return { image: { url: content.filePath }, mimetype: 'image/jpeg', ...shared }
  return { video: { url: content.filePath }, mimetype: 'video/mp4', ...shared }
}

type Long = { toNumber?: () => number; toString: () => string }

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const output = (error as { output?: { statusCode?: number } }).output
  if (typeof output?.statusCode === 'number') return output.statusCode
  return undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 400)
  return 'неизвестная ошибка'
}
