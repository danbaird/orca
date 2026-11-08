import { readFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { ClaudeLaunchAccountSource, ClaudePaneKind } from './claude-launch-context'

// Mirrors codex-pane-account-registry: a pane keeps the account it launched with across
// later launches, restarts and rotations, keyed by terminal pane key or chat session id.

export type ClaudePaneAccountRecord = {
  /** Launch selection lane: host or wsl:<distro>. */
  selectionKey: string
  /** Managed account id, or null for the system default. */
  accountId: string | null
  paneKind?: ClaudePaneKind
  source: ClaudeLaunchAccountSource
  /** The repo the pin resolved against when `source` is `repo-pin`. */
  repoKey?: string
  /** Launch cwd, so rotation can re-check the repo pin without the pane. */
  cwd?: string
  /** The global selection when recorded; a rotation yields once the person changes it. */
  globalAccountId?: string | null
  /** The exhausted account a rotation moved the pane off. */
  rotatedFromAccountId?: string
  /** Unix ms until which a rotation beats the repo pin and global selection: the old account's reset. */
  holdUntil?: number
  recordedAt: number
}

export type ClaudePaneAccountRegistryFile = {
  version: 1
  panes: Record<string, ClaudePaneAccountRecord>
}

const SOURCES: readonly ClaudeLaunchAccountSource[] = ['repo-pin', 'pane', 'rotation', 'global']

function isRecord(value: unknown): value is ClaudePaneAccountRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Partial<ClaudePaneAccountRecord>
  return (
    (record.selectionKey === 'host' ||
      (typeof record.selectionKey === 'string' && /^wsl:.+/.test(record.selectionKey))) &&
    (record.accountId === null || typeof record.accountId === 'string') &&
    SOURCES.includes(record.source as ClaudeLaunchAccountSource) &&
    typeof record.recordedAt === 'number'
  )
}

function parseRegistry(raw: string): ClaudePaneAccountRegistryFile {
  const empty: ClaudePaneAccountRegistryFile = { version: 1, panes: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  const panes = (parsed as Partial<ClaudePaneAccountRegistryFile> | null)?.panes
  if (!panes || typeof panes !== 'object' || Array.isArray(panes)) {
    return empty
  }
  for (const [paneId, record] of Object.entries(panes)) {
    if (isRecord(record)) {
      empty.panes[paneId] = record
    }
  }
  return empty
}

export class ClaudePaneAccountRegistry {
  private cached: ClaudePaneAccountRegistryFile | null = null
  /** Set when the file exists but could not be read; mutations then stay in memory rather than erase it. */
  private unreadable = false

  constructor(readonly path: string) {}

  get(paneId: string): ClaudePaneAccountRecord | null {
    return this.read().panes[paneId] ?? null
  }

  list(): ReadonlyMap<string, ClaudePaneAccountRecord> {
    return new Map(Object.entries(this.read().panes))
  }

  record(paneId: string, record: ClaudePaneAccountRecord): void {
    const registry = this.read()
    const previous = registry.panes[paneId]
    if (previous && sameRecord(previous, record)) {
      return
    }
    registry.panes[paneId] = record
    this.persist(registry)
  }

  forget(paneId: string): void {
    const registry = this.read()
    if (paneId in registry.panes) {
      delete registry.panes[paneId]
      this.persist(registry)
    }
  }

  /** livePaneIds must be the authoritative inventory; records of closed panes are dropped. */
  reconcile(livePaneIds: readonly string[]): void {
    const registry = this.read()
    const live = new Set(livePaneIds)
    let changed = false
    for (const paneId of Object.keys(registry.panes)) {
      if (!live.has(paneId)) {
        delete registry.panes[paneId]
        changed = true
      }
    }
    if (changed) {
      this.persist(registry)
    }
  }

  private read(): ClaudePaneAccountRegistryFile {
    if (this.cached) {
      return this.cached
    }
    try {
      this.cached = parseRegistry(readFileSync(this.path, 'utf8'))
    } catch (error) {
      this.unreadable = !isDefinitiveAbsence(error)
      this.cached = { version: 1, panes: {} }
    }
    return this.cached
  }

  private persist(registry: ClaudePaneAccountRegistryFile): void {
    this.cached = registry
    if (this.unreadable) {
      console.warn(
        '[claude-pane-accounts] Registry unreadable; keeping pane accounts in memory only.'
      )
      return
    }
    try {
      writeFileAtomically(this.path, `${JSON.stringify(registry)}\n`, { mode: 0o600 })
    } catch (error) {
      // Attribution persistence must not break a launch.
      console.warn('[claude-pane-accounts] Failed to persist pane account registry:', error)
    }
  }
}

function sameRecord(a: ClaudePaneAccountRecord, b: ClaudePaneAccountRecord): boolean {
  return (
    a.selectionKey === b.selectionKey &&
    a.accountId === b.accountId &&
    a.source === b.source &&
    a.repoKey === b.repoKey &&
    a.cwd === b.cwd &&
    a.globalAccountId === b.globalAccountId &&
    a.rotatedFromAccountId === b.rotatedFromAccountId &&
    a.holdUntil === b.holdUntil &&
    a.paneKind === b.paneKind
  )
}
