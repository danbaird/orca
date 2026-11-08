import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../shared/claude-profile-routing'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeLaunchAccountSource, ClaudeLaunchContext } from './claude-launch-context'
import type { ClaudePaneAccountRegistry } from './claude-pane-account-registry'
import type { ClaudeRepoAccountPin } from './claude-repo-account-pin'
import type { ClaudeEnvPatch } from './environment'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

export type ClaudeLaunchAccountResolution = {
  accountId: string | null
  source: ClaudeLaunchAccountSource
  repoKey?: string
}

export type ClaudeLaunchAccountResolverDeps = {
  getSettings: () => Pick<
    GlobalSettings,
    'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
  >
  /** Which account each pane launched with; rotation records its choice here. */
  paneAccounts?: ClaudePaneAccountRegistry
  /** The account a repo pins through orca.yaml or settings, for the launch's cwd. */
  resolveRepoPin?: (context: ClaudeLaunchContext) => ClaudeRepoAccountPin | null
  /** Saved and signed in (or covered by System default), so a launch on it cannot fail for auth. */
  launchable: (accountId: string) => boolean
}

/** Repo pin, then a rotation recorded for the pane, then the global selection. A pin that
 *  needs sign-in falls back to the global selection with a warning, never to a silent failure. */
export class ClaudeLaunchAccountResolver {
  constructor(private readonly deps: ClaudeLaunchAccountResolverDeps) {}

  private globalAccountId(): string | null {
    return getSelectedClaudeAccountIdForTarget(this.deps.getSettings(), { runtime: 'host' })
  }

  resolve(context?: ClaudeLaunchContext): ClaudeLaunchAccountResolution {
    const globalId = this.globalAccountId()
    const global: ClaudeLaunchAccountResolution = { accountId: globalId, source: 'global' }
    if (!context) {
      return global
    }
    const pin = this.deps.resolveRepoPin?.(context) ?? null
    if (pin) {
      if (this.deps.launchable(pin.accountId)) {
        return { accountId: pin.accountId, source: 'repo-pin', repoKey: pin.repoKey }
      }
      console.warn(
        `[claude-profile] Claude account ${pin.accountId} pinned for ${pin.repoKey} needs sign-in; launching on the global selection instead.`
      )
    }
    const pane = context.paneId ? this.deps.paneAccounts?.get(context.paneId) : null
    // A rotation holds until the person changes the global selection themselves.
    if (
      pane?.source === 'rotation' &&
      pane.selectionKey === 'host' &&
      pane.accountId &&
      pane.globalAccountId === globalId &&
      this.deps.launchable(pane.accountId)
    ) {
      return { accountId: pane.accountId, source: 'rotation', repoKey: pane.repoKey }
    }
    return global
  }

  /** Remember what the pane launched with, so rotation and the usage display agree with it. */
  record(
    context: ClaudeLaunchContext | undefined,
    resolution: ClaudeLaunchAccountResolution
  ): void {
    if (!context?.paneId || !this.deps.paneAccounts) {
      return
    }
    this.deps.paneAccounts.record(context.paneId, {
      selectionKey: 'host',
      accountId: resolution.accountId,
      source: resolution.source,
      ...(context.paneKind ? { paneKind: context.paneKind } : {}),
      ...(resolution.repoKey ? { repoKey: resolution.repoKey } : {}),
      ...(context.cwd ? { cwd: context.cwd } : {}),
      globalAccountId: this.globalAccountId(),
      recordedAt: Date.now()
    })
  }
}

/** The shell function re-reads the global pointer only for Orca's own injected value, so a
 *  pinned or rotated pane keeps its CLAUDE_CONFIG_DIR as if the person had set it. */
export function withPaneOwnClaudeConfigDir(
  env: ClaudeEnvPatch,
  resolution: ClaudeLaunchAccountResolution
): ClaudeEnvPatch {
  if (resolution.source === 'global' || !env.CLAUDE_CONFIG_DIR) {
    return env
  }
  const { [CLAUDE_INJECTED_CONFIG_DIR_ENV]: _injected, ...own } = env
  return own
}
