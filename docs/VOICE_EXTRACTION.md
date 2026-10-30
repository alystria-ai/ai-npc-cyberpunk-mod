# Voice reference clips from the player's own game files

Branch `feat/voice-extract` (2026-10-30). Not merged, not pushed, nothing uploaded, the game was not launched, and the two game folders were only read.

## What this is

Every character's voice reference clips (OmniVoice short and long, Pocket) were cut from the game's own English voice lines with our pipeline (`scripts/reference-pool/extract.py`, `scripts/clip-search/`, the picker). They ship in the Runtime and the OmniVoice pack: 945 files, 627.7 MB unpacked (picked 236.5 MB, archetypes 391.2 MB), about 380 MB zipped.

This work builds the same clips again on the player's PC from the player's own `lang_en_voice.archive`, the first time a character is invited or talked to, and keeps them. A player whose game has no English voice files downloads the same clips from Hugging Face instead. The shipped clips are still in the packages: nothing is dropped yet.

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
| All clips in the manifest | 1026 (315 voices in the configs and the 27 side characters of the cast sweep, three kinds each) | |

The 5: `lucy-kushinada` (3 clips) is a web clip of the anime's dub with the music removed, not game audio, so no game file exists. `spider-murphy/omni-long` (kept from an earlier set, its second line does not match any candidate file with the recovered gain) and `npc-kang-tao-male/omni-short` (its first line does not match the file the id names) were looked at only briefly and the cause was not found. These three voices are left out of the manifest and keep the shipped clips.

The 27 side characters of the cast sweep (`characters/cast-sweep-voices.json`) all rebuild sample for sample from their one game line. They have no entry in the voice lists yet, so nothing names them. They are in the manifest for when they do.

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

## Dropping the clips (not done, ready behind a flag)

`voiceClips.fromGame: true` makes `packaging/build-release.mjs` check every clip against its hash as ever but leave it out of the Runtime and the OmniVoice pack. It is off. Turn it on only after the clips are on Hugging Face (`packaging/voice-clips-upload-list.json`: 936 files, 622.6 MB, `voice-clips/<kind>/<key>.wav`, each with its SHA-256, nothing uploaded). The Runtime clip listing, `check-pack-overlap` and the Voxtral slot cache were not rebuilt with the flag on. A full Runtime build with the flag on has not been run.

## Risks

- **Scipy and torch in the Runtime.** The `poly` and `torch` recipes need scipy or torch in the Runtime's Python. Both are in the 0.3.4 Runtime and both are optional in the file check, so a Runtime without scipy cannot build the characters that need it (clear error, the character keeps its shipped clip or downloads). Without torch the numpy port is used and a few samples differ by one step.
- **Another machine, another torch.** The torch recipe was exact on this CPU with torch 2.8.0 in two builds. The convolution is not guaranteed to give the same last bit on every CPU (AVX2 against AVX512). The worst case is one 16-bit step in a few samples, which is below anything heard, but the SHA-256 would then differ from the shipped one (the bridge uses the built file's own hash, so nothing breaks).
- **Time.** 3.4 s median, up to 9 s, at below normal priority, once per character, in the background. Not in front of a reply. An invitation waits for it (up to a minute) only when the shipped clip is missing.
- **Many characters at once.** One build at a time, in the order asked. A crowd of new NPCs queues behind each other. Archetype voices are shared, so a city of NPCs needs a few dozen builds at most.
- **Which key is built.** The bridge builds the voice key a profile resolves to (`voiceKeyFor`). Archetype characters pick a variant from their alias pool, and only the variants in the manifest are built.
- **Hugging Face is empty.** Nothing is uploaded. Until the list is uploaded, a player with no English voice files and no shipped clips gets the 404 and the character keeps the archetype voice. With the packages unchanged nobody is in that position today.
- **A missing-clips log line.** At start the bridge logs once when an installed OmniVoice pack is short of reference clips (`missingOmniClips`). With `fromGame` on that line would name every character. It would need to skip the manifest's characters.
- **Game updates.** The lines are fixed `StringID` files. A future patch that rewrites a voice line changes the audio and the SHA-256 (the clip still builds and the character speaks with the patched line). A patch that removes one makes that character unavailable and it falls back.
- **The 27 cast sweep characters** are in the manifest but not in any voice list, so no word list exists for them. Wiring them is a separate step.

## Re-running it

```
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/recover_manifest.py --shard 0/16 --out m_0.json --report r_0.json   (16 shards, about 25 minutes)
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/recover_manifest.py --cast-sweep --out m_cast.json --report r_cast.json
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/merge_manifest.py --shards <folder> --extra <folder>/m_cast.json
vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/upload_list.py
```

The recovery needs the main checkout's `runtime/` (voice lists and shipped clips), the game and vgmstream. It reads the game folder only.
