# Multilingual Convai profiles (full roster)

Every character the mod has a Convai profile for (all 79 in `characters/roster.json`
with an ID in `runtime/characters.json`) has a twin named "<name> Multilingual" in the
same account, and so does each relationship variant. Today the only variants are the
five romantic profiles (Judy, Panam, River, Kerry, Meredith), so there are 84 twins.
The twins exist and are verified; the mod uses them while Settings > Conversations > Multilingual
conversations is on (see "Multilingual conversations" below).
Alt Cunningham is a tier-1 voice but has no Convai profile.

```powershell
node scripts/Create-MultilingualProfiles.mjs --dry-run        # default: plan only, no remote calls
node scripts/Create-MultilingualProfiles.mjs --apply          # create/adopt + verify all 84
node scripts/Create-MultilingualProfiles.mjs --apply --only judy-alvarez,judy-alvarez-romantic
node --test bridge/multilingual-profiles.test.mjs
```

The mapping is `runtime/multilingual-profiles.json` (ignored by Git, no secrets):
per profile key (a roster key, or `<key>-romantic`) the original ID, twin ID, name, voice, language list, model,
`verified`, `languageBoxField`, `languageBoxOff` and `notCloned`. Romantic twins are
keyed `<key>-romantic` (the provider key used in `runtime/relationship-profiles.json`)
and also record `variant: "romantic"` and `baseKey`. Only new characters are created;
originals are only read. A re-run adopts the mapped twin, or an existing twin found by
exact name plus the exact marker line, and re-verifies it, so it never duplicates. An
interrupted create with no matching character stops that profile instead of guessing.
`--apply` keeps going after a failing profile and lists it under `failures` (exit
code 1); re-running retries only what is not yet verified.

Ownership markers (the exact backstory line that identifies a character as ours):

| Profile | Marker line |
| --- | --- |
| Ordinary original | `[CyberpunkConvai profile v2:<key>]` |
| Ordinary twin | `[CyberpunkConvai profile v2:<key>:multilingual]` |
| Romantic original | `[CyberpunkConvai profile v2:<key>-romantic]` |
| Romantic twin | `[CyberpunkConvai profile v2:<key>-romantic:multilingual]` |

The romantic original has the same Convai display name as the ordinary profile (for
example both are "Judy Alvarez"), so the ordinary twin and the romantic twin are both
named "Judy Alvarez Multilingual". Tell them apart by character ID or marker, never by
name. (The name can be changed on the twin later without affecting the script, which
matches on name plus marker only to recover a lost create receipt.)

## What a twin copies and what differs

Copied and read back: biography (only the ownership marker line differs, so a twin
never matches its original's marker or another twin's), speaking style description,
sample dialogues, model (list readback), memory enabled, state of mind, verbosity,
and every other compared setting (moderation, filters, guardrails, traits, listing,
actions, narrative flag, temperature, and so on; any difference is listed in
`notCloned`, all empty today). A romantic twin clones the romantic profile, including
its added "CONVERSATION PROFILE" paragraph and affectionate style and samples.

Different on purpose:

- **Voice.** Convai refuses non-English `languageCodes` on a Kokoro voice
  ("Given voice incompatible with the language code"). Twins use a gender-matched
  Azure multilingual voice (Emma for women, Christopher for men; 71 languages). Gender comes from the original Kokoro voice, falling back to the roster's `gender`
  field (the dry run lists any key that needed the fallback; none did, and the two
  sources agree for the whole roster). The
  original Kokoro voice is not kept. The mod mostly speaks with its own local voices,
  so this matters only for Convai cloud voice. Romantic twins match the voice gender
  of the ordinary profile (Judy, Panam, Meredith: Emma; River, Kerry: Christopher).
- **Languages.** `languageCodes` is `['en-US']` only. With the language box off (next
  section) the character answers in whatever language the player uses, so the
  languages do not need to be listed. An earlier version listed ten interface
  languages; that is no longer wanted.
- **Not cloned:** the avatar (Convai assigns a random one; the mod does not use
  it) and `embodiment_data`. The originals have no knowledge bank files
  (`character/knowledge-bank/list` returned none for the 23 tier-1 profiles), no
  narrative design (`is_narrative_driven` false) and no actions, so nothing was
  missing.

## The "Only reply in the selected languages" box

The box is the dashboard field `language_hardening_mode`: `default` means ticked and
`off` means unticked. The twins want it unticked (`off`).

- Core `POST /character/update` **ignores** the field (camelCase and snake_case were
  both tried; readback was unchanged), and `/character/get` and `/character/list`
  never return it.
- The Core API key gets 401 on the web dashboard API
  (`https://convai.com/api/character/...`). Only a signed-in browser session can set
  it, with `POST https://convai.com/api/character/update` and JSON
  `{character_id, workspace_id, language_hardening_mode: 'off'}`.
- The script therefore **never sets it**. Its output includes `needsLanguageBoxOff`,
  the `{key, id, name}` of every twin whose mapping entry is not marked
  `languageBoxOff: true`. After the box is set through the browser session, edit the
  mapping entry to `languageBoxOff: true` (the script preserves that flag on re-runs).

Status (2026-10-07): all 84 twins (23 tier-1, 5 romantic, 56 for the rest of the roster)
have the box off, set through the web session and verified by readback, and are marked
`languageBoxOff: true` in the mapping.

## Voice and memory

- Voices stay Azure multilingual (Kokoro rejects non-English).
- Memory is per profile: Convai long-term memory is scoped by character ID plus
  end-user ID, so each twin keeps its own memory, as if it were another character.

## Multilingual conversations (the mod setting)

