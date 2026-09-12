import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { McpDraft } from './model.js'

const SECRET_KEYS = /token|secret|password|api[-_]?key|authorization|cookie|oauth|credential|private[-_]?key|bearer/i
const SERVER_CONTAINERS = new Set(['mcpservers', 'servers', 'connectors', 'mcp'])
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Parse the JSONC emitted by WorkBuddy without evaluating or interpolating it. */
function parseJsonc(text: string): unknown {
  let output = ''
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    const next = text[index + 1]
    if (quoted) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; output += char; continue }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      output += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    output += char
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, '$1')) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeServer(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return ['url', 'command', 'args', 'transport', 'type'].some(key => key in value)
}

interface Candidate { name?: string; value: Record<string, unknown> }

function collectCandidates(value: unknown, depth = 0): Candidate[] {
  if (depth > 5 || value === null || value === undefined) return []
  if (Array.isArray(value)) {
    return value.flatMap(item => isRecord(item) && looksLikeServer(item) ? [{ value: item }] : collectCandidates(item, depth + 1))
  }
  if (!isRecord(value)) return []
  if (looksLikeServer(value) && !Object.keys(value).some(key => SERVER_CONTAINERS.has(key.toLowerCase()))) return [{ value }]
  const candidates: Candidate[] = []
  for (const [key, child] of Object.entries(value)) {
    if (SERVER_CONTAINERS.has(key.toLowerCase())) {
      if (Array.isArray(child)) {
        for (const item of child) if (isRecord(item) && looksLikeServer(item)) candidates.push({ value: item })
      } else if (isRecord(child)) {
        if (looksLikeServer(child)) candidates.push({ value: child })
        else for (const [name, item] of Object.entries(child)) if (isRecord(item) && looksLikeServer(item)) candidates.push({ name, value: item })
      }
    } else if (depth < 3 && isRecord(child)) candidates.push(...collectCandidates(child, depth + 1))
  }
  return candidates
}

function sanitizeUrl(value: string): { value?: string; secret: boolean } {
  try {
    const parsed = new URL(value)
    let secret = false
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_KEYS.test(key)) { parsed.searchParams.delete(key); secret = true }
    }
    if (parsed.username || parsed.password) { parsed.username = ''; parsed.password = ''; secret = true }
    return { value: parsed.toString(), secret }
  } catch {
    return SECRET_KEYS.test(value) ? { secret: true } : { value, secret: false }
  }
}

/** Extract only non-sensitive connector fields; secrets are reported, never copied. */
export async function sanitizeMcpConfig(path: string): Promise<{ drafts: McpDraft[]; skippedSecrets: string[] }> {
  let parsed: unknown
  try { parsed = parseJsonc(await readFile(path, 'utf8')) } catch { return { drafts: [], skippedSecrets: ['invalid-json'] } }
  const drafts: McpDraft[] = []
  const skippedSecrets: string[] = []
  for (const candidate of collectCandidates(parsed)) {
    const row = candidate.value
    // Profile files contain a large disabled catalog mirror. It is not a
    // user's configured MCP and should not inflate the migration preview.
    if (row.disabled === true) continue
    const name = typeof row.name === 'string' && row.name.trim() ? row.name : candidate.name ?? `connector-${drafts.length + 1}`
    const localSecrets: string[] = []
    const safe: Partial<McpDraft> = { name, sourcePath: path, skippedSecrets: localSecrets }
    for (const [key, value] of Object.entries(row)) {
      if (SECRET_KEYS.test(key) || key === 'headers' || key === 'env' || key === 'staticHeaders' || key === 'staticEnv') {
        localSecrets.push(`${name}.${key}`)
        continue
      }
      if (key === 'url' && typeof value === 'string') {
        const result = sanitizeUrl(value)
        if (result.value) safe.url = result.value
        if (result.secret) localSecrets.push(`${name}.url`)
      } else if ((key === 'transport' || key === 'type' || key === 'command') && typeof value === 'string') {
        if (key === 'type') safe.transport ??= value
        else safe[key] = value
      } else if (key === 'args' && Array.isArray(value)) {
        safe.args = value.filter(item => {
          if (typeof item !== 'string') return false
          if (SECRET_KEYS.test(item)) { localSecrets.push(`${name}.args`); return false }
          return true
        })
      }
    }
    if (safe.url || safe.command) {
      safe.id = `mcp-${hash([name, safe.url ?? '', safe.transport ?? '', safe.command ?? '', ...(safe.args ?? [])].join('\u0000')).slice(0, 24)}`
      drafts.push(safe as McpDraft)
      skippedSecrets.push(...localSecrets)
    }
  }
  return { drafts, skippedSecrets }
}
