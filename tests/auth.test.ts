import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoginGuard, csrfOk, issueSession, passwordsMatch, verifySession } from '../src/auth.js'

test('сессия подписывается и пароль сравнивается без утечки длины', () => {
  assert.equal(passwordsMatch('секретный-пароль', 'секретный-пароль'), true)
  assert.equal(passwordsMatch('секретный-пароль', 'другой'), false)
  const issued = issueSession('session-secret-value', 60_000, 1_000)
  const ok = verifySession('session-secret-value', issued.token, 1_000)
  assert.equal(ok?.csrf, issued.csrf)
  assert.equal(verifySession('session-secret-value', issued.token, 61_001), null)
  assert.equal(verifySession('other-secret-value-xx', issued.token, 1_000), null)
  assert.equal(csrfOk(issued.csrf, issued.csrf), true)
  assert.equal(csrfOk(issued.csrf, 'нет'), false)
  const guard = createLoginGuard()
  for (let i = 0; i < 5; i += 1) guard.fail('1.1.1.1', 0)
  assert.equal(guard.allowed('1.1.1.1', 0), false)
  assert.equal(guard.allowed('1.1.1.1', 16 * 60 * 1000), true)
})
