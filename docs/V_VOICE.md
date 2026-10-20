# V's voice for typed lines

October 14, 2026. A setting that makes a typed line sound like V said it. With **Companion Manager > Settings > Voices > V's voice
for typed lines** on, whatever you type to a companion is also spoken aloud, in a male or female V voice cloned from V's own
lines in the game. Then the companion answers.

**On by default** (new installs, and saved settings that never stored it; a player who turned it off keeps it off). The first version saved `false` as its default, so a saved `false` counts only when the player set it (an Apply that carried it stores `vVoiceChosen`, the same pattern as Expressive emotions and the holocall live picture); an unchosen `false` becomes `true` when the settings load, in `mod/manager.lua` and in the bridge's read of `runtime/settings.json`. Typed lines only: push-to-talk is never replayed (you already spoke it). Reactions, phone Chat, add-on
remarks and the later speakers of a group round never get a V line. A line typed to an add-on's voice (the Delamain cab, Skippy) does
(2026-10-16; before it did not, and V was silent in the cab): `runAddonTurn` starts V's line beside the add-on's text request exactly as for a
companion, in V's own voice page, and the add-on's reply waits for it. The composer of an add-on's voice leaves a voice-only hint in
`conversation-prewarm.json` (`voiceOnly`), so V's voice page is warm; it opens no connection. V's words are never part of the add-on speaker's
reply (the add-on's text host cuts them: `bridge/mistral-prompt.mjs` `stripPlayerEcho` and `speakerTurn`).

## What you hear, and in which order

1. You type a line and send it. The text goes to the companion's model at once, exactly as without the setting.
2. In parallel, V's line is synthesized and played, in V's voice, at the game's dialogue volume. It has no face or lip sync: it
   is your own voice, not a game utterance. Its words are shown as **V's subtitle** (below).
3. When the companion's reply is ready, its audio waits (silently, buffered) only while V's line is still playing, then starts.
   The two never overlap.
4. **If V's line is not audible yet when the reply is ready, the reply waits for V's first audio for at most 600 ms (the grace,
   below), then V's line is dropped** and the reply goes on at once. Before 2026-10-19 V was dropped the moment the reply was ready.
   The first line after a cold start used to be lost for this reason (the voice has to be prepared once); the voice is now prepared
   before the first line (below), and the composer warms the renderer page when it opens.

Any failure (a clone that cannot be made, a voice error, no audio in time) skips V's line, writes one `[VVoice]` log line and
never touches the conversation.

## The grace, the warm voice and the totals (2026-10-19, branch `fix/v-voice-typed`)

**Live finding (Silent power mode, V on Pocket on the CPU, companion voice Voxtral, Mistral).** V's typed line to Johnny was never
heard: `engine=pocket-helper result=dropped reason=slower-than-reply marks={"voiceStart":1,"playStart":13,"ttsSent":220.7,
"rendererReady":831.7,"firstPcm":3006.1,"dropped":3046.1}`, the companion's `firstFrame` at 3053 ms on the turn's clock.

**What the marks say.** V's marks are on V's own clock, which starts when V's line starts: V's `dropped` (3046) is 3082 on the turn's
clock (`vDropped`), so V started about 36 ms into the turn, at the top of `runInput`, in parallel with the model request. It did not
wait for the companion's `voiceStart` (1340 ms, that is the companion's clock). Nothing needed to start earlier. The time went to
Pocket: `ttsSent` 220 ms, the voice's first PCM at 3006 ms, about 2.8 s of synthesis where a warm Pocket needs 0.2 to 0.3 s. The renderer
page (831 ms) was ready in parallel and was not the bottleneck. A warm Pocket line is audible long before any reply (the model's first
sentence alone takes 1.1 s), so this one was cold, and the reply's first audio (1.4 s of Voxtral after `ttsSent` 1492) beat it by 40 ms.

**Cause 1: the first Pocket line of a session paid the voice's preparation.** Pocket clones a voice by encoding its reference clip once
(seconds on a slow CPU; `ensurePrepared` runs inside the first `synthesizeStream`). The composer's warm-up (`VVoice.warmUp`) prepared the
voice only when it knew which V is playing, and the game does not say before the first typed turn: with two clips and no line yet
the code deliberately prepared nothing. So the first line of every session was cold, and a worker still loading when the composer opened
(`ready(key)` false) prepared nothing either.

**Cause 2: the drop rule had no tolerance.** `VLine.holds()` and `holdsPublish()` (called by the continuous speech for every frame, and
by `waitClear` for a reply published as a whole) dropped a line that was in `synth` state on the first ask, so a V line that was 40 ms
from audible was lost like one that was seconds away.

**The fix.**

- **V's voice is prepared before the first line.** (a) V's gender is remembered between sessions (`v-voice-gender.json` in the
  state folder, written only when it changes), so the first composer of a session prepares that one voice. (b) With nothing known (a
  first session) both voices are prepared one after the other, male first, and the second is skipped as soon as a typed turn says which V
  it is; the choice is remembered from then on. (c) When V's own Pocket worker finishes loading it prepares V's voice at once
  (`VHelperVoice.onReady`, `VoiceSelection` option `onVHelperReady`, `warmUp({page: false})`): no renderer page is opened for this, and
  nothing runs per frame. With "Keep prepared voices" on, the worker also saves the prepared voice to disk, so later sessions pay almost
  nothing. The preparation runs in the below-normal-priority worker process, never on the game's thread.
