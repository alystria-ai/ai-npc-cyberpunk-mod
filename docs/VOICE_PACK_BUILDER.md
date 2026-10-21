# The voice language pack builder (`scripts/voice-packs/`, 2026-10-21)

Builds the packs of `docs/VOICE_LANGUAGE_PACKS.md` (the contract) from the game's dubbed voice-over. Run everything with `vendor/reference-voicestudio/.venv/Scripts/python.exe -I` (numpy, scipy, soundfile, torch, torchaudio, speechbrain).

| Step | Command | Does |
|---|---|---|
| once | `trace_english.py` | traces the line ids of every shipped English OmniVoice long reference to game files, proves the join recipe against the shipped WAVs, writes `line-lists.json` (ids and file stems only) and `work/en/mapping-proof.json` |
| once | `ecapa_baseline.py` | ECAPA cosines between the clips of each English reference (`work/en/ecapa-baseline.json`), the base of the per-voice speaker bar |
| per language | `build_pack.py --lang zh-cn [--only key,key]` | extracts only the needed files from `E:/SteamLibrary/AiNpc-vo-stash/<lang>/{content,ep1}` (WolvenKit), decodes (vgmstream), joins, checks, writes `E:/SteamLibrary/AiNpc-voice-packs/<lang>/stage/...` and `work/<lang>/build-report.json` |
| per language | `finish_pack.py --lang zh-cn` | Voxtral slots (`prepare_slots.mjs`, the bridge's `VoxtralVoice.buildFromPack`), the bridge's own `loadPack` check (`validate_pack.mjs`), the zip + `.files.json` + `SHA256SUMS.txt` (`package_pack.mjs`), the listening sheet in `deliverables/voice-packs/<lang>/`, `work/<lang>/summary.json` and `per-voice.csv` |

Nothing game-derived is written inside the repository: audio, wem files and packs stay on E:.

## What the English recipe turned out to be (proved on all 301 traceable voices plus V)

- 301 of the 302 shipped references (299 config voices, V male and V female; `viktor-vektor` ships as the file `viktor-vektor-2.wav`) rebuild from their line ids with the same length and at most 15 16-bit steps of difference per sample (SNR at least 61 dB; the rest is rounding). `lucy-kushinada` is a web clip, not game audio: no pack entry, she keeps her English reference.
- Join: whole clips, mono, 24 kHz (scipy `resample_poly`: 605 of the 802 English clips; the others came through torchaudio's sinc resampler), 0.4 s of digital silence between clips, 16-bit PCM, no EQ or denoise.
- **A gain stage for 44 voices** (the clip-search 43 and `viktor-vektor`; their config `pick.gain`): one linear gain to -20 LUFS, true peak at most -1 dBTP, never quieter, hot sets turned down (`scripts/clip-search/loud43/apply_loud43.py`). The builder applies the same rule, recomputed on the dub, to the same 44 voices.
- V: its own recipe (`scripts/clip-search/v-voice/`): silence below -45 dBFS trimmed with 80 ms margin, left channel when the stereo channels are decorrelated, no gain.

## How a dub pack is made

- The dub file of a line is the same stem and string id under the language's locale folder: `zh-cn`, `fr-fr`, `it-it`, `de-de`, `es-es`, `jp-jp`, `kr-kr`, `pl-pl`, `pt-br`, `ru-ru` (found through the archive listing; if a stem differs the same string id is used).
- The transcript is the same string id in `lang_<archive>_text.archive` (installed, read-only; the file that holds it comes from the English subtitle index). Female variant for an `_f_` file, male for `_m_`; `<mothertongue .../>` markup becomes the words spoken.
- Per-voice checks: every clip 1 to 12 s, not clipped, gated level -36 to -10 dBFS, non-empty subtitle; the set at most 19.9 s (whole last clips dropped until it fits); ECAPA between the voice's clips against a per-voice bar (the English reference's own lowest pair minus 0.30, held between 0.10 and 0.35, and never above that lowest pair nor below 0.05: the English references themselves range from 0.01 to 0.8 between their clips). The speaker check needs the ECAPA weights in the Hugging Face cache (`speechbrain/spkrec-ecapa-voxceleb`); without them it is skipped and the report says so.
- A line that is missing in the dub or fails a check is replaced by the next line the English scoring ranked for that voice (the pool index's typicality for named voices, the archetype manifest's order for archetypes). A voice with no usable set (under 4 s, or its clips do not sound like one speaker with no replacement left) is left out of the manifest and keeps its English reference.
- The slots in `prepared/` are made with the bridge's own code, so their signatures are the ones the bridge looks for.
