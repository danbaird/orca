import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getClaudeAgentViewService } from '../claude/agent-view/agent-view-service'
import { probeRecentClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import { runClaudeProfileSetupInWorker } from './claude-profile-setup-worker'

export type ClaudeProfileSetupsDeps = {
  dataRoot: string
  getSettings: () => Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
  userHome: () => string
  userConfigDir: () => string | undefined
  /** Setup reads the login shell's CLAUDE_CONFIG_DIR, so it waits for that resolution. */
  envReady: Promise<unknown>
  runSetup?: typeof runClaudeProfileSetupInWorker
}

/** Reuse in-flight setup per account, so concurrent launches share one worker run. */
export class ClaudeProfileSetups {
  private readonly running = new Map<string, Promise<ClaudeProfileSetupReport>>()

  constructor(private readonly deps: ClaudeProfileSetupsDeps) {}

  pending(accountId: string): Promise<ClaudeProfileSetupReport> | undefined {
    return this.running.get(accountId)
  }

  run(profile: ClaudeProfileDescriptor): Promise<ClaudeProfileSetupReport> {
    const running = this.running.get(profile.accountId)
    if (running) {
      return running
    }
    const run = this.start(profile).finally(() => this.running.delete(profile.accountId))
    this.running.set(profile.accountId, run)
    return run
  }

  private async start(profile: ClaudeProfileDescriptor): Promise<ClaudeProfileSetupReport> {
    await this.deps.envReady
    const hooks = isAgentStatusHooksEnabledForAgent(this.deps.getSettings(), 'claude')
    const claudeVersion = hooks ? await probeRecentClaudeCliVersion(resolveClaudeCommand()) : null
    const report = await (this.deps.runSetup ?? runClaudeProfileSetupInWorker)({
      dataRoot: this.deps.dataRoot,
      profile,
      userHome: this.deps.userHome(),
      userConfigDir: this.deps.userConfigDir(),
      hooks,
      claudeVersion: claudeVersion ?? undefined
    })
    if (report.outcome === 'prepared') {
      await getClaudeAgentViewService(this.deps.dataRoot).prepareProfile(profile.home)
    }
    if (report.outcome === 'refused' || report.warnings.length > 0) {
      console.warn('[claude-profile] Account setup was incomplete:', report)
    }
    return report
  }
}
