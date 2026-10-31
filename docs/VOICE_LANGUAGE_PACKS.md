# Multilingual packs

Optional packs that let OmniVoice and the Mistral voice (Voxtral) clone a character from the game's own dub in the reply's language, instead of the English actor's clips. One pack per voiced language of the game: `fr`, `it`, `de`, `es-es`, `ja`, `ko`, `pl`, `pt-br`, `ru`, `zh-cn` (Steam's "Full Audio" list). Pocket speaks English only and gets nothing from them.

Status: built and released as downloads (owner decision 2026-10-21). Since the branch `feat/language-clips-on-demand` (31 Oct 2026) a player no longer needs to download a pack: each character's clip is made on the player's PC from their own dub, or fetched for that one character. See "Clips on demand" below. This file is the contract between the pack builder and the bridge.

## Clips on demand (no pack to download)

The packs held 3015 clips (10 languages, about 300 each, 2240 MB), each one joined from lines of the game's own dub. All 3015 can be made again, sample for sample, from the dub archive the player already has, so a reply in German no longer needs `Voices-German.zip`.

When a reply is in a language the game is voiced in and the speaking voice is OmniVoice or the Mistral voice (or Pocket with a PocketTTS model of that language), the bridge asks for the clip of that one character (`bridge/language-clips.mjs`, `LanguageVoiceClips`, reached through `VoiceLanguagePacks.entry`). The order is:

| Order | Source | When |
|---|---|---|
| 1 | An installed pack | The pack is on disk and valid, as ever. Nothing changes for players who have one. |
| 2 | The player's own dub | `archive/pc/content/lang_<xx>_voice.archive` is in the game folder (`ep1` too when Phantom Liberty is installed). `bridge/voice_clip_build.py build-language` makes the clip in a process of its own at below normal priority. |
| 3 | Hugging Face, one file | No dub, or the build failed, or the recipe is not exact for this clip: `voice-clips/<lang>/<picked or archetypes or v-voice>/<key>.wav`, checked against the SHA-256 in the manifest. Only the character being voiced. |
| 4 | The English reference | Nothing above gave a clip yet (offline, or still being made). Exactly what happens with no pack today. |

A reply never waits. `entry()` is an in-memory lookup: when the clip is not ready it asks for it once, in the background, and answers nothing, so the English reference speaks that reply. The next reply in that language uses the dubbed clip. When the conversation is already in another language (the Reply language setting, or the language of the last exchange) a character is also asked for when it is invited and when a talk starts, so the clip is usually ready before the first line. One build at a time, shared with the English clip builds (`SerialQueue`), nothing per frame, nothing resident: the process exits when the clip is written.

Where things are:

- `characters/voice-language-clips/<lang>.json`: the recipe of every clip of a language (shipped with the code, about 200 KB each). Per voice: `kind`, `file`, `gender`, `text` (the dub's subtitles, what the clip says), `seconds`, `samples`, `sha256`, `exact`, and for an exact one `lines` (archive and path under `localization\<locale>\`), `how` (`pack`, `pack64` or `packv` for V) and `gain` (a linear factor, or null). A voice with `exact: false` has no recipe and is only downloaded. New keys are added by running `scripts/voice-extract/recover_language_manifest.py` again (see below).
- `<references>/multilingual/<lang>/<picked|archetypes|v-voice>/<key>.wav`: the clips, the same place an installed pack keeps them, so the voice workers (which accept a language reference only there) need nothing new. They are copied into every other reference folder a worker reads, like the English clips. `<references>/multilingual/<lang>/generated.json` marks a folder that holds clips made on the PC and no `manifest.json`: it is not an incomplete pack and raises no notice.
- `<state>/voice-language-clips.json`: the index of what is ready (SHA-256, size, built or downloaded). An entry counts only while its file is there with that size.
- `<references>/multilingual/<lang>/prepared/`: the Mistral voice's slot for each clip, made by the bridge's own `VoxtralVoice.buildFromPack` the first time the voice speaks (the same code that made the shipped slots). Nothing is shipped for it.

A failed clip is tried again after 15 minutes at the earliest (a player who comes online later gets it), never at every line. A voice that is not in the manifest (a custom character, a side character with no dub voice yet) is never asked for twice. `CYBERPUNK_CONVAI_LANGUAGE_CLIPS=0` turns the whole thing off, `CYBERPUNK_CONVAI_VOICE_CLIPS_DOWNLOAD=0` turns the download off (the same switch as the English clips). The support report lists, per language, how many clips are ready, built and downloaded, and whether the dub is installed (counts only).

A clip built from a game that has been patched (another hash) is kept: it is the player's own dub. A downloaded clip that does not match the manifest is refused.

### How the recipe was recovered

The pack builder (`scripts/voice-packs/`) recorded the dub's line ids, the subtitles and the clip's SHA-256 in each pack manifest, but not the dub's file for each id, the resampler, or the gain of the 44 voices that have a loudness stage. `scripts/voice-extract/recover_language_manifest.py --lang de --pack <voices/multilingual>` finds them from the installed pack and the dub archives in `E:/SteamLibrary/AiNpc-vo-stash` (read only):

1. Each line id is looked up in the archive's name listing (WolvenKit, used for the recovery only: the player's PC never lists an archive, the manifest names the paths). A line id with more than one candidate file is resolved by trying the candidates in order.
2. The recipe of the pack builder is repeated: vgmstream decode, mean of the channels, `scipy.signal.resample_poly` in float32 with no 16-bit file in between (`pack`), the lines joined with 0.4 s of silence, clipped to the range, and `rint(x * 32767)`. V uses the left channel when the channels are decorrelated and trims silence below -45 dBFS (`packv`).
3. The 44 voices with the loudness stage get a single linear factor. Each sample says in which interval the factor must lie, the intervals are intersected and the middle is stored with full precision.
4. A recipe is written only when the SHA-256 of the 16-bit WAV equals the one of the shipped clip. Anything else would be marked `exact: false` and stay download only. Result: all 3015 clips are exact (see the table).

### Proof

