import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'

import { createLoginGuard, csrfOk, issueSession, passwordsMatch, readCookie, sessionCookie, verifySession } from '../auth.js'
import type { AppConfig } from '../config.js'
import type { AppDb } from '../db.js'
import { contactsToCsv, contactsToXlsx } from '../exportContacts.js'
import { ImportFormatError } from '../errors.js'
import { buildImportPlan, parseContactFile } from '../importContacts.js'
import { prepareStatusMedia } from '../media.js'
import { cooldownRemainingMs } from '../statusLogic.js'
import { moscowLocalToUtcIso } from '../time.js'
import type { AudienceSource, PostKind, SourceFilter } from '../types.js'
import type { WaManager } from '../waManager.js'
import {
  accountPage,
  accountStatusLabel,
  accountsPage,
  contactsPage,
  dashboardPage,
  esc,
  healthPage,
  importRunPage,
  layout,
  loginPage,
  postStatusLabel,
  renderFlash,
  statusDetailPage,
  statusFormPage,
  statusListPage,
  storiesPage,
  viewersPage,
} from './views.js'

type Deps = { config: AppConfig; db: AppDb; wa: WaManager }
type Upload = { path: string; originalname: string }

const guard = createLoginGuard()

export function createApp(deps: Deps): express.Express {
  const { config, db, wa } = deps
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', 1)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'")
    next()
  })
  app.use('/assets', express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public'), { maxAge: '1h' }))
  app.use(express.urlencoded({ extended: false, limit: '1mb' }))

  const upload = multer({
    dest: path.join(config.dataDir, 'tmp'),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  })

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/login', (req, res) => {
    if (currentSession(req, config)) {
      res.redirect('/')
      return
    }
    res.type('html').send(loginPage({ next: safeNext(q(req.query.next)), error: q(req.query.msg) === 'bad_password' ? 'Неверный пароль.' : q(req.query.msg) === 'rate_limited' ? 'Слишком много попыток. Подождите 15 минут.' : undefined }))
  })

  app.post('/login', (req, res) => {
    const ip = req.ip || 'local'
    if (!guard.allowed(ip)) {
      res.redirect('/login?msg=rate_limited')
      return
    }
    const password = typeof req.body.password === 'string' ? req.body.password : ''
    if (!passwordsMatch(password, config.adminPassword)) {
      guard.fail(ip)
      res.redirect('/login?msg=bad_password')
      return
    }
    guard.succeed(ip)
    const session = issueSession(config.sessionSecret, config.sessionTtlHours * 3600 * 1000)
    res.setHeader('Set-Cookie', sessionCookie(session.token, session.maxAgeSec, config.cookieSecure))
    res.redirect(safeNext(typeof req.body.next === 'string' ? req.body.next : '/'))
  })

  app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path === '/login') {
      next()
      return
    }
    const session = currentSession(req, config)
    if (!session) {
      if (req.path.startsWith('/api/') || req.path.endsWith('/state') || req.path.endsWith('/progress')) {
        res.status(401).json({ error: 'auth' })
        return
      }
      res.redirect(`/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`)
      return
    }
    const multipart = (req.headers['content-type'] ?? '').includes('multipart/form-data')
    if (req.method === 'POST' && !multipart && !csrfOk(session.csrf, req.body?.csrf)) {
      res.redirect('/?msg=csrf')
      return
    }
    res.locals.csrf = session.csrf
    next()
  })

  app.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', sessionCookie('', 0, config.cookieSecure))
    res.redirect('/login')
  })

  app.get('/', (req, res) => {
    const accounts = db.listAccounts()
    res.type('html').send(page(req, config, 'Обзор', 'home', dashboardPage({
      accounts,
      contacts: db.countContacts(),
      sources: db.sourceCounts(),
      queue: db.queueCounts(),
      today: db.countFinishedSince(moscowDayStart()),
      posts: db.listPosts(6),
    })))
  })

  app.get('/accounts', (req, res) => {
    res.type('html').send(page(req, config, 'Номера', 'accounts', accountsPage(db.listAccounts(), csrf(res))))
  })

  app.post('/accounts', async (req, res) => {
    const label = clipLabel(req.body.label)
    const account = db.createAccount(label || 'Номер')
    try {
      await wa.start(account.id)
    } catch (error) {
      db.addLog('error', error instanceof Error ? error.message : 'Не удалось открыть сессию', account.id)
    }
    res.redirect(`/accounts/${account.id}`)
  })

  app.get('/accounts/:id', (req, res) => {
    const account = db.getAccount(param(req.params.id))
    if (!account) {
      res.redirect('/accounts?msg=not_found')
      return
    }
    res.type('html').send(page(req, config, account.label, 'accounts', accountPage(account, csrf(res), db.countDiscovered(account.id), config.waProxyLabel)))
  })

  app.get('/accounts/:id/state', (req, res) => {
    const account = db.getAccount(param(req.params.id))
    if (!account) {
      res.status(404).json({ error: 'missing' })
      return
    }
    const snap = wa.snapshot(account.id)
    res.json({
      status: snap.status,
      statusLabel: accountStatusLabel(snap.status),
      qrDataUrl: snap.qrDataUrl,
      phone: snap.phone,
      phoneDisplay: snap.phone ? snap.phone : '',
      error: snap.lastError,
      discovered: snap.discovered,
      historyComplete: snap.historyComplete,
    })
  })

  app.post('/accounts/:id/label', (req, res) => {
    const id = param(req.params.id)
    if (!db.getAccount(id)) {
      res.redirect('/accounts?msg=not_found')
      return
    }
    db.updateAccount(id, { label: clipLabel(req.body.label) || 'Номер' })
    res.redirect(`/accounts/${id}?msg=label_saved`)
  })

  app.post('/accounts/:id/reconnect', async (req, res) => {
    const id = param(req.params.id)
    if (!db.getAccount(id)) {
      res.redirect('/accounts?msg=not_found')
      return
    }
    await wa.restart(id)
    res.redirect(`/accounts/${id}?msg=reconnecting`)
  })

  app.post('/accounts/:id/logout', async (req, res) => {
    const id = param(req.params.id)
    if (!db.getAccount(id)) {
      res.redirect('/accounts?msg=not_found')
      return
    }
    await wa.logout(id)
    res.redirect(`/accounts/${id}?msg=logged_out_ok`)
  })

  app.post('/accounts/:id/delete', async (req, res) => {
    const id = param(req.params.id)
    if (db.getAccount(id)) await wa.remove(id)
    res.redirect('/accounts?msg=deleted')
  })

  app.post('/accounts/:id/sync', (req, res) => {
    const id = param(req.params.id)
    if (!db.getAccount(id)) {
      res.redirect('/accounts?msg=not_found')
      return
    }
    const result = wa.syncContacts(id)
    if (!result.ok) {
      res.redirect(`/accounts/${id}?msg=sync_${result.reason}`)
      return
    }
    const query = new URLSearchParams({
      msg: 'synced',
      added: String(result.added),
      updated: String(result.updated),
      unchanged: String(result.unchanged),
      discovered: String(result.discovered),
    })
    res.redirect(`/contacts?${query}`)
  })

  app.get('/contacts', (req, res) => {
    const source = sourceFilter(q(req.query.source))
    const tag = q(req.query.tag)
    const search = q(req.query.q)
    const pageNo = Math.max(1, num(req.query.page) || 1)
    const found = db.searchContacts({ q: search, tag, source, limit: 40, offset: (pageNo - 1) * 40 })
    res.type('html').send(page(req, config, 'Контакты', 'contacts', contactsPage({
      items: found.items,
      total: found.total,
      page: pageNo,
      q: search,
      tag,
      source,
      tags: db.listTags(),
      csrf: csrf(res),
    })))
  })

  app.post('/contacts/import', upload.single('file'), async (req, res) => {
    if (!csrfOk(csrf(res), req.body?.csrf)) {
      if (req.file) await fs.promises.rm(req.file.path, { force: true })
      res.redirect('/contacts?msg=csrf')
      return
    }
    const file = req.file as Upload | undefined
    if (!file) {
      res.redirect('/contacts?msg=file_required')
      return
    }
    try {
      const buffer = await fs.promises.readFile(file.path)
      const raws = await parseContactFile(file.originalname, buffer)
      const plan = buildImportPlan(raws)
      const applied = db.applyMerge(plan.contacts)
      const run = db.addImportRun({
        filename: path.basename(file.originalname),
        added: applied.added,
        updated: applied.updated,
        skipped: plan.issues.length,
        merged: plan.duplicatesMerged,
        issues: plan.issues,
      })
      const query = new URLSearchParams({
        msg: 'imported',
        added: String(applied.added),
        updated: String(applied.updated),
        skipped: String(plan.issues.length),
        merged: String(plan.duplicatesMerged),
        run: String(run.id),
      })
      res.redirect(`/contacts?${query}`)
    } catch (error) {
      db.addLog('error', error instanceof Error ? error.message : 'Импорт не удался')
      res.redirect(`/contacts?msg=${error instanceof ImportFormatError ? 'format' : 'file_type'}`)
    } finally {
      await fs.promises.rm(file.path, { force: true })
    }
  })

  app.get('/contacts/imports/:id', (req, res) => {
    const run = db.getImportRun(intParam(req.params.id))
    if (!run) {
      res.redirect('/contacts?msg=not_found')
      return
    }
    res.type('html').send(page(req, config, 'Импорт', 'contacts', importRunPage(run)))
  })

  app.post('/contacts/:id/tags', (req, res) => {
    const id = intParam(req.params.id)
    const tags = typeof req.body.tags === 'string' ? req.body.tags.split(',') : []
    if (!db.setContactTags(id, tags)) {
      res.redirect('/contacts?msg=not_found')
      return
    }
    res.redirect('/contacts?msg=tags_saved')
  })

  app.post('/contacts/:id/delete', (req, res) => {
    if (!db.deleteContact(intParam(req.params.id))) {
      res.redirect('/contacts?msg=not_found')
      return
    }
    res.redirect('/contacts?msg=contact_deleted')
  })

  app.get('/contacts/export/csv', (req, res) => {
    const rows = exportRows(db, req)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="kontakty.csv"')
    res.send(contactsToCsv(rows))
  })

  app.get('/contacts/export/xlsx', async (req, res) => {
    const rows = exportRows(db, req)
    const buffer = await contactsToXlsx(rows)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="kontakty.xlsx"')
    res.send(buffer)
  })

  app.get('/api/cooldown', (_req, res) => {
    const now = Date.now()
    const waitMs = cooldownRemainingMs(db.lastFinishedAt(), config.minPublishIntervalMs, now)
    const running = db.queueCounts().running
    res.json({ waitMs, until: waitMs > 0 ? new Date(now + waitMs).toISOString() : null, running })
  })

  app.get('/api/audience', (req, res) => {
    const source = audienceOf(q(req.query.source))
    const tag = q(req.query.tag).trim()
    res.json({ count: db.countAudience(source, tag || null) })
  })

  app.get('/stories', (req, res) => {
    const posts = db.listPosts(40).filter((post) => post.status === 'done' || post.status === 'partial')
    const counts = db.countViews(posts.map((post) => post.id))
    const accounts = new Map(db.listAccounts().map((account) => [account.id, account]))
    res.type('html').send(page(req, config, 'Мои статусы', 'stories', storiesPage({
      posts,
      accounts,
      views: counts,
      tags: db.listTags(),
      csrf: csrf(res),
      batchSize: config.batchSize,
      batchDelayMs: config.batchDelayMs,
    })))
  })

  app.get('/media/:id', (req, res) => {
    sendPostFile(config.dataDir, db, intParam(req.params.id), 'media', res)
  })

  app.get('/media/:id/thumb', (req, res) => {
    sendPostFile(config.dataDir, db, intParam(req.params.id), 'thumb', res)
  })

  app.get('/status', (req, res) => {
    const accounts = new Map(db.listAccounts().map((account) => [account.id, account]))
    res.type('html').send(page(req, config, 'Публикации', 'status', statusListPage(db.listPosts(100), accounts)))
  })

  app.get('/status/new', (req, res) => {
    res.type('html').send(page(req, config, 'Новая публикация', 'status', statusFormPage({
      accounts: db.listAccounts(),
      tags: db.listTags(),
      csrf: csrf(res),
      batchSize: config.batchSize,
      batchDelayMs: config.batchDelayMs,
    })))
  })

  app.post('/status', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
    if (!csrfOk(csrf(res), req.body?.csrf)) {
      const files = (req.files ?? {}) as { image?: Upload[]; video?: Upload[] }
      for (const file of [...(files.image ?? []), ...(files.video ?? [])]) {
        await fs.promises.rm(file.path, { force: true })
      }
      res.redirect('/status/new?msg=csrf')
      return
    }
    const kind = kindOf(req.body.kind)
    const accountId = typeof req.body.account_id === 'string' ? req.body.account_id : ''
    const account = db.getAccount(accountId)
    const files = (req.files ?? {}) as { image?: Upload[]; video?: Upload[] }
    const temp = kind === 'image' ? files.image?.[0] : kind === 'video' ? files.video?.[0] : undefined
    const cleanup = async () => {
      if (temp) await fs.promises.rm(temp.path, { force: true })
    }
    if (!account) {
      await cleanup()
      res.redirect('/status/new?msg=no_account')
      return
    }
    const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() : ''
    if (caption.length > 1024) {
      await cleanup()
      res.redirect('/status/new?msg=caption_long')
      return
    }
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : ''
    if (kind === 'text' && !text) {
      await cleanup()
      res.redirect('/status/new?msg=text_required')
      return
    }
    if (kind === 'text' && text.length > 700) {
      await cleanup()
      res.redirect('/status/new?msg=text_long')
      return
    }
    if (kind !== 'text') {
      if (!temp) {
        res.redirect('/status/new?msg=file_required')
        return
      }
      const ext = path.extname(temp.originalname).toLowerCase()
      const imageOk = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
      const videoOk = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.3gp', '.m4v'].includes(ext)
      if ((kind === 'image' && !imageOk) || (kind === 'video' && !videoOk)) {
        await cleanup()
        res.redirect('/status/new?msg=file_type')
        return
      }
    }
    const source = audienceOf(req.body.audience_source)
    const tag = typeof req.body.tag === 'string' ? req.body.tag.trim() : ''
    let scheduledAt: string | null = null
    let status: 'queued' | 'scheduled' = 'queued'
    if (req.body.when === 'schedule') {
      const iso = moscowLocalToUtcIso(typeof req.body.scheduled_at === 'string' ? req.body.scheduled_at : '')
      if (!iso) {
        await cleanup()
        res.redirect('/status/new?msg=bad_time')
        return
      }
      if (new Date(iso).getTime() < Date.now() - 60_000) {
        await cleanup()
        res.redirect('/status/new?msg=past_time')
        return
      }
      if (new Date(iso).getTime() > Date.now() + 60_000) {
        scheduledAt = iso
        status = 'scheduled'
      }
    }
    if (status === 'queued' && db.countAudience(source, tag || null) === 0) {
      await cleanup()
      res.redirect('/status/new?msg=no_recipients')
      return
    }
    let mediaPath: string | null = null
    let thumbPath: string | null = null
    let mediaWidth: number | null = null
    let mediaHeight: number | null = null
    try {
      if (temp && kind !== 'text') {
        const prepared = await prepareStatusMedia({
          kind,
          sourcePath: temp.path,
          dataDir: config.dataDir,
          ffmpegPath: config.ffmpegPath,
          maxVideoSeconds: config.maxVideoSeconds,
        })
        mediaPath = prepared.path
        thumbPath = prepared.thumbPath
        mediaWidth = prepared.width || null
        mediaHeight = prepared.height || null
        if (prepared.skippedTranscode) db.addLog('info', 'Видео уже подходит для статуса, перекодирование пропущено', account.id)
      }
    } catch (error) {
      db.addLog('error', error instanceof Error ? error.message : 'ffmpeg', account.id)
      await cleanup()
      res.redirect('/status/new?msg=ffmpeg')
      return
    }
    await cleanup()
    const post = db.createPost({
      accountId: account.id,
      kind,
      body: kind === 'text' ? text : '',
      caption,
      mediaPath,
      thumbPath,
      mediaWidth,
      mediaHeight,
      originalName: temp?.originalname ?? null,
      backgroundColor: kind === 'text' ? hexColor(req.body.background_color) : null,
      font: kind === 'text' ? fontOf(req.body.font) : null,
      audienceSource: source,
      audienceTag: tag || null,
      scheduledAt,
      status,
    })
    db.addLog('info', status === 'scheduled' ? `Запланирована публикация #${post.id}` : `В очереди публикация #${post.id}`, account.id)
    res.redirect(`/status/${post.id}?msg=${status === 'scheduled' ? 'scheduled' : 'queued'}`)
  })

  app.get('/status/:id', (req, res) => {
    const post = db.getPost(intParam(req.params.id))
    if (!post) {
      res.redirect('/status?msg=not_found')
      return
    }
    const views = db.countViews([post.id]).get(post.id) ?? 0
    res.type('html').send(page(req, config, `Публикация #${post.id}`, 'status', statusDetailPage(post, db.getAccount(post.accountId), db.listBatches(post.id), csrf(res), views)))
  })

  app.get('/status/:id/viewers', (req, res) => {
    const post = db.getPost(intParam(req.params.id))
    if (!post) {
      res.redirect('/stories?msg=not_found')
      return
    }
    const source = sourceFilter(q(req.query.source))
    const tag = q(req.query.tag)
    const search = q(req.query.q)
    const pageNo = Math.max(1, num(req.query.page) || 1)
    const found = db.listViews(post.id, { q: search, tag, source, limit: 50, offset: (pageNo - 1) * 50 })
    res.type('html').send(page(req, config, 'Просмотры', 'stories', viewersPage({
      post,
      items: found.items,
      total: found.total,
      page: pageNo,
      q: search,
      tag,
      source,
      tags: db.listTags(),
    })))
  })

  app.get('/status/:id/viewers.csv', (req, res) => {
    const post = db.getPost(intParam(req.params.id))
    if (!post) {
      res.status(404).type('text').send('Не найдено')
      return
    }
    const found = db.listViews(post.id, {
      q: q(req.query.q),
      tag: q(req.query.tag),
      source: sourceFilter(q(req.query.source)),
      limit: 100_000,
      offset: 0,
    })
    const lines = ['телефон;имя;когда']
    for (const view of found.items) {
      lines.push([view.phone, view.name, view.viewedAt].map((cell) => /[;"\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(';'))
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="prosmotry-${post.id}.csv"`)
    res.send(`\uFEFF${lines.join('\r\n')}\r\n`)
  })

  app.post('/status/:id/retry', (req, res) => {
    const post = db.getPost(intParam(req.params.id))
    if (!post || (post.status !== 'failed' && post.status !== 'partial')) {
      res.redirect('/status?msg=not_found')
      return
    }
    db.resetFailedBatches(post.id)
    db.updatePost(post.id, { status: 'queued', finishedAt: null, notBefore: null, error: null })
    db.addLog('info', `Повтор публикации #${post.id}`, post.accountId)
    res.redirect(`/status/${post.id}?msg=queued`)
  })

  app.get('/status/:id/progress', (req, res) => {
    const post = db.getPost(intParam(req.params.id))
    if (!post) {
      res.status(404).json({ error: 'missing' })
      return
    }
    const finished = post.status === 'done' || post.status === 'partial' || post.status === 'failed' || post.status === 'cancelled'
    const percent = post.totalRecipients > 0 ? Math.round(((post.successRecipients + post.failedRecipients) / post.totalRecipients) * 100) : 0
    res.json({
      status: post.status,
      statusLabel: postStatusLabel(post.status),
      totalRecipients: post.totalRecipients,
      totalBatches: post.totalBatches,
      sentBatches: post.sentBatches,
      successRecipients: post.successRecipients,
      failedRecipients: post.failedRecipients,
      error: post.error,
      finished,
      percent,
    })
  })

  app.post('/status/:id/cancel', (req, res) => {
    const post = db.getPost(intParam(req.params.id))
    if (!post) {
      res.redirect('/status?msg=not_found')
      return
    }
    if (post.status === 'queued' || post.status === 'scheduled' || post.status === 'running') {
      db.updatePost(post.id, { status: 'cancelled', finishedAt: new Date().toISOString(), error: 'Остановлено из панели' })
    }
    res.redirect(`/status/${post.id}?msg=cancelled`)
  })

  app.get('/health', (req, res) => {
    const accounts = db.listAccounts()
    const seconds = Math.round(process.uptime())
    const uptime = seconds < 3600 ? `${Math.round(seconds / 60)} мин` : `${Math.floor(seconds / 3600)} ч`
    res.type('html').send(page(req, config, 'Журнал', 'health', healthPage({
      accounts,
      discovered: new Map(accounts.map((account) => [account.id, db.countDiscovered(account.id)])),
      queue: db.queueCounts(),
      uptime,
      batchSize: config.batchSize,
      batchDelayMs: config.batchDelayMs,
      proxyLabel: config.waProxyLabel,
      proxyCheck: wa.lastProxyProbe,
      csrf: csrf(res),
      logs: db.listLogs(80),
    })))
  })

  app.post('/health/proxy-check', async (_req, res) => {
    await wa.checkProxy()
    res.redirect('/health')
  })

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.redirect(`${req.path.startsWith('/contacts') ? '/contacts' : '/status/new'}?msg=file_large`)
      return
    }
    const text = error instanceof Error ? error.message : 'Внутренняя ошибка'
    db.addLog('error', text)
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: 'internal' })
      return
    }
    res.status(500).type('html').send(layout({
      title: 'Ошибка',
      active: 'home',
      body: `<h1>Внутренняя ошибка</h1><p>${esc(text)}</p>`,
    }))
  })

  return app
}

