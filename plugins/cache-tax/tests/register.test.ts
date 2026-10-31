import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { CommandRunInput, ConfigRow, ConfigSetInput, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionIdentity, SessionRateLimit, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { statusIcons } from '../hooks/status-icons'
import { belief, fmtDuration, freshState, parseDuration, readOptions, resetForClear, seedFromResume } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the answered arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (command: 'keepwarm' | 'cache-tax' | 'effort', args: string): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const themeChange = (value: string): ConfigSetInput => ({ key: 'theme', value, previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })

type ForkAnswer = null | ModelForkResult | { read: number; write: number; out?: number; input?: number }

// The settings every test sees unless it says otherwise: the one-hour cache the
// tests were written for, and no idle compaction, which they predate.
const ONE_HOUR_WORLD = { promptCacheTtl: '1h', idleCompaction: false }

// The /config rows an interactive session lists for the mod's own options, none locked.
const OWN_ROWS: ConfigRow[] = (['guard', 'keepwarm', 'cacheTtl', 'stopAtPercent'] as const).map(f => ({
  key: `cache-tax.${f}`, label: f, kind: f === 'stopAtPercent' ? 'number' : 'choice', value: f === 'stopAtPercent' ? 95 : f === 'keepwarm' ? 'on' : 'auto',
  provider: { plugin: 'cache-tax', tier: 'user' }, isLocked: false,
}))

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
function world(on: On, forkAnswers: ForkAnswer[], opts: { store?: Map<string, unknown>; commands?: string[]; live?: { tokens?: number }; sid?: string | (() => string); model?: string | (() => string); bandText?: string; theme?: { value: string }; noColor?: boolean; denyTheme?: boolean; writtenTheme?: string; gate?: () => Promise<void>; steps?: TurnUsage[]; storeGate?: (op: 'get' | 'set' | 'delete', key: string) => Promise<void>; env?: Record<string, string>; settings?: Record<string, unknown>; policy?: Record<string, unknown>; limits?: { now: SessionRateLimit[] }; cost?: { usd?: number }; identity?: SessionIdentity | 'throw'; rows?: ConfigRow[]; tools?: { names: string[] } } = {}) {
  if (opts.store) {
    const store = opts.store
    // A read takes its value first and is delivered after the gate, as a reply can arrive late.
    on('store.get', async ($, e) => { const value = store.get(e.key); await opts.storeGate?.('get', e.key); return { value } })
    on('store.set', async ($, e) => { await opts.storeGate?.('set', e.key); store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', async ($, e) => { await opts.storeGate?.('delete', e.key); store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, {})
  const reads = { theme: 0, env: 0 }
  on('env.get', ($, e) => {
    if (e.name === 'NO_COLOR') reads.env++
    return { value: e.name === 'NO_COLOR' ? (opts.noColor ? '1' : undefined) : opts.env?.[e.name] }
  })
  on('config.list', () => {
    reads.theme++
    return { value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme?.value ?? 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }, ...(opts.rows ?? OWN_ROWS)] }
  })
  on('settings.read', ($, e) => ({ value: e.source === 'policy' ? opts.policy ?? {} : { ...ONE_HOUR_WORLD, ...opts.settings } }))
  on('session.identity', () => {
    if (opts.identity === 'throw') throw new Error('$.session.identity is not a function')
    return { value: opts.identity ?? { deny: 'not installed by managed settings' } }
  })
  on('config.set', ($, e) => opts.denyTheme ? { deny: 'theme locked' } : { value: opts.writtenTheme ?? e.value })
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: typeof opts.sid === 'function' ? opts.sid() : opts.sid ?? 'S1' }))
  on('session.model', () => ({ value: typeof opts.model === 'function' ? opts.model() : opts.model ?? 'claude-fable-5-1' }))
  if (opts.tools) {
    const tools = opts.tools
    on('tool.list', () => ({ value: tools.names.map(name => ({ name, description: '', mcp: false })) }))
  }
  on('command.run', { command: 'effort' }, ($, e) => ({ text: `Set effort level to ${e.args}` }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: opts.live?.tokens }, rateLimits: opts.limits?.now ?? [], ...(opts.cost?.usd === undefined ? {} : { cost: { usd: opts.cost.usd } }) } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    const u = opts.steps?.shift() ?? null
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: u }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('classic.PreModelSwitch', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [opts.bandText ?? ''] }))
  on('model.fork', async () => {
    forks.push(forks.length)
    if (opts.gate) await opts.gate()
    const a = forkAnswers.shift()
    // Older Claude Code releases returned null instead of a failure object.
    if (a === null || a === undefined) return { value: null as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, logs, entered, reads }
}

const warm: ForkAnswer = { read: 200000, write: 0 }
// A ping that finds nothing to fork leaves the window waiting, with a wake at the cold mark and no further fork.
const nothing: ForkAnswer = { isAnswered: false, reason: 'nothing-to-fork' }
const busy: ForkAnswer = { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() }

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 75,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

describe('cache indicator', () => {
  test('redraws reuse session preferences and theme changes repaint immediately', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    await $.config.set(themeChange('light'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.warm.png })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    expect(w.forks.length).toBe(0)
  })

  test('a denied theme change preserves the existing icon', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { denyTheme: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await $.config.set(themeChange('light'))).deny).toBe('theme locked')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
  })

  test('the written theme wins over the requested value', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { writtenTheme: 'light' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.neutral.png })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: official cube follows state and theme with a text alternative`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const theme = { value: 'dark' }
      const w = world(on, [nothing], { theme })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.command.run(run('keepwarm', '3h'))
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface, component: 'AbovePrompt', props: bandProps })
      const type = surface === 'terminal' ? 'Image' : 'Svg'
      const source = (variant: typeof statusIcons.dark) => surface === 'terminal' ? { png: variant.neutral.png } : variant.neutral.svg
      expect((await ui.find({ type }))?.props.source).toEqual(source(statusIcons.dark))
      expect((await ui.find({ type }))?.props.alt).toBe(surface === 'terminal' ? '[>]' : 'Cache Tax')
      if (surface === 'terminal') {
        expect((await ui.find({ type }))?.props.columns).toBe(3)
        expect((await ui.find({ type }))?.props.rows).toBe(1)
      }
      await $.turn.complete(turn())
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.dark.warm.png } : statusIcons.dark.warm.svg)
      await $.config.set(themeChange('light'))
      await clock.advance(HOUR)
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.light.cold.png } : statusIcons.light.cold.svg)
      expect((await ui.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe('#c15f3c')
      expect(w.forks.length).toBe(1)
      await $.command.run(run('keepwarm', 'off'))
      expect(await ui.find({ type })).toBe(undefined)
    })

    test(`${surface}: NO_COLOR uses a bold text icon and uncolored state`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { noColor: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ type: 'Image' })).toBe(undefined)
      expect(await ui.find({ type: 'Svg' })).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: /^\[>\]$/ }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^warm$/ }))?.props.color).toBe(undefined)
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: unknown, warm, cold and warm again agree with the card`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on, [nothing], { bandText: 'other mod' })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ text: 'cache-tax' })).toBe(undefined)
      await $.command.run(run('keepwarm', '3h'))
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/unknown.*waiting for the first turn/)
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/warm.*ping in 50m/)
      await clock.advance(HOUR)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
      expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/cold.*cold now/)
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       COLD/)
      expect(w.forks.length).toBe(1)
      expect((await ui.find({ text: /^other mod$/ }))?.text).toBe('other mod')
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       warm/)
      expect(w.status.filter(Boolean)).toEqual([])
      await $.command.run(run('keepwarm', 'off'))
      expect(await ui.find({ text: 'cache-tax' })).toBe(undefined)
      expect(w.forks.length).toBe(1)
    })
  }

  test('cold resume, compaction and clear reset the row without a ping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/unknown.*after compaction/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.classic.SessionStart({ source: 'clear' })
    expect(await ui.find({ text: 'cache-tax' })).toBe(undefined)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('window expiry removes the row and surveys retain their band', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { bandText: 'survey' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '10m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const survey = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, hasSurvey: true } })
    expect(await survey.find({ text: 'cache-tax' })).toBe(undefined)
    expect((await survey.find({ text: 'survey' }))?.text).toBe('survey')
    await clock.advance(10 * MIN)
    expect(await ui.find({ text: 'cache-tax' })).toBe(undefined)
    expect(w.forks.length).toBe(0)
  })

  test('a warm resume restores green and ignores subagent cache activity', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [nothing], { store: new Map<string, unknown>([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30 * 60, context_tokens: 200000 })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.turn.complete(turn({ agentId: 'worker' }))
    await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    expect(w.forks.length).toBe(1)
  })

  for (const surface of ['vscode', 'mobile', null] as const) {
    test(`${surface ?? 'headless'} keeps the plain status fallback`, async ($, on) => {
      mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
      expect(w.status.at(-1)).not.toMatch(/\x1b/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('a warm ping keeps the green row and a cold read stops it neutrally', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, { read: 0, write: 200000 }])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/last ping read 200k/)
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/stopped.*cache was already gone/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(2)
  })

  for (const failure of [
    { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request', usage: usage() },
    { isAnswered: false, reason: 'empty-reply', usage: usage() },
    { isAnswered: false, reason: 'aborted', usage: usage() },
  ] satisfies ModelForkResult[]) {
    test(`structured fork failure ${failure.reason} stops without retrying`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [failure])
      await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h every 1m'))
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
      await clock.advance(MIN)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/stopped/)
      await clock.advance(2 * HOUR)
      expect(w.forks.length).toBe(1)
    })
  }
})

describe('parse and format', () => {
  test('durations', async () => {
    expect(parseDuration('6h')).toBe(6 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('2h30m')).toBe(150 * MIN)
    expect(parseDuration('soon')).toBe(null)
    expect(fmtDuration(150 * MIN)).toBe('2h30m')
    expect(fmtDuration(7 * MIN)).toBe('7m')
    expect(fmtDuration((15 * 24 + 9) * 60 * MIN)).toBe('15d 9h')
  })
})

