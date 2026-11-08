import { claudeAccountUsagePreparation } from './claude-account-usage-preparation'
import { claudeProfileSelectionHomes } from './claude-profile-selection-homes'
import { prepareClaudeProfileForLaunch } from './claude-profile-launch-preparation'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import { claudeProfileMissing } from './claude-profile-launch-errors'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  describeClaudeProfile,
  type ClaudeProfileDescriptor,
  readUserClaudeConfigDir,
  readUserClaudeConfigDirAsSet,
  resolveClaudeDefaultHome
} from './claude-profile-paths'
import type { runClaudeProfileSetupInWorker } from './claude-profile-setup-worker'
import { ClaudeProfileSetups } from './claude-profile-setups'
import {
  ClaudeLaunchAccountResolver,
  withPaneOwnClaudeConfigDir,
  type ClaudeLaunchAccountResolution
} from './claude-launch-account-resolution'
import type { ClaudeEnvPatch } from './environment'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { findClaudeAccount, type ClaudeAccountSelectionTarget } from './runtime-selection'
import { wslClaudeProfilePointer } from './claude-profile-wsl-paths'
import { isDirectory, listClaudeProfileHomes } from './claude-profile-homes'
import {
  claudeStateFile,
  readClaudeFolderLogin,
  removeClaudeAccountFolder,
  isSameClaudeLogin,
  type ClaudeFolderLogin
} from './claude-account-folder'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import type { ClaudeLaunchContext } from './claude-launch-context'
import type { ClaudePaneAccountRegistry } from './claude-pane-account-registry'
import type { ClaudeRepoAccountPin } from './claude-repo-account-pin'

export type ClaudeProfileRouterSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'claudeAccountByRepo'
  | 'agentStatusHooksEnabled'
  | 'disabledTuiAgents'
>

export type { ClaudeLaunchAccountResolution } from './claude-launch-account-resolution'

/** Mirror the settings selection to a pointer file for Claude in existing terminals. */
export class ClaudeProfileRouter {
  readonly pointerPath: string
  private readonly setups: ClaudeProfileSetups
  private readonly launches: ClaudeLaunchAccountResolver
  private env: NodeJS.ProcessEnv
  private readonly envReady: Promise<unknown>
  private envResolved: boolean
  constructor(
    private readonly args: {
      getSettings: () => ClaudeProfileRouterSettings
      dataRoot: string
      userHome?: string
      env?: NodeJS.ProcessEnv
      runSetup?: typeof runClaudeProfileSetupInWorker
      refreshWaitMs?: number
      /** Which account each pane launched with; rotation records its choice here. */
      paneAccounts?: ClaudePaneAccountRegistry
      /** The account a repo pins through orca.yaml or settings, for the launch's cwd. */
      resolveRepoPin?: (context: ClaudeLaunchContext) => ClaudeRepoAccountPin | null
    }
  ) {
    this.pointerPath = join(args.dataRoot, 'claude-profiles', 'selected-host')
    this.env = args.env ?? process.env
    // Dock launches lack CLAUDE_CONFIG_DIR exported by shell startup files.
    this.envResolved = Boolean(args.env)
    this.envReady = args.env
      ? Promise.resolve()
      : resolveLoginShellEnvironment().then((env) => {
          this.env = env
          this.envResolved = true
          // Recompute routing using the resolved System default.
          try {
            this.writePointer()
          } catch (error) {
            console.warn('[claude-profile] Could not update the Claude account pointer:', error)
          }
        })
    this.setups = new ClaudeProfileSetups({
      dataRoot: args.dataRoot,
      getSettings: args.getSettings,
      userHome: () => this.userHome,
      userConfigDir: () => this.userConfigDir(),
      envReady: this.envReady,
      runSetup: args.runSetup
    })
    this.launches = new ClaudeLaunchAccountResolver({
      getSettings: args.getSettings,
      paneAccounts: args.paneAccounts,
      resolveRepoPin: args.resolveRepoPin,
      launchable: (accountId) => this.launchable(accountId)
    })
  }

  get userHome(): string {
    return this.args.userHome ?? homedir()
  }

