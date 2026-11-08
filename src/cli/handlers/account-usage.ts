import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { readAgentFlag, type ClaudeCodexSnapshot } from './account-selection'

export type ClaudeAccountUsageWindow = {
  usedPercent: number
  resetsAt: number | null
  resetDescription: string | null
}

/** One saved Claude account with the poller's last 5-hour and 7-day readings. */
export type ClaudeAccountUsageRow = {
  id: string
  email: string
  runtime: 'host' | 'wsl'
  wslDistro: string | null
  active: boolean
  needsSignIn: boolean
  status: ProviderRateLimits['status'] | 'unread'
  fiveHour: ClaudeAccountUsageWindow | null
  sevenDay: ClaudeAccountUsageWindow | null
  updatedAt: number | null
  error: string | null
}

export type ClaudeAccountUsageReport = {
  activeAccountId: string | null
  accounts: ClaudeAccountUsageRow[]
}

function usageWindow(value: RateLimitWindow | null | undefined): ClaudeAccountUsageWindow | null {
  return value
    ? {
        usedPercent: value.usedPercent,
        resetsAt: value.resetsAt,
        resetDescription: value.resetDescription
      }
    : null
}

function activeIds(state: ClaudeRateLimitAccountsState): Set<string | null> {
  return new Set([
    state.activeAccountId,
    state.activeAccountIdsByRuntime?.host ?? null,
    ...Object.values(state.activeAccountIdsByRuntime?.wsl ?? {})
  ])
}

/** The active account reads from the live `claude` meter; every other from the inactive-account cache. */
function readingFor(
  account: ClaudeManagedAccountSummary,
  active: boolean,
  rateLimits: RateLimitState
): ProviderRateLimits | null {
  const inactive = rateLimits.inactiveClaudeAccounts.find(
    (entry) => entry.accountId === account.id
  )?.rateLimits
  if (inactive) {
    return inactive
  }
  return active ? rateLimits.claude : null
}

export function claudeAccountUsageReport(snapshot: {
  claude: ClaudeRateLimitAccountsState
  rateLimits: RateLimitState
}): ClaudeAccountUsageReport {
  const active = activeIds(snapshot.claude)
  return {
    activeAccountId: snapshot.claude.activeAccountId,
    accounts: snapshot.claude.accounts.map((account) => {
      const isActive = active.has(account.id)
      const reading = readingFor(account, isActive, snapshot.rateLimits)
      return {
        id: account.id,
        email: account.email,
        runtime: account.managedAuthRuntime ?? 'host',
        wslDistro: account.wslDistro ?? null,
        active: isActive,
        needsSignIn: account.needsSignIn === true,
        status: reading?.status ?? 'unread',
        fiveHour: usageWindow(reading?.session),
        sevenDay: usageWindow(reading?.weekly),
        updatedAt: reading?.updatedAt ?? null,
        error: reading?.error ?? null
      }
    })
  }
}

function describeWindow(value: ClaudeAccountUsageWindow | null): string {
  if (!value) {
    return '--'
  }
  const reset =
    value.resetDescription ?? (value.resetsAt ? new Date(value.resetsAt).toLocaleString() : null)
  return `${Math.round(value.usedPercent)}%${reset ? ` (resets ${reset})` : ''}`
}

export function formatClaudeAccountUsage(report: ClaudeAccountUsageReport): string {
  if (report.accounts.length === 0) {
    return 'No managed Claude accounts.'
  }
  const lines = report.accounts.map((row) => {
    const flags = [row.active ? 'active' : null, row.needsSignIn ? 'sign in again' : null]
      .filter(Boolean)
      .join(', ')
    const detail =
      row.fiveHour || row.sevenDay
        ? `5h ${describeWindow(row.fiveHour)}  7d ${describeWindow(row.sevenDay)}`
        : (row.error ?? row.status)
    return `  ${row.id}  ${row.email}${flags ? ` (${flags})` : ''}\n    ${detail}`
  })
  return `Claude account usage (${report.accounts.length}):\n${lines.join('\n')}`
}

/** `orca account usage --agent claude`: every saved account's last 5-hour and 7-day readings. */
export async function showAgentAccountUsage(ctx: HandlerContext): Promise<void> {
  if (readAgentFlag(ctx) !== 'claude') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Per-account usage is only available for --agent claude; `orca account list --json` carries the others.'
    )
  }
  // Refresh stale windows within the host's throttles so a rotation decision reads current numbers.
  const response = await ctx.client.call<ClaudeCodexSnapshot & { rateLimits: RateLimitState }>(
    'accounts.list',
    { refreshUsage: false, refreshStaleUsage: true }
  )
  const report = claudeAccountUsageReport(response.result)
  printResult({ ...response, result: report }, ctx.json, formatClaudeAccountUsage)
}
