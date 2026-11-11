import Database from 'better-sqlite3'
import crypto from 'node:crypto'

import { mergeName, uniqueSources } from './contactsMerge.js'
import { foldText, likeContains, normalizeTagList } from './tags.js'
import type {
  Account,
  AccountStatus,
  AudienceSource,
  Contact,
  ContactDraft,
  ContactSource,
  ImportIssue,
  ImportRun,
  PostKind,
  PostStatus,
  SourceFilter,
  StatusBatch,
  StatusPost,
  StatusView,
} from './types.js'
import { nowIso } from './time.js'

type AccountPatch = Partial<Pick<Account, 'label' | 'phone' | 'status' | 'lastError' | 'connectedAt' | 'autoConnect' | 'historyComplete'>>
type PostPatch = Partial<{
  status: PostStatus
  notBefore: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  thumbPath: string | null
  mediaPath: string | null
  mediaWidth: number | null
  mediaHeight: number | null
  deletedAt: string | null
  totalRecipients: number
  totalBatches: number
  sentBatches: number
  successRecipients: number
  failedRecipients: number
}>

function sourceClause(filter: SourceFilter | AudienceSource): string {
  const whatsapp = `EXISTS (SELECT 1 FROM contact_sources sw WHERE sw.contact_id = c.id AND sw.source = 'whatsapp')`
  const phone = `EXISTS (SELECT 1 FROM contact_sources sp WHERE sp.contact_id = c.id AND sp.source = 'phone')`
  if (filter === 'whatsapp') return whatsapp
  if (filter === 'phone') return phone
  if (filter === 'both') return `(${whatsapp} AND ${phone})`
  return '1=1'
}

export class AppDb {
  constructor(readonly raw: Database.Database) {}

  close(): void {
    this.raw.close()
  }

  listAccounts(): Account[] {
    const rows = this.raw.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as AccountRow[]
    return rows.map(mapAccount)
  }

  getAccount(id: string): Account | null {
    const row = this.raw.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
    return row ? mapAccount(row) : null
  }

  createAccount(label: string): Account {
    const id = crypto.randomUUID()
    const now = nowIso()
    this.raw.prepare(
      `INSERT INTO accounts (id, label, status, auto_connect, history_complete, created_at, updated_at)
       VALUES (?, ?, 'created', 1, 0, ?, ?)`,
    ).run(id, label, now, now)
    return this.getAccount(id) as Account
  }

