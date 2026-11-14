export type ModelRow = { name: string; pct: number; tokens: number }

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
  files: number
  updatedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-share': { snapshot: Shaped<Snapshot | null>; refreshMs: number }
  }
}
