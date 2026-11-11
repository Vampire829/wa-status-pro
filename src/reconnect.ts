/** Решение, что делать после обрыва сокета. Чистая функция, чтобы цикл QR не расползался. */
export type ReconnectInput = {
  code?: number
  showingQr: boolean
  wasConnected: boolean
  backoffMs: number
  /** Сколько быстрых обновлений QR подряд не принесли новый код. */
  qrRefreshStrikes: number
}

export type ReconnectPlan = {
  action: 'stop' | 'retry'
  waitMs: number
  nextBackoffMs: number
  keepQr: boolean
  countStrike: boolean
  reason: 'logged_out' | 'forbidden' | 'replaced' | 'bad_session' | 'restart' | 'qr_refresh' | 'network'
  log: 'info' | 'warn'
  message: string
}

const MIN_BACKOFF_MS = 2_000
const QR_REFRESH_MS = 1_000
const RESTART_MS = 500
const MAX_BACKOFF_PAIRED_MS = 60_000
const MAX_BACKOFF_PAIRING_MS = 15_000
const MAX_QR_STRIKES = 6

export function planReconnect(input: ReconnectInput): ReconnectPlan {
  const backoff = clampBackoff(input.backoffMs)
  if (input.code === 401) return stop('logged_out', 'WhatsApp сбросил сессию. Отсканируйте QR заново.')
  if (input.code === 403) return stop('forbidden', 'WhatsApp отклонил сессию (403). Остановитесь и проверьте номер, не запускайте переподключение пачкой.')
  if (input.code === 440) return stop('replaced', 'Сессию заменило другое подключение. Нажмите «Подключить снова», когда будете готовы.')
  if (input.code === 500) return stop('bad_session', 'Сессия повреждена. Отвяжите номер и отсканируйте QR заново.')
  if (input.code === 515) {
    return {
      action: 'retry',
      waitMs: RESTART_MS,
      nextBackoffMs: MIN_BACKOFF_MS,
      keepQr: false,
      countStrike: false,
      reason: 'restart',
      log: 'info',
      message: 'WhatsApp просит переподключить сессию после привязки',
    }
  }
  if (input.showingQr && input.qrRefreshStrikes < MAX_QR_STRIKES) {
    return {
      action: 'retry',
      waitMs: QR_REFRESH_MS,
      nextBackoffMs: MIN_BACKOFF_MS,
      keepQr: true,
      countStrike: true,
      reason: 'qr_refresh',
      log: 'info',
      message: 'Обновляем QR',
    }
  }
  const cap = input.wasConnected ? MAX_BACKOFF_PAIRED_MS : MAX_BACKOFF_PAIRING_MS
  const next = Math.min(Math.max(backoff * 2, MIN_BACKOFF_MS), cap)
  const wait = Math.min(backoff, cap)
  return {
    action: 'retry',
    waitMs: wait,
    nextBackoffMs: next,
    keepQr: false,
    countStrike: false,
    reason: 'network',
    log: 'warn',
    message: `Нет связи с WhatsApp, повтор через ${Math.round(wait / 1000)} с`,
  }
}

function stop(reason: ReconnectPlan['reason'], message: string): ReconnectPlan {
  return {
    action: 'stop',
    waitMs: 0,
    nextBackoffMs: MIN_BACKOFF_MS,
    keepQr: false,
    countStrike: false,
    reason,
    log: 'warn',
    message,
  }
}

function clampBackoff(value: number): number {
  if (!Number.isFinite(value) || value < MIN_BACKOFF_MS) return MIN_BACKOFF_MS
  return value
}
