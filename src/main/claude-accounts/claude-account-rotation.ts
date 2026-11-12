import type { ClaudePaneKind } from './claude-launch-context'
import type { ClaudePaneAccountRecord } from './claude-pane-account-registry'

export type ClaudeRotationWindow = { usedPercent: number; resetsAt: number | null }

/** One saved account as the rotation sees it: its runtime, whether it can launch, and its windows. */
export type ClaudeRotationCandidate = {
  id: string
  runtime: 'host' | 'wsl'
  wslDistro: string | null
  signedIn: boolean
  /** 5-hour window; null until the poller has read it. */
  session: ClaudeRotationWindow | null
  /** 7-day window; null until the poller has read it. */
  weekly: ClaudeRotationWindow | null
}

export type ClaudeRotationPane = {
  paneId: string
  paneKind?: ClaudePaneKind
  selectionKey: string
  accountId: string | null
  cwd?: string
  repoKey?: string
}

export type ClaudeRotationReason = 'usage-threshold' | 'rate-limited'

export type ClaudeRotationEvent = {
  time: string
  pane: string
  paneKind: ClaudePaneKind | null
  repo: string | null
  from: string
  to: string
  reason: ClaudeRotationReason
  /** The chosen account's remaining percent per window, as the poller last saw it. */
  headroom: { fiveHour: number | null; sevenDay: number | null }
  /** Whether a chat was restarted on the new account; terminal panes move on their next launch. */
  restarted: boolean
}

/** At or above this share of the 5-hour window an account is treated as exhausted. */
export const CLAUDE_ROTATION_EXHAUSTED_PERCENT = 95
/** At most one rotation per pane in this window, so a flapping reading cannot bounce a chat. */
export const CLAUDE_ROTATION_WINDOW_MS = 10 * 60_000
/** Hold a rotation this long when the exhausted account's reset time is unknown. */
const CLAUDE_ROTATION_DEFAULT_HOLD_MS = 5 * 60 * 60_000

function headroom(window: ClaudeRotationWindow | null): number | null {
  return window ? Math.max(0, 100 - window.usedPercent) : null
}

export function isClaudeAccountExhausted(candidate: ClaudeRotationCandidate): boolean {
  return (
    (candidate.session !== null &&
      candidate.session.usedPercent >= CLAUDE_ROTATION_EXHAUSTED_PERCENT) ||
    (candidate.weekly !== null && candidate.weekly.usedPercent >= 100)
  )
}

function sameRuntime(a: ClaudeRotationCandidate, b: ClaudeRotationCandidate): boolean {
  return (
    a.runtime === b.runtime &&
    (a.runtime === 'host' ||
      (a.wslDistro ?? '').toLowerCase() === (b.wslDistro ?? '').toLowerCase())
  )
}

/** The signed-in account on the same runtime with the most 5-hour headroom, ties broken by 7-day. */
export function chooseClaudeRotationTarget(
  candidates: readonly ClaudeRotationCandidate[],
  from: ClaudeRotationCandidate
): ClaudeRotationCandidate | null {
  const usable = candidates.filter(
    (candidate) =>
      candidate.id !== from.id &&
      candidate.signedIn &&
      sameRuntime(candidate, from) &&
      candidate.session !== null &&
      !isClaudeAccountExhausted(candidate)
  )
  usable.sort(
    (a, b) =>
      (headroom(b.session) ?? 0) - (headroom(a.session) ?? 0) ||
      (headroom(b.weekly) ?? 0) - (headroom(a.weekly) ?? 0) ||
      a.id.localeCompare(b.id)
  )
  return usable[0] ?? null
}

/** The soonest 5-hour reset among exhausted accounts, for the "everything is used up" notice. */
export function earliestClaudeReset(candidates: readonly ClaudeRotationCandidate[]): number | null {
  const resets = candidates
    .filter((candidate) => candidate.signedIn && isClaudeAccountExhausted(candidate))
    .map((candidate) => candidate.session?.resetsAt ?? null)
    .filter((reset): reset is number => reset !== null)
  return resets.length > 0 ? Math.min(...resets) : null
}

