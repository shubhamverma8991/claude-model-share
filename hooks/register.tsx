import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ModelRow, Snapshot } from '../types'

// Share of tokens per model across every Claude Code session on this computer,
// for the current weekly limit window, shown in a pane and the status line.

const PANE = 'model-share'
const TITLE = 'Model share'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const LIMIT_KEY = 'limit'
// The meter's quiet track.
const TRACK = '#3A3A3C'
// Recount this often while a session is open. Local file scan only: no model
// calls, no tokens.
const DEFAULT_REFRESH_MS = 3 * 60_000
const REFRESH_KEY = 'refreshMs'
// The choices offered in the pane; 0 is off.
const INTERVALS = [
  { value: String(60_000), label: '1 min' },
  { value: String(3 * 60_000), label: '3 min' },
  { value: String(5 * 60_000), label: '5 min' },
  { value: String(10 * 60_000), label: '10 min' },
  { value: '0', label: 'Off' },
] as const
const intervalLabel = (ms: number) =>
  ms <= 0 ? 'off' : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`

type SavedLimit = { weekPct: number; resetsAt?: string; at: number }

// The auto-refresh interval in ms (0 = off), kept in $.store across sessions.
const refreshEvery = atom({ plugin: 'model-share', key: 'refreshMs' } as const, DEFAULT_REFRESH_MS)

const snapshot = atom({ plugin: 'model-share', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})

type Scan = { models: Record<string, number>; files: number; start: number }

// Brand-ish colors per model family, readable on dark and light.
const COLORS: Record<string, string> = {
  Opus: '#D97757',
  Sonnet: '#6A9BCC',
  Fable: '#7FB069',
  Haiku: '#C9A227',
}
const colorOf = (name: string) => COLORS[name.split(' ')[0] ?? ''] ?? '#9A8FD1'

// "claude-sonnet-5-5-20261001[1m]" -> "Sonnet 5.5"
const pretty = (id: string): string => {
  const m = id.replace(/\[.*\]$/, '').match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/)
  const family = m?.[1]
  if (!m || !family) return id
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

const rowsOf = (models: Record<string, number>): ModelRow[] => {
  const merged: Record<string, number> = {}
  for (const [id, n] of Object.entries(models)) merged[pretty(id)] = (merged[pretty(id)] ?? 0) + n
  const total = Object.values(merged).reduce((a, b) => a + b, 0)
  if (total === 0) return []
  return Object.entries(merged)
    .map(([name, tokens]) => ({ name, tokens, pct: (tokens / total) * 100 }))
    .sort((a, b) => b.pct - a.pct)
}

// Whole numbers in proportion to `values` that add up to exactly `total`
// (largest remainder), so displayed figures and bar widths always agree.
const apportion = (values: number[], total: number): number[] => {
  const sum = values.reduce((a, b) => a + b, 0)
  if (sum <= 0) return values.map(() => 0)
  const exact = values.map(v => (v / sum) * total)
  const out = exact.map(Math.floor)
  let rest = total - out.reduce((a, b) => a + b, 0)
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (rest <= 0) break
    out[i] = (out[i] ?? 0) + 1
    rest -= 1
  }
  return out
}

const fmtPct = (pct: number) => (pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`)
const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`
const when = (ms: number) =>
  new Date(ms).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
const left = (ms: number) => {
  const h = Math.max(0, Math.round(ms / 3_600_000))
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`
}

// Each model's share of what was used this week, whatever the limit stands
// at: the week's usage is the whole (100%). Whole percents adding up to 100.
const sharesOf = (snap: Snapshot): number[] => apportion(snap.rows.map(r => r.pct), 100)

const statusLine = (snap: Snapshot) => {
  const shares = sharesOf(snap)
  const used = snap.weekPct !== undefined ? ` (${fmtPct(snap.weekPct)} used)` : ''
  return `This week${used}: ${snap.rows.map((x, i) => `${x.name} ${shares[i]}%`).join(' · ')}`
}

// How the week's usage compares with the time gone: on pace when the limit
// used is no further along than the week, and when 100% comes at this rate.
type Pace = { weekGone: number; tone: 'success' | 'warning' | 'error'; text: string }
const paceOf = (used: number, start: number, reset: number, now: number): Pace | undefined => {
  const weekGone = Math.min(100, Math.max(0, ((now - start) / (reset - start)) * 100))
  if (weekGone < 2) return undefined
  const ratio = used / weekGone
  const hitsFullAt = start + ((now - start) * 100) / Math.max(used, 0.1)
  const day = new Date(hitsFullAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })
  if (used >= 100) return { weekGone, tone: 'error', text: 'Weekly limit reached' }
  if (ratio <= 1) return { weekGone, tone: 'success', text: 'On pace · lasts the whole week' }
  if (hitsFullAt >= reset) return { weekGone, tone: 'warning', text: 'A little ahead of pace · should last' }
  return { weekGone, tone: ratio > 1.5 ? 'error' : 'warning', text: `Ahead of pace · hits 100% ~${day}` }
}

