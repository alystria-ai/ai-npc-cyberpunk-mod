# Local game dialogue as voice references

Verified on 2026-09-28 against the installed game at `E:\SteamLibrary\steamapps\common\Cyberpunk 2077`.

## Result

Bounded extraction works with tools already on this computer. **21 individual dialogue clips** were copied from the installed English archives and decoded to WAV, totaling **112.899 seconds**. Their exact transcripts were read from the installed subtitle resources by StringID. Every extracted resource passed the archive's SHA-1 check; every WEM had a complete RIFF/WAVE container; every WAV was independently inspected with FFprobe.

All WAVs are **48 kHz, 16-bit PCM**, with zero full-scale clipped samples. Ana, Blue Moon and Judy are mono; Johnny and Smasher retain their source stereo layout. No gain, denoising, EQ, resampling, trimming or concatenation was applied. No game files were changed, no tools were installed, and no speech model or GPU workload was run.

These are technically verified benchmark inputs. Listening review and clone-quality evaluation are still pending. A `vo` path does not guarantee that the asset lacks character-specific processing.

### Familiar-character comparison added later on September 28

At the user's request, added two Panam lines from `q114_05_quiet_place`, with the same named-speaker, local archive hash, exact subtitle, RIFF and PCM checks. The combined manifest now contains **23 clips**, including an 8.869-second Panam reference (`1935981141805363200`). `selected-benchmark.json` includes Panam alongside Johnny and Judy for the next listening comparison. Her two original recordings are in `runtime/voice-references/panam-extracted/`; no audio processing was applied. This addition is separate from the initial extraction totals above.

## Files

- `scripts/Extract-VoiceReferences.py`: bounded local extractor and verifier; makes no network calls.
- `runtime/voice-references/inventory.json`: installed archives, tool paths, remote metadata queries and local path-hash checks.
- `runtime/voice-references/extracted/manifest.json`: all 21 clips, exact transcripts, source archives, depot paths, path hashes, subtitle IDs, resource checksums, decoder output and FFprobe results.
- `runtime/voice-references/selected-benchmark.json`: five initial reference pairs and the explicit 8ug8ear exclusion.
- `runtime/voice-references/extracted/<character>/<StringID>.wem`, `.wav`, `.txt`: untouched WEM, decoded WAV and exact UTF-8 transcript.
- `runtime/voice-references/bugbear-unverified.json`: metadata for unassigned generic voice assets; no extracted audio.

`runtime/` is ignored by Git. Recorded dialogue and transcript text stay there; this document and the extractor contain no game dialogue. Read all JSON and transcript files explicitly as UTF-8 on Windows.

### Initial benchmark selection

Each stem below has adjacent `.wav` and `.txt` files under `runtime/voice-references/extracted/`.

| Character | Relative stem | Actual duration | Channels | Selection note |
| --- | --- | ---: | ---: | --- |
| Ana Friedman | `ana-friedman/3241597669668655104` | 9.788 s | 1 | Descriptive conversational line from the client meeting |
| Blue Moon | `blue-moon/1864881884746653696` | 7.567 s | 1 | Spoken park conversation; relatively quiet source level |
| Judy Alvarez | `judy-alvarez/1947721441586405376` | 8.059 s | 1 | Conversational account of her technical interests |
| Johnny Silverhand | `johnny-silverhand/3475057498618839040` | 8.342 s | 2 | Conversational delivery; character processing remains |
| Adam Smasher | `adam-smasher/1995167848803622912` | 3.828 s | 2 | Short supplemental candidate; processed character voice |

Smasher's selected line is shorter than the preferred 6–15 second starting range. The manifest includes alternatives but none were lengthened artificially. Johnny's actual decoded durations differ from the remote index by up to about 0.30 seconds; local sample counts are authoritative.

## Installed archive inventory

The counts below are archive entries, including metadata and other resources; they are not counts of clean dialogue references.