Settings > Conversations > **Multilingual conversations**, off by default (`multilingualConversations` in
`runtime/settings.json`). Code: `bridge/multilingual.mjs` (twin map, setting, per-turn voice),
`bridge/reply-language.mjs` (language detection), `bridge/relationship-routing.mjs` (twin selection),
`bridge/voice-selection.mjs` (the multilingual Omni worker), `mod/manager.lua` / `mod/mcm.lua` (setting, Apply notice).

### Routing

- The bridge loads `runtime/multilingual-profiles.json` at start. A twin is used only when its entry is
  `verified: true`, `languageBoxOff: true` and its `originalCharacterId` equals the ID the mod uses today
  (`runtime/characters.json`, or `relationship-profiles.json` for `<key>-romantic`); anything else stays on the
  original and is logged as "Multilingual profiles not used". No map is an English-only installation.
- Each twin becomes provider key `<providerKey>-multilingual` (`judy-alvarez-multilingual`,
  `judy-alvarez-romantic-multilingual`) in the original's family (`judy-alvarez`).
- On, relationship routing first decides ordinary or romantic exactly as before (Auto / Romantic / Ordinary, the
  same save facts), then the twin of THAT profile is used. A profile without a usable twin keeps its original.
- The setting commits at the same idle boundary as the relationship modes; every character with a twin is
  marked changed once, so its warm connections are replaced with the new character ID.

### Memory and Forget

- A twin is its own character for Convai memory (character ID + player ID), so its memories are separate from the
  original's, and switching the setting starts on the other profile's memories (nothing is copied; there is no
  memory-add API).
- The twin keys are in the family map (`providerFamilies`) used by player memory, the Forget command and chat
  history resets, so Forget for a character clears the original, the romantic profile and both twins, and Forget all
  clears every twin the player talked to. The Memory screen shows the canonical character only.
- `PlayerMemoryApi` checks each twin's own marker (`markerKeys`: `[CyberpunkConvai profile v2:<key>:multilingual]`);
  an original's marker on a twin ID, or the reverse, is refused (`NOT_MOD_OWNED`).

### Voice per turn

Pocket TTS speaks English only, so the voice is decided per turn (`planTurnVoice`) and again per reply
(`replyVoice`):

| Turn expected in | Chosen voice | Voice used | Natural speech / Expressive emotions instructions |
| --- | --- | --- | --- |
| English (or unclear) | any | the chosen voice | as today (local voices only) |
| another language | OmniVoice | OmniVoice, with the language | yes (Omni) |
| another language | Pocket, Omni pack installed and worker ready | OmniVoice (multilingual worker) | yes (Omni) |
| another language | Pocket, Omni pack installed, worker still loading | Convai cloud voice (twin's Azure voice); starts the worker | none |
| another language | Pocket, no Omni pack | Convai cloud voice | none |
| another language | Convai cloud voice | Convai cloud voice | none (as today) |

- The expected language is the player's message (script, function words, greetings), else the language of the last
  exchange (for reactions, the microphone placeholder and warm connections), else English.
- After a local turn's reply arrives, its own language decides: English keeps the chosen voice; another language uses
  OmniVoice (main worker or the multilingual worker) or, when none is ready, the reply is shown as text
  (`audioError`). A cloud-voice turn is already spoken by Convai whatever language came back (an English reply
  then uses the twin's Azure voice).
- The multilingual Omni worker is a second `ResidentVoice` (GPU) used only while Pocket is chosen. It is started by
  the first turn that needs it (never warmed ahead), renders at the saved Omni quality and reference, and is released
  when the setting goes off or OmniVoice becomes the chosen voice (only one Omni worker may hold the model slot, so
  the main worker waits for its exit). A failed start keeps it out until the setting is turned on again.
- The worker passes `language` (ISO 639-1) to OmniVoice; English requests are unchanged (`language='English'`).
  Checked on 2026-10-07 with Judy's reference: en, es, ja, de, zh, ru all render (16 steps, about 2.3 to 3 s each on
  the laptop GPU under load).

### Natural speech and Expressive emotions without the Omni pack

Both need a local voice (the cloud voice would read the tags aloud). The instructions are sent per turn only when the
planned voice is local, so a turn that goes to the cloud voice never asks for tags. Without the pack, the two
settings therefore keep working for English replies and are simply absent from replies in other languages; nothing
is switched off. The Apply that creates this combination (Multilingual on, no Omni pack, Pocket chosen, either
setting on) says so once: "Without the OmniVoice pack, replies in other languages use the Convai cloud voice, so
Natural speech and Expressive emotions apply only to English replies." With the pack (or OmniVoice chosen)
everything works together.

### Known limits

- **Microphone:** the player's speech is transcribed by Convai's server STT through the realtime SDK (no local
  recogniser; the PocketSphinx "US English" model is only the lip-sync phone analyser). The SDK has no STT language
  field; recognition follows the character's languages, and the twins list only `en-US`. Speaking another language
  into the microphone is untested and probably transcribes as English. Text chat works in any language.
- **Lip sync:** the facial model is trained on English game audio but works from audio alone, so the mouth still moves
  for other languages, with English-shaped visemes.
- **Subtitles and phone chat:** the text path is UTF-8 safe (character-based splitting, no byte truncation of reply
  text). The mod sets no font on reply text; the game's font for the selected game language draws it, so CJK or
  Cyrillic replies with an English game language may show missing glyphs (to check in game).
- **Cloud voice:** with the Convai cloud voice, a twin speaks with its Azure multilingual voice (Emma or Christopher),
  not the original Kokoro voice, also in English.
