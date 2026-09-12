import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { LossRecord } from './model.js'

export interface WorkBuddyAutomationRecord {
  sourceId: string
  name: string
  prompt: string
  status: string
  scheduleType: 'recurring' | 'once' | 'other'
  rrule?: string
  scheduledAt?: string
  nextRunAt?: number
  validFrom?: string
  validUntil?: string
  cwds: string[]
  modelId?: string
}

export interface AutomationDraft {
  sourceId: string
  name: string
  prompt: string
  enabled: boolean
  triggerKind: 'cron' | 'single' | 'unsupported'
  cron?: string
  timezone?: string
  runAt?: string
  targetWorkspacePath?: string
  modelId?: string
  validFrom?: string
  validUntil?: string
  loss: LossRecord[]
  /** Filled by the service against the import manifest. */
  status?: 'new' | 'unchanged'
  eligible?: boolean
}

/** WorkBuddy-internal model aliases that do not exist in the DSH model catalog. */
const WORKBUDDY_MODEL_ALIASES = new Set(['auto', 'fast-model', 'auto-pro', 'pro', 'fast', 'thinking', 'reasoning'])

export interface AutomationModelPolicy {
  /**
   * WorkBuddy model ids the operator knows the DSH deployment serves (usually
   * the deployment's own model catalog). Only these may be carried over
   * verbatim.
   */
  allowlist?: ReadonlySet<string>
  /** Model id every migrated automation is pinned to; empty keeps the default. */
  fallbackModelId?: string
}

export interface AutomationModelResolution {
  /** Model id written into the rule; absent means "deployment default". */
  model?: string
  /** WorkBuddy model id that was replaced or dropped (for the loss report). */
  mappedFrom?: string
}

/**
 * Resolve a WorkBuddy model id for the DSH automation rule.
 *
 * WorkBuddy's model vocabulary (`auto`, `fast-model`, `glm-*`, `hy3`, `kimi-*`,
 * …) does not overlap with a typical deployment's model catalog, so passing an
 * id through verbatim makes the migrated rule fail at run time with an unknown
 * model. Only ids the operator explicitly allows may pass; everything else is
 * replaced by the configured fallback or dropped so the deployment default
 * model is used.
 */
export function resolveAutomationModel(
  modelId: string | undefined,
  policy: AutomationModelPolicy = {},
): AutomationModelResolution {
  if (modelId === undefined) return {}
  const id = modelId.trim()
  if (id === '') return {}
  if (policy.allowlist?.has(id) === true) return { model: id }
  const fallback = policy.fallbackModelId?.trim()
  return fallback !== undefined && fallback !== '' && fallback !== id
    ? { model: fallback, mappedFrom: id }
    : { mappedFrom: id }
}

/** Whether the id is a WorkBuddy alias rather than a vendor model id. */
export function isWorkBuddyModelAlias(modelId: string): boolean {
  return WORKBUDDY_MODEL_ALIASES.has(modelId.toLowerCase())
}

/**
 * Convert the supported RRULE subset to a 5-segment cron expression.
 * Returns undefined (with a loss message) for unsupported rules.
 */
