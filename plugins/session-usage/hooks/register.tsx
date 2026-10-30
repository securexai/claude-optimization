import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Live, Tokens, Totals, Turn } from '../types'

const KEEP_TURNS = 100

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const live = atom(
  { plugin: 'session-usage', key: 'live' } as const,
  { contextWindow: 0, rateLimits: [] },
  { shape: 'live-1' },
)
const turns = atom({ plugin: 'session-usage', key: 'turns' } as const, [], {
  shape: 'turns-1',
})
const totals = atom(
  { plugin: 'session-usage', key: 'totals' } as const,
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, agentTurns: 0 },
  { shape: 'totals-1' },
)
// The session cost when the running main-loop turn started, so spend between
// turns (another mod's keepwarm pings) lands on no turn.
const costMark = atom({ plugin: 'session-usage', key: 'costMark' } as const, 0, {
  shape: 'cost-mark-1',
})
const isHidden = atom({ plugin: 'session-usage', key: 'isHidden' } as const, false)

type Measured = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const toLive = (u: Measured): Live => ({
  costUsd: u.cost?.usd,
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  rateLimits: u.rateLimits.map(r => ({
    kind: r.kind,
    percentUsed: r.percentUsed,
    resetsAt: r.resetsAt,
  })),
})

const tokens = (n: number): string =>
  n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(1)}k`
      : `${(n / 1_000_000).toFixed(2)}M`

const usd = (n: number | undefined): string =>
  n === undefined ? '–' : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`

// Share of the prompt the cache served.
const cacheHit = (t: Tokens): number | undefined => {
  const prompt = t.input + t.cacheRead + t.cacheWrite

  return prompt === 0 ? undefined : Math.round((t.cacheRead / prompt) * 100)
}

const pct = (n: number | undefined): string => (n === undefined ? '–' : `${n}%`)

const level = (percent: number | undefined): Color | undefined =>
  percent === undefined
    ? undefined
    : percent >= 90
      ? 'error'
      : percent >= 75
        ? 'warning'
        : 'success'

const bar = (percent: number, width: number): string => {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return '█'.repeat(full) + '░'.repeat(width - full)
}

const until = (resetsAt: string | undefined, now: number): string => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  if (mins >= 48 * 60) return ` (${Math.round(mins / 1440)}d)`
  if (mins >= 60) return ` (${Math.floor(mins / 60)}h${mins % 60}m)`

  return ` (${mins}m)`
}

const limitName = (kind: string): string =>
  ({ five_hour: '5h', seven_day: '7d', spend_limit: 'spend' })[kind] ?? kind

const shortModel = (model: string): string => model.replace(/^claude-/, '')

const seconds = (ms: number): string =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(0)}s`
    : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`

const refresh = async ($: EngineInterface): Promise<SessionUsage> => {
  const u = await $.session.usage()
  await update($, live, () => toLive(u))

  return u
}

// One stretch of the bar: its words and the colour they take.
type Segment = { key: string; text: string; color?: Color; isDim?: boolean }

const SEP = ' · '

// Keeps the segments in order while they fit the width; drops the rest.
const fit = (segments: Segment[], width: number): Segment[] => {
  const kept: Segment[] = []
  let used = 0
  for (const s of segments) {
    const cost = (kept.length > 0 ? SEP.length : 0) + s.text.length
    if (used + cost > width) break
    kept.push(s)
    used += cost
  }

  return kept
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'usage-bar',
      description: 'Show or hide the live token usage and cost bar',
    })
    await refresh($)

    return started
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    await refresh($)
    const hidden = await update($, isHidden, was => !was)

    return { text: hidden ? 'Usage bar hidden.' : 'Usage bar shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const u = await $.session.usage()
      await update($, costMark, () => u.cost?.usd ?? 0)
    }

    return next(e)
  })

  // Pushed after every main-thread turn and when a rate-limit window moves.
  on('session.measure', async ($, e, next) => {
    await update($, live, () => toLive(e))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = e.usage
    if (usage === undefined) return done

    const spent: Tokens = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    }
    const isAgent = e.agentId !== undefined
    await update($, totals, (t): Totals => ({
      input: t.input + spent.input,
      output: t.output + spent.output,
      cacheRead: t.cacheRead + spent.cacheRead,
      cacheWrite: t.cacheWrite + spent.cacheWrite,
      turns: t.turns + (isAgent ? 0 : 1),
      agentTurns: t.agentTurns + (isAgent ? 1 : 0),
    }))
    if (isAgent) return done

    const u = await refresh($)
    const now = u.cost?.usd
    const mark = await read($, costMark)
    const turn: Turn = {
      ...spent,
      id: e.turnId,
      model: usage.model,
      durationMs: e.durationMs,
      costUsd: now === undefined ? undefined : Math.max(0, now - mark),
    }
    await update($, turns, list => [...list, turn].slice(-KEEP_TURNS))

    return done
  })

  // Draws below whatever the rest of the chain (other mods, the engine) shows,
  // never in its place.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey || (await read($, isHidden))) return rest

    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, live)
    const t = await read($, totals)
    const history = await read($, turns)
    const last = history[history.length - 1]
    const now = await $.clock.now()
    const hit = cacheHit(t)

    const segments: Segment[] = [
      { key: 'cost', text: usd(l.costUsd), color: 'claude' },
      {
        key: 'context',
        text: `ctx ${l.contextTokens === undefined ? '–' : tokens(l.contextTokens)}/${
          l.contextWindow > 0 ? tokens(l.contextWindow) : '–'
        } ${l.contextPercent === undefined ? '' : `${bar(l.contextPercent, 10)} `}${pct(l.contextPercent)}`,
        color: level(l.contextPercent),
      },
      ...l.rateLimits.map(
        (r): Segment => ({
          key: `limit-${r.kind}`,
          text: `${limitName(r.kind)} ${r.percentUsed}%${until(r.resetsAt, now)}`,
          color: level(r.percentUsed),
        }),
      ),
      {
        key: 'tokens',
        text: `in ${tokens(t.input + t.cacheRead + t.cacheWrite)} out ${tokens(t.output)} cache ${pct(hit)}`,
      },
      ...(last === undefined
        ? []
        : [
            {
              key: 'last',
              text: `last ${shortModel(last.model)} ${tokens(
                last.input + last.cacheRead + last.cacheWrite,
              )}→${tokens(last.output)} ${usd(last.costUsd)} ${seconds(last.durationMs)}`,
              isDim: true,
            },
          ]),
    ]

    return (
      <Box flexDirection="column">
        {rest}
        <Box key="bar" flexDirection="row">
          {fit(segments, e.props.bodyColumns).map((s, i) => (
            <Text key={s.key} color={s.color} dimColor={s.isDim}>
              {i > 0 ? SEP : ''}
              {s.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
