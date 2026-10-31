import type { ConfigRow, EngineInterface, PluginOptions, Register, SessionIdentity, SessionRateLimit, TurnUsage } from 'claude-code'
import { statusIcons } from './status-icons'

const TTL_1H = 60 * 60 * 1000
const TTL_5M = 5 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
// What always keeps on a 5-minute cache: a short window at a period the cache outlives, as its refusal advises.
const SHORT_WINDOW_MS = 30 * 60 * 1000
const SHORT_EVERY_MS = 4 * 60 * 1000
const BIG_TOKENS = 50000
// An idle gap this far inside the two lifetimes tells them apart: a re-write after five minutes, or a read before the hour.
const OBSERVE_MARGIN_MS = 30 * 1000
// A 5-minute entry has been read 8.5 minutes after its last use, so only a read this far into a break says an hour.
const OBSERVE_1H_MS = 15 * 60 * 1000
// A smaller conversation's miss can be the model's caching minimum rather than the lifetime.
const OBSERVE_MIN_TOKENS = 20000
// Claude Code compacts a conversation this large on a 1-hour cache 0.9 of the way to its expiry, 54 minutes into a
// break, unless idleCompaction is false; CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS moves the size, never under 100k.
const IDLE_COMPACT_TOKENS = 200000
const IDLE_COMPACT_FLOOR = 100000
const IDLE_COMPACT_AFTER_MS = 0.9 * TTL_1H
// The same /keepwarm again within this long arms a window over a lifetime nobody has confirmed.
const CONFIRM_MS = 2 * 60 * 1000
const STOP_AT_PERCENT = 95
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
const KEY_TTL = 'ttl'
const PLUGIN = 'cache-tax'

// Prompts no person sent, so nobody could send them again after a refusal. Every
// other origin, including sdk, unclassified and the owner's own Slack or channel
// messages, may carry a person's words and keeps the guard.
const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type Ttl = '1h' | '5m'
type Belief = { ttl: Ttl | null; why: string }
/** What one model's requests showed of its lifetime, `seen` times running, or what Claude Code itself reported for it. */
type Evidence = { ttl: Ttl; why: string; seen: number; engine: boolean }
type GuardMode = 'auto' | 'refuse' | 'warn' | 'off'
type KeepwarmMode = 'on' | 'manual' | 'off'
type Field = 'guard' | 'keepwarm' | 'cacheTtl' | 'stopAtPercent'
type Move = { kind: string; delta: number }
type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean; moves: Move[] }
type Miss = { at: number; tokens: number; usd: number | null }
/** A limit window as the last response reported it, or marked reset when its window has turned over since. */
type Reading = SessionRateLimit & { reset?: true }
/** $ per million tokens of one model: uncached input, cache read, the two cache writes, output. */
type Rates = { input: number; read: number; write1h: number; write5m: number; output: number }
/** One managed modelPricing row: all four rates, or Claude Code skips it. */
type PriceRow = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Pricing = { multiplier: number; overrides: Record<string, PriceRow> }
type Options = { guard: GuardMode; keepwarm: KeepwarmMode; cacheTtl: 'auto' | Ttl; stopAtPercent: number }
/** A break before a main request: how long, the context before it, its model, whether a ping ended it, and what explains a miss. */
type Gap = { gap: number; prev: number; model: string | null; afterPing: boolean; explained: string | null }
/** A turn's first request: what it found of the cache, its write at its own tier, and what explains a miss. */
type FirstStep = { read: number; write: number; usd: number | null; explained: string | null }

const FIELDS: readonly Field[] = ['guard', 'keepwarm', 'cacheTtl', 'stopAtPercent']
const DEFAULTS: Options = { guard: 'auto', keepwarm: 'on', cacheTtl: 'auto', stopAtPercent: STOP_AT_PERCENT }

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  // The last main-thread request: when it went out, the model that answered and the model and effort it named, and
  // what the cache held after it.
  lastMainAt: number
  lastModel: string | null
  lastAsked: string | null
  lastEffort: string | number | null | undefined
  lastPrefix: number | null
  lastRead: number | null
  ctx: number
  compacted: boolean
  // Claude Code judged the resumed conversation's cache expired: cold until its first request, whatever the clock says.
  resumeCold: boolean
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  firstStep: FirstStep | null
  // The cache's lifetime rests on, strongest first: configuration Claude Code obeys, a plan limit used up, Claude
  // Code's own word for the model, a statement, what this session's requests showed, the plan's own default.
  cacheOff: string | null
  offFamilies: string[]
  offSeen: Record<string, string>
  envTtl: Belief | null
  settingTtl: Belief | null
  enable1h: boolean
  evidence: Record<string, Evidence>
  chosen: Ttl | null
  chosenBy: string
  account: { kind: string; plan: string | null } | null
  limits: Reading[]
  limitsUntil: number
  subscription: boolean
  answered: boolean
  limitStop: string | null
  stopAtPercent: number
  pricing: Pricing | null
  engineCold: { usd: number; ctx: number } | null
  idleCompaction: boolean
  idleMin: number
  // What this conversation's next request can show: its turns in this process, whether it was resumed, the prefix
  // every conversation shares, and a change since the last main request that explains a miss.
  convTurns: number
  convResumed: boolean
  firstExchange: boolean
  resumeSeeded: boolean
  shared: number
  toolsKey: string | null
  prefixChange: string | null
  pingsHold: boolean | null
  lastWasPing: boolean
  armedAnyway: boolean
  confirm: { args: string; at: number } | null
  warnedFix: boolean
  keepwarm: KeepwarmMode
  // Options the organization owns and options a settings file sets, over which a stored choice gives way, and
  // options whose /config row is kept from this mod while others' show, which may be locked.
  locked: Field[]
  pinned: Field[]
  hidden: Field[]
  stored: { guard: GuardMode | null; ttl: Ttl | null }
  classicSeen: boolean | null
  turnsSeen: number
  sidStale: boolean
}

