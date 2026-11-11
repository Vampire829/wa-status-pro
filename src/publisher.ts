import { planBatches } from './batch.js'
import type { AppDb } from './db.js'
import { WaSendError } from './errors.js'
import type { StatusPost } from './types.js'
import { nowIso } from './time.js'
import type { StatusContent, WaManager } from './waManager.js'

export type PublisherDeps = {
  db: AppDb
  wa: Pick<WaManager, 'isReady' | 'isBlocked' | 'sendStatus'>
  batchSize: number
  batchDelayMs: number
  minPublishIntervalMs: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  log?: (level: 'info' | 'warn' | 'error', message: string, accountId?: string | null) => void
}

export function startScheduler(deps: PublisherDeps, intervalMs = 2000): { stop: () => void } {
  let stopped = false
  let running = false
  const timer = setInterval(() => {
    if (stopped || running) return
    running = true
    publishOnce(deps)
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error)
        deps.log?.('error', `Планировщик: ${text}`)
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  return { stop() { stopped = true; clearInterval(timer) } }
}

export async function publishOnce(deps: PublisherDeps): Promise<boolean> {
  const now = (deps.now ?? (() => new Date()))()
  const stamp = nowIso(now)
  const claimed = deps.db.claimNextPost(stamp)
  if (claimed == null) return false
  const post = deps.db.getPost(claimed)
  if (!post) return false
  if (post.sentBatches === 0 && deps.minPublishIntervalMs > 0) {
    const last = deps.db.lastFinishedAt()
    if (last) {
      const elapsed = now.getTime() - new Date(last).getTime()
      if (elapsed < deps.minPublishIntervalMs) {
        deps.db.updatePost(post.id, {
          status: 'queued',
          notBefore: new Date(new Date(last).getTime() + deps.minPublishIntervalMs).toISOString(),
          error: 'Пауза между публикациями, чтобы не частить',
        })
        return false
      }
    }
  }
  try {
    await runPost(deps, post, now)
  } catch (error) {
    const text = clip(error instanceof Error ? error.message : 'Сбой публикации')
    deps.log?.('error', `Публикация #${post.id}: ${text}`, post.accountId)
    deps.db.updatePost(post.id, { status: 'failed', finishedAt: nowIso(now), error: text })
  }
  return true
}

async function runPost(deps: PublisherDeps, post: StatusPost, now: Date): Promise<void> {
  const account = deps.db.getAccount(post.accountId)
  if (!account) {
    deps.db.updatePost(post.id, { status: 'failed', finishedAt: nowIso(now), error: 'Номер удалён' })
    return
  }
  let batches = deps.db.listBatches(post.id)
  if (batches.length === 0) {
    if (deps.wa.isBlocked(post.accountId)) {
      deps.db.updatePost(post.id, { status: 'failed', finishedAt: nowIso(now), error: 'Сессия номера сброшена' })
      return
    }
    if (!deps.wa.isReady(post.accountId)) {
      requeue(deps, post.id, 20_000, 'Номер не на связи, публикация ждёт подключения')
      return
    }
    const phones = deps.db.audiencePhones(post.audienceSource, post.audienceTag)
    const jids = phones.map((phone) => `${phone}@s.whatsapp.net`)
    const chunks = planBatches(jids, deps.batchSize)
    if (chunks.length === 0) {
      deps.db.updatePost(post.id, { status: 'failed', finishedAt: nowIso(now), error: 'В выбранной аудитории нет контактов' })
      return
    }
    deps.db.insertBatches(post.id, chunks)
    deps.db.updatePost(post.id, {
      totalRecipients: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      totalBatches: chunks.length,
      error: null,
    })
    deps.log?.('info', `Публикация #${post.id}: ${chunks.reduce((s, c) => s + c.length, 0)} получателей, пачек ${chunks.length}`, post.accountId)
    batches = deps.db.listBatches(post.id)
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (const batch of batches) {
    if (batch.status !== 'pending') continue
    const fresh = deps.db.getPost(post.id)
    if (fresh?.status === 'cancelled') {
      deps.db.updatePost(post.id, { finishedAt: nowIso(), error: 'Остановлено из панели' })
      return
    }
    let sent = false
    let lastError = 'Пачка не отправилась'
    for (let attempt = 1; attempt <= 2 && !sent; attempt += 1) {
      try {
        const result = await deps.wa.sendStatus(post.accountId, contentOf(post), batch.jids)
        deps.db.markBatch(batch.id, { status: 'sent', waMessageId: result.messageId })
        sent = true
      } catch (error) {
        if (error instanceof WaSendError && error.pause) {
          refresh(deps, post.id)
          requeue(deps, post.id, 20_000, 'Номер отключился во время отправки')
          return
        }
        if (error instanceof WaSendError && (error.code === 401 || error.code === 403)) {
          refresh(deps, post.id)
          deps.db.updatePost(post.id, {
            status: 'failed',
            finishedAt: nowIso(),
            error: error.message,
          })
          return
        }
        lastError = clip(error instanceof Error ? error.message : 'Ошибка отправки')
        if (attempt === 1) await sleep(deps.batchDelayMs)
      }
    }
    if (!sent) deps.db.markBatch(batch.id, { status: 'failed', error: lastError })
    refresh(deps, post.id)
    const pendingLeft = deps.db.nextPendingBatch(post.id)
    if (pendingLeft) await sleep(deps.batchDelayMs)
  }

  const agg = deps.db.aggregateBatches(post.id)
  let status: StatusPost['status'] = 'done'
  let error: string | null = null
  if (agg.sent === 0) {
    status = 'failed'
    error = 'Ни одна пачка не ушла в WhatsApp'
  } else if (agg.failed > 0) {
    status = 'partial'
    error = 'Часть пачек не отправилась. Подробности в списке пачек.'
  }
  deps.db.updatePost(post.id, {
    status,
    error,
    finishedAt: nowIso(),
    sentBatches: agg.sent,
    successRecipients: agg.success,
    failedRecipients: agg.failedRecipients,
    totalBatches: agg.total,
  })
  deps.log?.(status === 'done' ? 'info' : 'warn', `Публикация #${post.id}: ${status === 'done' ? 'готово' : error}`, post.accountId)
}

function contentOf(post: StatusPost): StatusContent {
  if (post.kind === 'text') {
    return { kind: 'text', text: post.body, backgroundColor: post.backgroundColor || '#0E6B52', font: post.font ?? 0 }
  }
  if (!post.mediaPath) throw new Error('Файл публикации не найден')
  if (post.kind === 'image') return { kind: 'image', filePath: post.mediaPath, caption: post.caption }
  return { kind: 'video', filePath: post.mediaPath, caption: post.caption }
}

function refresh(deps: PublisherDeps, postId: number): void {
  const agg = deps.db.aggregateBatches(postId)
  deps.db.updatePost(postId, {
    sentBatches: agg.sent,
    successRecipients: agg.success,
    failedRecipients: agg.failedRecipients,
    totalBatches: agg.total,
    totalRecipients: agg.success + agg.failedRecipients + deps.db.listBatches(postId).filter((batch) => batch.status === 'pending').reduce((sum, batch) => sum + batch.recipientCount, 0),
  })
}

function requeue(deps: PublisherDeps, postId: number, delayMs: number, error: string): void {
  const base = (deps.now ?? (() => new Date()))()
  deps.db.updatePost(postId, {
    status: 'queued',
    notBefore: new Date(base.getTime() + delayMs).toISOString(),
    error,
  })
}

function clip(value: string): string {
  return value.length > 500 ? value.slice(0, 500) : value
}