  selectedProfile(context?: ClaudeLaunchContext): ClaudeProfileDescriptor | null {
    const id = this.resolveLaunchAccount(context).accountId
    return id ? this.describe(id) : null
  }

  /** A held rotation, then the repo pin, then the global selection. */
  resolveLaunchAccount(context?: ClaudeLaunchContext): ClaudeLaunchAccountResolution {
    return this.launches.resolve(context)
  }

  private launchable(accountId: string): boolean {
    return (
      this.savedAccount(accountId) !== undefined &&
      (this.accountLogin(accountId) !== null || this.coveredBySystemDefault(accountId))
    )
  }

  private routedProfile(context?: ClaudeLaunchContext): ClaudeProfileDescriptor | null {
    const profile = this.selectedProfile(context)
    return profile && !this.coveredBySystemDefault(profile.accountId) ? profile : null
  }

  accountLogin(accountId: string): ClaudeFolderLogin | null {
    return readClaudeFolderLogin(claudeStateFile(this.accountHome(accountId), this.userHome))
  }

  systemDefaultLogin(maxAgeMs = 0): ClaudeFolderLogin | null {
    return readClaudeFolderLogin(claudeStateFile(this.userConfigDir(), this.userHome), maxAgeMs)
  }

  /** Reuse a matching System default login until a legacy account signs in separately. */
  coveredBySystemDefault(accountId: string): boolean {
    if (this.accountLogin(accountId)) {
      return false
    }
    const saved = this.savedAccount(accountId)
    const systemDefault = this.systemDefaultLogin()
    return Boolean(saved && systemDefault && isSameClaudeLogin(saved, systemDefault))
  }

  savedAccount(accountId: string): ClaudeManagedAccount | undefined {
    return findClaudeAccount(this.args.getSettings(), accountId)
  }

  systemDefaultHome(): string {
    return resolveClaudeDefaultHome(this.userHome, this.userConfigDir())
  }

  /** Never fall back from a missing folder: that would run the wrong account. `identity` names
   *  the selected route before its folder exists; launches and reads still check availability. */
  routedHome(
    availability: 'checked' | 'identity' = 'checked',
    context?: ClaudeLaunchContext
  ): string | null {
    const home = this.routedProfile(context)?.home ?? null
    if (availability === 'checked' && home !== null && !isDirectory(home)) {
      throw claudeProfileMissing()
    }
    return home
  }

  /** Publish the pointer before starting background setup. */
  publish(): void {
    if (!this.writePointer()) {
      return
    }
    // Create missing or covered folders without a login so they can sign in separately.
    const profile = this.selectedProfile()
    if (profile) {
      this.setUpInBackground(profile)
    }
  }

  private writePointer(): boolean {
    if (this.args.getSettings().claudeManagedAccounts.length === 0) {
      rmSync(this.pointerPath, { force: true })
      return false
    }
    const home = this.routedProfile()?.home ?? ''
    // Avoid rewriting the pointer on every launch.
    if (!existsSync(this.pointerPath) || readFileSync(this.pointerPath, 'utf8') !== home) {
      mkdirSync(dirname(this.pointerPath), { recursive: true, mode: 0o700 })
      writeFileAtomically(this.pointerPath, home, { mode: 0o600 })
    }
    return true
  }

  private setUpInBackground(profile: ClaudeProfileDescriptor): void {
    this.setups.run(profile).catch((error: unknown) => {
      console.warn('[claude-profile] Account setup failed:', error)
    })
  }

  /** Initial setup must succeed; later refreshes may time out without blocking launch. */
  async prepareLaunch(context?: ClaudeLaunchContext): Promise<ClaudeRuntimeAuthPreparation> {
    const selected = this.selectedProfile(context)
    // Only fallback routing needs the shell env; account setup waits for it separately.
    if (!selected || !this.accountLogin(selected.accountId)) {
      await this.envReady
    }
    // Login changes since publication can change the route.
    this.writePointer()
    this.launches.record(context, this.resolveLaunchAccount(context))
    const profile = this.routedProfile(context)
    if (!profile) {
      return this.preparation(context)
    }
    await prepareClaudeProfileForLaunch(
      profile,
      (value) => this.setups.run(value),
      this.args.refreshWaitMs
    )
    return this.preparation(context)
  }

