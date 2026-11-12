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
    waProxyUrl: null,
    waProxyLabel: null,
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
    assert.equal(ok.headers.get('location'), '/stories')
    const home = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: cookie.split(';')[0] ?? '' } })
    const homeHtml = await home.text()
    assert.match(homeHtml, /Обзор/)
    assert.match(homeHtml, /Из WhatsApp/)
    const journal = await fetch(`http://127.0.0.1:${port}/health`, { headers: { cookie: cookie.split(';')[0] ?? '' } })
    const healthHtml = await journal.text()
    assert.match(healthHtml, /Прокси WhatsApp не задан/)
    assert.match(healthHtml, /Проверить прокси/)
    db.applyMerge([{ phone: '79280000001', name: 'Аминат', nameRank: 3, tags: ['vip'], sources: ['phone'] }])
    const account = db.createAccount('Тест')
    const stories = await fetch(`http://127.0.0.1:${port}/stories`, { headers: { cookie: cookie.split(';')[0] ?? '' } })
    const storiesHtml = await stories.text()
    assert.match(storiesHtml, /id="add-status"/)
    assert.match(storiesHtml, /Статус/)
    assert.match(storiesHtml, /id="add-text"/)
    assert.match(storiesHtml, /composer\.js/)
    const csrf = /data-csrf="([^"]+)"/.exec(storiesHtml)?.[1] ?? ''
    assert.ok(csrf)
    const count = await fetch(`http://127.0.0.1:${port}/api/audience-count`, {
      method: 'POST',
      headers: { cookie: cookie.split(';')[0] ?? '', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, audience: JSON.stringify({ mode: 'only', includeTags: ['vip'] }) }),
    })
    assert.equal((await count.json()).count, 1)
    const form = new FormData()
    form.set('csrf', csrf)
    form.set('account_id', account.id)
    form.set('audience', JSON.stringify({ mode: 'only', includeTags: ['vip'], includeSources: [], includePhones: [], excludeTags: [], excludePhones: [] }))
    form.set('items', JSON.stringify([{ kind: 'text', text: 'Салам', color: '#0e6b52', font: 1 }]))
    const sent = await fetch(`http://127.0.0.1:${port}/stories/compose`, {
      method: 'POST',
      headers: { cookie: cookie.split(';')[0] ?? '' },
      body: form,
    })
    const body = await sent.json() as { ids?: number[]; error?: string }
    assert.equal(sent.status, 200, body.error)
    const created = db.getPost(body.ids?.[0] ?? 0)
    assert.equal(created?.body, 'Салам')
    assert.equal(created?.font, 1)
    assert.equal(created?.status, 'queued')
    assert.match(created?.audienceSpec ?? '', /"mode":"only"/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    db.close()
  }
})
