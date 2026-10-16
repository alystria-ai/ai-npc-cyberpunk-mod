# Group voice

## Controls

Assign any suitable key or chord to **AI NPC Cyberpunk Mod: group voice chat** in
CET. Press it to begin, wait for Listening, speak, then press that same shortcut
again to finish. **Talk by voice** is the separate private action. The wrong
mode's shortcut cannot submit or redirect an ongoing capture; the hint names
the action that started it. Capture auto-finishes
after 30 seconds. Opening a menu cancels it, including paused frames with zero
simulation delta. Starting a conversation never silently enables the microphone.

Registered actions do not assign or rewrite a player's CET bindings. Action IDs
stay stable so existing choices survive updates. Bind an unassigned action in
CET when choosing to test microphone input. Runtime hints read CET's `IsBound`
and `GetBind` on demand, so changed keys and modifier chords are reflected
immediately. Missing APIs or unbound actions fall back to the action name.
No runtime hint assumes a function key. The optional local development setup recommends keys and preserves any
existing assignments; it is not automatic mod initialization.

## One captured utterance, one ordered group round

- Private/group text and voice share target resolution. The addressed supported character goes
  first. Group mode requires at least two distinct enabled profiles and selects
  at most three. Duplicate copies do not produce duplicate speakers. A looked-at
  unsupported NPC is reported rather than silently replaced by another person.
- Starting group voice freezes the participating entities/profiles and follow-up setting.
  The first request contains microphone input and its group context. Finish
  refreshes quest/battle/world facts without changing the captured audience or
  player identity. Only the last remaining scheduled speaker may ask a follow-up
  when the captured option is On.
- Convai generates the primary response directly from microphone input. That
  response is played once; it is not regenerated as a text request.
- The SDK's recognized user transcription is returned as optional `userText`
  in `reply.json`. SDK 1.7.0 emits finalized STT segments into `user-transcription`
  chat rows while they accumulate, then may replace them with a consolidated
  `isStreaming:false` row. The latter is preferred. Interim STT events, old
  message IDs, bot text and text-chat prompts cannot become V's recognized speech.
- After actual first playback, later speakers use this same recognized text,
  the delivered group history and the existing group prefetch/delivery rules.
  Missing/invalid transcription or first-turn errors cancel later speakers.
  The first audible reply may still be shown when no transcript was returned.
- The transcript is whitespace/control normalized and bounded to 1,200 UTF-16
  units without splitting a surrogate pair. Lua validates its UTF-8 and matching
  limit before continuing. No extra cloud turn is sent to invent a transcript.
- Lost primary, save/world changes, explicit cancellation and recording errors
  retire the owner. A late callback cannot resurrect that group round. Other
  participants may leave and are skipped by the existing live audience checks.
- Text and voice rounds keep each admitted actor's entity and conversation
  profile together. Reassigning, dismissing or disabling the current speaker
  cancels that round's pending reply and owned playback. A changed later
  participant is skipped; the remaining audience and prepared next turn are
  refreshed without substituting the new profile into the old round.

Duplicate copies of one profile are one speaker. The copy V addresses (looks at,
or the nearest when none is targeted) is the one that speaks, wherever its
duplicate stands. Dismissing or reassigning the copy that is waiting or speaking
ends the round even when another copy of that profile remains; the duplicate
never takes over the turn. Changes to a silent duplicate do not affect the round.

## Look-ahead: the next speaker is generated while the previous one talks

Before October 5, 2026 every speaker change paid a whole new request. Lua submits
speaker N+1 only after N has been heard (`group-chat.lua` stage `next`), so the bridge
started that request after N's last sample: about 2-3 s on Convai speech (3.0 s mean in
five live measurements) and 3-6 s on Omni. `group-prefetch.mjs` did not help: its
text-preparation cache was disconnected from the bridge when identified player memory was
added (a speculative turn can not be rolled back), and the prediction file only warmed the
next character's connection, after N had already ended.

Now `bridge/group-lookahead.mjs` runs the predicted turn early, through the normal
pipeline, and holds it back from the game:

1. When N's complete reply text is known, Lua already publishes the turn it will submit for
   N+1 (`group-prefetch.json`: heard context includes N's text; cleared with `{}` whenever
   the audience, delivery or round changes). The bridge validates it against N's live
   reply (same round, audience and order, N's text as the last heard line, N's request
   file still current) and starts it. No Lua change is needed.