// Recount from the session files and publish the result.
const refresh = async ($: EngineInterface): Promise<Snapshot> => {
  let start: number | 'auto' = 'auto'
  let resetsAt: string | undefined
  let weekPct: number | undefined
  try {
    const week = (await $.session.usage()).rateLimits.find(r => r.kind === 'seven_day')
    weekPct = week?.percentUsed
    const end = week?.resetsAt ? Date.parse(week.resetsAt) : NaN
    if (!Number.isNaN(end)) {
      start = end - WEEK_MS
      resetsAt = week?.resetsAt
    }
  } catch {}

  // Some clients (the VS Code extension) don't get the limit's percentage.
  // Remember the last one any session saw for this window, and fall back to it.
  let weekPctAt: number | undefined
  const now = await $.clock.now()
  if (weekPct !== undefined) {
    await $.store.set(LIMIT_KEY, { weekPct, resetsAt, at: now } satisfies SavedLimit)
  } else {
    const saved = (await $.store.get(LIMIT_KEY)) as SavedLimit | undefined
    const savedEnd = saved?.resetsAt ? Date.parse(saved.resetsAt) : NaN
    const isSameWindow = resetsAt ? saved?.resetsAt === resetsAt : savedEnd > now
    if (saved && isSameWindow) {
      weekPct = saved.weekPct
      weekPctAt = saved.at
      if (!resetsAt && saved.resetsAt) {
        resetsAt = saved.resetsAt
        start = savedEnd - WEEK_MS
      }
    }
  }

  let snap: Snapshot
  try {
    const r = await $.process.run(
      ['python3', '-I', `${$.plugin.root}/hooks/scan.py`, String(start)],
      { timeoutMs: 60_000 },
    )
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `scan exited ${r.exitCode}`)
    const scan = JSON.parse(r.stdout) as Scan
    snap = {
      rows: rowsOf(scan.models), start: scan.start, resetsAt, weekPct, weekPctAt,
      files: scan.files, updatedAt: await $.clock.now(),
    }
  } catch (err) {
    snap = {
      rows: [], start: typeof start === 'number' ? start : 0, resetsAt, weekPct, weekPctAt, files: 0,
      updatedAt: await $.clock.now(), error: err instanceof Error ? err.message : String(err),
    }
  }

  await update($, snapshot, () => snap)
  $.ui.status(
    snap.error
      ? `Model share: scan failed (${snap.error})`
      : snap.rows.length
        ? statusLine(snap)
        : undefined,
  )
  return snap
}

// The running auto-refresh timer; a reload of the mod drops it and
// session.start sets a new one.
let timer: Timer | undefined

const schedule = ($: EngineInterface, ms: number) => {
  timer?.cancel()
  timer = ms > 0 ? $.clock.every(ms, () => void refresh($)) : undefined
}

