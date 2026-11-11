import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareStatusMedia } from '../src/media.js'

test('ffmpeg приводит картинку и видео к формату статуса', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-media-'))
  const png = path.join(dir, 'in.png')
  const mp4 = path.join(dir, 'in.mp4')
  const image = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', png], { encoding: 'utf8' })
  assert.equal(image.status, 0, image.stderr)
  const video = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-shortest', '-t', '1', mp4], { encoding: 'utf8' })
  assert.equal(video.status, 0, video.stderr)
  const jpeg = await prepareStatusMedia({ kind: 'image', sourcePath: png, dataDir: dir, ffmpegPath: 'ffmpeg', maxVideoSeconds: 30 })
  const out = await prepareStatusMedia({ kind: 'video', sourcePath: mp4, dataDir: dir, ffmpegPath: 'ffmpeg', maxVideoSeconds: 30 })
  assert.ok(fs.statSync(jpeg.path).size > 0)
  assert.ok(fs.statSync(out.path).size > 0)
  assert.ok(fs.statSync(jpeg.thumbPath).size > 0)
  assert.ok(jpeg.path.endsWith('.jpg'))
  assert.ok(out.path.endsWith('.mp4'))
})