  updateAccount(id: string, patch: AccountPatch): void {
    const current = this.getAccount(id)
    if (!current) return
    const next = { ...current, ...patch, updatedAt: nowIso() }
    this.raw.prepare(
      `UPDATE accounts
       SET label = ?, phone = ?, status = ?, last_error = ?, connected_at = ?, auto_connect = ?, history_complete = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.label,
      next.phone,
      next.status,
      next.lastError,
      next.connectedAt,
      next.autoConnect ? 1 : 0,
      next.historyComplete ? 1 : 0,
      next.updatedAt,
      id,
    )
  }

  deleteAccount(id: string): void {
    this.raw.prepare('DELETE FROM wa_discovered WHERE account_id = ?').run(id)
    this.raw.prepare('DELETE FROM wa_lids WHERE account_id = ?').run(id)
    this.raw.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }

  countContacts(): number {
    const row = this.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }
    return row.n
  }

  sourceCounts(): { whatsapp: number; phone: number; both: number } {
    const count = (sql: string) => (this.raw.prepare(sql).get() as { n: number }).n
    return {
      whatsapp: count(`SELECT COUNT(*) AS n FROM contacts c WHERE ${sourceClause('whatsapp')}`),
      phone: count(`SELECT COUNT(*) AS n FROM contacts c WHERE ${sourceClause('phone')}`),
      both: count(`SELECT COUNT(*) AS n FROM contacts c WHERE ${sourceClause('both')}`),
    }
  }

  searchContacts(opts: { q: string; tag: string; source: SourceFilter; limit: number; offset: number }): { total: number; items: Contact[] } {
    const where = this.contactWhere(opts.q, opts.tag, opts.source)
    const total = (this.raw.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE ${where.sql}`).get(...where.params) as { n: number }).n
    const rows = this.raw.prepare(
      `SELECT c.* FROM contacts c WHERE ${where.sql} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    ).all(...where.params, opts.limit, opts.offset) as ContactRow[]
    return { total, items: this.hydrate(rows) }
  }

  listForExport(opts: { q: string; tag: string; source: SourceFilter; limit: number }): Contact[] {
    const where = this.contactWhere(opts.q, opts.tag, opts.source)
    const rows = this.raw.prepare(
      `SELECT c.* FROM contacts c WHERE ${where.sql} ORDER BY c.phone ASC LIMIT ?`,
    ).all(...where.params, opts.limit) as ContactRow[]
    return this.hydrate(rows)
  }

  listTags(): { tag: string; count: number }[] {
    const rows = this.raw.prepare(
      `SELECT MIN(tag) AS tag, COUNT(*) AS n FROM contact_tags GROUP BY tag_fold ORDER BY n DESC, tag ASC`,
    ).all() as { tag: string; n: number }[]
    return rows.map((row) => ({ tag: row.tag, count: row.n }))
  }

  getContact(id: number): Contact | null {
    const row = this.raw.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined
    if (!row) return null
    return this.hydrate([row])[0] ?? null
  }

  setContactTags(id: number, tags: string[]): boolean {
    const contact = this.getContact(id)
    if (!contact) return false
    const clean = normalizeTagList(tags)
    const del = this.raw.prepare('DELETE FROM contact_tags WHERE contact_id = ?')
    const ins = this.raw.prepare('INSERT INTO contact_tags (contact_id, tag, tag_fold) VALUES (?, ?, ?)')
    this.raw.transaction(() => {
      del.run(id)
      for (const tag of clean) ins.run(id, tag, foldText(tag))
    })()
    return true
  }

  deleteContact(id: number): boolean {
    const info = this.raw.prepare('DELETE FROM contacts WHERE id = ?').run(id)
    return info.changes > 0
  }

  applyMerge(drafts: ContactDraft[]): { added: number; updated: number; unchanged: number } {
    const deduped = new Map<string, ContactDraft>()
    for (const draft of drafts) {
      const prev = deduped.get(draft.phone)
      if (!prev) {
        deduped.set(draft.phone, {
          phone: draft.phone,
          name: draft.name.trim(),
          nameRank: draft.name.trim() ? draft.nameRank : 0,
          tags: normalizeTagList(draft.tags),
          sources: uniqueSources(draft.sources),
        })
      } else {
        const name = mergeName(prev, draft)
        deduped.set(draft.phone, {
          phone: draft.phone,
          name: name.name,
          nameRank: name.nameRank,
          tags: normalizeTagList([...prev.tags, ...draft.tags]),
          sources: uniqueSources([...prev.sources, ...draft.sources]),
        })
      }
    }
    const find = this.raw.prepare('SELECT id, name, name_rank FROM contacts WHERE phone = ?')
    const insert = this.raw.prepare(
      'INSERT INTO contacts (phone, name, name_fold, name_rank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const update = this.raw.prepare('UPDATE contacts SET name = ?, name_fold = ?, name_rank = ?, updated_at = ? WHERE id = ?')
    const addSource = this.raw.prepare('INSERT OR IGNORE INTO contact_sources (contact_id, source) VALUES (?, ?)')
    const addTag = this.raw.prepare(
      'INSERT INTO contact_tags (contact_id, tag, tag_fold) VALUES (?, ?, ?) ON CONFLICT(contact_id, tag_fold) DO NOTHING',
    )
    let added = 0
    let updated = 0
    let unchanged = 0
    const tx = this.raw.transaction((rows: ContactDraft[]) => {
      const now = nowIso()
      for (const row of rows) {
        const existing = find.get(row.phone) as { id: number; name: string; name_rank: number } | undefined
        if (!existing) {
          const info = insert.run(row.phone, row.name, foldText(row.name), row.nameRank, now, now)
          const id = Number(info.lastInsertRowid)
          for (const source of row.sources) addSource.run(id, source)
          for (const tag of row.tags) addTag.run(id, tag, foldText(tag))
          added += 1
          continue
        }
        let changed = false
        const name = mergeName({ name: existing.name, nameRank: existing.name_rank }, row)
        if (name.name !== existing.name || name.nameRank !== existing.name_rank) {
          update.run(name.name, foldText(name.name), name.nameRank, now, existing.id)
          changed = true
        }
        for (const source of row.sources) {
          const info = addSource.run(existing.id, source)
          if (info.changes > 0) changed = true
        }
        for (const tag of row.tags) {
          const info = addTag.run(existing.id, tag, foldText(tag))
          if (info.changes > 0) changed = true
        }
        if (changed) updated += 1
        else unchanged += 1
      }
    })
    tx([...deduped.values()])
    return { added, updated, unchanged }
  }

  audiencePhones(source: AudienceSource, tag: string | null): string[] {
    const tagFold = tag?.trim() ? foldText(tag) : ''
    const rows = this.raw.prepare(
      `SELECT c.phone FROM contacts c
       WHERE ${sourceClause(source)}
         AND (? = '' OR c.id IN (SELECT contact_id FROM contact_tags WHERE tag_fold = ?))
       ORDER BY c.id ASC`,
    ).all(tagFold, tagFold) as { phone: string }[]
    return rows.map((row) => row.phone)
  }

  countAudience(source: AudienceSource, tag: string | null): number {
    const tagFold = tag?.trim() ? foldText(tag) : ''
    const row = this.raw.prepare(
      `SELECT COUNT(*) AS n FROM contacts c
       WHERE ${sourceClause(source)}
         AND (? = '' OR c.id IN (SELECT contact_id FROM contact_tags WHERE tag_fold = ?))`,
    ).get(tagFold, tagFold) as { n: number }
    return row.n
  }

  createPost(input: {
    accountId: string
    kind: PostKind
    body: string
    caption: string
    mediaPath: string | null
    thumbPath?: string | null
    mediaWidth?: number | null
    mediaHeight?: number | null
    originalName: string | null
    backgroundColor: string | null
    font: number | null
    audienceSource: AudienceSource
    audienceTag: string | null
    scheduledAt: string | null
    status: PostStatus
  }): StatusPost {
    const now = nowIso()
    const info = this.raw.prepare(
      `INSERT INTO status_posts (
        account_id, kind, body, caption, media_path, thumb_path, media_width, media_height, original_name, background_color, font,
        audience_source, audience_tag, scheduled_at, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.accountId,
      input.kind,
      input.body,
      input.caption,
      input.mediaPath,
      input.thumbPath ?? null,
      input.mediaWidth ?? null,
      input.mediaHeight ?? null,
      input.originalName,
      input.backgroundColor,
      input.font,
      input.audienceSource,
      input.audienceTag,
      input.scheduledAt,
      input.status,
      now,
    )
    return this.getPost(Number(info.lastInsertRowid)) as StatusPost
  }

