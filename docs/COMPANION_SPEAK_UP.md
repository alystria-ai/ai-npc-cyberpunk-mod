# Companions speak up on their own

Written 2026-10-25 on branch `feat/dynamic-info-speak-up` (feature 4 of the Dynamic info work). Party companions sometimes say one short thing nobody asked for: at random at a calm moment, or after a game dialogue or scene they were present for has ended, commenting on it with the mission and the journal in mind. Johnny Silverhand (in V's head, only V hears him) may follow up on such a line, or on a reply in a conversation V is having, with one brief remark. Who speaks and when is a random schedule on the game side (`mod/speak-up.lua`); no model decides anything on any provider. A line that is going to follow another is written and voiced while the first is still playing and is heard right after it, with no wait for the provider in the gap. Nothing here is stored in conversation memory.

The game half is the first sections, the bridge half is under "Bridge side".

## What the player sees

**Settings > Conversations > Companions speak up** (a list: **Off**, **Speaks up rarely**, **Speaks up normally**, **Speaks up often**; **Rarely** by default, so the feature is on for everyone). **Johnny in your head** has the same three speaking choices after Off and On (**Off**, **On**, **Speaks up rarely**, **Speaks up normally**, **Speaks up often**). The help of both rows says the numbers plainly: Rarely about 2 an hour, Normally about 4, Often about 6, and that when both are on the two rates add up and the two take turns.

| Stored value (`runtime/settings.json`) | Companions (`companionSpeakUp`) | Johnny (`johnnyRemarks`, with `johnnyInHead` true) | Target rate |
|---|---|---|---|
| `off` | Off | Off, or On (he answers the talk keys; no unprompted lines) | none |
| `rare` | Speaks up rarely | Speaks up rarely | 2 an hour |
| `medium` | Speaks up normally | Speaks up normally | 4 an hour |
| `normal` | Speaks up often | Speaks up often | 6 an hour |

`normal` is the name Johnny's "often" has always had in the file, so an older file reads exactly as before; `medium` is the new value for Normally, in both keys. Anything else in `companionSpeakUp` reads as `rare` and is put right once; anything else in `johnnyRemarks` reads as `off`. The housemates feature accepts these level names too (`rare` / `medium` / `normal` next to rarely / normally / often).

**Rarely, Normally and Often are TARGET rates, not caps.** The scheduler (`mod/speak-up.lua`) draws a random gap around `3600 / rate` seconds (0.4 to 1.6 times the mean, the mean kept) and counts only ELIGIBLE play: time in combat, a scene, a call, a menu, a conversation, with V typing or recording, or with a line playing is not counted, so nothing piles up afterwards (an hour of fighting is followed by no burst). "An hour" here is an hour of that calm play, counted in real seconds of the 0.1 s game tick (not game time, which runs faster), the same kind of clock Johnny's old limiter used (`os.time`). With both lists on the rates ADD UP: rare + rare is 4 an hour, normal + normal 8 (Normally twice), often + often 12, rare + often 8. Any two unprompted lines are at least **150 seconds** apart (2.5 minutes; 12 an hour averages one every five minutes). Nobody speaks twice in a row because of the merge: when both could speak, the one who did not speak last goes. Johnny's follow-on to a companion's line or a conversation reply counts towards HIS rate and is exempt from the 150 seconds (it is one exchange).

## What a companion says on her own

Only a party companion that is one of OUR copies and is ready, within 15 m (`companions.conversationCandidates`), never a character another mod spawned, never Johnny, never a game-placed character.

- **(a) At a calm moment (`calm`).** After 20 seconds of calm play with a companion beside V (open gameplay: no combat, scene, dialogue, choice list, call, vehicle or replacer; nothing playing; V not typing or recording and not within 45 seconds of V's last line to anyone), when her turn comes up on the schedule. She says one short thing, from the right-now facts (where V is, the time, who is with V, V's state) and V's tracked quest.
- **(b) After a scene she was in (`scene`).** `mod/game-dialogue.lua` hands every recorded scene line to `convaiSpeakUpScene`; a scene is two or more lines with a companion among those present (the line's `present` list or its speaker). Once the scene has been quiet 2.5 seconds her line is prepared ahead (below), and it is said once it has been quiet 6 seconds and the gates still hold. The request carries the game dialogue (who spoke, what was said, scoped to her by the bridge), the tracked quest and the right-now facts. One try per scene: if another line comes while it is prepared, it is dropped and that scene gets no comment. Needs Dynamic info > Recent game dialogue on.
- **Never** during combat, scenes, dialogue choices, calls, menus or an ongoing conversation; the line is withdrawn (nothing is heard) if any of those starts first, and a line already playing is ended the way a fight reaction is (`convaiSpeakUpManage`: combat, a scene or a blocked sample, V typing or recording, the speaker gone or unavailable). In a vehicle nothing is said (the same rule as the fight reactions).
- **One speaker at a time.** The scheduler's floor (`holder`) is taken when a line is chosen and given back by `cancelAutomatic` (unheard lines do not count against the rate and come back no sooner than 15 seconds); a battle or loot reaction, a conversation and a Johnny remark are all `busy` for it.
- **Not remembered.** Like a battle quip, the line is a reaction: it is in nobody's conversation memory, so a statement, never a question.

## What Johnny does with it

Johnny's rate and the list are unchanged in kind. His queued remarks (a person, a job, a romance, a place, the Relic, a fight; `mod/johnny-remarks.lua`) now compete with the companions' candidate through `sched:pick`, so the arbiter lets only one of them start: he never cuts in on a companion and a companion never starts while he talks. The old per-level gap and hourly count of that module are replaced by the scheduler (`paced = true`); its queue, quiet time, cooldowns and time limits stay. In addition, on his own list (Rarely, Normally or Often) he may FOLLOW UP, "sometimes, not every time" (half the time, and only when his own timer allows it, so it counts towards his rate):

- after a companion's speak-up has finished (`via = 'companion'`), and
- after a reply in a conversation V is having with a named character, once the reply has finished and never in the middle of one (`via = 'talk'`; not a group round, a holocall, an ordinary NPC, an add-on or his own turn).

The scene-end remark he already had ("meeting a named person") stays and goes through the same arbiter. Johnny only speaks to V: his lines never reach a companion's context, memory or history (bridge side below), and the companions never answer him.

**Prepared ahead.** As soon as the whole text of the line that is playing is known (`speech.transcript(...).textComplete`), `convaiSpeakUpPlanFollow` decides (the dice and his timer) and, if yes, builds Johnny's request and writes it to `runtime/group-prefetch.json` as `{kind = 'follow', sourceRequestId, input}`. The bridge writes and voices his line meanwhile and holds it. When the source line has been heard to its end (`speech.lua` calls `speech.onStopped(requestId, 'finished')` at the end of `M.stop`) the companion's floor is released at once (not when her caption has faded), `convaiSpeakUpSubmitFollow` claims the floor for Johnny with `follow = true` and sends the very same request table, and the bridge releases the held line. If anything else happens first the plan is withdrawn (`{}` is written): V sends or opens a line, a source that did not finish normally, a scene, combat, a call or the choice list (`head:refusal`), the setting turned off, the plan older than 120 seconds. A scene line (case b) is the same with `{kind = 'ahead', input}` and no source turn.

## Game side (files)

| File | Role |
|---|---|
| `mod/speak-up.lua` (new, pure) | rates, jittered timers on the eligible clock, `pick`, `claim`, `release`, `followOn` (`during` for a decision taken while the companion still speaks), `external` / `externalAllowed` for other features' exchanges, `reset` |
| `mod/init.lua` (block "Companions and Johnny speak up on their own", globals `convaiSpeakUp*`) | `convaiSpeakUpService` (loads the scheduler while either list is on and unloads it when both are Off), `convaiSpeakUpAdvance` (the clock, once per 0.1 s tick in `updateBattles`), `convaiSpeakUpCompanion` (who and about what), `convaiSpeakUpBuild` / `Submit` / `StartJohnny` / `Offer` / `Manage` (the request, the lease, the line in progress), `convaiSpeakUpPlanFollow` / `PlanTick` / `SubmitFollow` / `Withdraw` (prepared ahead), `convaiSpeakUpScene` (a recorded scene line), `convaiSpeakUpManualSent` (V's own line), `convaiSpeakUpStopped` (the end of a line of speech) and `convaiProactive` |
| `mod/speech.lua` | `M.stop` calls `M.onStopped(requestId, reason)` at its end: the only event the follow-on needs |
| `mod/johnny-remarks.lua` | `paced`: the scheduler does the pacing; `medium` is a level |
| `mod/game-dialogue.lua` | unchanged; its `onRow` callback also feeds `convaiSpeakUpScene` |
| `mod/manager.lua`, `mod/manager-ui.lua` | the `companionSpeakUp` setting and row, `medium` on Johnny's list, the help texts in 15 languages |

**Cost.** Nothing in `onUpdate`. On the existing 0.1 s tick: three settings reads, a handful of comparisons, one `scheduler:tick`, and (only while a line plays and Johnny's list is on) one `speech.transcript` per source line until its text is complete. A recorded scene line is a few table writes. Both lists Off: the scheduler is not loaded, the tick returns after the settings reads, and a scene line returns at its first test. Nothing is hooked: the only new event is the end of a line of speech.

## `convaiProactive` (for the housemates)

`convaiProactive.allow(kind, lines)` answers whether a proactive exchange of `kind` (for example `'house'`) of about `lines` lines may start now: true when nobody holds the floor and 150 seconds of calm play have passed since the last unprompted line ended (and always true while both speak-up lists are Off, when there is nothing to merge with). `convaiProactive.note(kind, lines)` records one: the end of the last line moves to the end of the exchange (about 5 seconds a line) and the companions' timer is drawn again, so the merged pace and the gaps count it. Both never raise. The time-awareness sentence ("You last talked with V last night") also works for a `house` reaction (`reaction.kind = 'house'` in `bridge/last-talk.mjs`: it reads the gap and counts as a talk; the `gameTime` must come with the request's `turnContext`).

## Convai budget

Each line is a provider interaction. On the free shared key all unprompted lines share the one pool of a tenth of the day's turns (10 of 100; `docs/JOHNNY_IN_YOUR_HEAD.md`, Quota), so the free key sees at most about ten of them a day, a line refused by the allowance just stops. At the default (Rarely, 2 an hour) a two-hour session uses about four. A player's own key is not limited by us; its plan's interactions are, and Rarely is the default for that reason.

## Tests

`bridge/speak-up.test.mjs` (the scheduler: each speaker alone at the three rates, the merged pace, the gap, Off for either, ineligible time, the arbiter, the follow-on), `bridge/speak-up-game.test.mjs` (the block of `init.lua` in fengari: a calm line, the rate over ten hours, the arbiter, the follow-on prepared and submitted unchanged, every drop reason, a reply in a conversation, a scene prepared and said or dropped, eligibility, load and unload, `convaiProactive`), `bridge/johnny-remarks.test.mjs` (the wiring pins), plus the bridge files in the table under "Tests" below, `bridge/manager.test.mjs`, `bridge/nsui-manager.test.mjs`, `bridge/mcm-host.test.mjs`, `bridge/settings-file-lua.test.mjs` (the setting) and `bridge/description-fit.test.mjs` / `bridge/nsui-labels.test.mjs` / `bridge/select-labels.test.mjs` (the strings fit in all 16 languages).

## Left for the live test (game side)

1. A save with a companion: Companions speak up at its default (Rarely). Play calmly and open the Settings page: the row is there in both hosts, on Speaks up rarely. After about half an hour of calm play (it is random: 30 minutes on average), the companion says one short line nobody asked for. `probe.log`: `Speak up: companion calm speaker=<key>`.
2. Never in combat, a cutscene, a call, a menu, a dialogue choice, a vehicle, or within 45 seconds of talking to someone. Start one of those just before her line would come: nothing is heard, and `probe.log` shows `Automatic reaction released: <reason>` if a line had already started.
3. Walk through a scene with a companion beside V (a quest conversation): about 3 to 6 seconds after the last line she may comment on it with the mission in mind. `probe.log`: `Speak up: companion scene line prepared`, then `companion scene speaker=<key> (prepared ahead)` and no `prepared line withdrawn` line. A scene that goes on after a pause: `prepared line withdrawn (scene-continued)`.
4. Johnny set to Rarely, Normally or Often as well: after some of her lines, Johnny follows with one remark about it, starting within about half a second of her last word (the stage clock: `runtime/bridge-latency.json` of his turn, `preparation.mode = lookahead`, `readyBeforeClaim = true`). `probe.log`: `Speak up: Johnny follow-on prepared via=companion`, then `Speak up: Johnny follow-on via=companion`. Talk to a companion yourself: sometimes (about every other time he is allowed) Johnny follows her reply; never while you are still talking or typing.
5. Pace: with both on at Normally, about 8 unprompted lines an hour in total, never two within 2.5 minutes (apart from Johnny's follow-on), never two overlapping, never the same speaker twice in a row when both could speak.
6. Set both lists to Off (or Johnny to On): no further unprompted line; `probe.log` has no `Speak up:` lines; nothing new in the perf probe.
7. The default is Rarely for everyone: a fresh `settings.json` has `"companionSpeakUp": "rare"`; Restore defaults puts it back to Rarely.

## Bridge side

Written 2026-10-25. Everything below is offline-verified against a simulated game and simulated providers; what only the game can show is listed under "Left for the live test".

### The three reactions and their wire formats

| What | Request the game writes (`runtime/last-input.json`) | Parser / trigger |
|---|---|---|
| A companion speaks up | the usual private turn of a normal named roster character (`profileKey`, `entity`, `name`, `bodyType`, `requestId`, `generation`, `text` = a placeholder sentence) plus `reaction = {kind = 'speakup', event = 'calm' \| 'scene', facts = {}, expiresAt = <ms, positive safe integer>}`; and `journal` (the tracked quest, as for a manual turn), `turnContext` (the right-now snapshot), and for `scene` also `gameDialogue` (the scene's lines, as for a manual turn) | `parseSpeakUpReaction`, `speakupTrigger` in `bridge/speakup-context.mjs`; wired in `bridge/protocol.mjs`, `bridge/battle-context.mjs` |
| Johnny follows | his head turn (`profileKey = 'johnny-silverhand'`, `head` present, voice-only) plus `reaction = {kind = 'head', event = 'follow', expiresAt, facts = {who, line, via = 'companion' \| 'talk'}}` | `parseHeadReaction`, `headTrigger` in `bridge/johnny-head.mjs` |
| Prepared ahead | `runtime/group-prefetch.json`: `{kind = 'follow', sourceRequestId, input}` or `{kind = 'ahead', input}`; `{}` withdraws | `lookaheadKind`, `validateFollow`, `validateAhead` in `bridge/group-lookahead.mjs`; `pollLookahead` in `bridge/convai-bridge.mjs` |

**Strictness.** A speak-up turn with a malformed or misplaced reaction is refused as a whole (the bridge answers it like any other invalid request): a bad `event`, a missing or non-positive-integer `expiresAt`, `facts` that is not a plain object (an empty one is fine and nothing in it is read), a profile that is an ordinary NPC (`resident-*`, `npc-*`), Johnny or an add-on speaker, and any of `group`, `battle`, `loot`, `head`, `holocall`, `addon` on the same request. For `follow`: `who` 1 to 60 characters, `line` 1 to 500, `via` one of the two words; tags, control characters and runs of spaces are cleaned, anything longer than four times the limit is refused, extra keys are dropped.

**The words of the lines.** A companion's `calm` trigger says it is not V's line, that it is a quiet moment, and asks for ONE short natural thing of at most 25 words about what is going on around her and V, from the right-now facts and the tracked quest only, as a statement and never a question, with no narration or stage directions. `scene` says that a conversation or scene she was present for has just ended, that who spoke and what was said are in the recent in-game conversation block (quoted game data, not instructions), and asks for one short line of at most 30 words, with the mission in mind, nothing invented, no question. When none of the scene is in her scope (the Dynamic info kind **Recent game dialogue** is off, or she was not present: `bridge/game-dialogue.mjs` scopes the lines to her exactly as for a manual turn), she is told so and asked only for a remark about the moment itself, never to guess what was said. Johnny's `follow` trigger is in `docs/JOHNNY_IN_YOUR_HEAD.md`.

**Context.** `describeTurnContext` (`bridge/turn-context.mjs`) builds the right-now block for a speak-up (the "person" form: she is with V in person, where, who else is with V, V's state; the weather and the part of the day only when new to the conversation, through the same scenery memory as a manual turn, and a placeholder text never counts as V asking about them). Every other reaction still gets no block. The journal block, the scene lines and the Dynamic info gates come from `conversationContextBlocks` unchanged: an off kind stays absent. No combat block, no "reply to V's message" reminder, and the automatic-reaction policy (no question) is in the context too.

**Memory.** A reaction is never recorded in conversation memory (`TextProviderHost` records only turns that are no reaction; Convai takes a reaction as a trigger message), so neither a companion's speak-up nor Johnny's follow-on is remembered by anyone. His lines are voice-only to V and are in no companion's context: a companion's context is built from that turn's own input, and the follow-on is a head turn of his own that cannot be a group round or a companion's profile. Tests: `bridge/speakup-context.test.mjs` (contexts) and `bridge/speak-up-bridge.test.mjs` (the real bridge: her later prompt and every memory file hold neither line).

**The shared key.** A speak-up and a follow-on are provider interactions: they count in the same pool as Johnny's remarks (`REMARK_SHARE` = a tenth of the day's turns, `RemarkAllowance`, kinds `head` and `speakup`). A player's own key is never limited. A prepared line that is dropped was still sent to the provider and stays counted.

### Preparing a line ahead

The group look-ahead (`docs/GROUP_VOICE.md`, "Look-ahead") already holds a turn that the game will submit later: the bridge runs it now, buffers its text and audio away from the game, and releases it when the game submits the **identical** turn (`turnKey`: request id, generation, entity, name, body type, profile, text, group, journal, battle, reaction, game dialogue). Two more kinds use it.

- **`follow`**: Johnny's remark on a line that is still playing. The game publishes it as soon as the source's complete text is known. The bridge checks that the source turn is the one named by `sourceRequestId`, a private turn of anyone but Johnny (a companion's own speak-up, or a normal reply in a conversation V is having), that its complete text equals `facts.line` (both cleaned the same way) and its name `facts.who`, that `via` agrees (`companion` for a speak-up, `talk` for a reply to V), that the follow-on is a later request than the source (`requestId` differs, `generation` greater) and has not expired. Any mismatch and the command is never started.
- **`ahead`**: a companion's after-scene line. There is no source turn of ours (the scene is game audio): the command is `{kind = 'ahead', input}` with a `speakup` reaction of event `scene`, a named non-ambient profile, no group.

**Order of events the game must follow** (what `bridge/speak-up-fixture.mjs` does, and what the tests run):

1. The source line is submitted as usual (a speak-up with its lease, or a normal reply). `lease` here is `runtime/reaction-lease.json`, refreshed as for any reaction.
2. When the source's complete text is known (`runtime/continuous-speech.json` `textComplete`, or the text of `reply.json`), the game writes `runtime/group-prefetch.json`: `{"kind": "follow", "sourceRequestId": <the source's requestId>, "input": <the request table>}`. For an after-scene line it writes `{"kind": "ahead", "input": ...}` while the scene's last line plays. The bridge starts the line at once, held back from the game.
3. The game does NOT withdraw the command before submitting. `{}` withdraws: it drops a held line at once, and is for the case that the game itself decides not to say it (a scene, a fight, a call, a menu started).
4. When the source has been heard (or the scene is over), the game writes the reaction lease for the new request and then the request itself (`last-input.json`): **the same table that was published**, field for field (its `requestId`, `generation`, `reaction` including `expiresAt`, `journal`, `gameDialogue`: they are part of the identity; `turnContext`, `head` and the knowledge snapshots are not). The bridge verifies the lease, claims the held turn, and the line plays with no provider wait left in front of it. If the game submits before the held line is ready, it plays as soon as it is.
5. After the claim the game may clear the command file (`{}`); that is harmless, but before the claim it kills the line.
6. `expiresAt` of a prepared request must cover the wait: the lease check at the claim refuses a reaction whose deadline has passed when its playback has not begun, so set it to the source's remaining playback plus about 30 seconds (the bridge holds a prepared line for 90 seconds at most).

**What drops a held line** (it then publishes nothing; the game's own submission, if it comes, runs as an ordinary request):

| Event | How |
|---|---|
| V starts talking or typing: the text box or the voice key opens (a new hint in `runtime/conversation-prewarm.json`), a recording runs | `vEngaged`, checked every poll while a line is held, and before one is started; an old hint of V's last line is not new |
| any request of V's (or anything that is not the identical turn) arrives | `GroupLookahead.claim` mismatch, at the moment the request is read |
| the source turn is cancelled, replaced, or its lease withdrawn | `GroupLookahead.watchSource`, after a 1.5 s grace (the game's own submission also ends the source, so a source seen gone at that instant is the claim in progress) |
| the game withdraws the command (`{}`), or the command is replaced | `dropPrefetch` / `offer` |
| a scene, a fight, a call starts | the game's rule: it withdraws the command (the bridge has no view of them) |
| 90 s without a claim | `PREPARED_HOLD_MS` (a group speaker keeps its 150 s) |
| the plan or provider no longer allows it | checked every poll |

**Who may prepare.** `lookaheadAllowed({kind})`: on Convai the rule of the group look-ahead (the shared key, or a player's own key on a confirmed paid plan with two or more connections; a free single-connection key keeps the serial path and the command file is not even read). The text providers (Mistral, Local AI, Custom) are allowed for these two kinds, which they are not for a group round, because a prepared line there is the lowest-priority work:

- **Mistral**: the request goes through the account's scheduler at its `BACKGROUND` priority, so a turn of V's on the same account is served first.
- **Local AI** (`bridge/local-llm-server.mjs`): the model has ONE slot (`-np 1`), so a line prepared beside anything else would stand in front of V's turn. It is sent as `prepared` work (`LocalLlmServer.preparedRefusal`, `begin({background, raise, cancel})`, `localRoute.connect({prepared})`): it never loads the model, never starts while a turn, a persona warm-up, a summary or any other request holds the slot (`'busy'`, refused without a request, not counted as a failed turn or a stall), needs no quiet time after the turn that just ended (a summary waits 10 s), runs the server at normal priority like a turn, and is registered like a summary so that any real turn stops it through `preempt()` at once. Its request is also aborted by the bridge itself when the held turn is cancelled. Verified against the fake llama-server: the server sees the client go away (`aborted`), V's turn beside a prepared one is answered at its normal latency, and the refused prepared line sends nothing (`bridge/speak-up-local-ai.test.mjs`). Not verifiable offline: that the real llama-server stops decoding a request whose client has disconnected (it is upstream behaviour for streamed requests; the bridge relies on it as it does for every aborted turn).
- **Custom**: a request to the saved endpoint; the abort closes the connection (verified against a simulated server in `bridge/speak-up-bridge.test.mjs`).

**A cost to know of (Local AI).** The server keeps the prompt of the last request in its slot. A prepared line for Johnny puts his persona prompt there, so if V then talks to the companion who just spoke, her first turn reads her persona again (the same displacement Johnny's follow-on causes when it is spoken, only earlier, and not at all if the line is never prepared). The composer opening already asks for a persona warm-up for the character V looks at, and a prepared line is dropped the moment the box opens, so the warm-up finds the model free; but on a slow machine the first turn after a dropped prepared line can be slower. If that turns out to matter in the live test, the one place to switch Local AI off for prepared lines is `lookaheadAllowed` in `bridge/group-lookahead.mjs`.

### Measured silence

`node scripts/Measure-GroupGap.mjs --follow ...` runs the real bridge against `bridge/speak-up-fixture.mjs` (a simulated game and simulated providers; the stage log of the simulated Convai speech provider gives each character's `play-start` and `play-end`). **These are SIMULATED provider timings, not live measurements.** The figure is the silence between the last audio of the line that plays and the first audio of the line that follows it.

Run on 2026-10-25, three rounds each, medians (milliseconds), Windows, a quiet machine; the shared Convai key; `submitDelayMs` 150 (the game's own tick before it submits the follow-on) is inside every prepared figure, so the floor of the prepared column is about 150 ms plus the game loop's 50 ms step and the bridge's hand-over.

| Scenario (command) | Serial (no preparation) | Prepared | Provider timings used |
|---|---|---|---|
| Johnny after a companion's speak-up, Convai (`--what speakup`) | 1988 | 354 | the fixture defaults (text 1.4 s, first audio 1.5 s after the request) |
| the same with the live round's delays (`--what speakup --live-timings`) | 7576 | 515 | connection 3.5 s, text 2.6 s later, first audio 3.5 s after the request (`LIVE_TIMINGS` of 2026-10-17) |
| Johnny after a reply to V (`--what talk`) | 2044 | 504 | fixture defaults |
| a companion's after-scene line (`--what scene`; the silence is from the end of the scene) | 1918 | 396 | fixture defaults |
| Johnny after a speak-up, text route (`--what speakup --route text`) | 1252 | 217 | a simulated model server, first token 700 ms; the figure is the time until the game has the line, **the voice's own start-up (Pocket, Voxtral) is not modelled** |
| after-scene line, text route (`--what scene --route text`) | 1567 | 391 | the same |

What this shows and what it does not. Preparation removes the whole provider request from the silence (Convai live-shaped: 7.6 s down to about half a second); what is left is the game's tick and the file hand-over. It does not show what a live Convai connection, Mistral, the local model or Pocket would do: the delays are simulated, and for a prepared line on a cold Convai connection for Johnny (his page is not opened ahead; a source line shorter than the connection plus the reply leaves some wait) the live figure is for the live test. On the text route the real serial silence is longer than shown, because the voice cannot start before the text is published; the prepared line has had its voice rendered into memory by then (Pocket's `BufferedPcm`, the same path the group look-ahead uses), which this fixture, with no audio device, cannot show.

### Tests

| File | What it pins |
|---|---|
| `bridge/speakup-context.test.mjs` | the parsers (both reactions, hostile values, ambient / add-on / Johnny refused), the triggers (no question, word limits, data quoting), the context (right-now block, journal, scene scoping, Dynamic info gates), the follow-on is in no companion's context |
| `bridge/speak-up-lookahead.test.mjs` | `validateFollow` / `validateAhead` (every refusal), the gate matrix, the 90 s hold, the source watch, the shared key's one pool |
| `bridge/speak-up-local-ai.test.mjs` | the Local AI server and route (refusals, stop by a turn, no model load, priority), the host (really aborted, no memory, V's turn not delayed), Mistral's background priority |
| `bridge/speak-up-bridge.test.mjs` | the real bridge: prepared before the source ends, published only after the game submits, dropped by V's request / the text box / a cancelled source / a withdrawal / the hold, mismatches never started, the after-scene line, who may prepare on Convai, the text provider route |

### Left for the live test

1. A companion's speak-up followed by Johnny with the shared key or a paid plan: Johnny's remark starts within about half a second of the companion's last word (probe.log / the stage clock: `preparation.mode = lookahead`, `readyBeforeClaim = true` in `runtime/bridge-latency.json`).
2. The same on Local AI: no stutter in the game while the line is prepared, and V's own turn typed or spoken during the preparation is answered at its usual latency.
3. Opening the text box while a companion speaks and Johnny's follow-on is held: nothing of him is heard.
4. Whether the real llama-server stops decoding at once when its client goes away (the log's `[LocalTurn]` line of the turn after a dropped prepared line shows the wait before it was sent: `waited 0 ms ... nothing else on the server`).
