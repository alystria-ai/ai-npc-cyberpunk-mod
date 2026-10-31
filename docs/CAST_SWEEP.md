# Cast sweep: a profile for every named character (2026-10-30)

Branch `feat/cast-sweep`. Not merged, not pushed, nothing uploaded, nothing installed, the game not touched.

A player's mod placed "Mateo" (a game character) and he did not show in the character library, because no profile named his record.
The owner asked for a profile for every named character of the game (base game and Phantom Liberty), with a voice picked from any clean
clip that is not phone audio. This page is the recipe and the decisions. The numbers are in the TODO.md captain's log entry of 2026-10-30.

## What a "minor" profile is

A normal roster row is a story character: protected from the other systems, prepared for the story face, invitable, with a Convai
character and twin. A sweep row (`"minor": true`) names an ordinary person, so it changes as little as possible (since 30 Oct 2026 most are invitable, see `docs/SIDE_CHARACTERS.md`):

| Question | Answer |
|---|---|
| A character another mod spawns from the record (Mateo) | Resolves to the profile at once, by record (`mod/character-catalog.lua` `resolve`). This was the reported case. |
| The game's own copy of that person | Only while Talk to story characters is on. With it off the person keeps the archetype conversation they had before (`profile.minor`), so the setting takes talk away from nobody. |
| Protected from other systems | No. `protectedReason` skips a minor profile, so recruiting and the other systems behave as before. |
| Story face preparation | No. The record is left out of `FaceFeature.reds` `NamedRecords` (`scripts/Build-FacialGraphs.mjs`), so the crowd preparation keeps serving it. |
| Invite | `invite: true` for 557 of the 575 (record in both game versions, not a child), listed under Side characters to invite (`docs/SIDE_CHARACTERS.md`). The other 18 stay `invite: false`: listed as "Profile only", no companion definition. |
| Voice | Own clip where the person has voice files of their own, else the fallback archetype voice (`characters/cast-sweep-voices.json`). |
| Convai character and twin | One each for the invitable rows (`scripts/cast-sweep/provision-batches.mjs`, `docs/SIDE_CHARACTERS.md`). Every provider other than Convai uses the profile text as it is. |

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
   Then `node scripts/Build-GameRoster.mjs` (the lean file the game decodes, see Costs), `node scripts/cast-sweep/finances.mjs` (a minor profile takes the money row of its fallback archetype, `MINOR_FINANCE_BASES` in
   `bridge/eddies-finances.mjs`), `node scripts/Build-FacialGraphs.mjs --reds` (no change expected) and `node scripts/cast-sweep/name-pools.mjs` followed by
   `node scripts/Build-NpcNamePools.mjs` (generated names and street handles stay clear of the new names).
8. `stems.py` and `voices.py` (27 people), then `voice_links.py` (13 more, see "Own voices by voice tag"): voice stems that start with the person's full name (never a voice tag alone), `vo` folder only, news,
   radio, call and loading screen stems skipped, 3.5 to 9.5 s, at least six words, no clipping, at least 0.4 percent of the energy above
   4 kHz (a telephone line has none). The best of up to six candidates is decoded to 24 kHz mono 16 bit WAV in
   `E:\CyberpunkConvai-offload\work\cast-sweep\<key>.wav` (outside the repo). One clip serves the OmniVoice short and long sets and Pocket.

Card template and two worked examples: `scripts/cast-sweep/example-card.json`.

## Own voices by voice tag (`feat/side-own-voices`, 31 Oct 2026)

Step 8 above found 27 people because a file stem started with their full name. That rule is strict, so a second rule was added: `scripts/cast-sweep/voice_links.py`
(then `voices.py --asr`, `apply_own_voices.py`). **13 more people have a clip of their own, 40 in all, 535 keep the fallback archetype voice.**

A voice file is `<voice tag>_<group>` (`fredrik_sts_wat_nid_04`, `sasquatch_q110`). The tag picks the voice, so every file with the same tag is the same voice and the
question is only whose tag it is. The REDmod tweak sources name a `voiceTag` on only 6 character records, so that alone found a few. The rest needed other evidence, and a
tag is the person's own when at least one of these holds:

| Evidence | Meaning | People |
|---|---|---|
| `voiceTag` | The person's record (or a parent) names the tag in the game's own tweak sources. | Emmerick Bronson, Leslie Wawuda (dropped later, see below), Matilda K. Rose (`sasquatch`), Roxanne Sumner, Tom Caldera |
| `name` | The tag spells the full name (all words, first and last, last and first) or the first word with one letter off (`micheal_maldonado`). | Roh Chi-Won (every word, `stems.py` only tried first and last), Reverend Colver (the title), Michael Maldonado |
| `record` | The tag is exactly the record's own name (`sts_wat_nid_04_fredrik` gives `fredrik`) and a file of the tag carries the record's quest group, or the record has no group at all (`Character.Scorpion`, `Character.mark_muratovitch`). | Fredrik Persson, Gottfrid Persson, Driss "Scorpion" Meriana, Mark Muratovich |
| `display+group` | The tag is the short name the game shows for the record (`Taylor`, `Dorian`) and a file of the tag carries the record's quest group. | Taylor Gibbs, Dorian |
| `scene` | A cached scene export (`research/cyberpunk/cache/game/scene-evidence`) shows an actor with the person's first record speaking a line of the tag. | confirms Scorpion, Sasquatch, Tom, Roxanne, Maldonado |

A candidate is dropped when any of these holds (accuracy over count):

