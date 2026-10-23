# PocketTTS models

Optional downloads that let the Pocket voice (CPU, `bridge/pocket-voice-worker.py`) speak **French, Italian, German, Spanish (Spain) and Portuguese (Brazil)**, cloned from the game's own dub of the character in that language. Evaluation and numbers: `docs/POCKET_V4_MULTILINGUAL_EVAL_2026-10-22.md`. Implemented on `feat/pocket-languages` (2026-10-22).

For the player: get the multilingual pack for your language (`docs/VOICE_LANGUAGE_PACKS.md`); if you use the Pocket voice, also get the PocketTTS model for that language. Both are on Hugging Face only (`multilingual/` folder of `alystria-ai/ai-npc-cyberpunk-mod-packs`), never on Nexus Mods. The model needs the pack of the same language: it clones from the pack's clips.

## What is shipped

One zip per language, `PocketTTS-Model-<Language>.zip`, the language in full (`PocketTTS-Model-French`, `PocketTTS-Model-Italian`, `PocketTTS-Model-German`, `PocketTTS-Model-Spanish`, `PocketTTS-Model-Portuguese`; the folder inside keeps the voice pack's code: `fr`, `it`, `de`, `es-es`, `pt-br`), 219 MB each, built by `packaging/build-pocket-models.mjs` from Kyutai's gated cloning weights (`kyutai/pocket-tts`, `languages/<name>/model.safetensors`, byte-identical, no splicing: its Mimi encoder tensors are the shipped student's) with Kyutai's tokenizer and v4.0.0 configuration. It extracts into the game folder like every pack:

```
red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual/<lang>/         the voice pack (docs/VOICE_LANGUAGE_PACKS.md)
red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket/<lang>/  the PocketTTS model for that language (a sibling folder)
  pocket-model.json     the manifest below
  model.safetensors     Kyutai's file, unchanged
  tokenizer.json        Kyutai's file, unchanged
  inference.yaml        Kyutai's v4.0.0 configuration with the weight and tokenizer paths changed to the files in this folder
  NOTICE.txt            CC-BY-4.0 attribution, Kyutai's prohibited-use terms, what was changed
```

`pocket-model.json` (version 1, `kind: "pocket-language-model"`): `language` (folder name), `languageTag` (reply language: `fr it de es pt`), `pocketSource: "3.3.0"` (the pinned source runs these models unchanged: the audio is bit-identical to Pocket 4.0.0's), `layers: 6`, `files{}` (bytes and SHA-256 of the model, tokenizer, configuration and notice), `upstream{}` (repositories, revisions, licence), `needsVoicePack`, `changes`. The Runtime and the Scripts never put a file in `voices/multilingual-pocket/` (the build refuses it, `packaging/lib/pack-overlap.mjs`) and a Runtime update never deletes in it (`apply-removals.mjs`).

Licence: CC-BY-4.0 (Kyutai). `THIRD_PARTY_NOTICES.md` carries the attribution and Kyutai's prohibited-use terms, which the zips repeat in `NOTICE.txt`.

## The bridge (`bridge/pocket-language-models.mjs`)

Found the way the voice packs are (`bridge/voice-language-packs.mjs`): one scan at start, a re-scan with the settings poll every 30 s (a listing and a stat per manifest), all or nothing per model (the manifest and the byte size of every file it names; the SHA-256 of the 219 MB file is checked by the worker when it loads, so a start does not read it). The root is the Pocket configuration's `runtime.referenceDirectory`, the folder the worker reads clips from; a pack found in another root is not usable for Pocket.

`speaks(tag)` is true only when the model **and** the voice pack of that language are valid. `bridge/multilingual.mjs` then plans and finishes the turn with Pocket for that language (`local.pocket.speaks`), otherwise the reply is shown as text as before. The clone reference is the pack's clip of the character (and its transcript), through `VoiceLanguagePacks.omniDescriptor`; a player's own clip for the character is used as it is; a character the pack has no clip for gets a written reply (`audioError` says so), never the English student reading foreign text.

**Model installed, pack missing.** The model is not loaded, the reply is written (`reason: pocket-language-pack-missing`), and the game says it once per language per game session, in the menu language: `keyNotice: "pocket-language-pack"` with `keyNoticeLanguage` on the reply, shown by `mod/init.lua` as "{language} replies show as text: the {language} multilingual pack is missing." (notice ids `pocket-pack-fr|it|de|es|pt`, `docs/NOTIFICATIONS.md`; sixteen languages). The generic `voice-language` notice is not used for it.

**A model the worker refuses** (a file differs from its hash, it will not load) is not offered again until its files change (`markFailed`); the support report lists it with the reason.

**Routing log.** A Pocket reply in a language logs `used="Pocket (PocketTTS model)" ref="multilingual/<lang>/picked/<voice>" model=multilingual-pocket/<lang> lang=<tag>`; the written case logs the fallback `the PocketTTS model for this language is installed but its multilingual pack is not`.

**Support report.** `pocketLanguageModels`: per model the language, size in MB, version, whether its voice pack is installed, whether Pocket may speak it, why a model is not used; no path.

**"Night City".** The Italian, Spanish and Portuguese models do not say the English name the English way. The text handed to Pocket (and only that text; the written reply and the other voices keep "Night City") gets a respelling: `Nait Siti` (it, es), `Náit Síti` (pt). Measured on the dub voices: Italian 4 of 5, Spanish 5 of 5, Portuguese 4 of 5 (0 of 5 before). French and German need none.

## The worker

One model is resident at a time: the English student, or the model of one language. The bridge sends a `language` command (`{language: "fr" | null, expected{sha256, tokenizerSha256, configSha256}, voices{key: descriptor}, urgent?}`); the worker:

1. checks the three files against the hashes sent (`inspect_language_export`, before anything is dropped: a refused model leaves the resident one as it was);
2. releases the resident model, then reads the new one and checks it is a CPU float32 six-layer model; if a language does not load, the English student is put back and the command answers with a non-terminal error (the bridge then treats the model as refused);
3. answers with the language and its voices; a language's voices are only the ones asked for (`add_language_voices`: a clip of that language's pack under `runtime/voice-references/multilingual/<lang>/`, or the player's own clip).

The English registry and its prepared voices stay in memory while a language is resident (a prepared state is plain tensors of the English weights, which are loaded again from the same file), so a swap back costs the model load and nothing else; a warm of an English voice that is already prepared does not swap the language out. The prepared states of the last two languages are kept too. A language's saved setups (the "Keep prepared voices" setting) live in `prepared-voices/lang-<lang>/`, apart from the English ones. The English path with no language resident sends and checks one comparison more than before.

**Swapping rule (owner, 2026-10-22).** The last language used stays loaded. Pocket swaps only when a reply comes in a different language, English included; there is no idle timer. The worker process exits when Pocket is not needed at all, exactly as before (voice change, Playback off, game closed). The bridge tells the worker the language of the turn as soon as the turn's language is known, while the reply is still being written (`warmPocketLanguage`), so the swap and the preparation of the voice happen behind the model's own thinking time.

**Memory is bounded without restarting the worker** (`scripts/Measure-PocketLanguageSwap.mjs`, the real worker, the installed Python and Pocket source, the five real models, 4 threads): the worker's working set was 790 MB after start, 2.13 to 2.25 GB after the first English reply (the English student's own behaviour: preparing the 19 s English clip), and 2.0 to 2.37 GB through 36 steps with 18 swaps (English, then fr, it, de, es, pt each, then English again, three rounds), never growing: a swap adds at most about 120 MB over the English-only worker and the next swap reuses it (`docs/POCKET_V4_MULTILINGUAL_EVAL_2026-10-22.md` measured the same at the smaller scale: 854 to 965 MB over a student, fr, de, it, fr sequence). Deleting a model in the process gives little back to the operating system, which is why the process exit stays the unload for "not needed". A restart per language switch would cost a 12 s start (imports and the student) for nothing, so it is not used.

**Latency** (same run): a reply in a language already resident: first audio 80 to 200 ms. The first reply in a language, swap and voice included: first audio 2.0 to 2.6 s, of which the swap is 0.87 to 0.95 s (hash of three files, release, read) and the rest is preparing the character's clip (1 to 1.6 s on this laptop, once; the "Keep prepared voices" setting and the language stash keep it). Back to English: first audio 0.9 s (the swap). Both are mostly hidden by the warm-up while the reply is written.

## Files

`bridge/pocket-language-models.mjs` (discovery, notice, respelling), `bridge/pocket-voice.mjs` (the client: `ensureLanguage`, `prepareLanguage`, `pocketLanguage` on `synthesizeStream`), `bridge/pocket-voice-worker.py` + `bridge/pocket_voice_runtime.py` (the worker), `bridge/voice-selection.mjs` (`pocketLanguageFor`, `warmPocketLanguage`), `bridge/multilingual.mjs`, `bridge/convai-bridge.mjs`, `bridge/voice-routing-log.mjs`, `bridge/support-report.mjs`, `mod/init.lua` + `mod/notices.lua` + `mod/locales/*.lua`, `packaging/build-pocket-models.mjs`. Tests: `bridge/pocket-language-models.test.mjs`, `bridge/pocket-language.test.mjs`, `bridge/pocket-language-selection.test.mjs`, `packaging/pocket-models-build.test.mjs`, `scripts/test_pocket_voice_runtime.py` (`LanguageModels`).

## Checked on an install (2026-10-22, game closed)

The French zip was extracted into the dev install (a player install: the committed bridge and Lua files that changed were laid over it, each identical to `main` before, backed up) and `scripts/Check-InstalledPocketLanguage.mjs` ran with the installed `node.exe`, installed Python, Pocket source and student (`docs/POCKET_LANGUAGE_MODELS.installed-check.json`): both folders scanned valid, the plan for a French reply on Pocket is Pocket, the language model became resident in 0.95 s, a warm-up while "the reply is written" took 2.4 s, then the French reply of Panam from the pack clip had first audio in 181 ms (again, no swap: 181 ms), an English reply after it swapped back (first audio 2.6 s, the English voice was not prepared yet), and French again 1.0 s. The installed Parakeet transcribes the French renders back exactly, "Night City" included. The routing line the installed code writes for that reply:

    profile=panam-palmer name="Panam Palmer" requested="Pocket · Performance" used="Pocket (PocketTTS model)" ref="multilingual/fr/picked/panam-palmer" model=multilingual-pocket/fr lang=fr

With the model but no pack the same code plans a written reply (`pocket-language-pack-missing`) and gives the notice once. The swap measurement (`scripts/Measure-PocketLanguageSwap.mjs`, three rounds through all five languages and English) is `docs/POCKET_LANGUAGE_MODELS.swap-measurement.json`.
