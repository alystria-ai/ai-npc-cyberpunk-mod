# Cast sweep: a profile for every named character (2026-10-30)

Branch `feat/cast-sweep`. Not merged, not pushed, nothing uploaded, nothing installed, the game not touched.

A player's mod placed "Mateo" (a game character) and he did not show in the character library, because no profile named his record.
The owner asked for a profile for every named character of the game (base game and Phantom Liberty), with a voice picked from any clean
clip that is not phone audio. This page is the recipe and the decisions. The numbers are in the TODO.md captain's log entry of 2026-10-30.

## What a "minor" profile is

A normal roster row is a story character: protected from the other systems, prepared for the story face, invitable, with a Convai
character and twin. A sweep row (`"minor": true`, `"invite": false`) names an ordinary person, so it changes as little as possible:

| Question | Answer |
|---|---|
| A character another mod spawns from the record (Mateo) | Resolves to the profile at once, by record (`mod/character-catalog.lua` `resolve`). This was the reported case. |
| The game's own copy of that person | Only while Talk to story characters is on. With it off the person keeps the archetype conversation they had before (`profile.minor`), so the setting takes talk away from nobody. |
| Protected from other systems | No. `protectedReason` skips a minor profile, so recruiting and the other systems behave as before. |
| Story face preparation | No. The record is left out of `FaceFeature.reds` `NamedRecords` (`scripts/Build-FacialGraphs.mjs`), so the crowd preparation keeps serving it. |
| Invite | `invite: false`: listed as "Profile only", no companion definition. Flip the flag per row if a character should be invitable. |
| Voice | Own clip where the person has voice files of their own, else the fallback archetype voice (`characters/cast-sweep-voices.json`). |
| Convai character and twin | None yet (owner step). Every provider other than Convai uses the profile text as it is. |

## Pipeline (all scripts in `scripts/cast-sweep/`)

1. `inventory.py` reads the installed REDmod tweak sources (`package Character` files, base and ep1) and the repo's English text index and
   resolves `displayName` and `fullDisplayName` through the parent chain. Output `staging/cast-sweep/records.json` (git ignored).
2. `candidates.py` groups the records into (display, full) pairs and marks the ones the roster already names (by record or name).
3. `person-check-input.py`, two Haiku agents, `person-check-merge.py`: is a pair a named individual or a role label (Bartender, Voodoo Boy,
   drones, crowd types)? The verdict gives the canonical name, gender and a role guess.
4. `group.py` and `finalize.py` (with `decisions.json`): one entry per canonical name, minus real people's cameos, placeholders, the add-on
   characters, duplicates of roster people and ambiguous single names (a one-word name that is also the first or last word of another profile:
   the display name is matched exactly, so one profile would answer for several people).
5. `wiki.py`: a plain-text extract of each person's Cyberpunk Wiki page through the MediaWiki API (one request every two seconds), used as
   reading material only.
6. `agent-batches.py`, `staging/cast-sweep/BRIEF.md`, Haiku agents: one small card per person in the first person (`compile.mjs` documents
   the fields). `compile.mjs split` checks every card (first person, word limits, banned words, no dashes, six to eight original sample
   lines, a pose or lighting note in `look`), so an agent fixes its own failures.
7. `compile.mjs apply`: dossier (`research/cyberpunk/dossiers/<key>.json`, `firstPersonNative: true`: no third-person text exists to rewrite, so
   there is no `first-person-profiles.json` entry), roster row, profile text, appearance, twin voice assignment, build report, coverage,
   knowledge pack `profileKeys` (the pack limit was raised from 256 to 1024 in `bridge/world-knowledge.mjs`), `cast-sweep-voices.json`.
   Then `node scripts/cast-sweep/finances.mjs` (a minor profile takes the money row of its fallback archetype, `MINOR_FINANCE_BASES` in
   `bridge/eddies-finances.mjs`), `node scripts/Build-FacialGraphs.mjs --reds` (no change expected) and `node scripts/cast-sweep/name-pools.mjs` followed by
   `node scripts/Build-NpcNamePools.mjs` (generated names and street handles stay clear of the new names).
8. `stems.py` and `voices.py`: voice stems that start with the person's full name (never a voice tag alone), `vo` folder only, news,
   radio, call and loading screen stems skipped, 3.5 to 9.5 s, at least six words, no clipping, at least 0.4 percent of the energy above
   4 kHz (a telephone line has none). The best of up to six candidates is decoded to 24 kHz mono 16 bit WAV in
   `E:\CyberpunkConvai-offload\work\cast-sweep\<key>.wav` (outside the repo). One clip serves the OmniVoice short and long sets and Pocket.

Card template and two worked examples: `scripts/cast-sweep/example-card.json`.

## Voices and what the owner uploads later

27 people have a clip of their own (listed in the report file). Everyone else speaks with their fallback archetype voice
(`characters/archetype-voices.json` voicesets, key in `cast-sweep-voices.json`) and, as for every profile without a prepared reference,
the roster's Convai voice locally falls back through `packaging/release-plan.json` `fallbackProfiles`. To ship the 27 clips:
copy `E:\CyberpunkConvai-offload\work\cast-sweep\<key>.wav` to `final/voice-references/picked/autobest/{omni-short,omni-long,pocket}/<key>.wav`,
add the three config rows (the recipe in `docs/CAST_EXPANSION_RECIPE.md` step 3 and `merge_rows.mjs`), and add the keys to
`voice.localProfiles`. Nothing is uploaded or merged by this branch. Convai originals and twins for the 575 keys:
`Provision-Characters.mjs --apply` and `Create-MultilingualProfiles.mjs --apply --roster named`.

## Costs the owner should know

* `characters/roster.json` grows from 1.4 MB to 3.9 MB. The game decodes it once at start (`conversation-characters.json`) and drops the research
  text fields, so the resident Lua table grows by about 1 MB (estimated from the 0.25 MB the first 128 rows cost, not measured in the game) and the one-time decode takes longer.
  If that matters, ship a lean copy of the sweep rows to the game.
* The Characters page lists 575 more "Profile only" rows.
* Sweep rows are first-person from the start and short; where the sources give nothing the card says so and invents nothing.

## Continuing

Cards for new people: add them to `staging/cast-sweep/final-people.json` (or rerun steps 1 to 4), `agent-batches.py`, agents, `compile.mjs apply`.
Live checks (none done): talk to a minor character a mod spawned (Mateo), and to a game-placed one with Talk to story characters on and off.
