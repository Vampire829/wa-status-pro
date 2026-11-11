import assert from 'node:assert/strict'
import test from 'node:test'

import { openDatabase } from '../src/db.js'
import {
  cooldownRemainingMs,
  normalizeOwnJid,
  videoNeedsTranscode,
  viewFromReceipt,
  withOwnJid,
} from '../src/statusLogic.js'

test('свой JID нормализуется и попадает в каждую пачку', () => {
  assert.equal(normalizeOwnJid('79990000000:17@s.whatsapp.net'), '79990000000@s.whatsapp.net')
  assert.equal(normalizeOwnJid('status@broadcast'), null)
  const batches = withOwnJid([['79280000001@s.whatsapp.net'], ['79990000000@s.whatsapp.net']], '79990000000@s.whatsapp.net')
  assert.deepEqual(batches[0], ['79990000000@s.whatsapp.net', '79280000001@s.whatsapp.net'])
  assert.deepEqual(batches[1], ['79990000000@s.whatsapp.net'])
})

test('пауза между публикациями и годность видео', () => {
  const now = Date.parse('2026-01-01T00:00:20.000Z')
  assert.equal(cooldownRemainingMs('2026-01-01T00:00:00.000Z', 30_000, now), 10_000)
  assert.equal(cooldownRemainingMs('2026-01-01T00:00:00.000Z', 0, now), 0)
  assert.equal(videoNeedsTranscode({
    videoCodec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 720, height: 1280,
    duration: 10, audioCodec: 'aac', format: 'mov,mp4',
  }, 30), false)
  assert.equal(videoNeedsTranscode({
    videoCodec: 'h264', profile: 'Main', pixFmt: 'yuv420p', width: 720, height: 1280,
    duration: 10, audioCodec: 'aac', format: 'mp4',
  }, 30), true)
})

test('просмотр считается только по квитанции read/played статуса', () => {
  assert.equal(viewFromReceipt({ remoteJid: '7999@s.whatsapp.net', messageId: 'abc', userJid: '79280000001@s.whatsapp.net', readTimestamp: 10 }), null)
  const view = viewFromReceipt({
    remoteJid: 'status@broadcast',
    messageId: 'abc',
    userJid: '79280000001:2@s.whatsapp.net',
    readTimestamp: 1_700_000_000,
  })
  assert.equal(view?.viewerJid, '79280000001@s.whatsapp.net')
  assert.equal(view?.messageId, 'abc')
  assert.equal(viewFromReceipt({ remoteJid: 'status@broadcast', messageId: 'abc', userJid: '79280000001@s.whatsapp.net' }), null)
})

test('просмотр пишется один раз и находится по id сообщения', () => {
  const db = openDatabase(':memory:')
  const account = db.createAccount('Тест')
  db.applyMerge([{ phone: '79280000001', name: 'Аминат', nameRank: 3, tags: ['vip'], sources: ['phone'] }])
  const post = db.createPost({
    accountId: account.id, kind: 'text', body: 'привет', caption: '', mediaPath: null, originalName: null,
    backgroundColor: '#111111', font: 0, audienceSource: 'any', audienceTag: null, scheduledAt: null, status: 'done',
  })
  db.insertBatches(post.id, [['79990000000@s.whatsapp.net', '79280000001@s.whatsapp.net']], '79990000000@s.whatsapp.net')
  const batch = db.listBatches(post.id)[0]
  assert.ok(batch)
  db.markBatch(batch.id, { status: 'sent', waMessageId: 'MSG1' })
  assert.equal(db.findPostByMessage('MSG1'), post.id)
  assert.equal(db.recordStatusView({ postId: post.id, viewerJid: '79280000001@s.whatsapp.net', phone: '79280000001', name: 'Аминат', viewedAt: '2026-01-01T00:00:00.000Z' }), true)
  assert.equal(db.recordStatusView({ postId: post.id, viewerJid: '79280000001@s.whatsapp.net', phone: '79280000001', name: 'Аминат', viewedAt: '2026-01-01T00:01:00.000Z' }), false)
  const views = db.listViews(post.id, { q: 'аминат', tag: 'vip', source: 'phone', limit: 10, offset: 0 })
  assert.equal(views.total, 1)
  assert.equal(views.items[0]?.name, 'Аминат')
  db.updatePost(post.id, { status: 'failed', finishedAt: '2026-01-01T00:00:00.000Z', error: 'сбой' })
  db.resetFailedBatches(post.id)
  db.updatePost(post.id, { status: 'queued', finishedAt: null, error: null, notBefore: null })
  assert.equal(db.getPost(post.id)?.status, 'queued')
  db.close()
})
