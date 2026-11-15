/** Raw token counts: input is fresh input plus cache writes; cached is cache reads. */
export type TokenSplit = { input: number; output: number; cached: number }

export type ModelRow = { name: string; pct: number; tokens: number; split?: TokenSplit }

/** The 5-hour limit: percent used and when it resets. */
export type FiveHour = { pct: number; resetsAt?: string }

/** This session's context window: percent and tokens used, and where they go. */
export type ContextUse = {
  pct: number
  used: number
  window: number
  messages: number
  tools: number
  other: number
}

export type Snapshot = {
  rows: ModelRow[]
  /** Window start, epoch ms. */
  start: number
  /** When the weekly limit resets (ISO), when known. */
  resetsAt?: string
  /** Weekly limit used, 0-100, when known. */
  weekPct?: number
  /** When weekPct was read by another session (this one has none), epoch ms. */
  weekPctAt?: number
  /** The 5-hour limit, when Claude Code reports one. */
  fiveHour?: FiveHour
  /** This session's context window. */
  context?: ContextUse
  /** Claude Code's Auto-compact setting, when /config has the row. */
  autoCompact?: boolean
  files: number
  updatedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-share': { snapshot: Shaped<Snapshot | null>; refreshMs: number; showSplit: boolean }
  }
}