| Archive relative to game root | Bytes | Entries |
| --- | ---: | ---: |
| `archive/pc/content/lang_en_voice.archive` | 4,980,334,592 | 90,263 |
| `archive/pc/ep1/lang_en_voice.archive` | 1,643,462,656 | 27,513 |
| `archive/pc/content/lang_en_text.archive` | 7,598,080 | 3,087 |
| `archive/pc/ep1/lang_en_text.archive` | 2,252,800 | 717 |

The installed REDmod package also supplies `tools/redmod/bin/oo2ext_7_win64.dll`. The extractor loads that existing library for the small, compressed subtitle resources. No copy or installation is needed.

Existing audio tools:

- `C:\Users\akshi\Downloads\misc\modding\fmodel\Output\.data\vgmstream-cli.exe` — r2055; help and actual decoding verified.
- `C:\ffmpeg\bin\ffprobe.exe` — output format and decoded duration verified.
- `C:\ffmpeg\bin\ffmpeg.exe` — available, not used to transform these clips.

No WolvenKit executable was found in the searched workspace and common program/download locations. This is not a claim that no copy exists on another drive. The limited extractor completed the requested sample without it.

## Mapping dialogue to the right character

WolvenKit's source defines the useful join explicitly:

1. A scene screenplay line has a `speaker` actor ID and a `locstringId`.
2. Resolve that actor inside the scene to its character/entity or voice tag.
3. Match the localization ID to subtitle `stringId` and the appropriate `femaleVariant`/`maleVariant`.
4. Match the same ID to `locVoLineEntry.stringId`, then use `femaleResPath`/`maleResPath` for the WEM.

The male/female fields describe dialogue variants; an `_f_` filename is not evidence that the speaker is female. A subtitle entry alone does not identify the speaker. Keep these 64-bit IDs and archive offsets as decimal strings in JSON to avoid JavaScript precision loss. [WolvenKit scene-line type](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Types/Classes/scnscreenplayDialogLine.cs), [subtitle-entry type](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Types/Classes/localizationPersistenceSubtitleEntry.cs), [voice-entry type](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Types/Classes/locVoLineEntry.cs).

