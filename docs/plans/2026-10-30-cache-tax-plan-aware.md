# cache-tax 2.4.0: correct on every Claude plan

Record state: CANCELED

## Approved baseline

- Outcome: one cache-tax build that works correctly on personal (Pro/Max) and corporate (Team/Enterprise login) plans. It detects the main cache lifetime (1h, 5m or unconfirmed) instead of assuming 1h, falls back safely where a work login suppresses its `classic.*` and `session.compact` hooks, reports pings and cold writes in the plan's currency with stop thresholds, takes org-lockable options, and documents the plan differences. Version 2.4.0.
- Scope and constraints:
  - Implement all five parts of the approved plan in `plugins/cache-tax/` (`hooks/register.ts`, `tests/register.test.ts`, `.claude-plugin/plugin.json`, `README.md`), plus `plugins/.claude-plugin/marketplace.json` and the repo `README.md`.
  - Target setups: Pro/Max on this workstation, and a Team/Enterprise claude.ai login.
  - Existing tests keep modelling a subscriber.
  - Preserve unrelated content. No AI attribution.
- Acceptance criteria:
  1. `register.ts` implements parts 1–4 of the plan:
     - the TTL belief with its sources and precedence;
     - 5m/unconfirmed guard and keepwarm behavior, and comeback verification;
     - work-login fallbacks;
     - receipts and stops;
     - userConfig options with lock precedence, `/cache-tax ttl`, identity.
  2. `claude plugin validate plugins/cache-tax` passes, and the README's "What it can reach" matches its output (G01).
  3. `claude plugin test plugins/cache-tax` passes, existing and new tests alike (G02).
  4. The typecheck is clean against current declarations (G03).
  5. Live on this workstation:
     - Pro/Max shows TTL 1h with the limit windows, and a ping receipt with Δ$/Δ% (G04);
     - the 5m simulation behaves as specified (G05).
  6. Docs updated and consistent with behavior (G09).
  7. A work-login checklist is delivered; the user runs it (G06).
- Approval evidence: the user approved the saved plan `~/.claude/plans/research-how-can-be-bright-turing.md` on 2026-10-30 through plan mode. Scope answers that day: "All five"; setups "Personal Pro/Max, Team/Enterprise login".
- Authorized actions and limits:
  - Authorized:
    - edit the files above and this record;
    - run `claude plugin validate`/`test` and the typecheck;
    - regenerate the gitignored declarations (G00);
    - run live `claude --plugin-dir plugins/cache-tax` sessions here for G04/G05, costing a few pings and one 50K+ context.
  - Needs separate approval:
    - G07 (the idle-compaction test);
    - G08 (`./install.sh`, which writes `~/.claude`);
    - commits and pushes;
    - upstream issues or PRs.
- Record location: docs/plans/2026-10-30-cache-tax-plan-aware.md

## Tasks

| Task | Outcome; depends on | Progress | Gates | Next action |
| --- | --- | --- | --- | --- |
| T01 | 2.1.314 declarations regenerated; decided whether the mod API exposes prompt-cache TTL, expiry or overage; none | ✅ DONE | G00 | None |
| T02 | Part 1: cache-lifetime belief, 5m/unconfirmed behavior, comeback check, tests; T01 | ✅ DONE | G01, G02, G03 | None |
| T03 | Part 2: work-login fallbacks (`session.end`, live context, card note), tests; T02 | ✅ DONE | G01, G02, G03 | None |
| T04 | Part 3: receipts, stops, `modelPricing` and 5m write pricing, idle-compaction note, tests; T02 | ✅ DONE | G01, G02, G03 | None |
| T05 | Part 4: userConfig options with lock precedence, `/cache-tax ttl`, identity, tests; T02 | ✅ DONE | G01, G02, G03 | None |
| T06 | Part 5: plugin README, `plugin.json` 2.4.0, `marketplace.json`, repo README; T02–T05 | ✅ DONE | G01, G09 | None |
| T07 | Live checks on this workstation; T02–T05 | ✅ DONE | G04, G05 | None |
| T08 | Work-login checklist delivered for the user to run; T06 | 🔄 IN_PROGRESS | G06 | The user runs G06 step 5 interactively on dsn |
| T09 | Optional idle-compaction interplay test (needs approval); T07 | ⬜ TODO | G07 | Ask the user |
| T10 | Install 2.4.0 with `./install.sh` (needs approval); T06, T07 | ✅ DONE | G08 | None (approved 2026-10-30: "Install, commit and push") |
| T11 | Review fixes, lifetime inference and pings: A1, A3, A4, A7, A8, A9 (per-model evidence, two observations for 5m, explained misses, latch resets, first-exchange pings, `/effort`); T02 | ✅ DONE | G01, G02, G03, G10 | None |
| T12 | Review fix D1: settings and locks beat a stored choice; withheld rows refuse changes; rows keyed by plugin id; T05 | ✅ DONE | G01, G02, G03, G10 | None |
| T13 | Review fixes C1, C2, C3: cold write judged by the first request's read; unknown price after a possible unseen idle compaction; managed pricing as the engine applies it; T04 | ✅ DONE | G01, G02, G03, G10 | None |
| T14 | Review fixes A2, A5, A6, D3: model switch per model with the engine's estimate; per-model caching off and the messages TTL; env-var remedy; version floor; T02 | ✅ DONE | G01, G02, G03, G10 | None |
| T15 | Review fixes B1, B2, D2, E1, E2: readings past their reset; receipts priced from the ping's own usage; session id at storage; always on short windows; confirmation per window; T03–T05 | ✅ DONE | G01, G02, G03, G10 | None |
| T16 | Docs for T11–T15: plugin README, `plugin.json`, `hooks.json`, repo README if affected; T11–T15 | ✅ DONE | G01, G09 | None (repo README and `marketplace.json` checked: still accurate, unchanged) |
| T17 | Live re-check of G04/G05 on the fixed build (authorized in the baseline); T16 | ✅ DONE | G04, G05 | None |
| T18 | Verification fixes: `always` on an unconfirmed lifetime keeps a running short period and a go-ahead window (E1), and its reply after a go-ahead says so; a resume Claude Code judged expired is no lifetime evidence, and that conversation is cold until its first request (A1); the guard's price after a model switch; rates printed to six significant figures (K22); tests; T11, T14, T15 | ✅ DONE | G01, G02, G03, G10 | None |
| T19 | Docs for T18: plugin README, `plugin.json` if affected; T18 | ✅ DONE | G01, G09 | None (repo README and `marketplace.json` checked: unaffected; `plugin.json` unaffected) |
| T20 | Live re-check of G04/G05 on the T18 build (authorized in the baseline); T19 | ✅ DONE | G04, G05 | None |

