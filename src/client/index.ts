import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createMigrationApi } from './api.js'
import { MigrationSection } from './MigrationSectionV2.js'
import { en, zh, type MigrationLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'migration.workbuddy': MigrationLocaleKey } }
export const inject = ['slots', 'locale']
const NS = 'migration.workbuddy'
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const api = createMigrationApi()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-migration-workbuddy: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'migration.workbuddy', order: 230, label: () => t('nav'), locale: NS, inject: () => ({ api }) }, MigrationSection))
}
