// Session Pulse's state contract: what each session publishes about itself
// (a Beat), what the board draws (a Row), and the person's display settings.

/** Where a session stands. `stopped` is an interrupted turn. */
export type PulseState = 'working' | 'waiting' | 'done' | 'stopped' | 'error' | 'idle'

/** A task plan the session is following, from TodoWrite, the Task tools or another mod. */
export type Plan = {
  done: number
  active: number
  total: number
  source: string
  /** When `done` or `active` last changed. */
  changedAt: number
}

/** One session's heartbeat, written to its own file under mods-data. */
export type Beat = {
  v: 1
  /** The Claude Code session id (the transcript's name). */
  id: string
  /** The desktop app's `local_…` id, or '' outside the desktop app. */
  hostId: string
  surface: string
  title: string
  /** The working directory's last folder name. */
  project: string
  cwd: string
  state: PulseState
  /** When the board first saw the session: rows keep this order, so they never jump under the pointer. */
  bornAt: number
  /** When the current (or last) turn started. */
  startedAt: number
  /** When the last turn ended; 0 while working. */
  endedAt: number
  /** Time spent waiting on the person during this turn. */
  waitMs: number
  /** When the current wait began; 0 when not waiting. */
  waitingSince: number
  tools: number
  activity: string
  plan: Plan | null
  /** When the current plan first appeared. */
  planAt: number
  /** How long this turn was expected to take when it started. */
  expectMs: number
  turns: number
  lastMs: number
  /** The bar's position when an interrupted or failed turn stopped. */
  stopPct: number
  /** Subagents still running after the turn ended. */
  agents: number
  /** What the session needs from you while waiting, in a few words ("allow bash"); '' otherwise. */
  need?: string
  ended?: boolean
  updatedAt: number
}

/** A board row: a beat plus how this viewer sees it. */
export type Row = Beat & {
  isSelf: boolean
  isHidden: boolean
  isStale: boolean
}

export type Prefs = {
  /** `full`: a row per session; `compact`: one summary line; `off`: no band. */
  mode: 'full' | 'compact' | 'off'
  /** Toast when another session finishes or needs you. */
  alerts: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-pulse': {
      rows: Row[]
      now: number
      prefs: Prefs
      isMasked: boolean
    }
  }
}
