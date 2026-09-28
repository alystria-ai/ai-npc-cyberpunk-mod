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

## Why a small extraction is sufficient

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

## Scaling to the named roster

Build a per-character inventory first, using the roster key and actual game record as separate fields. Resolve aliases and entity/voice tags, join scene speakers to localization IDs, then request only a few candidate paths for each character. Keep base-game and DLC namespaces explicit. Deduplicate repeated scene uses by WEM path or audio hash.

For each candidate, retain the local archive identity, StringID, complete WEM path, transcript variant, original WAV, decoder version, sample count and review status. Prefer a complete 6–15 second conversational line with one speaker and enough phonetic variety. Exclude choice captions without audio, grunts, songs, screams and phone/helmet versions unless that delivery is intentional. Listen to the actual extracted clip before marking it suitable; format and amplitude checks cannot establish naturalness, background isolation or identity.

Use explicit statuses such as `metadata_found`, `extracted_and_local_transcript_verified`, `listening_verified`, and `reference_approved`. Leave missing or ambiguous voices unresolved. A summonable named character is not a guarantee of a distinct recorded speaking voice. Keep the selected reference and its exact transcript paired when handing them to VoiceStudio; any backend-specific resampling or mono conversion belongs in a separate derived copy with its own receipt.