- **A bounded grace instead of an instant drop (`V_GRACE_MS`, 600 ms).** The first time the reply asks while V is not audible, the
  reply's publish and sound are held and a timer starts; V becoming audible inside it plays as usual (the reply then follows V's end), the
  timer running out drops V (`slower-than-reply`, `waitedMs` in the line's summary), and the reply goes on. Later asks never extend it.
  A turn ending or a failure cancels it. The stage clock shows it: V's `graceStart`, and on the turn's clock `vGrace`, then `vAudible` or
  `vDropped`. **Why 600 ms:** it is the renderer's 400 ms start buffer plus about one Pocket chunk, which covers the near miss seen
  live (40 ms) and ordinary jitter, while a voice that really is seconds away (a cold one, 2.8 s) is not waited for beyond it.
  `CYBERPUNK_CONVAI_V_GRACE_MS` sets it (0 restores the old instant drop, at most 2000).
  **What a rescue really costs, and its budget.** Waiting is the small part. A line that becomes audible after the reply is ready no
  longer overlaps the model's wait, so the reply then follows V's whole line (its speech, 160 ms lead-in and 320 ms tail): in the
  live case about 0.3 s of wait plus 2.5 s of V, and the numbers below show it. A warm V is audible in 0.3 s and the same line costs the
  reply almost nothing. So the grace is capped by `V_RESCUE_BUDGET_MS` (4 s): the line's length is estimated from its words (2.8 a
  second, the pace V speaks) plus the 480 ms of edges, and the wait is only what is left of the budget after that. Up to eight words get
  the whole 600 ms, nine get about 300 ms, ten words and more get none and are dropped at once as before. The budget is
  the answer to "never delay the reply more than a bound": it bounds the wait plus the line, about 4 s, the reply latency a player
  already sees on a slow turn.
- **Totals in the log (and so in a support report).** Each V line that settles is counted. The first line of the session, and every dropped
  line, writes `[VVoice] this session: 3 typed line(s) spoken, 1 not heard (slower-than-reply=1), 2 not started (voice-not-loaded=2)`; the
  last such line is the current total. A typed line that could not start (`voice-not-loaded`, `voice-not-ready`, `cloud-unavailable`,
  `not-english`, `volume-unknown`) is counted by reason and the first of each reason writes the totals. Counts only, no text. The
  per-line `[VVoice] ... result=...` records and `runtime/bridge-latency.json` `vVoice` already existed; both are in a report.

**Measured 2026-10-19 (stage clock, `scripts/Measure-VVoice.mjs --early --runs 3 --prep 250 --text 1150 --only "Voxtral companions, V on Pocket"`;
simulated providers, the real `VVoice`, `VLine` and `TurnClock`; the reply's first audio is ready at about 2520 ms, the live shape;
milliseconds after the send; seven-word line).** "Delay" is when the reply starts minus when it would start with V off.

| V's Pocket first audio | Grace | V audible | V | Reply starts | Reply delay |
|---|---|---:|---|---:|---:|
| 250 (warm, Pocket's usual) | 600 | 323 | heard | 2791 | +265 |
| 1500 (slow CPU, voice prepared) | 0 (old rule) | 1566 | heard | 4039 | +1514 |
| 1500 | 600 | 1571 | heard | 4040 | +1522 |
| 2800 (the cold first line seen live) | 0 (old rule) | never | **dropped** | 2526 | +2 |
| 2800 | 600 | 2864 | heard (320 ms after the reply was ready) | 5349 | +2824 |

So the warm voice is the real fix: the same line is heard at 323 ms and costs the reply 265 ms, against 2824 ms for a rescued cold
line. The grace only turns a lost line into a heard one in the narrow band where V is within 600 ms behind the reply, at the price of
the reply following V's line; it never holds the reply for more than the grace when V is later than that (budget above). The
simulated "Keep prepared voices" and the real Pocket prepare time were not measured live in this change: the live check is in TODO.md.
(The cold 2800 ms figure is the live mark; the 2 s of it that is voice preparation is what the new warm-up removes.)

**Not changed, on purpose.** V still starts first (top of `runInput`), the reply is still never held for a V line that is not
coming, no second Pocket worker or extra model is loaded, and an unfinished V line on the shared Pocket worker still steps aside when the
companion's text-to-speech request goes out (the worker does one job at a time). The 200 ms between V's `playStart` and `ttsSent` in the
live marks is the bridge's event loop busy with the turn's other start-up work (knowledge, admission) on a slow CPU; it was not
touched.

## V's subtitle (2026-10-15)

What V says is also on screen, in the same cinematic subtitles the companions' replies use. When you send a typed line, `mod/init.lua`
calls `subtitles.showTyped` (`mod/subtitles.lua`) once, right after the request is written:

- **Speaker `V`**, the same name V's live words use when you speak by microphone, as one dialogue-HUD line owned by the player. It is the
  cinematic style whatever style replies use ("Cinematic subtitles" or overhead), since V has no head to hang an overhead caption on.
- **Timing.** It appears when the line is sent, which is within a fraction of a second of V's audio starting (V's first audio is about 0.25
  s after the request). It stays for the ordinary reading time (about 2.8 words a second, which is also about the pace V speaks, at least 3.5
  seconds), the pages of a long line advance the same way, and a short line goes by itself. The bridge sends no signal for it and nothing
  here waits for V's audio: the companion's audio already waits for V (below), so the reply's own caption normally arrives after V has finished.
- **Cleared before the reply.** The reply's caption (`show` or `beginTimed`) clears the line first, so the companion's subtitle never
  starts beneath it. V's subtitle owns no utterance, so it never holds a reply back.
