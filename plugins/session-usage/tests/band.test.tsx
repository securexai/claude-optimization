import { expect, test } from 'claude-code/testing'

const BAND = (bodyColumns: number) =>
  ({
    plugin: 'session-usage',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

const USAGE = (usd: number, tokens: number) => ({
  startedAt: 0,
  context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
  rateLimits: [{ kind: 'five_hour', percentUsed: 80 }],
  cost: { usd },
})

const TURN = {
  answer: 'ok',
  durationMs: 4200,
  isAborted: false,
  reason: 'answer',
} as const

test('the bar shows cost, context, limits, totals and the last turn', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  let usage = USAGE(0.5, 10_000)
  on('clock.now', () => ({ value: 0 }))
  on('command.register', () => ({ value: { command: 'usage-bar' } }))
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('command.run', () => ({ text: '' }))
  // What sits beneath in the band: another mod's row (cache-tax's) or the engine's.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Spend between turns, as another mod's keepwarm ping, lands on no turn.
  usage = USAGE(0.6, 10_000)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  usage = USAGE(0.75, 50_000)
  await $.turn.complete({
    ...TURN,
    turnId: 't1',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    },
  })
  // A subagent's turn adds to the totals, never becomes the last turn.
  await $.turn.complete({
    ...TURN,
    turnId: 'a1',
    agentId: 'agent-1',
    usage: {
      model: 'claude-haiku-5-5',
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })
  await $.session.measure({ ...USAGE(0.8, 60_000), changed: ['cost', 'context'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND(200), surface })

    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    expect((await ui.find({ key: 'bar' }))?.props.justifyContent).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^\$/ }))?.text).toBe('$0.800')
    expect((await ui.find({ type: 'Text', text: /ctx/ }))?.text).toBe(
      ' · ctx 60.0k/200.0k ███░░░░░░░ 30%',
    )
    expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe(' · 5h 80%')
    expect((await ui.find({ type: 'Text', text: /in / }))?.text).toBe(
      ' · in 10.5k out 2.1k cache 86%',
    )
    expect((await ui.find({ type: 'Text', text: /last/ }))?.text).toBe(
      ' · last opus-5-5 10.0k→2.0k $0.150 4s',
    )
    await ui.unmount()
  }

  // A narrow terminal keeps the leading segments and drops the rest.
  const narrow = await $.ui.mount({ ...BAND(50), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /ctx/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /last/ })).toBeUndefined()
  await narrow.unmount()

  // The command hides it; the engine's own band then shows through.
  await $.command.run({
    command: 'usage-bar',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 200 },
  })
  const hidden = await $.ui.mount({ ...BAND(200), surface: 'terminal' })
  expect(await hidden.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  expect((await hidden.find({ type: 'Text' }))?.text).toBe('engine')
  await hidden.unmount()
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('state.get', (_, e) =>
    e.key === 'isHidden'
      ? { value: { value: undefined, version: 0 } }
      : { value: { value: [{ model: 'x' }], version: 1 } },
  )

  const ui = await $.ui.mount({ ...BAND(200), surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^–$/ }))?.text).toBe('–')
  expect(await ui.find({ type: 'Text', text: /last/ })).toBeUndefined()
  await ui.unmount()
})
