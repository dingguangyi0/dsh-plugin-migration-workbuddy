import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { resolveAutomationModel, rruleToCron, toAutomationDraft } from '../src/automation.js'
import { MigrationService } from '../src/service.js'

describe('automation conversion', () => {
  it('converts supported RRULE subsets to cron', () => {
    expect(rruleToCron('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')).toEqual({ cron: '30 08 * * *', timezone: 'Asia/Shanghai' })
    expect(rruleToCron('FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0')).toMatchObject({ cron: '00 09 * * 1,3' })
    expect(rruleToCron('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0')).toMatchObject({ cron: '00 00 1 * *' })
  })

  it('degrades unsupported RRULE expressions with a loss', () => {
    expect('loss' in rruleToCron('FREQ=YEARLY')).toBe(true)
    expect('loss' in rruleToCron('FREQ=WEEKLY;BYDAY=1MO')).toBe(true)
    expect('loss' in rruleToCron('FREQ=DAILY;INTERVAL=2')).toBe(false) // interval still yields a daily cron
  })

  it('maps a recurring record into a cron draft', () => {
    const draft = toAutomationDraft({
      sourceId: 'a1', name: '每日单词', prompt: '背 5 个单词', status: 'ACTIVE',
      scheduleType: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30', cwds: ['/wb/work'],
    })
    expect(draft.triggerKind).toBe('cron')
    expect(draft.cron).toBe('30 08 * * *')
    expect(draft.targetWorkspacePath).toBe('/wb/work')
    expect(draft.enabled).toBe(true)
  })

  it('drops WorkBuddy model ids a deployment does not serve', () => {
    // Aliases and foreign vendor ids are not valid on the deployment's model
    // catalog: the rule must fall back to the default instead of carrying them
    // over.
    expect(resolveAutomationModel('auto')).toEqual({ mappedFrom: 'auto' })
    expect(resolveAutomationModel('fast-model')).toEqual({ mappedFrom: 'fast-model' })
    expect(resolveAutomationModel('glm-5v-turbo')).toEqual({ mappedFrom: 'glm-5v-turbo' })
    expect(resolveAutomationModel(undefined)).toEqual({})
    expect(resolveAutomationModel('  ')).toEqual({})
  })

  it('keeps only allowlisted model ids and can pin a fallback model', () => {
    const allowlist = new Set(['deepseek-v4-pro'])
    expect(resolveAutomationModel('deepseek-v4-pro', { allowlist })).toEqual({ model: 'deepseek-v4-pro' })
    expect(resolveAutomationModel('auto', { allowlist, fallbackModelId: 'deepseek-v4-flash' }))
      .toEqual({ model: 'deepseek-v4-flash', mappedFrom: 'auto' })
    expect(resolveAutomationModel('auto', { fallbackModelId: 'auto' })).toEqual({ mappedFrom: 'auto' })
  })

  it('maps an inactive or once record with loss notes', () => {
    const inactive = toAutomationDraft({ sourceId: 'b1', name: 'x', prompt: 'p', status: 'PAUSED', scheduleType: 'once', nextRunAt: 0, cwds: [] })
    expect(inactive.enabled).toBe(false)
    expect(inactive.loss.some(item => item.code === 'automation-inactive')).toBe(true)
    const unscheduled = toAutomationDraft({ sourceId: 'c1', name: 'x', prompt: 'p', status: 'ACTIVE', scheduleType: 'once', cwds: [] })
    expect(unscheduled.triggerKind).toBe('unsupported')
  })
})

