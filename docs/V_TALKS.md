# V talks on their own

Written 2026-10-19 on branch `v-talks` (from `main` 120bc54f). Built, unit-tested, not merged, not installed, not seen in the game.

## The request

A player on Nexus (chiefertain, 2026-10-19): "Would it be possible to make V reply automatically instead of having to type or talk? ... not infinitely but rather from time to time have small conversations or after something intense has happened. For example if V had their own AI instance just like the NPCs you interact with."

## What a player gets

Settings > Conversations > **V talks on their own** (right under Johnny speaks up): **Off** (the default), **Rare** or **Normal**. With it on, now and then V starts a short exchange with a companion in the party and the companion answers, without the player typing or talking. It happens mostly after something intense (a fight that counted, a main or side job finished) and now and then on a quiet walk or ride. An exchange is two lines (V, the companion) or four (V, the companion, V, the companion again).

It needs **V's voice for typed lines** (Settings > Voices, on by default): V's lines are spoken in V's voice and shown as V's subtitle, the way a typed line is. With that setting off the feature stays silent; it never falls back to text-only chatter.

## The defaults the design chose (all changeable: each is one constant in `mod/v-talks.lua` or `bridge/v-talks.mjs`)

| Question | Default | Where to change it |
|---|---|---|
| When | After a fight that counted (20 s or longer) or a main or side job finished; on a calm walk or ride after a quiet spell (10 min at Normal, 20 min at Rare, plus a random share of up to half again) during which V really travelled 40 m or more. Gigs and NCPD hustles do not count | `FIGHT_MIN_SECONDS`, `CALM_SECONDS`, `CALM_JITTER`, `CALM_MOVED`, `QUIET_SECONDS`, `TTL` |
| Who | Only a companion in the party (a copy invited through the Companion Manager) within 12 m of V who can speak. Not a story character, a passer-by, a character another mod spawned, Johnny in V's head or an add-on voice. After a fight a witness is preferred; the companion who spoke last is not chosen twice when another can | `SPEAKER_RANGE`, `pickSpeaker` |
| How long | Two lines in most exchanges, four in about four in ten | `LONG_CHANCE` |
| V's voice | The existing V voice for typed lines (`docs/V_VOICE.md`), male or female by V's voice tone; the engine is the player's V voice engine (Pocket or Voxtral) | the V voice settings |
| Rate | Rare: at most 2 an hour, at least 15 minutes apart. Normal: at most 6 an hour, at least 5 minutes apart. The same trigger never starts two exchanges in a row (see "Triggers" below) | `LEVELS`, `REPEAT_SECONDS` |
| Cost | Every companion answer is one turn of the day on the free shared Convai key, counted in Johnny's remark share (`REMARK_SHARE`, a tenth of the day's limit, 10 of 100). Mistral, Local AI and a player's own key are not capped beyond the rate limits | `isRemark` in `bridge/shared-key-guard.mjs` |

## V's personality, and why the lines are written, not generated

V's lines come from a reviewed bank in `mod/v-talks.lua` (`M.LINES`), not from a model. Reasons:

- The shared free Convai key has no V character. A V written by a model would need a second model turn per line, and on Convai there is nothing to ask. A bank costs nothing and works the same on every provider.
- **V never states anything the knowledge rules do not support.** No line names a person, a place, a quest outcome, a choice V made, V's health, Johnny or the Relic; no line says a fight was won or a job went well or badly. `bridge/v-talks.test.mjs` scans the whole bank for these (names, victory and death words, decisions, romance, Johnny, the Relic) and for length and shape, so an edit that breaks the rule fails the tests.
- The persona the bank is written to: V is dry, quick and a little wry, loyal underneath, speaks in short sentences, asks short practical questions, never gushes and never lectures. The lines are neutral in gender (the voice clip carries the gender) and in tone.
- **From the save:** the lifepath (Street Kid, Nomad or Corpo, read once per save by `mod/turn-context.lua`) colours only the calm walk and ride lines, and only with what the lifepath itself fixes (open sky for a Nomad, streets one grew up on for a Street Kid, offices and glass for a Corpo). A finished job's title is used in quotes when it is short and plain, and never otherwise. Everything else V says is true of any V.
- The companion's answer is a real turn: one line of at most 25 words from the companion's own profile, memory of V and knowledge, told only V's line, one sentence about the moment and the limits. It never asks a question, never claims an outcome, an injury, a kill or a choice V made, never claims to do something in the game. The exchange is not written to the companion's conversation memory (a reaction never is), so a V line cannot become a stored fact.
- Possible later step, not built: with Mistral or Local AI a model could write V's second line from the companion's answer. The bank's follow-up lines ("Mm. Noted.", "Fair. Moving on.") are deliberately the kind that fit any answer.