  getPost(id: number): StatusPost | null {
    const row = this.raw.prepare('SELECT * FROM status_posts WHERE id = ?').get(id) as PostRow | undefined
    return row ? mapPost(row) : null
  }

  listPosts(limit: number, includeDeleted = true): StatusPost[] {
    const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL'
    const rows = this.raw.prepare(`SELECT * FROM status_posts ${where} ORDER BY id DESC LIMIT ?`).all(limit) as PostRow[]
    return rows.map(mapPost)
  }

  requestDelete(id: number, now: string): 'missing' | 'ok' {
    const post = this.getPost(id)
    if (!post) return 'missing'
    const cancellable = post.status === 'queued' || post.status === 'scheduled' || post.status === 'running'
    this.updatePost(id, {
      deletedAt: post.deletedAt ?? now,
      ...(cancellable
        ? { status: 'cancelled' as const, finishedAt: post.finishedAt ?? now, error: 'Остановлено перед удалением' }
        : {}),
    })
    this.raw.prepare(
      `UPDATE status_batches
       SET revoke_status = 'pending', revoke_error = NULL
       WHERE post_id = ? AND status = 'sent' AND wa_message_id IS NOT NULL
         AND (revoke_status IS NULL OR revoke_status = 'failed')`,
    ).run(id)
    return 'ok'
  }

  retryRevoke(id: number): boolean {
    const post = this.getPost(id)
    if (!post?.deletedAt) return false
    const info = this.raw.prepare(
      `UPDATE status_batches SET revoke_status = 'pending', revoke_error = NULL
       WHERE post_id = ? AND revoke_status = 'failed'`,
    ).run(id)
    if (info.changes > 0) this.updatePost(id, { notBefore: null, error: null })
    return info.changes > 0
  }

  nextMediaCleanup(): number | null {
    const row = this.raw.prepare(
      `SELECT id FROM status_posts
       WHERE deleted_at IS NOT NULL
         AND status != 'running'
         AND (media_path IS NOT NULL OR thumb_path IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM status_batches
           WHERE post_id = status_posts.id AND revoke_status = 'pending'
         )
       ORDER BY id ASC LIMIT 1`,
    ).get() as { id: number } | undefined
    return row?.id ?? null
  }

  nextDeletion(now: string): number | null {
    const row = this.raw.prepare(
      `SELECT id FROM status_posts
       WHERE deleted_at IS NOT NULL
         AND status != 'running'
         AND (not_before IS NULL OR not_before <= ?)
         AND EXISTS (
           SELECT 1 FROM status_batches
           WHERE post_id = status_posts.id AND revoke_status = 'pending'
         )
       ORDER BY deleted_at ASC, id ASC
       LIMIT 1`,
    ).get(now) as { id: number } | undefined
    return row?.id ?? null
  }

