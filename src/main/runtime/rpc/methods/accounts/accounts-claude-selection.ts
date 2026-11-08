import { defineMethod } from '../../core'
import {
  SelectClaudeAccountForTargetParams,
  SelectClaudeAccountParams
} from '../../../../../shared/rpc-contract/accounts-params'

export const CLAUDE_SELECTION_METHOD_DEFINITIONS = [
  defineMethod({
    name: 'accounts.selectClaude',
    permission: 'accounts-admin',
    params: SelectClaudeAccountParams,
    handler: async (params, { runtime }) =>
      runtime.selectClaudeAccount(params.accountId, {
        movesRunningSessions: params.movesRunningSessions
      })
  }),
  defineMethod({
    // Use a distinct RPC: old hosts strip unknown target fields and could otherwise clear the host slot.
    name: 'accounts.selectClaudeForTarget',
    permission: 'accounts-admin',
    params: SelectClaudeAccountForTargetParams,
    handler: async (params, { runtime }) =>
      runtime.selectClaudeAccountForTarget(params.accountId, params.target)
  })
]
