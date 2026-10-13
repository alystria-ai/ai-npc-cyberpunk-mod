# Delamain's voice reference

The manifest points at `voice/delamain.wav` with its transcript. The wav is **game audio** (Delamain's own cab lines, English,
Samuel Barnett), so it is never committed: `.gitignore` excludes `addons/*/voice/*.wav` and `*-reference.json`. Without the file the
bridge logs "voice not used" and Delamain shows subtitles only; the add-on still works.

## What the current reference is

13.1 s, 24 kHz mono, 16-bit PCM, made from three of the twelve plain-voice `delamain_delamain_taxi_f_` lines (the cab's own spoken
lines in `archive/pc/content/lang_en_voice.archive`), left channel only (the two stereo channels are decorrelated, so a mean downmix
would comb-filter the voice), silence trimmed to 80 ms, 0.25 s between clips. Whisper small.en matches the installed subtitle text.
The transcript in `convai-addon.json` is those three subtitles joined with a space and must stay exactly equal to the audio.

Status: `extracted_and_local_transcript_verified`. **Not yet listened to**, so not approved. Listen to `voice/delamain.wav` once. If the
decorrelated stereo was an intended voice effect, or the clips sound phone-filtered or like a different performer, change the clip choice.

## Rebuild (reads the installed game; plays nothing)

1. `python scripts/clip-search/delamain/extract_delamain.py` extracts the 12 plain-voice cab lines (the WEM names come from
   `runtime/voice-cast-inventory-20261001`, the subtitle text from `research/cyberpunk/cache/game/localization/index/lookup.sqlite3`).
   Personality tags (sad, deep, glados, manic, angry, scared, suicidal, distorted, merged, receptionist) and holocall files are refused.
2. `python scripts/clip-search/delamain/build_reference.py` writes `addons/delamain/voice/delamain.wav` and `delamain-reference.json`.
3. Put the transcript it prints into `speakers[0].voice.transcript` of `convai-addon.json` if you changed the clips.
4. `node packaging/build-addon.mjs addons/delamain` ships the wav in the add-on zip. Decide before a public release whether a zip may
   carry game audio; the alternative is to drop the `voice` entry and let the player prepare a reference locally.

More clips are available (about 320 plain-voice lines in all, mostly phone-expression lines from the Delamain questline; see
`docs/addons/DELAMAIN_RESEARCH.md` section 2). A longer, more varied reference (up to the 20 s limit) is a quality option for the
voice engine after listening.
