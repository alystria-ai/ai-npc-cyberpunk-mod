# Voice reference clips from the player's own game files

Branch `feat/voice-extract` (2026-10-30) built the work. Branch `feat/voice-clips-on` (2026-10-30, for 0.4.0) switches it on: `voiceClips.fromGame` is true, the 1017 fallback clips are on Hugging Face and read back, the first 27 side characters of the cast sweep are wired (13 more since `feat/side-own-voices`, 31 Oct 2026, see "Side characters found by a voice tag" below), the Runtime file check asks for scipy and torch, and a character whose clips are not built yet speaks with a stand-in voice. Not merged, not pushed. The two game folders were only read.

## What this is

Every character's voice reference clips (OmniVoice short and long, Pocket) were cut from the game's own English voice lines with our pipeline (`scripts/reference-pool/extract.py`, `scripts/clip-search/`, the picker). They ship in the Runtime and the OmniVoice pack: 945 files, 627.7 MB unpacked (picked 236.5 MB, archetypes 391.2 MB), about 380 MB zipped.

This work builds the same clips again on the player's PC from the player's own `lang_en_voice.archive`, the first time a character is invited or talked to, and keeps them. A player whose game has no English voice files downloads the same clips from Hugging Face instead. Since 0.4.0 the packages no longer carry the clips the PC can rebuild (see "Switched on").

## Result in one table

| Question | Answer |
|---|---|
| Can the clips be rebuilt from the game files without WolvenKit? | Yes. The archive is read by a small reader (`bridge/voice_clip_build.py`). Voice lines are stored whole, not compressed, so no Oodle or Kraken is needed. |
| Are they exact? | 1017 of the 1026 clips in the manifest rebuild sample for sample (largest difference 0). 4 differ by one 16-bit step in 106 to 6611 samples of 170,000 to 470,000. 5 cannot be rebuilt. |
| Byte for byte? | The 45 clips of the proof (10 main cast, 5 archetype voices, three kinds each) have the same SHA-256 as the shipped files, in both of two runs (90 of 90), built with the Runtime's own Python and vgmstream. |
| Cost per character | About 3.4 s in a process of its own (median), 130 MB peak. 0.7 s and 53 MB for a voice that needs no scipy. 9 s and 289 MB for one that needs torch. |
| Size if the clips were dropped | 627.7 MB unpacked, about 380 MB zipped, plus the same in the OmniVoice pack for the clips it holds. |

## The recipe that was recovered

The shipped clips are not all made the same way, so each clip has its own recipe in `characters/voice-clips-manifest.json`:

1. **Lines.** From the live voice configs (`pick.clips`, in order). Each id is a `StringID` and the game file is `base\localization\en-us\vo\<stem>_<f|m>_<16 hex digits of the id>.wem` (or `ep1\...` for Phantom Liberty, or `vo_holocall`). The lists of paths are `runtime/voice-cast-inventory-20261001/*-wem-paths.txt`.
2. **Decode.** `vgmstream-cli` r2055 to 16-bit PCM, mixed to mono (mean of the channels).
3. **Resample to 24 kHz.** Four variants were used over the project's history and the recovery picks the one that matches each line:
   - `poly`: `scipy.signal.resample_poly` in float32, written as a 16-bit file and read back (the old reference pool).
   - `poly64`: the same computed in float64.
   - `torch`: `torchaudio.functional.resample` (sinc interpolation, Hann window, width 6, rolloff 0.99). Written in `voice_clip_build.py` with plain torch operations (the Runtime carries torch, not torchaudio), which gives torchaudio's result sample for sample.
   - `js`: the reference picker's port of the same resampler in `scripts/reference-picker/audio.mjs` (float64 sums in order), written to match its output exactly.
4. **Join.** Whole lines in order with 9600 samples (0.4 s) of digital silence between them.
5. **Write 16 bit.** Two writers: `sf` (python-soundfile, libsndfile 1.2) and `js` (`Math.round(v * 32767)`). The `sf` writer is `floor(x * 32768 + 2**-17)` in double precision: measured against soundfile on 3.7 million values with no difference. The `2**-17` matters. A float a hair below zero is written as 0, not -1.
6. **Loudness gain (125 clips).** The clips of 2026-10-14 got one linear gain after the join. Its exact value is not in the configs (they hold two decimals). The recovery finds the interval of gains that gives every sample and stores the middle of it with full precision.