describe('MigrationService automation import', () => {
  it('previews and imports WorkBuddy automations through the save channel', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-auto-source-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-auto-target-'))
    // WorkBuddy automations run inside a workspace directory; a deleted
    // workspace (directory gone) must not be recreated.
    const workspace = await mkdtemp(join(tmpdir(), 'mwb-auto-work-'))
    const db = new DatabaseSync(join(sourceRoot, 'workbuddy.db'))
    db.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, schedule_type TEXT NOT NULL DEFAULT 'recurring', next_run_at INTEGER, rrule TEXT NOT NULL DEFAULT '', scheduled_at TEXT, valid_from TEXT, valid_until TEXT, cwds TEXT NOT NULL DEFAULT '[]', model_id TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)`)
    db.prepare('INSERT INTO automations (id, name, prompt, status, schedule_type, rrule, cwds, model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('automation-1', '每日单词', '背 5 个英语单词', 'ACTIVE', 'recurring', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30', JSON.stringify([workspace]), 'fast-model')
    db.prepare('INSERT INTO automations (id, name, prompt, status, schedule_type, rrule, cwds) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('automation-missing-workspace', '已删工作区', 'p', 'ACTIVE', 'recurring', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '["/wb/deleted-workspace"]')
    db.prepare('INSERT INTO automations (id, name, prompt, status, schedule_type, cwds) VALUES (?, ?, ?, ?, ?, ?)')
      .run('automation-2', '未支持', 'p', 'ACTIVE', 'custom', '[]')
    db.prepare('INSERT INTO automations (id, name, prompt, status, schedule_type, cwds, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('automation-deleted', '已删除', 'p', 'ACTIVE', 'recurring', '[]', 1787758794032)
    db.close()

    const created: string[] = []
    const saved: unknown[] = []
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService({
        create: async (header: { id: string }) => { created.push(header.id) },
        append: async () => undefined,
      } as never, undefined, {
        sourceRoot,
        saveAutomationRule: async rule => { saved.push(rule) },
      })
      const preview = await service.preview()
      expect(preview.summary.automations).toBe(3)
      expect(preview.summary.automationEligible).toBe(3)
      expect(preview.automations.some(item => item.sourceId === 'automation-deleted')).toBe(false)
      const result = await service.migrate({ sessions: false, memories: false, mcp: false, automations: true })
      // The automation whose workspace directory is gone is skipped, not
      // resurrected (its loss record names the missing path).
      expect(result.importedAutomations).toBe(1)
      expect(result.skippedAutomations).toBe(2)
      expect(result.loss.some(item => item.code === 'automation-workspace-missing')).toBe(true)
      expect(saved).toHaveLength(1)
      const rule = saved[0] as { id: string; name: string; trigger: { kind: string; cron: string }; action: { prompt: string; model?: string }; target: { mode: string; workspaceId?: string } }
      expect(rule.id).toBe('workbuddy-automation-1')
      expect(rule.trigger).toMatchObject({ kind: 'cron', cron: '30 08 * * *' })
      expect(rule.action.prompt).toBe('背 5 个英语单词')
      // WorkBuddy's `fast-model` is not a model this deployment serves: it must
      // not be carried over (the deployment default model is used instead).
      expect(rule.action.model).toBeUndefined()
      expect(result.loss.some(item => item.code === 'automation-model-remapped')).toBe(true)
      // The automation contract target is `mode`, not `kind`.
      expect(rule.target.mode).toBe('new-session')
      const second = await service.migrate({ sessions: false, memories: false, mcp: false, automations: true })
      expect(second.importedAutomations).toBe(0)
      // Second pass: the imported rule is unchanged, the unsupported one and
      // the deleted-workspace one are skipped again.
      expect(second.skippedAutomations).toBe(3)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('keeps automation drafts visible but unimportable without a rule-import channel', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-auto-nochannel-source-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-auto-nochannel-target-'))
    const workspace = await mkdtemp(join(tmpdir(), 'mwb-auto-nochannel-work-'))
    const db = new DatabaseSync(join(sourceRoot, 'workbuddy.db'))
    db.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, schedule_type TEXT NOT NULL DEFAULT 'recurring', next_run_at INTEGER, rrule TEXT NOT NULL DEFAULT '', scheduled_at TEXT, valid_from TEXT, valid_until TEXT, cwds TEXT NOT NULL DEFAULT '[]', model_id TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)`)
    db.prepare('INSERT INTO automations (id, name, prompt, status, schedule_type, rrule, cwds) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('automation-1', '每日单词', '背 5 个英语单词', 'ACTIVE', 'recurring', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30', JSON.stringify([workspace]))
    db.close()

    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      // No `saveAutomationRule`: this plugin is usable without an automation
      // provider, so the draft is reported (visible) yet ineligible.
      const service = new MigrationService({
        create: async () => undefined,
        append: async () => undefined,
      } as never, undefined, { sourceRoot })
      const preview = await service.preview()
      expect(preview.summary.automations).toBe(1)
      expect(preview.summary.automationEligible).toBe(0)
      expect(preview.automations[0]?.eligible).toBe(false)
      const result = await service.migrate({ sessions: false, memories: false, mcp: false, automations: true })
      expect(result.importedAutomations).toBe(0)
      expect(result.skippedAutomations).toBe(1)
      // A missing channel is a reported skip, never a failed batch.
      expect(result.errors).toEqual([])
      expect(result.loss.some(item => item.code === 'automation-channel-unavailable')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
