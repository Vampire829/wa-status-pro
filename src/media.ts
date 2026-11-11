import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error('ffmpeg не найден. Установите ffmpeg или укажите FFMPEG_PATH.'))
        return
      }
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-400)}`))
    })
  })
}

export async function prepareStatusMedia(opts: {
  kind: 'image' | 'video'
  sourcePath: string
  dataDir: string
  ffmpegPath: string
  maxVideoSeconds: number
}): Promise<string> {
  const dir = path.join(opts.dataDir, 'media')
  fs.mkdirSync(dir, { recursive: true })
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  if (opts.kind === 'image') {
    const output = path.join(dir, `${id}.jpg`)
    await runFfmpeg(opts.ffmpegPath, [
      '-y',
      '-i',
      opts.sourcePath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-q:v',
      '3',
      output,
    ])
    return output
  }
  const output = path.join(dir, `${id}.mp4`)
  await runFfmpeg(opts.ffmpegPath, [
    '-y',
    '-i',
    opts.sourcePath,
    '-t',
    String(opts.maxVideoSeconds),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    "scale='min(720,iw)':-2,fps=30",
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-ar',
    '44100',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    output,
  ])
  return output
}