  pendingRevokes(postId: number): StatusBatch[] {
    return this.listBatches(postId).filter((batch) => batch.revokeStatus === 'pending' && batch.waMessageId)
  }

  markRevoke(id: number, status: 'revoked' | 'failed' | 'pending', error: string | null): void {
    this.raw.prepare('UPDATE status_batches SET revoke_status = ?, revoke_error = ? WHERE id = ?').run(status, error, id)
  }

  claimNextPost(now: string): number | null {
    const row = this.raw.prepare(
      `UPDATE status_posts
       SET status = 'running', started_at = COALESCE(started_at, ?)
       WHERE id = (
         SELECT id FROM status_posts
         WHERE (status = 'queued' OR (status = 'scheduled' AND scheduled_at <= ?))
           AND (not_before IS NULL OR not_before <= ?)
         ORDER BY COALESCE(scheduled_at, created_at) ASC, id ASC
         LIMIT 1
       )
       AND NOT EXISTS (SELECT 1 FROM status_posts WHERE status = 'running')
       RETURNING id`,
    ).get(now, now, now) as { id: number } | undefined
    return row?.id ?? null
  }

  updatePost(id: number, patch: PostPatch): void {
    const current = this.getPost(id)
    if (!current) return
    const next = { ...current, ...patch }
    this.raw.prepare(
      `UPDATE status_posts SET
        status = ?, not_before = ?, error = ?, started_at = ?, finished_at = ?,
        media_path = ?, thumb_path = ?, media_width = ?, media_height = ?, deleted_at = ?,
        total_recipients = ?, total_batches = ?, sent_batches = ?, success_recipients = ?, failed_recipients = ?
       WHERE id = ?`,
    ).run(
      next.status,
      next.notBefore,
      next.error,
      next.startedAt,
      next.finishedAt,
      next.mediaPath,
      next.thumbPath,
      next.mediaWidth,
      next.mediaHeight,
      next.deletedAt,
      next.totalRecipients,
      next.totalBatches,
      next.sentBatches,
      next.successRecipients,
      next.failedRecipients,
      id,
    )
  }

  listBatches(postId: number): StatusBatch[] {
    const rows = this.raw.prepare('SELECT * FROM status_batches WHERE post_id = ? ORDER BY batch_index ASC').all(postId) as BatchRow[]
    return rows.map(mapBatch)
  }

  nextPendingBatch(postId: number): StatusBatch | null {
    const row = this.raw.prepare(
      `SELECT * FROM status_batches WHERE post_id = ? AND status = 'pending' ORDER BY batch_index ASC LIMIT 1`,
    ).get(postId) as BatchRow | undefined
    return row ? mapBatch(row) : null
  }

  insertBatches(postId: number, chunks: string[][], ownJid: string | null): void {
    const stmt = this.raw.prepare(
      `INSERT INTO status_batches (post_id, batch_index, recipient_count, jids_json, status) VALUES (?, ?, ?, ?, 'pending')`,
    )
    const tx = this.raw.transaction((rows: string[][]) => {
      rows.forEach((jids, index) => {
        const audience = jids.filter((jid) => jid !== ownJid).length
        stmt.run(postId, index, audience, JSON.stringify(jids))
      })
    })
    tx(chunks)
  }

  resetFailedBatches(postId: number): void {
    this.raw.prepare(`UPDATE status_batches SET status = 'pending', error = NULL, sent_at = NULL WHERE post_id = ? AND status = 'failed'`).run(postId)
  }

  findPostByMessage(messageId: string): number | null {
    const row = this.raw.prepare('SELECT post_id FROM status_batches WHERE wa_message_id = ?').get(messageId) as { post_id: number } | undefined
    return row?.post_id ?? null
  }

  recordStatusView(input: { postId: number; viewerJid: string; phone: string; name: string; viewedAt: string }): boolean {
    const info = this.raw.prepare(
      `INSERT INTO status_views (post_id, viewer_jid, phone, name, viewed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(post_id, viewer_jid) DO NOTHING`,
    ).run(input.postId, input.viewerJid, input.phone, input.name, input.viewedAt)
    return info.changes > 0
  }

  contactNameByPhone(phone: string): string {
    const row = this.raw.prepare('SELECT name FROM contacts WHERE phone = ?').get(phone) as { name: string } | undefined
    return row?.name ?? ''
  }

