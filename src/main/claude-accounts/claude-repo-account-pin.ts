import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { parseOrcaYaml } from '../../shared/orca-yaml'
import type { Repo } from '../../shared/repo-types'
import type { ClaudeLaunchContext } from './claude-launch-context'

export type ClaudeRepoAccountPin = {
  accountId: string
  /** The repo id, or the folder the orca.yaml was read from when the repo is not registered. */
  repoKey: string
  source: 'settings' | 'orca.yaml'
}

export type ClaudeRepoPinSettings = Pick<GlobalSettings, 'claudeManagedAccounts'> & {
  /** Repo id or repo path to account id or email; overrides a repo's own orca.yaml. */
  claudeAccountByRepo?: Record<string, string>
}

export type ClaudeRepoPinDeps = {
  settings: ClaudeRepoPinSettings
  repos: readonly Pick<Repo, 'id' | 'path'>[]
  /** Reads `<dir>/orca.yaml`'s claudeAccount; injectable for tests. */
  readClaudeAccount?: (dir: string) => string | undefined
  warn?: (message: string) => void
}

// Walking further than this from the launch cwd no longer plausibly names the same checkout.
const MAX_ANCESTORS = 12

function normalizePath(path: string): string {
  const resolved = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** Resolves an id or a saved email to one account; an email in several organizations is refused. */
export function matchClaudeAccountReference(
  accounts: readonly ClaudeManagedAccount[],
  reference: string
): { accountId: string } | { error: string } {
  const trimmed = reference.trim()
  const byId = accounts.find((account) => account.id === trimmed)
  if (byId) {
    return { accountId: byId.id }
  }
  const needle = trimmed.toLowerCase()
  const byEmail = accounts.filter((account) => account.email.toLowerCase() === needle)
  if (byEmail.length === 1) {
    return { accountId: byEmail[0].id }
  }
  return {
    error:
      byEmail.length > 1
        ? `"${trimmed}" names several Claude accounts (${byEmail.map((a) => a.id).join(', ')}); pin one by id.`
        : `"${trimmed}" is not a saved Claude account.`
  }
}

export function readOrcaYamlClaudeAccount(dir: string): string | undefined {
  const path = join(dir, 'orca.yaml')
  if (!existsSync(path)) {
    return undefined
  }
  try {
    return parseOrcaYaml(readFileSync(path, 'utf8'))?.claudeAccount
  } catch {
    return undefined
  }
}

function repoFor(
  context: ClaudeLaunchContext,
  repos: readonly Pick<Repo, 'id' | 'path'>[]
): { id: string; path: string } | null {
  const separator = context.workspaceId?.indexOf('::') ?? -1
  if (context.workspaceId && separator > 0) {
    const id = context.workspaceId.slice(0, separator)
    const repo = repos.find((entry) => entry.id === id)
    return { id, path: repo?.path ?? context.workspaceId.slice(separator + 2) }
  }
  if (!context.cwd) {
    return null
  }
  const cwd = normalizePath(context.cwd)
  // The longest containing repo path wins, so a nested checkout pins its own account.
  const containing = repos
    .filter((repo) => isWithin(cwd, normalizePath(repo.path)))
    .sort((a, b) => b.path.length - a.path.length)
  return containing[0] ? { id: containing[0].id, path: containing[0].path } : null
}

/** Folders whose orca.yaml may pin this launch: the cwd's ancestors up to the repo, then the repo itself. */
function candidateYamlDirs(context: ClaudeLaunchContext, repoPath: string | null): string[] {
  const dirs: string[] = []
  if (context.cwd) {
    let dir = resolve(context.cwd)
    const stop = repoPath ? normalizePath(repoPath) : null
    for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
      dirs.push(dir)
      if ((stop && normalizePath(dir) === stop) || dirname(dir) === dir) {
        break
      }
      dir = dirname(dir)
    }
  }
  if (repoPath && !dirs.some((dir) => normalizePath(dir) === normalizePath(repoPath))) {
    dirs.push(repoPath)
  }
  return dirs
}

/**
 * The account a repo pins for its launches: the settings map first (set on this machine for
 * repos whose orca.yaml is not ours to edit), then `claudeAccount` in the checkout's orca.yaml.
 * A pin naming an unknown account is reported and ignored rather than failing the launch.
 */
export function resolveClaudeRepoAccountPin(
  context: ClaudeLaunchContext,
  deps: ClaudeRepoPinDeps
): ClaudeRepoAccountPin | null {
  const warn = deps.warn ?? ((message) => console.warn(`[claude-profile] ${message}`))
  const repo = repoFor(context, deps.repos)
  const byRepo = deps.settings.claudeAccountByRepo ?? {}
  if (repo) {
    const key = Object.keys(byRepo).find(
      (candidate) =>
        candidate === repo.id ||
        (candidate.includes(sep) || candidate.includes('/')
          ? normalizePath(candidate) === normalizePath(repo.path)
          : false)
    )
    if (key) {
      const match = matchClaudeAccountReference(deps.settings.claudeManagedAccounts, byRepo[key])
      if ('accountId' in match) {
        return { accountId: match.accountId, repoKey: repo.id, source: 'settings' }
      }
      warn(`claudeAccountByRepo for ${repo.id}: ${match.error}`)
    }
  }
  const read = deps.readClaudeAccount ?? readOrcaYamlClaudeAccount
  for (const dir of candidateYamlDirs(context, repo?.path ?? null)) {
    const reference = read(dir)
    if (!reference) {
      continue
    }
    const match = matchClaudeAccountReference(deps.settings.claudeManagedAccounts, reference)
    if ('accountId' in match) {
      return { accountId: match.accountId, repoKey: repo?.id ?? dir, source: 'orca.yaml' }
    }
    warn(`orca.yaml claudeAccount in ${dir}: ${match.error}`)
    return null
  }
  return null
}
