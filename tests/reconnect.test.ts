import assert from 'node:assert/strict'
import test from 'node:test'

import { DisconnectReason } from '@whiskeysockets/baileys'

import { planReconnect } from '../src/reconnect.js'

test('коды Baileys совпадают с тем, на что опирается планировщик', () => {
  assert.equal(DisconnectReason.loggedOut, 401)
  assert.equal(DisconnectReason.forbidden, 403)
  assert.equal(DisconnectReason.timedOut, 408)
  assert.equal(DisconnectReason.connectionClosed, 428)
  assert.equal(DisconnectReason.connectionReplaced, 440)
  assert.equal(DisconnectReason.badSession, 500)
  assert.equal(DisconnectReason.restartRequired, 515)
})

test('истечение QR обновляется быстро и не разгоняет паузу до 60 секунд', () => {
  const plan = planReconnect({
    code: DisconnectReason.timedOut,
    showingQr: true,
    wasConnected: false,
    backoffMs: 60_000,
    qrRefreshStrikes: 0,
  })
  assert.equal(plan.action, 'retry')
  assert.equal(plan.reason, 'qr_refresh')
  assert.equal(plan.waitMs, 1000)
  assert.equal(plan.keepQr, true)
  assert.equal(plan.nextBackoffMs, 2000)
  assert.equal(plan.log, 'info')
})

test('после нескольких пустых обновлений QR включается обычная пауза', () => {
  const plan = planReconnect({
    code: DisconnectReason.connectionClosed,
    showingQr: true,
    wasConnected: false,
    backoffMs: 2000,
    qrRefreshStrikes: 6,
  })
  assert.equal(plan.reason, 'network')
  assert.equal(plan.keepQr, false)
  assert.equal(plan.waitMs, 2000)
  assert.ok(plan.nextBackoffMs <= 15_000)
})

test('уже привязанный номер ждёт дольше, свежий вход ограничен 15 секундами', () => {
  const paired = planReconnect({
    code: 428,
    showingQr: false,
    wasConnected: true,
    backoffMs: 32_000,
    qrRefreshStrikes: 0,
  })
  assert.equal(paired.waitMs, 32_000)
  assert.equal(paired.nextBackoffMs, 60_000)

  const pairing = planReconnect({
    code: 428,
    showingQr: false,
    wasConnected: false,
    backoffMs: 32_000,
    qrRefreshStrikes: 0,
  })
  assert.equal(pairing.waitMs, 15_000)
  assert.equal(pairing.nextBackoffMs, 15_000)
})

test('опасные обрывы не переподключаются сами, рестарт после QR быстрый', () => {
  assert.equal(planReconnect({ code: 401, showingQr: true, wasConnected: false, backoffMs: 2000, qrRefreshStrikes: 0 }).action, 'stop')
  assert.equal(planReconnect({ code: 403, showingQr: false, wasConnected: true, backoffMs: 2000, qrRefreshStrikes: 0 }).reason, 'forbidden')
  assert.equal(planReconnect({ code: 440, showingQr: false, wasConnected: true, backoffMs: 2000, qrRefreshStrikes: 0 }).reason, 'replaced')
  const restart = planReconnect({ code: 515, showingQr: true, wasConnected: false, backoffMs: 60_000, qrRefreshStrikes: 3 })
  assert.equal(restart.reason, 'restart')
  assert.equal(restart.waitMs, 500)
  assert.equal(restart.keepQr, false)
})
