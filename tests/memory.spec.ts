import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMemoryCandidate, toMemoryRecords } from '../src/memory.js'

describe('memory migration', () => {
  it('parses markdown bullets and deduplicates records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-memory-'))
    const path = join(root, 'user_memory.md')
    await writeFile(path, '# facts\n- prefers Chinese\n- prefers Chinese\n- likes concise answers\n')
    const preview = await parseMemoryCandidate(path, 'markdown')
    expect(preview.records).toHaveLength(2)
    expect(toMemoryRecords([preview]).records).toHaveLength(2)
  })
})