## Gates

| Gate | Method and expected result | Status | Latest evidence |
| :-- | :-- | :-- | :-- |
| G00 | Declarations headed "Written by Claude Code 2.1.314" exist beside the plugin; their `SessionUsage` and related types searched for cache TTL, expiry and overage fields; decision recorded | ✅ PASS | G00 attempt 1 |
| G01 | `claude plugin validate plugins/cache-tax` passes, userConfig included; the hooks, calls and env lines match the README | ✅ PASS | G01 attempt 5 |
| G02 | `claude plugin test plugins/cache-tax`: every test passes, existing and new | ✅ PASS | G02 attempt 4 |
| G03 | `npx -p typescript tsc -p plugins/cache-tax` exits 0 with no errors | ✅ PASS | G03 attempt 4 |
| G04 | Live, Pro/Max: `/cache-tax` shows `ttl 1h` with reason subscription and the 5h/7d windows; `/keepwarm 1h every 1m` gives a receipt with Δ$ and Δ%; `/keepwarm off` | ✅ PASS | G04 attempt 3 |
| G05 | Live, `FORCE_PROMPT_CACHING_5M=1`: card `ttl 5m`; bare `/keepwarm` refused with the fix; a send after more than 5 minutes idle on a 50K+ context warns at the 5m rate; no fork sent | ✅ PASS | G05 attempt 3 |
| G06 | User runs the work-login checklist: guard note, card wording, no stale refusal after `/clear`, whether 5h/7d windows show, `/cache-tax ttl 1h` arms without confirmation | 🔄 IN_PROGRESS | G06 attempt 2 (steps 1–4, 7 pass; 6 N/A; 5 open, interactive only) |
| G07 | Optional: a 200K+ context; does a ping at 50m defer idle compaction at about 54m (needs approval) | ⬜ NOT_RUN | Pending |
| G08 | `./install.sh` twice: installs 2.4.0; the second run reports everything up to date with no new `.bak` (needs approval) | ✅ PASS | G08 attempt 1 |
| G09 | Docs review: every changed README statement matches the code and tests; links resolve; matrix sources cited | ✅ PASS | G09 attempt 3 |
| G10 | Each review finding (A1–A9, B1–B2, C1–C3, D1–D3, E1–E2) has a named test that drives its failure scenario, and the test passes | ✅ PASS | G10 attempt 2 |

## Evidence

All attempts run in the repo root, on 66f982d plus this change's uncommitted edits.

### Baseline (before any edit)

- `claude plugin validate plugins/cache-tax`: ✔ Validation passed (ICON_MISSING catalog warning only).
- `claude plugin test plugins/cache-tax`: 137 pass, 0 fail.

### G00 attempt 1

- Method:
  - `claude plugin validate`/`test` and `claude -p "/cache-tax status" --plugin-dir plugins/cache-tax` wrote no declarations; the `-p` run printed the card with no model call.
  - An interactive session, driven through a pty by a scratchpad script (`claude --plugin-dir plugins/cache-tax --settings '{"enabledPlugins":{"cache-tax@claude-optimization":false}}'`, then `/exit`), wrote `plugins/cache-tax/.claude-plugin/types/` (gitignored), headed `// Written by Claude Code 2.1.314.`
- Expected: the declarations exist; a decision on the mod API.
- Actual:
  - `SessionUsage` is still `{ startedAt, context, rateLimits, cost }`.
  - Cache TTL and warmth appear only in classic Pre/PostModelSwitch (`cache_ttl`, `prompt_cache_warm`) and resume `prompt_cache_likely_expired`.
  - There is no expiry or overage field.
  - 107 changed lines versus 2.1.312, none in the APIs used here.
  - `SettingsKeyRead` is `{ key, source? }`; `Register` is `(on, options)`.
- Status: PASS.
- Decision: implement the inference of part 1 as planned.

### G02 attempt 1

- `claude plugin test plugins/cache-tax` in the repo root: 184 pass, 0 fail (the original 137 plus 47 new: lifetime sources, the 5-minute cache, unconfirmed lifetimes, comebacks, organization-login fallbacks, receipts and stops, pricing, options and locks, identity). Status: PASS.

### G03 attempt 1

- `npx -p typescript tsc -p plugins/cache-tax` against the 2.1.314 declarations (hooks and tests included): exit 0. The first run found one `string | undefined` at `parseDuration(words[0])`, fixed with `?? ''`. Status: PASS.

### G01 attempt 1

- `claude plugin validate plugins/cache-tax`: ✔ Validation passed, userConfig included.
- New hooks: `classic.PreModelSwitch`, `classic.PostModelSwitch`, `session.end`, `session.measure`.
- New calls: `$.session.identity`, `$.settings.read`.
- env reads: `CLAUDE_CODE_PROMPT_CACHE_TTL`, `DISABLE_PROMPT_CACHING`, `ENABLE_PROMPT_CACHING_1H`, `FORCE_PROMPT_CACHING_5M`, `NO_COLOR`.
- The only new advisory is "gating hook without .catch" for the two observe-only model-switch hooks; v2.3.0 had the same note for its other classic hooks (compared by validating a `git archive` copy of HEAD in the scratchpad).
- README half pending (T06).

### G01 attempt 2