2. The held turn does everything a submitted turn does (world/memory admission, the
   speaker's own session and group audience, Convai request), but nothing reaches the
   game files, so there is still exactly one speech owner, one set of subtitles and one
   voice at a time:
   - Convai speech: the character's own page receives the stream; the renderer gets the
     quiet control, so PCM buffers silently. No state, reply, receipt or text
     announcement is published (`ConvaiContinuousSpeech` `hold`). The stream is never
     split into phrase requests.
   - Pocket: Convai text-only, then the complete text goes to Pocket once; its PCM is kept
     in memory (`BufferedPcm`) and drained in order into the single renderer after the
     claim (the renderer page is still owned by the previous speaker until then).
   - Omni: first phrase synthesized into memory (phrase scheduling unchanged); its GPU
     work waits until the previous speaker's phrases have been produced, because the
     worker is FIFO and would otherwise delay that speaker's own next phrase.
3. After N is heard Lua submits the identical turn. The bridge adopts it (the turn key
   covers request, generation, speaker, text, audience and heard lines, journal and battle
   context; the world/journal snapshots Lua recaptures at submission are deliberately not
   part of it), releases the hold and the buffered audio is published at once.
   If it was not finished yet it simply finishes: the wait is the remaining generation
   time only, never more than a serial request, and never a second voice.

Cancellation: a new message, a dismissal, an audience change, an undelivered or
interrupted speaker, party removal, world/memory reset, microphone start and bridge
shutdown cancel the held turn (`dropPrefetch`). Its page is discarded, its Pocket request
aborted and nothing is published, so no orphaned stream or late audio. A submitted turn
that differs from the prediction discards the held one and runs as an ordinary request. A
held turn that fails publishes nothing and the submitted turn runs normally. Held turns
expire after 150 s.

Limits. The third speaker's turn can only start once the second is audible (Lua publishes
the prediction for the speaker being heard), so a very short second reply leaves part of
the third request's latency. The held turn keeps the world/journal snapshot of the moment
the prediction was published (seconds before submission, still bound to the live world).
Convai records the held speaker's turn when it is sent: as for any generated but
undelivered turn, an interrupted round can leave that speaker's unheard reply in provider
memory (the bridge records it as `cancelled-turn`, never as delivered).

Measured (silence between one speaker's last audio and the next speaker's first audio):

| Setting | Serial (before) | Look-ahead (after) |
| --- | ---: | ---: |
| Fixture, real bridge, simulated game and provider (1.5 s first audio) | 1.79-1.94 s (original bridge, 4 gaps) | 0.20-0.32 s |
| Live Convai speech, test user, warm pages, silent renderer | 2.2-3.4 s (5 runs, median 3.0 s) | 0.38-0.88 s (5 runs, median 0.78 s) |

Both include modelled game round trips (150 ms to submit, 120 ms to admit) and the
renderer's own start; `node scripts/Measure-GroupGap.mjs --fixture` and `--live` repeat
them. The next speaker's request started 1.9-2.2 s before the previous one ended, and
finished (buffered, text complete) 0.2-0.4 s before the game submitted it in four of five
live runs. In-game numbers: `runtime/bridge-latency.json` rows of a held turn carry
`preparation.mode: "lookahead"` and `lookahead` (`startedAt`, `readyAt`, `claimedAt`,
`readyBeforeClaim`); the gap is the later turn's `continuousPlaybackFirstObservedAt` minus
the earlier turn's `continuousPlaybackCompleteAt`.

`npm run test:group-voice` includes `group-lookahead.test.mjs` (module, buffered PCM),
`group-lookahead-bridge.test.mjs` (the real bridge against a simulated game/provider:
gap, ordering, partial overlap, new message, dismissal, mismatch, failure, replaced
prediction) and the hold tests in `convai-continuous-speech.test.mjs` and
`voice-routing.test.mjs`.

One persistent player identity is retained across private/group/microphone and
phone conversations. Group session separation does not create extra player IDs.

## Verification and limits

`npm run test:group-voice` exercises the real registered Lua hotkeys, recording
command files, reply polling, first reply, later speakers, prefetch, wrong-mode
keys, lost targets, zero-delta menus, save restoration, missing transcription,
timeouts and automatic finish. SDK transcript tests use the installed SDK event
contract with mocks. These checks never access a microphone or submit cloud
dialogue. Audible microphone acceptance remains deferred at the user's request.

Microphone's first Convai reply currently retains the existing full-reply
collection path. This change does not claim streaming onset for that first
microphone response; later text-routed group replies use the normal voice path.