describe('guard', () => {
  test('refuses a cold send once with the price, then lets the resend through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt('hi'))
    expect(first.drop).toMatch(/cache-tax: the prompt cache went cold 2h00m ago\. Sending this re-writes up to 200,502 tokens at \$20\/MTok = \$4\.01/)
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('lets slash commands, warm sends and small contexts through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.prompt.submit(prompt('warm one'))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('/clear'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 20000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('small one'))
    expect(w.entered).toEqual(['warm one', '/clear', 'small one'])
  })

  test('warn mode shows the price and sends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const r = await $.command.run(run('cache-tax', 'guard warn'))
    expect(r.text).toMatch(/guard set to warn/)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Sending anyway/)
  })

  test('a paid cold write is scored and arms keepwarm for three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toMatch(/cold write of 201k tokens paid \(\$4\.01\)\. Keeping the cache warm for 3h00m/)
    expect(w.status.at(-1)).toMatch(/^keepwarm 3h00m left · ping in 50m/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/session     1 cold write paid, \$4\.01/)
    expect(card.text).toMatch(/keepwarm    on, 2h10m left/)
  })

  test('context comes from the live window, not the turn\'s summed usage', async ($, on) => {
    mock.clock(on, { now: START })
    const live: { tokens?: number } = {}
    const w = world(on, [], { live })
    await $.session.start(session)
    await $.turn.complete(turn())
    live.tokens = 100000
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000 }) }))
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/context     100,000 tokens/)
    expect(card.text).toMatch(/0 cold writes paid/)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/clear forgets the context, the clock and the tally', async () => {
    const s = freshState()
    s.ctx = 200000
    s.lastRequestAt = START - 2 * HOUR
    s.ackedAt = s.lastRequestAt
    s.misses = [{ at: START, tokens: 200000, usd: 4 }]
    let cancelled = false
    s.pending = { cancel: () => { cancelled = true } }
    resetForClear(s)
    expect(s.ctx).toBe(0)
    expect(s.lastRequestAt).toBe(0)
    expect(s.ackedAt).toBe(0)
    expect(s.misses).toEqual([])
    expect(s.pending).toBe(null)
    expect(cancelled).toBe(true)
  })

  test('an unguarded full miss is scored too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/1 cold write paid/)
    expect(w.status.at(-1)).toMatch(/^keepwarm 3h00m left/)
  })

  test('stays quiet after a compaction until the first new turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
    await $.prompt.submit(prompt('after compact'))
    expect(w.entered).toEqual(['after compact'])
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/reset by compaction/)
  })

  test('a cold resume seeds the guard before any turn and returns the estimate line', async () => {
    const s = freshState()
    const now = START
    const line = seedFromResume(s, { source: 'resume', model: 'claude-fable-5-1', context_tokens: 396113, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 7.92 }, now)
    expect(line).toMatch(/resuming cold\. The first message re-writes 396,113 tokens, about \$7\.92/)
    expect(s.ctx).toBe(396113)
    expect(s.lastRequestAt).toBe(now - 3 * HOUR)
    expect(seedFromResume(freshState(), { source: 'startup' }, now)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', context_tokens: 20000, prompt_cache_likely_expired: true }, now)).toBe(null)
  })

  test('warns once when the hook form is installed beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: ['cache-tax:status'] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/hook form .* is also installed/)
  })
})

describe('keepwarm', () => {
  test('pings 50 minutes after the last request, then again, and reports the read', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', '6h'))
    expect(r.text).toMatch(/keepwarm on for 6h00m/)
    await $.turn.complete(turn())
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm 5h10m left · ping in 50m · last ping read 200k \$0\.05/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a new turn resets the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops when a ping reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 180000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 180k tokens \(\$3\.60\)/)
    await clock.advance(120 * MIN)
    expect(w.forks.length).toBe(1)
    const s = await $.command.run(run('keepwarm', 'status'))
    expect(s.text).toMatch(/stopped/)
  })

  test('stops when the engine returns null, a cold snapshot or an API error', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [null])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/either the snapshot was cold or the API call failed/)
  })

  test('the window ends on its own, forgetting the every knob, and off cancels', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm, warm], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3m every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the every knob lasts one window only', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', 'off'))
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(3)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a bare /keepwarm arms six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toMatch(/^keepwarm on for 6h00m, a ping 50m after each idle stretch/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('always is remembered, arms every session start, and off ends it for good', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true], ['deadline:S1', START - MIN], ['every:S1', MIN]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/keepwarm    on, 5h10m left · ping in 50m · last ping read 200k \$0\.05 \(always\)/)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off, and always is off for every session from its next turn')
    expect(store.has('always')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/keepwarm always sets the switch and arms now', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toMatch(/^keepwarm always on: every session stays warm until 6h00m after its last turn/)
    expect(store.get('always')).toBe(true)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('always rolls the window forward with each turn, so a long session never outlives it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm, warm], { store })
    await $.session.start(session)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    // A turn five and a half hours in: a fixed window would end 30m later, before the first ping.
    await clock.advance(5 * HOUR + 30 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 11 * HOUR + 30 * MIN)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the ping figure counts output tokens at the model\'s rate, Sonnet 5 priced as itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, out: 1000 }], { model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.05')
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/cold cost   \$0\.80 to re-write it \(warm turn \$0\.04\)/)
    expect(card.text).toMatch(/break-even  up to 20 pings at the read rate cost one cold write, about 16h40m of idle at one ping per 50m/)
  })

  test('a partial write, a zero read, or a full write stops the loop; a ping\'s own few tokens do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 500 }, { read: 75000, write: 70000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^keepwarm 5h59m left · ping in 1m · last ping read 200k/)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 75k and wrote 70k tokens/)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that reads nothing stops the loop too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 0 tokens/)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the ping figure counts uncached input at the base rate', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, input: 50000, out: 1000 }], { model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.15')
  })

  test('the card states the break-even for Fable 5.1', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/break-even  up to 80 pings at the read rate cost one cold write, about 2d 18h of idle at one ping per 50m/)
  })

  test('/keepwarm on a cold session schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(15 * 24 * HOUR)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toBe('keepwarm on for 6h00m. The cache is cold now, so the first ping comes 50m after the next turn')
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 50m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/keepwarm    on, 4h59m left · cold now, first ping 50m after the next turn/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 4h59m left · ping in 50m')
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the always switch on a cold resume schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(15 * 24 * HOUR)
    // The test kit cannot raise classic.SessionStart, so the cold state comes from the turn above and a second start arms the switch over it.
    store.set('always', true)
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 50m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toBe('keepwarm always on: every session stays warm until 6h00m after its last turn; /keepwarm off turns it off for good. The cache is cold now, so the first ping comes 50m after the next turn')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cold window expires and its testing period does not reach the next auto-window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '90m every 1m'))
    await clock.advance(90 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('every:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a turn after sleep clears the expired period before the overdue timer runs', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 2 * HOUR
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    expect(store.get('every:S1')).toBe(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 3 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 3h00m left · ping in 50m')
    expect(w.forks.length).toBe(0)
  })

  test('subagent turns do not touch the timer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn({ agentId: 'a1' }))
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('store per session', () => {
  test('another session\'s window does not arm this one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    const r = await $.command.run(run('keepwarm', 'status'))
    expect(r.text).toBe('keepwarm is off')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
  })

  test('this session\'s own window is restored on start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START + 2 * HOUR], ['every:mine', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window that lapsed less than a week ago is left for its own session', async ($, on) => {
    const now = START + 30 * 24 * HOUR
    mock.clock(on, { now })
    const store = new Map<string, unknown>([['deadline:recent', now - HOUR], ['every:recent', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:recent', 'every:recent'])
  })

  test('/keepwarm off deletes only this session\'s keys', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN], ['always', true], ['guard', 'warn']])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    expect(store.get('deadline:mine')).toBe(START + HOUR)
    expect(store.get('every:mine')).toBe(MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.has('deadline:mine')).toBe(false)
    expect(store.has('every:mine')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
    expect(store.get('guard')).toBe('warn')
  })

  test('legacy bare keys are cleared on start; other sessions\' keys, live or dead, and the global switches stay', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['deadline:old1', START - 8 * 24 * HOUR], ['every:old1', MIN],
      ['deadline:old2', 0],
      ['deadline', 0], ['every', MIN],
      ['deadline:live', START + HOUR], ['every:live', 2 * MIN],
      ['guard', 'warn'],
    ])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:old1', 'every:old1', 'deadline:old2', 'deadline:live', 'every:live', 'guard'])
  })

  test('this session\'s own dead window is cleared on start', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START - MIN], ['every:mine', MIN], ['deadline:other', START - MIN], ['every:other', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:other', 'every:other'])
  })
})

describe('prices', () => {
  for (const [model, cold, warmTurn, pings] of [
    ['claude-opus-5-5', '1.60', '0.04', 40],
    ['claude-opus-5', '2.00', '0.10', 20],
    ['claude-sonnet-5-5', '0.80', '0.02', 40],
    ['claude-haiku-5-5', '0.20', '0.01', 20],
    ['claude-mythos-5-1', '4.00', '0.05', 80],
    ['claude-opus-4-1-20250805', '6.00', '0.30', 20],
    ['claude-opus-4-20250514', '6.00', '0.30', 20],
    ['claude-opus-4@20250514', '6.00', '0.30', 20],
    ['claude-opus-4-1@20250805', '6.00', '0.30', 20],
    ['anthropic.claude-opus-4-1-20250805-v1:0', '6.00', '0.30', 20],
    ['claude-opus-4-1', '6.00', '0.30', 20],
    ['claude-opus-4-5-20251101', '2.00', '0.10', 20],
    ['claude-opus-4-5@20251101', '2.00', '0.10', 20],
    ['anthropic.claude-opus-4-5-20251101-v1:0', '2.00', '0.10', 20],
    ['claude-opus-4-8', '2.00', '0.10', 20],
    ['claude-3-5-haiku-20241022', '0.32', '0.02', 20],
  ] as const) {
    test(`${model} at 200k tokens is priced from its own row`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { live: { tokens: 200000 } })
      await $.session.start(session)
      await $.turn.complete(turn({ usage: usage({ model }) }))
      const card = await $.command.run(run('cache-tax', ''))
      expect(card.text).toMatch(`cold cost   $${cold} to re-write it (warm turn $${warmTurn})`)
      expect(card.text).toMatch(`break-even  up to ${pings} pings`)
    })
  }

  test('Haiku 5.5 up to 100k tokens takes the short-prompt row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 100000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5' }) }))
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch('cold cost   $0.02 to re-write it (warm turn $0.00)')
  })
})

describe('keepwarm input', () => {
  for (const args of ['3h every 60m', '3h every 90m', '3h every 2h']) {
    test(`${args} is refused, since it would only fire on a cold cache`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run('keepwarm', args))
      expect(r.text).toBe('every takes a period from 1m to 59m')
      expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    })
  }

  test('every 59m pings before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 59m'))
    await clock.advance(59 * MIN)
    expect(w.forks.length).toBe(1)
  })

  for (const args of ['0m', '0h', '0h0m']) {
    test(`a ${args} window is refused`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run('keepwarm', args))
      expect(r.text).toBe('keepwarm takes a window such as 6h or 90m, or always, off, or status')
    })
  }

  test('a stored period of an hour or more falls back to 50m', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { store: new Map<string, unknown>([['deadline:S1', START + 3 * HOUR], ['every:S1', 90 * MIN]]) })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('always after /clear', () => {
  test('arms a fresh window under the new session id', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const w = world(on, [warm], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('without always, /clear leaves keepwarm off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3h'))
    await $.turn.complete(turn())
    await $.classic.SessionStart({ source: 'clear' })
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
  })
})

