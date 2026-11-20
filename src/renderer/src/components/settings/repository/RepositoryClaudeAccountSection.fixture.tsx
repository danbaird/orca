import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repo-types'
import type { ClaudeManagedAccountSummary } from '../../../../../shared/managed-account-types'
import { RepositoryClaudeAccountSection } from './RepositoryClaudeAccountSection'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture sets only the Repo fields the section reads.
const repo = {
  id: 'repo-1',
  path: '/work/client-site',
  displayName: 'client-site',
  badgeColor: '#888888',
  addedAt: 0
} as Repo

const accounts: ClaudeManagedAccountSummary[] = [
  summary('acct-work', 'dev@work.example'),
  summary('acct-client', 'dev@client.example', { needsSignIn: true })
]

function summary(
  id: string,
  email: string,
  extra: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...extra
  }
}

function seed() {
  return () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture replaces one preload method.
    const api = window.api as unknown as { claudeAccounts: { list: () => Promise<unknown> } }
    api.claudeAccounts = {
      ...api.claudeAccounts,
      list: async () => ({ accounts, activeAccountId: 'acct-work', systemDefaultEmail: null })
    }
  }
}

function store(claudeAccountByRepo?: Record<string, string>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture seeds only the settings fields the section reads.
  return {
    settings: {
      claudeManagedAccounts: accounts.map((account) => ({
        ...account,
        managedAuthPath: '/unused',
        authMethod: 'subscription-oauth' as const
      })),
      claudeAccountByRepo
    }
  } as never
}

export const globalDefault = defineFixture({
  width: 520,
  store: store(),
  setup: seed(),
  render: () => <RepositoryClaudeAccountSection repo={repo} forceVisible />
})

export const pinned = defineFixture({
  width: 520,
  store: store({ 'repo-1': 'acct-work' }),
  setup: seed(),
  render: () => <RepositoryClaudeAccountSection repo={repo} forceVisible />
})

export const pinnedNeedsSignIn = defineFixture({
  width: 520,
  store: store({ 'repo-1': 'acct-client' }),
  setup: seed(),
  render: () => <RepositoryClaudeAccountSection repo={repo} forceVisible />
})

export const pinnedMissing = defineFixture({
  width: 520,
  store: store({ 'repo-1': 'removed@example.test' }),
  setup: seed(),
  render: () => <RepositoryClaudeAccountSection repo={repo} forceVisible />
})
