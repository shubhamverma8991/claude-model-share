import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ContextUse, FiveHour, ModelRow, Snapshot, TokenSplit } from '../types'

// Share of tokens per model across every Claude Code session on this computer,
// for the current weekly limit window, shown in a pane and the status line.

const PANE = 'model-share'
const TITLE = 'Model share'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const CONTEXT_COLOR = '#5BC8E8'
const TOOLS_COLOR = '#A78BFA'
const OTHER_COLOR = '#6E6E73'
const TICK_COLOR = '#A1A1A6'
const TONE_HEX = { success: '#7FB069', warning: '#D9A23B', error: '#E5534B' } as const
// The desktop bar's thickness in CSS pixels.
const BAR_PX = 6
const LIMIT_KEY = 'limit'
// The meter's quiet track.
const TRACK = '#3A3A3C'
// Recount this often while a session is open. Local file scan only: no model
// calls, no tokens.
const DEFAULT_REFRESH_MS = 3 * 60_000
const REFRESH_KEY = 'refreshMs'
const SPLIT_KEY = 'showSplit'
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
type SavedFive = { pct: number; resetsAt?: string; at: number }
const FIVE_KEY = 'fiveHour'

// The auto-refresh interval in ms (0 = off), kept in $.store across sessions.
const refreshEvery = atom({ plugin: 'model-share', key: 'refreshMs' } as const, DEFAULT_REFRESH_MS)

// Whether each model's row also shows its input / output / cached tokens,
// kept in $.store across sessions.
const showSplit = atom({ plugin: 'model-share', key: 'showSplit' } as const, false)

const snapshot = atom({ plugin: 'model-share', key: 'snapshot' } as const, null, {
  shape: 'snapshot-3',
})

type Scan = {
  models: Record<string, number>
  split?: Record<string, TokenSplit>
  files: number
  start: number
}

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

// Rows per display name: ids that read the same ("claude-opus-5-5" and its
// 1M-context variant) are merged, their token splits summed.
const rowsOf = (models: Record<string, number>, split: Record<string, TokenSplit> = {}): ModelRow[] => {
  const merged: Record<string, number> = {}
  const splits: Record<string, TokenSplit> = {}
  for (const [id, n] of Object.entries(models)) {
    const name = pretty(id)
    merged[name] = (merged[name] ?? 0) + n
    const one = split[id]
    if (one) {
      const sum = splits[name] ?? { input: 0, output: 0, cached: 0 }
      splits[name] = {
        input: sum.input + one.input,
        output: sum.output + one.output,
        cached: sum.cached + one.cached,
      }
    }
  }
  const total = Object.values(merged).reduce((a, b) => a + b, 0)
  if (total === 0) return []
  return Object.entries(merged)
    .map(([name, tokens]) => ({ name, tokens, pct: (tokens / total) * 100, split: splits[name] }))
    .sort((a, b) => b.pct - a.pct)
}

