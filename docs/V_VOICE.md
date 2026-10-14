# V's voice for typed lines

October 14, 2026. A setting that makes a typed line sound like V said it. With **Companion Manager > Settings > Voices > V's voice
for typed lines** on, whatever you type to a companion is also spoken aloud, in a male or female V voice cloned from V's own
lines in the game. Then the companion answers.

**On by default** (new installs, and saved settings that never stored it; a player who turned it off keeps it off). The first version saved `false` as its default, so a saved `false` counts only when the player set it (an Apply that carried it stores `vVoiceChosen`, the same pattern as Expressive emotions and the holocall live picture); an unchosen `false` becomes `true` when the settings load, in `mod/manager.lua` and in the bridge's read of `runtime/settings.json`. Typed lines only: push-to-talk is never replayed (you already spoke it). Reactions, phone Chat, add-on
speakers and the later speakers of a group round never get a V line.

## What you hear, and in which order

1. You type a line and send it. The text goes to the companion's model at once, exactly as without the setting.
2. In parallel, V's line is synthesized and played, in V's voice, at the game's dialogue volume. It has no face or lip sync: it
   is your own voice, not a game utterance. Its words are shown as **V's subtitle** (below).
3. When the companion's reply is ready, its audio waits (silently, buffered) only while V's line is still playing, then starts.
   The two never overlap.
4. **If V's line is not audible yet when the reply is ready, V's line is dropped.** The reply is never delayed to wait for V.
   The first line after a cold start can be dropped for this reason (the voice has to be prepared once); the composer warms
   the voice and the renderer page when it opens, so later lines are normally in time.

Any failure (a clone that cannot be made, a voice error, no audio in time) skips V's line, writes one `[VVoice]` log line and
never touches the conversation.

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

## Which voice speaks

V's voice follows **V's voice tone** from the character creator (the "brain gender"), not V's body: a V built with a male voice
speaks with `v-male` whatever the body, as the game's own V lines do. `mod/turn-context.lua` reads it from the character
customization state (`IsBrainGenderMale`) and sends it as `voice`; only when that read fails does it fall back to the resolved
gender (`gender`). `voice` is never written into the model's context.

The voice is the one **you already chose** for companions:

| Companion voice | How V's line is made |
|---|---|
| Pocket TTS | cloned by the local Pocket worker (a lazy voice entry, prepared on first use) |
| OmniVoice | spoken by a **Pocket worker on the CPU that loads beside OmniVoice** (see "OmniVoice companions" below); V is never rendered on OmniVoice. English only |
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

**The rule "cloud voice loads no local model" is untouched:** the helper never exists beside Mistral (Voxtral), Inworld or the Convai
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
- A failure (the worker cannot start or dies) leaves the helper off with one log line (`[VHelper] ... failed`) until V is turned
  off and on, or the voice changes: no retry loop, and V is silent, never rendered on OmniVoice instead.
- Pocket speaks English only: a non-English turn (Multilingual conversations) gets no V line beside OmniVoice, with one log line.
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
`firstPcm`, `firstPcmAccepted`, `audible` (the renderer holds audio), `synthDone`, `ended`, or `dropped` with a `reason`
(`slower-than-reply`, `reply-voice-started`, `turn-ended`, `failed`, `no-audio`). The companion's own clock also gets
`vAudible`, `vEnded` or `vDropped`, so the wait V caused (if any) is visible in its record.

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

## Where the code is

| Piece | File |
|---|---|
| Feature, clip loading, V's line, gate | `bridge/v-voice.mjs` |
| Helper Pocket voice beside OmniVoice | `bridge/v-helper-voice.mjs`, `bridge/voice-selection.mjs` (`tickVHelper`, `vHelper*`) |
| Second renderer page | `bridge/realtime-host.mjs` (`playVoiceLine`, `prewarmVoiceLine`) |
| Config merge | `bridge/addons.mjs` (`voiceConfigPaths`, `extra`) |
| Wiring | `bridge/convai-bridge.mjs` (`vVoice`, `runInput`, `continuousSpeech` hold, `publishResult`, settings poll, composer warm-up) |
| Stage clock listener | `bridge/turn-clock.mjs` (`on`) |
| Dialogue volume | `mod/turn-context.lua`, `bridge/turn-context.mjs` (`dialogueVolume`) |
| Setting | `mod/manager.lua` (`vVoice`, `vVoiceChosen`), `mod/mcm.lua` |
| V's subtitle | `mod/subtitles.lua` (`showTyped`), `mod/init.lua` (the submission in `onUpdate`), `bridge/subtitles.test.mjs` |
| Tests | `bridge/v-voice.test.mjs`, `bridge/v-helper-voice.test.mjs`, `bridge/manager.test.mjs`, `bridge/turn-context.test.mjs`, `bridge/addons.test.mjs` |

## Live check

See TODO.md, "Live checks still to run": V's gender follows the V voice, the clip sounds like V, V is heard before the
companion on Pocket (and on a cloud voice), the companion starts right after V ends, the dropped line on a cold start, the
volume follows the game's Dialogue volume, and the Convai-voice case (setting on, no V line, the inline note on the row, no notice).

**Clip choice (2026-10-14, by ear):** the user preferred the original male clips (11.4 s, 3 lines) over the picker's male set, and the picker's female set (11.55 s, 2 clips) over the original female clips. The manifest ships that mix.
