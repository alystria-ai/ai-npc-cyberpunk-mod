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

## What the bridge does with a pack (implemented 2026-10-21, `bridge/voice-language-packs.mjs`)

**Finding and checking.** At service start, and again within 30 s of a change (a listing and a stat per manifest from the settings poll, never from a reply), the bridge reads `<references>/multilingual/<lang>/manifest.json` for each of the ten folder names above (`<references>` is the `voices/` folder; the dev checkout's `runtime/voice-references`). A pack is used only when all of this holds, else the whole pack is ignored with one log line (`[VoiceLanguagePacks] voice language pack zh-cn is not used: <reason>`) and the reason goes in the support report (`voiceLanguagePacks`):

- `version` is 1, `language` is the folder name, `languageTag` is the code in the table above;
- every voice key matches `^[a-z0-9][a-z0-9-]{0,79}$`, its `file` matches `(picked|archetypes|v-voice)/<name>.wav`, and it has a non-empty `text`;
- every file exists and its header says 24 kHz, mono, 16-bit PCM, at most 20 s. The bridge reads the header only. The `prepared/` slots are not part of the check (a missing slot is made on the fly).

**Lookup.** The manifest is keyed by the voice key as the English lists have it (a named character, an archetype voice such as `resident-female`, a variant such as `npc-maelstrom-male-v2`, `v-male`, `v-female`), not by the shipped file name. A voice with no entry keeps its English reference. A voice the player gave a clip of their own (`runtime/player-voices`) also keeps it: no pack replaces it.

**OmniVoice.** The reply's language code picks the pack; the speaking voice key picks the entry. The worker is sent the pack clip as `languageReference` ({reference: `runtime/voice-references/multilingual/<lang>/<file>`, sha256, transcript}) beside the English profile; it checks it like any reference (inside the references folder, hash, 20 s) and speaks from the English reference, saying so, when it refuses it. The clip is used for both the Short and Long OmniVoice choices (a pack carries one long reference per voice). The prompt cache is keyed by the clip's own file and words, so an English and a Mandarin reference never share a prepared state.

**The Mistral voice (Voxtral).** The same lookup; the reference is cached under `<lang>|<voice key>`. `VoxtralVoice.buildFromPack(key, entry)` reads the clip, checks `sha256` when the manifest has one, and prepares it exactly like an English reference: an `archetypes/` clip speaks from one clip of the joined reference (the English archetype rule), the slot is `prepared/<key>.json` + `.ogg` in the pack's own folder, found by the same signature (`createReferencePreparer(...).signature(sha)`, where `sha` is the clip's SHA-256, or `oneClipHash` of it for an archetype clip that joins several lines, which is cut to its longest line first), and made there when it is missing. **The pack builder should make its slots by calling `buildFromPack` (or `finishReference` with `{ordinary: file starts with 'archetypes/', slots: <pack>/prepared}`) so the signatures match.**

**Pocket** speaks English only and never asks.

**Routing log.** `ref="multilingual/<lang>/<picked|archetypes|v-voice>/<voice key>"` for OmniVoice and the Mistral voice when a pack clip speaks; the English set otherwise.

**Contract addition (optional, nothing breaks without it).** A voice entry may carry `"sha256": "<64 hex>"`, the SHA-256 of the WAV. Without it the bridge hashes the clip once, the first time the voice speaks. With it, a clip that changed after the pack was built is refused (English reference, one log line).

**Developer mode** (Settings > Developer mode) keeps the last spoken reply for a speaker check offline: `<state>/debug/last-reply-<omni|voxtral|pocket>.wav` (24 kHz mono 16-bit, every phrase in order) and `.json` (`engine`, `voiceKey`, `language`, `reference` as in the routing line, `referenceUsed` set to `english-fallback` when OmniVoice's worker refused the clip, `seconds`). No words of the reply. Off, nothing is held or written.