  countViews(postIds: number[]): Map<number, number> {
    const counts = new Map<number, number>()
    if (postIds.length === 0) return counts
    const marks = postIds.map(() => '?').join(',')
    const rows = this.raw.prepare(
      `SELECT post_id, COUNT(*) AS n FROM status_views WHERE post_id IN (${marks}) GROUP BY post_id`,
    ).all(...postIds) as { post_id: number; n: number }[]
    for (const row of rows) counts.set(row.post_id, row.n)
    return counts
  }

  listViews(postId: number, opts: { q: string; tag: string; source: SourceFilter; limit: number; offset: number }): { total: number; items: StatusView[] } {
    const where = this.viewWhere(opts.q, opts.tag, opts.source)
    const total = (this.raw.prepare(
      `SELECT COUNT(*) AS n FROM status_views v LEFT JOIN contacts c ON c.phone = v.phone WHERE v.post_id = ? AND ${where.sql}`,
    ).get(postId, ...where.params) as { n: number }).n
    const rows = this.raw.prepare(
      `SELECT v.viewer_jid, v.phone, COALESCE(NULLIF(c.name, ''), v.name) AS name, v.viewed_at
       FROM status_views v LEFT JOIN contacts c ON c.phone = v.phone
       WHERE v.post_id = ? AND ${where.sql}
       ORDER BY v.viewed_at DESC LIMIT ? OFFSET ?`,
    ).all(postId, ...where.params, opts.limit, opts.offset) as { viewer_jid: string; phone: string; name: string; viewed_at: string }[]
    return {
      total,
      items: rows.map((row) => ({ viewerJid: row.viewer_jid, phone: row.phone, name: row.name, viewedAt: row.viewed_at })),
    }
  }

  failStuckRunning(olderThanIso: string, now: string): number {
    const info = this.raw.prepare(
      `UPDATE status_posts
       SET status = 'failed', finished_at = ?, error = ?
       WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?`,
    ).run(now, 'Публикация зависла и остановлена. Её можно повторить.', olderThanIso)
    return info.changes
  }

  markBatch(id: number, patch: { status: 'sent' | 'failed'; error?: string | null; waMessageId?: string | null }): void {
    this.raw.prepare(
      `UPDATE status_batches SET status = ?, error = ?, wa_message_id = ?, sent_at = ? WHERE id = ?`,
    ).run(patch.status, patch.error ?? null, patch.waMessageId ?? null, patch.status === 'sent' ? nowIso() : null, id)
  }

