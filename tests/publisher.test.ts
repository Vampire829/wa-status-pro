import assert from 'node:assert/strict'
import test from 'node:test'

import { openDatabase } from '../src/db.js'
import { WaSendError } from '../src/errors.js'
import { publishOnce } from '../src/publisher.js'
import type { ContactDraft } from '../src/types.js'

function seed(phones: ContactDraft[]) {
  const db = openDatabase(':memory:')
  const account = db.createAccount('Тест')
  db.updateAccount(account.id, { status: 'connected', phone: '79990000000' })
  db.applyMerge(phones)
  return { db, account }
}

test('публикация режется на пачки и уважает источник с меткой', async () => {
  const { db, account } = seed([
    { phone: '79280000001', name: 'А', nameRank: 3, tags: ['vip'], sources: ['whatsapp'] },
    { phone: '79280000002', name: 'Б', nameRank: 3, tags: ['vip'], sources: ['whatsapp'] },
    { phone: '79280000003', name: 'В', nameRank: 3, tags: ['vip'], sources: ['phone'] },
    { phone: '79280000004', name: 'Г', nameRank: 3, tags: ['город'], sources: ['whatsapp'] },
    { phone: '79280000005', name: 'Д', nameRank: 3, tags: ['vip'], sources: ['whatsapp'] },
  ])
  const calls: string[][] = []
  const post = db.createPost({
    accountId: account.id,
    kind: 'text',
    body: 'привет',
    caption: '',
    mediaPath: null,
    originalName: null,
    backgroundColor: '#0E6B52',
    font: 0,
    audienceSource: 'whatsapp',
    audienceTag: 'vip',
    scheduledAt: null,
    status: 'queued',
  })
  await publishOnce({
    db,
    wa: {
      isReady: () => true,
      isBlocked: () => false,
      ownJid: () => '79990000000@s.whatsapp.net',
      async deleteStatus() { return undefined },
      async sendStatus(_id, content, jids) {
        assert.equal(content.kind, 'text')
        calls.push(jids)
        if (calls.length === 2) throw new Error('временный сбой')
        return { messageId: `m${calls.length}` }
      },
    },
    batchSize: 2,
    batchDelayMs: 0,
    minPublishIntervalMs: 0,
    sleep: async () => undefined,
  })
  const saved = db.getPost(post.id)
  assert.equal(saved?.status, 'done')
  assert.equal(saved?.totalRecipients, 3)
  assert.equal(saved?.successRecipients, 3)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], ['79990000000@s.whatsapp.net', '79280000001@s.whatsapp.net', '79280000002@s.whatsapp.net'])
  db.close()
})

test('обрыв связи возвращает публикацию в очередь, не помечая пачку отправленной', async () => {
  const { db, account } = seed([
    { phone: '79280000001', name: 'А', nameRank: 1, tags: [], sources: ['phone'] },
  ])
  const post = db.createPost({
    accountId: account.id,
    kind: 'text',
    body: 'ещё раз',
    caption: '',
    mediaPath: null,
    originalName: null,
    backgroundColor: null,
    font: 0,
    audienceSource: 'phone',
    audienceTag: null,
    scheduledAt: null,
    status: 'queued',
  })
  await publishOnce({
    db,
    wa: {
      isReady: () => true,
      isBlocked: () => false,
      ownJid: () => '79990000000@s.whatsapp.net',
      async deleteStatus() { return undefined },
      async sendStatus() {
        throw new WaSendError('Номер не подключён', { pause: true })
      },
    },
    batchSize: 10,
    batchDelayMs: 0,
    minPublishIntervalMs: 0,
    sleep: async () => undefined,
  })
  const saved = db.getPost(post.id)
  assert.equal(saved?.status, 'queued')
  assert.equal(db.listBatches(post.id)[0]?.status, 'pending')
  db.close()
})
