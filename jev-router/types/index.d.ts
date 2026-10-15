// Jev Router's state contract: the two toggles and Jev's last skill pick.

/** Jev's answer to "which skill fits this prompt". */
export type Pick = {
  /** A skill name, or 'none'. */
  choice: string
  /** 0 to 1; below 0.6 the pick is not passed on. */
  confidence: number
}

/** Jev's answer to "how complex is this subagent task". */
export type Complexity = {
  /** 1 (lookup) to 4 (deep reasoning). */
  score: number
  confidence: number
}

declare module 'claude-code' {
  interface PluginState {
    'jev-router': { enabled: boolean; modelRouting: boolean; lastPick: Pick | null }
  }
}