describe('guard by origin', () => {
  for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'observer'] as const) {
    test(`a cold ${kind} prompt is sent and scored, and the next typed prompt is still refused`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const r = await $.prompt.submit({ text: 'agent finished', wait: false, origin: { kind } })
      expect(r.drop).toBe(undefined)
      expect(w.entered).toEqual(['agent finished'])
      expect(w.logs.at(-1)).toMatch(new RegExp(`Sending anyway, since this ${kind} prompt cannot be sent again`))
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/session     1 cold write paid/)
      await $.command.run(run('keepwarm', 'off'))
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-tax: the prompt cache went cold/)
    })
  }

  for (const origin of [
    { kind: 'bridge' }, { kind: 'sdk' }, { kind: 'unclassified' }, { kind: 'slack-ping' },
    { kind: 'channel', server: 'telegram' }, { kind: 'auto-continuation' },
  ] satisfies PromptSubmitInput['origin'][]) {
    test(`a cold ${origin.kind} prompt, which a person may have sent, is refused like a typed one`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit({ text: 'hi', wait: false, origin })).drop).toMatch(/^cache-tax:/)
    })
  }
})

describe('ping failures', () => {
  test('after a restart with nothing to fork, the window waits for the next turn instead of stopping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const store = new Map<string, unknown>([['deadline:S1', 13 * HOUR]])
    const w = world(on, [{ isAnswered: false, reason: 'nothing-to-fork' }, warm], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 40 * 60, context_tokens: 200000 })
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h50m left · nothing to fork yet, first ping after the next turn')
    expect(store.get('deadline:S1')).toBe(13 * HOUR)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(1)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  for (const status of [429, 529, 500, null]) {
    test(`an API error ${status} is retried and the loop goes on once a ping lands`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [{ isAnswered: false, reason: 'api-error', status, error: 'rate_limit', usage: usage() }, warm, warm])
      await $.session.start(session)
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h'))
      await clock.advance(50 * MIN)
      expect(w.forks.length).toBe(1)
      expect(w.status.at(-1)).toBe('keepwarm 2h10m left · API busy, ping retry 1 of 3')
      await clock.advance(MIN)
      expect(w.forks.length).toBe(2)
      expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
      await clock.advance(50 * MIN)
      expect(w.forks.length).toBe(3)
    })
  }

  test('a lasting 429 stops after three retries, before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(57 * MIN)
    expect(w.forks.length).toBe(4)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429) after 3 retries')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(4)
  })

  test('a retry that would land within a minute of the cache going cold is not tried', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 58m'))
    await clock.advance(58 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429)')
  })
})

describe('stale and late ping results', () => {
  // The tsconfig loads no DOM or Node types; the runtime has a real setTimeout to let a released fork finish.
  const realTimer = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }
  const settle = () => new Promise<void>(r => { realTimer.setTimeout(r, 20) })
  const gated = () => {
    let release = () => {}
    return { gate: () => new Promise<void>(r => { release = r }), release: () => release() }
  }

  test('a 429 that lands after a compaction schedules no retry', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [busy], { gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    g.release()
    await settle()
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h10m left · waiting for the first turn after compaction')
  })

  test('a 429 that lands after /clear with always on leaves the new window alone', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const g = gated()
    const w = world(on, [busy], { store, sid: () => sid, gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    g.release()
    await settle()
    expect(store.get('deadline:S2')).toBe(START + 50 * MIN + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('nothing to fork that lands after a turn does not hold the next ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [nothing, warm], { gate: async () => { if (w.forks.length === 1) await g.gate() } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.turn.complete(turn())
    g.release()
    await settle()
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  test('a retry whose timer fires inside the last minute is not sent', async ($, on) => {
    let now = START
    const timers: Array<() => void> = []
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm 2h10m left · API busy, ping retry 1 of 3')
    // The host slept through the retry's one-minute slot and wakes 30 seconds before the cache goes cold.
    now += 9.5 * 60 * 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the API call failed (429) after 1 retry')
  })
})

describe('price edge cases', () => {
  test('Claude Haiku 3.5 by display name takes the Haiku 3.5 row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'Claude Haiku 3.5' }) }))
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch('cold cost   $0.32 to re-write it (warm turn $0.02)')
  })

  test('without step usage, a Haiku 5.5 comeback is priced at the tier of the context it re-sent', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.command.run(run('cache-tax', 'guard warn'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 99000 }) }))
    await clock.advance(2 * HOUR)
    // Two requests summed: the 99k comeback write under 100k, then a step that crossed it.
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 100500 }) }))
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/session     1 cold write paid, \$0\.02/)
  })
})

describe('per-request pricing and window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const haiku = (read: number, write: number) => usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: read, cache_creation_input_tokens: write })
  const step = async ($: Parameters<TestBody>[0], index: number) => {
    for await (const c of $.turn.step({ turnId: 'comeback', index, model: 'claude-haiku-5-5', messageCount: 2 })) void c
  }

  test('a Haiku 5.5 comeback request over 100k is priced at the long tier though the context before was under it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { steps: [haiku(0, 101000)] })
    await $.session.start(session)
    await $.command.run(run('cache-tax', 'guard warn'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    // The guard sees the cache gone; after a first exchange the re-write alone would not say so.
    await $.prompt.submit(prompt('hi'))
    await step($, 0)
    await $.turn.complete(turn({ usage: haiku(0, 101000) }))
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/session     1 cold write paid, \$0\.10/)
  })

  test('a cold comeback is scored at its first request, at that request\'s tier; the turn\'s later writes are new content', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { steps: [haiku(0, 99000), haiku(99000, 60000)] })
    await $.session.start(session)
    await $.command.run(run('cache-tax', 'guard warn'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await step($, 0)
    await step($, 1)
    // 99,000 re-written at $0.20; the 60,000 the second request added would have been written warm or cold.
    await $.turn.complete(turn({ usage: haiku(99000, 159000) }))
    expect(w.logs.at(-1)).toMatch(/^cold write of 99k tokens paid \(\$0\.02\)/)
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/session     1 cold write paid, \$0\.02/)
  })

  test('a ping out when /keepwarm extends the window still counts', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.command.run(run('keepwarm', '6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('pings in flight', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  // Holds the first fork until released; later forks answer at once.
  const holdFirst = (w: () => { forks: number[] }) => {
    let release = () => {}
    const gate = async () => { if (w().forks.length === 1) await new Promise<void>(r => { release = r }) }
    return { gate, release: () => release() }
  }

  test('extending the window while a ping is out sends no second ping, and a cold reply then stops it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(5 * 1000)
    expect(w.forks.length).toBe(1)
    h.release()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 200k/)
  })

  test('a main request while a ping is out supersedes its cold reply', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await clock.advance(MIN)
    for await (const c of $.turn.step({ turnId: 'next', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    h.release()
    await settle()
    expect(w.status.at(-1)).not.toMatch(/stopped/)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  test('a turn aborted before any request keeps the reply of a ping that was out', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [warm, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await clock.advance(MIN)
    await $.turn.complete(turn({ isAborted: true, usage: undefined }))
    h.release()
    await settle()
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
    // The next ping counts from the ping's own read, not from the aborted turn.
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('ping timing races', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a timer that fires while another ping waits on the clock never sends a second fork', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // Ping B's fork stays out until released, so it is in flight when A resumes.
    let releaseFork = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    // Ping A's clock read is held; the extension's own reads go through.
    hold = new Promise<void>(r => { releaseClock = r })
    timers.at(-1)?.()
    await settle()
    await $.command.run(run('keepwarm', '6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseFork()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
  })

  test('a superseded reply followed by an early timer still leaves the window armed', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    // A long tool call: the turn's first request lands, and the turn does not complete.
    for await (const c of $.turn.step({ turnId: 'long', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    release()
    await settle()
    await clock.advance(2 * 1000)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('retry after a window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands after /keepwarm extends the window waits the full retry delay', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [busy, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('keepwarm', '6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
    // The extension's one-second timer is gone; only the one-minute retry remains.
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(1)
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
  })
})

describe('one timer at a time', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands while /keepwarm is reading the clock leaves one live timer', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // The extension writes its deadline, then arms; holding the next clock read pauses it inside arm().
    let watch = false
    class Store extends Map<string, unknown> {
      override set(key: string, value: unknown) {
        if (watch && key === 'deadline:S1') holdNext = true
        return super.set(key, value)
      }
    }
    let releaseFork = () => {}
    const w = world(on, [busy, busy, busy, warm], { store: new Store(), gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    const before = timers.length
    watch = true
    const extension = $.command.run(run('keepwarm', '6h'))
    await settle()
    releaseFork()
    await settle()
    releaseClock()
    await extension
    await settle()
    // Two timers were set since the first ping: the retry's, then the extension's. Fire the extension's at
    // one second and the retry's at its minute, a beat apart, as the host would; only a live timer may send.
    expect(timers.length - before).toBe(2)
    now += 1000
    timers[before + 1]?.()
    await settle()
    expect(w.forks.length).toBe(2)
    now += MIN
    timers[before]?.()
    await settle()
    expect(w.forks.length).toBe(2)
  })
})

describe('a paused ping yields to a newer schedule', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a ping paused on the clock does not send after a newer ping set a retry', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    // Ping A pauses on its clock read.
    holdNext = true
    timers.at(-1)?.()
    await settle()
    // The extension sets timer B; B pings, gets a 429 and schedules a one-minute retry.
    await $.command.run(run('keepwarm', '6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API busy, ping retry 1 of 3/)
  })
})

describe('/clear overlapping /keepwarm', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a window armed while /clear is still running keeps a timer', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    const holdNextRead = () => {
      let release = () => {}
      hold = new Promise<void>(r => { release = r })
      return () => release()
    }
    const timers: Array<() => void> = []
    const waits: number[] = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', ($, e) => new Promise<{ value: void }>(r => { waits.push(e.ms); timers.push(() => r({ value: undefined })) }))
    const w = world(on, [warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    now += 50 * MIN
    // Ping A fires and pauses on its clock read.
    const releaseA = holdNextRead()
    timers.at(-1)?.()
    await settle()
    // /clear stops the old window and pauses on its last clock read.
    const releaseClear = holdNextRead()
    const clearing = $.classic.SessionStart({ source: 'clear' })
    await settle()
    // /keepwarm arms a new window meanwhile; then /clear finishes.
    await $.command.run(run('keepwarm', '6h'))
    const beforeClearEnds = timers.length
    releaseClear()
    await clearing
    await settle()
    // /clear cancelled the window's timer in its reset, so it must set a new one: the wake at the deadline,
    // since the new conversation has no request yet.
    expect(timers.length).toBe(beforeClearEnds + 1)
    expect(waits.at(-1)).toBe(6 * HOUR)
    // A wakes, finds the schedule changed and a timer in place, and sends nothing.
    releaseA()
    await settle()
    expect(w.forks.length).toBe(0)
    expect(timers.length).toBe(beforeClearEnds + 1)
    // The first turn of the new conversation starts the pings as usual.
    await $.turn.complete(turn())
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
  })
})

describe('always covers any break up to six hours', () => {
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a window that stopped comes back on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [{ read: 0, write: 200000 }, warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 50 * MIN + 6 * HOUR)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/ping in 50m · last ping read 200k/)
  })

  test('a shorter window and a testing period give way to six hours at 50m on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m every 2m'))
    expect(store.get('every:S1')).toBe(2 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('an expired window with a testing period rolls at 50m, not at its old period', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    await $.turn.complete(turn())
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
  })

  test('the window rolls in the conversation after /clear too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    let sid = 'S1'
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S2')).toBe(START + 11 * HOUR)
  })

  test('without always a turn never moves the deadline', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '90m'))
    await clock.advance(80 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 90 * MIN)
    await clock.advance(10 * MIN)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    expect(w.forks.length).toBe(0)
  })
})

