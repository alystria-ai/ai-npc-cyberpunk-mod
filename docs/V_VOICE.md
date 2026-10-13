# V's voice for typed lines

October 14, 2026. A setting that makes a typed line sound like V said it. With **Companion Manager > Settings > Voices > V's voice
for typed lines** on, whatever you type to a companion is also spoken aloud, in a male or female V voice cloned from V's own
lines in the game. Then the companion answers.

**Off by default.** Typed lines only: push-to-talk is never replayed (you already spoke it). Reactions, phone Chat, add-on
speakers and the later speakers of a group round never get a V line.

## What you hear, and in which order

1. You type a line and send it. The text goes to the companion's model at once, exactly as without the setting.
2. In parallel, V's line is synthesized and played, in V's voice, at the game's dialogue volume. It has no face, lip sync or
   subtitle: it is your own voice, not a game utterance.
3. When the companion's reply is ready, its audio waits (silently, buffered) only while V's line is still playing, then starts.
   The two never overlap.
4. **If V's line is not audible yet when the reply is ready, V's line is dropped.** The reply is never delayed to wait for V.
   The first line after a cold start can be dropped for this reason (the voice has to be prepared once); the composer warms
   the voice and the renderer page when it opens, so later lines are normally in time.

Any failure (a clone that cannot be made, a voice error, no audio in time) skips V's line, writes one `[VVoice]` log line and
never touches the conversation.

## Which voice speaks

V's gender comes from the turn context the game sends with a typed line (`gender`, read by `mod/turn-context.lua` from the
player puppet's resolved gender name). `v-male` or `v-female` is chosen from it. **Check in game that this follows V's voice
and not only V's body** (a V whose body and voice differ is the case that could pick the wrong clip; the save metadata has
`bodyGender` and `brainGender` separately, and the live check below covers it).

The voice is the one **you already chose** for companions:

| Companion voice | How V's line is made |
|---|---|
| Pocket TTS | cloned by the local Pocket worker (a lazy voice entry, prepared on first use) |
| OmniVoice | rendered whole by the local OmniVoice worker (short or long reference, as chosen), then played |
| Mistral (Voxtral) | cloned by the Mistral cloud voice with the player's Mistral key; **no local voice model is loaded** |
| Inworld | cloned (once) by the Inworld cloud voice with the player's own key; **no local voice model is loaded** |
| Convai cloud voice | **cannot clone, so the setting cannot be turned on beside it.** Turning it on while the Convai voice is saved is refused with a short message; choosing the Convai voice while it is on keeps the voice and turns V's voice off with one notice. A saved pairing of the two (an older or hand-edited file) loads as off. |

A cloud voice with no key, or a turn in a language the chosen voice cannot speak (Pocket speaks English only), gives no V line.
With the Mistral or local text route the Convai-voice setting maps to Pocket for the companion; the setting is still refused
beside it because the choice shown to the player is the Convai voice.