export type ClaudeAccountRotatorDeps = {
  candidates: () => readonly ClaudeRotationCandidate[]
  panes: () => readonly ClaudeRotationPane[]
  /** Chats that stopped on a usage limit and can be continued on another account. */
  rateLimitedSessions?: () => readonly string[]
  globalAccountId: () => string | null
  recordRotation: (paneId: string, record: ClaudePaneAccountRecord) => void
  /** Restarts a chat on its newly recorded account; resolves false when it could not. */
  restartSession: (sessionId: string) => Promise<boolean>
  appendLog: (event: ClaudeRotationEvent) => void
  notify: (notice: { title: string; body: string }) => void
  now?: () => number
  windowMs?: number
}

/** Moves panes off an exhausted Claude account to the one with the most headroom. */
export class ClaudeAccountRotator {
  private readonly lastRotationAt = new Map<string, number>()
  private exhaustedNoticeShown = false
  private running: Promise<ClaudeRotationEvent[]> | null = null

  constructor(private readonly deps: ClaudeAccountRotatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** One pass over every pane: rate-limited chats first, then panes whose account crossed the threshold. */
  evaluate(): Promise<ClaudeRotationEvent[]> {
    if (!this.running) {
      this.running = this.sweep().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async sweep(): Promise<ClaudeRotationEvent[]> {
    const events: ClaudeRotationEvent[] = []
    const candidates = this.deps.candidates()
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const panes = this.deps.panes()
    const rateLimited = new Set(this.deps.rateLimitedSessions?.() ?? [])
    for (const pane of panes) {
      const current = pane.accountId ? byId.get(pane.accountId) : undefined
      if (!current) {
        continue
      }
      const reason: ClaudeRotationReason | null = rateLimited.has(pane.paneId)
        ? 'rate-limited'
        : isClaudeAccountExhausted(current)
          ? 'usage-threshold'
          : null
      if (!reason) {
        continue
      }
      const event = await this.rotate(pane, current, candidates, reason)
      if (event) {
        events.push(event)
      }
    }
    return events
  }

  private async rotate(
    pane: ClaudeRotationPane,
    from: ClaudeRotationCandidate,
    candidates: readonly ClaudeRotationCandidate[],
    reason: ClaudeRotationReason
  ): Promise<ClaudeRotationEvent | null> {
    const now = this.now()
    const last = this.lastRotationAt.get(pane.paneId)
    if (last !== undefined && now - last < (this.deps.windowMs ?? CLAUDE_ROTATION_WINDOW_MS)) {
      return null
    }
    const to = chooseClaudeRotationTarget(candidates, from)
    if (!to) {
      this.notifyAllExhausted(candidates)
      return null
    }
    this.exhaustedNoticeShown = false
    this.lastRotationAt.set(pane.paneId, now)
    this.deps.recordRotation(pane.paneId, {
      selectionKey: pane.selectionKey,
      accountId: to.id,
      source: 'rotation',
      ...(pane.paneKind ? { paneKind: pane.paneKind } : {}),
      ...(pane.repoKey ? { repoKey: pane.repoKey } : {}),
      ...(pane.cwd ? { cwd: pane.cwd } : {}),
      globalAccountId: this.deps.globalAccountId(),
      rotatedFromAccountId: from.id,
      holdUntil: from.session?.resetsAt ?? now + CLAUDE_ROTATION_DEFAULT_HOLD_MS,
      recordedAt: now
    })
    let restarted = false
    if (pane.paneKind === 'session') {
      restarted = await this.deps.restartSession(pane.paneId).catch((error: unknown) => {
        console.warn('[claude-rotation] Could not restart the chat on the new account:', error)
        return false
      })
    }
    const event: ClaudeRotationEvent = {
      time: new Date(now).toISOString(),
      pane: pane.paneId,
      paneKind: pane.paneKind ?? null,
      repo: pane.repoKey ?? null,
      from: from.id,
      to: to.id,
      reason,
      headroom: { fiveHour: headroom(to.session), sevenDay: headroom(to.weekly) },
      restarted
    }
    this.deps.appendLog(event)
    return event
  }

  /** One notice per exhaustion episode; it rearms once a rotation succeeds again. */
  private notifyAllExhausted(candidates: readonly ClaudeRotationCandidate[]): void {
    if (this.exhaustedNoticeShown) {
      return
    }
    this.exhaustedNoticeShown = true
    const reset = earliestClaudeReset(candidates)
    this.deps.notify({
      title: 'Every Claude account is at its limit',
      body: reset
        ? `The earliest 5-hour window resets at ${new Date(reset).toLocaleTimeString()}.`
        : 'No reset time is known yet; Orca keeps polling.'
    })
  }
}