const splitLine = (t: TokenSplit) =>
  `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cached ${fmtTokens(t.cached)}`

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
  const hours = Math.max(0, Math.round(ms / 3_600_000))
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`
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
// "4h 52m", "35m", "2d 3h": time left, compact.
const leftHm = (ms: number) => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins >= 24 * 60) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
}

type Pace = { weekGone: number; tone: 'success' | 'warning' | 'error'; text: string }
const paceOf = (used: number, start: number, reset: number, now: number): Pace | undefined => {
  const weekGone = Math.min(100, Math.max(0, ((now - start) / (reset - start)) * 100))
  if (weekGone < 2) return undefined
  const ratio = used / weekGone
  const hitsFullAt = start + ((now - start) * 100) / Math.max(used, 0.1)
  const day = new Date(hitsFullAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })
  const resets = `resets in ${leftHm(reset - now)}`
  if (used >= 100) return { weekGone, tone: 'error', text: `Limit reached – ${resets}` }
  if (ratio <= 1) return { weekGone, tone: 'success', text: `On pace – ${resets}` }
  if (hitsFullAt >= reset) return { weekGone, tone: 'warning', text: `Slightly ahead, should last – ${resets}` }
  return { weekGone, tone: ratio > 1.5 ? 'error' : 'warning', text: `Hits 100% ~${day} – ${resets}` }
}


// The 5-hour window's pace: where it lands by the reset at this rate, and how
// much of the window has gone (for the bar's even-pace tick).
const fiveHourPace = (f: FiveHour, now: number) => {
  const reset = f.resetsAt ? Date.parse(f.resetsAt) : NaN
  if (Number.isNaN(reset)) return { tone: 'success' as const, text: '', gone: undefined }
  const resets = `resets in ${leftHm(reset - now)}`
  const elapsed = now - (reset - FIVE_HOURS_MS)
  const gone = Math.min(1, Math.max(0, elapsed / FIVE_HOURS_MS))
  if (f.pct >= 100) return { tone: 'error' as const, text: `Limit reached – ${resets}`, gone }
  if (gone < 0.03 || f.pct <= 0) return { tone: 'success' as const, text: resets, gone }
  const projected = f.pct / gone
  if (projected <= 100) {
    return {
      tone: projected <= 80 ? ('success' as const) : ('warning' as const),
      text: `On pace for ~${Math.round(projected)}% by reset – ${resets}`,
      gone,
    }
  }
  const hitsIn = (elapsed * 100) / f.pct - elapsed
  return { tone: 'error' as const, text: `Hits 100% in ~${leftHm(hitsIn)} – ${resets}`, gone }
}

// The context window, from the status line's figures and the local
// /context estimate (no API call): messages, tools, and everything else used.
const contextOf = (usage: Awaited<ReturnType<EngineInterface['session']['usage']>>): ContextUse | undefined => {
  const c = usage.context
  if (!c.window) return undefined
  const parts = { messages: 0, tools: 0, other: 0 }
  for (const cat of c.breakdown?.categories ?? []) {
    if (cat.kind !== 'used' || cat.isDeferred) continue
    if (cat.name === 'Messages') parts.messages += cat.tokens
    else if (/tool/i.test(cat.name)) parts.tools += cat.tokens
    else parts.other += cat.tokens
  }
  const used = c.tokens ?? c.breakdown?.totalTokens ?? parts.messages + parts.tools + parts.other
  return { pct: c.percent ?? (used / c.window) * 100, used, window: c.window, ...parts }
}

// Compacts the conversation, as /compact does; refused while Claude replies.
const compactNow = async ($: EngineInterface) => {
  try {
    const r = await $.session.compact()
    $.ui.toast(r.skip ? `Compact skipped: ${r.skip}` : 'Conversation compacted.')
  } catch {
    $.ui.toast("Can't compact while Claude is replying. Try again when it's done.")
  }
  await refresh($)
}

// Claude Code's own Auto-compact setting, as /config shows and changes it.
const toggleAutoCompact = async ($: EngineInterface) => {
  const row = (await $.config.list()).find(r => r.key === 'autoCompact')
  if (!row) return $.ui.toast('Auto-compact setting not found in this Claude Code version.')
  const { deny } = await $.config.set({ key: 'autoCompact', value: row.value !== true })
  if (deny) $.ui.toast(`Auto-compact not changed: ${deny}`)
  await refresh($)
}

// Recount from the session files and publish the result.
const refresh = async ($: EngineInterface): Promise<Snapshot> => {
  let start: number | 'auto' = 'auto'
  let resetsAt: string | undefined
  let weekPct: number | undefined
  let fiveHour: FiveHour | undefined
  let context: ContextUse | undefined
  let autoCompact: boolean | undefined
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    context = contextOf(usage)
    const five = usage.rateLimits.find(r => r.kind === 'five_hour')
    if (five && Number.isFinite(five.percentUsed)) fiveHour = { pct: five.percentUsed, resetsAt: five.resetsAt }
    const week = usage.rateLimits.find(r => r.kind === 'seven_day')
    weekPct = week?.percentUsed
    const end = week?.resetsAt ? Date.parse(week.resetsAt) : NaN
    if (!Number.isNaN(end)) {
      start = end - WEEK_MS
      resetsAt = week?.resetsAt
    }
  } catch {}
  try {
    const row = (await $.config.list()).find(r => r.key === 'autoCompact')
    if (typeof row?.value === 'boolean') autoCompact = row.value
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

  // The 5-hour figure, like the weekly one, doesn't reach every client:
  // remember the last one any session saw, while its window is still open.
  if (fiveHour) {
    await $.store.set(FIVE_KEY, { pct: fiveHour.pct, resetsAt: fiveHour.resetsAt, at: now } satisfies SavedFive)
  } else {
    const saved = (await $.store.get(FIVE_KEY)) as SavedFive | undefined
    const end = saved?.resetsAt ? Date.parse(saved.resetsAt) : NaN
    if (saved && Number.isFinite(saved.pct) && end > now) {
      fiveHour = { pct: saved.pct, resetsAt: saved.resetsAt, at: saved.at }
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
      rows: rowsOf(scan.models, scan.split), start: scan.start, resetsAt, weekPct, weekPctAt,
      fiveHour, context, autoCompact,
      files: scan.files, updatedAt: await $.clock.now(),
    }
  } catch (err) {
    snap = {
      rows: [], start: typeof start === 'number' ? start : 0, resetsAt, weekPct, weekPctAt, files: 0,
      fiveHour, context, autoCompact,
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

// A thin rounded bar as SVG, for surfaces that draw Svg: segments laid side by
// side over a quiet track, and an optional tick (0..1) marking even pace.
// Drawn wide and squeezed to its slot (preserveAspectRatio none).
type Segment = { pct: number; color: string }
const barSvg = (segments: Segment[], tick?: number) => {
  const W = 1000
  let x = 0
  const rects = segments
    .map(seg => {
      const w = (Math.min(100, Math.max(0, seg.pct)) / 100) * W
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${Math.min(w, W - x).toFixed(1)}" height="${BAR_PX}" fill="${seg.color}"/>`
      x += w
      return r
    })
    .join('')
  const tickRect =
    tick === undefined ? '' : `<rect x="${Math.min(W - 6, Math.max(0, tick * W - 3)).toFixed(1)}" y="0" width="6" height="${BAR_PX}" fill="${TICK_COLOR}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${BAR_PX}" viewBox="0 0 ${W} ${BAR_PX}" preserveAspectRatio="none">` +
    `<clipPath id="r"><rect width="${W}" height="${BAR_PX}" rx="${BAR_PX / 2}" ry="${BAR_PX / 2}"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${W}" height="${BAR_PX}" fill="${TRACK}"/>${rects}${tickRect}</g></svg>`
  )
}