  aggregateBatches(postId: number): { total: number; sent: number; failed: number; pending: number; success: number; failedRecipients: number } {
    const row = this.raw.prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'sent' THEN recipient_count ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN recipient_count ELSE 0 END), 0) AS failed_recipients
       FROM status_batches WHERE post_id = ?`,
    ).get(postId) as { total: number; sent: number; failed: number; pending: number; success: number; failed_recipients: number }
    return {
      total: row.total,
      sent: row.sent,
      failed: row.failed,
      pending: row.pending,
      success: row.success,
      failedRecipients: row.failed_recipients,
    }
  }

  lastFinishedAt(): string | null {
    const row = this.raw.prepare(
      `SELECT finished_at FROM status_posts
       WHERE finished_at IS NOT NULL AND status IN ('done', 'partial', 'failed')
       ORDER BY finished_at DESC LIMIT 1`,
    ).get() as { finished_at: string } | undefined
    return row?.finished_at ?? null
  }

  queueCounts(): { queued: number; scheduled: number; running: number } {
    const rows = this.raw.prepare(
      `SELECT status, COUNT(*) AS n FROM status_posts WHERE status IN ('queued', 'scheduled', 'running') GROUP BY status`,
    ).all() as { status: string; n: number }[]
    const counts = { queued: 0, scheduled: 0, running: 0 }
    for (const row of rows) {
      if (row.status === 'queued' || row.status === 'scheduled' || row.status === 'running') counts[row.status] = row.n
    }
    return counts
  }

  resetRunningToQueued(): number {
    const info = this.raw.prepare(`UPDATE status_posts SET status = 'queued' WHERE status = 'running'`).run()
    return info.changes
  }

  countFinishedSince(iso: string): number {
    const row = this.raw.prepare(
      `SELECT COUNT(*) AS n FROM status_posts WHERE finished_at >= ? AND status IN ('done', 'partial')`,
    ).get(iso) as { n: number }
    return row.n
  }

  addImportRun(input: { filename: string; added: number; updated: number; skipped: number; merged: number; issues: ImportIssue[] }): ImportRun {
    const now = nowIso()
    const issues = input.issues.slice(0, 200)
    const info = this.raw.prepare(
      `INSERT INTO import_runs (filename, added, updated, skipped, merged, issues_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.filename, input.added, input.updated, input.skipped, input.merged, JSON.stringify(issues), now)
    return this.getImportRun(Number(info.lastInsertRowid)) as ImportRun
  }

  getImportRun(id: number): ImportRun | null {
    const row = this.raw.prepare('SELECT * FROM import_runs WHERE id = ?').get(id) as ImportRunRow | undefined
    if (!row) return null
    return {
      id: row.id,
      filename: row.filename,
      added: row.added,
      updated: row.updated,
      skipped: row.skipped,
      merged: row.merged,
      issues: JSON.parse(row.issues_json) as ImportIssue[],
      createdAt: row.created_at,
    }
  }

  addLog(level: 'info' | 'warn' | 'error', message: string, accountId?: string | null): void {
    this.raw.prepare('INSERT INTO logs (level, account_id, message, created_at) VALUES (?, ?, ?, ?)').run(level, accountId ?? null, message, nowIso())
    this.raw.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 1000)').run()
  }

  listLogs(limit: number): { id: number; level: string; accountId: string | null; message: string; createdAt: string }[] {
    const rows = this.raw.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit) as LogRow[]
    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      accountId: row.account_id,
      message: row.message,
      createdAt: row.created_at,
    }))
  }

  upsertDiscovered(accountId: string, rows: { phone: string; name: string; nameRank: number }[]): void {
    const stmt = this.raw.prepare(
      `INSERT INTO wa_discovered (account_id, phone, name, name_rank, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, phone) DO UPDATE SET
         name = CASE
           WHEN excluded.name_rank > wa_discovered.name_rank OR (wa_discovered.name = '' AND excluded.name != '') THEN excluded.name
           ELSE wa_discovered.name END,
         name_rank = CASE WHEN excluded.name_rank > wa_discovered.name_rank THEN excluded.name_rank ELSE wa_discovered.name_rank END,
         updated_at = excluded.updated_at`,
    )
    const tx = this.raw.transaction((items: { phone: string; name: string; nameRank: number }[]) => {
      const now = nowIso()
      for (const item of items) stmt.run(accountId, item.phone, item.name, item.nameRank, now)
    })
    tx(rows)
  }

  listDiscovered(accountId: string): ContactDraft[] {
    const rows = this.raw.prepare(
      'SELECT phone, name, name_rank FROM wa_discovered WHERE account_id = ? ORDER BY phone ASC',
    ).all(accountId) as { phone: string; name: string; name_rank: number }[]
    return rows.map((row) => ({
      phone: row.phone,
      name: row.name,
      nameRank: row.name_rank,
      tags: [],
      sources: ['whatsapp'] as ContactSource[],
    }))
  }

  countDiscovered(accountId: string): number {
    const row = this.raw.prepare('SELECT COUNT(*) AS n FROM wa_discovered WHERE account_id = ?').get(accountId) as { n: number }
    return row.n
  }

  upsertLid(accountId: string, lid: string, patch: { phone?: string | null; name?: string; nameRank?: number }): void {
    const current = this.raw.prepare('SELECT phone, name, name_rank FROM wa_lids WHERE account_id = ? AND lid = ?').get(accountId, lid) as
      | { phone: string | null; name: string; name_rank: number }
      | undefined
    const name = mergeName(
      { name: current?.name ?? '', nameRank: current?.name_rank ?? 0 },
      { name: patch.name ?? current?.name ?? '', nameRank: patch.nameRank ?? current?.name_rank ?? 0 },
    )
    const phone = patch.phone === undefined ? current?.phone ?? null : patch.phone ?? current?.phone ?? null
    this.raw.prepare(
      `INSERT INTO wa_lids (account_id, lid, phone, name, name_rank)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, lid) DO UPDATE SET phone = excluded.phone, name = excluded.name, name_rank = excluded.name_rank`,
    ).run(accountId, lid, phone, name.name, name.nameRank)
  }

  lidPhoneMap(accountId: string): Map<string, string> {
    const rows = this.raw.prepare(
      `SELECT lid, phone FROM wa_lids WHERE account_id = ? AND phone IS NOT NULL AND phone != ''`,
    ).all(accountId) as { lid: string; phone: string }[]
    return new Map(rows.map((row) => [row.lid, row.phone]))
  }

  private viewWhere(q: string, tag: string, source: SourceFilter): { sql: string; params: string[] } {
    const folded = foldText(q)
    const digits = q.replace(/\D/g, '')
    const phoneLike = likeContains(digits || folded)
    const nameLike = likeContains(folded)
    const tagFold = tag.trim() ? foldText(tag) : ''
    const sourceSql = source === 'whatsapp'
      ? `EXISTS (SELECT 1 FROM contact_sources sw WHERE sw.contact_id = c.id AND sw.source = 'whatsapp')`
      : source === 'phone'
        ? `EXISTS (SELECT 1 FROM contact_sources sp WHERE sp.contact_id = c.id AND sp.source = 'phone')`
        : source === 'both'
          ? `EXISTS (SELECT 1 FROM contact_sources sw WHERE sw.contact_id = c.id AND sw.source = 'whatsapp') AND EXISTS (SELECT 1 FROM contact_sources sp WHERE sp.contact_id = c.id AND sp.source = 'phone')`
          : '1=1'
    return {
      sql: `${sourceSql}
        AND (? = '' OR v.phone LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR c.name_fold LIKE ? ESCAPE '\\')
        AND (? = '' OR c.id IN (SELECT contact_id FROM contact_tags WHERE tag_fold = ?))`,
      params: [q.trim(), phoneLike, nameLike, nameLike, tagFold, tagFold],
    }
  }

  private contactWhere(q: string, tag: string, source: SourceFilter): { sql: string; params: string[] } {
    const folded = foldText(q)
    const digits = q.replace(/\D/g, '')
    const phoneLike = likeContains(digits || folded)
    const nameLike = likeContains(folded)
    const tagFold = tag.trim() ? foldText(tag) : ''
    const sql = `${sourceClause(source)}
      AND (? = '' OR phone LIKE ? ESCAPE '\\' OR name_fold LIKE ? ESCAPE '\\'
        OR id IN (SELECT contact_id FROM contact_tags WHERE tag_fold LIKE ? ESCAPE '\\'))
      AND (? = '' OR id IN (SELECT contact_id FROM contact_tags WHERE tag_fold = ?))`
    return { sql, params: [q.trim(), phoneLike, nameLike, nameLike, tagFold, tagFold] }
  }

  private hydrate(rows: ContactRow[]): Contact[] {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const marks = ids.map(() => '?').join(',')
    const tags = this.raw.prepare(`SELECT contact_id, tag FROM contact_tags WHERE contact_id IN (${marks}) ORDER BY tag`).all(...ids) as {
      contact_id: number
      tag: string
    }[]
    const sources = this.raw.prepare(
      `SELECT contact_id, source FROM contact_sources WHERE contact_id IN (${marks})`,
    ).all(...ids) as { contact_id: number; source: ContactSource }[]
    return rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      name: row.name,
      nameRank: row.name_rank,
      tags: tags.filter((tag) => tag.contact_id === row.id).map((tag) => tag.tag),
      sources: uniqueSources(sources.filter((source) => source.contact_id === row.id).map((source) => source.source)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
}

export function openDatabase(file: string): AppDb {
  const raw = new Database(file)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  raw.pragma('busy_timeout = 5000')
  raw.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL,
      last_error TEXT,
      connected_at TEXT,
      auto_connect INTEGER NOT NULL DEFAULT 1,
      history_complete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      name_fold TEXT NOT NULL DEFAULT '',
      name_rank INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contact_sources (
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('whatsapp', 'phone')),
      PRIMARY KEY (contact_id, source)
    );
    CREATE TABLE IF NOT EXISTS contact_tags (
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      tag_fold TEXT NOT NULL,
      PRIMARY KEY (contact_id, tag_fold)
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_name_fold ON contacts(name_fold);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_fold ON contact_tags(tag_fold);
    CREATE TABLE IF NOT EXISTS wa_discovered (
      account_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      name_rank INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, phone)
    );
    CREATE TABLE IF NOT EXISTS wa_lids (
      account_id TEXT NOT NULL,
      lid TEXT NOT NULL,
      phone TEXT,
      name TEXT NOT NULL DEFAULT '',
      name_rank INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, lid)
    );
    CREATE TABLE IF NOT EXISTS status_posts (
      id INTEGER PRIMARY KEY,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      media_path TEXT,
      thumb_path TEXT,
      media_width INTEGER,
      media_height INTEGER,
      original_name TEXT,
      background_color TEXT,
      font INTEGER,
      audience_source TEXT NOT NULL,
      audience_tag TEXT,
      scheduled_at TEXT,
      not_before TEXT,
      status TEXT NOT NULL,
      total_recipients INTEGER NOT NULL DEFAULT 0,
      total_batches INTEGER NOT NULL DEFAULT 0,
      sent_batches INTEGER NOT NULL DEFAULT 0,
      success_recipients INTEGER NOT NULL DEFAULT 0,
      failed_recipients INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_posts_status ON status_posts(status, scheduled_at);
    CREATE TABLE IF NOT EXISTS status_batches (
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES status_posts(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL,
      recipient_count INTEGER NOT NULL,
      jids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      wa_message_id TEXT,
      sent_at TEXT,
      revoke_status TEXT,
      revoke_error TEXT,
      UNIQUE(post_id, batch_index)
    );
    CREATE TABLE IF NOT EXISTS status_views (
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES status_posts(id) ON DELETE CASCADE,
      viewer_jid TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      viewed_at TEXT NOT NULL,
      UNIQUE(post_id, viewer_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_status_views_post ON status_views(post_id, viewed_at);
    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      added INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      skipped INTEGER NOT NULL,
      merged INTEGER NOT NULL,
      issues_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      level TEXT NOT NULL,
      account_id TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  ensureColumn(raw, 'status_posts', 'thumb_path', 'TEXT')
  ensureColumn(raw, 'status_posts', 'media_width', 'INTEGER')
  ensureColumn(raw, 'status_posts', 'media_height', 'INTEGER')
  ensureColumn(raw, 'status_posts', 'deleted_at', 'TEXT')
  ensureColumn(raw, 'status_batches', 'revoke_status', 'TEXT')
  ensureColumn(raw, 'status_batches', 'revoke_error', 'TEXT')
  return new AppDb(raw)
}

function ensureColumn(raw: Database.Database, table: string, column: string, ddl: string): void {
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!rows.some((row) => row.name === column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

type AccountRow = {
  id: string
  label: string
  phone: string | null
  status: AccountStatus
  last_error: string | null
  connected_at: string | null
  auto_connect: number
  history_complete: number
  created_at: string
  updated_at: string
}

type ContactRow = {
  id: number
  phone: string
  name: string
  name_fold: string
  name_rank: number
  created_at: string
  updated_at: string
}

type PostRow = {
  id: number
  account_id: string
  kind: PostKind
  body: string
  caption: string
  media_path: string | null
  thumb_path: string | null
  media_width: number | null
  media_height: number | null
  original_name: string | null
  background_color: string | null
  font: number | null
  audience_source: AudienceSource
  audience_tag: string | null
  scheduled_at: string | null
  not_before: string | null
  status: PostStatus
  total_recipients: number
  total_batches: number
  sent_batches: number
  success_recipients: number
  failed_recipients: number
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  deleted_at: string | null
}

type BatchRow = {
  id: number
  post_id: number
  batch_index: number
  recipient_count: number
  jids_json: string
  status: 'pending' | 'sent' | 'failed'
  error: string | null
  wa_message_id: string | null
  sent_at: string | null
  revoke_status: 'pending' | 'revoked' | 'failed' | null
  revoke_error: string | null
}

type ImportRunRow = {
  id: number
  filename: string
  added: number
  updated: number
  skipped: number
  merged: number
  issues_json: string
  created_at: string
}

type LogRow = {
  id: number
  level: string
  account_id: string | null
  message: string
  created_at: string
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    label: row.label,
    phone: row.phone,
    status: row.status,
    lastError: row.last_error,
    connectedAt: row.connected_at,
    autoConnect: row.auto_connect === 1,
    historyComplete: row.history_complete === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPost(row: PostRow): StatusPost {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    body: row.body,
    caption: row.caption,
    mediaPath: row.media_path,
    thumbPath: row.thumb_path,
    mediaWidth: row.media_width,
    mediaHeight: row.media_height,
    originalName: row.original_name,
    backgroundColor: row.background_color,
    font: row.font,
    audienceSource: row.audience_source,
    audienceTag: row.audience_tag,
    scheduledAt: row.scheduled_at,
    notBefore: row.not_before,
    status: row.status,
    totalRecipients: row.total_recipients,
    totalBatches: row.total_batches,
    sentBatches: row.sent_batches,
    successRecipients: row.success_recipients,
    failedRecipients: row.failed_recipients,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    deletedAt: row.deleted_at,
  }
}

function mapBatch(row: BatchRow): StatusBatch {
  let jids: string[] = []
  try {
    const parsed = JSON.parse(row.jids_json) as unknown
    if (Array.isArray(parsed)) jids = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    jids = []
  }
  return {
    id: row.id,
    postId: row.post_id,
    batchIndex: row.batch_index,
    recipientCount: row.recipient_count,
    jids,
    status: row.status,
    error: row.error,
    waMessageId: row.wa_message_id,
    sentAt: row.sent_at,
    revokeStatus: row.revoke_status,
    revokeError: row.revoke_error,
  }
}
