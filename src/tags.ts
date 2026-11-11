export function foldText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU')
}

const SKIP_TAGS = new Set(['* mycontacts', 'mycontacts', '* starred', 'starred', '*'])

export function normalizeTagList(tags: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const tag of tags) {
    const pieces = tag.split(/\s:::\s|[,;|]/)
    for (const piece of pieces) {
      const clean = piece.trim().replace(/\s+/g, ' ')
      if (!clean || clean.length > 40) continue
      const fold = foldText(clean)
      if (!fold || SKIP_TAGS.has(fold) || seen.has(fold)) continue
      seen.add(fold)
      out.push(clean)
      if (out.length >= 20) return out
    }
  }
  return out
}

export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}
