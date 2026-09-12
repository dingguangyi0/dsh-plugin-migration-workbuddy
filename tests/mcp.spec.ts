import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sanitizeMcpConfig } from '../src/mcp.js'

describe('MCP migration detection', () => {
  it('reads WorkBuddy mcpServers maps and maps type to transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-mcp-'))
    const path = join(root, 'mcp.json')
    await writeFile(path, `{
      // WorkBuddy accepts JSONC
      "mcpServers": {
        "browser": { "command": "node", "args": ["server.js"], "env": { "TOKEN": "do-not-copy" } },
        "remote": { "type": "streamable-http", "url": "https://example.test/mcp?token=hidden", "headers": { "Authorization": "hidden" } },
        "catalog-only": { "url": "https://disabled.example", "disabled": true }
      },
    }`)
    const result = await sanitizeMcpConfig(path)
    expect(result.drafts).toHaveLength(2)
    expect(result.drafts.map(item => item.name)).toEqual(['browser', 'remote'])
    expect(result.drafts[1]).toMatchObject({ transport: 'streamable-http', url: 'https://example.test/mcp' })
    expect(result.skippedSecrets).toEqual(expect.arrayContaining(['browser.env', 'remote.headers', 'remote.url']))
    expect(JSON.stringify(result.drafts)).not.toContain('hidden')
  })

  it('supports direct server records and nested servers arrays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-mcp-'))
    const path = join(root, 'connectors.json')
    await writeFile(path, JSON.stringify({ config: { servers: [{ name: 'one', url: 'https://one.test' }, { name: 'two', command: 'bun' }] } }))
    const result = await sanitizeMcpConfig(path)
    expect(result.drafts.map(item => item.name)).toEqual(['one', 'two'])
  })
})
