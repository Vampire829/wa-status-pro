import assert from 'node:assert/strict'
import test from 'node:test'

import { openDatabase } from '../src/db.js'
import {
  cooldownRemainingMs,
  escapeDrawtext,
  matchAudience,
  normalizeOwnJid,
  planVideoSegments,
  statusDeleteKey,
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

test('аудитория как в WhatsApp и нарезка длинного видео', () => {
  const contacts = [
    { phone: '79280000001', tags: ['vip'], sources: ['phone'] as Array<'whatsapp' | 'phone'> },
    { phone: '79280000002', tags: ['город'], sources: ['whatsapp'] as Array<'whatsapp' | 'phone'> },
    { phone: '79280000003', tags: ['vip'], sources: ['whatsapp', 'phone'] as Array<'whatsapp' | 'phone'> },
  ]
  const all = contacts.filter((contact) => matchAudience(contact, { mode: 'all', excludeTags: [], excludePhones: [], includeTags: [], includeSources: [], includePhones: [] }))
  assert.equal(all.length, 3)
  const except = contacts.filter((contact) => matchAudience(contact, { mode: 'exclude', excludeTags: ['vip'], excludePhones: [], includeTags: [], includeSources: [], includePhones: [] }))
  assert.deepEqual(except.map((contact) => contact.phone), ['79280000002'])
  const only = contacts.filter((contact) => matchAudience(contact, { mode: 'only', excludeTags: [], excludePhones: [], includeTags: [], includeSources: ['whatsapp'], includePhones: ['79280000001'] }))
  assert.deepEqual(only.map((contact) => contact.phone), ['79280000001', '79280000002', '79280000003'])
  assert.deepEqual(planVideoSegments(75, 30).map((part) => part.end), [30, 60, 75])
  assert.equal(planVideoSegments(12, 30).length, 1)
  assert.equal(escapeDrawtext("10:00 it's 100%"), "10\\:00 it\\'s 100\\%")
})

test('удаление прячет статус, сохраняет просмотры и помечает пачки к отзыву', () => {
  const db = openDatabase(':memory:')
  const account = db.createAccount('Тест')
  const post = db.createPost({
    accountId: account.id, kind: 'text', body: 'привет', caption: '', mediaPath: '/data/media/a.jpg', originalName: null,
    backgroundColor: '#111111', font: 0, audienceSource: 'any', audienceTag: null, scheduledAt: null, status: 'done',
  })
  db.insertBatches(post.id, [['79990000000@s.whatsapp.net', '79280000001@s.whatsapp.net']], '79990000000@s.whatsapp.net')
  const batch = db.listBatches(post.id)[0]
  assert.ok(batch)
  db.markBatch(batch.id, { status: 'sent', waMessageId: 'MSG9' })
  db.recordStatusView({ postId: post.id, viewerJid: '79280000001@s.whatsapp.net', phone: '79280000001', name: 'Аминат', viewedAt: '2026-01-01T00:00:00.000Z' })
  assert.equal(db.requestDelete(post.id, '2026-01-02T00:00:00.000Z'), 'ok')
  assert.equal(db.listPosts(10, false).some((item) => item.id === post.id), false)
  assert.equal(db.listViews(post.id, { q: '', tag: '', source: 'all', limit: 10, offset: 0 }).total, 1)
  assert.equal(db.pendingRevokes(post.id)[0]?.waMessageId, 'MSG9')
  db.markRevoke(batch.id, 'failed', 'сеть')
  assert.equal(db.retryRevoke(post.id), true)
  assert.equal(db.pendingRevokes(post.id).length, 1)
  assert.deepEqual(statusDeleteKey('MSG9'), { remoteJid: 'status@broadcast', fromMe: true, id: 'MSG9' })
  db.close()
})

test('спецификация аудитории выбирает телефоны из базы', () => {
  const db = openDatabase(':memory:')
  db.applyMerge([
    { phone: '79280000001', name: 'Аминат', nameRank: 3, tags: ['vip'], sources: ['phone'] },
    { phone: '79280000002', name: 'Ислам', nameRank: 3, tags: ['город'], sources: ['whatsapp'] },
  ])
  const all = db.phonesForSpec({ mode: 'all', excludeTags: [], excludePhones: [], includeTags: [], includeSources: [], includePhones: [] })
  assert.deepEqual(all, ['79280000001', '79280000002'])
  const only = db.phonesForSpec({ mode: 'only', excludeTags: [], excludePhones: [], includeTags: ['vip'], includeSources: [], includePhones: [] })
  assert.deepEqual(only, ['79280000001'])
  const except = db.phonesForSpec({ mode: 'exclude', excludeTags: [], excludePhones: ['79280000001'], includeTags: [], includeSources: [], includePhones: [] })
  assert.deepEqual(except, ['79280000002'])
  db.close()
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