No EQ, denoise or trimming was ever applied. Each manifest entry holds the file paths, the archive, the resampler per line, the writer, the gain, the sample count, the SHA-256 of the shipped clip, and the measured difference.

## The archive reader

`lang_en_voice.archive` is an RDAR version 12 file: a header with the index offset, an index of 56 byte file entries sorted by the FNV-1a 64 hash of the lower case depot path, and 16 byte segment records (offset, stored size, decoded size). The reader loads the index once (about 7 MB, 6 ms warm and 26 to 76 ms the first time), looks the hash up with a binary search, reads the bytes at the offset and checks them against the SHA-1 in the entry. Nothing else is read: a character needs 1 to 7 lines of 30 to 120 KB. `Oodle` support through the game's `oo2ext_7_win64.dll` is in the file as a fall back and was never needed for a voice line.

Both game versions work. All 1459 distinct lines the manifest uses are byte for byte the same in 2.5 and 2.31. Builds from the 2.31 copy gave the same clips (14 of 15 byte for byte, the 15th is one of the four near clips).

## Manifest coverage

`research/voice-extract/coverage.json` is the machine readable result. `scripts/voice-extract/recover_manifest.py` recovers the recipes, `merge_manifest.py` merges the shards, and anything the build cannot reproduce is listed with the reason.

| | Clips | Share |
|---|---|---|
| Rebuild sample for sample (largest difference 0) | 1017 | 99.1 percent |
| One 16-bit step in a few samples | 4 (`jesse/pocket`, `santiago/omni-long`, `steven-santos/omni-long`, `yorinobu-arasaka/pocket`) | 0.4 percent |
| Cannot be rebuilt | 5 | 0.5 percent |
| All clips in the manifest | 1065 (315 voices in the configs and the 40 side characters of the cast sweep, three kinds each). The table above counts the 1026 of 30 Oct. The 39 clips of the 13 added on 31 Oct all rebuild sample for sample, so 1056 rebuild exactly | |

The 5: `lucy-kushinada` (3 clips) is a web clip of the anime's dub with the music removed, not game audio, so no game file exists. `spider-murphy/omni-long` (kept from an earlier set, its second line does not match any candidate file with the recovered gain) and `npc-kang-tao-male/omni-short` (its first line does not match the file the id names) were looked at only briefly and the cause was not found. These three voices are left out of the manifest and keep the shipped clips.

The 40 side characters of the cast sweep (`characters/cast-sweep-voices.json`, 27 by a name in the file stem and 13 by a proven voice tag) all rebuild sample for sample from their one game line. They are in the manifest, the live voice configurations and `voice.localProfiles` (see "Side characters found by a voice tag" for the 13).

## Proof

Run with the Runtime of the installed 0.3.4 (Python 3.12.10, numpy 2.5.3, scipy 1.18.1, torch 2.8.0 CPU) and its `app/vgmstream`, one process per character as the bridge starts it, output in the scratchpad:

`scripts/voice-extract/prove.py --game "<game folder>" --vgmstream <vgmstream-cli.exe> --out <folder> --keys ... --repeat 2`

- Main cast: johnny-silverhand, judy-alvarez, panam-palmer, jackie-welles, viktor-vektor, misty-olszewski, mama-welles, t-bug, evelyn-parker, dexter-deshawn.
- Archetypes: resident-male, npc-maelstrom-female, npc-tyger-claws-male, npc-valentinos-female, npc-sixth-street-male.
- 90 of 90 clips (15 voices, three kinds, two runs): same SHA-256 as the shipped file, so largest absolute difference 0, 0 differing samples, correlation 1.0.
- Time per character (a fresh process, including Python and library start): median 3.4 s (run 1) and 3.4 s (run 2), range 0.74 s to 9.3 s. Cold and warm are the same within noise because a character reads under 1 MB of the archive. The index opens in 6 ms warm. Reading a line takes under 1 ms (3 ms the first time), vgmstream takes 60 to 90 ms a line, the rest is importing scipy (about 2.5 s) or torch.
- Peak working set: median 130 MB, 53 MB when no scipy or torch is needed (jackie-welles), 231 to 289 MB for the characters that use torch. The vgmstream child is a few MB and lives 70 ms.
- With the bridge's own wrapper (`GameVoiceClips`, below normal priority): panam-palmer took 6.6 s wall time from the first talk to the tables being updated, and all three hashes equalled the shipped ones.
- 2.31: five voices built from `E:\SteamLibrary\Cyberpunk2077-2.31`, 14 of 15 identical, 5 to 8 s each.

