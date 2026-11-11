import assert from 'node:assert/strict'
import test from 'node:test'

import { estimatePublishMs, planBatches } from '../src/batch.js'

test('делит аудиторию на пачки и убирает повторы', () => {
  const jids = ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'a@s.whatsapp.net', '  ', 'c@s.whatsapp.net', 'd@s.whatsapp.net', 'e@s.whatsapp.net']
  const batches = planBatches(jids, 2)
  assert.deepEqual(batches, [
    ['a@s.whatsapp.net', 'b@s.whatsapp.net'],
    ['c@s.whatsapp.net', 'd@s.whatsapp.net'],
    ['e@s.whatsapp.net'],
  ])
  assert.deepEqual(planBatches(['one@s.whatsapp.net'], 100), [['one@s.whatsapp.net']])
  assert.deepEqual(planBatches([], 10), [])
  assert.equal(planBatches(['x@s.whatsapp.net', 'y@s.whatsapp.net'], 0).length, 2)
  assert.equal(estimatePublishMs(250, 100, 4000), 8000)
  assert.equal(estimatePublishMs(0, 100, 4000), 0)
})
