import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { MemoryPreview, MemoryRecord } from './model.js'

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function clean(value: string): string {
  return value.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/\s+/g, ' ').trim()
}

/** Parse unstable WorkBuddy memory candidates into reviewable atomic records. */
export async function parseMemoryCandidate(path: string, kind: MemoryPreview['kind']): Promise<MemoryPreview> {
  const raw = await readFile(path, 'utf8')
  const sourceHash = hash(raw)
  const values: string[] = []
  if (kind === 'markdown' || kind === 'unknown') {
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*#+\s+/.test(line)) continue
      const value = clean(line.replace(/^#+\s*/, ''))
      if (value && !value.endsWith(':')) values.push(value)
    }
  } else {
    try {
      const parsed: unknown = kind === 'jsonl'
        ? raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        : JSON.parse(raw)
      const visit = (value: unknown): void => {
        if (typeof value === 'string') { const item = clean(value); if (item) values.push(item); return }
        if (Array.isArray(value)) { value.forEach(visit); return }
        if (typeof value === 'object' && value !== null) {
          const row = value as Record<string, unknown>
          for (const key of ['content', 'text', 'memory', 'fact', 'value', 'summary']) if (row[key] !== undefined) visit(row[key])
        }
      }
      visit(parsed)
    } catch (cause) {
      return { sourcePath: path, sourceHash, kind, records: [], skipped: 1, loss: [{ code: 'memory-parse', detail: cause instanceof Error ? cause.message : String(cause) }] }
    }
  }
  const unique = [...new Map(values.map(value => [value.toLocaleLowerCase(), value])).values()]
  return {
    sourcePath: path,
    sourceHash,
    kind,
    records: unique.map(content => ({ id: hash(`${sourceHash}:${content}`).slice(0, 24), content })),
    skipped: Math.max(0, values.length - unique.length),
    loss: [],
  }
}

export function toMemoryRecords(previews: readonly MemoryPreview[], existing: readonly MemoryRecord[] = []): { records: MemoryRecord[]; skipped: number } {
  const seen = new Set(existing.map(record => record.content.toLocaleLowerCase()))
  const records: MemoryRecord[] = []
  let skipped = 0
  for (const preview of previews) for (const candidate of preview.records) {
    const key = candidate.content.toLocaleLowerCase()
    if (seen.has(key)) { skipped += 1; continue }
    seen.add(key)
    records.push({ id: candidate.id, content: candidate.content, sourcePath: preview.sourcePath, sourceHash: preview.sourceHash, enabled: true, createdAt: new Date().toISOString() })
  }
  return { records, skipped }
}
