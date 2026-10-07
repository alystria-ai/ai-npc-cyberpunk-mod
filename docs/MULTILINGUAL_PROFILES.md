# Multilingual Convai profiles (tier 1)

Each of the 23 tier-1 characters with a Convai profile has a twin named
"<name> Multilingual" in the same account. The twins exist and are verified; the
mod does not use them yet (no routing change). Alt Cunningham is the 24th tier-1
voice but has no Convai profile.

```powershell
node scripts/Create-MultilingualProfiles.mjs --dry-run        # default: plan only, no remote calls
node scripts/Create-MultilingualProfiles.mjs --apply          # create/adopt + verify all 23
node scripts/Create-MultilingualProfiles.mjs --apply --only judy-alvarez
node --test bridge/multilingual-profiles.test.mjs
```

The mapping is `runtime/multilingual-profiles.json` (ignored by Git, no secrets):
per character the original ID, twin ID, name, voice, language list, model,
`verified`, `replyAnyLanguageApplied`, `manualUntickRequired` and `notCloned`.
Only new characters are created; originals are only read. A re-run adopts the
mapped twin, or an existing twin found by exact name plus the exact marker line
`[CyberpunkConvai profile v2:<key>:multilingual]`, and re-verifies it, so it never
duplicates. An interrupted create with no matching character stops instead of
guessing.

## What a twin copies and what differs

Copied and read back: biography (only the ownership marker line differs, so the
twin never matches the original's marker), speaking style description, sample
dialogues, model (list readback), memory enabled, state of mind, verbosity, and
every other compared setting (moderation, filters, guardrails, traits, listing,
actions, narrative flag, and so on; any difference is listed in `notCloned`, all
empty today).

Different on purpose:

- **Voice.** Convai refuses non-English `languageCodes` on a Kokoro voice
  ("Given voice incompatible with the language code"). Twins use a
  gender-matched Azure multilingual voice (Emma for women, Christopher for men;
  71 languages). The original Kokoro voice is not kept. The mod mostly speaks with
  its own local voices, so this matters only for Convai cloud voice.
- **Languages.** `languageCodes` is the ten interface languages (en-US, zh-CN,
  zh-TW, es-ES, pt-BR, fr-FR, de-DE, ru-RU, ja-JP, ko-KR). The playground offers
  1 to 4, the API accepts all ten.
- **Not cloned:** the avatar (Convai assigns a random one; the mod does not use
  it) and `embodiment_data`. The originals have no knowledge bank files
  (`character/knowledge-bank/list` returned none for all 23), no narrative
  design (`is_narrative_driven` false) and no actions, so nothing was missing.

## The "Only reply in the selected languages" box

Convai documents this setting ("sits together under Core AI Settings") but
neither the Core, Character Base nor Core AI Settings API pages list a request
field for it, and `/character/get` and `/character/list` return no such field
(no character in the account shows a difference, including the older
"Multilingual" Witcher twins). Unknown request fields are accepted silently, so a
guessed name cannot be verified by readback. About 60 camelCase guesses were
tried on a test twin with a behavioural check (German or Swedish prompt, look at
the reply language); none changed anything. `languageCodes` (camelCase) is the only
language field the update endpoint reads.

The Dan Walker pair from the user's manual test is not in this account (350
characters before this work, none named Dan Walker), so it could not be diffed.

What does work through the API, checked by chat on the Judy, Johnny and Jackie
twins: with the voice and the ten language codes set, replies follow the player's
language (Spanish, German, French, Korean, Chinese, Portuguese, Italian answered
in kind). A twin limited to en-US answered Spanish and Japanese prompts in English.
Languages outside the list were mixed: Italian and Russian were answered in kind,
Hindi and Swedish in English (Judy: "I don't speak Hindi"). That residual
restriction is what unticking the box should lift.

**Manual step:** for each twin, open its playground page, Core AI Settings, and
untick "Only reply in the selected languages" (all 23 have `manualUntickRequired`
true). To get the exact field, open the browser Network tab on one Dan Walker or
twin save and note the `character/update` body; set `REPLY_ANY_LANGUAGE_FIELD` in
the script to `{field, value}` and re-run `--apply` to set and record it for all.

## Routing (not done)

- Memory: Convai long-term memory is scoped by character ID plus end-user ID, so an
  original and its twin keep separate memories for the same player UUID. Options:
  (a) pick one profile per character for the whole save based on a setting and
  accept a reset when switching; (b) keep both and add the twin to the
  family/forget scope (`bridge/player-memory-api.mjs` allows only exact
  `[CyberpunkConvai profile v2:<key>]` markers, so the twin marker needs its own
  provider key and a family map entry, like `canonical-romantic`); (c) seed
  nothing (no `/memory/add` exists). Forget must clear both.
- Relationship alternates: Judy, Panam, River, Kerry and Meredith also have a
  romantic profile (`runtime/relationship-profiles.json`). Twins exist only for the
  ordinary profile. Routing needs a multilingual version of each romantic profile
  (five more characters) or a rule that the twin wins and carries a style hint.
- Provider keys and ID maps (`runtime/characters.json`,
  `relationship-profiles.json`) are unchanged; the twin map is separate.
- Transient sessions and phone chat sessions key by provider ID, so switching
  profiles starts fresh sessions; local Chat history stays under the canonical key.
- Local TTS: Pocket is English-only, so non-English replies need Omni or the
  Convai Azure voice the twin already has.
