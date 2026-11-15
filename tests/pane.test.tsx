import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'model-share',
  component: 'Pane',
  requestId: 'model-share',
  props: {
    title: 'Model share',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SCAN = {"models": {"claude-opus-5-5": 5630816.899999999, "claude-fable-5-2": 8134257.100000002, "claude-sonnet-5-5": 7094939.8}, "files": 31, "start": 1794492000000}

test('the pane shows each model with its share, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'model-share' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {},
      rateLimits: [{ kind: 'seven_day', percentUsed: 59, resetsAt: '2026-11-19T14:00:00.000Z' }],
    },
  }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
  on('ui.status', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-14T14:00:00.000Z') }))

  const ran = await $.command.run({ command: 'model-share', args: '' })
  expect(ran.text).toContain('Fable 5.2')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Fable 5\.2$/ }))?.text).toBe('Fable 5.2')
    expect((await ui.find({ type: 'Text', text: /resets in/ }))?.text).toBe('resets in 5d 0h')
    expect(await ui.find({ type: 'Text', text: /^59%$/ })).toBeTruthy()
    // The limit meter: 59% used with 29% of the week gone is well ahead of
    // pace. No second bar for the week itself.
    expect(await ui.find({ type: 'Text', text: /^Weekly$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Week$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /Ahead of pace · hits 100%/ })).toBeTruthy()
    // Each model's share of what was used: the week's usage is the whole.
    const shares = (await ui.findAll({ type: 'Text', text: /^\d+%$/ }))
      .map(t => Number(t.text.slice(0, -1)))
      .slice(-3) // the last three; the limit's 59% comes first
    expect(shares).toEqual([39, 34, 27])
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100)
    await ui.unmount()
  }
})

test('a client without the limit shows the one another session saw', async ($, on) => {
  on('command.register', () => ({ value: { command: 'model-share' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {},
      rateLimits: [{ kind: 'seven_day', percentUsed: undefined, resetsAt: '2026-11-19T14:00:00.000Z' }],
    },
  }))
  on('store.get', () => ({
    value: { weekPct: 59, resetsAt: '2026-11-19T14:00:00.000Z', at: Date.parse('2026-11-14T13:55:00.000Z') },
  }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-14T14:00:00.000Z') }))

  await $.command.run({ command: 'model-share', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /^59%$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /limit as of/ })).toBeTruthy()
  await ui.unmount()
})

test('the pane says it is counting before the first scan', async ($) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/Counting/)
  await ui.unmount()
})

test('the auto-refresh interval can be changed and is saved', async ($, on) => {
  const saved: Record<string, unknown> = {}
  on('command.register', () => ({ value: { command: 'model-share' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-14T14:00:00.000Z') }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const set = await $.command.run({ command: 'model-share', args: 'every 5m' })
  expect(set.text).toBe('Model share auto refresh: every 5m.')
  expect(saved.refreshMs).toBe(300_000)

  const off = await $.command.run({ command: 'model-share', args: 'every off' })
  expect(off.text).toBe('Model share auto refresh: off.')
  expect(saved.refreshMs).toBe(0)

  const tooFast = await $.command.run({ command: 'model-share', args: 'every 5s' })
  expect(tooFast.text).toBe('Model share: pick 30s or more.')
})

const SPLIT_SCAN = {"models": {"claude-opus-5-5": 10726238.099999994, "claude-fable-5-2": 8134257.100000002, "claude-sonnet-5-5": 7401049.300000002}, "split": {"claude-opus-5-5": {"input": 2222315, "output": 390896, "cached": 81130271}, "claude-fable-5-2": {"input": 1990422, "output": 324972, "cached": 58188631}, "claude-sonnet-5-5": {"input": 2373003, "output": 347723, "cached": 46803233}}, "files": 31, "start": 1794492000000}

test('In / out shows each model\'s input, output and cached tokens, and is saved', async ($, on) => {
  const saved: Record<string, unknown> = {}
  on('command.register', () => ({ value: { command: 'model-share' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SPLIT_SCAN), stderr: '' } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-15T14:00:00.000Z') }))

  const ran = await $.command.run({ command: 'model-share', args: '' })
  expect(ran.text).toMatch(/Opus 5\.5 .*in [\d.]+[Mk] · out [\d.]+[Mk] · cached [\d.]+M/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^in .* · out / })).toBeFalsy()
  await ui.press({ key: 'split' })
  const lines = await ui.findAll({ type: 'Text', text: /^in .* · out .* · cached / })
  expect(lines.length).toBe(3)
  expect(saved.showSplit).toBe(true)
  await ui.unmount()
})

test('5-hour limit, context and the compact controls', async ($, on) => {
  const calls: string[] = []
  let autoCompact = true
  on('command.register', () => ({ value: { command: 'model-share' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    calls.push(`toast:${e.text}`)
    return { value: undefined }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [
        // 2% used, 30 minutes into the 5-hour window: on pace for about 20%
        { kind: 'five_hour', percentUsed: 2, resetsAt: '2026-11-15T18:30:00.000Z' },
        { kind: 'seven_day', percentUsed: 65, resetsAt: '2026-11-19T14:00:00.000Z' },
      ],
      context: {
        tokens: 395_000,
        window: 1_000_000,
        percent: 39.5,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 341_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'System tools', tokens: 35_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'System prompt', tokens: 19_000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 572_000, color: 'x', isDeferred: false, kind: 'free' },
          ],
        },
      },
    },
  }))
  on('config.list', () => ({
    value: [{ key: 'autoCompact', label: 'Auto-compact', kind: 'boolean', value: autoCompact, isLocked: false }],
  }))
  on('config.set', (_, e) => {
    calls.push(`config:${e.key}=${e.value}`)
    autoCompact = e.value === true
    return { value: e.value }
  })
  on('session.compact', () => {
    calls.push('compact')
    return { skip: 'nothing to compact in a test' }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SPLIT_SCAN), stderr: '' } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-15T14:00:00.000Z') }))

  await $.command.run({ command: 'model-share', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^5 hour$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /On pace for about 20% by reset · resets in 4h 30m/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Messages 341k · Tools 35k · Other 19k/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /605k free of 1\.0M/ })).toBeTruthy()

  await ui.press({ key: 'compact' })
  expect(calls).toContain('compact')
  expect(calls).toContain('toast:Compact skipped: nothing to compact in a test')

  await ui.press({ key: 'auto-compact' })
  expect(calls).toContain('config:autoCompact=false')
  await ui.unmount()
})
