import { restoreJournal } from '../../agent-session-journal/replay/journal-open'
import { renderJournalStatus } from '../../agent-session-journal/projection/journal-public-read'
import { journalInputOrder } from '../../agent-session-journal/input-order/journal-input-order'
import {
  latestNativeChatUsageLimitCut,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type Database from '../../../sqlite/sync-database'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { sendStructuredAgentSessionTurn } from '../operations/structured-agent-session-host-mutations'

export type Cut = NativeChatUsageLimitCut & { resetsAt: number; turnEndedAt: number }
export type Attempt = { identity: string; count: number; at: number; unconfirmed?: boolean }
export type Deps = {
  host: Pick<StructuredAgentSessionHostDeps, 'usageLimitAutoContinue' | 'logger'> & {
    store: Pick<
      AgentSessionRecordStore,
      | 'listVisibleSessionIds'
      | 'getRecord'
      | 'hostId'
      | 'isSessionTabVisible'
      | 'cancelUsageLimitContinue'
    >
  }
  sessions: ReadonlyMap<string, unknown>
  /** Reads an unopened chat's saved cut; history-sized, so the sweep budgets it. */
  readSavedCut: (id: string) => NativeChatUsageLimitCut | null
  serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>
  send: (
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ) => ReturnType<typeof sendStructuredAgentSessionTurn>
  readLoadedCut: (id: string) => NativeChatUsageLimitCut | null
  publish: (id: string) => void
  now: () => number
}

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
export function readSavedUsageLimitCut(
  db: Database.Database,
  id: string
): NativeChatUsageLimitCut | null {
  const load = restoreJournal(db, id)
  const snapshot =
    load && !load.newer && !load.damage
      ? renderJournalStatus(load.state, journalInputOrder(load.state))
      : null
  return snapshot ? latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions) : null
}

export const identity = (cut: NativeChatUsageLimitCut): string =>
  JSON.stringify([cut.turnItemId, cut.resetsAt])
