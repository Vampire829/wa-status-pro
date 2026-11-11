/** Делит список JID на пачки для statusJidList. Порядок сохраняется, повторы выкидываются. */
export function planBatches(jids: string[], batchSize: number): string[][] {
  const size = Number.isFinite(batchSize) && batchSize >= 1 ? Math.floor(batchSize) : 1
  const unique: string[] = []
  const seen = new Set<string>()
  for (const jid of jids) {
    const trimmed = jid.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    unique.push(trimmed)
  }
  const batches: string[][] = []
  for (let index = 0; index < unique.length; index += size) {
    batches.push(unique.slice(index, index + size))
  }
  return batches
}

export function estimatePublishMs(recipientCount: number, batchSize: number, delayMs: number): number {
  if (recipientCount <= 0) return 0
  const size = Math.max(1, Math.floor(batchSize))
  const batches = Math.ceil(recipientCount / size)
  return Math.max(0, batches - 1) * Math.max(0, delayMs)
}
