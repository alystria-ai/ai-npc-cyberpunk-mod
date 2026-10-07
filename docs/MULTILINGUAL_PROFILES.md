# Multilingual Convai profiles (full roster)

Every character the mod has a Convai profile for (all 79 in `characters/roster.json`
with an ID in `runtime/characters.json`) has a twin named "<name> Multilingual" in the
same account, and so does each relationship variant. Today the only variants are the
five romantic profiles (Judy, Panam, River, Kerry, Meredith), so there are 84 twins.
The twins exist and are verified; the mod does not use them yet (no routing change).
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

## Routing (not done)

- Memory: an original and its twin keep separate memories for the same player UUID.
  Options: (a) pick one profile per character for the whole save based on a setting
  and accept a reset when switching; (b) keep both and add the twin to the
  family/forget scope (`bridge/player-memory-api.mjs` allows only exact
  `[CyberpunkConvai profile v2:<key>]` markers, so each twin marker needs its own
  provider key and a family map entry, like `canonical-romantic`); (c) seed
  nothing (no `/memory/add` exists). Forget must clear all of them.
- Relationship alternates: the five romantic twins exist (see the table above), so
  routing can pick the ordinary twin or the romantic twin by the same relationship
  decision that picks the ordinary or romantic original.
- Provider keys and ID maps (`runtime/characters.json`,
  `relationship-profiles.json`) are unchanged; the twin map is separate.
- Transient sessions and phone chat sessions key by provider ID, so switching
  profiles starts fresh sessions; local Chat history stays under the canonical key.
- Local TTS: Pocket is English-only, so non-English replies need Omni or the
  Convai Azure voice the twin already has.
