# Voice language packs

Optional packs that let OmniVoice and the Mistral voice (Voxtral) clone a character from the game's own dub in the reply's language, instead of the English actor's clips. One pack per voiced language of the game: `fr`, `it`, `de`, `es-es`, `ja`, `ko`, `pl`, `pt-br`, `ru`, `zh-cn` (Steam's "Full Audio" list). Pocket speaks English only and gets nothing from them.

Status: being built (owner decision 2026-10-21). This file is the contract between the pack builder and the bridge.

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

Zip name: `AI-NPC-Cyberpunk-Mod-Voices-<lang>.zip`. On Hugging Face they live in the `multilingual/` folder.

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

No new search. Each English reference is a fixed list of game lines (clip ids `<voice>/<string id>[/female|male]` in the pick log and the autobest configs). The pack takes the same line ids from `base\localization\<lang>\vo\` and `ep1\localization\<lang>\vo\`, decodes them (vgmstream), and joins them like the English build (24 kHz mono 16-bit, 0.4 s of silence between clips, no EQ or denoise). It then runs a cheap check per voice:

- the total fits OmniVoice's 20 s limit (trim at a pause if not);
- loudness is sane, with no clipping;
- the clips sound like one speaker (embedding similarity between them), which catches a line the dub gave to someone else.

A line that's missing in the dub or fails a check is replaced by the next line ranked in the English scoring. The transcript comes from that language's subtitles for the same line ids.

## How the bridge uses a pack

When a reply's detected language has an installed pack, and the speaking voice is OmniVoice or Voxtral, the reference (clip plus transcript) comes from the pack. Otherwise it's the English reference, as today. The voice-routing log names the pack reference (`ref="multilingual/zh-cn/picked/panam-palmer"`). A pack is found the same way as the other packs (all-or-none check of its manifest and files). A broken pack is ignored with one notice, never half-used.
