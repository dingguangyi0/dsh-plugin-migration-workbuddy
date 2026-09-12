import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename as renameAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replaceFile, replaceFileSync } from '../src/atomic-file.js'

/** The Windows conflicts Node reports for a busy destination. */
function conflict(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted`), { code })
}

describe('atomic file replacement', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scenario(): { dir: string, target: string, temp: string } {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-replace-'))
    dirs.push(dir)
    const target = join(dir, 'state.json')
    const temp = join(dir, 'state.json.tmp')
    writeFileSync(target, 'old')
    writeFileSync(temp, 'new')
    return { dir, target, temp }
  }

  function leftovers(dir: string): string[] {
    return readdirSync(dir).filter(name => name.includes('.replaced-'))
  }

  it('replaces the destination when rename succeeds', () => {
    const { target, temp } = scenario()
    replaceFileSync(temp, target)
    expect(readFileSync(target, 'utf8')).toBe('new')
  })

  it('creates the destination when it does not exist yet', () => {
    const { target, temp } = scenario()
    rmSync(target)
    replaceFileSync(temp, target)
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(existsSync(temp)).toBe(false)
  })

  it('retries every busy-destination code before giving up', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EEXIST']) {
      const { target, temp } = scenario()
      let calls = 0
      replaceFileSync(temp, target, {
        sleep: () => {},
        rename: (from, to) => {
          calls += 1
          if (calls === 1) throw conflict(code)
          renameSync(from, to)
        },
      })
      expect(calls).toBe(2)
      expect(readFileSync(target, 'utf8')).toBe('new')
    }
  })

  it('moves a persistent conflict aside and still lands the new content', () => {
    const { dir, target, temp } = scenario()
    const calls: string[] = []
    replaceFileSync(temp, target, {
      sleep: () => {},
      rename: (from, to) => {
        calls.push(from === temp ? 'swap' : 'aside')
        if (to === target && existsSync(target)) throw conflict('EBUSY')
        renameSync(from, to)
      },
    })
    expect(calls.filter(entry => entry === 'swap')).toHaveLength(4) // 3 attempts + the final swap
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(leftovers(dir)).toEqual([])
  })

  it('rolls the original destination back when the swap keeps failing', () => {
    const { dir, target, temp } = scenario()
    expect(() => replaceFileSync(temp, target, {
      sleep: () => {},
      rename: (from, to) => {
        if (from === temp) throw conflict('EBUSY')
        renameSync(from, to)
      },
    })).toThrow(/EBUSY/u)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(leftovers(dir)).toEqual([])
  })

  it('keeps the new content when the backup cannot be removed', () => {
    const { target, temp } = scenario()
    replaceFileSync(temp, target, {
      sleep: () => {},
      remove: () => { throw conflict('EPERM') },
      rename: (from, to) => {
        if (to === target && existsSync(target)) throw conflict('EBUSY')
        renameSync(from, to)
      },
    })
    expect(readFileSync(target, 'utf8')).toBe('new')
  })

  it('names the backup when the destination cannot be restored', () => {
    const { target, temp } = scenario()
    let error: unknown
    try {
      replaceFileSync(temp, target, {
        sleep: () => {},
        rename: (from, to) => {
          if (from === temp || to === target) throw conflict('EBUSY')
          renameSync(from, to)
        },
      })
    } catch (cause) {
      error = cause
    }
    expect(String(error)).toMatch(/previous content is at .*\.replaced-/u)
  })

  it('refuses a directory destination instead of replacing it with a file', () => {
    const { target, temp } = scenario()
    rmSync(target)
    mkdirSync(target)
    expect(() => replaceFileSync(temp, target, { sleep: () => {} })).toThrow()
    expect(statSync(target).isDirectory()).toBe(true)
  })

  it('does the same asynchronously', async () => {
    const { dir, target, temp } = scenario()
    let calls = 0
    await replaceFile(temp, target, {
      sleep: async () => {},
      rename: async (from, to) => {
        calls += 1
        if (calls === 1) throw conflict('EBUSY')
        await renameAsync(from, to)
      },
    })
    expect(calls).toBe(2)
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(leftovers(dir)).toEqual([])
  })

  it('rolls back asynchronously too', async () => {
    const { dir, target, temp } = scenario()
    await expect(replaceFile(temp, target, {
      sleep: async () => {},
      rename: async (from, to) => {
        if (from === temp) throw conflict('EBUSY')
        await renameAsync(from, to)
      },
    })).rejects.toThrow(/EBUSY/u)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(leftovers(dir)).toEqual([])
  })
})