* the tag is a **generic voice model or a role** (`civ_*`, `gang_*`, `ncpd_*`, `sec_*`, `merc_*`, crowd, vendor, V, an organisation voice, a quest label, a tag with a number, or a role word such as barman, bouncer, boss, ripperdoc, assassin, narrator: 5 role tags and 1 generic `voiceTag` were met).
* **another person has a claim of the same or higher strength** on the tag, or a main character is named by that one word (`theo` is also the voice tag of Aymeric Cassel's record, so Theo Price is out).
* another record **names the tag as its own `voiceTag`**, or a cached scene shows another named record speaking it.
* the quest group of the record is on no file of the tag (Alex Pushkin, Jesse Sabara, Monique Ashka).
* only radio, news, call or chip stems exist (Kevin King).

Result of the rule on the 548 people without a clip: 19 had a tag that held, 11 candidates were dropped for the reasons above, and for 6 of the 19 no line passed the audio checks
(Gorira and Grace: one line of 2.5 s or none with six words, Jotaro Shobo and Myriam Glesile: no line of six words, Jack Mausser: Whisper similarity under 0.85 on all eight lines, Leslie Wawuda: her one line is 11.2 s).
13 passed. 17 more people are proven by a scene export to be the speaker of a generic voice model line (`held back` in the links file). They are left on the archetype on purpose, because that voice model is shared with ordinary people.
Only 23 of the 213 non-generic tags in the files share no word with any roster name or record, and they are main or story voices (Wade Bleecker, Delamain, Skippy, Katya Karelina), so few non-generic tags are left unused. The other side characters are spoken in the game by shared civilian, gang, police and security voice models.

The line is picked by `voices.py --asr` as in step 8, plus: Whisper small.en (the project's copy, CPU) must hear the game subtitle with a difflib similarity of at least 0.85, and the line must have the same bytes in the 2.31 archive. The 13 have 0.88 to 1.0. `apply_own_voices.py` writes `clip` and `link` (`{tag, how}`) into `characters/cast-sweep-voices.json`, and the wiring is the one below (manifest, rows, words, release plan, upload list).
Run order: `inventory.py`, `voice_links.py`, `voices.py --people characters/roster.json --stems <stems-new.json> --asr`, `apply_own_voices.py`, `recover_manifest.py --cast-sweep`, `add_cast_manifest.py`, `stage_cast_voices.py --keys ... --apply`, `merge_rows.mjs`, `write_words.mjs`, `upload_list.py`.
Open question: Dorian is a child (invite false, profile only), and the Reverend Colver line is from a televised debate scene (clean, Whisper similarity 0.98).

## Voices and what the owner uploads later

The first 27 people have a clip of their own (listed in the report file), 13 more by voice tag (above). Everyone else speaks with their fallback archetype voice
(`characters/archetype-voices.json` voicesets, key in `cast-sweep-voices.json`) and, as for every profile without a prepared reference,
the roster's Convai voice locally falls back through `packaging/release-plan.json` `fallbackProfiles`. The fallback is applied by the bridge, not by the voice tables: `bridge/voice-fallbacks.mjs` reads `cast-sweep-voices.json` (shipped in appData) and gives the voice service an alias for each person, so the person is routed, listed in `routedProfiles` (the manager names the voice) and spoken with the archetype's voice on Pocket and on both OmniVoice sets, and the workers prepare that voice once however many people share it (no row is copied, the workers never hear the person's key). A person with a row of their own in an engine's table, or with clips built on this PC, keeps it. An engine whose table lacks an archetype answers that person in text, with one `[VoiceFallbacks]` log line at start.
To ship the clips (done for all 40 on the branches `feat/voice-clips-on` and `feat/side-own-voices`, see `docs/VOICE_EXTRACTION.md`):
copy `E:\CyberpunkConvai-offload\work\cast-sweep\<key>.wav` to `final/voice-references/picked/autobest/{omni-short,omni-long,pocket}/<key>.wav`,
add the three config rows (the recipe in `docs/CAST_EXPANSION_RECIPE.md` step 3 and `merge_rows.mjs`), and add the keys to
`voice.localProfiles`. Nothing is uploaded or merged by this branch. Convai originals and twins for the 575 keys:
`Provision-Characters.mjs --apply` and `Create-MultilingualProfiles.mjs --apply --roster named`.

## Costs, and the lean game file

* `characters/roster.json` (what the bridge reads) is 3.9 MB with the 575 rows. The GAME does not decode that: `characters/game-roster.json`
  (`node scripts/Build-GameRoster.mjs`, checked by `bridge/game-roster.test.mjs`) is what packaging and the development installer ship as
  `conversation-characters.json`. Its 575 minor rows hold only `key`, `name`, `records`, `kind`, `invite` and `minor` (an alias list that
  repeats the name, the summary, the voice fields and all profile text stay on the bridge side). The other 128 rows are copied unchanged.
  Measured with LuaJIT 2.1 (`lua51.dll` from OBS) and CET's own `json.lua`, `scripts/cast-sweep/measure-roster.py`, median of 7 fresh states:

  | File | Bytes | Decode | Allocated by the decode | Kept after init.lua drops its fields |
  |---|---|---|---|---|
  | roster before the sweep (128 rows) | 1,460,437 | 18 ms | 23.4 MB | 803 KB |
  | roster with the sweep (703 rows, what the game would have decoded) | 3,898,325 | 42 ms | 37.6 MB | 2,245 KB |
  | game roster (703 rows, lean) | 1,430,797 | 18 ms | 23.7 MB | 1,173 KB |

  Re-run it after any change to the roster. The decode runs once at start and again on a CET reload.
* The Companion Manager's Main characters to invite list does not carry minor profiles (`mod/manager.lua` `invitableProfiles`); the invitable ones are on the Side characters to invite page.
  The memory page and the profile assignment list still list every profile, and the search finds them.
* The character editor picker has a "Minor characters" chip (role `minor`, `bridge/character-editor.mjs` `roleOfRow`). The minor characters are
  not in All or the other chips until the search box has text, so the default list stays short.
* Sweep rows are first-person from the start and short, where the sources give nothing the card says so and invents nothing.

## Continuing

Cards for new people: add them to `staging/cast-sweep/final-people.json` (or rerun steps 1 to 4), `agent-batches.py`, agents, `compile.mjs apply`.
Live checks (none done): talk to a minor character a mod spawned (Mateo), and to a game-placed one with Talk to story characters on and off.