describe('/keepwarm off during a rolling turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('off wins over the window a finishing turn was opening', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let holdEveryDelete = false
    let release = () => {}
    const storeGate = async (op: 'get' | 'set' | 'delete', key: string) => {
      if (holdEveryDelete && op === 'delete' && key === 'every:S1') {
        holdEveryDelete = false
        await new Promise<void>(r => { release = r })
      }
    }
    const w = world(on, [warm, warm], { store, storeGate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    // The next turn's roll pauses while saving its window; /keepwarm off runs to the end meanwhile.
    holdEveryDelete = true
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('keepwarm', 'off'))).text).toMatch(/^keepwarm is off/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })
})

describe('always, from the PR review', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a longer window is kept, with its testing period reset to 50m', async ($, on) => {
    mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    const r = await $.command.run(run('keepwarm', '48h every 2m'))
    expect(r.text).toMatch(/Always is on, so your next turn makes it at least 6h00m at one ping per 50m$/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
    expect(store.has('every:S1')).toBe(false)
  })

  test('a 48h window without a testing period is untouched by a turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '48h'))
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
  })

  test('a turn that failed before any response does not open a window over a cold cache', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    // Back after the six-hour window ended; the first request fails for good, with no usage.
    await clock.advance(7 * HOUR)
    const before = w.forks.length
    await $.turn.complete(turn({ usage: undefined }))
    expect(store.has('deadline:S1')).toBe(false)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(before)
  })

  test('the cold-write receipt prints with always on, and the guard promises six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: alwaysOn() })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/keepwarm will then hold the cache for 6h00m\./)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
  })

  test('without always the receipt still offers three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/keepwarm will then hold the cache for 3h00m\./)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toMatch(/^cold write of 200k tokens paid \(\$4\.00\)\. Keeping the cache warm for 3h00m/)
  })

  test('/keepwarm off in another session stops this one rolling at its next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    // Another session ran /keepwarm off: the shared switch is gone from the store.
    store.delete('always')
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
  })

  test('/keepwarm off that lands while the roll reads the clock wins', async ($, on) => {
    let now = START
    let skip = -1
    let release = () => {}
    on('clock.now', async () => {
      if (skip === 0) {
        skip = -1
        await new Promise<void>(r => { release = r })
      } else if (skip > 0) skip--
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 10 * MIN
    // The finishing turn reads the clock once, then the roll reads it again: hold that second read.
    skip = 1
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('keepwarm', 'off'))).text).toMatch(/^keepwarm is off/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    expect(w.forks.length).toBe(0)
  })
})

describe('the shared always switch across a turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const holdOnce = (op: 'get' | 'set' | 'delete', key: string) => {
    let armed = false
    let release = () => {}
    const gate = async (o: 'get' | 'set' | 'delete', k: string) => {
      if (armed && o === op && k === key) {
        armed = false
        await new Promise<void>(r => { release = r })
      }
    }
    return { gate, arm: () => { armed = true }, release: () => release() }
  }

  test('/keepwarm off while the turn reads the switch is not undone by the old value', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    h.arm()
    const finishing = $.turn.complete(turn())
    await settle()
    await $.command.run(run('keepwarm', 'off'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('/keepwarm off during a cold-writing turn also stops its three-hour auto-warm', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.command.run(run('cache-tax', 'guard warn'))
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const before = w.forks.length
    h.arm()
    const finishing = $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await settle()
    await $.command.run(run('keepwarm', 'off'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(before)
  })

  test('always turned back on in another session reaches a session that saw it off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    world(on, [], { store })
    await $.session.start(session)
    store.delete('always')
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect((await $.command.run(run('cache-tax', ''))).text).not.toMatch(/\(always\)/)
    store.set('always', true)
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 8 * HOUR)
  })
})

describe('/keepwarm off while a turn is running', () => {
  test('a cold write landing after the off does not reopen three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-tax:/)
    await $.prompt.submit(prompt('hi'))
    // The paid resend's request is out when /keepwarm off runs, and its turn finishes after.
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.command.run(run('keepwarm', 'off'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('without an off the same cold write still arms three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.get('deadline:S1')).toBe(START + 2 * HOUR + 3 * HOUR)
  })
})

type WorldOpts = NonNullable<Parameters<typeof world>[2]>
// Settings that leave the cache's lifetime to Claude Code's automatic choice.
const AUTO = { promptCacheTtl: undefined }
const FIVE = { settings: { promptCacheTtl: '5m' } }
const sonnet = (over: Partial<TurnUsage> = {}) => usage({ model: 'claude-sonnet-5', ...over })
const window5h = (percentUsed: number): SessionRateLimit => ({ kind: 'five_hour', percentUsed })
const measure = (rateLimits: SessionRateLimit[]) => ({ context: { window: 1000000 }, rateLimits, changed: ['rateLimits' as const] })
const coldTurn = () => turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) })
const cardOf = async ($: Parameters<TestBody>[0]) => (await $.command.run(run('cache-tax', ''))).text ?? ''
// One request of a main-thread turn, answered with the next of the world's step usages.
const stepAt = async ($: Parameters<TestBody>[0], model = 'claude-fable-5-1', effort?: 'low' | 'medium' | 'high') => {
  for await (const c of $.turn.step({ turnId: 'next', index: 0, model, messageCount: 3, ...(effort ? { effort } : {}) })) void c
}
// A re-write that read the prefix every conversation shares and nothing past it.
const cold20k = { cache_read_input_tokens: 20000, cache_creation_input_tokens: 180000 }