- After the README edits: `claude plugin validate plugins/cache-tax` ✔ Validation passed. The README's "What it can reach" quotes its hooks, calls and env-reads lines verbatim, so they match the output. Status: PASS.
- Rerun of `claude plugin test plugins/cache-tax` after the docs: 184 pass, 0 fail.

### G09 attempt 1

- Every `#anchor` in the plugin README and the repo README, including the repo README's link to `plugins/cache-tax/README.md#plans-and-billing-paths`, resolves to a heading (scripted check).
- The README statements were written against the code and its tests: the lifetime order matches `belief()`, the guard modes `guardAction()`, the hold reasons `holdReason()`, the options `readOptions()`/`lockedFields()`, and the fallbacks the `session.end` hook.
- `hooks.json`, `marketplace.json` and `plugin.json` parse as JSON.
- Not done: the external doc URLs in the matrix were taken from the research and not fetched again. Status: PASS.

### G04 attempt 1

- Method: a pty-driven interactive session in the repo root: `claude --model claude-haiku-5-5 --plugin-dir plugins/cache-tax --settings '{"enabledPlugins":{"cache-tax@claude-optimization":false}}'`; one short turn, then `/cache-tax`, `/keepwarm 1h every 1m`, wait 80 s, `/keepwarm status`, `/cache-tax`, `/keepwarm off`, `/exit`. Captured in the scratchpad (`drive/g04.log.plain`).
- Actual:
  - The card read `state warm, 59m left`, `cache lives 1 hour (a subscription within its limits)`, `plan 5h 14%, resets in 54m · 7d 4%, resets in 5d6h; dollars are API-equivalent (list prices) …; pings stop at 95%`, and `guard auto: refuse once on this 1-hour cache`.
  - Armed: `keepwarm on for 1h00m, a ping 1m after each idle stretch …`.
  - Receipt: `last ping read 38k $0.0… (5h +0%, 7d +0%)`; the terminal capture cut the cost digits.
  - `keepwarm is off` at the end.
  - The organization-login note did not appear (0 matches), so `classic.SessionStart` reaches the mod on this personal login.
- Status: PASS.
- Open: one 38k Haiku ping moved neither window at 0.1-point resolution, so whether forks update the limit readings is undecided. The planned fallback (showing the change across the whole break) was not built.

### G05 attempt 1

- Method: as G04 with `FORCE_PROMPT_CACHING_5M=1`. Haiku read the test file to build the context; then `/cache-tax`, a bare `/keepwarm`, about 6 minutes idle, one short message, `/exit` (`drive/g05.log.plain`).
- Actual:
  - Card: `cache lives 5 minutes (FORCE_PROMPT_CACHING_5M)`, `context 95,621 tokens`.
  - `/keepwarm` was refused: `… lives 5 minutes (FORCE_PROMPT_CACHING_5M), so a ping 50m into a break …`.
  - The send warned: `the prompt cache went cold 2m ago. Sending this re-writes up to 95,621 tokens at $0.125/MTok = $0.01 (a warm turn would have cost $0.00). Sending anyway. This session's cache lives 5 minutes (FORCE_PROMPT_CACHING_5M); "promptCacheTtl" …`.
  - No `last ping read` appeared: no fork was sent.
- Status: PASS.

### Review fixes (T11–T17), 2026-10-30

All runs in the repo root, on 66f982d plus the uncommitted edits. Scratchpad logs live in this session's scratchpad (`g01.log`, `g02b.log`, `g03b.log`, `drive/g04.log.plain`, `drive/g05.log.plain`).

#### Probes before the fixes

- Read-only greps of the 2.1.314 binary for the engine facts listed under Decisions (TTL order, per-model caching off, idle compaction, `modelPricing`, `$.session.model()`).
- A throwaway mod in the scratchpad (`cfgprobe`, with one `userConfig` field, no model call) was run with `claude -p` and in a pty-driven interactive session.
  - Interactive: `$.config.list()` at `session.start` lists the plugin's own row (`cfgprobe.flag`, provider `cfgprobe@inline`, unlocked).
  - Headless `-p`: no plugin rows at all, at start or later.
  - Both: `$.session.model()` answered `claude-opus-5-5`, `$.tool.list()` answered the tool list, and the policy `pluginConfigs` read answered `undefined`.
- Two forms the engine's module scanner refuses, seen as load failures in the first test run and fixed: reading `$.session.identity` as a value (a `typeof` guard), and passing `$` in a call with a spread argument.

#### G01 attempt 3

- `claude plugin validate plugins/cache-tax`: ✔ Validation passed, userConfig included.
- New hook: `command.run{command=effort}`. New calls: `$.tool.list`, and `$.settings.read` via `readLocks`. New env reads: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL`, `DISABLE_PROMPT_CACHING_{FABLE,HAIKU,MYTHOS,OPUS,SONNET}`.
- The only new advisory is "gating hook without .catch" for the observe-only `/effort` hook, like the other observe-only hooks.
- A script confirmed that the README quotes the hooks, calls and env-reads lines verbatim.
- Status: PASS.

#### G02 attempt 2

- `claude plugin test plugins/cache-tax`: 221 pass, 0 fail (`g02b.log`).
- That is the 184 earlier tests, 17 of them updated to the fixed behavior (several renamed), plus 37 new ones.
- Status: PASS.

#### G03 attempt 2

- `npx -p typescript tsc -p plugins/cache-tax` against the 2.1.314 declarations: exit 0. Status: PASS.

#### G09 attempt 2

- A script resolved every relative link and `#anchor` in the plugin README and the repo README: 0 problems.
- `plugin.json`, `hooks.json` and `marketplace.json` parse as JSON.
- Each changed README statement was re-read against `belief()`, `learnFromGap()`, `ping()`, `holdReason()`, `lifetimeGate()`, `readLocks()`/`applyOptions()`, `rollAlways()`, `mayHaveCompacted()` and `ratesOf()`.
- One README sentence on go-aheads was corrected during this review.
- The repo README and `marketplace.json` claim nothing these fixes changed, so they stay as they are.
- Status: PASS.

#### G10 attempt 1

