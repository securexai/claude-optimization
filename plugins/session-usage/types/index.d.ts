export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

// The figures the status line has, as the last measurement left them.
export type Live = {
  costUsd?: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: RateLimit[]
}

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// One main-loop turn; costUsd is the session total's growth since the last one,
// so a subagent's spend lands on the turn that spawned it.
export type Turn = Tokens & {
  id: string
  model: string
  durationMs: number
  costUsd?: number
}

// Every turn's tokens, main loop and subagents alike.
export type Totals = Tokens & { turns: number; agentTurns: number }

declare module 'claude-code' {
  interface PluginState {
    'session-usage': {
      live: Shaped<Live>
      turns: Shaped<Turn[]>
      totals: Shaped<Totals>
      costMark: Shaped<number>
      isHidden: boolean
    }
  }
}
