import path from 'node:path'

import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { createApp } from './http/server.js'
import { startScheduler } from './publisher.js'
import { WaManager } from './waManager.js'

const config = loadConfig()
const db = openDatabase(path.join(config.dataDir, 'app.sqlite'))

function log(level: 'info' | 'warn' | 'error', message: string, accountId?: string | null): void {
  const line = `[${level}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  try {
    db.addLog(level, message, accountId)
  } catch (error) {
    console.error('[error] не удалось записать журнал', error)
  }
}

const resumed = db.resetRunningToQueued()
if (resumed > 0) log('warn', `В очередь возвращено прерванных публикаций: ${resumed}`)

const wa = new WaManager(db, config, log)
const app = createApp({ config, db, wa })
const scheduler = startScheduler({
  db,
  wa,
  batchSize: config.batchSize,
  batchDelayMs: config.batchDelayMs,
  minPublishIntervalMs: config.minPublishIntervalMs,
  log,
})

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  log('info', `Остановка (${signal})`)
  scheduler.stop()
  await wa.shutdown()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  process.exit(0)
}

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
  log('info', `Панель WA Status Pro: http://${shown}:${config.port}`)
})

void wa.restore().catch((error) => {
  log('error', error instanceof Error ? error.message : 'Не удалось восстановить сессии')
})

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('unhandledRejection', (error) => {
  log('error', `Необработанная ошибка: ${error instanceof Error ? error.message : String(error)}`)
})