SoundDB provides searchable scene/speaker metadata and the WEM/subtitle paths. Its documented API base is `https://sounddb.zhincore.eu/v1/`; `/search/subtitles` accepts `q`, `page` and `per_page`. Useful filters include `actor`, `scene`, `voiceover` and `expression`. The current selected candidates came from character-specific WEM paths with named scene speakers. The manifest records the metadata URL for that attribution. This scene mapping has not been independently re-parsed from local scene files. Audio bytes and subtitle text were separately verified against local archives. [SoundDB search documentation](https://sounddb.redmodding.org/about), [API specification](https://sounddb.zhincore.eu/api.json).

Local REDmod tweak records support `judy`, `johnny`, `smasher` and `blue_moon` voice tags. Ana's `Character.sts_ep1_08_client_background` record does not contain an explicit tag, but the scene index identifies Ana and her files use `ana_friedman_sts_ep1_08`. A name lookup should therefore be a discovery aid rather than the only speaker check.

## Bounded reference extraction

Dialogue WEMs are individual resources in the language voice archives. OpusPak extraction is primarily the sound-effects route and is unnecessary for these selected lines. Main, holocall and helmet assets can be separate variants; prefer the main spoken asset for a neutral reference. [WolvenKit audio guide](https://wiki.redmodding.org/wolvenkit/wolvenkit-app/usage/video-and-audio), [audio-file documentation](https://wiki.redmodding.org/cyberpunk-2077-modding/for-mod-creators-theory/files-and-what-they-do/audio-files).

Every selected WEM was a single uncompressed archive segment. The extractor reads the RDAR index, hashes the normalized depot path with FNV-1a, copies only that entry and verifies its SHA-1. Subtitle resources use KARK/Oodle compression; after decompression, the script locates the typed `stringId: CRUID` property and reads its typed string variant with REDengine's signed VLQ length encoding. It rejects unknown layouts, ambiguous IDs, inconsistent local transcript variants, multi-segment resources and resources larger than 32 MiB. [WolvenKit archive reader](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Archive/IO/ArchiveReader.cs), [Oodle implementation](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.Core/Compression/Oodle.cs), [string reader](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.Core/Extensions/BinaryReaderExtensions.cs).

From the workspace root, reproduce the bounded extraction with:

```powershell
python scripts/Extract-VoiceReferences.py
```

The current allowlist contains 21 clips. The script caps a run at 48 clips, writes only beneath `runtime/voice-references`, rejects 8ug8ear candidates with unresolved ownership, and launches the decoder and probe without visible console windows. For general archive formats or a wider metadata export, WolvenKit remains the maintained alternative; its CLI supports exact hash or filename filters. Check its installed-version help before using its commands. [WolvenKit CLI commands](https://wiki.redmodding.org/wolvenkit/wolvenkit-cli/usage/command-list).

## 8ug8ear requires another ownership check

Her local `Character.sts_hey_rey_09_tobias` record has no explicit `voiceTag`. Searches for actor aliases returned no named speaker results. A broader `voiceover:bugbear` query did find eight generic `civ_mid_f_07_enus_15` lines associated with `bugbear_default`, plus two V lines. SoundDB supplies no scene mapping for those default lines; they may be unused. Her actual gig also has a hum under that generic voice, which is unsuitable as a speech reference.

These findings do not prove that she has no usable speech. They also do not establish those generic default lines as her canonical spoken performance. Inspect the local scene/entity assignment and listen before selecting them. None was extracted or approved here.

## Hand-extracted references for 8ug8ear and Jake Estevez (2026-10-13)

Neither character had a clip in the picker's pool (the pool index lists them with no clips), so no auto-best set existed and all three
configs (`pocket-voices.autobest.json`, `local-voices.autobest-short.json`, `local-voices.autobest-long.json`) had them as
`unprepared`. Their lines were found in the scene files and the voice archive instead. Scripts: `scripts/clip-search/missing-two/`
(`extract_two.py`, `analyze_two.py`, `select_build.py`, `asr_check.py`). Raw decoded clips, the analysis and the listening copies are
in `E:\CyberpunkConvai-offload\work\clip-search\missing-two\` (`raw/<key>/<StringID>.{wem,wav,txt}`, `analysis.json`, `asr-check.txt`,
`listen/`); no game dialogue is kept in the repo.

- **Jake Estevez**: scene `sts_hey_gle_06_scene` (Heywood, Glen). The actor `Estevez` speaks six lines, all in the voice files
  `civ_mid_m_14_enus_20_sts_hey_gle_06_f_<id>.wem`; every other actor of that scene has a different voice tag, so the speaker is
  certain. Six clips, 1.7 to 7.4 s.
- **8ug8ear**: the voice files `civ_mid_f_07_enus_15_scene_bugbear_default_f_<id>.wem` (eight lines, the scene `bugbear_default`). The
  earlier check left their ownership open because `civ_mid_f_07` is a shared civilian model and the scene has no English store. The
  captions settle it: they are a woman thanking V for saving her, describing her bruises, and naming Wakako, which is only her
  after-rescue situation. They carry no hum (the gaps are digital silence); the hum noted earlier belongs to the gig's own scene, whose
  one native line has empty English text. Eight clips, 1.1 to 5.8 s. This is content evidence, not a scene-to-entity proof: listen.

Checks (objective, `analysis.json`): no clipped samples (peaks -11 to -1.8 dBFS), gated loudness -22 to -23 dB against the pool's -23
(Jake's last line, -18.4 dB, is left out as the loud outlier), silence ratio 0.2 to 0.6 (fixed 0.3 s lead and trail, pauses), no noise
floor or hum, 99 percent of the energy under 2.5 to 4.7 kHz, not the telephone band limit (Judy's reference measures 4.1 kHz).
Speaker consistency by ECAPA (cosine between clips): Jake's six clips agree at 0.39 to 0.75 (the lowest involve the short thanks line
and the 1.7 s line, which are not used; the two used agree at 0.75); 8ug8ear's eight at 0.11 to 0.65 (the 1.1 s and 1.5 s clips are the
low outliers; the four used agree at 0.54 to 0.65). Eight unrelated characters' references agree at 0.15 on average and 0.31 at most,
so each set is one voice. A Whisper small.en pass over the raw clips matches the installed captions (word similarity 0.86 to 1.00 for the
clips used; the differences are contractions and a proper noun).

Built the clip-search way (whole clips in the listed order, 0.4 s gaps, mono 24 kHz torchaudio resample, 16-bit PCM; no EQ, denoise or
gain), into `runtime/voice-references/picked/autobest/<omni-short|omni-long|pocket>/<key>.wav`. The picks were chosen by duration-weighted
leave-one-out ECAPA typicality with a 0.004 per second length bonus, among clips of 1.5 to 9 s with at least three words, typicality of
0.55 or more, loudness within 2 dB of the median and peak under -3 dBFS. The Pocket set is the long set (the Pocket student trained on
references up to 18 s).

| Key | Set | Clips (StringID) | Seconds | sha256 |
| --- | --- | --- | ---: | --- |
| `jake-estevez` | omni-short | 1925828924100177920 | 7.38 | `1be5680ea82d9df4b1b059f595c40d9cae34765af7f4a235ee376ae1e37cf1dc` |
| `jake-estevez` | omni-long, pocket | 1925828924100177920, 1925831516700143616 | 12.24 | `bf0716fa388188008604941db9f1312f9f744645b5e7a88816492ab9d343f131` |
| `8ug8ear` | omni-short | 1937554339705671680, 1949225073582559232 | 8.52 | `b703798588ea7ec0ce3c51d5788ede6b080abb9bf3bff6c93aa4d813d3bd2a4c` |
| `8ug8ear` | omni-long, pocket | 1937537478452596736, 1937554339705671680, 1949225070059343872, 1949225073582559232 | 14.99 | `328a9a6ef342690ac7b6f6bce2aecf7252aca1550e56aa83d7aa6d91b622bfeb` |

All three configs load with the bridge's Node and Python loaders (256 voices ready, none unavailable). To ship: upload the six WAVs to
`final/voice-references/picked/autobest/` and the three config files to `final/voice-configs/` in the Hugging Face bucket. Re-running
`scripts/Build-AutobestConfigs.mjs` would put both back to `unprepared` (the pool has no clips for them), so re-apply these entries
afterwards.

## Scaling to the named roster

Build a per-character inventory first, using the roster key and actual game record as separate fields. Resolve aliases and entity/voice tags, join scene speakers to localization IDs, then request only a few candidate paths for each character. Keep base-game and DLC namespaces explicit. Deduplicate repeated scene uses by WEM path or audio hash.

For each candidate, retain the local archive identity, StringID, complete WEM path, transcript variant, original WAV, decoder version, sample count and review status. Prefer a complete 6–15 second conversational line with one speaker and enough phonetic variety. Exclude choice captions without audio, grunts, songs, screams and phone/helmet versions unless that delivery is intentional. Listen to the actual extracted clip before marking it suitable; format and amplitude checks cannot establish naturalness, background isolation or identity.

Use explicit statuses such as `metadata_found`, `extracted_and_local_transcript_verified`, `listening_verified`, and `reference_approved`. Leave missing or ambiguous voices unresolved. A summonable named character is not a guarantee of a distinct recorded speaking voice. Keep the selected reference and its exact transcript paired when handing them to VoiceStudio; any backend-specific resampling or mono conversion belongs in a separate derived copy with its own receipt.

## Additional dialogue for training

The user's later request to spend more time training character voices expands
the scope beyond the 23 short comparison references. The separate preparation
pipeline extracts an explicit allowlist of up to 240 lines each for Judy,
Johnny and Panam, using the same archive/transcript verification in batches of
32. Source WAVs are preserved; training and evaluation use separate scene groups.
See [character voice preparation](VOICE_TRAINING.md) for dataset counts, model
revisions, limits and the distinction between a trained adapter and an accepted
voice. The original reference manifests and listening comparisons remain intact.

## Hand-extracted references for Rita Wheeler (2026-10-18)

Rita Wheeler (`Character.lizzies_bouncer`, the Mox door guard at Lizzie's Bar) is a named character with her own lines. Attribution is at scene level:

- Scene `base\quest\main_quests\prologue\q000\scenes\q000_corpo_04_lizzies_club.scene` (The Corpo-Rat), exported with `research/cyberpunk/scripts/extract_scene_evidence.py` (batch `rita-lizzies-door`). Its actor 6 is named `lizzies_bouncer` (the name of her character record), community entry `bouncer`, voicetag id 1624173162027036812, and is the speaker of nine screenplay lines. `scripts/clip-search/rita-wheeler/scene_lines.py` lists them.
- The nine locstring ids map one to one to the nine voice files `civ_prnd_f_01_enus_30_q000_f_<hex>.wem`, which are the only files with that prefix in the voice archive, and to nine installed English subtitle entries (the transcripts).
- Not used: the door guards of `q105_01a_bouncer` and `q004_01_meet_the_lizzies` (community entries `bouncer_quest_01` and `bouncer_quest_02` of `wat_kab_com_lizzies_default`). They speak with other voice tags (`gang_liz_f_01`, `gang_liz_f_03`) and nothing in the exported scenes ties them to her record, so a shared look or role is not accepted as identity.

Extracted by `scripts/clip-search/rita-wheeler/extract_rita.py` (the low-level helpers of `Extract-VoiceReferences.py`: archive index, Oodle, RIFF check, vgmstream, FFprobe-style WAV facts) into `runtime/voice-references/extracted/rita-wheeler/<StringID>.{wem,wav,txt}`. All nine are mono 48 kHz 16-bit, no clipped samples, digital silence between words (no noise floor, no hum). Seconds, in scene order: 1.93, 2.22, 2.78, 2.89, 1.33, 2.20, 1.79, 2.01, 1.74. A Whisper small.en pass (`asr_check.py`) matches the subtitles at 0.73 to 1.00 word similarity (the differences are the non-word "Pff", a contraction and one mis-heard word); pitch median about 190 to 220 Hz (crude estimate, so an average-pitch voice with a clipped, blunt delivery rather than a low one).

Built by `build_rita.py` (clip-search recipe: whole clips, 0.4 s gaps, mono 24 kHz, 16-bit; no EQ, denoise or gain). The four shouted lines (gated loudness 17 to 19.5 dB against the set median of 22) stay out; the rule is the usual one (1.5 to 9 s, at least three words, within 2 dB of the median, peak at most -3 dBFS). ECAPA typicality was not run: the weights are not on disk since the 2026-10-16 clean-up and fetching them needs approval; all nine clips are one actor in one scene, so one voice holds by construction.

| Key | Set | Clips (StringID) | Seconds | sha256 |
| --- | --- | --- | ---: | --- |
| `rita-wheeler` | omni-short | 1672130344050925568, 1877987316845268992, 1882154225697222656, 1985029939546484736 | 9.98 | `ca35e3ecfd937568f12db48b05ddb992862eb71c6a2d2fd6accbd0039c54e1f2` |
| `rita-wheeler` | omni-long, pocket | the four above plus 1877994627231928320 (1.33 s), in scene order | 11.71 | `5b8050f02875ca5b685449bd4f42baea8a64ec7b7187323aa1463772273fee46` |

Wired into `runtime/pocket-voices.autobest.json`, `runtime/local-voices.autobest-short.json` and `runtime/local-voices.autobest-long.json` (the three files `runtime/voice-configs.json` names; Voxtral reads the Omni long set first, then Pocket). `lucy-kushinada` has `{"status": "unprepared"}` in the same three files (no game voice). The Node and Python loaders accept all three (`node` registry 257 ready, 1 unavailable: Lucy; the hashes match). Backups of the three files: `runtime/backups/rita-voice-20261018/`. `packaging/release-plan.json` lists `rita-wheeler` under `voice.localProfiles` (77). To ship: upload the three WAVs to `final/voice-references/picked/autobest/{omni-short,omni-long,pocket}/rita-wheeler.wav` and the three config files to `final/voice-configs/` in the Hugging Face bucket; re-running `scripts/Build-AutobestConfigs.mjs` would put her back to `unprepared` (the pool has no clips for her), so re-apply `build_rita.py` afterwards.