describe('cache lifetime', () => {
  const cases: Array<[string, WorldOpts, string]> = [
    ['the promptCacheTtl setting', FIVE, 'lives 5 minutes (the promptCacheTtl setting)'],
    ['FORCE_PROMPT_CACHING_5M over the setting', { env: { FORCE_PROMPT_CACHING_5M: '1' } }, 'lives 5 minutes (FORCE_PROMPT_CACHING_5M)'],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL over the setting', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, settings: { promptCacheTtl: '5m' } }, 'lives 1 hour (CLAUDE_CODE_PROMPT_CACHE_TTL)'],
    ['ENABLE_PROMPT_CACHING_1H with no setting', { env: { ENABLE_PROMPT_CACHING_1H: '1' }, settings: AUTO }, 'lives 1 hour (ENABLE_PROMPT_CACHING_1H)'],
    ['CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL for the conversation over CLAUDE_CODE_PROMPT_CACHE_TTL', { env: { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }, 'lives 5 minutes (CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL)'],
    ['a setting over a used-up plan limit', { limits: { now: [window5h(100)] } }, 'lives 1 hour (the promptCacheTtl setting)'],
  ]
  for (const [name, opts, expected] of cases) {
    test(`configuration decides it in Claude Code's order: ${name}`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], opts)
      await $.session.start(session)
      await $.turn.complete(turn())
      expect(await cardOf($)).toMatch(`cache       ${expected}`)
    })
  }

  test('with nothing configured, a subscription within its limits caches for an hour', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: AUTO, limits: { now: [window5h(10)] }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    const text = await cardOf($)
    expect(text).toMatch('cache       lives 1 hour (a subscription within its limits)')
    expect(text).toMatch('plan        5h 10%; dollars are API-equivalent (list prices), your plan counts these windows; pings stop at 95%')
  })

  test('Fable on a subscription is unconfirmed, as Pro and Team Standard run it on usage credits', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: AUTO, limits: { now: [window5h(10)] } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cache       lifetime not confirmed (Fable and Mythos run on usage credits on Pro and Team Standard')
  })

  test('a used-up plan limit means usage credits and five minutes', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: AUTO, limits: { now: [window5h(100)] }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    expect(await cardOf($)).toMatch('cache       lives 5 minutes (a plan limit is used up, and on usage credits Claude Code caches for 5 minutes)')
  })

  test('no limit windows, as on a work login, leave it unconfirmed', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: AUTO })
    await $.session.start(session)
    expect(await cardOf($)).toMatch('cache       lifetime not confirmed (no response yet)')
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cache       lifetime not confirmed (no plan limits are visible to this mod, as on a Team or Enterprise login')
  })

  test('a read 20 minutes into a break confirms an hour; one 9 minutes in, which a 5-minute entry can survive, does not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { settings: AUTO, steps: [usage(), usage()] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(9 * MIN)
    await stepAt($)
    expect(await cardOf($)).toMatch('cache       lifetime not confirmed')
    await clock.advance(20 * MIN)
    await stepAt($)
    expect(await cardOf($)).toMatch('cache       lives 1 hour (the cache was read after 20m idle)')
  })

  test('two re-writes between five minutes and the hour say five minutes; one does not, nor one on another model', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { settings: AUTO, steps: [usage(cold20k), usage(cold20k), usage({ model: 'claude-sonnet-5', ...cold20k })] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    await clock.advance(9 * MIN)
    await stepAt($)
    expect(await cardOf($)).toMatch('cache       lifetime not confirmed')
    await clock.advance(9 * MIN)
    await stepAt($)
    expect(await cardOf($)).toMatch('cache       lives 5 minutes (the cache was re-written after only 9m idle, seen 2 times)')
    await clock.advance(9 * MIN)
    await stepAt($, 'claude-sonnet-5')
    expect(await cardOf($)).toMatch(/^claude-sonnet-5\n[^\n]*\ncache       lifetime not confirmed/)
  })

  test('resume fields 20 minutes after the last response that Claude Code judges live: lives 1 hour', async ($, on) => {
    mock.clock(on, { now: 10 * HOUR })
    world(on, [], { settings: AUTO })
    await $.session.start(session)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 1200, context_tokens: 200000, prompt_cache_likely_expired: false })
    expect(await cardOf($)).toMatch('cache       lives 1 hour (Claude Code judged it so at resume, 20m after the last response)')
  })

  // Claude Code 2.1.314 reports a transcript whose last compaction has no response after it as expired at any gap.
  test('A1: a resume judged expired 20 minutes on, as after a /compact, says nothing of the lifetime and is cold until its first request', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    world(on, [], { settings: AUTO, limits: { now: [window5h(10)] }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 1200, context_tokens: 200000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 0.8 })
    let text = await cardOf($)
    expect(text).toMatch('cache       lives 1 hour (a subscription within its limits)')
    expect(text).toMatch('state       COLD, last request 20m ago (Claude Code judged it expired at resume)')
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe("cache-tax: the prompt cache is cold: Claude Code judged it expired when this conversation was resumed. Sending this re-writes up to 200,000 tokens, about $0.80 by Claude Code's estimate (a warm turn would have cost $0.04). Send it again to pay it, and keepwarm will then hold the cache for 3h00m. Or /clear and start from a note.")
    await clock.advance(MIN)
    await stepAt($, 'claude-sonnet-5')
    text = await cardOf($)
    expect(text).toMatch('state       warm, 1h00m left')
    expect(text).toMatch('cache       lives 1 hour (a subscription within its limits)')
  })

  test('A1: where nothing else says, a resume judged expired leaves the lifetime unconfirmed, and /cache-tax ttl 1h still states it', async ($, on) => {
    mock.clock(on, { now: 10 * HOUR })
    world(on, [], { settings: AUTO })
    await $.session.start(session)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 1200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(await cardOf($)).toMatch('cache       lifetime not confirmed')
    expect((await $.command.run(run('cache-tax', 'ttl 1h'))).text).toMatch(/Now: lives 1 hour \(set with \/cache-tax ttl\)$/)
  })

  test('a model switch reports the lifetime of the model it leaves, holds the pings, and is priced at Claude Code\'s estimate', async ($, on) => {
    mock.clock(on, { now: START })
    const switchTo = (from: string, to: string, ttl: '1h' | '5m') => ({ from_model: from, to_model: to, requested_model: null, source: 'command' as const, context_tokens: 200502, prompt_cache_warm: true, cache_ttl: ttl, estimated_cache_write_usd: 1.23, pricing: 'catalog' as const })
    const w = world(on, [], { settings: AUTO, limits: { now: [window5h(10)] }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    await $.command.run(run('keepwarm', '3h'))
    // Pro, with Fable on usage credits beside Sonnet within the plan: the hour Claude Code reports is Sonnet's.
    await $.classic.PostModelSwitch(switchTo('claude-sonnet-5', 'claude-fable-5-1', '1h'))
    const text = await cardOf($)
    expect(text).toMatch(/^claude-fable-5-1\n/)
    expect(text).toMatch('cache       lifetime not confirmed (Fable and Mythos run on usage credits')
    expect(text).toMatch('cold cost   $1.23 to re-write it')
    expect(w.status.at(-1)).toMatch(/· no pings: the model changed to claude-fable-5-1 since your last message/)
    await $.classic.PostModelSwitch(switchTo('claude-fable-5-1', 'claude-sonnet-5', '5m'))
    expect(await cardOf($)).toMatch('cache       lives 1 hour (Claude Code reported it at a model switch)')
    await $.classic.PostModelSwitch(switchTo('claude-sonnet-5', 'claude-fable-5-1', '1h'))
    expect(await cardOf($)).toMatch('cache       lives 5 minutes (Claude Code reported it at a model switch)')
  })

  test('/cache-tax ttl states it on this machine and wins over what requests showed; auto hands back to them', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { settings: AUTO, store, steps: [usage(cold20k), usage(cold20k)] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    expect((await $.command.run(run('cache-tax', 'ttl 2h'))).text).toBe('/cache-tax ttl takes auto, 1h or 5m')
    expect((await $.command.run(run('cache-tax', 'ttl 1h'))).text).toBe("cache-tax assumes 1h on this machine; Claude Code's own cache follows promptCacheTtl, not this. Now: lives 1 hour (set with /cache-tax ttl)")
    expect(store.get('ttl')).toBe('1h')
    await clock.advance(9 * MIN)
    await stepAt($)
    await clock.advance(9 * MIN)
    await stepAt($)
    expect(await cardOf($)).toMatch('cache       lives 1 hour (set with /cache-tax ttl)')
    expect((await $.command.run(run('cache-tax', 'ttl auto'))).text).toBe('cache-tax detects the lifetime again. Now: lives 5 minutes (the cache was re-written after only 9m idle, seen 2 times)')
    expect(store.has('ttl')).toBe(false)
  })

  test('prompt caching switched off leaves nothing to warm or guard', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { env: { DISABLE_PROMPT_CACHING: '1' } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cache       off (DISABLE_PROMPT_CACHING), nothing to keep warm')
    expect((await $.command.run(run('keepwarm', ''))).text).toBe('prompt caching is off in this session (DISABLE_PROMPT_CACHING), so there is nothing to keep warm')
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })
})

describe('on a five-minute cache', () => {
  test('the guard warns at the 5-minute write rate past five idle minutes, naming the fix once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], FIVE)
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(6 * MIN)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs.at(-1)).toBe('the prompt cache went cold 1m ago. Sending this re-writes up to 200,502 tokens at $12.5/MTok = $2.51 (a warm turn would have cost $0.05). Sending anyway. This session\'s cache lives 5 minutes (the promptCacheTtl setting); "promptCacheTtl": "1h" in settings keeps it an hour, its writes at 2x base input instead of 1.25x.')
    await $.turn.complete(turn())
    await clock.advance(6 * MIN)
    await $.prompt.submit(prompt('again'))
    expect(w.logs.at(-1)).toMatch(/Sending anyway\.$/)
    expect(w.entered).toEqual(['hi', 'again'])
  })

  test('refuse, chosen outright, still refuses once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], FIVE)
    await $.session.start(session)
    await $.command.run(run('cache-tax', 'guard refuse'))
    await $.turn.complete(turn())
    await clock.advance(6 * MIN)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-tax: the prompt cache went cold 1m ago\. .* Send it again to pay it\. Or \/clear/)
  })

  test('bare /keepwarm and the window after a cold write send no pings; always keeps 30m at one ping per 4m', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm], { ...FIVE, store })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', ''))).text).toBe('this session\'s prompt cache lives 5 minutes (the promptCacheTtl setting), so a ping 50m into a break would find it gone and re-send the whole context. "promptCacheTtl": "1h" in settings keeps it an hour (its writes cost 2x base input, not 1.25x); for a short break, /keepwarm 30m every 4m.')
    await $.turn.complete(coldTurn())
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($2.50). Keepwarm stays off: this cache lives 5 minutes (the promptCacheTtl setting).')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
    expect((await $.command.run(run('keepwarm', 'always'))).text).toBe('keepwarm always on: on this 5-minute cache every session stays warm for 30m after its last turn, at one ping per 4m; /keepwarm off turns it off for good. The cache is cold now, so the first ping comes 4m after the next turn')
    expect(store.get('always')).toBe(true)
    await $.turn.complete(turn())
    expect(store.get('every:S1')).toBe(4 * MIN)
    await clock.advance(8 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a period under five minutes still holds it, and a longer one is refused', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm], FIVE)
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '30m every 5m'))).text).toBe('every takes a period from 1m to 4m on a 5-minute cache')
    expect((await $.command.run(run('keepwarm', '30m every 4m'))).text).toBe('keepwarm on for 30m, a ping 4m after each idle stretch keeps the cache read, not re-written')
    await clock.advance(4 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(4 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('an unconfirmed lifetime', () => {
  test('/keepwarm asks once with the risk priced, and the same command again arms it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { settings: AUTO })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '90m'))).text).toBe("cache-tax can't confirm this session's prompt cache lives an hour (no plan limits are visible to this mod, as on a Team or Enterprise login, an API key or a cloud provider). If it lives 5 minutes, a ping 50m into a break re-sends up to 200,502 tokens (about $2.01) for nothing. Send /keepwarm 90m again to arm it anyway, or /cache-tax ttl 1h if you know it lives an hour.")
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('keepwarm', '90m'))).text).toBe('keepwarm on for 1h30m, a ping 50m after each idle stretch keeps the cache read, not re-written. The lifetime is unconfirmed: the first ping checks it, and keepwarm stops if the cache is gone')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(await cardOf($)).toMatch('cache       lives 1 hour (a ping read the cache 50m into a break)')
  })

  test('a confirmation goes stale after two minutes, and another command is a new question', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { settings: AUTO })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m'))
    await clock.advance(3 * MIN)
    expect((await $.command.run(run('keepwarm', '90m'))).text).toMatch(/^cache-tax can't confirm/)
    expect((await $.command.run(run('keepwarm', '2h'))).text).toMatch(/^cache-tax can't confirm/)
  })

  test('the guard only warns while the cache may be cold, and scores nothing it has not seen paid', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { settings: AUTO })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(await cardOf($)).toMatch('state       unknown, last request 10m ago, cold if this cache lives 5 minutes')
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs.at(-1)).toMatch(/^the prompt cache may be cold: it has been idle 10m, and this session's cache lifetime isn't confirmed .* Sending anyway\.$/)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('session     0 cold writes paid')
  })

  test('always and the automatic window wait for a confirmed lifetime', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { settings: AUTO, store: new Map<string, unknown>([['always', true]]) })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe("keepwarm 6h00m left · no pings: this cache's lifetime isn't confirmed (no plan limits are visible to this mod, as on a Team or Enterprise login, an API key or a cloud provider)")
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
  })
})

describe('the comeback after a ping', () => {
  test('a re-write after a ping stops keepwarm, and no window opens over it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { steps: [usage(cold20k)] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(20 * MIN)
    await stepAt($)
    expect(w.status.at(-1)).toBe("keepwarm stopped: the message 20m after the last ping re-wrote 180k tokens, so pings don't keep this cache alive here; /keepwarm tries again")
    await $.turn.complete(turn({ usage: usage(cold20k) }))
    expect(w.logs.at(-1)).toBe('cold write of 180k tokens paid ($3.60). Keepwarm stays off: a ping did not keep this cache alive; /keepwarm tries again.')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(1)
  })

  test('a read after a ping lets keepwarm go on', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm], { steps: [usage()] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(70 * MIN)
    await stepAt($)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that finds the cache gone stops keepwarm; it takes a second such miss to say five minutes', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const gone = { read: 20000, write: 180000 }
    world(on, [gone, gone], { settings: AUTO, limits: { now: [window5h(10)] }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    await $.turn.complete(turn({ usage: sonnet() }))
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    const text = await cardOf($)
    expect(text).toMatch('cache       lives 1 hour (a subscription within its limits)')
    expect(text).toMatch(/keepwarm    stopped, the ping read 20k and wrote 180k tokens/)
    await $.turn.complete(turn({ usage: sonnet() }))
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(await cardOf($)).toMatch('cache       lives 5 minutes (a ping 50m into a break found the cache gone, seen 2 times)')
  })
})

