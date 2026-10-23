# Pocket TTS 4.0 non-English models cloned from the dub voice packs (2026-10-22)

**Verdict: adopt, all five languages (fr, it, de, es, pt).** Each Pocket language model is an optional download that needs the same language's voice pack installed; the worker loads one language model at a time, on demand, and drops it when unused.
Branch `exp/pocket-v4-dub`. Nothing in the worker or the bridge was changed; this is the measurement and the plan. Numbers: `docs/POCKET_V4_MULTILINGUAL_EVAL_2026-10-22.results.json` (every score, every transcript, every timing). Scripts: `scripts/pocket-v4-dub/`.

The earlier evaluation (`docs/POCKET_V4_EVAL_2026-10-21.md` on `exp/pocket-v4`) found the v4 language models weak (ECAPA 0.22 to 0.38) because it cloned from the English actors' clips. Cloned from the dub clips of the new voice packs they score 0.50 to 0.57, speak every test sentence intelligibly, and run at the same speed as our English student.

## What was tested

- Models: the five standard 100M v4 language models (`languages/{french,italian,german,spanish,portuguese}`, 219,029,196 bytes each) from `kyutai/pocket-tts-without-voice-cloning` at revision `a7056f50`, plus their tokenizers. Not the `_24l` models (672 MB each; not tested).
- **Spliced encoder (caveat).** The public weights have the 42 Mimi encoder tensors zeroed, and the real cloning weights are in the gated repo `kyutai/pocket-tts` (not accessible here). As in the 2026-10-21 evaluation, the 42 encoder tensors of the shipped English student were spliced in (`scripts/pocket-v4-dub/build_models.py`). Everything else is Kyutai's language model. The result is "v4 language model with our encoder", not the official cloning weights; the real ones may clone better or worse. Re-run `build_models.py` and `score.py` with them before release (the owner would have to accept the repo's terms).
- Characters: panam-palmer, judy-alvarez, jackie-welles, resident-female, v-male. Sentences: the 3 pack-check sentences of each language (`deliverables/voice-packs/<pack>/check/results.json`). 5 characters x 3 sentences x 2 clone sources x 5 languages = 150 renders, one at a time.
  - (a) cloned from the pack's dub clip (`voices/multilingual/<pack>/picked|v-voice/<key>.wav`, read from the installed pack).
  - (b) cloned from the English clip (`check/ref/<key>.en-ref.wav`, the OmniVoice check's baseline).
- Worker settings: temperature 0.3, one decode step, `eos_threshold` -1.0, no noise clamp, `frames_after_eos=1`, `copy_state=True`, `get_state_for_audio_prompt(path, truncate=False)`, 4 torch threads (the registry's `threads`), 1 interop thread, CPU only. Python 3.12, pocket-tts 4.0.0, torch 2.14.1, `python -X utf8` (Kyutai's YAML needs it on Windows).
- Speaker similarity: ECAPA (speechbrain/spkrec-ecapa-voxceleb), the three sentences joined with 0.3 s gaps, cosine against the dub clip. This is the OmniVoice pack check's method (`pack-check-analyze.py`), so the numbers compare. The OmniVoice figures below are the ones in each `results.json`.
- Intelligibility: **Parakeet-TDT-0.6b-v3 int8, not Whisper.** The only Whisper models on this machine are English (`.en`); Parakeet v3 is the multilingual recognizer the mod already ships (`models/stt`), covers all five languages, and was run through sherpa-onnx. Score = 1 - Levenshtein / max length on lower-cased text without punctuation (character level), per sentence. The same score was computed for the OmniVoice pack-check renders of the same sentences.
- Speed: first audio (request to first PCM chunk, reference state ready) and real-time factor (render seconds / audio seconds) per sentence, after one discarded warm-up. The laptop was not idle: Windows Balanced plan, 28 to 44 % background CPU from other work. Every run saw the same conditions, and the English student was timed in the same session as a yardstick.

## Results

### Speaker similarity and intelligibility (means over 5 voices; ASR over 15 sentences)

| Language | Pack | Pocket dub-clone ECAPA | Weakest voice | Pocket English-clip control | Gain over control | OmniVoice + pack | Pocket as share of OmniVoice | ASR Pocket (dub) | ASR OmniVoice |
|---|---|---|---|---|---|---|---|---|---|
| French | fr | 0.525 | 0.431 | 0.212 | +0.313 | 0.773 | 68 % | 1.000 | 0.993 |
| Italian | it | 0.573 | 0.421 | 0.276 | +0.297 | 0.765 | 75 % | 0.973 | 0.994 |
| German | de | 0.573 | 0.495 | 0.271 | +0.302 | 0.794 | 72 % | 1.000 | 1.000 |
| Spanish | es-es | 0.544 | 0.435 | 0.277 | +0.267 | 0.813 | 67 % | 0.957 | 0.981 |
| Portuguese | pt-br | 0.500 | 0.406 | 0.313 | +0.187 | 0.719 | 70 % | 0.960 | 0.994 |
| All | | 0.543 | | 0.270 | +0.273 | 0.773 | 70 % | 0.978 | 0.992 |

Cloning from the English clip (the control) with a foreign model scores only 0.26 to 0.42 against its own English reference, matching the earlier evaluation (0.22 to 0.38). The dub clip is what makes the difference. The dub speakers and the English actors are different people (dub clip against English clip: 0.11 to 0.20), so the control's low score against the dub is expected; the pack check's own PASS rule (dub clone beats English clone, both measured against the dub) holds for 25 of 25 voices.

Per voice, Pocket dub-clone / OmniVoice (ECAPA against the dub clip):

| Voice | French | Italian | German | Spanish | Portuguese |
|---|---|---|---|---|---|
| panam-palmer | 0.48 / 0.75 | 0.42 / 0.81 | 0.50 / 0.77 | 0.50 / 0.80 | 0.46 / 0.74 |
| judy-alvarez | 0.48 / 0.70 | 0.52 / 0.67 | 0.60 / 0.78 | 0.43 / 0.77 | 0.54 / 0.66 |
| jackie-welles | 0.68 / 0.87 | 0.63 / 0.84 | 0.54 / 0.80 | 0.66 / 0.83 | 0.41 / 0.65 |
| resident-female | 0.56 / 0.82 | 0.72 / 0.71 | 0.56 / 0.83 | 0.52 / 0.77 | 0.59 / 0.73 |
| v-male | 0.43 / 0.72 | 0.57 / 0.79 | 0.67 / 0.79 | 0.60 / 0.89 | 0.51 / 0.81 |

Yardsticks from the earlier evaluation: our English student scores 0.63 against its own English references, the stock English 100M models about 0.49 to 0.50. Pocket in the dub languages (0.54) is level with stock English Pocket and about 70 % of OmniVoice with a pack.

Intelligibility, the one defect: **"Night City" is not said as the English name by the Italian, Spanish and Portuguese models** (the test sentence 2 contains it). Parakeet heard it in 0/5 renders in each of those languages, against 5/5 for OmniVoice, and 5/5 (French) and 5/5 (German). That is the whole of the ASR gap (sentence 2 scores 0.87 to 0.91, the other sentences 1.00). A respelling in the Pocket text fixes most of it (`scripts/pocket-v4-dub/night_city.py`, sentence 2 cloned from the dub clip, 5 voices):

| Language | Respelling | "Night City" heard |
|---|---|---|
| Italian | Nait Siti | 4/5 |
| Spanish | Nait Siti | 5/5 |
| Portuguese | Nait Siti / Nait Citi | 0/5 / 0/5 |
| Portuguese | Náit Síti | 4/5 |

Other English proper nouns of the game were not tested.

### Speed (CPU, 4 threads, 30 renders per language, load at 28 to 44 %)

| Language | First audio median ms | p90 ms | RTF median | RTF p90 | RTF max | Reference encode median ms (9 to 13 s clip) | Model load s |
|---|---|---|---|---|---|---|---|
| French | 132 | 159 | 0.48 | 0.73 | 0.81 | 2396 | 0.98 |
| Italian | 129 | 167 | 0.46 | 0.64 | 0.76 | 2231 | 1.06 |
| German | 117 | 157 | 0.42 | 0.54 | 0.77 | 2272 | 0.73 |
| Spanish | 97 | 152 | 0.31 | 0.58 | 0.68 | 2099 | 0.72 |
| Portuguese | 87 | 115 | 0.31 | 0.59 | 0.73 | 1995 | 0.73 |
| English student (same session, 15 renders) | 97 | | 0.38 | | | 3422 | 1.61 |

The language models are as fast as the English student on this machine: first audio about 90 to 130 ms and a real-time factor of 0.3 to 0.5, never above 0.81, using about 2.2 cores. A clone from a never-seen voice costs a reference encode of 2 to 3.6 s (a 12 s clip, measured under load; the English student's was 3.4 s in the same session) before its first sentence. The worker's prepared-voice store keeps the state after that: 7.3 MB per voice (12 s clip), keyed by the model hash and the source clip.

### Memory (one process, language model resident)

| Measure | MB |
|---|---|
| Process after imports (torch, pocket-tts) | 354 |
| After loading one language model | 799 to 800 (+445 per model) |
| Peak resident while rendering | 915 to 956 |
| Peak working set of the process (reached while loading) | 1327 to 1407 |
| English student loaded, for comparison | 799 |
| Resident after the model is deleted and collected | 861 to 872 |

Swapping models in one process (student, then fr, de, it, fr): resident memory stayed between 854 and 965 MB the whole time; a second model reuses the first one's memory instead of adding 445 MB. But deleting a model inside the process returns almost nothing to the operating system (about 40 MB), so the only way to give the memory back is for the worker process to exit, as it already does when Pocket is not needed.

### Compatibility with the shipped worker

The worker's pinned source is pocket-tts 3.3.0. Rendering one fixed line with a fixed seed from the v4 French model with the 3.3.0 source and with 4.0.0 gave **bit-identical audio** (largest difference 0.0, 67,200 samples, `scripts/pocket-v4-dub/compat_code.py`). The v4 language models are 6-layer, have a `tokenizer.json`, and use the same YAML structure as 3.3.0's `french.yaml` (one extra `replace_characters` entry in 4.0.0, which the relocated YAML keeps). So adopting them needs no upgrade of the pinned Pocket source or its hash.

## The bar and how each language fares

| Criterion | Bar | fr | it | de | es | pt |
|---|---|---|---|---|---|---|
| Intelligibility, mean over the voice's sentences | mean >= 0.95, every voice >= 0.90 | 1.000 / 1.00 | 0.973 / 0.96 | 1.000 / 1.00 | 0.957 / 0.94 | 0.960 / 0.95 |
| Voice likeness to the dub (ECAPA) | mean >= 0.50, every voice >= 0.40 | 0.525 / 0.431 | 0.573 / 0.421 | 0.573 / 0.495 | 0.544 / 0.435 | 0.500 / 0.406 |
| Beats the English-clip clone | every voice by >= 0.05 | min +0.17 | min +0.11 | min +0.13 | min +0.22 | min +0.08 |
| Real time on 4 CPU threads under load | RTF p90 <= 1.0, first audio median <= 200 ms | 0.73 / 132 | 0.64 / 129 | 0.54 / 117 | 0.58 / 97 | 0.59 / 87 |
| Memory | <= 0.5 GB per resident model, released by process exit | 445 MB | 445 MB | 445 MB | 445 MB | 445 MB |

The bar is: clearly intelligible, recognisably the dub speaker rather than a generic voice (a different speaker scores 0.1 to 0.3; the English Pocket path today sits at 0.49 to 0.63), faster than real time with margin, and affordable in RAM. All five languages clear it. Portuguese clears it by the thinnest margin (mean 0.5005, jackie-welles 0.406, gain +0.08), so it is the one most likely to disappoint.

Why adopt rather than leave non-English Pocket as text only: today a Pocket player gets no voice in these five languages; the alternative is the cloud Mistral voice (needs a key and a network, not measured here). A local, free, CPU voice that is intelligible, level with English stock Pocket in likeness and as fast as the English student is a real step up from silence. It is not OmniVoice: 70 % of OmniVoice's likeness, and the weakest pairs (fr v-male 0.43, it panam-palmer 0.42, pt jackie-welles 0.41) are recognisably the right gender and age but not convincingly the character.

Open items that do not change the verdict but must be closed before shipping:
1. Real cloning weights (gated) against the spliced encoder: re-run the scores; also decide whether our spliced file or Kyutai's own cloning file is shipped (the repo is tagged CC-BY-4.0, which needs attribution in the notices).
2. The Portuguese model's variant: Kyutai's model card says only "portuguese". The pack is Brazilian; the model may be European. The ASR cannot tell. Check with a Brazilian speaker, or the Portuguese entry becomes optional.
3. The "Night City" respelling table (it, es, pt) in the Pocket text path, and a check of the other English names.
4. Nobody listened to any of this: long replies (more than 50 tokens are chunked), expressive lines and the quality of the 24-layer models (higher quality, 672 MB each) are untested.

## Integration sketch (written before the build)

Built as `docs/POCKET_LANGUAGE_MODELS.md` (2026-10-22). Where the build differs from this sketch: the zips hold Kyutai's real gated cloning weights unchanged (the owner accepted the terms, and the gated French file's 42 Mimi encoder tensors are byte-identical to the shipped student's, so the numbers above hold; no splicing), 219 MB each; the unload rule is the owner's (the last language stays loaded); the memory was re-measured in the real worker and stays flat.

**Shipping (owner decisions of 2026-10-22).** Each Pocket language model is its own optional zip on Hugging Face only, in the `multilingual/` folder next to the multilingual packs, never on Nexus. Sizes measured by zipping the real files (deflate level 9):

| Zip | Contents | Size |
|---|---|---|
| `AI-NPC-Cyberpunk-Mod-Pocket-<lang>.zip` (our spliced model) | `model.safetensors` 237,478,516 B, `tokenizer.json` ~0.25 MB, `inference.yaml`, `pocket-model.json` | **about 177 MB** (176.6 to 176.7 MB) |
| Same with Kyutai's public weights, encoder zeroed (not usable for cloning) | model 219,029,196 B | about 160 MB |

The model file is about 220 MB raw, 160 to 177 MB zipped; the 237 MB figure is the spliced file (the student's encoder tensors are stored in float32). Five languages: about 0.88 GB of zips. The voice pack of the same language (about 150 to 170 MB) is needed too; a player who wants Pocket French downloads both.

**Folder layout.** Extracted into the game folder like the voice packs, as a sibling of `multilingual/`:

```
red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual/<lang>/          the voice pack (unchanged)
red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket/<lang>/   the Pocket model for that language
  pocket-model.json     {version, language, languageTag, modelSha256, bytes, layers: 6, pocketSource: "3.3.0", needsVoicePack: ">=1"}
  model.safetensors
  tokenizer.json
  inference.yaml        Kyutai's YAML, paths relative; the worker relocates it with yaml.safe_dump as it does today (avoids the Windows encoding bug)
```

A sibling folder (not a subfolder of the pack) keeps the pack's all-or-none manifest check and the two downloads independent, and uses the same `<references>` roots, so the Mod Organizer 2 overlay behaves the same.

**How the bridge finds it.** A small module modelled on `bridge/voice-language-packs.mjs`: `scan()` at start and the same cheap `refresh()` in the settings poll, one directory listing and one stat per `pocket-model.json`, the full check (all files present, sizes, SHA-256 once per file change, `layers`, `pocketSource` equals the pinned source) only on change; a model is used all-or-none. `LANGUAGE_PACKS` maps the folder names (`fr`, `it`, `de`, `es-es`, `pt-br`) to the reply-language tags, and the Pocket models use the same tags. `bridge/multilingual.mjs` stops saying "Pocket speaks English only" and asks the new module: Pocket may speak tag T when a valid model for T is installed **and** `VoiceLanguagePacks.has(T)`; otherwise the turn stays text as today. The voice-routing log line gets `ref="multilingual/<lang>/picked/<voice>"` and the Pocket model's language, as for OmniVoice. The support report lists installed Pocket models and the reason a model is not used.

**Notice when the model is there but the pack is missing.** The model is not loaded (no RAM, no worker work), the reply is shown as text, and once per language per session the player gets one note: "The Pocket <Language> voice is installed, but it clones from the <Language> multilingual pack, which is not installed. Install AI-NPC-Cyberpunk-Mod-Voices-<lang>.zip from the Hugging Face multilingual folder; until then this reply is shown as text." The support report reason is `pocket-model-needs-pack`. (A pack without a model keeps today's behaviour for Pocket: text only, and OmniVoice or Mistral still use the pack.)

**Worker.** The existing worker keeps its protocol, ack and cancel logic, sampling settings and the 3.3.0 source pin (verified bit-identical). Changes:
- a `language` op (or a `language` field on the load request): the worker builds the relocated YAML from the language folder, checks `model.safetensors` against `pocket-model.json`, loads it with `TTSModel.load_model(...)` (0.7 to 1.1 s measured) and sets it as the resident model, replacing the English student in the same process;
- `inspect_student_export` (6 layers, `tokenizer.json`) already fits: the language models have 6 layers and a `tokenizer.json`; the ready frame reports the language;
- references for a language turn are the pack's clips (below), passed by path and SHA-256 as OmniVoice's descriptor already does; the prepared-voice store is keyed by model hash, source hash and clip hash, so a language's states never mix with the English ones.

**One model at a time, loaded on demand.** The first Pocket reply in a language with an installed model and pack swaps the language model in; replies in English swap the student back (a load of about 1 s, once per language change, not per reply; the previous reply must finish first, which the existing gate already enforces). Memory stays near 0.9 GB because the swap reuses the freed memory (measured). Keeping both models resident would cost another 445 MB and is not recommended.

**Unload rule (changed by the owner on 2026-10-22; implemented in `docs/POCKET_LANGUAGE_MODELS.md`).** The last language used stays loaded; Pocket swaps only when a reply comes in a different language, English included (no idle timer). When Pocket is not needed any more (voice setting changed, game closed) the worker exits as it does today and the exit is confirmed, because only a process exit returns the memory (deleting the model in-process frees about 40 MB of 445). A model whose pack disappears at the live re-scan stops being used and the notice above is shown.

**Pack files reused.** `multilingual/<lang>/manifest.json` (the voice entries, their clip paths and SHA-256) and the clips `picked/<key>.wav`, `archetypes/<key>.wav` and `v-voice/v-male.wav`, which are 24 kHz mono, 6 to 20 s, the right format for `get_state_for_audio_prompt(path, truncate=False)` without conversion. Not used: the transcripts (Pocket does not need them) and `prepared/` (Voxtral only). A player's own clip for a character is still never replaced by a pack's, as for OmniVoice. A voice missing from the pack falls back to text for that turn, not to the English clip, because the English clip with a foreign model clones badly (0.21 to 0.31 against the dub; the control above).

**Prepared voices.** First use of a voice costs a 2 to 3.6 s reference encode (under load) and writes a 7.3 MB state; 100 voices in one language would be about 730 MB on disk, so the store's size cap needs a check, and the main cast should be prepared in the background when a language model first loads (no work on the reply path).

**Text path.** A per-language word substitution before synthesis ("Night City" to the respellings above) in the Pocket text path only.

**Where the models ship.** A zip per language beside its voice pack, not inside the voice pack: the voice pack stays usable by OmniVoice and Mistral without 177 MB it does not need, and the Pocket model can be updated (a better model, the 24-layer variant at about 670 MB raw, or the real cloning weights) without rebuilding the packs.

## Reproduce

All scripts take every path as an argument and run with `python -X utf8 -I`:
`build_models.py` (splice and relocate), `render.py` (one language, one process, timing and memory), `score.py` (ECAPA and Parakeet), `baseline_swap.py` (English student yardstick and model swapping), `state_size.py`, `night_city.py`, `compat_code.py`. The 150 renders and the downloaded models were deleted after the run; the results are in the JSON.