// The running auto-refresh timer; a reload of the mod drops it and
// session.start sets a new one.
let timer: Timer | undefined

const schedule = ($: EngineInterface, ms: number) => {
  timer?.cancel()
  timer = ms > 0 ? $.clock.every(ms, () => void refresh($)) : undefined
}

const toggleSplit = async ($: EngineInterface) => {
  const next = !(await read($, showSplit))
  await $.store.set(SPLIT_KEY, next)
  await update($, showSplit, () => next)
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
    const isSplitSaved = (await $.store.get(SPLIT_KEY)) === true
    await update($, showSplit, () => isSplitSaved)
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
      .map((x, i) => `${x.name.padEnd(14)} ${`${shares[i]}%`.padStart(4)}${x.split ? `   ${splitLine(x.split)}` : ''}`)
      .join('\n')
    return {
      text: `${isPlaced ? 'Model share pane opened.' : 'Model share this week:'}${snap.weekPct !== undefined ? ` (${fmtPct(snap.weekPct)} of the weekly limit used)` : ''}\n${rows || 'No usage yet this week.'}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Select } = table
    // Thin SVG bars only in the desktop app: VS Code draws an Svg at full
    // width, which breaks the label / bar / figure row apart.
    const Svg = e.surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
    // VS Code draws each spacing step much taller than the desktop app.
    const space = e.surface === 'vscode' ? 0 : 1
    const snap = await read($, snapshot)
    const everyMs = await read($, refreshEvery)
    const isSplit = await read($, showSplit)

    if (!snap) return <Text dimColor>Counting this week's usage…</Text>

    const shares = sharesOf(snap)
    const reset = snap.resetsAt ? Date.parse(snap.resetsAt) : snap.start + WEEK_MS
    const pace =
      snap.weekPct !== undefined ? paceOf(snap.weekPct, snap.start, reset, snap.updatedAt) : undefined
    const five = snap.fiveHour ? fiveHourPace(snap.fiveHour, snap.updatedAt) : undefined
    const ctx = snap.context
    const clock = (ms: number) =>
      new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    // A bar: thin rounded SVG where the surface draws it, else coloured cells.
    const bar = (key: string, alt: string, segments: Segment[], tick?: number) =>
      Svg ? (
        <Box key={key} flexGrow={1} flexShrink={1} height={1} alignItems="center">
          <Svg alt={alt} source={barSvg(segments, tick)} height={BAR_PX} />
        </Box>
      ) : (
        <Box key={key} flexDirection="row" flexGrow={1} height={1} backgroundColor={TRACK}>
          {segments.map((seg, i) => (
            <Box key={`${key}-${i}`} width={`${Math.round(Math.min(100, Math.max(0, seg.pct)))}%`} height={1} backgroundColor={seg.color}>
              <Text> </Text>
            </Box>
          ))}
        </Box>
      )

    // One meter: label, bar, figure on a row; a dim status line under it.
    const meter = (label: string, pct: number, segments: Segment[], tone: string, note: string, tick?: number) => (
      <Box key={`meter-${label}`} flexDirection="column">
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box width={7} flexShrink={0}>
            <Text>{label}</Text>
          </Box>
          {bar(`bar-${label}`, `${label} ${fmtPct(pct)} used`, segments, tick)}
          <Box width={4} flexShrink={0} justifyContent="flex-end">
            <Text bold color={tone}>{fmtPct(pct)}</Text>
          </Box>
        </Box>
        {note ? <Text dimColor wrap="truncate-end">{note}</Text> : null}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>MODEL SHARE</Text>
          <Text dimColor>updated {clock(snap.updatedAt)}</Text>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} paddingY={space} gap={space}>
          <Box flexDirection="column" gap={space}>
            {snap.fiveHour && five
              ? meter(
                  '5 Hour',
                  snap.fiveHour.pct,
                  [{ pct: snap.fiveHour.pct, color: TONE_HEX[five.tone] }],
                  TONE_HEX[five.tone],
                  five.text,
                  five.gone,
                )
              : null}
            {snap.weekPct !== undefined
              ? meter(
                  'Weekly',
                  snap.weekPct,
                  [{ pct: snap.weekPct, color: TONE_HEX[pace?.tone ?? 'success'] }],
                  TONE_HEX[pace?.tone ?? 'success'],
                  pace?.text ?? `resets in ${leftHm(reset - snap.updatedAt)}`,
                  pace ? pace.weekGone / 100 : undefined,
                )
              : null}
            {snap.weekPctAt !== undefined || snap.fiveHour?.at !== undefined ? (
              <Text dimColor>Limits as of {clock(snap.weekPctAt ?? snap.fiveHour?.at ?? snap.updatedAt)}</Text>
            ) : null}
          </Box>

          {ctx ? (
            <Box flexDirection="column">
              {meter(
                'Context',
                ctx.pct,
                [
                  { pct: (ctx.messages / ctx.window) * 100, color: CONTEXT_COLOR },
                  { pct: (ctx.tools / ctx.window) * 100, color: TOOLS_COLOR },
                  { pct: (ctx.other / ctx.window) * 100, color: OTHER_COLOR },
                ],
                ctx.pct >= 80 ? TONE_HEX.error : ctx.pct >= 60 ? TONE_HEX.warning : TONE_HEX.success,
                '',
              )}
              <Text dimColor wrap="truncate-end">
                <Text color={CONTEXT_COLOR}>Messages</Text> {fmtTokens(ctx.messages)} · <Text color={TOOLS_COLOR}>Tools</Text>{' '}
                {fmtTokens(ctx.tools)} · Other {fmtTokens(ctx.other)}
              </Text>
              <Box flexDirection="row" gap={1} marginTop={space}>
                <Button key="compact" label="Compact" onPress={() => void compactNow($)} />
                {snap.autoCompact !== undefined ? (
                  <Button
                    key="auto-compact"
                    label={`Auto compact: ${snap.autoCompact ? 'On' : 'Off'}`}
                    onPress={() => void toggleAutoCompact($)}
                  />
                ) : null}
              </Box>
            </Box>
          ) : null}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          {snap.error ? (
            <Text color="error">Scan failed: {snap.error}</Text>
          ) : snap.rows.length === 0 ? (
            <Text dimColor>No Claude Code usage yet this week.</Text>
          ) : (
            snap.rows.map((r, i) => (
              <Box key={`row-${r.name}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  <Box flexDirection="row" gap={1}>
                    <Text color={colorOf(r.name)}>■</Text>
                    <Text color={colorOf(r.name)} bold>{r.name}</Text>
                  </Box>
                  <Box flexDirection="row" gap={2}>
                    <Text dimColor>{fmtTokens(r.tokens)} tok</Text>
                    <Text bold>{shares[i]}%</Text>
                  </Box>
                </Box>
                {isSplit && r.split ? (
                  <Box paddingLeft={2}>
                    <Text dimColor>{splitLine(r.split)}</Text>
                  </Box>
                ) : null}
              </Box>
            ))
          )}
        </Box>

        <Box flexDirection="column">
          <Text dimColor>Claude Code only · {snap.files} files this week</Text>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
            <Select
              key="auto-refresh"
              label="Auto refresh"
              options={INTERVALS}
              value={INTERVALS.some(o => o.value === String(everyMs)) ? String(everyMs) : undefined}
              onSelect={value => void setRefreshEvery($, Number(value))}
            />
            <Box flexDirection="row" gap={1}>
              <Button
                key="split"
                label={isSplit ? 'Hide split' : 'In / out'}
                onPress={() => void toggleSplit($)}
              />
              <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
}