Run with the Python and vgmstream of the installed Runtime (the ones a player's PC builds with), against the dub archives of `E:/SteamLibrary/AiNpc-vo-stash` made visible to the builder as a game folder, `scripts/voice-extract/prove_language.py`. One process per voice, the way the bridge starts it, for a sample of every kind (both V voices, named characters, archetypes, and the voices that have a gain stage), then every clip of the language in one process:

| Language | Sample, one process per voice (identical to the pack's file) | Median time and peak memory per clip | Every clip of the language in one process | Voices with a gain stage |
|---|---|---|---|---|
| de | 26 of 26 | 2.20 s, 121 MB | 302 of 302 (79 s) | 44 of 44 |
| es-es | 26 of 26 | 2.24 s, 122 MB | 302 of 302 (119 s) | 42 of 42 |
| fr | 26 of 26 | 2.19 s, 121 MB | 301 of 301 (119 s) | 41 of 41 |
| it | 26 of 26 | 2.24 s, 121 MB | 302 of 302 (141 s) | 42 of 42 |
| ja | 26 of 26 | 2.22 s, 122 MB | 302 of 302 (84 s) | 44 of 44 |
| ko | 26 of 26 | 2.17 s, 121 MB | 302 of 302 (79 s) | 41 of 41 |
| pl | 26 of 26 | 2.20 s, 121 MB | 300 of 300 (118 s) | 41 of 41 |
| pt-br | 26 of 26 | 2.25 s, 121 MB | 302 of 302 (140 s) | 43 of 43 |
| ru | 26 of 26 | 2.26 s, 122 MB | 300 of 300 (119 s) | 43 of 43 |
| zh-cn | 26 of 26 | 2.20 s, 121 MB | 302 of 302 (84 s) | 42 of 42 |
| Total | 260 of 260 | about 2.2 s, 121 MB | 3015 of 3015 | 423 of 423 |

Each sample holds both V voices, 14 named characters, 10 archetypes and the voices that have a gain stage, in every language. The Python was the Runtime's (3.12.10, numpy 2.5.3, scipy 1.18.1), the vgmstream the Runtime's (the exe that made the packs), the game folders were made of hard links to the stash archives (nothing copied or written). The same recovery with the developer machine's Python (3.11, scipy 1.17.1) also gave 3015 of 3015, so the result does not depend on the scipy version. A clip takes a little over 2 s in a process of its own (the Python start and the scipy import are most of it) and 121 MB at its peak, once per character and language. Reading a line from the archive takes under a millisecond, as for the English clips.

A game on another CPU could in principle differ by one 16-bit step in a few samples (the resampler is float32), as the English notes say. The bridge keeps whatever it built and uses the built file's own hash, so nothing breaks, and the Mistral slot or OmniVoice prompt is made for that file.

### What the Nexus page and release texts must change

Nothing is edited by this branch (`docs/NEXUS_PAGE.md` is untouched). When it is released:

- The multilingual packs are no longer needed. The Nexus page lines that tell players to get the packs (the Optional files list entry for "Multilingual packs", the Mod Organizer 2 sentence about putting the multilingual packs in the mod's folder, the Voices and Dubbed voices lines of Languages) say instead that the game's dubbed voices are made on the PC from the game's own voice files for that language, or fetched for the character that is speaking, with no pack. The PocketTTS model line no longer says it needs the voice pack of the same language installed. State plainly that a player with the language's voice files in the game needs to download nothing, and that otherwise one small file per character is fetched when it first speaks in that language.
- `README.md` (optional packs table rows 10 and 11) and `packaging/HF_MULTILINGUAL_README.md` (the text of the Hugging Face multilingual folder): the packs become optional and no longer the way to get the dubbed voices. The old zips stay on Hugging Face for players who have them or want an offline copy.
- The in-game notice `pocket-language-pack` ("needs the voice pack of the language") should say the voice is being prepared, or be dropped, once the on-demand clips are released: with the PocketTTS model installed and no pack, Pocket now speaks as soon as the clip of that character is ready and shows the reply as text until then.
- The upload: 3015 files, 2240.3 MB, listed in `packaging/voice-language-clips-upload-list.json` (path in the repository, size, SHA-256). Nothing is uploaded by this branch.

## Where a pack installs

One zip per language, extracted into the game folder like every other pack:

```
red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual/<lang>/
  manifest.json
  picked/<voice>.wav          named characters (one long OmniVoice reference each)
  archetypes/<voice>.wav      pedestrian voices
  v-voice/v-male.wav, v-female.wav
  prepared/<key>.json + <key>.ogg   Voxtral slots for every WAV above, built with the bridge's own VoxtralVoice.build
```

Zip name: `Voices-<Language>.zip`, the language in full (`Voices-Chinese`, `Voices-French`, ...); the folder inside keeps the code. On Hugging Face they live in the `multilingual/` folder.

## manifest.json

```json
{
  "version": 1,
  "language": "zh-cn",
  "languageTag": "zh",
  "gameLanguage": "zh-cn",
  "built": "2026-10-21",
  "source": {"game": "2.31", "lines": "the English picks' line ids"},
  "voices": {
    "<voice key as in the English lists>": {
      "file": "picked/<voice>.wav",
      "text": "the words said in the clip, from the game's subtitles in this language",
      "seconds": 12.4,
      "lines": ["<16-hex line id>", "..."],
      "gender": "female"
    }
  }
}
```

`languageTag` is the code the bridge's language detection uses for replies (`zh`, `ja`, `ko`, `fr`, `de`, `it`, `es`, `pl`, `pt`, `ru`). A voice missing from the manifest keeps its English reference.

## How clips are chosen

No new search. Each English reference is a fixed list of game lines (clip ids `<voice>/<string id>[/female|male]` in the pick log and the autobest configs). The pack takes the same line ids from `base\localization\<lang>\vo\` and `ep1\localization\<lang>\vo\`, decodes them (vgmstream), and joins them like the English build (24 kHz mono 16-bit, 0.4 s of silence between clips, no EQ or denoise; the 44 voices whose English build has a -20 LUFS gain stage get the same gain, and V keeps its own trim recipe; details in VOICE_PACK_BUILDER.md). It then runs a cheap check per voice:

- the total fits OmniVoice's 20 s limit (trim at a pause if not);
- loudness is sane, with no clipping;
- the clips sound like one speaker (embedding similarity between them), which catches a line the dub gave to someone else.

A line that's missing in the dub or fails a check is replaced by the next line ranked in the English scoring. The transcript comes from that language's subtitles for the same line ids.

## How the bridge uses a pack

When a reply's detected language has an installed pack, and the speaking voice is OmniVoice or Voxtral, the reference (clip plus transcript) comes from the pack. Otherwise it's the English reference, as today. The voice-routing log names the pack reference (`ref="multilingual/zh-cn/picked/panam-palmer"`). A pack is found the same way as the other packs (all-or-none check of its manifest and files). A broken pack is ignored with one notice, never half-used.

## What the bridge does with a pack (implemented 2026-10-21, `bridge/voice-language-packs.mjs`)

**Finding and checking.** At service start, and again within 30 s of a change (a listing and a stat per manifest from the settings poll, never from a reply), the bridge reads `<references>/multilingual/<lang>/manifest.json` for each of the ten folder names above (`<references>` is the `voices/` folder; the dev checkout's `runtime/voice-references`). A pack is used only when all of this holds, else the whole pack is ignored with one log line (`[VoiceLanguagePacks] multilingual pack zh-cn is not used: <reason>`) and the reason goes in the support report (`voiceLanguagePacks`):

- `version` is 1, `language` is the folder name, `languageTag` is the code in the table above;
- every voice key matches `^[a-z0-9][a-z0-9-]{0,79}$`, its `file` matches `(picked|archetypes|v-voice)/<name>.wav`, and it has a non-empty `text`;
- every file exists and its header says 24 kHz, mono, 16-bit PCM, at most 20 s. The bridge reads the header only. The `prepared/` slots are not part of the check (a missing slot is made on the fly).

**Lookup.** The manifest is keyed by the voice key as the English lists have it (a named character, an archetype voice such as `resident-female`, a variant such as `npc-maelstrom-male-v2`, `v-male`, `v-female`), not by the shipped file name. A voice with no entry keeps its English reference. A voice the player gave a clip of their own (`runtime/player-voices`) also keeps it: no pack replaces it.

**OmniVoice.** The reply's language code picks the pack; the speaking voice key picks the entry. The worker is sent the pack clip as `languageReference` ({reference: `runtime/voice-references/multilingual/<lang>/<file>`, sha256, transcript}) beside the English profile; it checks it like any reference (inside the references folder, hash, 20 s) and speaks from the English reference, saying so, when it refuses it. The clip is used for both the Short and Long OmniVoice choices (a pack carries one long reference per voice). The prompt cache is keyed by the clip's own file and words, so an English and a Mandarin reference never share a prepared state.

**The Mistral voice (Voxtral).** The same lookup; the reference is cached under `<lang>|<voice key>`. `VoxtralVoice.buildFromPack(key, entry)` reads the clip, checks `sha256` when the manifest has one, and prepares it exactly like an English reference: an `archetypes/` clip speaks from one clip of the joined reference (the English archetype rule), the slot is `prepared/<key>.json` + `.ogg` in the pack's own folder, found by the same signature (`createReferencePreparer(...).signature(sha)`, where `sha` is the clip's SHA-256, or `oneClipHash` of it for an archetype clip that joins several lines, which is cut to its longest line first), and made there when it is missing. **The pack builder should make its slots by calling `buildFromPack` (or `finishReference` with `{ordinary: file starts with 'archetypes/', slots: <pack>/prepared}`) so the signatures match.**

**Pocket** speaks English only, except in the five languages that also have a PocketTTS model installed (French, Italian, German, Spanish, Portuguese: docs/POCKET_LANGUAGE_MODELS.md). Then it asks the pack for the clip of the character, like OmniVoice, and the model is used only while this pack is valid in the folder the Pocket worker reads.

**Routing log.** `ref="multilingual/<lang>/<picked|archetypes|v-voice>/<voice key>"` for OmniVoice and the Mistral voice when a pack clip speaks; the English set otherwise.

**Contract addition (optional, nothing breaks without it).** A voice entry may carry `"sha256": "<64 hex>"`, the SHA-256 of the WAV. Without it the bridge hashes the clip once, the first time the voice speaks. With it, a clip that changed after the pack was built is refused (English reference, one log line).

**Developer mode** (Settings > Developer mode) keeps the last spoken reply for a speaker check offline: `<state>/debug/last-reply-<omni|voxtral|pocket>.wav` (24 kHz mono 16-bit, every phrase in order) and `.json` (`engine`, `voiceKey`, `language`, `reference` as in the routing line, `referenceUsed` set to `english-fallback` when OmniVoice's worker refused the clip, `seconds`). No words of the reply. Off, nothing is held or written.