function norm(model: string | null): string {
  return (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
}

/** One model under its dated, provider and context spellings: claude-opus-4-1-20250805, claude-opus-4-1@20250805 and us.anthropic.claude-opus-4-1-20250805-v1:0 are claude-opus-4-1. */
function modelKey(model: string | null): string {
  return (model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^(?:[a-z]{2,}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '').replace(/[-@]20\d{6}$/, '').replace(/[\s.]+/g, '-')
}

/** Whether two spellings name one model; a shorter one may leave off the start, as a display name does. */
function sameModel(a: string | null, b: string | null): boolean {
  const x = modelKey(a)
  const y = modelKey(b)
  return x === y || x.endsWith('-' + y) || y.endsWith('-' + x)
}

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = norm(model)
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

/** A built-in model's id as Claude Code spells it: such a modelPricing key covers that model's dated and provider forms. */
function isBuiltIn(key: string): boolean {
  return /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-\d+(?:-\d+)?|3(?:-[57])?-(?:opus|sonnet|haiku))$/.test(key)
}

/** The managed row for a model id, found as Claude Code finds it: the id itself in any case first, then a built-in model's key for any of its forms. */
function overrideOf(p: Pricing, model: string | null): PriceRow | undefined {
  const id = (model ?? '').trim().toLowerCase()
  const rows = Object.entries(p.overrides)
  const exact = rows.find(([key]) => key.trim().toLowerCase() === id)
  if (exact) return exact[1]
  const own = modelKey(model)
  return rows.find(([key]) => isBuiltIn(modelKey(key)) && modelKey(key) === own)?.[1]
}

/**
 * The rates a request is billed at: the organization's managed modelPricing row where one names the model, else the
 * list row, either scaled by its multiplier. A row's one cacheWrite prices both lifetimes; on the list a 5-minute
 * write is 1.25x base input against 2x for the hour.
 */
function ratesOf(s: State, model: string | null, promptTokens: number): Rates | null {
  const m = s.pricing?.multiplier ?? 1
  const own = s.pricing ? overrideOf(s.pricing, model) : undefined
  if (own) return { input: own.input * m, read: own.cacheRead * m, write1h: own.cacheWrite * m, write5m: own.cacheWrite * m, output: own.output * m }
  const list = priceOf(model, promptTokens)
  if (!list) return null
  return { input: list[1] / 2 * m, read: list[0] * m, write1h: list[1] * m, write5m: list[1] * 0.625 * m, output: list[2] * m }
}

/** An unconfirmed lifetime is priced at the hour's write, the upper bound. */
function writeRate(r: Rates, ttl: Ttl | null): number {
  return ttl === '5m' ? r.write5m : r.write1h
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

/** A rate as a price list writes it: $14.375/MTok, not the $14.374999999999998 a multiplier can leave. */
function fmtRate(rate: number): string {
  return `$${Number(rate.toPrecision(6))}/MTok`
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function upper(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function isOn(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())
}

function isFable(model: string | null): boolean {
  return /fable|mythos/.test(norm(model))
}

function limitName(kind: string): string {
  return ({ five_hour: '5-hour limit', seven_day: 'weekly limit', spend_limit: 'spend limit' } as Record<string, string>)[kind] ?? `${kind} limit`
}

function limitShort(kind: string): string {
  return ({ five_hour: '5h', seven_day: '7d', spend_limit: 'spend' } as Record<string, string>)[kind] ?? kind
}

function isPlanWindow(l: SessionRateLimit): boolean {
  return l.kind === 'five_hour' || l.kind === 'seven_day'
}

function resetAt(l: SessionRateLimit): number {
  const at = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
  return Number.isNaN(at) ? Infinity : at
}

function overPlanLimit(s: State): boolean {
  return s.limits.some(l => isPlanWindow(l) && l.percentUsed >= 100)
}

/** Configuration Claude Code obeys, in its own order: FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL for the conversation, CLAUDE_CODE_PROMPT_CACHE_TTL, promptCacheTtl, ENABLE_PROMPT_CACHING_1H. */
function explicitTtl(s: State): Belief | null {
  return s.envTtl ?? s.settingTtl ?? (s.enable1h ? { ttl: '1h', why: 'ENABLE_PROMPT_CACHING_1H' } : null)
}

/** Why the session's model caches nothing, or null: the switch for every model, its family's, or a request that showed it. */
function cacheOffNow(s: State): string | null {
  if (s.cacheOff) return s.cacheOff
  const m = norm(s.lastModel)
  const family = s.offFamilies.find(f => m.includes(f))
  if (family) return `DISABLE_PROMPT_CACHING_${family.toUpperCase()}`
  return s.offSeen[modelKey(s.lastModel)] ?? null
}

/**
 * How long this session's main cache lives, and what says so. Unset, Claude Code caches for an hour on a
 * subscription within its usage limits and for five minutes everywhere else, usage credits included.
 */
export function belief(s: State): Belief {
  const set = explicitTtl(s)
  if (set) return set
  if (overPlanLimit(s)) return { ttl: '5m', why: 'a plan limit is used up, and on usage credits Claude Code caches for 5 minutes' }
  const ev = s.evidence[modelKey(s.lastModel)]
  if (ev?.engine) return { ttl: ev.ttl, why: ev.why }
  if (s.chosen) return { ttl: s.chosen, why: s.chosenBy }
  // One 5-minute sighting may be a prefix change nobody saw; it takes a second to say so.
  if (ev && (ev.ttl === '1h' || ev.seen >= 2)) return { ttl: ev.ttl, why: ev.seen > 1 ? `${ev.why}, seen ${ev.seen} times` : ev.why }
  if (s.account && s.account.kind !== 'claude.ai' && s.account.kind !== 'oauth-token') return { ttl: '5m', why: `signed in with ${s.account.kind}, which caches for 5 minutes by default` }
  if (s.subscription && !isFable(s.lastModel)) return { ttl: '1h', why: 'a subscription within its limits' }
  if (s.account?.plan === 'claude_team' && !isFable(s.lastModel)) return { ttl: '1h', why: 'a Team seat within its allowance' }
  if (s.subscription) return { ttl: null, why: 'Fable and Mythos run on usage credits on Pro and Team Standard, which cache for 5 minutes' }
  if (!s.answered) return { ttl: null, why: 'no response yet' }
  return { ttl: null, why: 'no plan limits are visible to this mod, as on a Team or Enterprise login, an API key or a cloud provider' }
}

/** Records what a request showed of one model's lifetime: the same answer again counts up, another starts over. */
function observe(s: State, model: string | null, ttl: Ttl, why: string, engine = false) {
  const key = modelKey(model)
  const was = s.evidence[key]
  // A sighting that agrees with Claude Code's own word adds nothing to it.
  if (!engine && was?.engine && was.ttl === ttl) return
  s.evidence[key] = { ttl, why, seen: !engine && was && !was.engine && was.ttl === ttl ? was.seen + 1 : 1, engine }
}

/** Idle past this, the cache is gone whatever the lifetime turns out to be. */
function coldAfter(s: State): number {
  return belief(s).ttl === '5m' ? TTL_5M : TTL_1H
}

/** Idle past this, the cache may be gone: an unconfirmed lifetime could be five minutes. */
function maybeColdAfter(s: State): number {
  return belief(s).ttl === '1h' ? TTL_1H : TTL_5M
}

/** Idle past this, pings wait for a turn: on an unconfirmed lifetime that is five minutes, until someone said to try. */
function pingColdAfter(s: State): number {
  return belief(s).ttl === null && !s.armedAnyway ? TTL_5M : coldAfter(s)
}

/** The engine's own estimate, made with its lifetime and the organization's prices at a resume or a model switch; it stands while the context does. */
function engineUsd(s: State, ctx: number): number | null {
  return s.engineCold && s.engineCold.ctx === ctx ? s.engineCold.usd : null
}

function coldUsd(s: State, ctx = s.ctx): number | null {
  const engine = engineUsd(s, ctx)
  if (engine != null) return engine
  const r = ratesOf(s, s.lastModel, ctx)
  return r ? ctx * writeRate(r, belief(s).ttl) / 1e6 : null
}

function warmUsd(s: State, ctx = s.ctx): number | null {
  const r = ratesOf(s, s.lastModel, ctx)
  return r ? ctx * r.read / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate, and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, r: Rates, ttl: Ttl | null): number {
  return (u.cache_read_input_tokens * r.read + u.cache_creation_input_tokens * writeRate(r, ttl) + u.input_tokens * r.input + u.output_tokens * r.output) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const r = ratesOf(s, s.lastModel, s.ctx)
  if (!r || s.ctx <= 0 || r.read <= 0) return null
  return Math.floor(writeRate(r, belief(s).ttl) / r.read)
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && (s.resumeCold || now - s.lastRequestAt >= coldAfter(s))
}

function maybeCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && (s.resumeCold || now - s.lastRequestAt >= maybeColdAfter(s))
}

function pastCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && (s.resumeCold || now - s.lastRequestAt >= pingColdAfter(s))
}

/** Why pings must not run now, or null when they may. */
function holdReason(s: State): string | null {
  const off = cacheOffNow(s)
  if (off) return `prompt caching is off (${off})`
  if (s.keepwarm === 'off') return 'keepwarm is off by option'
  if (s.limitStop) return s.limitStop
  if (s.prefixChange) return `${s.prefixChange} since your last message, so the cache a ping would keep is not the one your next message reads`
  if (s.pingsHold === false) return 'a ping did not keep this cache alive; /keepwarm tries again'
  const b = belief(s)
  // A period under five minutes holds a 5-minute cache too; a longer one would find it gone.
  if (b.ttl === '5m' && s.every >= TTL_5M) return `this cache lives 5 minutes (${b.why})`
  if (b.ttl === null && !s.armedAnyway && s.every >= TTL_5M) return `this cache's lifetime isn't confirmed (${b.why})`
  return null
}

/** Why a cold write must not open the automatic window, or null when it may. */
function autoArmBlock(s: State): string | null {
  if (s.keepwarm !== 'on') return `the keepwarm option is ${s.keepwarm}`
  const hold = holdReason(s)
  if (hold) return hold
  const b = belief(s)
  return b.ttl === '1h' ? null : b.ttl === '5m' ? `this cache lives 5 minutes (${b.why})` : `this cache's lifetime isn't confirmed (${b.why})`
}

function guardAction(s: State): 'refuse' | 'warn' | 'off' {
  if (s.guard === 'auto') return belief(s).ttl === '1h' ? 'refuse' : 'warn'
  return s.guard
}

/** What keeps this session's cache an hour: unsetting the variable that forces five minutes, else the setting. */
function remedy(s: State): string {
  const env = s.envTtl
  if (env?.ttl === '5m') {
    return env.why === 'CLAUDE_CODE_PROMPT_CACHE_TTL' ? 'CLAUDE_CODE_PROMPT_CACHE_TTL=1h keeps it an hour'
      : `unsetting ${env.why}, with "promptCacheTtl": "1h" in settings, keeps it an hour`
  }
  return '"promptCacheTtl": "1h" in settings keeps it an hour'
}

function fixText(s: State): string {
  const b = belief(s)
  if (b.ttl !== '5m' || s.warnedFix) return ''
  s.warnedFix = true
  return ` This session's cache lives 5 minutes (${b.why}); ${remedy(s)}, its writes at 2x base input instead of 1.25x.`
}

function idleNote(s: State): string | null {
  if (!s.idleCompaction || s.ctx < s.idleMin || belief(s).ttl !== '1h') return null
  return 'Claude Code compacts a conversation this size about 54m into a break (idleCompaction), and a ping may not stop it; "idleCompaction": false keeps the full context'
}

/** Whether Claude Code may have compacted this conversation while it sat idle: only on a cache that may live an hour, 54 minutes after the last main request, from its minimum size, and never for a conversation this process has not yet sent. */
function mayHaveCompacted(s: State, now: number): boolean {
  return s.idleCompaction && !s.resumeSeeded && s.ctx >= s.idleMin && belief(s).ttl !== '5m' && s.lastMainAt > 0 && now - s.lastMainAt >= IDLE_COMPACT_AFTER_MS
}

function guardText(s: State, now: number, ctx: number): string {
  const b = belief(s)
  const r = ratesOf(s, s.lastModel, ctx)
  const rate = r ? fmtRate(writeRate(r, b.ttl)) : 'the cache-write rate'
  const warm = warmUsd(s, ctx)
  const idle = now - s.lastRequestAt
  const head = idle >= coldAfter(s) ? `the prompt cache went cold ${fmtDuration(idle - coldAfter(s))} ago`
    : s.resumeCold ? 'the prompt cache is cold: Claude Code judged it expired when this conversation was resumed'
    : `the prompt cache may be cold: it has been idle ${fmtDuration(idle)}, and this session's cache lifetime isn't confirmed (${b.why})`
  // Claude Code's estimate is its own sum, with its own lifetime and prices; a table rate beside it need not multiply out to it.
  const engine = engineUsd(s, ctx)
  const price = engine != null ? `, about ${fmtUsd(engine)} by Claude Code's estimate` : ` at ${rate} = ${fmtUsd(coldUsd(s, ctx))}`
  return `${head}. Sending this re-writes up to ${ctx.toLocaleString('en-US')} tokens${price}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** A conversation this process goes on with: fresh after /clear or compaction, or resumed from a transcript. */
function newConversation(s: State, resumed: boolean) {
  s.convTurns = 0
  s.convResumed = resumed
  s.firstExchange = false
  s.resumeSeeded = resumed
  s.resumeCold = false
  s.lastWasPing = false
  s.lastPrefix = null
  s.lastRead = null
  s.prefixChange = null
  // A finding that pings don't hold the cache may have been the old prefix's doing.
  s.pingsHold = null
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.lastMainAt = 0
  s.compacted = false
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.waitForTurn = false
  s.firstStep = null
  s.engineCold = null
  s.confirm = null
  // Neither a ping's receipt nor a go-ahead given for the old conversation is this one's.
  s.last = null
  s.armedAnyway = false
  newConversation(s, false)
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = now - e.seconds_since_last_response * 1000
  s.lastMainAt = s.lastRequestAt
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  // Another conversation: its last request was no ping of this process's, no receipt or go-ahead is its own, and
  // Claude Code renders a resumed transcript afresh, so what its first request finds says nothing of the lifetime or of pings.
  s.last = null
  s.armedAnyway = false
  newConversation(s, true)
  // Claude Code judges the expiry by the lifetime of the last response's cache write, so a cache it still calls live
  // between the two lifetimes lives an hour. One it calls expired says nothing of the lifetime: it calls a conversation
  // compacted since its last response expired at any gap. Either way that conversation is cold until its first request.
  const gap = typeof e.seconds_since_last_response === 'number' ? e.seconds_since_last_response * 1000 : null
  if (gap != null && e.prompt_cache_likely_expired === false && gap > TTL_5M + OBSERVE_MARGIN_MS && gap < TTL_1H - OBSERVE_MARGIN_MS) {
    observe(s, s.lastModel, '1h', `Claude Code judged it so at resume, ${fmtDuration(gap)} after the last response`, true)
  }
  s.resumeCold = e.prompt_cache_likely_expired === true
  s.engineCold = typeof e.estimated_cache_write_usd === 'number' ? { usd: e.estimated_cache_write_usd, ctx: s.ctx } : null
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

/** Takes the limit windows a response reported: whether this is a subscription, whether pings must stop, and when a reading that matters lapses. */
export function noteLimits(s: State, limits: readonly Reading[], now: number) {
  if (limits.some(isPlanWindow)) s.subscription = true
  // A reading is the last response's: past its window's reset it is stale until the next response, and the window has started over.
  s.limits = limits.map(l => !l.reset && resetAt(l) <= now ? { kind: l.kind, percentUsed: 0, reset: true } : l)
  const top = s.limits.filter(l => l.percentUsed >= s.stopAtPercent).sort((a, b) => b.percentUsed - a.percentUsed)[0]
  s.limitStop = top ? `the ${limitName(top.kind)} is at ${top.percentUsed}%, keepwarm stops at ${s.stopAtPercent}%` : null
  s.limitsUntil = Math.min(...s.limits.filter(l => l.percentUsed >= s.stopAtPercent || (isPlanWindow(l) && l.percentUsed >= 100)).map(resetAt))
}

/** Lets go of readings whose window has reset since they were taken. */
function refreshLimits(s: State, now: number) {
  if (now >= s.limitsUntil) noteLimits(s, s.limits, now)
}

/** What one fork moved each limit window by, in points, where both readings have it. */
function movesOf(before: SessionRateLimit[], after: SessionRateLimit[]): Move[] {
  return after.flatMap(a => {
    const b = before.find(x => x.kind === a.kind)
    return b ? [{ kind: a.kind, delta: Math.round((a.percentUsed - b.percentUsed) * 10) / 10 }] : []
  })
}

function movesText(moves: Move[]): string {
  return moves.length ? ` (${moves.map(m => `${limitShort(m.kind)} ${m.delta >= 0 ? '+' : ''}${m.delta}%`).join(', ')} account-wide)` : ''
}

/**
 * Reads what the user's own request says, measured past the prefix every conversation shares: a read fifteen
 * minutes or more into a break means an hour, and a re-write between five minutes and the hour is one sighting of
 * five. After a ping, a re-write means pings don't hold this cache; the reason to stop is returned. A re-write a
 * known change explains, or that did not even read the shared prefix, says nothing of either.
 */
export function learnFromGap(s: State, o: Gap, u: TurnUsage): string | null {
  if (o.model && u.model && !sameModel(o.model, u.model)) return null
  const conv = o.prev - s.shared
  if (conv < OBSERVE_MIN_TOKENS) return null
  if (o.gap <= TTL_5M + OBSERVE_MARGIN_MS || o.gap >= TTL_1H - OBSERVE_MARGIN_MS) return null
  const read = u.cache_read_input_tokens - s.shared
  const warm = read >= 0.5 * conv
  const cold = !o.explained && u.cache_read_input_tokens > 0 && u.cache_read_input_tokens >= 0.9 * s.shared && read < 0.2 * conv && u.cache_creation_input_tokens >= 0.5 * conv
  if (o.afterPing) {
    if (warm) s.pingsHold = true
    else if (cold) {
      s.pingsHold = false
      return `the message ${fmtDuration(o.gap)} after the last ping re-wrote ${fmtTok(u.cache_creation_input_tokens)} tokens, so pings don't keep this cache alive here; /keepwarm tries again`
    }
  }
  if (warm && o.gap >= OBSERVE_1H_MS) observe(s, u.model || o.model, '1h', `the cache was read after ${fmtDuration(o.gap)} idle`)
  else if (cold && !o.afterPing) observe(s, u.model || o.model, '5m', `the cache was re-written after only ${fmtDuration(o.gap)} idle`)
  return null
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}${movesText(s.last.moves)}` : ''
  const hold = holdReason(s)
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : hold ? ` · no pings: ${hold}`
    : pastCold(s, now) ? ` · ${isCold(s, now) ? 'cold' : 'may be cold'} now, first ping ${fmtDuration(s.every)} after the next turn`
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  // A go-ahead holds for the window it was given for.
  s.armedAnyway = false
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) await $.store.delete(KEY_ALWAYS)
  updateStatus($, s, await $.clock.now())
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  refreshLimits(s, now)
  if (now >= s.deadline) return stop($, s, null)
  // A cold window, or one whose pings are held, still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !pastCold(s, now) && !holdReason(s)) {
    const untilCold = s.lastRequestAt + pingColdAfter(s) - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    // A limit reading that holds the pings is looked at again when its window resets: no response may come to renew it.
    s.pending = $.clock.after(Math.min(s.deadline, s.limitsUntil) - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

/** The tools a request carries, by name; a change re-writes the cache from the tools on. */
async function toolsKey($: EngineInterface): Promise<string | null> {
  const tools = await $.tool.list().catch(() => null)
  return tools ? tools.map(t => t.name).sort().join(',') : null
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  // The readings come first: a limit, or what the session has spent, may have moved since the timer was set. The
  // fork goes out on the session's model and tools as they are now, which need not be what the window's cache holds.
  const before = await $.session.usage().catch(() => null)
  const model = await $.session.model().catch(() => null)
  const tools = await toolsKey($)
  const now = await $.clock.now()
  if (before) noteLimits(s, before.rateLimits, now)
  // A timer set or cancelled while these were read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the awaits, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  // A model chosen since the last main request has none of this conversation cached: a ping would write all of it.
  // Compared as the engine names models, since a gateway's reply may spell the one that answered otherwise.
  if (model && s.lastAsked && !sameModel(model, s.lastAsked)) {
    s.prefixChange = `the model changed to ${model}`
    s.pingsHold = null
  }
  if (holdReason(s)) return arm($, s)
  if (pastCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + pingColdAfter(s) - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  const first = s.firstExchange
  const tooled = tools !== null && s.toolsKey !== null && tools !== s.toolsKey
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const after = await $.session.usage().catch(() => null)
  const at = await $.clock.now()
  s.inFlight = false
  if (after) noteLimits(s, after.rateLimits, at)
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + pingColdAfter(s) - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const read = u.cache_read_input_tokens
  const write = u.cache_creation_input_tokens
  s.firstExchange = false
  if (tools !== null) s.toolsKey = tools
  const r = ratesOf(s, s.lastModel, u.input_tokens + read + write)
  // Priced from the fork's own usage: the session's ledger also moves for anything else that lands meanwhile.
  const own = r ? pingUsd(u, r, belief(s).ttl) : null
  const spent = before?.cost && after?.cost ? after.cost.usd - before.cost.usd : null
  const usd = own ?? (spent != null && spent >= 0 ? spent : null)
  // Limit windows are the whole account's, read from the last response before the ping and from the ping's own:
  // shown only when nothing else this session paid for landed between the two.
  const alone = spent == null || own == null || spent <= own * 1.5 + 0.01
  // Warm, the fork read back at least the prefix the last main request left cached; without that figure, it wrote under a tenth of what it read.
  const warm = s.lastPrefix ? read >= 0.9 * s.lastPrefix : read > 0 && write < 0.1 * read
  s.last = { at: now, read, write, usd, warm, moves: before && after && alone ? movesOf(before.rateLimits, after.rateLimits) : [] }
  const idle = now - sentAt
  // A fork that neither read nor wrote a prompt this long went out with caching off for this model.
  if (read === 0 && write === 0 && u.input_tokens >= OBSERVE_MIN_TOKENS) {
    s.offSeen[modelKey(s.lastModel)] = `a ping on ${s.lastModel ?? 'this model'} read and wrote nothing`
    return stop($, s, `the ping read 0 and wrote 0 tokens (${fmtUsd(usd)}): prompt caching is off for this model`)
  }
  // A miss owed to something other than the lifetime: a tool list changed since the last main request, or the first
  // message Claude Code re-sends in full after a conversation's first turn, past the shared prefix and that message's start.
  const explained = warm ? null : tooled ? 'the tool list changed since your last message'
    : first && read > s.shared ? 'Claude Code re-sends the first message in full after the first turn' : null
  if (!warm && !explained) {
    // A miss that read the shared prefix is one sighting of a 5-minute lifetime, never on the first ping after one exchange.
    if (!first && read > 0 && read >= 0.9 * s.shared && idle > TTL_5M + OBSERVE_MARGIN_MS && idle < TTL_1H - OBSERVE_MARGIN_MS) {
      observe(s, s.lastModel, '5m', `a ping ${fmtDuration(idle)} into a break found the cache gone`)
    }
    return stop($, s, `the ping read ${fmtTok(read)} and wrote ${fmtTok(write)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  }
  if (warm && !first && idle >= OBSERVE_1H_MS && idle < TTL_1H - OBSERVE_MARGIN_MS) observe(s, s.lastModel, '1h', `a ping read the cache ${fmtDuration(idle)} into a break`)
  // The re-write such a change explains is the one the next message would have paid: the cache now holds what it reads.
  if (explained) $.ui.log(`the ping re-wrote ${fmtTok(write)} tokens (${fmtUsd(usd)}) because ${explained}; your next message and the next ping read what it wrote.`)
  s.lastRequestAt = now
  s.lastWasPing = true
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** How long keepwarm holds the cache after a paid cold write: the rolling window when always is on. */
function holdMs(s: State): number {
  return s.always ? DEFAULT_WINDOW_MS : AUTO_WARM_MS
}