Named passing tests per finding, all in `g02b.log`:

- A1: `A1: a model chosen during a break…`, `A1: a ping after the tool list changed…`, `/cache-tax ttl … wins over what requests showed…`, `a ping that finds the cache gone stops keepwarm; it takes a second such miss…`, `two re-writes … say five minutes; one does not, nor one on another model`.
- A2: `a model switch reports the lifetime of the model it leaves, holds the pings, and is priced at Claude Code's estimate`.
- A3: `A3: an explicit /keepwarm tries pings again…`, `A3: the reply to /keepwarm says when no pings will go…`.
- A4: `A4: a resume does not judge its first request…`.
- A5: three `A5:` tests, plus the `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL` configuration case.
- A6: three `A6:` tests, one per variable.
- A7: two `A7:` tests.
- A8: `A8: /effort during a break…`.
- A9: `A9: the prefix every conversation shares…`, `a read 20 minutes into a break confirms an hour; one 9 minutes in … does not`.
- B1: two `B1:` tests.
- B2: `a ping's receipt is its own usage priced…`, `when something else this session paid for lands during a ping…`.
- C1: two `C1:` tests, `a cold comeback is scored at its first request…`.
- C2: `after an idle compaction this mod did not see…`, `where idle compaction is off, a missing live window still prices the refusal…`. The old live-floor test, whose mock reported 30,000 live tokens after a compaction, is replaced.
- C3: three `C3:` tests.
- D1: five `D1:` tests.
- D2: two `D2:` tests, `where classic.SessionStart arrives too, the old conversation's end … is passed over`.
- D3: `D3: the session starts and the commands register all the same` covers the failing identity call. The version floor itself is a manifest and docs change, checked under G01 and G09.
- E1: two `E1:` tests, `bare /keepwarm and the window after a cold write send no pings; always keeps 30m at one ping per 4m`.
- E2: two `E2:` tests.

Status: PASS.

#### G04 attempt 2

- Method: as attempt 1, with a pty driver in the scratchpad (`drive/drive.py`, steps `drive/g04-steps.json`). The session ran `claude --model claude-haiku-5-5 --plugin-dir plugins/cache-tax --settings '{"enabledPlugins":{"cache-tax@claude-optimization":false}}'`, with one short turn, then `/cache-tax`, `/keepwarm 1h every 1m`, about 85 s, `/keepwarm status`, `/cache-tax`, `/keepwarm off` and `/exit`.
- Card:
  - `cache lives 1 hour (a subscription within its limits)`, context 38,335 tokens.
  - `plan 5h 0%, resets in 5h00m · 7d 16%, resets in 5d 1h; dollars are API-equivalent (list prices), your plan counts these windows; pings stop at 95%`.
- Armed: `keepwarm on for 1h00m, a ping 1m after each idle stretch keeps the cache read, not re-written`.
- Receipt: `last ping read 38k $0.00 (5h +0%, 7d +0% account-wide)`.
- No stop, no re-write line (this single-exchange session's ping read warm), no organization note. `keepwarm is off` at the end.
- Status: PASS.

#### G05 attempt 2

- Method: as attempt 1, with the same pty driver (steps `drive/g05-steps.json`) and `FORCE_PROMPT_CACHING_5M=1`. Haiku read the test file (2,945 lines) to build the context. Then `/cache-tax`, a bare `/keepwarm`, about 6.7 minutes idle, `hi`, `/cache-tax` and `/exit` (`drive/g05.log.plain`).
- Card: `cache lives 5 minutes (FORCE_PROMPT_CACHING_5M)`, context 112,544 tokens, `guard auto: warn only, as this cache lives 5 minutes or is unconfirmed`, 0 cold writes.
- The bare `/keepwarm` was refused and named the variable (A6): `… lives 5 minutes (FORCE_PROMPT_CACHING_5M), so a ping 50m into a break would find it gone and re-send the whole context. Unsetting FORCE_PROMPT_CACHING_5M, with "promptCacheTtl": "1h" in settings, keeps it an hour (its writes cost 2x base input, not 1.25x); for a short break, /keepwarm 30m every 4m.`
- The send warned rather than refused: `the prompt cache went cold 3m ago. Sending this re-writes up to 112,544 tokens at $0.625/MTok = $0.07 (a warm turn would have cost $0.01). Sending anyway. This session's cache lives 5 minutes (FORCE_PROMPT_CACHING_5M); unsetting FORCE_PROMPT_CACHING_5M, with "promptCacheTtl": "1h" in settings, keeps it an hour, …`. The rate is Haiku 5.5's long-prompt 5-minute write, since the context was over 100k.
- After the turn: `cold write of 114k tokens paid ($0.07). Keepwarm stays off: this cache lives 5 minutes …`. The comeback's first request re-wrote the context about 8 minutes after the last request.
- No `last ping read` and no window: no fork was sent.
- Plan usage across G04 and G05: 5h 0% → 1%.
- Status: PASS.

### Verification fixes (T18–T20), 2026-10-30

All runs in the repo root, on 66f982d plus the uncommitted edits. Logs live in this session's scratchpad, `/tmp/claude-1000/-var-home-aicloudopspecial-code-repos-claude-optimization/6586f3bc-6b45-42b2-abe1-ba0da1b18ae9/scratchpad`.

- Engine read for A1 (`engine-onr-inr.txt`, from byte 255175790 of the 2.1.314 binary): `Onr()` returns `prompt_cache_likely_expired: we>=ke`, where `we` is infinite unless `Inr()` holds. `Inr()` holds when the transcript has no compaction, or a response with usage after its last one.
- First run on the edited code (`t1.log`): 219 pass, 2 fail.
  - The writer's "expired means five minutes" resume case failed, as intended.
  - "a longer window is kept, with its testing period reset to 50m" failed because the first draft of the roll note quoted the stretched length (`at least 2d 0h`). The note now quotes the roll's floor.

#### G02 attempt 3

- `claude plugin test plugins/cache-tax`: 228 pass, 0 fail (`t3.log`). The 221 earlier tests became 222, since the two resume-field cases are now three: the live case and two A1 cases. Six tests are new.
- Red check: the same suite on a scratchpad copy holding the writer's pre-fix `register.ts` (the verifier's `a3` copy, byte-identical to it) gives 7 fail (`red-before.log`). Each failure shows a reported symptom:
  - `lives 5 minutes (Claude Code judged it so at resume…)` on a 1-hour subscription;
  - the swap announced, and pings held after the roll;
  - "every session stays warm";
  - `at $4/MTok = $0.50` for 200k tokens;
  - `$14.374999999999998/MTok`.
  - The resume-cold short-period test passes on both copies; it guards the new flag.
