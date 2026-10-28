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
  at most three. With nobody faced the round is the first member of the party plus two picked at random from the rest of it (`docs/TALK_FALLBACK.md`). Duplicate copies do not produce duplicate speakers. A looked-at
  unsupported NPC is reported rather than silently replaced by another person.
- Starting group voice freezes the participating entities/profiles.
  The first request contains microphone input and its group context. Finish
  refreshes quest/battle/world facts without changing the captured audience or
  player identity.
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

## Anyone nearby (2026-10-28, branch `feat/group-anyone`)

Owner decision: a group round takes any two or three people nearby that V can talk to, not only companions and named characters. Before this, V beside two crowd women got "Group chat needs two characters nearby."

**Who counts, in this order.** The person V faces leads. Then V's companions, then the characters another mod placed (`docs/SPAWNED_CHARACTERS.md`), then everyone else the key press's own native query already found within 6 m (`convaiStrangerRange`): the ordinary people of the street (strangers), the game's named characters (while Settings > Talk to story characters is on) and quest-bound people, nearest first, three people at most. Facing nobody with no party, the nearest of them leads; facing nobody with a party keeps the party rule of `docs/TALK_FALLBACK.md`. The search is `convaiTalkNearbyPeople`, called on the key press only: it reads the list `convaiTalkNative` that the talk target gathered anyway (nothing the camera cannot see is counted, nobody behind V), it makes no query of its own and runs nothing per frame. It looks at a candidate only while the round has a seat free, skips our own copies and the other mod's characters (their lists), anybody fighting V, anybody with no usable profile or switched off, and, for a game-placed person, anybody the game is in charge of right now (the `talk-busy` refusal of `mod/world-talk.lua`). The key press logs `Group candidates: people=N of M looked at (noProfile=.. unsupported=.. disabled=.. refused=.. far=..)`.

**Game-placed people keep the same limits as in private talk** (`docs/WORLD_CHARACTERS.md`): talk, voice and face only. No gaze or hold (`beginFocus` is not called for them), no action offers, nothing that moves them. Each such speaker is checked when its turn comes (`convaiGroupSpeakerStory`): the story rules for its face are set for that speaker alone, a speaker the game has taken over (a scene, a call, a fight, an injury, a ride) is skipped and the round goes on with the others, and the mid-reply guard (`speech.storyGuard`) drops a group speaker's line instead of retiring a private reply. Strangers get the same treatment as a private stranger: a Night City name from the name pools (assigned only to those who are chosen), their district and archetype facts.

**The bridge.** A stranger's turn in a round is a normal turn of an ambient profile (`bridge/player-knowledge.mjs`): its session, Convai page and history are keyed by the physical entity as well as by the round's audience, so two strangers of one profile are two people with two histories, Convai long-term memory stays off for them, and a named speaker in the same round keeps its own rules. The audience still lists a shared profile once (it is a set of profiles); a round that has a stranger therefore also sends `group.people`, the names of the people in speaking order (`bridge/group-context.mjs` `parsePeople`), which the group context hands to every speaker ("The people in this conversation, in speaking order: ...") so the first speaker, who has heard nobody yet, knows who else is there. A malformed list is dropped and the round stands without it; a round of companions only is unchanged. This is the same on every provider: Convai (each speaker is its own Convai character, text only, voiced by the player's chosen voice), Mistral, Local AI and Custom (history in the ambient store under the person's key). No Convai-specific route was needed; there is no non-Convai fallback for strangers. Group warm-up and the look-ahead open a stranger's page only with its entity (`PlayerKnowledge.configFor` returns nothing without one), so the first stranger of a round on Convai pays its connection when its turn is prepared, which the look-ahead overlaps with the previous speaker (it cannot on a single-session plan).

**The notice.** "Group chat needs two characters nearby. Use {key} for one person." names the key that answers one person: the key set on the mod's Key bindings page (a controller button as "Controller A"), else Cyber Engine Tweaks' binding, else, when neither reads as a name (no key, or a binding whose text is blank, a no-break space or zero-width characters), the action's own name ("Talk by text", "Talk by voice"). It never prints an empty key (`convaiKeyHint`). The old variant "Use private chat for one person." is gone from the catalogue and the 15 dictionaries.