## Licences

- vgmstream r2055: ISC licence. It is already in the Runtime (`app/vgmstream`, 7.8 MB, with `licenses/vgmstream/NOTICE-bundled-libraries.txt`) for V voice mods. The exe is the same file (SHA-256 71027230...) that cut the shipped clips. Nothing new ships.
- The archive reader is our own code (no WolvenKit code, no RED4 library). The game's file format is read, no game file is copied or written anywhere. The `oo2ext` DLL is only loaded from the player's game folder if ever needed.
- Clips downloaded from Hugging Face are the same derivative clips we already redistribute.

## What is wired in

- `bridge/voice_clip_build.py`: the builder, one character per process (`build --manifest ... --key ... --game ... --vgmstream ... --out ...`). Exit 0 done, 3 no English voice archive, 2 any other failure with one line on stderr.
- `bridge/voice-clips.mjs` (`GameVoiceClips`): one build at a time, below normal priority, a 180 s limit, an index (`<state>/voice-clips.json`) of what is kept, clips in `<references>/generated/<kind>/<key>.wav`, a copy in every other reference folder a worker reads (Pocket reads one folder), a failure is remembered for the session, and the Hugging Face download (`voice-clips/<kind>/<key>.wav`, checked against the manifest SHA-256).
- `bridge/live-voices.mjs`: a `generated` hook. A character with a clip of the player's own keeps it. Otherwise the generated clips replace the shipped descriptors of that key (words unchanged), live, with the same machinery as the editor's clips.
- `bridge/convai-bridge.mjs`: opens the service at start, puts the clips already kept into the tables (a file read, no process), asks for a character when it is invited (waits up to a minute, the invitation already waits for the voice) and when a talk starts (`warmTalkTargets`, in the background).
- When is a character built? Only when its shipped clip is missing on disk, or with `CYBERPUNK_CONVAI_GAME_CLIPS=1`. With the shipped clips in place nothing is started, so today's players see no change. `CYBERPUNK_CONVAI_VOICE_CLIPS_DOWNLOAD=0` turns the download off.
- Fall backs, in order: the game's English voice files, then Hugging Face, then the shipped clip, then the archetype voice the character already has. A character that cannot be made is not tried again that session. Never all characters at once.
- Packaging: `bridge/voice_clip_build.py` and `characters/voice-clips-manifest.json` ship with the code, and `voiceClips.fromGame` (default false) in `packaging/release.config.json` stops the Runtime and the OmniVoice pack from carrying the clips (see "Dropping the clips").
- Tests: `bridge/voice-clips.test.mjs` (11), `bridge/live-voices.test.mjs`, and the packaging tests.

### Prepared voices

Mistral's cloud voice keeps a prepared slot per clip, keyed by the SHA-256 of the clip. Rebuilt clips are byte for byte the shipped ones, so `voices/prepared-runtime` and `voices/prepared` stay valid. For the four near clips the hash differs from the shipped one, so the bridge prepares a new slot the first time, as it does for any clip it has not seen. OmniVoice and Pocket read the clip itself, not a frozen copy.

## Switched on (0.4.0)

`voiceClips.fromGame` in `packaging/release.config.json` is true. What changed:

| Part | What it does now |
|---|---|
| Packages | `packaging/build-release.mjs` checks every clip against its hash as ever and leaves out of the Runtime and the OmniVoice pack every clip whose characters the manifest can rebuild (`packaging/lib/voice-clips-left-out.mjs`). 1011 of the 1026 clips are left out. |
| Still shipped | `lucy-kushinada` (a web clip, not game audio), `spider-murphy` omni-long and `npc-kang-tao-male` omni-short (not reproducible, so those two voices are not complete in the manifest and keep all their clips), and the two stand-in voices `resident-male` and `resident-female` (three kinds each). 15 files, about 9 MB. |
| Runtime clip listing | The check that the listing of the Runtime's OmniVoice clips equals what the pack skips is held to the clips that are still shipped. The Voxtral slot caches are not touched (they are keyed by the clip's hash and stay valid). |
| Hugging Face | `voice-clips/<kind>/<key>.wav`, 1017 files (936 of the main cast and archetypes plus 81 of the 27 side characters), 649.5 MB, in 6 commits of the packs repository. Every size and LFS SHA-256 was read back and equals the manifest. Three files were fetched over the public URL, as the bridge does, and matched. Nothing else on the repository was touched. |
| Runtime file check | `bridge/runtime-python.mjs` `SITE_PACKAGES` now also asks for `scipy`, `scipy/signal` and `torch/nn` (the builder imports `scipy.signal` and `torch.nn.functional`). The setup check, the Runtime build and the install test use the same list. `packaging/check-runtime-contents.mjs` also requires the Pocket clips of the two stand-in voices in the Runtime zip. |
| The 27 side characters (40 since 31 Oct) | They have rows in the three voice configurations (`scripts/voice-extract/stage_cast_voices.py` writes the rows from the game's subtitles, `scripts/clip-search/cast-expansion/merge_rows.mjs` merges them with a backup), a place in `packaging/release-plan.json` `voice.localProfiles`, and their three paths in the upload list. One clip serves the three kinds. |
| Start-up log | `[OmniPack] N of M reference clips are missing` no longer counts the characters the game builds, and the stand-ins are put in the tables before it runs, so with the clips left out it stays silent. One line `[VoiceClips] N character(s) speak with a stand-in voice until their clips are built` says how many wait, with no names. |

### Stand-in voices and the first build

A character is built at its invitation (the invitation waits up to a minute, a build takes 3 to 9 s) or at the first sign of a talk (in the background). Before its clips are ready the tables name, for each engine whose shipped clip is not on disk, the clip of the stand-in voice of its gender (`resident-female`, or `resident-male` for every other gender word, `bridge/voice-clips.mjs` `applyStandIns`). The voice workers therefore see a clip that exists, the character is available, and a line needed before the build is done is spoken in that archetype voice, with no error and no written-reply notice. When the build ends the live tables swap the character's own clips in (`LiveVoices` `generated` hook, the same machinery as the editor's clips), the worker drops only that character's prepared voice and prepares it again at once in the background. A build that fails (no English voice files and no download) leaves the stand-in for the session. The stand-in logic reads file names only. It runs once at start (about a thousand file checks, a few milliseconds) and when a character's clips change, never per frame and never per reply.

### Characters the shipped tables have no row for

A manifest character can be missing from the voice configurations of an older Runtime (the 27 side characters, for a Runtime that predates them). Two things follow, both handled in `bridge/voice-clips.mjs`:

- Before its clips are built it speaks with the stand-in voice of its gender, like a character whose shipped clip is only missing on disk (`standInDescriptors` no longer needs a shipped row), so it is routed and the Companion Manager names the voice instead of "Text only (no voice)".
- When its clips are built, a voice table names a clip together with its words, and there are no shipped words to take. They come from `characters/voice-clips-words.json` (`readWords`, passed to `GameVoiceClips.open`), one set per engine, each taken from the configuration row whose clip hash is the manifest's hash. Without them the live change dropped the key (the log said "voices changed while running (1 character)" and the character stayed unrouted, 30 Oct 2026). A character with a shipped row keeps the shipped words, as before.

Write the file again after the manifest or the configurations change: `node scripts/voice-extract/write_words.mjs --runtime <folder with the autobest configurations>` (`--check` writes nothing). A test fails when it is out of step with the manifest. It ships in `appData` of `packaging/release.config.json`.

### The workers read a file

The voice workers hold the voices of the configuration FILE they are started with. The clip service edits the tables in memory at start (`applyReadyClips`, `applyStandIns`), so on their own those edits reached the bridge's registries but not the workers: Pocket's answer listed only the file's voices, so the ready clips and the stand-ins were never routed (30 Oct 2026, 27 characters missing from `routedProfiles`). When anything was edited, `clipVoiceConfigPaths` writes the edited configurations to `<state>/clips.pocket-voices.json`, `clips.omni-short-voices.json` and `clips.omni-long-voices.json` (a few small writes, once, at start), and the voice service starts its workers on those. The shipped and add-on files are never changed, and a failed write keeps the original file. Clips built later reach the running workers through `LiveVoices` as before.

