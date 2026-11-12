import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { RateLimitService } from '../rate-limits/service'
import {
  ClaudeAccountRotator,
  type ClaudeRotationCandidate,
  type ClaudeRotationEvent,
  type ClaudeRotationPane
} from './claude-account-rotation'
import type { ClaudePaneAccountRegistry } from './claude-pane-account-registry'
import type { ClaudeAccountService } from './service'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

export type ClaudeAccountRotationWiring = {
  claudeAccounts: Pick<ClaudeAccountService, 'listAccounts'>
  rateLimits: Pick<RateLimitService, 'getState' | 'onStateChange'>
  paneAccounts: ClaudePaneAccountRegistry
  getSettings: () => Pick<
    GlobalSettings,
    'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
  >
  dataRoot: string
  notify?: (notice: { title: string; body: string }) => void
}

// Usage-limit cuts can appear between polls; a sweep this often catches them within a minute.
const SWEEP_INTERVAL_MS = 60_000

function usageWindow(window: ProviderRateLimits['session']) {
  return window ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt } : null
}

/** Every saved account with the poller's last reading: the active one from the live meter, the rest from the cache. */
export function claudeRotationCandidates(
  accounts: ReturnType<ClaudeAccountService['listAccounts']>,
  state: RateLimitState
): ClaudeRotationCandidate[] {
  const activeHostId = accounts.activeAccountIdsByRuntime?.host ?? accounts.activeAccountId
  return accounts.accounts.map((account) => {
    const cached = state.inactiveClaudeAccounts.find((entry) => entry.accountId === account.id)
    const reading =
      cached?.rateLimits ??
      (account.id === activeHostId && state.claudeTarget.runtime === 'host' ? state.claude : null)
    const usable = reading?.status === 'ok' ? reading : null
    return {
      id: account.id,
      runtime: account.managedAuthRuntime ?? 'host',
      wslDistro: account.wslDistro ?? null,
      signedIn: account.needsSignIn !== true,
      session: usageWindow(usable?.session ?? null),
      weekly: usageWindow(usable?.weekly ?? null)
    }
  })
}

function rotationPanes(registry: ClaudePaneAccountRegistry): ClaudeRotationPane[] {
  return Array.from(registry.list(), ([paneId, record]) => ({
    paneId,
    paneKind: record.paneKind,
    selectionKey: record.selectionKey,
    accountId: record.accountId,
    cwd: record.cwd,
    repoKey: record.repoKey
  }))
}

function defaultNotify(notice: { title: string; body: string }): void {
  console.warn(`[claude-rotation] ${notice.title}: ${notice.body}`)
}

/** Watches the usage poller and rotates panes off exhausted accounts; returns a stop function. */
export function startClaudeAccountRotation(wiring: ClaudeAccountRotationWiring): () => void {
  const logPath = join(wiring.dataRoot, 'claude-rotations.jsonl')
  const rotator = new ClaudeAccountRotator({
    candidates: () =>
      claudeRotationCandidates(wiring.claudeAccounts.listAccounts(), wiring.rateLimits.getState()),
    panes: () => rotationPanes(wiring.paneAccounts),
    rateLimitedSessions: () =>
      getStructuredAgentSessionHost()
        ?.usageLimitContinue.listLoadedCuts()
        .map((entry) => entry.sessionId) ?? [],
    globalAccountId: () =>
      getSelectedClaudeAccountIdForTarget(wiring.getSettings(), { runtime: 'host' }),
    recordRotation: (paneId, record) => wiring.paneAccounts.record(paneId, record),
    restartSession: async (sessionId) =>
      (await getStructuredAgentSessionHost()?.usageLimitContinue.continueNow(sessionId)) ?? false,
    appendLog: (event: ClaudeRotationEvent) => {
      try {
        appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
      } catch (error) {
        console.warn('[claude-rotation] Could not append the rotation log:', error)
      }
    },
    notify: wiring.notify ?? defaultNotify
  })
  const sweep = (): void => {
    void rotator.evaluate().catch((error: unknown) => {
      console.warn('[claude-rotation] Rotation sweep failed:', error)
    })
  }
  const unsubscribe = wiring.rateLimits.onStateChange(sweep)
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => {
    unsubscribe()
    clearInterval(timer)
  }
}