/** The window always opens: six hours at the default period, or on a 5-minute cache the short window it outlives. */
function alwaysWindow(s: State): [number, number] {
  return belief(s).ttl === '5m' ? [SHORT_WINDOW_MS, SHORT_EVERY_MS] : [DEFAULT_WINDOW_MS, PING_AFTER_MS]
}

/**
 * Always's window after a turn: its shortest length, its period, whether a running window longer than that keeps its
 * length, and whether a go-ahead goes with it. On a 1-hour cache: at least six hours at the default period, which
 * brings back a stopped window and replaces a shorter one or a testing period. On a 5-minute or unconfirmed lifetime a
 * running window's period under five minutes is what holds the cache, not a testing knob, so it stays, and else a
 * 5-minute cache gets the short window. On an unconfirmed lifetime a running window armed on a go-ahead rolls as on an
 * hour and keeps it; any other window there waits for the lifetime, as always's own do.
 */
function rollTo(s: State, now: number): { floor: number; every: number; keep: boolean; go: boolean } {
  const ttl = belief(s).ttl
  const running = s.deadline > now
  if (ttl !== '1h' && running && s.every < TTL_5M) return { floor: SHORT_WINDOW_MS, every: s.every, keep: true, go: false }
  if (ttl === '5m') return { floor: SHORT_WINDOW_MS, every: SHORT_EVERY_MS, keep: false, go: false }
  return { floor: DEFAULT_WINDOW_MS, every: PING_AFTER_MS, keep: true, go: ttl === null && running && s.armedAnyway }
}

