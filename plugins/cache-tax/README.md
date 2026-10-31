# Cache Tax for Claude Code

> Vendored from [karanb192/cache-tax](https://github.com/karanb192/cache-tax) v2.3.0 (commit `432a08d`), MIT licensed (see [LICENSE](LICENSE)), and maintained in this repository. It no longer installs from or tracks the upstream repository. The upstream website files, video and icon-generation tool were not copied. Local changes since v2.3.0 (version 2.4.0): the cache lifetime is worked out per session instead of assumed to be an hour, work logins get fallbacks, receipts are in the plan's own terms, and options can be locked by an organization. See [Plans and billing paths](#plans-and-billing-paths).

**Keep Claude Code's prompt cache warm during breaks.**

Cache Tax is a Claude Code mod that refreshes your prompt cache while you step away and shows the estimated rewrite cost before a cold send. Run `/keepwarm 90m` before a break. Pings cost tokens; choose a window you expect to return within.

**[Install](#install)** · [Website](https://cachetax.aidojo.si/) · [Plans](#plans-and-billing-paths) · [How it works](#how-it-works) · [Costs and limits](#cost-and-the-plan-limit-question) · [Commands](#commands)

A two-line recap in a 330k-token session triggered a **$6.61 estimate**. After resending, the reported cache write was **$6.28**. Recorded on 2.1.1; current wording says “up to” the estimated token count. These are API-equivalent costs, not extra subscription charges.

## Install

Needs [Claude Code 2.1.299 or later](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off), a one-hour cache and Claude Code left running. Mods are on by default. Pings cost tokens, including uncapped output.

`./install.sh` in this repository installs it from the local `claude-optimization` marketplace. By hand, once that marketplace is added:

```sh
claude plugin install cache-tax@claude-optimization
```

Restart Claude Code or run `/reload-plugins` in an open session. No early-access flag is needed. If you set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` previously, remove it; current Claude Code ignores it.

In a warm session, run `/keepwarm` to arm six hours. Use `/keepwarm 90m` for a shorter window, or `/keepwarm off` to stop.

**The main cache lifetime decides what keepwarm can do.** Included subscription usage defaults to one hour. Usage credits, API keys and cloud providers default to five minutes, and [`promptCacheTtl`](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself) set to `"1h"` changes that. A 50-minute ping cannot protect a five-minute cache, so cache-tax works out which one the session has and holds its pings on five minutes or when it can't tell. `/cache-tax` shows the lifetime and what it rests on. See [Plans and billing paths](#plans-and-billing-paths).

**Prefer a settings hook?** The [hook version](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/cache-tax) warns by default, refuses once with `CACHE_TAX_BLOCK=1`, and provides a standalone status-line countdown. Warming is part of this mod.

## Plans and billing paths

One build serves personal and corporate plans. The ping and the guard work the same everywhere; three things differ by how the session is billed, and cache-tax reads them per session.

| | Pro / Max | Team / Enterprise (`/login`) | API key, cloud provider, gateway |
| --- | --- | --- | --- |
| Main cache lifetime, unset | 1 hour within plan usage; 5 minutes once [usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) engage. On Pro, Fable models run on credits from the start | 1 hour within the seat allowance (inferred: the docs list Team and Enterprise as subscription plans); 5 minutes on credits, and Standard seats run Fable on credits. Usage-based Enterprise: not documented | 5 minutes unless `promptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL` or `ENABLE_PROMPT_CACHING_1H` say an hour |
| What a ping or a cold write costs you | a share of the 5-hour and weekly limits ("cached portions count less against your limits", [Help Center](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)); dollars only on credits | inside the seat allowance usage "isn't metered in dollars" ([costs](https://code.claude.com/docs/en/costs)); credits at API rates under your organization's caps | real dollars, at list prices or your organization's managed `modelPricing` |
| Limit windows this mod sees | `five_hour`, `seven_day` | none, per the [status-line docs](https://code.claude.com/docs/en/statusline) | none; a Claude apps gateway may report `spend_limit` |
| Hooks a user-installed mod gets | all | Claude Code's [built-in guard](https://code.claude.com/docs/en/plugins/mods/admin#know-which-hooks-of-a-users-mod-dont-run) passes over `classic.*` and `session.compact` | all, unless the machine has managed settings |

How cache-tax decides the lifetime, strongest source first:

1. Configuration Claude Code obeys, in its own order: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m` (the conversation's part of the prompt), `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`. `DISABLE_PROMPT_CACHING`, or `DISABLE_PROMPT_CACHING_FABLE`, `_HAIKU`, `_MYTHOS`, `_OPUS` or `_SONNET` for the session's model family, stands the guard and keepwarm down, as does a request that read and wrote nothing of a prompt of 20K tokens or more.
2. A plan window at 100%: on credits the cache drops to five minutes. A reading past its window's reset no longer counts, and pings held at the stop line go on at that reset.
3. Claude Code's own word for the session's model: a resume 5 to 60 minutes after the last response that it judges still cached, which means an hour, and the lifetime a model switch reports, which belongs to the model being left. A resume it judges expired says nothing of the lifetime, since Claude Code calls a conversation compacted since its last response expired at any gap; that conversation counts as cold until its first request.
4. A statement: `/cache-tax ttl 1h|5m` on this machine, or the `cacheTtl` option.
5. What this session's requests showed, kept per model and measured past the prefix every conversation shares (the first request of a conversation reads only that). A read 15 to 60 idle minutes into a break means an hour; five-minute entries have been seen read 8.5 minutes after their last use, so an earlier read says nothing. A re-write 5 to 60 minutes in that still read the shared prefix is one sighting of five minutes, and it takes two. A re-write that a model, effort or tool-list change explains, or a resume, or the first message Claude Code re-sends in full after a conversation's first turn, is no sighting.
6. The plan's default: subscription windows under 100% on a non-Fable model mean an hour; an organization mod told the account (`$.session.identity()`) uses its kind and plan.

Otherwise the lifetime is **unconfirmed**. Then the card shows `unknown` between 5 and 60 idle minutes, the guard only warns, and keepwarm sends no pings until the lifetime is known or you repeat the arming command within two minutes. A period under five minutes (`/keepwarm 30m every 4m`) arms without asking while fewer than five minutes have passed since the last request, or after a resume Claude Code judged expired, when its first ping waits for your next turn; otherwise it asks like any other. A go-ahead covers the window it was given for, however `always` extends it; `/keepwarm off`, `/clear` and any window opened anew, such as `always`'s next one, start without one, so `always`'s own windows wait for the lifetime. With `always` on, your turn leaves a running window at a period under five minutes at its period, for at least 30 minutes, and rolls a window armed on a go-ahead as on a one-hour cache.

On a five-minute cache the guard warns (mode `auto`) at the 5-minute write rate, 1.25x base input instead of 2x, and the first warning names the fix: the `promptCacheTtl` setting, or the environment variable that forces five minutes. Keepwarm opens no window that would ping after the cache is gone; `/keepwarm 30m every 4m` still works for a short break. `always` keeps 30 minutes at one ping per 4 minutes after each turn there, and leaves a running window you armed at a period under five minutes at its period, for at least 30 minutes.

The first message more than five minutes after a ping must read the cache. If it re-writes it instead, with no model, effort or tool change to explain it, pings don't keep this cache alive: keepwarm stops, and no window pings until you arm one with `/keepwarm` or start over with `/clear`.

## In an organization

On a Team or Enterprise `/login`, or any machine with managed settings, Claude Code's built-in guard keeps a user-installed mod's `classic.SessionStart` and `session.compact` hooks from running. cache-tax then hears about `/clear` and resume only through `session.end`. It resets its state there in every session; where `classic.SessionStart` arrives too, the reset happens once, whichever comes first. The new conversation's id is read before anything is stored under it. After an idle compaction the mod did not see, the engine reports no live context until the next response. Where one may have happened (`idleCompaction` on, 200K+ tokens, 54 minutes after the last request on a cache that may live an hour), the guard sends with the price unknown rather than refuse on the old size. The resume warning and its pre-turn seeding are lost. The card says so after the first turn of a fresh session.

To give it every hook, an administrator installs it as the organization's mod ([Install your organization's mods](https://code.claude.com/docs/en/plugins/mods/admin#install-your-organizations-mods)):

- Managed `enabledPlugins` enables it.
- Managed `extraKnownMarketplaces` names a directory marketplace by absolute path, writable only by administrators.
- That marketplace lists the plugin by a relative path. A copy from GitHub, git, a URL or npm counts as a user's.

An organization mod is also told the account (`$.session.identity()`), and the card shows its kind and plan, never the email.

Options, read from `pluginConfigs["cache-tax@<marketplace>"].options` in user or managed settings (project settings are ignored):

| Option | Values | Default |
| --- | --- | --- |
| `guard` | `auto` (refuse once on a 1-hour cache, warn otherwise), `refuse`, `warn`, `off` | `auto` |
| `keepwarm` | `on`; `manual` (no `always`, no automatic window after a cold write); `off` (no pings) | `on` |
| `cacheTtl` | `auto`, `1h`, `5m`: what cache-tax assumes, not Claude Code's own lifetime | `auto` |
| `stopAtPercent` | 1–100: hold pings while any limit window is at or above it | `95` |

A value set in settings stands over this machine's stored choice, and `/cache-tax guard` and `/cache-tax ttl` refuse to change it, pointing to `/config`; the card lists it. It is the organization's when managed `pluginConfigs` sets it or its `/config` row is locked, under the plugin's name or, beside another plugin of that name, its id. Any value away from its default counts as set, even where neither the lock nor the managed value reaches the mod. Where the mod's own `/config` rows are kept from it while other plugins' rows show, it treats them as possibly locked: the commands refuse, and a stored choice gives way. (A `-p` run lists no plugin rows at all, so there the commands work as usual.) Otherwise those commands store a choice for this machine.

Managed `modelPricing` prices the card's estimates as Claude Code's `/usage` does. A key that is a built-in model's id covers that model's dated and provider forms; any other key matches one model id exactly. A row missing any of its four rates is skipped, and the multiplier scales every row, overridden or not. A user-level `modelPricing` is ignored, as Claude Code ignores it.

## How it works

**Before a break:** `/keepwarm` arms a bounded window. After 50 idle minutes, a timer inside Claude Code sends one tool-less fork over the session's transcript. It reads usage after every ping. A ping is warm when it reads back at least nine tenths of the prefix the last main request left cached (with no such figure, when it writes under a tenth of what it reads). Sometimes a known change explains a re-write: a tool list that changed since your last message, or the first message Claude Code re-sends in full after a single exchange. Then the ping is logged and the window goes on, since your next message and the next ping read what it wrote. Any other re-write, or a ping that reads nothing, stops the loop. A model or effort changed during the break holds the pings until your next message, which writes the cache for the new setting; a ping would only pay that write early. There is no background transcript-polling loop.

**When you return cold:** for a context of at least 50,000 tokens, the guard drops your ordinary message once when its clock says the cache is cold, timed by the session's [cache lifetime](#plans-and-billing-paths), or when Claude Code judged it expired as the conversation was resumed. In its default mode, `auto`, it refuses only on a one-hour cache and warns on a five-minute or unconfirmed one. It shows the estimated rewrite price: Claude Code's own estimate after a resume or a model switch, until the context changes, and otherwise the context at the cache-write rate. Resend to continue, or `/clear` and start from a note. A prompt no person sent, such as a background task's notification, a scheduled prompt or another session's message, is sent with the price logged, because nobody is there to resend it. Anything a person may have sent keeps the guard, including Remote Control, Slack and channel messages, SDK hosts and prompts Claude Code cannot classify.

A cold write is a turn whose first request found under half of what was cached before it and re-wrote the rest, with nothing but the break to explain it; the tally counts that request's write, since the turn's later requests write what it added either way. On a confirmed one-hour cache, a detected cold write automatically arms at least three hours of keepwarm, six with `always` on, and prints what it cost; where no window is running it prints why keepwarm stays off. `/cache-tax` shows the cache lifetime and its source, the current cache estimate, the plan's limit windows, the warming window and this session's cold-write tally.

Windows belong to individual sessions. An already-cold session waits for your next turn before pinging, and so does a window restored after Claude Code restarts, until the new process has a turn to fork. A ping refused by a busy API (429, 529, 5xx) is retried after 1, 2 and 4 minutes while it can still land before the cache goes cold. With `always` on, each of your turns that reaches the cache leaves at least six hours of window at the default period, so any break up to six hours stays warm however long the session runs. The same turn brings back a window that stopped, stretches a shorter one to six hours and resets a testing period; a longer window you set stays. On a five-minute cache the turn leaves 30 minutes at one ping per 4 minutes instead. On a five-minute or unconfirmed lifetime, a running window at a period under five minutes keeps its period, for at least 30 minutes, since that period is what holds the cache. On an unconfirmed lifetime, a window you armed on a go-ahead rolls as on a one-hour cache and keeps the go-ahead, while `always`'s own windows wait for the lifetime. `/keepwarm off` in any session stops every session rolling from its next turn. A window ends at its deadline; `/keepwarm off` also cancels it and clears the always setting.

### A recorded warming ping

Sonnet 5, 16 September 2026: the status reported **75k tokens read at $0.02**. Nothing appeared in the conversation during the live run. This capture used the one-minute testing interval on 2.0.0; its card's $0.45 rewrite estimate used an older Sonnet price row, versus $0.30 for the same context with the current row. The two-cent ping is a receipt for that session, not a fixed price.

## Why a short message can cost so much

When the cached prefix expires, even “give me a recap” can trigger a rewrite of the old context before the answer. Cache Tax's Fable 5.1 price row compares a $20 one-hour write with a $0.25 cache read per million tokens: 80x per token, not 80x total savings. See the [pricing assumptions](#cost-and-the-plan-limit-question) and [Anthropic's price table](https://platform.claude.com/docs/en/about-claude/pricing).

New to caching? [Anthropic explains how Claude Code uses it](https://code.claude.com/docs/en/prompt-caching).

## Commands

    /keepwarm               keep warm for six hours
    /keepwarm 90m           keep warm for a window of your own (also 2h30m, 6h)
    /keepwarm always        keep every session warm until six hours after its last turn (30m at one ping per 4m on a five-minute cache; on an unconfirmed lifetime only the window you confirm pings), remembered across sessions
    /keepwarm 6h every 2m   pinging every two minutes; a testing knob, 1m to 59m, forgotten after this window (with always on, at your next turn)
    /keepwarm status        the warming window, next ping and last receipt
    /keepwarm off           stop, forget the window, and turn always off
    /cache-tax              the card
    /cache-tax guard auto   refuse once on a one-hour cache, warn on a five-minute or unconfirmed one (default)
    /cache-tax guard warn   show the price and send (the hook's default)
    /cache-tax guard refuse drop a cold send once, the resend goes through
    /cache-tax guard off    no check before a cold send
    /cache-tax ttl 1h       tell cache-tax this machine's cache lives an hour (also 5m; auto to detect again)

On an unconfirmed lifetime, `/keepwarm` first answers with the risk priced; the same command again within two minutes arms it. A reply that arms a window says when no pings will go, and why. Options set in settings, the organization's included, can't be changed by these commands; see [In an organization](#in-an-organization).

The refusal, verbatim:

    cache-tax: the prompt cache went cold 2h00m ago. Sending this re-writes up to 200,502 tokens at $20/MTok = $4.01 (a warm turn would have cost $0.05). Send it again to pay it, and keepwarm will then hold the cache for 3h00m. Or /clear and start from a note.

The figure is an upper bound. The context count the engine reports for a resumed session is the last response's input, cache read, cache write and output together, and the resume payload carries no separate output count to take off; on one 15-day-old session the refusal said 330,316 tokens and $6.61 and the write that followed was 314k tokens, $6.28.

While keepwarm is armed, the terminal and Desktop Code tab show a row above the prompt with the Cache Tax cube. Its lid is green for warm, orange for cold, and grey before the first turn or after compaction. The bold state label matches; the timer and receipt text use normal weight. Ghostty and kitty can draw the image; other terminals show `[>]` in its place. A nonempty `NO_COLOR` selects a bold text icon and an uncolored state label. The row also says `warm`, `cold` or `unknown`, so color is never the only signal. These states use the same clock as `/cache-tax`, timed by the session's cache lifetime; with an unconfirmed lifetime the row says `unknown` between 5 and 60 idle minutes. They are estimates, not a live server cache check.

The row includes the warming window, next ping and last readback. A stopped loop shows a neutral symbol and its reason. `/keepwarm off` or an expired window removes the row. Surveys temporarily take priority, and other mods' content stays in the band. Sessions without this band retain the plain status text.

The cube follows Claude's light or dark theme. Its terminal image also has a contrasting edge for terminal backgrounds that differ from that setting. The embedded assets come from the upstream website's official SVGs. No image files are read or fetched at runtime.

The mod reads the theme and `NO_COLOR` once when the session starts. Accepted theme changes update the icon immediately; ordinary redraws do not reread either setting. Set `NO_COLOR` before starting the session.

## Both forms installed

The hook and the mod share a name and a job, so having both means two guards on every cold send. The mod checks at session start whether the hook's `/cache-tax:status` command exists and says so once. Keep one guard. The hook remains an option for people who prefer settings hooks. Before uninstalling it, check your status line: the 🧊 row wired to `cache-tax.js` comes from the hook's files. This mod draws above the prompt while keepwarm is armed; it does not replace your shell status line.

## What it can reach

Validated on Claude Code 2.1.314:

    ❯ ./register.ts hooks: config.set{key=theme}, ui.render{component=AbovePrompt}, session.start, classic.SessionStart, classic.PreModelSwitch, classic.PostModelSwitch, session.end, session.measure, command.run{command=effort}, command.run{command=keepwarm}, command.run{command=cache-tax}, prompt.submit, turn.step, turn.complete, session.compact
    ❯ ./register.ts calls: $.clock.after (via arm, ping), $.clock.now, $.command.list, $.command.register, $.config.list, $.env.get, $.model.fork (via ping), $.session.id, $.session.identity, $.session.model, $.session.usage, $.settings.read (via readLocks, readSettings), $.store.delete, $.store.get, $.store.set, $.tool.list (via toolsKey), $.ui.invalidate, $.ui.log, $.ui.resolve, $.ui.status
    ❯ ./register.ts env reads: CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL, CLAUDE_CODE_PROMPT_CACHE_TTL, DISABLE_PROMPT_CACHING, DISABLE_PROMPT_CACHING_FABLE, DISABLE_PROMPT_CACHING_HAIKU, DISABLE_PROMPT_CACHING_MYTHOS, DISABLE_PROMPT_CACHING_OPUS, DISABLE_PROMPT_CACHING_SONNET, ENABLE_PROMPT_CACHING_1H, FORCE_PROMPT_CACHING_5M, NO_COLOR

Reach L2, drives Claude. Sees every prompt you type, every model request's timing and every answer's token counts.

    Threat model for cache-tax (reach L2, drives Claude)
    1. Reads:    of each prompt, whether it starts with a slash and nothing else (the text is passed on untouched, never kept, never logged); the time; the token counts and model id the engine already holds on turn.complete and on the fork's reply; the resume fields Claude Code computes for settings hooks; the model and effort level each main request names; the command list, the session id and, before each ping and when a resumed session's fields carry no model id, the session's model; the names of the tools, at each turn's first request and before each ping, to tell a changed tool list; of /effort, its first word, to tell a new level; the limit windows, live context size and /usage cost total from $.session.usage() and session.measure; the cache lifetime and price Claude Code reports at a model switch; settings through $.settings.read: promptCacheTtl and idleCompaction (merged), and modelPricing and its own pluginConfigs entries (managed only); the cache environment flags named above; the /config rows, at start for the theme and at start and each /cache-tax command for which of its own options are locked; once at start, $.session.identity(), which answers only an organization's mod and whose email is never shown or kept; the option values register() receives; from its own $.store, the keepwarm deadline and the ping period keyed by session id, plus the global always switch, guard mode and stated cache lifetime
    2. Runs:     one $.model.fork per idle stretch inside a keepwarm window, one per ping period (50 minutes unless the testing knob set it, or 4 minutes for always on a five-minute cache; floor 1 minute), never outside the window, never onto a cache the mod already knows is cold, never after a readback that read nothing or re-wrote what no known change explains, never while the cache's lifetime is five minutes or unconfirmed (unless you shortened the period or confirmed), a limit window is at the stop line, the model or effort changed since your last message, or a message after a ping showed pings don't hold the cache (until you arm a window again)
    3. Sends:    nothing leaves the machine except the fork, an API request over the session's own transcript with a fixed one-line prompt
    4. Persists: in $.store, the keepwarm deadline and the ping period under this session's id (with always on, rewritten after each turn), and the always switch, the guard mode and the stated cache lifetime (/cache-tax ttl) for every session; nothing in settings files; a window that has ended is deleted at stop and at this session's next start, together with the bare keys of a 2.1.0 store; another session's keys are never deleted here, because a read followed by a delete cannot be made atomic against that session renewing its window, so a session that armed keepwarm and never came back leaves two small keys behind; the session's cold-write tally lives in memory and dies with the session
    5. Hostile input: the only text it parses is the argument of its two commands, matched against a duration regex and five literals, and the first word of /effort, compared with the last request's level; of the prompt text only the first non-blank character is inspected, for a slash; tool results and files never reach a branch; the fork's prompt is a constant, so nothing crafted can be sent through it; a refusal only ever drops the user's own message, and the resend is unconditional; if a hook throws, the engine skips it and the message enters unguarded, with one dim line

## Cost and the plan-limit question

Prices are the list table, or your organization's managed `modelPricing` when it sets one, where Fable 5.1 reads at $0.25, writes the 1h tier at $20 and answers at $50 per million tokens; Sonnet 5 has its own row ($0.20, $4, $10). On an API key the arithmetic is plain. A ping bills the cache read, its own few uncached tokens at the base rate, and whatever the model says back at the output rate; the displayed ping cost counts all of it, since a fork takes no output cap and a model at high effort may think before it says "warm". A comeback after the lapse is a write. The card prints the read-only upper bound for your model, 80 pings on Fable 5.1, with the idle that covers at the current ping period; a real ping costs a little more than a read, so the true break-even sits below that number. A five-minute cache writes at 1.25x base input instead of 2x, and cache-tax prices it that way. A ping's receipt prices the ping's own usage at those rates; the session's cost ledger also moves for anything else that lands while the fork is out, such as a subagent's answer. On a subscription the dollars are a yardstick, not the bill: the receipt adds how many points each limit window moved, such as `(5h +0.3% account-wide)`. Those points run from the last response before the ping to the ping's own, so they include whatever else the account used meanwhile, claude.ai included; when the ledger shows another response of this session landed during the ping, the receipt leaves them out. Anthropic says cached content counts less against your limits than new content, but not by how much, so those points are the nearest measure there is. On a Team or Enterprise login no windows are visible to the mod, and the dollars stay a yardstick.

## Limits

- Mods require Claude Code 2.1.287+, and cache-tax 2.1.299+, the first build with `$.session.identity()`; Claude Code's changelog doesn't date the other mod calls it makes. Mods are on by default, but local settings, safe mode or organization policy can prevent them from loading. See [mod controls](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off).
- Claude Code's `DISABLE_PROMPT_CACHING_SONNET`, `_OPUS` and `_HAIKU` turn caching off for that family's default model only; cache-tax stands down for the whole family, so on an older model of that family whose cache still works it neither guards nor pings.
- Only a model, effort or tool-list change it can see explains a re-write. A prefix change it can't see looks like an expired cache: it stops a ping, and two such sightings would say five minutes until `/cache-tax ttl` states otherwise.
- The 50-minute schedule needs a one-hour main cache. Included subscription usage has it by default, and usage credits, API keys and cloud providers need [`promptCacheTtl`](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself) set to `"1h"`. cache-tax works the lifetime out from configuration, limits and the session's own requests, but can't see whether a Team or Enterprise seat or a usage-based Enterprise plan is on credits until a request shows it.
- On Pro and Team Standard, Fable and Mythos run on usage credits, so on a subscription their lifetime stays unconfirmed until the session shows it.
- Claude Code compacts a one-hour conversation of 200K+ tokens about 54 minutes into a break unless `idleCompaction` is `false`; whether a ping defers that is unverified. The card names it when it applies.
- As a user mod on a Team or Enterprise login or a managed machine, cache-tax gets no resume warning; see [In an organization](#in-an-organization).
- One transcript-verified return at the default interval, Fable 5.1 on a subscription, 19 September 2026: `/keepwarm` armed at minute 42 of a break, the ping fired at minute 50 and read 157k, and the message sent at minute 62 read 156,886 tokens from cache and wrote 2,255. Claude Code's own cache countdown reset to 58 minutes after the ping, so the fork carried the one-hour TTL. One run, one configuration: it shows the ping kept that cache alive past the hour, not net savings for every setup. Claude Code documents forks in its non-main request bucket, normally five minutes. In this run, the fork still read the one-hour session prefix and reset the native countdown. That is observed behavior in one configuration, not proof that every provider handles the buckets identically.
- A ping that reads warm proves the cache was warm then. Prefix changes can invalidate the cache regardless of time. The exact effect depends on the model and when Claude Code applies the change; see [Claude Code's cache behavior](https://code.claude.com/docs/en/prompt-caching).
- Resume fields let the guard check the first ordinary send after resuming; a resume Claude Code judged expired counts as cold until its first request, whatever the clock says. If those fields are absent, the first turn seeds its clock and context.
- The refusal's token count is an upper bound: it is the context the engine reports for the last response, which on a resume includes that response's output, and the mod has no separate output count to subtract.
- The cold-write tally is per session and in memory; /clear empties it.
- Context size is the engine's live window figure. A turn's own usage is its responses summed, which on a ten-step turn is ten reads of the context, so it is only the fallback where the host reports no live figure.

## Local development

From the claude-optimization repository root, load it for one session:

    claude --plugin-dir plugins/cache-tax

To keep it installed, rerun `./install.sh` from the repository root.

## Prove it on your own session

The mock-clock tests prove the timer, the guard and the scoring, not that a fork hits the main cache. One ping proves that, and it costs a cache read plus the answer. In any warm session:

    > Reply with one word: ready
    > /keepwarm 1h every 1m

Watch the row above the prompt after a minute, or the plain status text on other surfaces. `last ping read 20k $0.01` reports the fork's readback. `keepwarm stopped: the ping read ... and wrote ...` means the readback did not meet the warm threshold; the loop has stopped. `the ping re-wrote ... because ...` names a change since your last message that explains the re-write; the loop goes on. `API busy, ping retry 1 of 3` means a 429, 529 or 5xx is being retried; the loop stops if the API is still busy after three retries or a minute before the cache goes cold. `nothing to fork yet` means the process has no conversation to fork, as after a restart; the window waits for your next message. Any other API error, an interruption or an empty reply stops the loop with a reason. Older engines that return null show a combined cold-snapshot or API-failure message. Finish with `/keepwarm off`. This short check establishes a cache read, not retention across the default 50-minute interval.

## Tests and typecheck

Run from the claude-optimization repository root:

```sh
claude plugin validate plugins/cache-tax
claude plugin test plugins/cache-tax
```

The [228 tests](tests/register.test.ts) use a mock clock and engine. They cover:

- **Guard:** refuse once and resend, warn mode, slash commands, small contexts, prompts nobody typed, resume seeding and cold-write scoring.
- **Warming:** command defaults and refused windows and periods, always/off, always after `/clear`, always rolling from the last turn, idle resets, usage-based stopping, cold-window expiry and delayed timers after sleep.
- **Session state:** isolated store keys, restored windows, legacy cleanup, clear/compaction resets and subagent isolation.
- **Pricing and display:** a row for every listed model, the Haiku 5.5 long-prompt tier priced per request, Opus 4 and 4.1 apart from Opus 4.5, output and uncached input costs, context counts, duration formatting, rates a multiplier scaled, Claude Code's own estimate quoted without a table rate, and the read-only break-even figure.
- **Indicator:** terminal images and desktop SVGs, theme selection, warm/cold transitions, resume, compaction, clear, expiry, surveys, other mods' content, text alternatives and `NO_COLOR` fallback.
- **Preferences:** one read per session, immediate theme updates, denied changes and the effective theme returned by the settings writer.
- **Cache lifetime:** configuration in Claude Code's order, per-model caching off, plan windows, used-up limits and readings past their reset, Fable, reads and re-writes after a break measured past the shared prefix, two sightings for five minutes, evidence per model, resume and model-switch fields, a resume judged expired as after `/compact`, `/cache-tax ttl` over sightings, the five-minute guard and its remedy, held pings and short periods, `always` on a five-minute or unconfirmed lifetime, confirming an unconfirmed window and a go-ahead per window, and the comeback after a ping.
- **Prefix changes:** a model or effort changed during a break holds pings; a changed tool list and the first message re-sent after a single exchange explain a ping's re-write; none of them counts against the lifetime or the pings, and the verdict on pings resets with `/clear`, a resume or a new `/keepwarm`.
- **Plans and organizations:** `/clear` and resume through `session.end`, with or without classic hooks and in either order, and the session id behind stored windows; an unseen idle compaction; receipts priced from the ping's own usage with account-wide limit points; stop lines; managed `modelPricing` as Claude Code applies it; idle compaction; the four options, locks, settings over stored choices and rows kept from the mod; and identity.
- **Fork failures:** a busy API is retried while the cache is warm, a retry that wakes too late is dropped, nothing to fork waits for the next turn, one ping is out at a time, a reply that lands after a request, `/clear` or compaction is discarded, and other failures and the null result returned by older releases stop without retrying.

The render tests check the element tree, not native terminal or desktop pixels. They do not validate server-side cache retention. See [the live check](#prove-it-on-your-own-session).

### Typecheck

Load the plugin with `claude --plugin-dir plugins/cache-tax` to generate declarations beside it. Then, from the claude-optimization repository root:

```sh
npx -p typescript tsc -p plugins/cache-tax
```

Generated declarations live in `plugins/cache-tax/.claude-plugin/types/`, which `.gitignore` keeps untracked.