const setRefreshEvery = async ($: EngineInterface, ms: number) => {
  await $.store.set(REFRESH_KEY, ms)
  await update($, refreshEvery, () => ms)
  schedule($, ms)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-share',
      description: "Open the pane showing which models this week's Claude Code usage went to",
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    // Picks up usage from your other sessions while this one sits idle.
    const saved = Number(await $.store.get(REFRESH_KEY))
    const ms = Number.isFinite(saved) && saved >= 0 ? saved : DEFAULT_REFRESH_MS
    await update($, refreshEvery, () => ms)
    schedule($, ms)
    return next(e)
  })

  // The weekly limit's figures can arrive after the session starts (another
  // client's first reply): recount when they move.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) void refresh($)
    return result
  })

  // Recount after each reply, without holding up the turn.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    return result
  })

  on('command.run', { command: 'model-share' }, async ($, e) => {
    // `/model-share every 5m` (or 90s, 2 or off) sets the auto-refresh interval.
    const every = e.args.trim().match(/^every\s+(off|0|(\d+)\s*(s|m|min)?)$/i)
    if (every) {
      const n = Number(every[2] ?? 0)
      const ms = every[1]?.toLowerCase() === 'off' || n === 0 ? 0 : every[3]?.toLowerCase() === 's' ? n * 1000 : n * 60_000
      if (ms > 0 && ms < 30_000) return { text: 'Model share: pick 30s or more.' }
      await setRefreshEvery($, ms)
      return { text: ms ? `Model share auto refresh: every ${intervalLabel(ms)}.` : 'Model share auto refresh: off.' }
    }
    if (e.args.trim()) return { text: 'Usage: /model-share, or /model-share every <1m | 3m | 5m | 90s | off>' }
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
    const snap = await refresh($)
    if (snap.error) return { text: `Model share: scan failed (${snap.error})` }
    const shares = sharesOf(snap)
    const rows = snap.rows
      .map((x, i) => `${x.name.padEnd(14)} ${`${shares[i]}%`.padStart(4)}`)
      .join('\n')
    return {
      text: `${isPlaced ? 'Model share pane opened.' : 'Model share this week:'}${snap.weekPct !== undefined ? ` (${fmtPct(snap.weekPct)} of the weekly limit used)` : ''}\n${rows || 'No usage yet this week.'}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const everyMs = await read($, refreshEvery)

    if (!snap) return <Text dimColor>Counting this week's usage…</Text>

    const shares = sharesOf(snap)
    const reset = snap.resetsAt ? Date.parse(snap.resetsAt) : snap.start + WEEK_MS
    const pace =
      snap.weekPct !== undefined ? paceOf(snap.weekPct, snap.start, reset, snap.updatedAt) : undefined

    // One labelled meter row: label, a rounded-feel bar, figure. Boxes, not
    // glyphs, so it draws the same width on every surface and font.
    const meter = (label: string, pct: number, fill: string, isStrong: boolean) => (
      <Box key={`meter-${label}`} flexDirection="row" alignItems="center" gap={1}>
        <Box width={5}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexDirection="row" flexGrow={1} height={1} backgroundColor={TRACK}>
          <Box width={`${Math.round(Math.min(100, Math.max(0, pct)))}%`} height={1} backgroundColor={fill}>
            <Text> </Text>
          </Box>
        </Box>
        <Box width={4} justifyContent="flex-end">
          <Text bold={isStrong} dimColor={!isStrong}>{fmtPct(pct)}</Text>
        </Box>
      </Box>
    )

    const clock = (ms: number) =>
      new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>MODEL SHARE · THIS WEEK</Text>
          {snap.weekPct !== undefined ? (
            <Box flexDirection="row" gap={1}>
              <Text bold color={pace?.tone ?? 'claude'}>{fmtPct(snap.weekPct)}</Text>
              <Text dimColor>used</Text>
            </Box>
          ) : null}
        </Box>
        {snap.weekPct !== undefined ? (
          <Box flexDirection="column" marginTop={1}>
            {meter('Used', snap.weekPct, pace?.tone ?? 'claude', true)}
            {pace ? <Text color={pace.tone}>● <Text dimColor>{pace.text}</Text></Text> : null}
          </Box>
        ) : null}
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{when(snap.start)} → {when(reset)}</Text>
          <Text dimColor>resets in {left(reset - snap.updatedAt)}</Text>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginY={1}>
          {snap.error ? (
            <Text color="error">Scan failed: {snap.error}</Text>
          ) : snap.rows.length === 0 ? (
            <Text dimColor>No Claude Code usage yet this week.</Text>
          ) : (
            snap.rows.map((r, i) => (
              <Box key={`row-${r.name}`} flexDirection="row" justifyContent="space-between">
                <Box flexDirection="row" gap={1}>
                  <Text color={colorOf(r.name)}>■</Text>
                  <Text color={colorOf(r.name)} bold>{r.name}</Text>
                </Box>
                <Box flexDirection="row" gap={2}>
                  <Text dimColor>{fmtTokens(r.tokens)} tok</Text>
                  <Text bold>{shares[i]}%</Text>
                </Box>
              </Box>
            ))
          )}
        </Box>

        <Text dimColor>
          Claude Code only · {snap.files} files · updated {clock(snap.updatedAt)}
          {snap.weekPctAt !== undefined ? ` · limit as of ${clock(snap.weekPctAt)}` : ''}
        </Text>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
          <Select
            key="auto-refresh"
            label="Auto refresh"
            options={INTERVALS}
            value={INTERVALS.some(o => o.value === String(everyMs)) ? String(everyMs) : undefined}
            onSelect={value => void setRefreshEvery($, Number(value))}
          />
          <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