describe('on an organization login', () => {
  const end = (reason: 'clear' | 'resume') => ({ reason, sessionId: 'S1', resume: { id: 'S1' } })

  test('without classic.SessionStart, /clear arrives through session.end and leaves no stale refusal', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('hooks       this mod sees /clear and resume only through session.end here')
    await clock.advance(3 * HOUR)
    sid = 'S2'
    await $.session.end(end('clear'))
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    await $.turn.complete(turn())
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR + 6 * HOUR)
  })

  test('a resume through session.end resets the clock rather than refuse on the old one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.end(end('resume'))
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('where classic.SessionStart arrives too, the old conversation\'s end, told after the new one began, is passed over', async ($, on) => {
    mock.clock(on, { now: START })
    let sid = 'S1'
    const store = new Map<string, unknown>()
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.classic.SessionStart({ source: 'startup' })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await $.session.end(end('clear'))
    const text = await cardOf($)
    expect(text).toMatch('context     200,502 tokens')
    expect(text).toMatch(/keepwarm    on, 3h00m left/)
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR)
    expect(text.includes('hooks       ')).toBe(false)
  })

  test('after an idle compaction this mod did not see, the engine has no live window and the send is not priced on the old context', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { settings: { idleCompaction: undefined } })
    await $.session.start(session)
    await $.turn.complete(turn())
    // Claude Code compacted the 200k conversation 54 minutes in; until the next response there is no live window.
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toBe("the prompt cache may be cold after 3h00m idle, but Claude Code may have compacted this conversation while it was idle, so cache-tax can't price this send. Sending it.")
  })

  test('where idle compaction is off, a missing live window still prices the refusal on the context it knows', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/re-writes up to 200,502 tokens/)
  })
})

describe('receipts and stops', () => {
  test("a ping's receipt is its own usage priced, and the limit points beside it are the account's", async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const cost = { usd: 1 }
    const limits = { now: [window5h(12)] }
    const w = world(on, [warm], { cost, limits, gate: async () => { cost.usd = 1.07; limits.now = [window5h(12.3)] } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 2h10m left · ping in 50m · last ping read 200k $0.05 (5h +0.3% account-wide)')
  })

  test('when something else this session paid for lands during a ping, its receipt leaves the limit points out', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const cost = { usd: 1 }
    const limits = { now: [window5h(12)] }
    // A subagent's answer lands while the fork is out.
    const w = world(on, [warm], { cost, limits, gate: async () => { cost.usd = 1.92; limits.now = [window5h(14)] } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 2h10m left · ping in 50m · last ping read 200k $0.05')
  })

  test('pings hold at the stop line and go on when the window falls back', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(10 * MIN)
    await $.session.measure(measure([window5h(96)]))
    expect(w.status.at(-1)).toBe('keepwarm 2h50m left · no pings: the 5-hour limit is at 96%, keepwarm stops at 95%')
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await $.session.measure(measure([window5h(20)]))
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test("managed modelPricing prices the card, and the same key in user settings does not", async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { policy: { modelPricing: { overrides: { 'claude-fable-5-1': { input: 5, output: 25, cacheRead: 0.1, cacheWrite: 8 } } } }, settings: { modelPricing: { multiplier: 0.5 } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    const text = await cardOf($)
    expect(text).toMatch('cold cost   $1.60 to re-write it (warm turn $0.02)')
    expect(text).toMatch("plan        no limit windows visible to this mod; dollars at your organization's modelPricing")
  })

  test('a managed multiplier scales the list row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { policy: { modelPricing: { multiplier: 0.5 } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cold cost   $2.01 to re-write it (warm turn $0.03)')
  })

  test('user-level modelPricing alone is ignored, as Claude Code ignores it', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: { modelPricing: { multiplier: 0.5 } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cold cost   $4.01 to re-write it (warm turn $0.05)')
  })

  test('idle compaction is named for a conversation of 200k tokens or more', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: { idleCompaction: undefined } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('idle        Claude Code compacts a conversation this size about 54m into a break (idleCompaction)')
    expect((await $.command.run(run('keepwarm', ''))).text).toMatch(/\. Claude Code compacts a conversation this size .* "idleCompaction": false keeps the full context$/)
  })
})

describe('options', () => {
  test('keepwarm off refuses every window and the automatic one', { options: { keepwarm: 'off' } }, async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '90m'))).text).toBe('keepwarm is off by its option: no pings in any session')
    await $.turn.complete(coldTurn())
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00). Keepwarm stays off: the keepwarm option is off.')
  })

  test('manual allows windows but neither always nor the automatic one', { options: { keepwarm: 'manual' } }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', 'always'))).text).toBe('always is off by the keepwarm option (manual); arm a window with /keepwarm or /keepwarm 90m')
    expect((await $.command.run(run('keepwarm', '90m'))).text).toMatch(/^keepwarm on for 1h30m/)
    await $.turn.complete(coldTurn())
    // The 90m window armed by hand runs on; the automatic three hours do not open.
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00).')
    expect(store.get('deadline:S1')).toBe(START + 90 * MIN)
    await $.command.run(run('keepwarm', 'off'))
    await $.turn.complete(coldTurn())
    expect(w.logs.at(-1)).toBe('cold write of 200k tokens paid ($4.00). Keepwarm stays off: the keepwarm option is manual.')
  })

  test('guard off sends every cold message unchecked', { options: { guard: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs).toEqual([])
  })

  test("a locked option is the organization's: this machine's choice and the command give way", { options: { guard: 'warn' } }, async ($, on) => {
    mock.clock(on, { now: START })
    const locked: ConfigRow = { key: 'cache-tax.guard', label: 'Cold-send guard', kind: 'choice', value: 'warn', provider: { plugin: 'cache-tax', tier: 'user' }, isLocked: true }
    world(on, [], { rows: [locked], store: new Map<string, unknown>([['guard', 'refuse']]) })
    await $.session.start(session)
    expect((await $.command.run(run('cache-tax', 'guard refuse'))).text).toBe('the guard is warn, set by your organization')
    const text = await cardOf($)
    expect(text).toMatch('guard       warn only (/cache-tax guard refuse to be stopped once), set by your organization')
    expect(text).toMatch('options     set by your organization: guard')
  })

  test('stopAtPercent sets the stop line', { options: { stopAtPercent: 80 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await $.session.measure(measure([window5h(85)]))
    expect(w.status.at(-1)).toBe('keepwarm 3h00m left · no pings: the 5-hour limit is at 85%, keepwarm stops at 80%')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
  })

  test('cacheTtl states the lifetime where nothing else does', { options: { cacheTtl: '1h' } }, async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: AUTO })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cache       lives 1 hour (set by the cacheTtl option)')
  })

  test('values out of range fall back to the defaults', async () => {
    expect(readOptions({ guard: 'loud', keepwarm: 'maybe', cacheTtl: '2h', stopAtPercent: 150 })).toEqual({ guard: 'auto', keepwarm: 'on', cacheTtl: 'auto', stopAtPercent: 95 })
    expect(readOptions({ guard: 'warn', keepwarm: 'manual', cacheTtl: '5m', stopAtPercent: 80 })).toEqual({ guard: 'warn', keepwarm: 'manual', cacheTtl: '5m', stopAtPercent: 80 })
  })
})

describe('an organization mod', () => {
  test('is told the account: the card shows the plan, never the email', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: AUTO, model: 'claude-sonnet-5', identity: { kind: 'claude.ai', organizationId: 'org-1', organizationType: 'claude_team', email: 'person@example.com', isVerified: true } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    const text = await cardOf($)
    expect(text).toMatch('account     claude.ai, claude_team')
    expect(text).toMatch('cache       lives 1 hour (a Team seat within its allowance)')
    expect(text.includes('person@example.com')).toBe(false)
  })

  test('an API key caches for five minutes by default', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { settings: AUTO, identity: { kind: 'api-key', isVerified: false } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cache       lives 5 minutes (signed in with api-key, which caches for 5 minutes by default)')
  })

  test('the belief reads the strongest source first', async () => {
    const s = freshState()
    s.subscription = true
    s.lastModel = 'claude-sonnet-5'
    expect(belief(s)).toEqual({ ttl: '1h', why: 'a subscription within its limits' })
    s.evidence['claude-sonnet-5'] = { ttl: '5m', why: 'a re-write 9m into a break', seen: 1, engine: false }
    expect(belief(s).ttl).toBe('1h')
    s.evidence['claude-sonnet-5'] = { ttl: '5m', why: 'a re-write 9m into a break', seen: 2, engine: false }
    expect(belief(s)).toEqual({ ttl: '5m', why: 'a re-write 9m into a break, seen 2 times' })
    // Sightings are another model's once the session moves on.
    s.lastModel = 'claude-opus-5-5'
    expect(belief(s).ttl).toBe('1h')
    s.lastModel = 'claude-sonnet-5-20261001'
    expect(belief(s).ttl).toBe('5m')
    s.chosen = '1h'
    s.chosenBy = 'set with /cache-tax ttl'
    expect(belief(s)).toEqual({ ttl: '1h', why: 'set with /cache-tax ttl' })
    s.evidence['claude-sonnet-5'] = { ttl: '5m', why: 'Claude Code reported it at a model switch', seen: 1, engine: true }
    expect(belief(s).ttl).toBe('5m')
    s.settingTtl = { ttl: '1h', why: 'the promptCacheTtl setting' }
    expect(belief(s).ttl).toBe('1h')
  })
})

// The suites below drive the failure scenarios of the 2.4.0 review, one or more per finding.

