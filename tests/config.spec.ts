import { describe, expect, it } from 'vitest'
import { normalizeMigrationConfig } from '../src/config.js'

describe('migration configuration', () => {
  it('enables the preview-first migration flow by default', () => {
    expect(normalizeMigrationConfig(undefined).enabled).toBe(true)
  })

  it('allows a profile to explicitly keep migration disabled', () => {
    expect(normalizeMigrationConfig({ enabled: false }).enabled).toBe(false)
  })
})
