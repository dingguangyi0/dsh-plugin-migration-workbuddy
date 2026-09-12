/**
 * Windows-safe file replacement.
 *
 * Node maps `fs.rename` to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` on
 * Windows, so replacing an ordinary file works there. What fails is a target
 * another process holds open (`EBUSY`/`EPERM`/`EACCES` — sharing violation,
 * antivirus, indexers) or a non-file target. This helper rides out transient
 * locks with short retries, then moves a regular-file destination aside,
 * swaps the new file in and rolls back if the swap fails.
 *
 * Deliberately duplicated per package: DSH plugins are independent packages
 * and must not import each other.
 */

import { lstatSync, renameSync, rmSync } from 'node:fs'
import { lstat, rename, rm } from 'node:fs/promises'

/** Filesystem behaviours a caller may replace in tests. */
export interface ReplaceFileOptions {
  /** Defaults to `fs.renameSync`. */
  rename?: (from: string, to: string) => void
  /** Defaults to `fs.rmSync(path, { force: true })`. */
  remove?: (path: string) => void
  /** Total rename attempts before moving the target aside. Defaults to 3. */
  attempts?: number
  /** Delay between retries in milliseconds. Defaults to 20. */
  delayMs?: number
  /** Injectable sleep (tests). Defaults to a synchronous wait. */
  sleep?: (milliseconds: number) => void
  /** Injectable stat (tests). Defaults to `fs.lstatSync`. */
  stat?: (path: string) => { isFile: () => boolean }
}

/** Async filesystem behaviours a caller may replace in tests. */
export interface ReplaceFileAsyncOptions {
  /** Defaults to `fs.promises.rename`. */
  rename?: (from: string, to: string) => Promise<void>
  /** Defaults to `fs.promises.rm(path, { force: true })`. */
  remove?: (path: string) => Promise<void>
  attempts?: number
  delayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  stat?: (path: string) => Promise<{ isFile: () => boolean }>
}

/** Windows reports these when the destination is busy or not a file. */
const WINDOWS_REPLACE_CODES = new Set(['EBUSY', 'EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'])

function isReplaceConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code !== undefined && WINDOWS_REPLACE_CODES.has(code)
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** Synchronous sleep; Atomics.wait on a throwaway buffer is the only option. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * Replace file `target` with `temp`.
 *
 * @param temp - the fully written temporary file.
 * @param target - the destination that may already exist.
 * @param options - injected filesystem behaviours (tests).
 */
export function replaceFileSync(temp: string, target: string, options: ReplaceFileOptions = {}): void {
  const renameImpl = options.rename ?? renameSync
  const remove = options.remove ?? ((path: string): void => rmSync(path, { force: true }))
  const stat = options.stat ?? lstatSync
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 20
  const sleep = options.sleep ?? sleepSync

  let conflict: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameImpl(temp, target)
      return
    } catch (error) {
      if (!isReplaceConflict(error)) throw error
      conflict = error
    }
    if (attempt < attempts) sleep(delayMs)
  }

  // The conflict is not transient. Only a regular file may be moved aside: a
  // directory target is a caller bug and must not be replaced by a file.
  let isFile: boolean
  try {
    isFile = stat(target).isFile()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw conflict
    throw error
  }
  if (!isFile) throw conflict

  const backup = `${target}.replaced-${String(process.pid)}-${String(Date.now())}`
  try {
    renameImpl(target, backup)
  } catch {
    throw conflict
  }
  try {
    renameImpl(temp, target)
  } catch (error) {
    try {
      renameImpl(backup, target)
    } catch {
      throw new Error(
        `replaceFileSync: could not restore ${target}; the previous content is at ${backup}`,
        { cause: error },
      )
    }
    throw error
  }
  try {
    remove(backup)
  } catch {
    // The write succeeded; a stray backup is harmless and never blocks startup.
  }
}

/** Async variant of {@link replaceFileSync}. */
export async function replaceFile(temp: string, target: string, options: ReplaceFileAsyncOptions = {}): Promise<void> {
  const renameImpl = options.rename ?? rename
  const remove = options.remove ?? ((path: string): Promise<void> => rm(path, { force: true }))
  const stat = options.stat ?? lstat
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 20
  const sleep = options.sleep ?? (async (milliseconds: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
  })

  let conflict: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await renameImpl(temp, target)
      return
    } catch (error) {
      if (!isReplaceConflict(error)) throw error
      conflict = error
    }
    if (attempt < attempts) await sleep(delayMs)
  }

  let isFile: boolean
  try {
    isFile = (await stat(target)).isFile()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw conflict
    throw error
  }
  if (!isFile) throw conflict

  const backup = `${target}.replaced-${String(process.pid)}-${String(Date.now())}`
  try {
    await renameImpl(target, backup)
  } catch {
    throw conflict
  }
  try {
    await renameImpl(temp, target)
  } catch (error) {
    try {
      await renameImpl(backup, target)
    } catch {
      throw new Error(
        `replaceFile: could not restore ${target}; the previous content is at ${backup}`,
        { cause: error },
      )
    }
    throw error
  }
  try {
    await remove(backup)
  } catch {
    // The write succeeded; a stray backup is harmless and never blocks startup.
  }
}