- **Typed and spoken.** It shows for every typed line, whether or not V's voice is on or can speak (the Convai cloud voice, or the
  setting off): the subtitle is what V says, the voice is optional. The voice of a microphone turn was never replayed, but its recognised
  words already showed as V's live line (`subtitles.showLive`, `mod/init.lua` `microphone.onHeard`), so mic turns are covered the same way.
- **Settings.** With the game's subtitles off (`player:ConvaiManagerSubtitles()`, the same switch replies use) nothing is shown. No phone
  Chat text, reaction or add-on remark gets it (those never pass the composer's submission); no per-frame work beyond a caption's own.

## V's voice engine (2026-10-17, branch `v-voice-engine`, not merged)

V's line no longer follows the companions' voice. **Settings > Voices > V's voice for typed lines** (one list since 2026-10-20: Off, Pocket · On your PC, Voxtral · Mistral cloud; it writes both stored keys, `vVoice` and `vVoiceEngine`, and Off keeps the saved engine) picks the engine for V alone, and
the sections below that still describe "the voice you already chose" are history: this section is current.

| Engine | How V's line is made | Loads locally |
|---|---|---|
| **Pocket** (default) | Cloned by a Pocket worker on the CPU. When the companions use Pocket, their worker speaks V (one job at a time, as before); with any other companion voice (OmniVoice, Voxtral, the Convai voice) V has a **Pocket worker of its own** (`bridge/v-helper-voice.mjs`) | Pocket worker, only when V needs it |
| **Voxtral** | One HTTPS request to the Mistral Voxtral voice with the player's Mistral key, cloned from V's reference | Nothing |

Not offered: OmniVoice (its GPU worker cannot serve V in time and cannot cancel a started render), and the Convai voice (it cannot clone). The engine is independent of the companions' voice, so every mix works.
Pocket is English only: a turn in another language gets no V line (subtitle still shows). Voxtral speaks the language of the line for the languages its model lists (Voxtral TTS 3, 22; `bridge/voxtral-languages.mjs`), so a V line in French or Japanese is spoken; a language it does not list gets no V line, as before (one log line).

**What the choice does to the pipeline.**

- **Early start.** V's line starts at the top of `runInput`, right after the profile check and before knowledge preparation, admission,
  the connection set-up and the transport hand-over (before, it started after `respond()` had been called). Synthesis therefore runs
  in parallel with the whole of the companion's text request, not just its tail. A look-ahead (group) turn still gets no V line.
- **Pocket** has the fastest first audio (about 0.2-0.3 s once warm), so it is audible long before a typical reply and costs the
  reply the least. **Voxtral** is a cloud round trip (first audio about 1.15 s in the simulation), so it is audible later and, because
  V then plays before the reply, it delays the reply's start more. That cost is inherent to a cloud voice; the engine is the player's choice.
- **Warm-up.** Pocket prepares the V clones on whichever worker will speak (the shared one or V's own). Voxtral pre-creates the cloned
  reference for the gender used last (both genders when none yet) so the first line does not pay for the clone.
- **Mistral scheduler.** A Voxtral line is skipped while the shared Mistral scheduler is spacing or paused (`spacingMs > 0` or
  `pausedForMs > 0`): V never takes a Mistral start from the reply. A failed V cloud line is not retried (a retry would land after the
  reply, which is dropped by design) and has no Convai-voice stand-in; V is silent and the subtitle shows.
- **The worker rule.** A Pocket worker for V loads only when V's voice is On, the engine is Pocket, V's clips exist and the companions
  are not already on the Pocket worker; never beside another Pocket worker (one work-folder lock), released with confirmed exit when
  any of that stops being true (`voice-selection.mjs`: `pocketRoute`, `vHelperDue`, `vHelperSpeaks`, `vRouteSpeaks`).

**Load and unload by combination** (V's voice On; with V's voice Off no V worker exists in any row):

| Companions | V engine | Local models loaded | Notes |
|---|---|---|---|
| Pocket | Pocket | the one Pocket worker (shared) | V and the companion share it; V's unfinished line is dropped when the companion's TTS request goes out |
| Pocket | Voxtral | the Pocket worker (companions only) | V is one HTTPS request |
| Voxtral | Pocket | **V's own Pocket worker only** | no Pocket for the companions; the cloud-voice rule is kept for them |
| Voxtral | Voxtral | **none** | nothing local at all |
| OmniVoice | Pocket | OmniVoice + V's own Pocket worker (starts after Omni is ready) | as before |
| OmniVoice | Voxtral | OmniVoice only | V's Pocket worker is released if it was running |
| Convai voice | Pocket | V's own Pocket worker only | V now speaks beside the Convai voice |
| Convai voice | Voxtral | none | V now speaks beside the Convai voice |

**Missing key, Mature content, language.** Voxtral for V needs a Mistral key: the Voxtral entry reads "Voxtral · needs Mistral key" and is greyed out, and the
manager refuses to apply it until a key is saved ("Requires a Mistral key (add it in Settings > Conversation provider)"). **Changed 2026-10-20:** if the key
is removed later (or an old file holds Voxtral with no key), the row shows Pocket and the bridge speaks V's line with Pocket (its settings poll reads a saved Voxtral without a key as Pocket); it is
Voxtral again as soon as a key is saved. Removing the key says so in its Remove help ("V's voice switches from Voxtral to Pocket."). Before that change the bridge skipped V's line with
no fallback, so as not to load a model the player did not choose. **Mature content never uses Voxtral** (decision 2026-10-20, after Mistral's Voxtral voice refused Mature lines in a live test; it replaces the same-day
rule that allowed it beside Mature on any text provider): turning Mature content on moves V's Voxtral to Pocket in the same save (the line says "V’s voice for typed lines" changed, and the record `matureRestore.vVoiceEngine`
keeps the way back), turning it off puts Voxtral back while the key is saved and V still speaks with Pocket, the Voxtral entry is greyed out ("Voxtral is not used with Mature content.", label "Voxtral · not with Mature" in Native Settings UI, which
has no greyed entries) and refused while it is on, and a saved file with both loads as Pocket. The bridge has two nets behind the page: the settings poll reads a saved Voxtral as Pocket while the setting is on, and V's cloud `problem` answers "Mature content is on".

**Measured (simulated providers, `scripts/Measure-VVoice.mjs`, real `VVoice`/`VLine`/`TurnClock`; prep 180 ms, companion text 900 ms,
5 runs; milliseconds).** "Delay" is when the reply's audio starts, minus when it would start without V.

| Scenario | V audible before -> after | Reply delay before -> after |
|---|---|---|
| Pocket companions, V on Pocket | 494 -> 318 | 1634 -> 1438 |
| Pocket companions, V on Voxtral | 1342 -> 1157 | 2475 -> 2281 |
| Voxtral companions, V on Pocket (own worker) | 490 -> 305 | 770 -> 588 |
| Voxtral companions, V on Voxtral | 1363 -> 1164 | 1623 -> 1430 |
| OmniVoice companions, V on Pocket (own worker) | 483 -> 317 | 563 -> 385 |
| OmniVoice companions, V on Voxtral | 1353 -> 1165 | 1419 -> 1228 |

The early start saves about 180-200 ms in every scenario (the pre-reply steps no longer sit in front of V). Compared with the old
behaviour where V followed the companions' voice (Voxtral companions: V audible at 1353 ms and reply delay +1621; now Pocket gives 305 ms
and +588), choosing Pocket for V is the fastest option for V and costs the reply the least. These are simulated numbers from
the stage clock, not live ones; the live check below gives the real figures.