async function rollAlways($: EngineInterface, s: State, now: number, offs: number) {
  const roll = rollTo(s, now)
  return startWindow($, s, roll.keep ? Math.max(roll.floor, s.deadline - now) : roll.floor, roll.every, offs, roll.go || undefined)
}

/** The reply to an arming command; on a cold cache it says when the first ping can come, and why none will while one can't. */
function armedText(s: State, now: number, windowMs: number): string {
  const hold = holdReason(s)
  const tail = (belief(s).ttl === null && s.armedAnyway ? '. The lifetime is unconfirmed: the first ping checks it, and keepwarm stops if the cache is gone' : '') +
    (hold ? `. No pings for now: ${hold}` : '') +
    (idleNote(s) ? `. ${idleNote(s)}` : '')
  if (pastCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache ${isCold(s, now) ? 'is' : 'may be'} cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn${tail}`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written${tail}`
}

/**
 * Whether a window may open over this session's lifetime: null when it may, true when it may on the go-ahead just
 * given, else the refusal. The same unconfirmed command again within two minutes is the go-ahead.
 */
function lifetimeGate(s: State, args: string, every: number, now: number): string | true | null {
  const off = cacheOffNow(s)
  if (off) return `prompt caching is off in this session (${off}), so there is nothing to keep warm`
  const b = belief(s)
  if (b.ttl === '1h') return null
  if (b.ttl === '5m') {
    if (every < TTL_5M) return null
    return `this session's prompt cache lives 5 minutes (${b.why}), so a ping ${fmtDuration(every)} into a break would find it gone and re-send the whole context. ` +
      `${upper(remedy(s))} (its writes cost 2x base input, not 1.25x); for a short break, /keepwarm 30m every 4m.`
  }
  // A period under five minutes holds either lifetime, if it starts before five idle minutes have passed, or after
  // the next turn when Claude Code judged the cache expired at resume: until then no ping goes.
  if (every < TTL_5M && (s.resumeCold || !maybeCold(s, now))) return null
  if (s.confirm && s.confirm.args === args && now - s.confirm.at <= CONFIRM_MS) {
    s.confirm = null
    return true
  }
  s.confirm = { args, at: now }
  const r = ratesOf(s, s.lastModel, s.ctx)
  const risk = r && s.ctx > 0 ? `re-sends up to ${s.ctx.toLocaleString('en-US')} tokens (about ${fmtUsd(s.ctx * r.input / 1e6)}) for nothing` : 're-sends the whole context for nothing'
  const when = every < TTL_5M ? `the first ping, ${fmtDuration(now - s.lastRequestAt)} into this break,` : `a ping ${fmtDuration(every)} into a break`
  return `cache-tax can't confirm this session's prompt cache lives an hour (${b.why}). If it lives 5 minutes, ${when} ${risk}. ` +
    `Send /keepwarm${args ? ' ' + args : ''} again to arm it anyway, or /cache-tax ttl 1h if you know it lives an hour.`
}

// A /keepwarm off after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first. `go` is a go-ahead given for this window.
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs, go?: boolean) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  // A window extended at its own period keeps its go-ahead; any other starts without one.
  s.armedAnyway = go ?? (s.armedAnyway && s.deadline > now && s.every === every)
  s.every = every
  s.deadline = deadline
  s.stopped = null
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