  accountHome(accountId: string): string {
    return this.describe(accountId).home
  }

  async prepareAccount(accountId: string): Promise<string> {
    const profile = this.describe(accountId)
    const report = await this.setups.run(profile).catch(() => null)
    if (report?.outcome !== 'prepared') {
      throw new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    }
    return profile.home
  }

  /** Wait for setup before deleting so it cannot recreate the folder. */
  async removeAccount(accountId: string): Promise<void> {
    await this.setups.pending(accountId)?.catch(() => {})
    await removeClaudeAccountFolder(this.args.dataRoot, accountId)
  }

  /** A legacy snapshot records copy-based account switching. */
  copiedLoginIntoSystemDefault(): boolean {
    return existsSync(join(this.args.dataRoot, 'claude-runtime-auth', 'system-default-auth.json'))
  }

  userConfigDir(): string | undefined {
    return readUserClaudeConfigDir(this.env)
  }

  private describe(accountId: string): ClaudeProfileDescriptor {
    return describeClaudeProfile(this.args.dataRoot, accountId, {
      executionHostId: 'local',
      runtime: 'host'
    })
  }

  launchEnv(context?: ClaudeLaunchContext): ClaudeEnvPatch {
    const home = this.routedHome('checked', context)
    return {
      [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath,
      // Preserve the user's inherited CLAUDE_CONFIG_DIR for System default.
      ...(home ? { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home } : {})
    }
  }

  /** A broken account selection must not prevent opening a terminal. */
  terminalEnv(
    target?: ClaudeAccountSelectionTarget,
    context?: ClaudeLaunchContext
  ): ClaudeEnvPatch {
    // Pass the pointer without waiting on the guest.
    if (target?.runtime === 'wsl') {
      return { [CLAUDE_PROFILE_POINTER_ENV]: `~/${wslClaudeProfilePointer(this.args.dataRoot)}` }
    }
    // Save the user's value so the shell function can restore it on System default.
    const userConfigDir = readUserClaudeConfigDirAsSet(this.env)
    const base: ClaudeEnvPatch = {
      [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath,
      ...(userConfigDir ? { [CLAUDE_USER_CONFIG_DIR_ENV]: userConfigDir } : {})
    }
    // Defer routing until the shell env resolves; the shell function will read the updated pointer.
    if (!this.envResolved) {
      return base
    }
    try {
      this.writePointer()
      const resolution = this.resolveLaunchAccount(context)
      this.launches.record(context, resolution)
      // Refresh without delaying terminal creation.
      const profile = this.routedProfile(context)
      if (profile) {
        this.setUpInBackground(profile)
      }
      return withPaneOwnClaudeConfigDir({ ...base, ...this.launchEnv(context) }, resolution)
    } catch {
      return base
    }
  }

  preparation(context?: ClaudeLaunchContext): ClaudeRuntimeAuthPreparation {
    const profile = this.routedProfile(context)
    const home = this.routedHome('checked', context)
    return {
      configDir: home ?? this.systemDefaultHome(),
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: this.launchEnv(context),
      provenance: home ? `profile:${profile?.accountId}` : 'system'
    }
  }

  /** Compare pre-routing terminals against the selection; null means no account is selected. */
  systemDefaultRunsAnotherAccount(): boolean | null {
    const profile = this.selectedProfile()
    if (!profile) {
      return null
    }
    const selected =
      this.accountLogin(profile.accountId) ??
      findClaudeAccount(this.args.getSettings(), profile.accountId)
    const systemDefault = this.systemDefaultLogin(5_000)
    return !selected || !systemDefault || !isSameClaudeLogin(selected, systemDefault)
  }

  routesToAccount(): boolean {
    return this.routedProfile() !== null
  }

  /** Read usage from the same login the account would launch with. */
  accountUsagePreparation(accountId: string): ClaudeRuntimeAuthPreparation {
    return claudeAccountUsagePreparation(this, accountId)
  }

  async accountSelectionHomes(launchEnv: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    return claudeProfileSelectionHomes(this, this.args.getSettings(), this.envReady, launchEnv)
  }

  /** Every account folder on this host, selected or not. */
  accountHomes(): string[] {
    return listClaudeProfileHomes(this.args.dataRoot)
  }
}