## Triggers and rate limits (how it works)

All of it is policy in `mod/v-talks.lua` (pure), driven from `mod/init.lua` on ticks that already exist. Nothing is per frame.

**Events.**

| Trigger | Source | Notes |
|---|---|---|
| `fight` | the encounter state of `mod/battle-reactions.lua` (`battles.status()` and `capture()`), looked at on the existing 0.5 s observer sample | one event per ended encounter, only if it lasted 20 s or more; waits 8 s after the end, expires after 90 s |
| `job` | `journalHistory.onFinished` (the history scan that already runs), the same callback Johnny speaks up uses | a main or side job finished or failed; waits 15 s, expires after 240 s; the same job is not talked about again for an hour |
| `walk`, `ride` | no event: a calm spell tracked on the 0.5 s sample (open gameplay: no scene tier 3 or above, no call, no quest conversation, no fight). The spell must last 10 min (Normal) or 20 min (Rare) plus up to 50 percent more, and V must have moved 40 m or more since it began (two position reads per spell). V in a vehicle makes it a ride | a broken spell starts over; standing still ends the spell without a talk |

**Rate.** Normal: at least 5 minutes between the starts of two exchanges, at most 6 an hour. Rare: 15 minutes, 2 an hour. An exchange takes one slot however many lines it has. A first part nobody heard (refused, failed, cut before a word) gives its slot back and does not count as the last trigger.

**Never two in a row with the same trigger.** The trigger is `fight`, `job`, `walk` or `ride` (a walk and a ride are two). The rule holds for half an hour (`REPEAT_SECONDS`): a second fight talk 8 minutes after the first is refused, one an hour later is not. Without the half hour, a player who only walks would get one calm talk per session; the strict reading ("never, until another trigger happens") is `REPEAT_SECONDS = math.huge`.

**Never while** (checked at the start, again every 0.1 s tick while a step is in flight, and fresh when a reply is about to be heard):

- a scene at tier 3 or above, a quest conversation or dialogue choice (while the tier is unknown), a phone call, V replaced by someone else, a fight in progress (`M.busy`, the rule of Johnny in V's head, except that a vehicle is fine);
- V types (the composer is open), talks or records (microphone), a group round or a phone chat is running;
- a game line was shown in the last 10 s (`convaiGameDialogue.lines`);
- any other automatic reaction (a battle line, a pickup comment, a Johnny remark) is the current turn, or ended less than 15 s ago;
- a reply or subtitle is playing or pending;
- V's voice for typed lines is off, or both voice playback and subtitles are off (automatic turns stay silent then);
- the bridge answered that V's line cannot be spoken (`vtalk-silent`): no new exchange for 10 minutes.

**One exchange.** The tick offers the due event (`offer`), picks the companion (`pickSpeaker`), chooses V's line (`line`), and starts an automatic turn: a request with `reaction = {kind = 'vtalk', exchange, step, steps, event, facts, expiresAt}` whose `text` is V's line, to the companion, through the same reply owner, lease (`runtime/reaction-lease.json`), cancellation and delivery gates as battle and loot reactions. V's subtitle shows at once (`subtitles.showTyped`). When the companion's answer has played to its end, an exchange with a second part waits 2 s and sends the second request to the same companion (V's follow-up line; the companion is told the first part's lines as reported words, the wording group rounds use for earlier speakers). If anything else spoke in between, or the first part was cut, or 25 s passed, the exchange is over.

**Bridge.** `bridge/v-talks.mjs`: `parseVTalkReaction` (a named roster companion, a plain line of at most 240 characters, an exchange id, step 1 or 2, facts validated, never a group round), `vTalkTrigger` (the words the companion is told), `VTalkLedger` (the lines of an exchange between its parts, in memory, a few at a time, five minutes). In `bridge/convai-bridge.mjs` `runInput`, for a `vtalk` step: the shared-key allowance is asked first (`hostGuard.check`, on Convai only), then V's line is started as a **required** line (`VVoice.start`, `VLine` with `required`: the companion's answer waits for it, up to 6 s, instead of V being dropped to spare the reply). If V's line cannot be spoken (no voice ready, no clip, another language, a Voxtral limit, or the second part's lines are gone after a restart) the step ends at once with `errorCode: 'vtalk-silent'`, no model request, no notice; the game side takes V's subtitle down, gives the slot back and mutes the feature for 10 minutes. After the answer the ledger keeps the lines for the second part. Both V's line and the answer go through the existing speech, subtitle and face paths unchanged.