/** Takes up this session's own stored window, or with always on a fresh one, whatever the last one left behind. */
async function restoreWindow($: EngineInterface, s: State, now: number) {
  const saved = await $.store.get(deadlineKey(s))
  const savedEvery = await $.store.get(everyKey(s))
  s.deadline = typeof saved === 'number' && saved > now && s.keepwarm !== 'off' ? saved : 0
  s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_1H ? savedEvery : PING_AFTER_MS
  const [windowMs, every] = alwaysWindow(s)
  if (s.always) await startWindow($, s, windowMs, every)
}

/** After a /clear or resume that only session.end told of, the new conversation's id, and its own stored window, before anything is stored under it. */
async function adoptSid($: EngineInterface, s: State) {
  if (!s.sidStale) return
  s.sidStale = false
  s.sid = await $.session.id()
  await restoreWindow($, s, await $.clock.now())
}

function until(resetsAt: string | undefined, now: number): string {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  return Number.isNaN(at) ? '' : `, resets in ${fmtDuration(at - now)}`
}

function cacheLine(s: State, b: Belief): string {
  const off = cacheOffNow(s)
  if (off) return `off (${off}), nothing to keep warm`
  if (b.ttl) return `lives ${b.ttl === '1h' ? '1 hour' : '5 minutes'} (${b.why})`
  return `lifetime not confirmed (${b.why}); /cache-tax ttl 1h if you know it lives an hour`
}

function planLine(s: State, now: number): string {
  const prices = s.pricing ? "your organization's modelPricing" : 'list prices'
  if (!s.limits.length) return `no limit windows visible to this mod; dollars at ${prices}`
  const windows = s.limits.map(l => l.reset ? `${limitShort(l.kind)} reset since the last reading` : `${limitShort(l.kind)} ${l.percentUsed}%${until(l.resetsAt, now)}`).join(' · ')
  const unit = s.subscription ? `dollars are API-equivalent (${prices}), your plan counts these windows` : `dollars at ${prices}`
  return `${windows}; ${unit}; pings stop at ${s.stopAtPercent}%`
}

function guardLine(s: State): string {
  const text = s.guard === 'off' ? 'off: no check before a cold send'
    : s.guard === 'warn' ? 'warn only (/cache-tax guard refuse to be stopped once)'
    : s.guard === 'refuse' ? 'refuse once (/cache-tax guard warn to only show the price)'
    : guardAction(s) === 'refuse' ? 'auto: refuse once on this 1-hour cache (/cache-tax guard warn to only show the price)'
    : 'auto: warn only, as this cache lives 5 minutes or is unconfirmed'
  return text + (s.locked.includes('guard') ? ', set by your organization' : s.pinned.includes('guard') ? ', set in settings' : '')
}

function card(s: State, now: number): string {
  const lines: string[] = []
  const b = belief(s)
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago${now - s.lastRequestAt < coldAfter(s) ? ' (Claude Code judged it expired at resume)' : ''}`)
  else if (maybeCold(s, now)) lines.push(`state       unknown, last request ${fmtDuration(now - s.lastRequestAt)} ago, cold if this cache lives 5 minutes`)
  else lines.push(`state       warm, ${b.ttl === null ? 'at least ' : ''}${fmtDuration(s.lastRequestAt + maybeColdAfter(s) - now)} left`)
  lines.push(`cache       ${cacheLine(s, b)}`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  lines.push(`plan        ${planLine(s, now)}`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? `off until the next turn, which arms ${fmtDuration(alwaysWindow(s)[0])} (always)` : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${guardLine(s)}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  const note = idleNote(s)
  if (note) lines.push(`idle        ${note}`)
  if (s.turnsSeen > 0 && s.classicSeen === false) {
    lines.push('hooks       this mod sees /clear and resume only through session.end here, as a user mod on an organization login or a managed machine; no resume warning. An admin can install it as an organization mod')
  }
  if (s.account) lines.push(`account     ${s.account.kind}${s.account.plan ? `, ${s.account.plan}` : ''}`)
  const set = s.pinned.filter(f => !s.locked.includes(f))
  const owned = [s.locked.length ? `set by your organization: ${s.locked.join(', ')}` : '', set.length ? `set in settings: ${set.join(', ')}` : ''].filter(Boolean)
  if (owned.length) lines.push(`options     ${owned.join('; ')}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastMainAt: 0, lastModel: null,
    lastAsked: null, lastEffort: undefined, lastPrefix: null, lastRead: null, ctx: 0, compacted: false, resumeCold: false,
    guard: 'auto', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, firstStep: null,
    cacheOff: null, offFamilies: [], offSeen: {}, envTtl: null, settingTtl: null, enable1h: false, evidence: {}, chosen: null, chosenBy: '',
    account: null, limits: [], limitsUntil: Infinity, subscription: false, answered: false, limitStop: null, stopAtPercent: STOP_AT_PERCENT,
    pricing: null, engineCold: null, idleCompaction: true, idleMin: IDLE_COMPACT_TOKENS,
    convTurns: 0, convResumed: false, firstExchange: false, resumeSeeded: false, shared: 0, toolsKey: null, prefixChange: null,
    pingsHold: null, lastWasPing: false, armedAnyway: false, confirm: null, warnedFix: false,
    keepwarm: 'on', locked: [], pinned: [], hidden: [], stored: { guard: null, ttl: null }, classicSeen: false, turnsSeen: 0, sidStale: false,
  }
}

const GUARD_MODES: readonly GuardMode[] = ['auto', 'refuse', 'warn', 'off']
const KEEPWARM_MODES: readonly KeepwarmMode[] = ['on', 'manual', 'off']

function isGuardMode(v: unknown): v is GuardMode {
  return typeof v === 'string' && (GUARD_MODES as readonly string[]).includes(v)
}

/** The manifest's userConfig values, each held to what it may be; a value out of range is its default. */
export function readOptions(o: PluginOptions): Options {
  const keepwarm = KEEPWARM_MODES.find(m => m === o.keepwarm) ?? DEFAULTS.keepwarm
  const cacheTtl = o.cacheTtl === '1h' || o.cacheTtl === '5m' ? o.cacheTtl : DEFAULTS.cacheTtl
  const pct = typeof o.stopAtPercent === 'number' && o.stopAtPercent > 0 && o.stopAtPercent <= 100 ? o.stopAtPercent : DEFAULTS.stopAtPercent
  return { guard: isGuardMode(o.guard) ? o.guard : DEFAULTS.guard, keepwarm, cacheTtl, stopAtPercent: pct }
}

function isRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000
}

/** The managed modelPricing as Claude Code honors it: a multiplier in (0, 10] and override rows with all four rates; anything else is skipped. */
function toPricing(v: unknown): Pricing | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as { multiplier?: unknown; overrides?: unknown }
  const multiplier = typeof p.multiplier === 'number' && p.multiplier > 0 && p.multiplier <= 10 ? p.multiplier : 1
  const overrides: Record<string, PriceRow> = {}
  if (typeof p.overrides === 'object' && p.overrides !== null) {
    for (const [key, row] of Object.entries(p.overrides as Record<string, unknown>)) {
      const r = typeof row === 'object' && row !== null ? row as Record<string, unknown> : {}
      if (isRate(r.input) && isRate(r.output) && isRate(r.cacheRead) && isRate(r.cacheWrite)) overrides[key] = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }
    }
  }
  return multiplier === 1 && !Object.keys(overrides).length ? null : { multiplier, overrides }
}

