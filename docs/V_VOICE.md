# V's voice for typed lines

October 14, 2026. A setting that makes a typed line sound like V said it. With **Companion Manager > Settings > Voices > V's voice
for typed lines** on, whatever you type to a companion is also spoken aloud, in a male or female V voice cloned from V's own
lines in the game. Then the companion answers.

**On by default** (new installs, and saved settings that never stored it; a player who turned it off keeps it off). Typed lines only: push-to-talk is never replayed (you already spoke it). Reactions, phone Chat, add-on
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

V's voice follows **V's voice tone** from the character creator (the "brain gender"), not V's body: a V built with a male voice
speaks with `v-male` whatever the body, as the game's own V lines do. `mod/turn-context.lua` reads it from the character
customization state (`IsBrainGenderMale`) and sends it as `voice`; only when that read fails does it fall back to the resolved
gender (`gender`). `voice` is never written into the model's context.

The voice is the one **you already chose** for companions:

| Companion voice | How V's line is made |
|---|---|
| Pocket TTS | cloned by the local Pocket worker (a lazy voice entry, prepared on first use) |
| OmniVoice | rendered whole by the local OmniVoice worker (short or long reference, as chosen), then played |
| Mistral (Voxtral) | cloned by the Mistral cloud voice with the player's Mistral key; **no local voice model is loaded** |
| Inworld | cloned (once) by the Inworld cloud voice with the player's own key; **no local voice model is loaded** |
| Convai cloud voice | **cannot clone, so the setting stays on but is inactive beside it:** no V line plays, nothing is refused, no notice is shown at load or Apply, and nothing is switched off. The setting row shows one short note ("Works with the Pocket, OmniVoice, Voxtral or Inworld voices."). Choosing a cloning voice makes it work at once. |

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

One reference per gender, cut from V's own lines in the game archives (`v_*_m_*.wem` and `v_*_f_*.wem`). **Male V: 13.6 s (three
lines). Female V: 11.55 s (two lines).** 24 kHz mono, whole trimmed clips joined with 0.4 s gaps (the project's reference recipe),
best clip first (one cloud voice cuts its reference to about the first 8.5 s).

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
volume follows the game's Dialogue volume, and the Convai-voice case (setting on, no V line, the inline note on the row, no notice).

**Clip choice (2026-10-14, by ear):** the user preferred the original male clips (11.4 s, 3 lines) over the picker's male set, and the picker's female set (11.55 s, 2 clips) over the original female clips. The manifest ships that mix.
