import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'

import type { AppConfig } from '../src/config.js'
import { openDatabase } from '../src/db.js'
import { createApp } from '../src/http/server.js'
import { WaManager } from '../src/waManager.js'

test('панель отдаёт вход на русском и не пускает без пароля', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-http-'))
  const db = openDatabase(path.join(dir, 'app.sqlite'))
  const config = {
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    adminPassword: 'test-password',
    sessionSecret: 'test-session-secret-value',
    sessionTtlHours: 1,
    cookieSecure: false,
    trustProxy: false,
    batchSize: 100,
    batchDelayMs: 4000,
    minPublishIntervalMs: 0,
    maxUploadMb: 8,
    maxVideoSeconds: 30,
    ffmpegPath: 'ffmpeg',
    logLevel: 'silent',
    baileysLogLevel: 'silent',
    syncFullHistory: false,
    warnDefaultPassword: false,
    warnDefaultSecret: false,
  } satisfies AppConfig
  const wa = new WaManager(db, config, () => undefined)
  const app = createApp({ config, db, wa })
  const server = app.listen(0, '127.0.0.1')
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve())
      server.once('error', reject)
    })
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('нет порта')
  const port = (address as AddressInfo).port
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(health.status, 200)
    const login = await fetch(`http://127.0.0.1:${port}/login`)
    const html = await login.text()
    assert.match(html, /Вход/)
    assert.match(html, /Пароль/)
    const denied = await fetch(`http://127.0.0.1:${port}/contacts`, { redirect: 'manual' })
    assert.equal(denied.status, 302)
    const bad = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
      redirect: 'manual',
    })
    assert.equal(bad.status, 302)
    const ok = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=test-password',
      redirect: 'manual',
    })
    const cookie = ok.headers.get('set-cookie') ?? ''
    assert.match(cookie, /wsp_session=/)
    const home = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: cookie.split(';')[0] ?? '' } })
    const homeHtml = await home.text()
    assert.match(homeHtml, /Обзор/)
    assert.match(homeHtml, /Из WhatsApp/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    db.close()
  }
})