**Tests.** `bridge/group-anyone.test.mjs` (selection harness cut from `mod/init.lua`: two crowd women, order and the 6 m limit, hostile, owned, other-mod, unprofiled and switched-off people left out, a full party looks at nobody, the notice in every key case, story and quest-bound people, busy ones, the speaker's story state, the round's names, `parseGroup`/`groupContext`) and `bridge/player-knowledge.test.mjs` ("a group round of strangers"). **Live check owed**: two crowd people beside V (group voice held, and group text), a stranger and a companion, a named character nearby (Judy at her place), that a stranger who walks off is skipped without a stall, and that nobody in the round is turned or held by the mod.

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

### Look-ahead on a player's own key (2026-10-17, branch `group-latency`)

The user's live round on the player's own Convai key (confirmed paid Gamer plan, Voxtral voice) waited 8.3 s and 9.0 s between speakers, while the first speaker's text came quickly. The stage clock (`runtime/bridge-latency.json`) of the later speakers read `preparation.mode: "none"`: nothing had been prepared. Each of them paid a fresh Convai connection (`timing.connectionMs` 3.0-4.3 s, `pageReused: false`, one more page per speaker), then the reply (`collectionMs` 2.4-2.6 s), then the voice (about 1.1 s to its first audio) and about 0.5 s of admission and publication, all after the previous speaker's last sample (`transport` to `voiceStart` 7.0 s and 7.7 s). Nothing was waiting behind the previous speaker's audio; there was nothing running ahead.

Cause: `pollLookahead` refused every poll while `singleSession()` was true, and that is true for any player's own key (a free plan holds one connection, and the rule was also kept on paid plans to save interactions). It is not specific to spawned characters: a speaker created by another mod runs under a roster profile and looks to the bridge like any other speaker (tests below).

Now:

- Look-ahead is allowed when the plan can hold a second connection: the shared key, or a player's key whose confirmed plan allows two or more (`connectionLimit()`, 6 on a paid Gamer plan; `lookaheadAllowed`). A free, unknown or unread plan keeps one connection and the serial path (a held turn would need the second connection beside the speaker still heard), and with Mistral or the local AI there is no Convai connection to run ahead on.
- On a confirmed paid plan the first speaker's request also opens the other speakers' pages (`warmRoundAhead`: `RealtimeHost.warm` with the exact route their turn will use, one after another, never awaited by the turn, no message sent, no memory written; it stops with the turn, and a page that does not open is opened on demand as before). Without this the next speaker's connection (3-4 s of its 7 s) would still start only when the previous speaker's text is complete, leaving about 2.2 s of silence. The shared key already opens them through the party connections.
- Nothing changes for a solo turn or a private chat: the look-ahead and the warm-up act only on a group round, and only when the round has speakers after the first.
- Interactions: a look-ahead turn is the turn the game submits a moment later, so a round that runs as predicted spends nothing extra. It spends one that is never heard only when the round is interrupted after the next speaker was requested.

Measured with the real bridge against a simulated game and provider delays shaped like that live round (`LIVE_TIMINGS` in `bridge/group-lookahead-fixture.mjs`: connection 3.5 s, reply text 2.1-2.6 s, first audio 3.5 s after the connection, 5 s of audio; a speaker that is not prepared takes about 7 s). Silence between one speaker's last audio and the next speaker's first, three speakers, two gaps (`node scripts/Measure-GroupGap.mjs --fixture --key player-paid --live-timings`):

| Bridge | Gap 1 | Gap 2 |
| --- | ---: | ---: |
| Before: player key on a paid plan | 7.5 s | 7.6 s |
| Look-ahead allowed only (the gate) | 2.4 s | 2.5 s |
| Look-ahead plus pages opened at the first request (now) | 0.31 s | 0.38 s |
| Player key on a free plan (unchanged, serial) | 7.2 s | 7.4 s |

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

`npm run test:group-voice` includes `group-lookahead.test.mjs` (module, buffered PCM, the plan gate, a spawned speaker's prediction),
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