describe('a model, effort or tool change is not the lifetime', () => {
  test('A1: a model chosen during a break holds the pings with no lifetime recorded, and pings start again after a turn on it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let model = 'claude-sonnet-5'
    const first = sonnet({ cache_read_input_tokens: 20000, cache_creation_input_tokens: 180500 })
    const onOpus = usage({ model: 'claude-opus-5-5', ...cold20k })
    const w = world(on, [warm], { settings: AUTO, limits: { now: [window5h(10)] }, model: () => model, steps: [first, sonnet(), onOpus] })
    await $.session.start(session)
    await stepAt($, 'claude-sonnet-5')
    await $.turn.complete(turn({ usage: first }))
    await stepAt($, 'claude-sonnet-5')
    await $.turn.complete(turn({ usage: sonnet() }))
    await $.command.run(run('keepwarm', '3h'))
    model = 'claude-opus-5-5'
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(w.status.at(-1)).toBe('keepwarm 2h10m left · no pings: the model changed to claude-opus-5-5 since your last message, so the cache a ping would keep is not the one your next message reads')
    expect(await cardOf($)).toMatch('cache       lives 1 hour (a subscription within its limits)')
    // The turn on the new model writes its cache, which is no cold write of a break, and pings keep that one.
    await stepAt($, 'claude-opus-5-5')
    await $.turn.complete(turn({ usage: onOpus }))
    expect(await cardOf($)).toMatch('session     0 cold writes paid')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('A1: a ping after the tool list changed re-writes the cache without counting against the lifetime, and the window goes on', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const tools = { names: ['Bash', 'Read'] }
    const first = sonnet({ cache_read_input_tokens: 20000, cache_creation_input_tokens: 180500 })
    const w = world(on, [{ read: 20000, write: 180000 }, warm], { settings: AUTO, limits: { now: [window5h(10)] }, model: 'claude-sonnet-5', tools, steps: [first, sonnet()] })
    await $.session.start(session)
    await stepAt($, 'claude-sonnet-5')
    await $.turn.complete(turn({ usage: first }))
    await stepAt($, 'claude-sonnet-5')
    await $.turn.complete(turn({ usage: sonnet() }))
    await $.command.run(run('keepwarm', '3h'))
    tools.names = ['Bash', 'Read', 'mcp__docs__search']
    await clock.advance(50 * MIN)
    expect(w.logs.at(-1)).toBe('the ping re-wrote 180k tokens ($0.72) because the tool list changed since your last message; your next message and the next ping read what it wrote.')
    expect(w.status.at(-1)).toMatch(/^keepwarm 2h10m left · ping in 50m · last ping read 20k/)
    expect(await cardOf($)).toMatch('cache       lives 1 hour (a subscription within its limits)')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/last ping read 200k/)
  })

  test('A8: /effort during a break holds the pings until the next message, whose re-write is blamed on neither the pings nor the lifetime', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const first = usage({ cache_read_input_tokens: 20000, cache_creation_input_tokens: 180500 })
    const rewrite = usage({ cache_read_input_tokens: 23000, cache_creation_input_tokens: 133000 })
    const w = world(on, [warm, warm], { steps: [first, usage(), rewrite] })
    await $.session.start(session)
    await stepAt($, 'claude-fable-5-1', 'medium')
    await $.turn.complete(turn({ usage: first }))
    await stepAt($, 'claude-fable-5-1', 'medium')
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.command.run(run('effort', 'high'))
    expect(w.status.at(-1)).toMatch(/· no pings: the effort changed since your last message/)
    await clock.advance(6 * MIN)
    await stepAt($, 'claude-fable-5-1', 'high')
    await $.turn.complete(turn({ usage: rewrite }))
    const text = await cardOf($)
    expect(text).toMatch(/keepwarm    on, /)
    expect(text).toMatch('session     0 cold writes paid')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('A9: the prefix every conversation shares is not the conversation: a 30k context with 20k of it shared says nothing of the lifetime', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const first = usage({ cache_read_input_tokens: 20000, cache_creation_input_tokens: 10000 })
    const read = usage({ cache_read_input_tokens: 30000, cache_creation_input_tokens: 500 })
    world(on, [], { settings: AUTO, steps: [first, read, read] })
    await $.session.start(session)
    await stepAt($)
    await $.turn.complete(turn({ usage: first }))
    await stepAt($)
    await $.turn.complete(turn({ usage: read }))
    await clock.advance(20 * MIN)
    await stepAt($)
    expect(await cardOf($)).toMatch('cache       lifetime not confirmed')
  })
})

describe('the verdict that pings do not hold', () => {
  test('A3: an explicit /keepwarm tries pings again, and /clear forgets the last receipt', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const w = world(on, [warm, warm], { sid: () => sid, steps: [usage(cold20k)] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(70 * MIN)
    await stepAt($)
    await $.turn.complete(turn({ usage: usage(cold20k) }))
    expect(await cardOf($)).toMatch(/keepwarm    stopped, the message 20m after the last ping re-wrote 180k tokens/)
    expect((await $.command.run(run('keepwarm', '3h'))).text).toBe('keepwarm on for 3h00m, a ping 50m after each idle stretch keeps the cache read, not re-written')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(await cardOf($)).toMatch(/last ping read 200k/)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    await $.command.run(run('keepwarm', '3h'))
    expect(await cardOf($)).not.toMatch(/last ping read/)
  })

  test('A3: the reply to /keepwarm says when no pings will go, and why', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { limits: { now: [window5h(97)] } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '3h'))).text).toBe('keepwarm on for 3h00m, a ping 50m after each idle stretch keeps the cache read, not re-written. No pings for now: the 5-hour limit is at 97%, keepwarm stops at 95%')
  })

  test('A4: a resume does not judge its first request as the comeback after a ping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [warm], { steps: [usage({ cache_read_input_tokens: 20000, cache_creation_input_tokens: 135000 })] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 20 * 60, context_tokens: 155000 })
    expect(await cardOf($)).not.toMatch(/last ping read/)
    await clock.advance(MIN)
    await stepAt($)
    expect(await cardOf($)).toMatch(/keepwarm    on, /)
  })
})

describe('a ping after a single exchange', () => {
  test('A7: re-writes the first message Claude Code re-sends, keeps the window, and says nothing of the lifetime', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const first = sonnet({ cache_read_input_tokens: 20365, cache_creation_input_tokens: 14000 })
    const w = world(on, [{ read: 22743, write: 11989 }, { read: 34732, write: 0 }], { settings: AUTO, limits: { now: [window5h(10)] }, model: 'claude-sonnet-5', steps: [first] })
    await $.session.start(session)
    await stepAt($, 'claude-sonnet-5')
    await $.turn.complete(turn({ usage: first }))
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.logs.at(-1)).toMatch(/^the ping re-wrote 12k tokens \(\$0\.\d\d\) because Claude Code re-sends the first message in full after the first turn/)
    expect(w.status.at(-1)).toMatch(/^keepwarm 2h10m left · ping in 50m · last ping read 23k/)
    expect(await cardOf($)).toMatch('cache       lives 1 hour (a subscription within its limits)')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/last ping read 35k/)
  })

  test('A7: a ping that read nothing after a single exchange still stops', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const first = usage({ cache_read_input_tokens: 20365, cache_creation_input_tokens: 14000 })
    const w = world(on, [{ read: 0, write: 34000 }], { steps: [first] })
    await $.session.start(session)
    await stepAt($)
    await $.turn.complete(turn({ usage: first }))
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 34k tokens/)
  })

  test('C1: the comeback after a single exchange, which re-sends the first message, is no cold write and opens no window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const first = usage({ cache_read_input_tokens: 20365, cache_creation_input_tokens: 180000 })
    const second = usage({ cache_read_input_tokens: 22743, cache_creation_input_tokens: 178000 })
    const w = world(on, [], { steps: [first, second] })
    await $.session.start(session)
    await stepAt($)
    await $.turn.complete(turn({ usage: first }))
    await clock.advance(10 * MIN)
    await stepAt($)
    await $.turn.complete(turn({ usage: second }))
    expect(await cardOf($)).toMatch('session     0 cold writes paid')
    expect(w.status.at(-1)).toBe(undefined)
  })
})

describe('caching off for one model, and lifetimes set in the environment', () => {
  test('A5: DISABLE_PROMPT_CACHING_SONNET leaves a Sonnet session nothing to warm or guard, and Fable still both', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { env: { DISABLE_PROMPT_CACHING_SONNET: '1' }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    expect(await cardOf($)).toMatch('cache       off (DISABLE_PROMPT_CACHING_SONNET), nothing to keep warm')
    expect((await $.command.run(run('keepwarm', ''))).text).toBe('prompt caching is off in this session (DISABLE_PROMPT_CACHING_SONNET), so there is nothing to keep warm')
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('again'))).drop).toMatch(/^cache-tax:/)
  })

  test('A5: a request that neither reads nor writes a long prompt shows caching off for its model', async ($, on) => {
    mock.clock(on, { now: START })
    const off = usage({ input_tokens: 34700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    world(on, [], { steps: [off] })
    await $.session.start(session)
    await stepAt($)
    await $.turn.complete(turn({ usage: off }))
    expect(await cardOf($)).toMatch('cache       off (a request on claude-fable-5-1 read and wrote nothing), nothing to keep warm')
  })

  test('A5: a ping that neither read nor wrote a long prompt stops, and caching shows off for the model', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0, input: 34700 }])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm stopped: the ping read 0 and wrote 0 tokens ($0.35): prompt caching is off for this model')
    expect(await cardOf($)).toMatch('cache       off (a ping on claude-fable-5-1 read and wrote nothing)')
  })

  for (const [env, fix] of [
    [{ FORCE_PROMPT_CACHING_5M: '1' }, 'Unsetting FORCE_PROMPT_CACHING_5M, with "promptCacheTtl": "1h" in settings, keeps it an hour'],
    [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, 'CLAUDE_CODE_PROMPT_CACHE_TTL=1h keeps it an hour'],
    [{ CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: '5m' }, 'Unsetting CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL, with "promptCacheTtl": "1h" in settings, keeps it an hour'],
  ] as const) {
    test(`A6: a lifetime ${Object.keys(env)[0]} forces names that variable, not the setting it overrides`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { env })
      await $.session.start(session)
      await $.turn.complete(turn())
      expect((await $.command.run(run('keepwarm', ''))).text).toMatch(`re-send the whole context. ${fix} (its writes cost 2x base input, not 1.25x); for a short break, /keepwarm 30m every 4m.`)
    })
  }
})

describe('limit readings past their reset', () => {
  test('B1: a used-up window that has since reset no longer means usage credits', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const resetsAt = new Date(START + HOUR).toISOString()
    world(on, [], { settings: AUTO, limits: { now: [{ kind: 'five_hour', percentUsed: 100, resetsAt }] }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    expect(await cardOf($)).toMatch('cache       lives 5 minutes (a plan limit is used up')
    await clock.advance(2 * HOUR)
    const text = await cardOf($)
    expect(text).toMatch('cache       lives 1 hour (a subscription within its limits)')
    expect(text).toMatch('plan        5h reset since the last reading;')
  })

  test('B1: pings held at the stop line go on when the window resets, with no new reading', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 96, resetsAt: new Date(START + 30 * MIN).toISOString() }]))
    expect(w.status.at(-1)).toMatch(/no pings: the 5-hour limit is at 96%/)
    await clock.advance(30 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 2h30m left · ping in 20m')
    await clock.advance(20 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('what counts as a cold write', () => {
  test('C1: a warm turn that adds much new content is no cold write and opens no window', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage({ cache_read_input_tokens: 200500, cache_creation_input_tokens: 120000 })] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    for await (const c of $.turn.step({ turnId: 'read', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    for await (const c of $.turn.step({ turnId: 'read', index: 1, model: 'claude-fable-5-1', messageCount: 5 })) void c
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 400500, cache_creation_input_tokens: 120500 }) }))
    expect(await cardOf($)).toMatch('session     0 cold writes paid')
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
  })
})