## Cost: FPS and latency

- **Setting off:** nothing is loaded (`mod/v-talks.lua` is never read). One settings read per 0.5 s observer sample (`convaiVTalkSample`, inside the existing sample) and one nil check on the 0.1 s tick; the journal callback does one settings read when a job finishes. The bridge does nothing.
- **Setting on:** nothing per frame, no new hook, no new native read per tick. Per 0.5 s sample: a table read of the observer's own sample and, once per sample, the encounter status. Per 0.1 s tick with nothing queued: `service:active` (a few comparisons). A calm talk reads V's position twice per spell. A started step costs what a battle reaction costs, plus one `convaiTurnContext:capture()` (the same on-demand read a typed turn does) for V's gender and the dialogue volume.
- **Latency:** V's line starts at the top of `runInput`, beside the companion's request, exactly as a typed line (`docs/V_VOICE.md`); the companion's answer waits for it only up to 6 s. The stage clock (`bridge/turn-clock.mjs`) measures both as for a typed turn.

## Which package each change lands in

| Package | Files |
|---|---|
| **Scripts** (Lua in the CET folder) | `mod/v-talks.lua` (new), `mod/init.lua` (service, sample, tick, delivery check, release, wrapper of the journal callback), `mod/manager.lua` (`vTalks`), `mod/mcm.lua` (the row and its apply), `mod/locales/*.lua` (3 strings x 15 languages), `packaging/release-plan.json` and `scripts/development-files.json` (ship and dev-install `v-talks.lua`) |
| **Runtime** (the bridge) | `bridge/v-talks.mjs` (new), `bridge/protocol.mjs`, `bridge/battle-context.mjs`, `bridge/shared-key-guard.mjs`, `bridge/v-voice.mjs`, `bridge/convai-bridge.mjs`, `bridge/text-provider-host.mjs`, `bridge/mistral-prompt.mjs`, `packaging/release-plan.json` and `packaging/runtime-layout.mjs` (the new module in the runtime list) |
| Not shipped | `localization/en.json` (developer catalog, regenerated), `bridge/*.test.mjs`, this document |