function sendPostFile(dataDir: string, db: AppDb, id: number, kind: 'media' | 'thumb', res: Response): void {
  const post = db.getPost(id)
  const target = kind === 'thumb' ? post?.thumbPath : post?.mediaPath
  if (!post || !target) {
    res.status(404).end()
    return
  }
  const root = path.resolve(dataDir)
  const file = path.resolve(target)
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.status(404).end()
    return
  }
  res.sendFile(file)
}

function exportRows(db: AppDb, req: Request) {
  return db.listForExport({
    q: q(req.query.q),
    tag: q(req.query.tag),
    source: sourceFilter(q(req.query.source)),
    limit: 100_000,
  }).map((contact) => ({
    phone: contact.phone,
    name: contact.name,
    tags: contact.tags,
    sources: contact.sources,
  }))
}

function page(req: Request, config: AppConfig, title: string, active: string, body: string): string {
  const warnings: string[] = []
  if (config.warnDefaultPassword) warnings.push('Смените ADMIN_PASSWORD: сейчас стоит пароль из примера.')
  if (config.warnDefaultSecret) warnings.push('Задайте свой SESSION_SECRET, иначе сессии завязаны на файл внутри data.')
  return layout({ title, active, body, warnings, flash: renderFlash(req.query as Record<string, unknown>) })
}

function csrf(res: Response): string {
  return typeof res.locals.csrf === 'string' ? res.locals.csrf : ''
}

function currentSession(req: Request, config: AppConfig): { csrf: string } | null {
  return verifySession(config.sessionSecret, readCookie(req.headers.cookie))
}

function q(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

function num(value: unknown): number {
  const parsed = Number(q(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function param(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

function intParam(value: string | string[] | undefined): number {
  const parsed = Number(param(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

function safeNext(value: string): string {
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login')) return value
  return '/'
}

function sourceFilter(value: string): SourceFilter {
  if (value === 'whatsapp' || value === 'phone' || value === 'both') return value
  return 'all'
}

function audienceOf(value: unknown): AudienceSource {
  if (value === 'whatsapp' || value === 'phone') return value
  return 'any'
}

function kindOf(value: unknown): PostKind {
  if (value === 'image' || value === 'video') return value
  return 'text'
}

function hexColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#0E6B52'
}

function fontOf(value: unknown): number {
  const parsed = Number(value)
  if (parsed === 1 || parsed === 2) return parsed
  return 0
}

function clipLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 40) : ''
}

function moscowDayStart(): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return moscowLocalToUtcIso(`${day}T00:00`) ?? new Date().toISOString()
}
