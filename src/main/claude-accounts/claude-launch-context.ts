/** What a Claude launch knows about where it runs, so routing can prefer a repo pin or a pane's account. */
export type ClaudeLaunchContext = {
  /** The launch working directory; names the repo whose orca.yaml or settings pin applies. */
  cwd?: string | null
  /** The Orca workspace id (`${repoId}::${path}` for worktrees), when the launch belongs to one. */
  workspaceId?: string | null
  /** A terminal pane key or a chat session id, so later launches in that pane keep its account. */
  paneId?: string | null
  paneKind?: ClaudePaneKind
}

export type ClaudePaneKind = 'terminal' | 'session'

/** Where a launch's account came from, in precedence order. */
export type ClaudeLaunchAccountSource = 'repo-pin' | 'pane' | 'rotation' | 'global'