## Which voice speaks

(Historical for the 2026-10-14 to 2026-10-16 behaviour, where V followed the companions' voice. Current: see "V's voice engine" above.)

V's voice follows **V's voice tone** from the character creator (the "brain gender"), not V's body: a V built with a male voice
speaks with `v-male` whatever the body, as the game's own V lines do. `mod/turn-context.lua` reads it from the character
customization state (`IsBrainGenderMale`) and sends it as `voice`; only when that read fails does it fall back to the resolved
gender (`gender`). `voice` is never written into the model's context.

Until 2026-10-17 the voice was the one **you had chosen** for companions:

| Companion voice | How V's line is made |
|---|---|
| Pocket TTS | cloned by the local Pocket worker (a lazy voice entry, prepared on first use) |
| OmniVoice | spoken by a **Pocket worker on the CPU that loads beside OmniVoice** (see "OmniVoice companions" below); V is never rendered on OmniVoice. English only |
| Mistral (Voxtral) | cloned by the Mistral cloud voice with the player's Mistral key; **no local voice model is loaded** |
| Convai cloud voice | **cannot clone, so the setting stays on but is inactive beside it:** no V line plays, nothing is refused, no notice is shown at load or Apply, and nothing is switched off. The setting row shows one short note ("Works with the Pocket, OmniVoice or Voxtral voices."). Choosing a cloning voice makes it work at once. |

A cloud voice with no key, or a turn in a language the chosen voice cannot speak (Pocket speaks English only), gives no V line.
Inactive beside the Convai voice costs nothing: `bridge/v-voice.mjs` starts no V line, warms no renderer page, prepares no voice
and logs no problem for it, and `mod/manager.lua` `vVoiceActive()` (setting on and a cloning voice saved) keeps the game-side
dialogue-volume read off (`mod/init.lua` `wantVolume`). A cached turn context read before the voice was switched is read again
once, so the first line after switching to a cloning voice already has the volume.

V has no model of its own: its two entries (`v-male`, `v-female`) are merged into the voice configurations the bridge already
loads (the same mechanism as an add-on's voice, `AddonHost.voiceConfigPaths` with `extra`). They are lazy, so merging them
changes nothing about what is loaded at start. Toggling the setting takes effect at once (no restart).

## Latency design

Latency is as important as FPS here, so V never stands in front of anything:

- V's line starts first, at the top of `runInput` (2026-10-17; before it started after `respond()`), so its synthesis runs beside the whole companion text request.
- A V line is never started for a look-ahead (group) turn.
- V plays on a second hidden renderer page (`RealtimeHost.playVoiceLine`, a second `LocalPcmHost`), so it never waits for, or
  takes the place of, the companion's utterance. The game's single pending-request machinery is untouched.
- The companion's audio is held with the existing `hold` of the continuous speech (the one a look-ahead uses): the renderer
  keeps buffering and gets the quiet control, nothing is published to the game, so the subtitle and the face start exactly when
  the companion's voice does. A reply published as a whole (OmniVoice) waits in `publishResult` for the same signal.
- "Audible" means the V renderer holds audio. If the reply is ready first, the reply waits for V's first audio for the grace (600 ms)
  and V is then dropped (2026-10-19; before, on the spot).
- Pocket and OmniVoice workers do one job at a time. When the companion's own text-to-speech request goes out (`ttsSent` on the
  turn's stage clock) and V's line is still waiting for its first audio, V is stopped so it is not in front of the reply's voice.
  A line that is already audible keeps going (the companion cannot be heard before it ends anyway). The cloud voices share no
  worker, so they are not stopped this way, and neither is a line spoken by the OmniVoice companions' helper Pocket worker (a
  different process on the CPU). (OmniVoice cannot cancel a render that has started, which is why V is not rendered on it at
  all: see "OmniVoice companions".)
- Nothing runs per frame. The game-side change is one extra read of the game's dialogue volume when a typed turn is built,
  and only while the setting is on (`mod/turn-context.lua`, cached with the rest of the turn context for 5 seconds).

### OmniVoice companions (2026-10-14, branch `v-voice-omni-drop`)

Live report: with an OmniVoice companion V was never heard when typing. The log (companion Dakota Smith, OmniVoice Balanced):

`[VVoice] ... engine=omni result=dropped reason=reply-voice-started marks={"ttsSent":3.4,"rendererReady":81.1,"dropped":881.5}` and a second line dropped at 1064.8 ms.

**Cause.** V's line was rendered whole on the OmniVoice worker (about 1.3 s to first audio for a reply at 16 steps, a little more for V's
longer 11 to 14 s reference; the whole WAV must exist before anything is audible). The companion's text reply is ready after 0.9 to
1.1 s and its own OmniVoice request goes out (`ttsSent` on the turn's clock), so V, still unheard, was stopped. The stop was not even
useful: OmniVoice has one GPU worker, serves one job at a time and cannot cancel a render that has started, so the companion's render
was queued behind V's anyway. Net effect of the old path: no V line, the reply's render started late (after V's render), a hidden
GPU render per typed line and a new CUDA graph capture (about 0.35 s) when the text shape changes. On Pocket V is audible after
0.2 to 0.25 s (`audible` in the live Pocket lines), well before the reply.

**Options weighed.**
- (a) Keep V on OmniVoice, play it first and queue the reply after it, with a cap. V is audible only after its whole render, 1.6 to
  2 s (so the cap would need to be about 2.5 s), the reply then starts after V's speech, about 4 to 4.5 s after the send against about
  2.2 s with V off. It also keeps costing GPU time (FPS) and graph captures on every typed line, and the Omni render can still
  not be cancelled. Rejected.
- (c) Start V's synthesis earlier. Already the case: `runInput` starts `respond` and then `vVoice.start`, in the same tick; V's voice
  entry is sent within 3 to 7 ms (`ttsSent` in V's own marks). Nothing to gain.
- (b) **Chosen: V is spoken by Pocket on the CPU even when the companions use OmniVoice.**

**Why (b).** V is audible at about 0.25 s, before the reply in nearly every turn; OmniVoice is not touched (no GPU work, no queue in
front of the reply's render, no graph capture); the reply starts at the later of "its own render is done" (about 2.2 s) and "V has
ended plus the 320 ms tail" (about 2.2 to 2.5 s for a 1.5 to 2 s line), so the added latency is about 0 to 0.3 s for an ordinary
line and the length of V's speech beyond that for a long one, and it is 0.4 to 0.9 s sooner than the old path, which delayed the
reply for nothing. V's two voices were picked and scored on Pocket (ECAPA 0.68 male, 0.52 female), so this is the better-tested voice.

**Resources.** Pocket is the CPU student: 418 MiB of weights (float32), 2 to 4 inference threads, worker below normal priority, 0 VRAM
(`CUDA_VISIBLE_DEVICES=-1`), so VRAM is untouched and the game's main thread is not involved. It is the same worker Pocket
companions already use during play (and Pocket plus a loading OmniVoice already coexist in the OmniVoice retry). Its start takes
about 45 s (the Python imports, below normal priority; seen in the live log), so it loads once, in the background, **after the OmniVoice
worker is ready** (never beside OmniVoice's own load), and stays resident (RAM about the student plus Python, roughly 1 GB; not measured
here) while OmniVoice is the committed voice and the V setting is on. Idle it costs nothing per frame; a V line is a short burst on
its threads. A player who wants no extra process turns the V setting off: the helper is then released.

**The rule "cloud voice loads no local model" is untouched:** the helper never exists beside Mistral (Voxtral) or the Convai
voice, nor beside the Pocket voice (V then uses the chosen worker), nor while voice playback is off.

**How it works** (`bridge/v-helper-voice.mjs`, `VoiceSelection.tickVHelper`):
- The bridge's settings poll tells the voice selection whether V is wanted (`setVHelperWanted(vVoice.enabled && vVoice.available)`).
  The helper is due when OmniVoice is the committed, loaded voice and V is wanted; it is released the moment that stops being true.
- It uses Pocket's configuration, which already holds V's two voices, and the prepared-voice store (a saved setup makes V's voice
  nearly free after the first time). The composer's warm-up prepares V's voice on it, not as a hidden OmniVoice render.
- Pocket's work folder has one lock, so the helper is released, with its exit confirmed, before any other Pocket worker starts (a
  switch to the Pocket voice, or a Settings preview of it), and it never starts while another Pocket worker is stopping.
- A V line that finds the helper still loading (the first typed lines after the game starts, or just after V was switched on) is
  skipped with one log line (`V's line skipped: the Pocket helper voice is not loaded yet`); the reply never waits.
- A failure (the worker cannot start or dies) leaves the helper off with one log line (`[VHelper] ... failed`); V is silent meanwhile,
  never rendered on OmniVoice instead. It is loaded again after 45 s, then 3 min, then 10 min (`V_HELPER_RETRY_DELAYS_MS`, the same
  waits as the companions' Pocket), never while a reply is in flight, due-checked from the 500 ms poll and each V line (no timer);
  after the fourth failure it stays off until V is turned off and on, or the voice changes. A Windows block of a file of the voice is
  not retried. (Before 0.2.4 one failure ended V's voice for the whole session.)
- Pocket speaks English only: a non-English turn gets no V line beside OmniVoice, with one log line.
- Order: the helper line is a V line like any other. The companion's OmniVoice request neither waits for it nor stops it (a different
  worker); the reply, published as a whole after its render, waits in `publishResult` (`waitClear`) while V is audible and starts after
  V's tail, so V is first, the companion second, never overlapping. If V were somehow not audible when the reply is ready it is dropped.
- The report line reads `engine=pocket-helper`.

Not measured live (no game turn was allowed): first-audio and the added reply latency above are estimates from the live Pocket V
lines (audible 195 to 260 ms), the OmniVoice figures in `docs/LOCAL_VOICES.md` and the two dropped Omni lines. The live check is in TODO.md.

### Air at both ends (2026-10-14)

Live report: V's line "feels abrupt on both ends, like there is air missing". Cause: Pocket starts a line at its first voiced sample and
ends it one frame after its own end-of-speech (`frames_after_eos=1`, `eos_threshold=-1.0` in `bridge/pocket-voice-worker.py`), and the
renderer plays exactly the samples it is given (no fade, no trim, no padding anywhere on that path by design), so the line starts and stops
tight, and the reply followed it at the very last sample. The reference clips are not the cause (80 ms lead, 90 ms tail, natural pauses).

`bridge/pcm-edges.mjs` (`PcmEdges`) wraps the packet consumer of a V line (`VLine.streamProducer` and `omniProducer`): 160 ms of silence in
front, merged into the first packet (nothing waits for it, no synthesis cost); a 15 ms raised-cosine fade-in; only the last 40 ms of the
line are held back (never a whole packet), faded to zero; then 320 ms of silence. The line is "ended" (and the companion released, `hold`)
only after that tail has been heard, so the reply starts about 320 ms after V's last word. Packets keep the engine's shape and are
renumbered. Latency: the first sound is not later than before; the lead-in silence counts toward the renderer's 400 ms start buffer.

The companion's own Pocket lines share the cause but are not changed: their PCM also feeds the facial and lip-sync stream, the subtitle
cues and the head/tail continuation by exact frame position, so padding them is a separate, live-tested change. With V's voice on, a reply
now starts after V's tail, so its start has air too.

### Timings

V's line runs under its own stage clock (`bridge/turn-clock.mjs`), so its marks never mix into the companion's. One log line per
line, and the same record in `runtime/bridge-latency.json` under `vVoice`:

`[VVoice] profile=judy-alvarez voice=v-male engine=pocket result=played marks={"voiceStart":0,"ttsSent":2.1,"firstPcm":...}`

Marks, in milliseconds after V's line started: `voiceStart`, `playStart`, `rendererReady`, `ttsSent` (the voice asked),
`firstPcm`, `firstPcmAccepted`, `audible` (the renderer holds audio), `synthDone`, `graceStart` (the reply was ready and waited for V's
first audio), `ended`, or `dropped` with a `reason` (`slower-than-reply`, `reply-voice-started`, `turn-ended`, `failed`, `no-audio`). The
summary carries `waitedMs` (how long the reply waited, when it did). The companion's own clock also gets `vGrace`, `vAudible`, `vEnded`
or `vDropped`, so the wait V caused (if any) is visible in its record.

## The reference clips

One reference per gender, cut from V's own lines in the game archives (`v_*_m_*.wem` and `v_*_f_*.wem`). **Male V: 13.6 s (three
lines). Female V: 11.55 s (two lines).** 24 kHz mono, whole trimmed clips joined with 0.4 s gaps (the project's reference recipe),
best clip first (one cloud voice cuts its reference to about the first 8.5 s).

**Louder clips (2026-10-14, branch `v-voice-louder`, by measurement only, not yet heard):** the game mixes nearly every V line to about -23 LUFS, so the references were swapped for the few clean, conversational, non-clipping lines the mix leaves hotter (the pool's `scripts/clip-search/v-voice/build_v_pool.py` rules; no hum, noise floor under -65 dBFS, no combat or shouted delivery, peak under -3 dBFS). Male: 3 lines, 11.42 s, -22.4 LUFS (was -23.6); female: 3 lines, 13.25 s, -20.6 LUFS (was -23.5); the three-line set is the loudest clean group that passes the 8-20 s and 2 dB spread rules. `loudness.py` measures LUFS / gated RMS; ECAPA likeness of the new clips has not been scored.

### How they were chosen (2026-10-14, second pass)

The first clips (2026-10-14 morning: male 11.4 s from 3 lines, female 14.5 s from 4 lines) were picked by a script that only checked
the subtitle with a speech recogniser and the loudness. They had no gross defect (no clipping, peaks at -5 to -8 dBFS, clean
floor, no phone or radio effect, no music), but nothing in that pick measured whether the clone sounds like V, and it does not:
on six held-out real V lines the cloned voice scored ECAPA 0.537 (male) and 0.429 (female) against V's own centroid, well under
what the companions get from the automatic picker (0.6 to 0.8). A user listening on the Pocket voice called it "a bit off, a little
low quality".

The second pass feeds V into the project's automatic reference search (`scripts/clip-search/search.py`, the "Auto-best" that
`scripts/reference-picker/autobest.mjs` loads), exactly as for the companions:

1. `extract_v.py` pulls 1200 random calm quest lines per gender (plain 7 to 17 word subtitles, no effect or special-state scene).
2. `build_v_pool.py` puts them in the picker's pool format: lines trimmed, loudness and ECAPA typicality, the picker's own
   exclusions (band-limited, comb, tone, reverb), plus dull (99 percent of the energy under 3.5 kHz), noisy pauses and hot peaks,
   and the game's scene index for delivery (`scripts/combat_flags/source_signal.py`: no combat or shouted lines; only lines the
   game plays as "Spoken": V's inner-dialog, cyberspace and phone expressions, 12 percent of the pool, are out). About 650 male
   and 560 female lines stay usable.
3. `run_search.py` runs `search.py` for Pocket on the CPU (the live student, decoder v2): 14 real lines are held out of the
   candidates; the search races single clips, grows sets under an 18 s cap, and scores the finalists on six fresh held-out real
   V lines with two seeds (ECAPA speaker similarity first, PLS second).
4. `compare_v.py` re-scores the old clips and the candidates on the same lines, renders four typed test sentences with each, and
   adds artifact measures; an ASR check of the renders and `asr_v.py` / `build_reference.py` check and build the shipped files.

| Set | Seconds | ECAPA (held-out V lines) | PLS |
|---|---:|---:|---:|
| Male, old clips | 11.4 | 0.537 +- 0.025 | 121.5 |
| Male, search pick (2 clips) | 10.65 | 0.673 +- 0.017 | 115.5 |
| **Male, shipped (3 clips)** | 13.6 | **0.677 +- 0.022** | 115.7 |
| Female, old clips | 14.45 | 0.429 +- 0.043 | 100.3 |
| **Female, shipped = search pick (2 clips)** | 11.55 | **0.521 +- 0.011** | 100.0 |

The male pick is not the search's 2-clip winner: the two tie (0.677 vs 0.673, inside one standard error; the 3-clip set also scores
higher on the four test sentences, 0.70 vs 0.68), and the 2-clip winner opens with a crude, mocking joke line that would colour
every typed line, so the calm 3-clip set is shipped (3 seconds longer; OmniVoice adds about 42 ms per second of reference).
Honest note: PLS (spectral closeness, secondary) is a little higher for the old male clips. The old clips were clean; what they
lacked was likeness. The ASR matches the subtitles 0.98 to 1.00 for four of the five clips; the third male clip is 0.89 because the
actor says "assumed" where the subtitle says "assume" (the audio is clear).

- `assets/v-voice/v-voice.json` (committed): transcripts, hashes and the source lines (string id, file name, scene).
- `assets/v-voice/v-male.wav`, `v-female.wav` and `v-voice-build.json` are **kept out of git** (`.gitignore`) like the add-on
  clips; `packaging/build-release.mjs` packs them from the local copy into `voices/v-voice/` of the Runtime package. A build
  without them still works and says so; the setting then has no voice and stays silent.
- The bridge looks in `<voice references>/v-voice` first (the installed mod), then `assets/v-voice` (a source checkout), and
  checks each clip against the hash in the manifest.
- Rebuild: `scripts/clip-search/v-voice/` (`extract_v.py`, `build_v_pool.py`, `run_search.py`, `compare_v.py`, `asr_v.py`,
  `build_reference.py`; `analyze_v.py` is the first pass's own filter and its metrics feed `build_v_pool.py`). They need the game
  archives, `vgmstream-cli`, the Oodle library, the voice inventory, the scene index and the picker's ECAPA model, like
  `scripts/clip-search/delamain/`; set `CLIP_SEARCH_ROOT` (the main checkout) and `CLIP_SEARCH_WORK` (a work folder) so nothing is
  written on the game drive. CPU only; they play nothing.
- **The new clips have been judged by measurements, not yet by ear.** Comparison files (the old and new references, rendered test
  sentences, held-out real V lines) were written for the user to listen to; nothing is approved until they have.

## When V stays silent because Pocket did not start (2026-10-20, third round of error reports)

Pocket ships inside the Runtime (Python, the model, the Pocket source), so nothing is installed beforehand. A player asked whether it must be; the
reports showed two 0.2.2 installs (both Vortex, one with a RTX 4060, one with a RTX 5090) where Pocket failed at every start with "Pocket source
differs from the pinned official revision": Vortex had put its `__folder_managed_by_vortex` marker into the Runtime's folders, and the worker hashes
the whole `pocket-tts` tree (`digest_source`, `bridge/pocket_voice_runtime.py`; the marker is ignored from 0.2.3, with `desktop.ini`, `Thumbs.db` and
`.DS_Store`; it is the only place the tree is walked). Pocket then retried after 45 s, 180 s and 600 s with the same result, V's own Pocket worker
(`VHelperVoice`) failed once and stayed off, and typed lines stayed silent with no hint in the game. What changed:

- The worker's fatal frame carries a reason (`ValueError: Pocket source differs ...`), so the log line, `[VHelper]` line and the report name the
  cause instead of "Pocket student runtime is unavailable".
- A voice that could not start (Pocket, V's helper, OmniVoice) is an error report of its own, kind `voice-failed`, message `<engine>: <reason>`
  (`ErrorEvents.voiceFailed`, once per reason per bridge run).
- Settings > Help has a "Pocket voice" row while Pocket or V's helper is failed (setup check id `voice`, code `pocket-failed`, from
  `VoiceSelection.voiceProblem()`): it says nothing needs installing, to restart the game and to send a report if it happens again.
  When Windows refused to load a file of the voice (Smart App Control, or a company's or school's Application Control policy: "DLL load failed ... An Application
  Control policy has blocked this file", 2026-10-20, `edd41879c00ef0ae`) `voiceProblem()` carries `cause: 'blocked'` (`blockedByWindows`), the Pocket worker is not tried
  again (the same import would be blocked again, and it costs thirty seconds of CPU), and the row says Windows blocked a file, that Pocket cannot run on this PC and to choose
  another voice. The mod cannot change the policy.

### Fourth round (2026-10-20, 0.2.3 on Vortex: `26d9eb59191a945a` and `f309bd3f807c9dd0`)

The same message came back on a 0.2.3 install (Vortex, RX 6600, Convai text with the Pocket voice) that had ignored the marker and the Explorer files
and still failed within half a second at every start. That install went 0.2.1 -> 0.2.2 -> 0.2.3 in place, so the `pocket-tts` folder can hold anything
the earlier Runtimes and the manager left there; the report could not say what. So the check no longer asks "is the folder exactly the pinned tree":
`verify_source` (`bridge/pocket_voice_runtime.py`) reads `SOURCE_FILES`, the path and SHA-256 of each of the 140 files the pinned revision ships
(generated from the revision; `SOURCE_SHA256` is the digest of exactly that list, `digest_manifest()`), and looks only at those. Files that are not in the
list (Vortex markers, deployment files and `.vortex_backup`, `__pycache__`, a leftover from an older Runtime, an antivirus note) are ignored by design.
A listed file that is missing, changed or a link fails when it is under `pocket_tts/` or is a `.py` file (the code that runs), and the error names the
first three with what is wrong ("pocket_tts/x.py changed, y.py missing, +2 more", relative paths only; the reason the worker sends is 300 characters now,
so the log line and the error report carry them). A pinned README, test, notebook or picture that differs does not stop the voice; the worker logs one
line naming them. A text file whose line endings were converted to CRLF counts as unchanged. The list is inside `pocket_voice_runtime.py`, which the
Runtime already ships, so no new file travels; `packaging/build-release.mjs` refuses to build when the files it ships are not the list
(`packaging/lib/pocket-source-list.mjs`, `packaging/pocket-source-list.test.mjs`).

The other reason a V line is not heard on a working Pocket is time: loading Pocket takes 8 to 36 s after the game starts on the reports (importing the
libraries is the slow part and is made slower by a virus scanner looking at the freshly extracted files), and a typed line before it is ready is skipped
(`voice-not-loaded`, one per session in the reports); a line whose voice starts after the companion's reply has begun is dropped
(`reply-voice-started`, `slower-than-reply`; 1 to 3 of 12 to 40 lines on three installs). Those are by design.

## Where the code is

| Piece | File |
|---|---|
| Feature, clip loading, V's line, gate | `bridge/v-voice.mjs` |
| V's own Pocket worker (any companion voice but Pocket) | `bridge/v-helper-voice.mjs`, `bridge/voice-selection.mjs` (`pocketRoute`, `tickVHelper`, `vHelper*`, `vRouteSpeaks`) |
| Second renderer page | `bridge/realtime-host.mjs` (`playVoiceLine`, `prewarmVoiceLine`) |
| Config merge | `bridge/addons.mjs` (`voiceConfigPaths`, `extra`) |
| Wiring | `bridge/convai-bridge.mjs` (`vVoice`, `runInput`, `continuousSpeech` hold, `publishResult`, settings poll, composer warm-up) |
| Stage clock listener | `bridge/turn-clock.mjs` (`on`) |
| Dialogue volume | `mod/turn-context.lua`, `bridge/turn-context.mjs` (`dialogueVolume`) |
| Setting | `mod/manager.lua` (`vVoice`, `vVoiceChosen`, `vVoiceEngine`), `mod/manager-ui.lua` |
| Simulated measurement | `scripts/Measure-VVoice.mjs` (`--legacy`, `--runs`, `--prep`, `--json`) |
| V's subtitle | `mod/subtitles.lua` (`showTyped`), `mod/init.lua` (the submission in `onUpdate`), `bridge/subtitles.test.mjs` |
| Grace, totals, remembered gender | `bridge/v-voice.mjs` (`V_GRACE_MS`, `VLine.startGrace`, `VVoice.count`, `VVoice.know`), `bridge/convai-bridge.mjs` (`vGenderMemory`, `onVHelperReady`) |
| Tests | `bridge/v-voice.test.mjs`, `bridge/v-helper-voice.test.mjs`, `bridge/manager.test.mjs`, `bridge/turn-context.test.mjs`, `bridge/addons.test.mjs` |

## Live check

See TODO.md, "Live checks still to run" (including the V's voice engine check of 2026-10-17: Pocket and Voxtral each audible, the reply start with each, the process list per combination, Voxtral refused without a key; Mature on no longer refuses it, 2026-10-20): V's gender follows the V voice, the clip sounds like V, V is heard before the
companion on Pocket (and on a cloud voice), the companion starts right after V ends, the dropped line on a cold start, the
volume follows the game's Dialogue volume, and, since 2026-10-17, V speaking beside the Convai voice.

**Clip choice (2026-10-14, by ear):** the user preferred the original male clips (11.4 s, 3 lines) over the picker's male set, and the picker's female set (11.55 s, 2 clips) over the original female clips. The manifest ships that mix.