/** The settings Claude Code's cache follows, read where it reads them: promptCacheTtl merged, modelPricing from managed settings only. */
async function readSettings($: EngineInterface, s: State) {
  const ttl = await $.settings.read({ key: 'promptCacheTtl' }).catch(() => undefined)
  s.settingTtl = ttl === '1h' || ttl === '5m' ? { ttl, why: 'the promptCacheTtl setting' } : null
  s.idleCompaction = (await $.settings.read({ key: 'idleCompaction' }).catch(() => undefined)) !== false
  s.pricing = toPricing(await $.settings.read({ key: 'modelPricing', source: 'policy' }).catch(() => undefined))
}

/** The environment Claude Code's cache follows; it does not change within a process. */
async function readEnv($: EngineInterface, s: State) {
  s.cacheOff = isOn(await $.env.get('DISABLE_PROMPT_CACHING')) ? 'DISABLE_PROMPT_CACHING' : null
  // Claude Code's per-family switches; it matches Sonnet, Opus and Haiku on their default model, cache-tax on the family, the safe side.
  const families: Record<string, string | undefined> = {
    fable: await $.env.get('DISABLE_PROMPT_CACHING_FABLE'),
    haiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU'),
    mythos: await $.env.get('DISABLE_PROMPT_CACHING_MYTHOS'),
    opus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS'),
    sonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET'),
  }
  s.offFamilies = Object.entries(families).filter(([, v]) => isOn(v)).map(([f]) => f)
  const force5m = isOn(await $.env.get('FORCE_PROMPT_CACHING_5M'))
  // Only 5m does anything here: it sets the conversation's lifetime under whatever the rest of the prompt has.
  const messages5m = (await $.env.get('CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL'))?.trim() === '5m'
  const ttl = (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))?.trim()
  s.envTtl = force5m ? { ttl: '5m', why: 'FORCE_PROMPT_CACHING_5M' }
    : messages5m ? { ttl: '5m', why: 'CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL' }
    : ttl === '1h' || ttl === '5m' ? { ttl, why: 'CLAUDE_CODE_PROMPT_CACHE_TTL' } : null
  s.enable1h = isOn(await $.env.get('ENABLE_PROMPT_CACHING_1H'))
  const min = Number((await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'))?.trim())
  s.idleMin = Number.isFinite(min) && min > 0 ? Math.max(IDLE_COMPACT_FLOOR, min) : IDLE_COMPACT_TOKENS
}

/** Which options a pluginConfigs object sets for this plugin, under its name or its id at any marketplace. */
function fieldsSet(v: unknown): Field[] {
  if (typeof v !== 'object' || v === null) return []
  const mine = Object.entries(v as Record<string, unknown>).filter(([key]) => key === PLUGIN || key.startsWith(`${PLUGIN}@`))
    .map(([, c]) => typeof c === 'object' && c !== null ? (c as { options?: unknown }).options : undefined)
  return FIELDS.filter(f => mine.some(o => typeof o === 'object' && o !== null && (o as Record<string, unknown>)[f] !== undefined))
}

/**
 * Which options the organization owns, from every place that can say: the /config rows it locks, keyed by this
 * plugin's name or, beside another plugin of that name, its id; and what managed settings set. A row kept from this
 * mod while other plugins' rows show may be locked; a host that lists no plugin rows, as -p, says nothing either way.
 */
async function readLocks($: EngineInterface, s: State, rows: readonly ConfigRow[] | null) {
  const managed = fieldsSet(await $.settings.read({ key: 'pluginConfigs', source: 'policy' }).catch(() => undefined))
  const own = (f: Field) => (rows ?? []).filter(row => row.key.endsWith(`.${f}`) && (row.key === `${PLUGIN}.${f}` || row.key.startsWith(`${PLUGIN}@`)))
  const listed = rows === null || rows.some(row => row.provider.plugin !== 'engine')
  s.locked = FIELDS.filter(f => managed.includes(f) || own(f).some(row => row.isLocked))
  s.hidden = listed ? FIELDS.filter(f => !own(f).length) : []
}

/** Why a command may not change an option, as the reply's tail, or null: a lock, a settings file, or a row out of this mod's sight. */
function heldBy(s: State, f: Field): string | null {
  if (s.locked.includes(f)) return ', set by your organization'
  if (s.pinned.includes(f)) return ', set in settings (pluginConfigs); change it with /config'
  if (s.hidden.includes(f)) return "; its /config row is kept from this mod, so it may be your organization's: change it with /config"
  return null
}

export const register: Register = (on, options) => {
  const s = freshState()
  const opts = readOptions(options ?? {})
  let light = false
  let noColor = false

  /**
   * The options in force. A value settings give, from the organization or a settings file, stands; this machine's
   * stored choice applies only where none is set and the row is in sight. Away from its default the value was set
   * somewhere, so it stands even where neither the lock nor the managed value reaches this mod.
   */
  function applyOptions() {
    s.pinned = FIELDS.filter(f => s.locked.includes(f) || opts[f] !== DEFAULTS[f])
    const free = (f: Field) => !s.pinned.includes(f) && !s.hidden.includes(f)
    s.guard = free('guard') && s.stored.guard ? s.stored.guard : opts.guard
    const ttl = free('cacheTtl') && s.stored.ttl ? s.stored.ttl : opts.cacheTtl
    s.chosen = ttl === 'auto' ? null : ttl
    s.chosenBy = s.locked.includes('cacheTtl') ? 'set by your organization' : ttl === s.stored.ttl && free('cacheTtl') ? 'set with /cache-tax ttl' : 'set by the cacheTtl option'
  }

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    refreshLimits(s, now)
    const text = statusText(s, now)
    if (!text || (s.deadline && now >= s.deadline)) return rest
    const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : maybeCold(s, now) ? 'unknown' : 'warm'
    const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const { Box, Text } = $.ui.resolve(e)
    const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
    const icon = noColor ? Text({ bold: true, children: ['[>]'] })
      : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
      : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Tax' })
      : Text({ color, bold: true, children: ['[>]'] })
    return Box({ flexDirection: 'column', children: [
      rest,
      Box({ flexDirection: 'row', alignItems: 'center', children: [
        Box({ flexShrink: 0, children: [icon] }),
        Text({ children: [
          ' cache-tax · ',
          Text({ color, bold: true, children: [state] }),
          ` · ${text}`,
        ] }),
      ] }),
    ] })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    // One read of the menu per session: the theme, and which options the organization locked.
    const rows = await $.config.list().catch(() => null)
    if (s.hasBand) {
      const theme = rows?.find(row => row.key === 'theme')?.value
      light = typeof theme === 'string' && theme.startsWith('light')
      noColor = Boolean(await $.env.get('NO_COLOR'))
      $.ui.status(undefined)
    }
    s.keepwarm = opts.keepwarm
    s.stopAtPercent = opts.stopAtPercent
    s.sid = await $.session.id()
    const now = await $.clock.now()
    await prune($, s, now)
    const savedGuard = await $.store.get(KEY_GUARD)
    const savedTtl = await $.store.get(KEY_TTL)
    s.stored = { guard: isGuardMode(savedGuard) ? savedGuard : null, ttl: savedTtl === '1h' || savedTtl === '5m' ? savedTtl : null }
    await readLocks($, s, rows)
    applyOptions()
    s.always = (await $.store.get(KEY_ALWAYS)) === true && s.keepwarm === 'on'
    await readEnv($, s)
    await readSettings($, s)
    // Answered only to a mod the organization's managed settings install; any other gets a refusal and learns
    // nothing. Claude Code before 2.1.299 has no such call, and the try keeps that from failing the start.
    let id: SessionIdentity | null = null
    try {
      id = await $.session.identity()
    } catch {
      id = null
    }
    s.account = id && id.deny === undefined ? { kind: id.kind, plan: id.organizationType ?? null } : null
    const usage = await $.session.usage()
    noteLimits(s, usage.rateLimits, now)
    // A start long after the session began is a reload or a resume, whose classic.SessionStart has run or is still
    // to come: only a fresh process tells an organization login by its absence.
    if (now - usage.startedAt > MIN_PING_MS && s.classicSeen === false) s.classicSeen = null
    await restoreWindow($, s, now)
    if (usage.context.tokens) s.ctx = usage.context.tokens
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (cache-tax)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard auto|refuse|warn|off, ttl auto|1h|5m (cache-tax, the Mod)',
      argumentHint: '[status | guard auto|refuse|warn|off | ttl auto|1h|5m]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.')
    }
    updateStatus($, s, now)
    return r
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // Where an organization manages Claude Code this event never reaches a user's mod; session.end stands in then.
    s.classicSeen = true
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      s.sidStale = false
      // No session.start fires after /clear, so this is where always arms the new conversation.
      const [windowMs, every] = alwaysWindow(s)
      if (s.always) await startWindow($, s, windowMs, every)
      // A window armed while this handler awaited lost its timer to resetForClear; arm it again.
      else if (s.deadline) await arm($, s)
      else updateStatus($, s, await $.clock.now())
      return r
    }
    const now = await $.clock.now()
    const id = await $.session.id()
    if ((e.source === 'resume' || e.source === 'fork') && id !== s.sid) {
      // A resume inside this process: the conversation left behind takes its window with it, and this one's own, if stored, takes over.
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = id
      s.sidStale = false
      await restoreWindow($, s, now)
    }
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    const model = typeof e.model === 'string' ? e.model : s.lastModel ?? await $.session.model()
    const line = seedFromResume(s, { ...e, model }, now)
    if (!s.lastModel) s.lastModel = model
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  // A model switch reports the lifetime Claude Code gave the last main request, which belongs to the model being left.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const r = await next(e)
    if (e.context_tokens > 0 && (e.cache_ttl === '1h' || e.cache_ttl === '5m')) observe(s, e.from_model, e.cache_ttl, 'Claude Code reported it at a model switch', true)
    return r
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    if (e.context_tokens > 0 && (e.cache_ttl === '1h' || e.cache_ttl === '5m')) observe(s, e.from_model, e.cache_ttl, 'Claude Code reported it at a model switch', true)
    if (!sameModel(e.from_model, e.to_model)) {
      // The next request writes the whole context on the new model: Claude Code's own estimate prices it until a turn
      // on that model, whose lifetime is worked out afresh, and until then there is nothing for a ping to keep.
      s.lastModel = e.to_model
      if (e.context_tokens > 0) {
        s.ctx = e.context_tokens
        s.engineCold = { usd: e.estimated_cache_write_usd, ctx: e.context_tokens }
      }
      s.prefixChange = `the model changed to ${e.to_model}`
      s.pingsHold = null
      if (s.deadline) await arm($, s)
    }
    return r
  })

  // The end of the conversation this state belongs to, by /clear or a resume. Where classic.SessionStart reaches this
  // mod it repeats the reset harmlessly; where it does not (an organization login, a managed machine) this is the only
  // word of it. One for a conversation already left behind is passed over.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if ((e.reason !== 'clear' && e.reason !== 'resume') || e.sessionId !== s.sid) return r
    await stop($, s, null)
    s.stopped = null
    resetForClear(s)
    s.sidStale = true
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    const was = s.limitStop
    noteLimits(s, e.rateLimits, await $.clock.now())
    // A window crossing the stop line holds the pings; one falling back under it lets them go on.
    if (s.deadline && was !== s.limitStop) await arm($, s)
    return r
  })

  // Another effort level re-writes the cache from the messages on, so the next message pays that write, not a ping.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    const level = String(e.args ?? '').trim().split(/\s+/)[0]
    if (level && s.lastEffort !== undefined && level !== String(s.lastEffort ?? '')) {
      s.prefixChange = 'the effort changed'
      s.pingsHold = null
      if (s.deadline) await arm($, s)
    }
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await adoptSid($, s)
    const args = String(e.args ?? '').trim()
    const words = args.split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    refreshLimits(s, now)
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off' }
    }
    if (words[0] === 'status') return { text: statusText(s, now) ?? 'keepwarm is off' }
    const lockNote = s.locked.includes('keepwarm') ? ', set by your organization' : ''
    if (s.keepwarm === 'off') return { text: `keepwarm is off by its option${lockNote}: no pings in any session` }
    if (words[0] === 'always' && s.keepwarm === 'manual') return { text: `always is off by the keepwarm option (manual${lockNote}); arm a window with /keepwarm or /keepwarm 90m` }
    await readSettings($, s)
    if (words[0] === 'always') {
      const [windowMs, every] = alwaysWindow(s)
      const gate = lifetimeGate(s, args, every, now)
      if (typeof gate === 'string') return { text: gate }
      // Arming is the person's word that pings should run: an earlier finding that they don't is tried again.
      s.pingsHold = null
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, windowMs, every, s.offs, gate === true)
      const hold = holdReason(s)
      const tail = (pastCold(s, now) ? `. The cache ${isCold(s, now) ? 'is' : 'may be'} cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : '') + (hold ? `. No pings for now: ${hold}` : '')
      const ttl = belief(s).ttl
      // On an unconfirmed lifetime the go-ahead just given is this window's alone: always's later windows wait for the lifetime.
      const reach = ttl === '5m' ? `on this 5-minute cache every session stays warm for ${fmtDuration(windowMs)} after its last turn, at one ping per ${fmtDuration(every)}`
        : ttl === null ? `on your go-ahead this session stays warm until ${fmtDuration(windowMs)} after its last turn, and its first ping checks the lifetime (keepwarm stops if the cache is gone); ` +
          'other sessions, and this one after /clear or a stop, send no pings until the lifetime is confirmed (/cache-tax ttl 1h if it lives an hour)'
        : `every session stays warm until ${fmtDuration(windowMs)} after its last turn`
      return { text: `keepwarm always on: ${reach}; /keepwarm off turns it off for good${tail}` }
    }
    if (!words.length) {
      const gate = lifetimeGate(s, args, PING_AFTER_MS, now)
      if (typeof gate === 'string') return { text: gate }
      s.pingsHold = null
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS, s.offs, gate === true)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    const window = parseDuration(words[0] ?? '')
    if (!window) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
    // "every 2m" is a testing knob and lasts only for the window it was given with.
    let every = PING_AFTER_MS
    if (words[1] === 'every') {
      // A period of the cache's whole lifetime or more would fire only once the cache is already cold.
      const lifetime = belief(s).ttl === '5m' ? TTL_5M : TTL_1H
      const period = parseDuration(words[2] ?? '')
      if (period == null || period < MIN_PING_MS || period >= lifetime) {
        return { text: `every takes a period from 1m to ${fmtDuration(lifetime - MIN_PING_MS)}${lifetime === TTL_5M ? ' on a 5-minute cache' : ''}` }
      }
      every = period
    }
    const gate = lifetimeGate(s, args, every, now)
    if (typeof gate === 'string') return { text: gate }
    s.pingsHold = null
    await startWindow($, s, window, every, s.offs, gate === true)
    // What always makes of this window at the next turn, told where that stretches it or changes its period.
    const roll = rollTo(s, now)
    const rolls = s.always && (roll.every !== s.every || roll.floor > s.deadline - now)
    return { text: armedText(s, now, window) + (rolls ? `. Always is on, so your next turn makes it at least ${fmtDuration(roll.floor)} at one ping per ${fmtDuration(roll.every)}` : '') }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    await adoptSid($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    refreshLimits(s, now)
    // The rows as they stand now: a lock set or lifted since the session started counts.
    await readLocks($, s, await $.config.list().catch(() => null))
    applyOptions()
    if (words[0] === 'guard') {
      const mode = words[1]
      if (!isGuardMode(mode)) return { text: '/cache-tax guard takes auto, refuse, warn or off' }
      const held = heldBy(s, 'guard')
      if (held) return { text: `the guard is ${s.guard}${held}` }
      s.stored.guard = mode
      s.guard = mode
      await $.store.set(KEY_GUARD, mode)
      return {
        text: mode === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through'
          : mode === 'warn' ? 'guard set to warn: a cold send goes through with its price shown'
          : mode === 'off' ? 'guard set to off: no check before a cold send'
          : 'guard set to auto: refuse once on a 1-hour cache, warn on a 5-minute or unconfirmed one',
      }
    }
    if (words[0] === 'ttl') {
      const v = words[1]
      if (v !== 'auto' && v !== '1h' && v !== '5m') return { text: '/cache-tax ttl takes auto, 1h or 5m' }
      const held = heldBy(s, 'cacheTtl')
      if (held) return { text: `the cache lifetime cache-tax assumes is ${s.chosen ?? 'auto'}${held}` }
      if (v === 'auto') {
        await $.store.delete(KEY_TTL)
        s.stored.ttl = null
      } else {
        await $.store.set(KEY_TTL, v)
        s.stored.ttl = v
      }
      applyOptions()
      if (s.deadline) await arm($, s)
      return { text: `${v === 'auto' ? 'cache-tax detects the lifetime again' : `cache-tax assumes ${v} on this machine; Claude Code's own cache follows promptCacheTtl, not this`}. Now: ${cacheLine(s, belief(s))}` }
    }
    await readSettings($, s)
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    refreshLimits(s, now)
    const action = guardAction(s)
    if (action === 'off' || cacheOffNow(s)) return next(e)
    const cold = isCold(s, now)
    if (!maybeCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    const live = (await $.session.usage().catch(() => null))?.context.tokens
    const hasLive = typeof live === 'number' && live > 0
    // No live window means no response since a compaction. One this mod did not see (its hook can pass over a user's
    // mod) may have left only a summary to write, so where Claude Code may have compacted while idle the price is unknown.
    if (!hasLive && mayHaveCompacted(s, now)) {
      $.ui.log(`the prompt cache may be cold after ${fmtDuration(now - s.lastRequestAt)} idle, but Claude Code may have compacted this conversation while it was idle, so cache-tax can't price this send. Sending it.`)
      return next(e)
    }
    // A compaction this mod did not see leaves the old size behind; the live window is the floor.
    const ctx = hasLive ? Math.min(s.ctx, live) : s.ctx
    if (ctx < BIG_TOKENS) return next(e)
    // A refused prompt that no person sent would be lost: nobody is there to send it again.
    const unattended = UNATTENDED.has(e.origin.kind)
    const hold = autoArmBlock(s) ? '' : `; keepwarm will hold the cache for ${fmtDuration(holdMs(s))} once it lands`
    if (action === 'warn' || unattended || !cold) {
      $.ui.log(`${guardText(s, now, ctx)} Sending anyway${unattended ? `, since this ${e.origin.kind} prompt cannot be sent again` : ''}${hold}.${fixText(s)}`)
      // Only a cache known to be gone is scored as paid; an unconfirmed one shows in the turn's own figures if it was.
      if (cold) s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    return { drop: `cache-tax: ${guardText(s, now, ctx)} Send it again to pay it${hold ? `, and keepwarm will then hold the cache for ${fmtDuration(holdMs(s))}` : ''}. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    let gap: Gap | null = null
    // What explains a miss on the turn's first request; undefined on the steps after it.
    let first: string | null | undefined
    if (!e.agentId) {
      const now = await $.clock.now()
      // The off count when the turn's first request went out: an off after it wins over what the turn opens.
      if (e.index === 0) {
        s.turnOffs = s.offs
        const tools = await toolsKey($)
        first = s.firstExchange ? 'Claude Code re-sends the first message in full after the first turn'
          : s.resumeSeeded ? 'the conversation was resumed'
          : s.prefixChange ?? (s.lastAsked && !sameModel(e.model, s.lastAsked) ? `the model changed to ${e.model}`
          : s.lastEffort !== undefined && (e.effort ?? null) !== s.lastEffort ? 'the effort changed'
          : tools !== null && s.toolsKey !== null && tools !== s.toolsKey ? 'the tool list changed' : null)
        // How long the cache sat idle before this turn, and how much of it the turn will find.
        if (s.lastRequestAt > 0 && !s.compacted) gap = { gap: now - s.lastRequestAt, prev: s.ctx, model: s.lastModel, afterPing: s.lastWasPing, explained: first }
        // A known change starts the verdict on pings afresh: what failed before may have been one nobody saw.
        if (first) s.pingsHold = null
        if (tools !== null) s.toolsKey = tools
        s.firstExchange = false
        s.resumeSeeded = false
        s.prefixChange = null
      }
      s.lastAsked = e.model
      s.lastEffort = e.effort ?? null
      s.lastRequestAt = now
      s.lastMainAt = now
      s.resumeCold = false
      s.lastWasPing = false
    }
    const r = yield* next(e)
    const u = r.usage
    if (!e.agentId && u) {
      const model = u.model || e.model
      if (gap) {
        const failed = learnFromGap(s, gap, u)
        if (failed) await stop($, s, failed)
      }
      // A conversation's first request finds only the prefix every conversation shares, which later reads are measured past.
      if (first !== undefined && s.convTurns === 0 && !s.convResumed && u.cache_read_input_tokens > 0) s.shared = u.cache_read_input_tokens
      // Caching that is off shows as a request that neither read nor wrote; one that did either shows it on.
      const key = modelKey(model)
      if (u.cache_read_input_tokens || u.cache_creation_input_tokens) delete s.offSeen[key]
      else if (u.input_tokens >= OBSERVE_MIN_TOKENS) s.offSeen[key] = `a request on ${model} read and wrote nothing`
      s.lastModel = model
      s.lastPrefix = u.cache_read_input_tokens + u.cache_creation_input_tokens
      s.lastRead = u.cache_read_input_tokens
      // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k).
      if (first !== undefined) {
        const rates = ratesOf(s, model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
        s.firstStep = { read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd: rates ? u.cache_creation_input_tokens * writeRate(rates, belief(s).ttl) / 1e6 : null, explained: first }
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    s.turnsSeen++
    // After a /clear or resume told by session.end, the new conversation's id is read before anything is stored under it.
    await adoptSid($, s)
    // An off at any point in this turn wins over every window the turn would open; a host that raised no
    // step falls back to the count at completion.
    const offs = s.turnOffs ?? s.offs
    s.turnOffs = null
    const now = await $.clock.now()
    refreshLimits(s, now)
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if (e.usage || !e.isAborted) {
      if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
      s.resumeCold = false
    }
    s.compacted = false
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break after a turn that reached the cache (a turn that failed before any response touched
    // nothing, and its cache may be cold). Another session's /keepwarm off or /keepwarm always changes the shared
    // switch, so every such turn reads it.
    if (e.usage) {
      const shared = (await $.store.get(KEY_ALWAYS)) === true
      if (s.offs === offs) s.always = shared && s.keepwarm === 'on'
      if (s.always) await rollAlways($, s, now, offs)
    }
    const u = e.usage
    if (u) {
      s.answered = true
      if (now - s.lastMainAt > e.durationMs) s.lastMainAt = now
      if (u.model) s.lastModel = u.model
      // A host that raised no step clears here what a turn's first request clears.
      s.resumeSeeded = false
      s.prefixChange = null
      if (!s.firstStep) {
        s.lastPrefix = null
        s.lastRead = null
      }
      s.convTurns++
      s.firstExchange = s.convTurns === 1 && !s.convResumed
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const measured = await $.session.usage()
      noteLimits(s, measured.rateLimits, now)
      const live = measured.context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      // Missed: the turn's first request found under half of what was cached before it and re-wrote the rest. The
      // requests after it write what the turn added, cold cache or not. The turn's sum stands in only where no
      // request reported its own figures.
      const step = s.firstStep
      const missed = prev > OBSERVE_MIN_TOKENS && (step ? step.read < 0.5 * prev && step.write >= 0.5 * prev
        : u.cache_read_input_tokens < 0.5 * prev && write >= 0.5 * prev)
      // A re-write a known change explains (another model or effort, the first message re-sent) is no cold write,
      // unless the guard saw the cache go cold first.
      if (step ? missed && (!step.explained || s.coldWritePending) : missed || s.coldWritePending) {
        const tokens = step ? step.write : write
        const rates = ratesOf(s, s.lastModel, prev || s.ctx)
        const usd = step ? step.usd : rates ? write * writeRate(rates, belief(s).ttl) / 1e6 : null
        s.misses.push({ at: now, tokens, usd })
        const blocked = autoArmBlock(s)
        const wanted = s.deadline < now + AUTO_WARM_MS && s.offs === offs
        if (wanted && !blocked) await startWindow($, s, AUTO_WARM_MS, s.every, offs)
        // Why no window opens is news only where none is running.
        $.ui.log(`cold write of ${fmtTok(tokens)} tokens paid (${fmtUsd(usd)}).` +
          (wanted && !blocked ? ` Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.`
            : wanted && !s.deadline ? ` Keepwarm stays off: ${blocked}.` : ''))
      }
    }
    s.coldWritePending = false
    s.firstStep = null
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.ctx = 0
      s.ackedAt = 0
      // The summary starts a conversation of its own.
      newConversation(s, false)
      outdate(s)
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
