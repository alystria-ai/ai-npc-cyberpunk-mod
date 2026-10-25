# Companions speak up on their own

Written 2026-10-25 on branch `feat/dynamic-info-speak-up` (feature 4 of the Dynamic info work). Party companions sometimes say one short thing nobody asked for: at random at a calm moment, or after a game dialogue or scene they were present for has ended, commenting on it with the mission and the journal in mind. Johnny Silverhand (in V's head, only V hears him) may follow up on such a line, or on a reply in a conversation V is having, with one brief remark. Who speaks and when is a random schedule on the game side (`mod/speak-up.lua`); no model decides anything on any provider. A line that is going to follow another is written and voiced while the first is still playing and is heard right after it, with no wait for the provider in the gap. Nothing here is stored in conversation memory.

This file has the bridge half under "Bridge side". The game half (the scheduler, the arbiter, the settings and the Lua wiring) is added by the game side's author.

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