A Scripts-only install shows the setting but nothing answers it (an older bridge does not know the request kind, so V's subtitle shows and the step expires after 60 s); a Runtime-only install is inert (no request is ever sent). Install both. No archive, no redscript, no game restart: a CET reload and a bridge restart.

## Tests

`bridge/v-talks.test.mjs` (27 tests): the bank's safety scan; the events; the gate; the speaker; the rate at Normal and Rare, Off, expiry and the queue's bound, the repeat rule, the calm spell; the exchange's two lengths and its end; V's line choice (no repeat among the last eight, lifepath, titles); `init.lua` run for real against stubs (the loader, Off, V's voice off, a fight to a two-line exchange, a four-line exchange, every gate, every release, a calm ride and walk, the mute); the wiring text; the bridge's parser, trigger, ledger and the text providers' header; V's required line (held up to its deadline, dropped after); the bridge's order (allowance, then V, then the model); the shared key's one cap for Johnny's remarks and these exchanges together; shipping and the 15 translations. `bridge/manager.test.mjs` has the setting's test; `bridge/startup-lua-fixture.mjs` lists the new default.

## Live checks owed

Needs the Scripts install (all committed `mod/` files, including the new `mod/v-talks.lua`, and the `.json` data), the Runtime (bridge) from this branch, a CET reload and a bridge restart. A save with at least one companion in the party, V's voice for typed lines on (the default) and the V reference clips present. With the free shared Convai key unless a step says otherwise.

1. **Off:** the default. Nothing below happens; `probe.log` has no `V talks on their own` line.
2. **The setting:** Settings > Conversations has **V talks on their own** right under Johnny speaks up, Off, with Rare and Normal. Set Normal and Apply; look at one other language for cut-off text.
3. **After a fight:** with Normal, fight for 30 seconds or more with a companion beside you and win or lose. About 8 to 15 seconds after the last shot (and after any battle reaction line), V says a short line in V's voice (male or female V as in your game), shown as V's subtitle, and the companion answers in one short line, in their own voice and face. `probe.log`: `V talks on their own: noted fight:battle-N`, then `V talks on their own: fight part 1 of 1 speaker=<profile>`; the bridge log: `[VVoice] ... result=played` for V's line. Nothing in the exchange claims who won.
4. **Four lines:** over several fights, some exchanges continue: about 2 seconds after the companion's answer V says a second short line ("Mm. Noted."-like), and the companion answers it, referring to the first part. `part 2 of 2` in the log.
5. **After a job:** finish a main or side job; within a minute or so of the journal update (the history scan) V says a line, some with the job's title in quotes. A gig or NCPD hustle gives nothing.
6. **Calm walk and ride:** walk or drive with a companion for 10 to 15 minutes at Normal with nothing happening: one calm exchange; a Nomad, Street Kid or Corpo V sometimes gets a line about open sky, the streets or glass. Standing still for that long gives nothing. In a car it is a ride line, the companion answers from their seat.
7. **The rate:** at Normal never two exchanges less than 5 minutes apart and at most 6 an hour; at Rare 15 minutes and 2 an hour. Two fights in a row within half an hour: only the first gets a talk. `Automatic reaction released: ...` in the log for any refusal.
8. **Never during:** open the text box, hold the voice key, start a phone call, enter a scene or a quest conversation, start a fight, or be mid-battle-reaction: nothing starts; if one is running, V's line and the answer stop (`Automatic reaction released: vtalk-<reason>`). Within 10 seconds of a game line nothing starts.
9. **V's voice off:** turn **V's voice for typed lines** off and Apply: V stays silent (`V talks on their own` lines stop); turn it back on and it resumes without a reload.
10. **Voice cannot speak:** with V's engine on Voxtral and no Mistral key (or another language with Multilingual conversations): one `[VTalks] ... not started` line in the bridge log, no model request, no notice, V's subtitle disappears at once, and no further attempt for 10 minutes.
11. **Shared key:** each companion answer lowers "x of y left today" by one; after 10 turns of Johnny's remarks and these exchanges together in a day the next ones stop silently while V's own talk goes on. With Mistral or Local AI the count does not move.
12. **FPS and latency:** the perf probe shows no new per-frame row with the setting on; `runtime/bridge-latency.json` for an exchange step is in line with a battle reaction on the same provider.
13. **Order of voices:** V's line is heard first, then the companion's answer; they never overlap. If V's line is not audible within 6 seconds the answer plays alone (`reason=too-slow` in the V log line).

## Open questions for the user

1. **Strict "never two in a row".** Half an hour (the default, recommended) or forever until another trigger happens.
2. **Calm talks at all.** On (the default) or only after fights and jobs.
3. **A longer bank, or a model-written V.** Later, with Mistral or Local AI only: V's second line written by the model from the companion's answer, with the same persona and the same bans. Not built. The bank has 57 lines (10 after a fight, 6 to 8 after a job, 10 to 12 on a walk, 6 to 7 in a ride, 8 follow-ups); a line is not repeated within V's last eight, and the companion's answer is new every time.
4. **Nexus page.** One sentence for the main page once this ships; not added to `docs/NEXUS_PAGE.md` yet.
