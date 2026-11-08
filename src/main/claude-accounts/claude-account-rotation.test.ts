import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeAccountRotator,
  chooseClaudeRotationTarget,
  type ClaudeRotationCandidate,
  type ClaudeRotationPane
} from './claude-account-rotation'
import type { ClaudePaneAccountRecord } from './claude-pane-account-registry'

function candidate(
  id: string,
  session: number,
  weekly: number,
  extra: Partial<ClaudeRotationCandidate> = {}
): ClaudeRotationCandidate {
  return {
    id,
    runtime: 'host',
    wslDistro: null,
    signedIn: true,
    session: { usedPercent: session, resetsAt: 10_000 + session },
    weekly: { usedPercent: weekly, resetsAt: null },
    ...extra
  }
}

const pane: ClaudeRotationPane = {
  paneId: 'chat-1',
  paneKind: 'session',
  selectionKey: 'host',
  accountId: 'a',
  repoKey: 'repo-1'
}

function rotator(
  candidates: ClaudeRotationCandidate[],
  options: { panes?: ClaudeRotationPane[]; rateLimited?: string[] } = {}
) {
  let now = 1_000_000
  const recorded = new Map<string, ClaudePaneAccountRecord>()
  const log: unknown[] = []
  const notify = vi.fn()
  const restartSession = vi.fn(async () => true)
  const instance = new ClaudeAccountRotator({
    candidates: () => candidates,
    panes: () => options.panes ?? [pane],
    rateLimitedSessions: () => options.rateLimited ?? [],
    globalAccountId: () => 'a',
    recordRotation: (paneId, record) => recorded.set(paneId, record),
    restartSession,
    appendLog: (event) => log.push(event),
    notify,
    now: () => now
  })
  return { instance, recorded, log, notify, restartSession, advance: (ms: number) => (now += ms) }
}

describe('chooseClaudeRotationTarget', () => {
  it('picks the signed-in same-runtime account with the most 5-hour headroom, ties by 7-day', () => {
    const from = candidate('a', 97, 10)
    const chosen = chooseClaudeRotationTarget(
      [
        from,
        candidate('b', 40, 80),
        candidate('c', 40, 20),
        candidate('d', 5, 5, { signedIn: false }),
        candidate('e', 0, 0, { runtime: 'wsl', wslDistro: 'Ubuntu' }),
        candidate('f', 96, 0)
      ],
      from
    )
    expect(chosen?.id).toBe('c')
  })
})

describe('ClaudeAccountRotator', () => {
  it('moves a pane whose account crossed the threshold to the headroom account and restarts the chat', async () => {
    const r = rotator([candidate('a', 95, 10), candidate('b', 30, 30), candidate('c', 60, 10)])
    const events = await r.instance.evaluate()
    expect(events).toEqual([
      expect.objectContaining({
        pane: 'chat-1',
        repo: 'repo-1',
        from: 'a',
        to: 'b',
        reason: 'usage-threshold',
        headroom: { fiveHour: 70, sevenDay: 70 },
        restarted: true
      })
    ])
    expect(r.recorded.get('chat-1')).toMatchObject({
      accountId: 'b',
      source: 'rotation',
      rotatedFromAccountId: 'a',
      globalAccountId: 'a',
      holdUntil: 10_095
    })
    expect(r.restartSession).toHaveBeenCalledWith('chat-1')
    expect(r.log).toHaveLength(1)
  })

  it('rotates a chat that stopped on a rate limit even below the threshold', async () => {
    const r = rotator([candidate('a', 50, 10), candidate('b', 30, 30)], { rateLimited: ['chat-1'] })
    const events = await r.instance.evaluate()
    expect(events.map((event) => [event.reason, event.to])).toEqual([['rate-limited', 'b']])
  })

  it('does nothing and notifies once with the earliest reset when every account is exhausted', async () => {
    const r = rotator([candidate('a', 97, 10), candidate('b', 99, 10), candidate('c', 95, 0)])
    expect(await r.instance.evaluate()).toEqual([])
    expect(await r.instance.evaluate()).toEqual([])
    expect(r.recorded.size).toBe(0)
    expect(r.restartSession).not.toHaveBeenCalled()
    expect(r.notify).toHaveBeenCalledTimes(1)
    expect(r.notify.mock.calls[0][0].body).toContain(new Date(10_095).toLocaleTimeString())
  })

  it('rotates a pane at most once per window', async () => {
    const r = rotator([candidate('a', 97, 10), candidate('b', 30, 30), candidate('c', 20, 50)], {
      panes: [pane, { ...pane, paneId: 'chat-2' }]
    })
    expect((await r.instance.evaluate()).map((event) => event.pane)).toEqual(['chat-1', 'chat-2'])
    r.advance(5 * 60_000)
    expect(await r.instance.evaluate()).toEqual([])
    r.advance(5 * 60_000)
    expect((await r.instance.evaluate()).map((event) => event.pane)).toEqual(['chat-1', 'chat-2'])
  })
})