- Probe replay: the verifier's sets (v1, v2, v3, v5, v6, ct, sweep, a3), each re-run with the fixed `register.ts` (`replay/*.log`).
  - Pass/fail changed only where intended: sweep A3, v3 K25c, v5 K19b, v5 K22a and K22b, and the writer's replaced resume case.
  - The a3 recheck gives 4 pings in 16 minutes on an unconfirmed lifetime, as on a five-minute cache.
  - Print-only probes changed only in the guard's price (Claude Code's estimate alone: v1 K1-a/b/c, v2 K20-a, K2a-1, K3-A, K3-B) and in v2 K2c. K2c's resume, judged expired 20 minutes on, now reads one hour, and `/cache-tax ttl 1h` states it.
- Status: PASS.

#### G03 attempt 3

- `npx -p typescript tsc -p plugins/cache-tax` against the declarations headed "Written by Claude Code 2.1.314": exit 0 (`tsc.log`). Status: PASS.

#### G01 attempt 4

- `claude plugin validate plugins/cache-tax`: ✔ Validation passed; the only warning is ICON_MISSING (`validate.log`).
- The hooks, calls and env-reads lines are unchanged, and a script found each quoted verbatim in the README.
- Status: PASS.

#### G09 attempt 3

- `links.py` resolved every relative link and `#anchor` in the plugin README and the repo README: 0 problems.
- Each changed README statement was re-read against `rollTo()`, `seedFromResume()`, `lifetimeGate()`, `guardText()`, the clock checks and the `always` reply. The test count reads 228.
- The repo README and `marketplace.json` claim nothing T18 changed.
- Status: PASS.

#### G10 attempt 2

- E1 on an unconfirmed lifetime: `E1: a short window armed for a break keeps its period across a turn, and its reply announces no swap`; `E1: a window armed on a go-ahead rolls as on an hour and keeps the go-ahead, as its reply says`.
- A1, a resume after `/compact`: `A1: a resume judged expired 20 minutes on, as after a /compact, …`; `A1: where nothing else says, a resume judged expired leaves the lifetime unconfirmed, and /cache-tax ttl 1h still states it`.
- The tests G10 attempt 1 named for every other finding pass in `t3.log`.
- Status: PASS.

#### G04 attempt 3

- Method: as attempt 2, with the same pty driver and steps, copied to this session's scratchpad (`drive/`). The session ran `claude --model claude-haiku-5-5 --plugin-dir plugins/cache-tax --settings '{"enabledPlugins":{"cache-tax@claude-optimization":false}}'` in the repo root and finished at 20:28 (`drive/g04.log.plain`). The terminal capture drops some spaces; the quotes below restore them.
- Card: `cache lives 1 hour (a subscription within its limits)`, context 38,334 tokens, and `plan 5h 9%, resets in 2h34m · 7d 18%, resets in 4d 22h; dollars are API-equivalent (list prices), your plan counts these windows; pings stop at 95%`.
- Armed: `keepwarm on for 1h00m, a ping 1m after each idle stretch keeps the cache read, not re-written`.
- Receipt: `last ping read 38k $0.00 (5h +0%, 7d +0% account-wide)`.
- No stop and no organization note; `keepwarm is off` at the end.
- Status: PASS.

#### G05 attempt 3

- Method: as attempt 2, with the same driver and steps and `FORCE_PROMPT_CACHING_5M=1`. Haiku read the test file, now longer, to build the context; then `/cache-tax`, a bare `/keepwarm`, about 6.7 minutes idle, `hi`, `/cache-tax` and `/exit`. Finished at 20:39 (`drive/g05.log.plain`).
- Card: `cache lives 5 minutes (FORCE_PROMPT_CACHING_5M)`, context 116,788 tokens, `guard auto: warn only, as this cache lives 5 minutes or is unconfirmed`, 0 cold writes.
- The bare `/keepwarm` was refused and named the variable: `… lives 5 minutes (FORCE_PROMPT_CACHING_5M), so a ping 50m into a break would find it gone and re-send the whole context. Unsetting FORCE_PROMPT_CACHING_5M, with "promptCacheTtl": "1h" in settings, keeps it an hour (its writes cost 2x base input, not 1.25x); for a short break, /keepwarm 30m every 4m.`
- The send warned rather than refused: `the prompt cache went cold 3m ago. Sending this re-writes up to 116,788 tokens at $0.625/MTok = $0.07 (a warm turn would have cost $0.01). Sending anyway. This session's cache lives 5 minutes (FORCE_PROMPT_CACHING_5M); unsetting FORCE_PROMPT_CACHING_5M, …`. The rate is Haiku 5.5's long-prompt 5-minute write, as printed by `fmtRate()`.
- After the turn: `cold write of 118k tokens paid ($0.07). Keepwarm stays off: this cache lives 5 minutes (FORCE_PROMPT_CACHING_5M).`
- No `last ping read`: no fork was sent.
- Status: PASS.

#### A7, A8, A9 and C1 against the review's own failure scenarios

The verifier checked these four only through the writer's tests, lacking the review text. That text is the user's paste in session `6d4e51da`, saved as `original-review.txt`.

