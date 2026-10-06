# Natural speech: listening test, findings and prompt-layer draft (October 6)

Groundwork for a future in-game "Natural speech" setting (companions that pause, say "hm", trail off). Nothing is implemented in the mod. The test is **paused** (see "Left to do"): the reference clips are about to change, so the renders must be redone with the new references before anyone relies on them.

**Read this first.** The measurements below come from silence detection and duration arithmetic on the rendered audio, not from listening. The author of the test could not hear the clips, and Whisper was deliberately not run. Statements like "a hum" or "breathy" are inferred from acoustic cues and are provisional until the user listens.

## What was rendered

- Page (labeled, not blind): `E:\CyberpunkConvai-offload\work\natural-speech\page\index.html`. Once the picker is restarted it is also at http://127.0.0.1:8765/natural-speech/ (read-only route, see "Picker route").
- Rows: character x line. Columns: variant x engine (Pocket, Omni 16, Omni 32). Each variant's text sits above its row of players, with the measured pauses under each player. Extra sections: the same lines rendered phrase by phrase the way the bridge sends them to OmniVoice, a tag probe, an isolated-filler probe.
- Characters: Judy, Johnny, Panam, Takemura. Two original in-character lines each (not game dialogue; `scripts/natural-speech/lines.json`), five variants of the same content:
  - v1 plain, as an LLM writes it
  - v2 punctuation pauses (commas, em dashes, "...")
  - v3 light fillers ("Hm,", "Mm,", "I mean —")
  - v4 heavy fillers, a ceiling ("Hm... okay, so, uh, ... mm ... I mean, ... Well...")
  - v5 a token: OmniVoice `[laughter]` or `[sigh]`; Pocket has no tags, so it gets a spelled fallback ("Heh." or "Haah.")
