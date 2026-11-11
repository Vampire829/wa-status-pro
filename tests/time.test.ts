import assert from 'node:assert/strict'
import test from 'node:test'

import { formatMoscow, moscowLocalToUtcIso } from '../src/time.js'

test('московское время переводится в UTC', () => {
  assert.equal(moscowLocalToUtcIso('2026-01-01T00:30'), '2025-12-31T21:30:00.000Z')
  assert.equal(moscowLocalToUtcIso('2026-06-15T15:45:10'), '2026-06-15T12:45:10.000Z')
  assert.equal(moscowLocalToUtcIso('2026-02-29T12:00'), null)
  assert.equal(moscowLocalToUtcIso('вчера'), null)
  assert.match(formatMoscow('2026-01-01T00:30:00.000Z'), /01\.01\.2026/)
  assert.match(formatMoscow('2026-01-01T00:30:00.000Z'), /03:30/)
})