describe('managed pricing as Claude Code applies it', () => {
  test('C3: the multiplier scales an overridden row too', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { policy: { modelPricing: { multiplier: 0.5, overrides: { 'claude-fable-5-1': { input: 5, output: 25, cacheRead: 0.1, cacheWrite: 8 } } } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cold cost   $0.80 to re-write it (warm turn $0.01)')
  })

  test('C3: a key no built-in model uses matches only that exact id; a built-in key covers its dated forms', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 }, policy: { modelPricing: { overrides: {
      claude: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      'claude-opus-4-1': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
    } } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cold cost   $4.00 to re-write it (warm turn $0.05)')
    await $.turn.complete(turn({ usage: usage({ model: 'claude-opus-4-1-20250805' }) }))
    expect(await cardOf($)).toMatch('cold cost   $2.00 to re-write it (warm turn $0.10)')
  })

  test('C3: a row missing one of its four rates is skipped for the list price', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 }, policy: { modelPricing: { overrides: { 'claude-fable-5-1': { input: 5, cacheRead: 0.1, cacheWrite: 8 } } } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('cold cost   $4.00 to re-write it (warm turn $0.05)')
  })
})

describe('options the organization or a settings file sets', () => {
  test("D1: a guard managed settings set is the organization's even where no row shows a lock", async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { policy: { pluginConfigs: { 'cache-tax@claude-optimization': { options: { guard: 'auto' } } } }, store: new Map<string, unknown>([['guard', 'off']]) })
    await $.session.start(session)
    expect((await $.command.run(run('cache-tax', 'guard off'))).text).toBe('the guard is auto, set by your organization')
    expect(await cardOf($)).toMatch('options     set by your organization: guard')
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-tax:/)
    expect(w.entered).toEqual([])
  })

  test("D1: a value set away from its default stands over this machine's stored choice", { options: { guard: 'warn' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: new Map<string, unknown>([['guard', 'off']]) })
    await $.session.start(session)
    expect((await $.command.run(run('cache-tax', 'guard off'))).text).toBe('the guard is warn, set in settings (pluginConfigs); change it with /config')
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.at(-1)).toMatch(/^the prompt cache went cold 2h00m ago\. .* Sending anyway/)
  })

  test("D1: options whose rows are kept from this mod, while other plugins' show, may be locked: the stored choice gives way and a change is refused", async ($, on) => {
    mock.clock(on, { now: START })
    const other: ConfigRow = { key: 'cc-plugin-agents-md.instructionFiles', label: 'Instruction files', kind: 'text', value: '', provider: { plugin: 'cc-plugin-agents-md@builtin', tier: 'user' }, isLocked: false }
    world(on, [], { rows: [other], store: new Map<string, unknown>([['guard', 'off']]) })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(await cardOf($)).toMatch('guard       auto: refuse once')
    expect((await $.command.run(run('cache-tax', 'guard warn'))).text).toBe("the guard is auto; its /config row is kept from this mod, so it may be your organization's: change it with /config")
  })

  test('D1: a lock on the row keyed by the plugin id, beside another plugin of the same name, counts', async ($, on) => {
    mock.clock(on, { now: START })
    const locked: ConfigRow = { key: 'cache-tax@claude-optimization.guard', label: 'Cold-send guard', kind: 'choice', value: 'auto', provider: { plugin: 'cache-tax@claude-optimization', tier: 'user' }, isLocked: true }
    world(on, [], { rows: [locked, ...OWN_ROWS] })
    await $.session.start(session)
    expect((await $.command.run(run('cache-tax', 'guard off'))).text).toBe('the guard is auto, set by your organization')
  })

  test('D1: where no plugin rows are listed at all, as under -p, the commands still set the options', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { rows: [], store })
    await $.session.start(session)
    expect((await $.command.run(run('cache-tax', 'guard warn'))).text).toMatch(/^guard set to warn/)
    expect(store.get('guard')).toBe('warn')
  })
})

describe('the session id behind stored windows', () => {
  test("D2: a resume inside the process ends the old conversation's window, takes up its own, and stores under its id", async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'A'
    const store = new Map<string, unknown>([['deadline:B', START + 2 * HOUR]])
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    expect(store.get('deadline:A')).toBe(START + 3 * HOUR)
    await clock.advance(MIN)
    sid = 'B'
    await $.session.end({ reason: 'resume', sessionId: 'A', resume: { id: 'A' } })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 100000 })
    expect(store.has('deadline:A')).toBe(false)
    expect(await cardOf($)).toMatch(/keepwarm    on, 1h59m left/)
    await $.command.run(run('keepwarm', '90m every 4m'))
    expect(store.get('deadline:B')).toBe(START + MIN + 90 * MIN)
    expect(store.get('every:B')).toBe(4 * MIN)
    expect(store.has('every:A')).toBe(false)
  })

  test('D2: after a /clear only session.end told of, a window armed before the next turn is stored under the new id', async ($, on) => {
    mock.clock(on, { now: START })
    let sid = 'S1'
    const store = new Map<string, unknown>()
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    sid = 'S2'
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
    await $.command.run(run('keepwarm', '90m'))
    expect(store.get('deadline:S2')).toBe(START + 90 * MIN)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.has('deadline:S2')).toBe(false)
  })
})

describe('always on a five-minute cache', () => {
  test('E1: a short window armed for a break keeps its period across a turn', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    world(on, [], { ...FIVE, store })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '2h every 4m'))).text).toBe('keepwarm on for 2h00m, a ping 4m after each idle stretch keeps the cache read, not re-written')
    await $.turn.complete(turn())
    expect(store.get('every:S1')).toBe(4 * MIN)
    expect(store.get('deadline:S1')).toBe(START + 2 * HOUR)
  })

  test('E1: always opens 30 minutes at one ping per 4 minutes after each turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm, warm], { ...FIVE, store })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 30m left · ping in 4m')
    await clock.advance(8 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('the go-ahead on an unconfirmed lifetime', () => {
  test('E2: a short period arms at once while the cache cannot have expired, and asks once it may have', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { settings: AUTO })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '30m every 4m'))).text).toBe('keepwarm on for 30m, a ping 4m after each idle stretch keeps the cache read, not re-written')
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(20 * MIN)
    expect((await $.command.run(run('keepwarm', '30m every 4m'))).text).toBe("cache-tax can't confirm this session's prompt cache lives an hour (no plan limits are visible to this mod, as on a Team or Enterprise login, an API key or a cloud provider). If it lives 5 minutes, the first ping, 20m into this break, re-sends up to 200,502 tokens (about $2.01) for nothing. Send /keepwarm 30m every 4m again to arm it anyway, or /cache-tax ttl 1h if you know it lives an hour.")
    expect(w.forks.length).toBe(0)
  })

  test('E2: a go-ahead holds for its window: /keepwarm off ends it, and an always window opened later goes without', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { settings: AUTO, store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '90m'))
    await $.command.run(run('keepwarm', '90m'))
    expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
    await $.command.run(run('keepwarm', 'off'))
    store.set('always', true)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/^keepwarm 6h00m left · no pings: this cache's lifetime isn't confirmed/)
  })
})

describe('an engine whose identity call fails', () => {
  test('D3: the session starts and the commands register all the same', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { identity: 'throw' })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    expect(await cardOf($)).not.toMatch(/^account/m)
  })
})

describe('always on an unconfirmed lifetime', () => {
  test('E1: a short window armed for a break keeps its period across a turn, and its reply announces no swap', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm, warm, warm, warm, warm], { settings: AUTO, store })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '30m every 4m'))).text).toBe('keepwarm on for 30m, a ping 4m after each idle stretch keeps the cache read, not re-written')
    await clock.advance(4 * MIN)
    expect(w.forks.length).toBe(1)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 30m left · ping in 4m · last ping read 200k $0.05')
    expect(store.get('every:S1')).toBe(4 * MIN)
    await clock.advance(12 * MIN)
    expect(w.forks.length).toBe(4)
  })

  test('E1: a window armed on a go-ahead rolls as on an hour and keeps the go-ahead, as its reply says', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { settings: AUTO, store })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', '2h every 10m'))).text).toMatch(/^cache-tax can't confirm/)
    expect((await $.command.run(run('keepwarm', '2h every 10m'))).text).toBe('keepwarm on for 2h00m, a ping 10m after each idle stretch keeps the cache read, not re-written. The lifetime is unconfirmed: the first ping checks it, and keepwarm stops if the cache is gone. Always is on, so your next turn makes it at least 6h00m at one ping per 50m')
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(await cardOf($)).toMatch('cache       lives 1 hour (a ping read the cache 50m into a break)')
  })

  test("/keepwarm always on a go-ahead says only this session's window has it, and always's window after /clear waits for the lifetime", async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { settings: AUTO, store: new Map<string, unknown>() })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(run('keepwarm', 'always'))).text).toMatch(/^cache-tax can't confirm .* Send \/keepwarm always again to arm it anyway/)
    expect((await $.command.run(run('keepwarm', 'always'))).text).toBe('keepwarm always on: on your go-ahead this session stays warm until 6h00m after its last turn, and its first ping checks the lifetime (keepwarm stops if the cache is gone); other sessions, and this one after /clear or a stop, send no pings until the lifetime is confirmed (/cache-tax ttl 1h if it lives an hour); /keepwarm off turns it off for good')
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
    await $.classic.SessionStart({ source: 'clear' })
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/^keepwarm 6h00m left · no pings: this cache's lifetime isn't confirmed/)
  })

  test('after a resume judged expired, a short period arms without asking and its first ping waits for the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [warm], { settings: AUTO })
    await $.session.start(session)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 1200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect((await $.command.run(run('keepwarm', '30m every 4m'))).text).toBe('keepwarm on for 30m. The cache is cold now, so the first ping comes 4m after the next turn')
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(4 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('prices as the guard quotes them', () => {
  test("after a model switch the guard gives Claude Code's estimate alone, not a table rate that does not multiply out to it", async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { limits: { now: [window5h(10)] }, model: 'claude-sonnet-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: sonnet() }))
    await clock.advance(2 * HOUR)
    await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-5', to_model: 'claude-sonnet-5-5', requested_model: null, source: 'command', context_tokens: 200000, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0.5, pricing: 'catalog' })
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe("cache-tax: the prompt cache went cold 1h00m ago. Sending this re-writes up to 200,000 tokens, about $0.50 by Claude Code's estimate (a warm turn would have cost $0.02). Send it again to pay it. Or /clear and start from a note.")
  })

  test('K22: a rate a managed multiplier scaled prints to six significant figures', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { ...FIVE, policy: { modelPricing: { multiplier: 1.15 } } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(6 * MIN)
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.at(-1)).toMatch(/^the prompt cache went cold 1m ago\. Sending this re-writes up to 200,502 tokens at \$14\.375\/MTok = \$2\.88 \(a warm turn would have cost \$0\.06\)\. Sending anyway\./)
  })
})
