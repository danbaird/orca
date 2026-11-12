import type { ClaudeAccountService } from '../../../claude-accounts/service'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import {
  getClaudeSelectionTargetForAccount,
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from '../../../claude-accounts/runtime-selection'
import type { RuntimeNotifier } from '../../client/events/runtime-notifier-contract'

type ClaudeSelectionNotifier = Pick<RuntimeNotifier, 'claudeAccountSelected'>

/** Desktop switches go through IPC and handle their own sessions; this path tells the window. */
export async function selectClaudeAccountNotifying(
  claudeAccounts: Pick<
    ClaudeAccountService,
    'listAccounts' | 'selectAccount' | 'selectAccountForTarget'
  >,
  notifier: ClaudeSelectionNotifier | null,
  accountId: string | null,
  /** CLI and paired clients name the runtime; a desktop select infers it from the account. */
  target?: ClaudeAccountSelectionTarget
): Promise<ClaudeRateLimitAccountsState> {
  const before = claudeAccounts.listAccounts()
  const after = target
    ? await claudeAccounts.selectAccountForTarget(accountId, target)
    : await claudeAccounts.selectAccount(accountId)
  const account = before.accounts.find((candidate) => candidate.id === accountId)
  const effective: ClaudeAccountSelectionTarget =
    target ?? (account ? getClaudeSelectionTargetForAccount(account) : { runtime: 'host' })
  notifier?.claudeAccountSelected?.({
    target: effective,
    before: { state: before, accountId: selectedClaudeAccountId(before, effective) },
    after: { state: after, accountId: selectedClaudeAccountId(after, effective) }
  })
  return after
}

function selectedClaudeAccountId(
  state: ClaudeRateLimitAccountsState,
  target: ClaudeAccountSelectionTarget
): string | null {
  return getSelectedClaudeAccountIdForTarget(
    {
      activeClaudeManagedAccountId: state.activeAccountId,
      activeClaudeManagedAccountIdsByRuntime: state.activeAccountIdsByRuntime
    },
    target
  )
}