- A7 and A9: the writer's tests use the review's own figures: a 20,365-token shared prefix, a 22,743/11,989 ping after one exchange, and reads 9 and 20 minutes into a break. The code takes the suggested fixes: warm against the last cached prefix, the re-sent first message explained, no lifetime evidence from a first ping, reads measured past the shared prefix, and two sightings for five minutes.
- A8 and C1 probes on a scratchpad copy of the fixed build (`probe-a8c1.log`):
  - A8: two `/effort` re-writes, each 6 minutes after a warm ping, on an auto lifetime. The evidence stays `a ping read the cache 50m into a break, seen 2 times`; a five-minute sighting would have reset that count. Also 0 cold writes, keepwarm on, both pings sent. The probe's expected cache line named the plan default and so "failed"; the outcome is the one wanted.
  - C1: the review's `notes.txt` turn after one exchange, with requests reading 22.7k, 34.8k and 57.2k, gives no cold write, no log and no window. Pass.

### Re-verification on resume, 2026-10-30

A new session (the T18–T20 report pasted after `/clear`) reran the automated gates on the unchanged working tree in the repo root, on 66f982d plus the uncommitted edits. The SHA-256 prefixes are `030dd149` for `register.ts`, `5c2b2459` for `register.test.ts` and `a52cc8ad` for the plugin README. Logs are in `/tmp/claude-1000/-var-home-aicloudopspecial-code-repos-claude-optimization/47e886ff-81e1-454f-a9b9-29a1a07a7610/scratchpad`.