## Side characters found by a voice tag (`feat/side-own-voices`, 31 Oct 2026)

The first 27 side characters were found by a name that starts the file stem. `scripts/cast-sweep/voice_links.py` adds a second rule (details and numbers in `docs/CAST_SWEEP.md`, "Own voices by voice tag"): 13 more characters got one line of their own. They are wired exactly like the 27:

| Part | What was done |
|---|---|
| Line | `scripts/cast-sweep/voices.py --asr`: plain `vo` file, 3.5 to 9.5 s, at least six words, no clipping, at least 0.4 percent energy above 4 kHz, Whisper small.en hears the game subtitle (similarity at least 0.85), and the same bytes are in the 2.31 archive. Decoded and resampled the way the first 27 were (`poly`, writer `sf`), into the offload folder. |
| Manifest | `recover_manifest.py --cast-sweep` reproduced all 40 sample for sample, `scripts/voice-extract/add_cast_manifest.py` added the 13 entries (every other voice unchanged, 355 voices now). |
| Rows | `stage_cast_voices.py --keys ... --apply` (the id check now pads the id to 16 hex digits, one new character has a leading zero) then `merge_rows.mjs` (backup `runtime/backups/cast-expansion-<stamp>`), `write_words.mjs`. |
| Release plan | The 13 keys are in `voice.localProfiles` (166 now, `preparedLocalProfiles` equal). |
| Hugging Face | `packaging/voice-clips-upload-list.json` is 1056 files, 662.1 MB. The 39 new rows (13 characters, three kinds) carry `"toUpload": true`. Nothing was uploaded. |
| Proof | `scripts/voice-extract/prove.py` on all 13 new keys (there are only 13, not 20): game 2.5 two runs each, 78 of 78 clips byte for byte the staged clip, and game 2.31 one run each, 39 of 39. About 2 s and 116 MB per character. Built with the vendor Python and vgmstream of the developer machine (the same builder code as the Runtime's). |

## The dubbed clips of the language packs (`feat/language-clips-on-demand`, 31 Oct 2026)

The same idea for the ten multilingual packs. Each pack clip (3015 in all) is made again on the player's PC from the dub archive `lang_<xx>_voice.archive` (base game and Phantom Liberty), else fetched one file at a time from Hugging Face (`voice-clips/<lang>/<kind>/<key>.wav`), and only for the character that is speaking. The recipe differs from the English one (the lines stay float after the resampler, there is no 16-bit file between, the gain is a plain linear factor), so it has its own manifest per language (`characters/voice-language-clips/<lang>.json`), its own entry point in the same builder (`voice_clip_build.py build-language`) and its own service (`bridge/language-clips.mjs`). It shares the one-build-at-a-time queue with the English clips (`SerialQueue` in `bridge/voice-clips.mjs`). All 3015 clips rebuild sample for sample with the Runtime's Python (3.12.10, scipy 1.18.1). The recovery, the proof, the bridge behaviour and the upload list are in `docs/VOICE_LANGUAGE_PACKS.md`, "Clips on demand".

## Side characters on their game's voice model (`feat/side-voice-models`, 31 Oct 2026)

Five more side characters have an own clip (45 in all: Cassius Ryder, Katherine McCannon, Milt Nauman, Susanna Quinn, Theo Price), made as above and wired the same way (manifest, rows by `merge_rows.mjs` with a backup, words, `voice.localProfiles` 171). `prove.py` on the 5: game 2.5 two runs 30 of 30 clips byte for byte, game 2.31 15 of 15.

137 side characters speak with the archetype voice of the generic voice model the game's scenes give them (`docs/CAST_SWEEP.md`, "Voice models"). 64 of the 112 models already were an archetype voice. The other 48 got a `model-<model>` voice from `scripts/cast-sweep/build_model_voices.py` (the archetype builder's code and rules, for exactly that model), 47 built and one with too few clean clips. They are archetype style voices in every respect:

| Part | What was done |
|---|---|
| Files | `runtime/voice-references/archetypes/<engine>/model-<model>.wav` and its manifest (git-ignored), the receipt in `characters/archetype-voices.json` (`modelVoice: true`), the list `characters/model-voices.json` |
| Live configurations | `scripts/archetype-voices/register_archetype_voices.mjs` adds the keys that are ready in `characters/model-voices.json` to the five voice files (backup `runtime/backups/archetype-voices-<stamp>`). The Python loaders reject a `runtime` junction ("Linked local assets"), so run them by the main checkout's paths. All five load, Node and Python |
| Manifest | `recover_manifest.py --keys <model keys>`: 141 of 141 clips sample for sample (`add_cast_manifest.py` takes keys that start with `model-`). 407 voices and 1221 clips in the manifest |
| Words and upload list | `write_words.mjs` (404 characters), `upload_list.py` 1212 files and 765.6 MB. The new rows carry `"toUpload": true`: 39 (13 characters, first branch) plus 15 (5 characters) plus 141 (47 model voices) = 195 files, about 116 MB. Nothing was uploaded |
| Packaging | nothing to change: `packaging/lib/voice-clips-left-out.mjs` leaves out every clip the manifest can rebuild, so the Runtime and the OmniVoice pack do not carry the new model voices |

## Risks

- **Scipy and torch in the Runtime.** The `poly` and `torch` recipes need scipy or torch in the Runtime's Python. Both are in every Runtime since the first release builder, and the file check now asks for `scipy`, `scipy/signal` and `torch/nn`, so a broken Runtime is reported (the character then keeps a stand-in voice or downloads). Without torch the numpy port is used and a few samples differ by one step.
- **Another machine, another torch.** The torch recipe was exact on this CPU with torch 2.8.0 in two builds. The convolution is not guaranteed to give the same last bit on every CPU (AVX2 against AVX512). The worst case is one 16-bit step in a few samples, which is below anything heard, but the SHA-256 would then differ from the shipped one (the bridge uses the built file's own hash, so nothing breaks).
- **Time.** 3.4 s median, up to 9 s, at below normal priority, once per character, in the background. Not in front of a reply. An invitation waits for it (up to a minute) only when the shipped clip is missing.
- **Many characters at once.** One build at a time, in the order asked. A crowd of new NPCs queues behind each other and speaks with the stand-in voice meanwhile. Archetype voices are shared, so a city of NPCs needs a few dozen builds at most.
- **Which key is built.** The bridge builds the voice key a profile resolves to (`voiceKeyFor`). Archetype characters pick a variant from their alias pool, and only the variants in the manifest are built. Every variant speaks with the stand-in of its gender until it is built.
- **A player with no English voice files and no network.** Nothing can be built or downloaded, so every character keeps the stand-in voice of its gender. That is the one case where the voices are not the character's own.
- **Game updates.** The lines are fixed `StringID` files. A future patch that rewrites a voice line changes the audio and the SHA-256 (the clip still builds and the character speaks with the patched line). A patch that removes one makes that character unavailable and it falls back to the stand-in voice, or to the Hugging Face copy of the clip when the download is on.
- **A stand-in for one line.** The stand-in is the same two archetype voices for everybody, so a character that talks before its clips are ready sounds like a resident for that line. The first line of an invited companion is not affected (the invitation waits for the build).
- **The 40 cast sweep characters** (27 by name, 13 by voice tag) are wired (rows with the game's subtitles as the words). Their roster rows are another branch's work: a profile still needs its roster row to be invited or talked to.

## Re-running it

```
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/recover_manifest.py --shard 0/16 --out m_0.json --report r_0.json   (16 shards, about 25 minutes)
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/recover_manifest.py --cast-sweep --out m_cast.json --report r_cast.json
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/merge_manifest.py --shards <folder> --extra <folder>/m_cast.json
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/upload_list.py
```

The recovery needs the main checkout's `runtime/` (voice lists and shipped clips), the game and vgmstream. It reads the game folder only.

A side character with no clips of its own (and no shipped row) speaks with its fallback archetype voice from `characters/cast-sweep-voices.json`, an alias made by `bridge/voice-fallbacks.mjs` (see `docs/CAST_SWEEP.md`, Voices). A character in the manifest keeps its stand-in or built clips: its own row wins over the alias.