V has no model of its own: its two entries (`v-male`, `v-female`) are merged into the voice configurations the bridge already
loads (the same mechanism as an add-on's voice, `AddonHost.voiceConfigPaths` with `extra`). They are lazy, so merging them
changes nothing about what is loaded at start. Toggling the setting takes effect at once (no restart).

## Latency design

Latency is as important as FPS here, so V never stands in front of anything:

- The companion's text request is sent first; V's line starts after it (`runInput` starts `respond` and then `vVoice.start`).
- A V line is never started for a look-ahead (group) turn.
- V plays on a second hidden renderer page (`RealtimeHost.playVoiceLine`, a second `LocalPcmHost`), so it never waits for, or
  takes the place of, the companion's utterance. The game's single pending-request machinery is untouched.
- The companion's audio is held with the existing `hold` of the continuous speech (the one a look-ahead uses): the renderer
  keeps buffering and gets the quiet control, nothing is published to the game, so the subtitle and the face start exactly when
  the companion's voice does. A reply published as a whole (OmniVoice) waits in `publishResult` for the same signal.
- "Audible" means the V renderer holds audio. If the reply is ready first, V is dropped on the spot.
- Pocket and OmniVoice workers do one job at a time. When the companion's own text-to-speech request goes out (`ttsSent` on the
  turn's stage clock) and V's line is still waiting for its first audio, V is stopped so it is not in front of the reply's voice.
  A line that is already audible keeps going (the companion cannot be heard before it ends anyway). The cloud voices share no
  worker, so they are not stopped this way. (OmniVoice cannot cancel a render that has started, so a long V render can still
  occupy its one GPU worker; V's text is short and the render starts as soon as the text request is sent.)
- Nothing runs per frame. The game-side change is one extra read of the game's dialogue volume when a typed turn is built,
  and only while the setting is on (`mod/turn-context.lua`, cached with the rest of the turn context for 5 seconds).

### Timings

V's line runs under its own stage clock (`bridge/turn-clock.mjs`), so its marks never mix into the companion's. One log line per
line, and the same record in `runtime/bridge-latency.json` under `vVoice`:

`[VVoice] profile=judy-alvarez voice=v-male engine=pocket result=played marks={"voiceStart":0,"ttsSent":2.1,"firstPcm":...}`

Marks, in milliseconds after V's line started: `voiceStart`, `playStart`, `rendererReady`, `ttsSent` (the voice asked),
`firstPcm`, `firstPcmAccepted`, `audible` (the renderer holds audio), `synthDone`, `ended`, or `dropped` with a `reason`
(`slower-than-reply`, `reply-voice-started`, `turn-ended`, `failed`, `no-audio`). The companion's own clock also gets
`vAudible`, `vEnded` or `vDropped`, so the wait V caused (if any) is visible in its record.

## The reference clips

One short reference per gender, cut from V's own lines in the game archives (`v_*_m_*.wem` and `v_*_f_*.wem`), the same way the
add-ons got theirs. Chosen from calm quest lines with a plain 7 to 17 word subtitle, checked by a speech recogniser against the
subtitle, joined with 0.25 s gaps, 24 kHz mono. Male V: 11.4 s (three lines). Female V: 14.5 s (four lines).

- `assets/v-voice/v-voice.json` (committed): transcripts, hashes and the source lines (string id, file name, scene).
- `assets/v-voice/v-male.wav`, `v-female.wav` and `v-voice-build.json` are **kept out of git** (`.gitignore`) like the add-on
  clips; `packaging/build-release.mjs` packs them from the local copy into `voices/v-voice/` of the Runtime package. A build
  without them still works and says so; the setting then has no voice and stays silent.
- The bridge looks in `<voice references>/v-voice` first (the installed mod), then `assets/v-voice` (a source checkout), and
  checks each clip against the hash in the manifest.
- Rebuild: `scripts/clip-search/v-voice/` (`extract_v.py`, `analyze_v.py`, `asr_v.py`, `build_reference.py`). They need the game
  archives, `vgmstream-cli`, the Oodle library and the voice inventory, like `scripts/clip-search/delamain/`. CPU only; they play
  nothing.
- **Nobody has listened to these clips yet and they are not approved.** The ASR matches the subtitles (0.94 to 1.00), which says
  the audio is the line, not that it sounds like a good reference.

## Where the code is

| Piece | File |
|---|---|
| Feature, clip loading, V's line, gate | `bridge/v-voice.mjs` |
| Second renderer page | `bridge/realtime-host.mjs` (`playVoiceLine`, `prewarmVoiceLine`) |
| Config merge | `bridge/addons.mjs` (`voiceConfigPaths`, `extra`) |
| Wiring | `bridge/convai-bridge.mjs` (`vVoice`, `runInput`, `continuousSpeech` hold, `publishResult`, settings poll, composer warm-up) |
| Stage clock listener | `bridge/turn-clock.mjs` (`on`) |
| Dialogue volume | `mod/turn-context.lua`, `bridge/turn-context.mjs` (`dialogueVolume`) |
| Setting | `mod/manager.lua` (`vVoice`), `mod/mcm.lua` |
| Tests | `bridge/v-voice.test.mjs`, `bridge/manager.test.mjs`, `bridge/turn-context.test.mjs`, `bridge/addons.test.mjs` |

## Live check

See TODO.md, "Live checks still to run": V's gender follows the V voice, the clip sounds like V, V is heard before the
companion on Pocket (and on a cloud voice), the companion starts right after V ends, the dropped line on a cold start, the
volume follows the game's Dialogue volume, and the Convai voice refusal message.