- Inputs: `register.ts` was last written at 20:05 and the tests at 20:08, before G04 attempt 3 (20:28) and G05 attempt 3 (20:39). So the live checks ran on the final code and stay PASS.
- G01 attempt 5: `claude plugin validate plugins/cache-tax` exits 0 with ✔ Validation passed; the only warning is ICON_MISSING (`validate.log`). A script found the hooks, calls and env-reads lines quoted verbatim in the plugin README. Status: PASS.
- G02 attempt 4: `claude plugin test plugins/cache-tax` gives 228 pass, 0 fail (`test.log`). Status: PASS.
- G03 attempt 4: `npx -p typescript tsc -p plugins/cache-tax` exits 0 with no diagnostics (`tsc.log`), against declarations headed "Written by Claude Code 2.1.314" (`claude --version`: 2.1.314). Status: PASS.
- G09 spot check, not a new attempt: a fresh script (`links.py`) resolved 35 relative links and anchors in both READMEs with 0 problems. `plugin.json` (2.4.0), `hooks.json` and `marketplace.json` parse. The `hooks.json` description no longer says `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is needed, which agrees with the plugin README's "current Claude Code ignores it". The statement-by-statement review stands on attempt 3, whose inputs are unchanged.

#### G08 attempt 1

- Approval: the user's "Install, commit and push", 2026-10-30.
- Method: `./install.sh` run twice in the repo root (`install1.log`, `install2.log` in the re-verification scratchpad). `*.bak-*` files under `~/.claude` (depth 2) were listed before and after.
- First run: exit 0. It mirrored `plugins/cache-tax` into `~/.claude/marketplace/cache-tax` and reinstalled `cache-tax@claude-optimization`, keeping its data. It noted that 4 userConfig options are not yet set; all four have defaults in `plugin.json`. It ended with `Verified: … setup is active`.
- Second run: exit 0, every item `Up to date` or `already installed`, with no reinstall. No new `.bak` files.
- After both runs: `claude plugin list` shows `cache-tax@claude-optimization` Version 2.4.0, enabled. `diff -rq` against `plugins/cache-tax` (excluding `types/`) finds no difference.
- Status: PASS.

### G06 attempt 1, 2026-11-03

- Source: a `/cache-tax` card the user pasted from Claude Code in WSL on the work machine (dsn), Enterprise claude.ai login, model `claude-sonnet-5-5`, 47,720 tokens of context. Observed by the user; not run from this workstation. The installed version wasn't shown; the card's wording matches 2.4.0's strings (`register.ts` lines 333, 944, 988).
- Step 2: `hooks` line reads "this mod sees /clear and resume only through session.end here, as a user mod on an organization login or a managed machine; no resume warning. An admin can install it as an organization mod". As expected.
- Step 3: `plan` line reads "no limit windows visible to this mod; dollars at list prices". So an Enterprise seat shows no 5h/7d windows and never gets the subscription default.
- Step 4, first half: `cache` line reads "lifetime not confirmed (no plan limits are visible to this mod, as on a Team or Enterprise login, an API key or a cloud provider)". `guard` reads "auto: warn only"; `keepwarm` off. `/cache-tax ttl 1h` and `/keepwarm 90m` not yet run.
- Step 1 (the `/plugin` guard note), steps 5–7: not run. A note the user pasted alongside mentions "the earlier notice", but its text wasn't seen, so step 1 stays open.
- Status: IN_PROGRESS.

### G06 attempt 2, 2026-11-03

- Method: from the Windows workstation, scripts run with `wsl.exe -d dsn -- bash -l <script>` in `$HOME` (`/home/cloudops`), the Enterprise login. Scripts: `dsn-check.sh`, `dsn-g06.sh`, `dsn-note.sh` in that session's scratchpad. Mod commands sent with `claude -p "/…"`, each a fresh session.
- Install: Claude Code 2.1.317; `cache-tax@claude-optimization` 2.4.0, user scope, enabled, read from `~/.claude/marketplace/cache-tax` (installed 2026-11-03T17:16Z). `diff -rq --strip-trailing-cr` against this repo's `plugins/cache-tax` (excluding `types/`): no content differences; only Windows `:Zone.Identifier` files extra, harmless.
- On dsn: `claude plugin validate .` ✔ Validation passed; `claude plugin test .` 228 pass, 0 fail.
- Step 4: `/cache-tax ttl 1h` → "Now: lives 1 hour (set with /cache-tax ttl)"; `/keepwarm 90m` → "keepwarm on for 1h30m, a ping 50m after each idle stretch …", with no confirmation asked. Card then: `cache lives 1 hour (set with /cache-tax ttl)`, `guard auto: refuse once on this 1-hour cache`. PASS. Restored afterwards: `/keepwarm off`, `/cache-tax ttl auto` → "detects the lifetime again … lifetime not confirmed".
- Step 6: dsn has no `/etc/claude-code`, so no managed cache-tax options and the card has no `options` line. N/A on this machine.
- Step 7: done by the restore above.
- Step 1: `claude plugin list --json` carries no guard note; only the interactive `/plugin` screen shows it. Open.
- Step 5: needs an interactive session idle more than an hour, then `/clear` and a message. Open.
- Status: IN_PROGRESS (steps 1 and 5 open).
- Step 1, follow-up the user pasted from interactive `/plugin` on dsn: the list shows `✔ cache-tax  Plugin  claude-optimization` under User, with no note on the list row. The plugin's detail view is not yet seen.
- Step 1, detail view the user pasted (cache-tax @ claude-optimization, 2.4.0, user scope, Enabled; header "3 mods active · cache-tax, blast-radius, session-usage"): "1 note: Its hooks on classic.SessionStart, classic.PreModelSwitch, classic.PostModelSwitch, session.compact do not run here: where an organization manages Claude Code, these events pass over the plugins you install → Only a plugin that counts as your organization's own runs hooks on these events. An administrator sets that up in managed settings". Matches the checklist and the plugin README's "In an organization". PASS.
- Status after this: IN_PROGRESS; only step 5 is open.

## Decisions and scope changes

- G00: 2.1.314 still gives mods no cache TTL, expiry or overage, so part 1's inference is built as planned. `modelPricing` is read with `{ key: 'modelPricing', source: 'policy' }`, so only the managed value counts, as in the engine.
- Test fixture (deviation from the plan's wording, same intent):
  - The existing tests run on `claude-fable-5-1`. Under part 1's Fable rule, a subscription window alone would leave them "unconfirmed".
  - So `world()` defaults its settings to `promptCacheTtl: "1h"` (the 1-hour cache those tests assumed) and `idleCompaction: false` (they predate idle compaction), instead of a `five_hour` window.
  - `world()`'s env-read counter counts `NO_COLOR` only, so the band test still proves one preference read per session now that the TTL env flags are read too.
- Recovery note: a context reset mid-T02 led to a second copy of the new test suites being appended; the duplicate (which failed to load) was cut, keeping the suite written first.
- userConfig schema confirmed from the 2.1.314 engine: `type`, `title` and `description` are required; `default`, `options` and `min`/`max` are allowed; keys must be identifiers.
- 2026-10-30, review of the uncommitted 2.4.0 work: the user pasted a review (findings A1–A9, B1–B2, C1–C3, D1–D3, E1–E2, each with a suggested fix and a priority order). Taken as the request to fix them, in the baseline's files and with its authorized actions, plus `hooks/hooks.json` for the version floor (D3). Tasks T11–T17 and gate G10 added. G01–G05 and G09 marked STALE: T11–T16 change their inputs.
- Engine facts read from the 2.1.314 binary for these fixes:
  - TTL order `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl`, `ENABLE_PROMPT_CACHING_1H`. `CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL` only turns the messages part to `5m`.
  - Per-model caching off (`jue()`): the Sonnet, Opus and Haiku variables match their family's default model id; Fable and Mythos match the family.
  - Idle compaction only on a 1-hour cache, at 0.9 of the lifetime (54m), from 200k tokens (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, floor 100k).
  - `modelPricing`: the multiplier scales every row, overridden or not. A built-in model id key covers its dated and provider forms; any other key matches one id exactly. A row missing any of its four rates is skipped.
  - The "detail withheld on this connection" strings belong to settings writes over relayed connections. The review's inferred D1 cause is unconfirmed, and its defensive fix is applied anyway.
- `$.session.identity()` arrived in 2.1.299 (changelog). The changelog does not date `session.measure`, `session.end` or `$.settings.read` for mods.
- Where the fixes depart from the review's suggestions, and why:
  - D3: the engine's module scanner refuses `typeof $.session.identity`, so the call sits in a `try` and the floor is raised to 2.1.299 in `plugin.json`, `hooks.json` and the README.
  - D2: the suggestion named `$.session.identity()`, but the session id comes from `$.session.id()`. It is read when the conversation may have changed: at an in-process resume, and at the first command or turn after a `session.end` reset. `session.end` now resets whenever its `sessionId` is the state's own, so ordering against `classic.SessionStart` doesn't matter, and the classic-hooks note shows only for a fresh process.
  - A7: "warm when it reads at least the previous request's cached prefix" is taken as the prefix that request left cached (read plus write, at nine tenths). Comparing against its read alone would call an expired cache warm after a cold turn. The re-sent first message is an explained re-write when the ping read past the shared prefix. "No evidence from the first ping" applies to the first ping after a single exchange, for both lifetimes.
  - A1: a statement (`/cache-tax ttl`, `cacheTtl`) ranks above sightings but below Claude Code's own report for the same model (resume fields, the model-switch TTL), since that is what Claude Code requested.
  - A9: a read counts as an hour only 15 minutes or more into a break, after the review's 8.5-minute sighting on a 5-minute cache.
  - E1: lifetime-aware. On a one-hour cache `always` still stretches windows and resets testing periods, as documented. On a five-minute cache it keeps a running period under five minutes and otherwise opens 30m at 4m.
  - Model and effort changes hold pings until the next message. A tool-list change does not hold, since a deferred-tools list may change without changing the request; a re-write after one is explained and the window goes on.
  - The pre-ping model check compares `$.session.model()` with the model the last request named (`turn.step`), not the model the response reports, which a gateway may spell differently.
  - B2: the limit points are dropped when the session's ledger moved more than 1.5 times the ping's own price plus $0.01.
  - A5: the engine turns Sonnet, Opus and Haiku caching off for the family's default model only; cache-tax stands down for the whole family, the cheaper side to be wrong on. Caching is also seen as off when a 20K+ prompt neither read nor wrote.
- 2026-10-30, verification of the review fixes: the user pasted a re-check, which re-ran tests, typecheck and validate and replayed the review's probes. It found E1 and A1 partly fixed and three smaller faults. Taken as the request to fix them, in the baseline's files and with its authorized actions (T18–T20). G01–G05, G09 and G10 marked STALE: T18 changes their inputs.
  - E1, unconfirmed lifetime: with `always` on, the next turn replaced a running `/keepwarm 30m every 4m` with six hours at 50m, whose pings wait for the lifetime (the review's sweep probe A3: one ping in 16 minutes), and the arming reply announced that swap.
    - The fix follows the review's "don't replace a user-armed window that is still running". On a five-minute or unconfirmed lifetime, a running window at a period under five minutes keeps its period. On an unconfirmed lifetime, a running window armed on a go-ahead rolls as on an hour and keeps the go-ahead.
    - A fresh `always` window on an unconfirmed lifetime still waits for the lifetime, as the approved plan says ("no automatic pings" on 5m or unconfirmed). The five-minute short window from T15 stays the one departure.
  - A1, resume after `/compact`: the engine read from the 2.1.314 binary (`Onr()`, `Inr()`) reports `prompt_cache_likely_expired` when the seconds since the last response reach the lifetime of that response's cache write. It reports a transcript whose last compaction has no response after it as expired at any gap.
    - So an expired report says nothing of the lifetime and no longer ranks as Claude Code's word; a live report 5–60 minutes in still says an hour.
    - The expired report is kept for what it does say: this conversation's cache is cold until its first request.
  - Smaller faults:
    - After a model switch, the guard quoted the table rate beside Claude Code's estimate (`at $4/MTok = $0.50` for 200k tokens). It now gives the estimate alone.
    - `/keepwarm always`, confirmed on an unconfirmed lifetime, replied that every session stays warm. The reply now says only this session's window has the go-ahead.
    - Rates scaled by a managed multiplier printed raw (the review's K22, e.g. `$14.374999999999998/MTok` at 1.15). They now print to six significant figures.
- 2026-11-03, rollback: the user reported that 2.4.0 does not work on Enterprise plans and asked to keep 2.3 and undo the 2.4 changes ("keep cache tax 2.3 and fix it also undo cache 2.4 changes is not working on enterprise plans"). The 2.4.0 commit `6acdd5a` is reversed in every file except this record: `plugins/cache-tax/` again matches the vendored 2.3.0 from `66f982d`, and the marketplace entry and repo README describe 2.3.0. Checks on the Windows workstation: `claude plugin validate plugins/cache-tax` passed; `claude plugin test plugins/cache-tax` 137 pass, 0 fail. Installed by hand, because the workstation has no jq or real python3 and `./install.sh` can't run there: copied `66f982d` into `~/.claude/marketplace/cache-tax`, uninstalled `cache-tax@claude-code-mods` 2.2.1, removed the `claude-code-mods` marketplace, installed `cache-tax@claude-optimization` 2.3.0. `claude plugin list` shows it enabled, and `/cache-tax` printed its card. The work machine (dsn) keeps 2.4.0 until it pulls and reruns `./install.sh`. Open G06 step 5 and G07 are dropped. Record closed as CANCELED.

## Handoff

- Outcome so far:
  - Parts 1–5 implemented (cache-tax 2.4.0).
  - The review's findings A1–A9, B1–B2, C1–C3, D1–D3 and E1–E2 are fixed (T11–T16), each with tests (G10). Departures from the suggested fixes are listed under Decisions.
  - The verification's open items are fixed (T18, T19): E1 on an unconfirmed lifetime, A1's resume after `/compact`, the guard's price after a model switch, the `always` reply after a go-ahead, and rate formatting (K22).
  - Tests (228), typecheck, validate, docs and both live checks (G04, G05) pass on the final files.
- Open gates and blockers:
  - G06 is yours to run on the work login (checklist below).
  - G07 (idle compaction against a ping) needs your go-ahead.
  - G08 passed: 2.4.0 is installed on this workstation. The change is committed and pushed, as approved on 2026-10-30.
- Limitations:
  - Whether forks move the limit readings is undecided (G04: 0.0 points on a 38k Haiku ping).
  - Team/Enterprise behavior, the D1 lock paths included, is proven only in unit tests until G06.
  - The D1 root cause the review inferred is unconfirmed; the fix covers the managed `pluginConfigs` read, non-default values and rows kept from the mod. A lock on a value equal to its default, with all three out of the mod's sight, would still let a stored choice through.
  - Usage-based Enterprise's lifetime is undocumented; cache-tax treats it as unconfirmed.
  - Untested live: a model or effort change before a ping, a tool-list change, and Pro's Fable-on-credits switch (A2), since Max caches every model for an hour.
  - Also untested live: a resume after `/compact` and `always` on an unconfirmed lifetime. Both are covered by unit tests and by the engine code read from the binary.
  - `always` on an unconfirmed lifetime, as on a work login with no windows visible, still sends no pings from its own windows until the lifetime is confirmed (`/cache-tax ttl 1h`) or a window gets a go-ahead. That follows the approved plan.
- G06 checklist, on the work machine after `./install.sh` there:
  1. `/plugin` → cache-tax: a note says its hooks on `classic.SessionStart` (and the model-switch events) and `session.compact` do not run.
  2. Send one message, then `/cache-tax`: the `hooks` line says /clear and resume arrive only through `session.end`.
  3. Note whether the `plan` line lists 5h/7d windows or says no windows are visible. This decides whether a Team seat ever gets the subscription default.
  4. Note the `cache` line: probably `lifetime not confirmed`. Run `/cache-tax ttl 1h`, then `/keepwarm 90m`: it should arm without asking.
  5. Wait more than 1 hour, then `/clear` and send a message: it should go through with no refusal or price warning.
  6. If managed settings set any cache-tax option, the card's `options` line names it as set by your organization, and `/cache-tax guard off` is refused.
  7. `/keepwarm off`, and report the lines from steps 2–4 and 6.
- Exact next action: none; record CANCELED on 2026-11-03 (see the rollback entry under Decisions and scope changes).