- Engines and references: the proposed 18 s three-clip references (`runtime/local-voices.multiref.json`, `runtime/pocket-voices.multiref.json`).
  - Pocket: student 5,000 raw with the fine-tuned decoder A (`E:\CyberpunkConvai-offload\work\mimi-dec\exports\s5000-raw-decA\`), CPU float32, through the bridge worker's own calls (`TTSModel.load_model`, `generate_audio_stream(..., frames_after_eos=1)`), temperature 0.3. Unseeded, like the bridge.
  - OmniVoice: the bridge's `backend.generate` call at 16 and 32 steps (FP16, guidance 2.0, denoise off, seed 1042, no CUDA graph).
- Counts: 40 lines x 3 engines, 40 x 2 phrase-chunked Omni renders, 7 tags x 2 voices x 2 step counts, 13 fillers x 2 voices x 3 engines, plus 32 noise renders (v1 and v2 re-rendered with other seeds).
- Scripts (all under `scripts/natural-speech/`): `render-omni.py`, `render-pocket.py`, `measure-pauses.py`, `measure-fillers.py`, `build-page.py`. Raw numbers: `E:\CyberpunkConvai-offload\work\natural-speech\measurements.json` and `fprobe.json`. The machine was in the Balanced power profile and the game was running, so render times mean nothing.

Pause method: 10 ms RMS frames; silent when more than 38 dB below the file's 90th-percentile level (and under -45 dBFS); only internal silences of 150 ms or more count; the word a pause follows is placed by proportional character alignment, so it is approximate.

## What the engines do

### OmniVoice (16 and 32 steps behave alike)

- **Total length is fixed by the text, before sampling.** Every file has the identical duration at 16 and 32 steps, and three seeds give a duration spread of 0.00 s. Only where the silence falls changes with the seed (spread of the paused total across seeds: mean 0.3 to 0.4 s, up to 0.9 s). Consequence: you cannot get a longer pause by asking nicely; the model spends a duration budget derived from the tokens.
- **Plain text is already paced.** Plain replies (about 7.2 s) have 2.6 pauses of 150 ms or more, 1.0 to 1.2 s in total, longest 0.53 to 0.56 s (the usual comma and sentence-end gaps).
- **Ellipsis and em dash add almost nothing.** v2 vs v1 is +0.12 s on 6 of 8 lines and +0.08 s on the other two, the same at both step counts. The measured paused-total change (+0.25 s at 16, +0.06 at 32) is inside the seed noise. So "..." and "—" work like a slightly heavier comma. They are safe (no artifacts found in the measurements) but they do not make the dramatic pause the text implies.
- **Fillers are rendered as sound, not skipped.** Each added filler word adds 0.66 s to the line at light density (0.42 to 0.51 s of speech plus 0.16 to 0.26 s of pause) and 0.47 s at heavy density (0.33 to 0.39 s speech). Speech time rising per filler is the evidence they are voiced. Heavy (v4, 5.4 fillers per line) makes a 7.2 s line 9.8 s (+36%).
- **Isolated fillers** (acoustic cues only): "Hm.", "Mm.", "Mm-hm.", "Hmm..." come out as 0.4 to 1.1 s, almost entirely under 1 kHz (centroid roughly 200 to 270 Hz, 94 to 99% of energy below 1 kHz) and mostly voiced, which looks like a closed-mouth hum. Caveat: the real-word controls ("Home.", "Ham.", "Hum.") also sit low, so this separates hums from hiss, not from a spoken "hum". "Uh," and "Um," are 0.4 to 0.7 s with more vowel-like spectra. "Ha." and "Heh." look breathy rather than voiced (Judy at 16 steps: centroid 3.2 kHz, 3% below 1 kHz, 11% voiced); whether that sounds like a laugh needs listening.
- **Tags reserve a time slot.** In the lines, `[laughter]` adds 0.60 to 0.88 s and `[sigh]` 0.32 to 0.48 s (the same at 16 and 32 steps). The sound starts at once (lead silence about 0.15 s with the laugh tag). Probe, "Yeah, I get it. [tag] Let's go.", total length: sigh 2.16 / 2.28 s (Judy / Johnny), laughter 2.48 / 2.64, question-en, surprise-oh and surprise-ah 2.68 / 2.84, confirmation-en 3.00 / 3.20, dissatisfaction-hnn 3.32 / 3.56. Documented English tags: `[laughter]`, `[sigh]`, `[confirmation-en]`, `[question-en]`, `[surprise-ah]`, `[surprise-oh]`, `[dissatisfaction-hnn]` (also `-ah/-oh/-ei/-yi/-wa/-yo` variants for other languages; source: `vendor/reference-omnivoice-training/omnivoice/models/omnivoice.py`, `README.md`). Whether each sounds right is for the user's ear.
- **Phrase chunking (what the bridge really sends).** `bridge/speech-stream.mjs` splits every reply into phrases of 6 to 34 words and renders each in its own call; 38 of the 40 test lines split into 2 or 3 phrases. Chunked renders are about 0.2 s longer and have about the same pause statistics (v1 at 16 steps: 3.0 pauses and 1.36 s, whole: 2.6 and 1.00; at 32 steps 2.4 and 1.11 vs 2.6 and 1.18), so chunking does not break the devices, but the voice's prosody resets at each phrase edge.
- **16 vs 32:** no systematic difference in these measures. At heavy density 32 steps showed more discrete pauses (6.5 vs 4.9 per line, 2.06 vs 1.55 s) with n=8; treat as unproven.
- **Reference caveat.** OmniVoice removes reference silences longer than 200 ms when it builds the voice prompt (`preprocess_prompt`), so the references teach it short pauses. That may be part of why punctuation barely stretches pauses.

### Pocket (student 5,000 raw + decoder A, CPU)

- **Pauses are generated by the model, not budgeted, and are long and noisy.** Plain replies (7.4 s) already have 2.2 pauses of 150 ms or more, 1.45 s in total, longest 0.75 s. Re-rendering the same text with other seeds changes the length by 0.48 s on average (up to 0.96 s) for v1 and 0.70 s (up to 1.68 s) for v2, and the paused total by 0.34 to 0.55 s. Any single-render difference below about 1 s between two Pocket variants is therefore noise.
- **Ellipsis and dash:** v2 vs v1 is +0.72 s on average (per line 0.00 to +2.40 s), the same size as the seed noise, so a real effect is possible but unproven with 8 lines. Upstream text prep treats "..." as a sentence boundary (`text_chunking.py`), and chunks are packed up to 50 tokens, so most test lines were one or two chunks.
- **Fillers lengthen Pocket a lot.** Light density takes a line from 7.4 s to 10.4 s, heavy to 13.5 s (+82%). Per filler: +1.46 s at light (0.60 s speech, 0.80 s pause) and +1.14 s at heavy. Pauses around fillers reach 1.0 to 1.7 s. The same heavy text runs 18.4 s on Pocket against 12.3 s on Omni for Judy line 1. That is probably too sluggish and "stagey"; confirm by ear.
- **Isolated fillers are mostly lost.** Judy "Hm." is a 0.1 s blip, "Hmm..." 0.8 s of very quiet audio, "Mm." 0.06 s. Johnny "Hm." and "Hmm..." are **digital silence** (peak 0.0000, 0.56 to 0.72 s long), and Johnny's "Heh." is a 0.09 s click (Judy's is 0.33 s). Inside a longer sentence fillers did add voiced time, so the problem is partly short out-of-distribution input, but a leading "Hm." or "Hmm..." should be assumed unreliable on Pocket.
- **No non-verbal tags.** The Pocket tokenizer and source have no laugh or breath token (checked `tokenizer.json` and `pocket_tts`). The spelled fallbacks ("Heh.", "Haah.") added 0.56 to 1.60 s in seven lines, one went 0.56 s shorter (noise); what they sound like needs listening, but the isolated "Heh." probes suggest a click, not a laugh.

### Summary table (means over the 8 lines)

| Variant | Pocket | Omni 16 | Omni 32 |
|---|---|---|---|
| v1 plain | 7.4 s, 2.2 pauses, 1.45 s paused | 7.2 s, 2.6, 1.00 | 7.2 s, 2.6, 1.18 |
| v2 punctuation | 8.2 s, 2.8, 2.06 | 7.3 s, 2.9, 1.25 | 7.3 s, 2.8, 1.24 |
| v3 light fillers | 10.4 s, 4.8, 3.05 | 8.5 s, 4.1, 1.52 | 8.5 s, 4.0, 1.51 |
| v4 heavy fillers | 13.5 s, 7.1, 4.45 | 9.8 s, 4.9, 1.55 | 9.8 s, 6.5, 2.06 |
| v5 token | 8.2 s, 3.1, 1.90 | 7.8 s, 3.0, 1.18 | 7.8 s, 2.9, 1.12 |

## Recommended devices, by engine and archetype (provisional, pending listening)

**By engine**
- OmniVoice only. Light fillers ("Hm,", "Mm,", "uh"), a single self-correction at most, and an occasional leading `[sigh]` or `[laughter]`. Punctuation is free but weak. Keep "..." for the text itself (captions) rather than as a pause control.
- Pocket: punctuation only (commas, one "—" or "..." per reply); no leading fillers, no tags. It already pauses a lot on its own.
- Convai cloud voice: none (its text comes from the same reply and its voice reads fillers as words).

**By archetype** (probability that a given reply gets any device is enforced by the bridge, not the model; "max" is per reply)

| Archetype | Characters (tier 1 examples) | Devices | Share of replies | Max per reply |
|---|---|---|---|---|
| Warm, quick, talky | Judy, Jackie, Misty, River | "Mm,", "hm", "I mean —", trailing "..." before something vulnerable, a short laugh | about 1 in 3 | 1 filler, 1 punctuation device |
| Practical, articulate | Panam, Viktor | "Hm," while working a plan, "okay, so", a laugh at something absurd; no stumbles when giving orders | about 1 in 3 | 1 filler |
| Dry, abrasive | Johnny, Rogue, Kerry | cut-off em dash, a flat "Heh." or "Hm.", trailing off only in quiet moments; almost no "uh" or "mm" | about 1 in 5 | 1 device |
| Formal, deliberate | Takemura, Hanako | a deliberate "Hm." or silence (comma, "..."), restating instead of stumbling; never "uh" or "um" | about 1 in 5 | 1 device |

No device on action turns (battle, loot, distraction reactions, orders), on replies under 8 words, or on the first turn of a session. Heavy density never ships; at Omni's rate it costs about 0.5 s per filler and sounds like a ceiling.

## Draft speaking-style profiles (personality first, dialogue only lightly)

Source: the speaking-style fields in `characters/profile-text/<key>.txt`, which describe delivery in the fan-written editorial voice. All four already say "one or two sentences", "no stage directions". The profiles below are what a future `natural-speech` data file would hold per character. Every one is a draft for the user to edit.

**Judy Alvarez** (warm, quick, practical)
- Style: direct, colloquial, dry jokes, impatient when someone dodges a practical problem; exact about hardware, human when it matters; quiet rather than melodramatic when sad; "a pause before saying something vulnerable".
- Devices: a short "Mm," or "Hm," while she works something out; "I mean —" to correct herself when she is being precise or backing away from a harsh first phrase; "..." only before a vulnerable line; a short laugh on her own jokes. Technical explanations stay fluent.
- Avoid: stumbling in the middle of technical explanations, "uh" in every sentence, sighing as a default, putting Spanish in as a filler.
- Rate: about 1 reply in 3; vulnerable moments get the pause, jokes get the laugh.

**Johnny Silverhand** (dry, abrasive, short attacks)
- Style: short attacks, pauses and abrupt switches from mockery to conviction; funny, curious or unexpectedly quiet; defensive sarcasm that gives way to a plain admission if earned.
- Devices: an em-dash cut-off when he swerves; a flat "Heh." or "Hm." as a beat before a jab; the "..." trail only for the rare quiet admission; occasional "Yeah, well," as a lead-in.
- Avoid: hesitation fillers ("uh", "um"), repeated stumbling, laughing at his own lines, sighing as a performance.
- Rate: about 1 reply in 5; heavier only in the quiet admission case.

**Panam Palmer** (articulate, practical, firm cadence)
- Style: direct full sentences, plans as sequences, checks that the listener is coming, terse under pressure; quick anger when loyalty is questioned but can admit fear and laugh at the absurd; curious and teasing in calm company.
- Devices: "Hm," or "Okay, so," as she thinks through a route or plan; a trailing "..." when she is angry and holding back; a real laugh at an absurd moment; no stumbling when giving orders.
- Avoid: fillers under pressure or in combat, "uh", folksy proverbs, pet names.
- Rate: about 1 reply in 3 in calm company, none under pressure.

**Goro Takemura** (formal, deliberate, blunt corrections)
- Style: clear, deliberate sentences, formal politeness, occasional blunt correction; dry humour, practical concern (eat, stay alert); short instructions during operations; in downtime can ask sincere questions and listen.
- Devices: a deliberate "Hm." before a considered answer or correction; a "..." pause before something personal (home, family, duty); correction by restating ("It is blocked. Correction: both are watched.") instead of "I mean —"; a rare quiet laugh at dry humour.
- Avoid: "uh", "um", "mm", sighs, stumbling, accent spelling, proverbs.
- Rate: about 1 reply in 5; none during operations.

## Prompt-layer design (draft; verified against the code on October 6)

### What exists today

- Per-turn context goes to Convai as a Web SDK `context-update` message `{mode:'replace', run_llm:'false', text}` (`bridge/realtime-client.mjs`, `updateContext`, about lines 647 to 682). The text starts with a fixed preface ("Reply briefly without stage directions...") plus `config.context`. Because the mode is `replace`, whatever the bridge sends on a turn does not linger into the next one.
- The bridge builds `config.context` in `conversationContext` (`bridge/convai-bridge.mjs` about lines 262 to 271): intrinsic character context, relationship context, phone recent rows. Its base layer is `conversationContext` in `bridge/quest-context.mjs` (about lines 114 to 121), which ends with `SPOKEN_OUTPUT` ("Speak only your own dialogue...") and the follow-up policy. `realtimeConfig` (convai-bridge.mjs about lines 279 to 283) already knows the engine through `localVoice.usesProfile(profileKey)`.
- Static speaking style is a Convai character field (`speaking_style_description`, written by `scripts/Build-CharacterProfiles.mjs`, pushed by `scripts/Provision-Characters.mjs`). It says "no stage directions" and "one or two sentences"; the 79 profiles' sample dialogues contain almost no speech devices (2 with an ellipsis, 9 with an em dash, 1 filler), so today's replies seldom contain any.
- Reply text is not sanitized anywhere between Convai and the engines. It goes verbatim to subtitles, Omni (after `splitSpeechText`), Pocket, memory and the journal. A "..." or "—" survives; `[laughter]` would survive to Omni (native) and be spoken literally by Pocket and Convai. Lip sync and facial timelines are audio-derived, so fillers do not break them.
- Settings travel from the CET/MCM (`mod/mcm.lua`, `mod/manager.lua` `applySettings`, allowlist and booleans) into `runtime/settings.json`, which the bridge polls every 500 ms.

### Design

1. **Data, not Convai fields.** A new local file, for example `characters/natural-speech.json`, keyed by profile key: `archetype`, `share` (probability), `minGapTurns`, `devices` (allowed list), `avoid`, and a 1 to 2 sentence `habit` text (the profiles above). Tier 1 are hand-written; every other character takes its archetype default. Do not edit the Convai static fields: they apply to every engine and to phone and reaction turns, cannot be toggled, and would need re-provisioning of 79 profiles plus variants.
2. **One injected block, last in the context.** A new `naturalSpeechContext(input)` is appended at the end of the array in `conversationContext` (convai-bridge.mjs) so it sits after `SPOKEN_OUTPUT` and wins. Draft text when the gate passes:
   > Delivery for this reply only: speak like a person thinking aloud. {habit} Use at most one hesitation (a short "hm", "mm" or a self-correction like "I mean —") and only where it feels natural; punctuation pauses (commas, an em dash, "...") are fine. Write them as plain words and punctuation, never as stage directions, asterisks or brackets. Keep the reply to the same length and content you would give otherwise.

   When the limiter says no, inject nothing (not "avoid fillers"); the `replace` mode means a skipped turn is clean.
3. **Gate (all must hold):** setting on; the turn's engine is a local OmniVoice profile (`localVoice.provider === 'omni' && localVoice.usesProfile(profileKey) && playbackEnabled !== false`); the channel is a spoken private or group turn (not `phone`, not a battle, loot or distraction reaction, not companion-action offers); and the limiter allows. Pocket stays off in v1; revisit only if listening shows its punctuation or fillers help. Convai's cloud voice is always off.
4. **Rate limit in the bridge, not in the prompt.** Keep a per-`sessionKey(input)` counter in the bridge: a turn is eligible when at least `minGapTurns` turns have passed since the last hinted turn and a deterministic hash of (session, turn index) falls under the character's `share`. This keeps fillers occasional and independent of the LLM's counting. Add a safety net on the reply: if the reply has more than 1 hesitation word plus 1 other device (or more than 2 "..."), a small `limitDevices(text)` pass trims the extras before TTS and subtitles. Also skip the hint on replies the bridge expects to be short (under 8 words) and on the first turn of a session.
5. **Pauses that actually pause.** Omni does not stretch for "..." or "—" (+0.12 s), and Pocket's pauses are noisy. If the user wants real trailing-off pauses, add a post-render step: when a phrase ends with "..." (or an em dash), the bridge inserts 250 to 400 ms of PCM silence after that phrase's audio before the next. This is deterministic, engine-independent, and uses the existing phrase boundaries from `splitSpeechText` (phrases only split at 6 or more words, so a short "Hm..." merges into its phrase; accept that or lower the minimum for a leading "Hm..."). Needs a listening test.
6. **Tags.** The LLM never writes tags (a bracketed tag looks like a stage direction and is spoken literally by other engines). If listening shows `[laughter]` and `[sigh]` are good, a bridge-side Omni-only mapper turns an opening standalone "Heh." or "Haha." into `[laughter]` and "Haah." into `[sigh]` just before synthesis. Display text for subtitles must keep the original word, which means `SpeechStream.phrases` would carry separate speech text and display text (a change to `bridge/speech-stream.mjs`, the Omni path and Pocket's text argument together).
7. **Subtitles.** Fillers appear in captions as written, on every engine. Choose: show them (simple, honest) or strip leading "Hm," style fillers and tags from the display copy only. Default to showing them.
8. **Memory feedback risk.** Replies are stored verbatim in Convai's session history, in the shared experience writes (`bridge/knowledge-service.mjs`), in group "heard" rows and phone recent rows, so the model sees its own fillers and may imitate them (escalation). Mitigations: sparse hints, "at most one" wording, and the `limitDevices` trim; consider stripping device words from the copies sent to group "heard" and phone recent rows.
9. **Setting plumbing.** Add a boolean `naturalSpeech` (default off) to the MCM allowlist and `runtime/settings.json`; the bridge reads it in its existing 500 ms settings poll, next to `localVoice.update`. Because the hint is added by the bridge (not stamped into each request by Lua), the look-ahead identity checks (`quest-context.mjs`, `group-lookahead.mjs`, `group-prefetch.mjs`, `microphone-session.mjs`, `intrinsic-character-context.mjs`) do not need a new field as long as the decision is made at `conversationContext` time, but `completeContext`'s engine marker should include the flag so a mid-round toggle invalidates a stale context.
10. **Testing.** `scripts/Check-ConversationStyle.mjs` (fresh Convai session per turn) can A/B the hint on text alone: count devices per reply with and without it, over 20 turns per character, before involving audio.

## Picker route

`scripts/reference-picker/natural-speech-page.mjs` (with a test) serves the page read-only: `GET /natural-speech/` returns `index.html`, `/natural-speech/audio/<engine>/<file>.wav` the clips, nothing else (path-traversal and extension guarded; the folder is `E:\CyberpunkConvai-offload\work\natural-speech\page`, or `NATURAL_SPEECH_PAGE`). `server.mjs` has a two-line hook (an import and one `if` before the `/api/` route). The running picker was not restarted, so the route goes live on its next start. `server.mjs` also carries another agent's uncommitted edits, so the hook is left in the working tree and was not committed by this task.

## Left to do

- Re-render everything with the new references once they exist (the scripts take the multiref configs; point them at the new files) and re-measure.
- The user's listening verdicts: do the fillers sound like "hm" on Omni, is `[laughter]` a laugh, is the Pocket heavy variant too sluggish, which tags (confirmation, dissatisfaction, surprise) are usable.
- If wanted: a seed-averaged measurement for Omni's pause placement (3 seeds were done only for v1 and v2), the silence-insertion experiment from design point 5, and the Convai text-only A/B from point 10.
- Do not implement the setting until the listening verdicts are in.