export function rruleToCron(rrule: string, timezone = 'Asia/Shanghai'): { cron: string; timezone: string } | { loss: string } {
  const parts = new Map<string, string>()
  for (const piece of rrule.split(';')) {
    const separator = piece.indexOf('=')
    if (separator <= 0) continue
    parts.set(piece.slice(0, separator).toUpperCase(), piece.slice(separator + 1))
  }
  const freq = parts.get('FREQ')
  const minute = parts.get('BYMINUTE') ?? '0'
  const hour = parts.get('BYHOUR') ?? '0'
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return { loss: `rrule unsupported time fields (${rrule})` }
  const minutes = minute.padStart(2, '0')
  const hours = hour.padStart(2, '0')
  if (freq === 'DAILY') return { cron: `${minutes} ${hours} * * *`, timezone }
  if (freq === 'WEEKLY') {
    const days = (parts.get('BYDAY') ?? '')
    const dayNumbers = new Map<string, number>([['MO', 1], ['TU', 2], ['WE', 3], ['TH', 4], ['FR', 5], ['SA', 6], ['SU', 7]])
    const values = days.split(/[\s,]+/).filter(Boolean).map(value => {
      const upper = value.toUpperCase()
      if (dayNumbers.has(upper)) return dayNumbers.get(upper) as number
      if (/^\d{1,2}$/.test(value)) return Number(value)
      return NaN
    })
    if (values.length === 0 || values.some(value => !Number.isInteger(value) || value < 1 || value > 7)) return { loss: `rrule unsupported BYDAY (${rrule})` }
    const weekdays = [...new Set(values.map(value => (value % 7).toString()))].sort((a, b) => Number(a) - Number(b)).join(',')
    return { cron: `${minutes} ${hours} * * ${weekdays}`, timezone }
  }
  if (freq === 'MONTHLY') {
    const day = parts.get('BYMONTHDAY')
    if (day === undefined || !/^\d{1,2}$/.test(day)) return { loss: `rrule unsupported BYMONTHDAY (${rrule})` }
    return { cron: `${minutes} ${hours} ${Number(day)} * *`, timezone }
  }
  return { loss: `rrule unsupported FREQ (${rrule})` }
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function stringArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * Read the local WorkBuddy automation catalog without making it a hard
 * dependency of migration; a missing database or schema change returns [].
 */
export function readWorkBuddyAutomations(root: string): WorkBuddyAutomationRecord[] {
  const path = join(root, 'workbuddy.db')
  if (!existsSync(path)) return []
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const rows = db.prepare('SELECT id, name, prompt, status, schedule_type, rrule, scheduled_at, next_run_at, valid_from, valid_until, cwds, model_id FROM automations WHERE deleted_at IS NULL').all() as Array<Record<string, unknown>>
    const result: WorkBuddyAutomationRecord[] = []
    for (const row of rows) {
      const id = text(row.id)
      if (id === undefined) continue
      const scheduleTypeValue = text(row.schedule_type) === 'once' ? 'once' : text(row.schedule_type) === 'recurring' ? 'recurring' : 'other'
      const rrule = text(row.rrule)
      const scheduledAt = text(row.scheduled_at)
      const validFrom = text(row.valid_from)
      const validUntil = text(row.valid_until)
      const modelId = text(row.model_id)
      result.push({
        sourceId: id,
        name: text(row.name) ?? `automation-${id}`,
        prompt: text(row.prompt) ?? '',
        status: text(row.status) ?? 'unknown',
        scheduleType: scheduleTypeValue,
        ...(rrule ? { rrule } : {}),
        ...(scheduledAt ? { scheduledAt } : {}),
        ...(typeof row.next_run_at === 'number' ? { nextRunAt: row.next_run_at } : {}),
        ...(validFrom ? { validFrom } : {}),
        ...(validUntil ? { validUntil } : {}),
        cwds: stringArray(row.cwds),
        ...(modelId ? { modelId } : {}),
      })
    }
    return result
  } catch {
    return []
  } finally {
    try { db?.close() } catch { /* best effort */ }
  }
}

function isoFromEpoch(value?: number): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : new Date(value).toISOString()
}

/** Map one WorkBuddy automation record into an importable DSH draft. */
export function toAutomationDraft(record: WorkBuddyAutomationRecord): AutomationDraft {
  const loss: LossRecord[] = []
  const enabled = record.status === 'ACTIVE'
  if (!enabled) loss.push({ code: 'automation-inactive', detail: `status ${record.status}` })
  let triggerKind: AutomationDraft['triggerKind'] = 'unsupported'
  let cron: string | undefined
  let runAt: string | undefined
  if (record.scheduleType === 'recurring' && record.rrule) {
    const converted = rruleToCron(record.rrule)
    if ('cron' in converted) { triggerKind = 'cron'; cron = converted.cron }
    else loss.push({ code: 'rrule-unsupported', detail: converted.loss })
  } else if (record.scheduleType === 'once') {
    const at = isoFromEpoch(record.nextRunAt) ?? record.scheduledAt
    if (at !== undefined) { triggerKind = 'single'; runAt = at }
    else loss.push({ code: 'automation-missing-run-at', detail: `${record.sourceId}` })
  } else {
    loss.push({ code: 'automation-unsupported-schedule', detail: record.scheduleType })
  }
  return {
    sourceId: record.sourceId,
    name: record.name,
    prompt: record.prompt,
    enabled,
    triggerKind,
    ...(cron === undefined ? {} : { cron }),
    ...(triggerKind === 'cron' ? { timezone: 'Asia/Shanghai' } : {}),
    ...(runAt === undefined ? {} : { runAt }),
    ...(record.cwds[0] ? { targetWorkspacePath: record.cwds[0] } : {}),
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(record.validFrom ? { validFrom: record.validFrom } : {}),
    ...(record.validUntil ? { validUntil: record.validUntil } : {}),
    loss,
  }
}
