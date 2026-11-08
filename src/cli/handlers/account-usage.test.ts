import { describe, expect, it } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import { claudeAccountUsageReport, formatClaudeAccountUsage } from './account-usage'

function account(id: string, extra: Partial<ClaudeManagedAccountSummary> = {}) {
  return {
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...extra
  }
}

function reading(session: number, weekly: number, resetsAt: number): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: session, windowMinutes: 300, resetsAt, resetDescription: '2:30 PM' },
    weekly: { usedPercent: weekly, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    updatedAt: 1_000,
    error: null,
    status: 'ok'
  }
}

const rateLimits = {
  claude: reading(97, 40, 5_000),
  claudeTarget: { runtime: 'host', wslDistro: null },
  inactiveClaudeAccounts: [
    { accountId: 'b', rateLimits: reading(12, 55, 9_000), updatedAt: 1_000, isFetching: false }
  ]
} as unknown as RateLimitState

describe('claudeAccountUsageReport', () => {
  it('reads the active account from the live meter and the others from the inactive cache', () => {
    const report = claudeAccountUsageReport({
      claude: {
        accounts: [account('a'), account('b'), account('c', { needsSignIn: true })],
        activeAccountId: 'a',
        activeAccountIdsByRuntime: { host: 'a', wsl: {} }
      },
      rateLimits
    })
    expect(report).toEqual({
      activeAccountId: 'a',
      accounts: [
        {
          id: 'a',
          email: 'a@example.test',
          runtime: 'host',
          wslDistro: null,
          active: true,
          needsSignIn: false,
          status: 'ok',
          fiveHour: { usedPercent: 97, resetsAt: 5_000, resetDescription: '2:30 PM' },
          sevenDay: { usedPercent: 40, resetsAt: null, resetDescription: null },
          updatedAt: 1_000,
          error: null
        },
        {
          id: 'b',
          email: 'b@example.test',
          runtime: 'host',
          wslDistro: null,
          active: false,
          needsSignIn: false,
          status: 'ok',
          fiveHour: { usedPercent: 12, resetsAt: 9_000, resetDescription: '2:30 PM' },
          sevenDay: { usedPercent: 55, resetsAt: null, resetDescription: null },
          updatedAt: 1_000,
          error: null
        },
        {
          id: 'c',
          email: 'c@example.test',
          runtime: 'host',
          wslDistro: null,
          active: false,
          needsSignIn: true,
          status: 'unread',
          fiveHour: null,
          sevenDay: null,
          updatedAt: null,
          error: null
        }
      ]
    })
    expect(formatClaudeAccountUsage(report)).toBe(
      [
        'Claude account usage (3):',
        '  a  a@example.test (active)',
        '    5h 97% (resets 2:30 PM)  7d 40%',
        '  b  b@example.test',
        '    5h 12% (resets 2:30 PM)  7d 55%',
        '  c  c@example.test (sign in again)',
        '    unread'
      ].join('\n')
    )
  })
})
