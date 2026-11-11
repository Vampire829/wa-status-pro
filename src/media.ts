import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { videoNeedsTranscode, type VideoFacts } from './statusLogic.js'

let ffmpegChain: Promise<void> = Promise.resolve()

function withFfmpegLock<T>(work: () => Promise<T>): Promise<T> {
  const run = ffmpegChain.then(work, work)
  ffmpegChain = run.then(() => undefined, () => undefined)
  return run
}

function runTool(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000)
    })
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
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: stdout || stderr }))
  })
}

async function runFfmpeg(ffmpegPath: string, args: string[], output?: string): Promise<void> {
  const result = await runTool(ffmpegPath, ['-threads', '1', '-hide_banner', ...args])
  if (result.code !== 0) throw new Error(`ffmpeg завершился с кодом ${result.code}: ${result.stderr.slice(-400)}`)
  if (output && (!fs.existsSync(output) || fs.statSync(output).size === 0)) {
    throw new Error(`ffmpeg не записал файл: ${result.stderr.slice(-400)}`)
  }
}

function ffprobeBin(ffmpegPath: string): string {
  if (ffmpegPath.endsWith('ffmpeg')) return `${ffmpegPath.slice(0, -'ffmpeg'.length)}ffprobe`
  return 'ffprobe'
}

export async function probeVideo(ffmpegPath: string, file: string): Promise<VideoFacts | null> {
  try {
    const result = await runTool(ffprobeBin(ffmpegPath), [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
    ])
    if (result.code !== 0) return null
    const parsed = JSON.parse(result.stderr) as {
      streams?: { codec_type?: string; codec_name?: string; profile?: string; pix_fmt?: string; width?: number; height?: number }[]
      format?: { duration?: string; format_name?: string }
    }
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
    if (!video) return null
    return {
      videoCodec: video.codec_name ?? '',
      profile: video.profile ?? '',
      pixFmt: video.pix_fmt ?? '',
      width: video.width ?? 0,
      height: video.height ?? 0,
      duration: Number(parsed.format?.duration ?? 0),
      audioCodec: audio?.codec_name ?? null,
      format: parsed.format?.format_name ?? '',
    }
  } catch {
    return null
  }
}

export type PreparedMedia = {
  path: string
  thumbPath: string
  width: number
  height: number
  skippedTranscode: boolean
}

const BOX = "scale=w='min(720,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"

export async function prepareStatusMedia(opts: {
  kind: 'image' | 'video'
  sourcePath: string
  dataDir: string
  ffmpegPath: string
  maxVideoSeconds: number
}): Promise<PreparedMedia> {
  return withFfmpegLock(() => prepareUnlocked(opts))
}

async function prepareUnlocked(opts: {
  kind: 'image' | 'video'
  sourcePath: string
  dataDir: string
  ffmpegPath: string
  maxVideoSeconds: number
}): Promise<PreparedMedia> {
  const dir = path.join(opts.dataDir, 'media')
  fs.mkdirSync(dir, { recursive: true })
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  if (opts.kind === 'image') {
    const output = path.join(dir, `${id}.jpg`)
    const thumb = path.join(dir, `${id}-thumb.jpg`)
    await runFfmpeg(opts.ffmpegPath, ['-y', '-i', opts.sourcePath, '-frames:v', '1', '-update', '1', '-vf', BOX, '-q:v', '3', output], output)
    await runFfmpeg(opts.ffmpegPath, ['-y', '-i', output, '-frames:v', '1', '-update', '1', '-vf', 'scale=320:-2', '-q:v', '6', thumb], thumb)
    const facts = await probeVideo(opts.ffmpegPath, output)
    return { path: output, thumbPath: thumb, width: facts?.width ?? 0, height: facts?.height ?? 0, skippedTranscode: false }
  }

  const facts = await probeVideo(opts.ffmpegPath, opts.sourcePath)
  const thumb = path.join(dir, `${id}-thumb.jpg`)
  if (facts && !videoNeedsTranscode(facts, opts.maxVideoSeconds)) {
    const output = path.join(dir, `${id}.mp4`)
    await fs.promises.copyFile(opts.sourcePath, output)
    await runFfmpeg(opts.ffmpegPath, ['-y', '-i', output, '-frames:v', '1', '-update', '1', '-vf', 'scale=320:-2', '-q:v', '6', thumb], thumb)
    return { path: output, thumbPath: thumb, width: facts.width, height: facts.height, skippedTranscode: true }
  }
  const output = path.join(dir, `${id}.mp4`)
  await runFfmpeg(opts.ffmpegPath, [
    '-y', '-i', opts.sourcePath, '-t', String(opts.maxVideoSeconds),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `${BOX},fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '5000k',
    '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ], output)
  await runFfmpeg(opts.ffmpegPath, ['-y', '-i', output, '-frames:v', '1', '-update', '1', '-vf', 'scale=320:-2', '-q:v', '6', thumb], thumb)
  const ready = await probeVideo(opts.ffmpegPath, output)
  return { path: output, thumbPath: thumb, width: ready?.width ?? 0, height: ready?.height ?? 0, skippedTranscode: false }
}

export function readJpegThumbnail(thumbPath: string | null | undefined): string | undefined {
  if (!thumbPath || !fs.existsSync(thumbPath)) return undefined
  return fs.readFileSync(thumbPath).toString('base64')
}
