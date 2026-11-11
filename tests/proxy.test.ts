import assert from 'node:assert/strict'
import test from 'node:test'

import { parseProxyUrl, readProxyEnv, redactProxyMessage } from '../src/proxy.js'

test('разбирает http, https, socks5 и socks5h', () => {
  assert.deepEqual(parseProxyUrl('http://10.0.0.8:8080'), {
    scheme: 'http',
    hostname: '10.0.0.8',
    port: 8080,
    username: undefined,
    password: undefined,
    redacted: 'http://10.0.0.8:8080',
  })
  assert.equal(parseProxyUrl('https://proxy.example').port, 443)
  assert.equal(parseProxyUrl('https://proxy.example').redacted, 'https://proxy.example:443')
  assert.equal(parseProxyUrl('socks5://127.0.0.1').port, 1080)
  const remoteDns = parseProxyUrl('socks5h://[2001:db8::1]:1080')
  assert.equal(remoteDns.scheme, 'socks5h')
  assert.equal(remoteDns.hostname, '2001:db8::1')
  assert.equal(remoteDns.redacted, 'socks5h://[2001:db8::1]:1080')
})

test('декодирует логин и пароль и не показывает их в адресе для журнала', () => {
  const parsed = parseProxyUrl('socks5h://user%3Aname:p%40ss%3Aword@edge.example:9050')
  assert.equal(parsed.username, 'user:name')
  assert.equal(parsed.password, 'p@ss:word')
  assert.equal(parsed.redacted, 'socks5h://edge.example:9050')
  assert.equal(parsed.redacted.includes('p@ss'), false)
  assert.equal(parsed.redacted.includes('user'), false)
  assert.equal(readProxyEnv('   ') , null)
  assert.equal(readProxyEnv(undefined), null)
  assert.equal(readProxyEnv(' http://10.1.1.1:3128 ')?.config.hostname, '10.1.1.1')
})

test('отклоняет чужие схемы и адрес с путём', () => {
  assert.throws(() => parseProxyUrl('ftp://files.example'), /http:\/\//)
  assert.throws(() => parseProxyUrl('socks4://10.0.0.1:1080'), /socks5h/)
  assert.throws(() => parseProxyUrl('http://10.0.0.1:8080/secret'), /путь/)
  assert.throws(() => parseProxyUrl('not a url'), /не похож/)
  assert.throws(() => parseProxyUrl('http://:8080'), /не похож/)
})

test('вычищает логин из текста ошибки', () => {
  const text = redactProxyMessage('connect failed via socks5h://user%3Aname:p%40ss@edge.example:9050')
  assert.match(text, /socks5h:\/\/\*\*\*@edge\.example:9050/)
  assert.equal(text.includes('p%40ss'), false)
})
