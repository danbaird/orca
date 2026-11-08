import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../shared/claude-profile-routing'
import { ClaudePaneAccountRegistry } from './claude-pane-account-registry'
import { ClaudeProfileRouter, type ClaudeProfileRouterSettings } from './claude-profile-router'
import { resolveClaudeRepoAccountPin } from './claude-repo-account-pin'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

function signIn(stateDir: string, email: string): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } })
  )
}

function account(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

/** Accounts a and b are signed in, c is saved but needs sign-in; a is the global selection. */
function fixture(claudeAccountByRepo?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'claude-account-routing-'))
  roots.push(root)
  const dataRoot = join(root, 'data')
  const repoDir = join(root, 'repo')
  mkdirSync(join(repoDir, 'nested'), { recursive: true })
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [account('a'), account('b'), account('c')],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    claudeAccountByRepo,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const paneAccounts = new ClaudePaneAccountRegistry(join(dataRoot, 'claude-pane-accounts.json'))
  const repos = [{ id: 'repo-1', path: repoDir }]
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot,
    userHome: join(root, 'personal'),
    env: {},
    runSetup: async () => ({ outcome: 'prepared', warnings: [], surfaces: {} }),
    paneAccounts,
    resolveRepoPin: (context) =>
      resolveClaudeRepoAccountPin(context, { settings, repos, warn: () => {} })
  })
  const homes = {
    a: router.accountHome('a'),
    b: router.accountHome('b'),
    c: router.accountHome('c')
  }
  for (const id of ['a', 'b', 'c'] as const) {
    mkdirSync(homes[id], { recursive: true })
    writeFileSync(join(homes[id], '..', 'profile.json'), '{}')
  }
  signIn(homes.a, 'a@example.test')
  signIn(homes.b, 'b@example.test')
  return { router, settings, homes, repoDir, paneAccounts }
}

function pinRepo(repoDir: string, reference: string): void {
  writeFileSync(join(repoDir, 'orca.yaml'), `claudeAccount: ${reference}\n`)
}

describe('per-repo and per-pane Claude account routing', () => {
  it('routes a repo pinned in orca.yaml to that account while other launches follow the global selection', async () => {
    const f = fixture()
    pinRepo(f.repoDir, 'b@example.test')
    expect(f.router.launchEnv().CLAUDE_CONFIG_DIR).toBe(f.homes.a)
    expect(f.router.launchEnv({ cwd: join(f.repoDir, 'nested') }).CLAUDE_CONFIG_DIR).toBe(f.homes.b)
    const prepared = await f.router.prepareLaunch({
      cwd: f.repoDir,
      paneId: 'chat-1',
      paneKind: 'session'
    })
    expect(prepared.provenance).toBe('profile:b')
    expect(f.paneAccounts.get('chat-1')).toMatchObject({
      accountId: 'b',
      source: 'repo-pin',
      repoKey: 'repo-1'
    })
  })

  it('lets the settings map pin a repo by id over its orca.yaml', () => {
    const f = fixture({ 'repo-1': 'b' })
    pinRepo(f.repoDir, 'a@example.test')
    expect(
      f.router.launchEnv({ workspaceId: `repo-1::${f.repoDir}`, cwd: f.repoDir }).CLAUDE_CONFIG_DIR
    ).toBe(f.homes.b)
  })

  it('keeps a rotated pane on its account over the global selection until that selection changes', () => {
    const f = fixture()
    f.paneAccounts.record('pane-1', {
      selectionKey: 'host',
      accountId: 'b',
      source: 'rotation',
      globalAccountId: 'a',
      recordedAt: 1
    })
    expect(f.router.launchEnv({ paneId: 'pane-1' }).CLAUDE_CONFIG_DIR).toBe(f.homes.b)
    // A terminal pane keeps its own CLAUDE_CONFIG_DIR so the shell function does not re-read the global pointer.
    const terminal = f.router.terminalEnv({ runtime: 'host' }, { paneId: 'pane-1' })
    expect(terminal.CLAUDE_CONFIG_DIR).toBe(f.homes.b)
    expect(terminal[CLAUDE_INJECTED_CONFIG_DIR_ENV]).toBeUndefined()
    f.settings.activeClaudeManagedAccountId = 'c'
    signIn(f.homes.c, 'c@example.test')
    expect(f.router.launchEnv({ paneId: 'pane-1' }).CLAUDE_CONFIG_DIR).toBe(f.homes.c)
  })

  it('falls back to the global selection with a warning when the pinned account needs sign-in', () => {
    const f = fixture()
    pinRepo(f.repoDir, 'c')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(f.router.launchEnv({ cwd: f.repoDir }).CLAUDE_CONFIG_DIR).toBe(f.homes.a)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pinned for repo-1 needs sign-in'))
  })

  it('ignores a pin naming an unknown account rather than failing the launch', () => {
    const f = fixture()
    pinRepo(f.repoDir, 'nobody@example.test')
    expect(f.router.resolveLaunchAccount({ cwd: f.repoDir })).toEqual({
      accountId: 'a',
      source: 'global'
    })
  })
})
