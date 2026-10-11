// You Should Know's state contract: the last summary /you-should-know produced and whether a check is running.

/** What kind of point it is; the summary sorts by this order, most urgent first. */
export type Tag = 'Risk' | 'Verify' | 'To do' | 'Changed' | 'Assumed' | 'Cost' | 'Note'

/** One thing the person should know. */
export type Point = {
  tag: Tag
  /** The point in a few words. */
  headline: string
  /** One short line of why or what to do; '' when the headline says it all. */
  detail: string
}

/** One finished /you-should-know check. */
export type Note = {
  /** What the side agent found, most urgent first; empty when it found nothing. */
  points: Point[]
  /** The focus the person typed after /you-should-know, or '' for none. */
  focus: string
  /** When the check finished (ms since epoch). */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'you-should-know': { note: Note | null; isChecking: boolean }
  }
}
