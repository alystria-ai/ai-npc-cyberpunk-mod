# Night City Allies followers: Lucy and Rita Wheeler

Written 2026-10-18 on branch `nca-followers` (from `main` da059f29). Unit-tested; not merged, not installed, not seen in the game.

A player asked (verbatim in `TODO.md`): *"would it be possible in the future to have addons for mods like NCA Rita Wheeler or Lucy? I'm using them as followers with Night City Allies but it would be so damn amazing to have actual conversations when we do a side mission or just riding along the car together."*

**Decision (the user, 2026-10-18):** this is part of the main mod, not an add-on. No separate repository, Nexus page or add-on wrapper. The main mod recognises Night City Allies' (NCA) Lucy and Rita when NCA (and, for Lucy, the Lucy mods) are installed, and does nothing when they are absent. NCA keeps its follow, combat and car behaviour; we add talk, face and audio, the same rule as for game-placed characters.

The add-on API would have been the wrong tool anyway: an add-on speaker has no body (no face, no gaze), and add-on text never uses Convai (`docs/ADDON_API.md`, "Guarantees"). NCA's followers have bodies, and the path for bodies another mod spawns already exists (`docs/SPAWNED_CHARACTERS.md`).

## Short version

- NCA spawns every follower through Codeware's dynamic entity system with its own tag, so our generic spawned-character recognition already sees Lucy and Rita as "spawned by another mod": talk, voice, memory, lip sync, eye contact without a hold, group chat and battle or loot reactions, with nothing of ours moving them.
- What was missing was **who they are**. Today Lucy resolves to no profile at all (the "no conversation profile" notice) and Rita to the generic Mox profile.
- This branch adds the two profiles to the normal character data with the records NCA spawns, plus a ride context (a spawned follower in V's car is told she is riding along or driving), and keeps both out of our own invite menus.
- **They cannot talk yet:** every conversation provider needs a Convai character ID for a roster profile (`bridge/convai-bridge.mjs` ~2296). Creating the two Convai characters is decision D1 below.
- Voices are decisions D2 and D3: Rita has game voice lines; Lucy has none.

## Inputs inspected

The zips are kept in `ref mods\` of the main checkout (untracked reference material, never staged). Each was extracted to its own folder under `%TEMP%\nca-research\` and nothing from them was run.

| Zip (`ref mods\`) | Version | Extracted to |
|---|---|---|
| `Night City Allies - AIO 27625 1.6.9 2026-10-02T17-51Z 4rpqrKkhY.zip` | NCA 1.6.9 | `%TEMP%\nca-research\nca-aio` |
| `Lucy for NCA-27670-1-0-0-1771469534.zip` | 1.0.0 | `%TEMP%\nca-research\lucy-for-nca` |
| `Custom Character - Edgerunners Lucy-9812-2-2-1763252222.zip` | 2.2 | `%TEMP%\nca-research\edgerunners-lucy` |

Paths below are inside those folders. `reds` means `r6/scripts/NightCityAllies/`.

## 1. How NCA spawns and identifies followers

**Spawning.** `reds/Npc/NpcHandle.reds` `SpawnAt` (lines 57-82) builds a `DynamicEntitySpec` with `recordID = GetSpawnRecordID()`, `tags = [n"NCA_Companion"]`, `alwaysSpawned = true`, and calls `GameInstance.GetDynamicEntitySystem().CreateEntity(spec)`. Vehicles and workspot props use the same system with the tags `NCA_Vehicle` and `NCA_Workspot` (`reds/Vehicle/VehicleHandle.reds` 166-177, `reds/Animation/AnimationHandle.reds` 113-124). Roamers and characters waiting at NCA locations (Lizzie's, the Afterlife) are spawned the same way (`reds/Npc/NpcManager.reds` `SpawnRoamer` 487, `reds/Spawn/SpawnSystem.reds`).

**The record it spawns is usually a clone.** `reds/Equipment/EquipmentSystem.reds` `PrepareCharacter` (88-125) clones the character record so it can change abilities, stats and weapons, and `GetSpawnRecordID` (127-133) returns the clone. The clone's name is `NCA.` plus the original record name (`reds/Equipment/EquipmentRecords.reds` `NCACloneName.Character`, 5-24), for example `NCA.Character.lizzies_bouncer`. If the original has no debug name the clone is `NCA.<number>`. With NCA's "default records" mode (`InitRecordMode(true)`) it spawns the original record. A clone copies every flat, so the display names stay the same.

**Where the characters come from.**
- JSON files in NCA's CET folder `Characters/` (`bin/x64/plugins/cyber_engine_tweaks/mods/NightCityAllies/Application/IO/characterLoader.lua` 24-42): `{name, record}`.
- A setting, on by default, that imports another spawner's custom-character list (`characterLoader.lua` 44-92, `reds/Settings/NCASettings.reds` 203-211).
- NCA's own modules for the story companions (`r6/scripts/NightCityAlliesModules/Characters/*.reds`: Goro, Jackie, Judy, Kerry, Misty, Panam, River, Rogue) and generic mercs (`Modules/Mercs/*.reds`).

**Lucy.**
- `Lucy for NCA` adds `Characters/npc_merc_lucy_mod.json` = `{"name": "Lucy", "record": "Character.EdgerunnersLucy_Merc"}` and `r6/tweaks/NightCityAllies/character_xBaebsae_Lucy.yaml`.
  - That yaml defines `Character.EdgerunnersLucy_Merc` with `$base: Character.Panam` and `entityTemplatePath: base\characters\custom_npc\edgerunners_lucy\_core\edgerunners_lucy.ent`. Without the template path she would spawn with Panam's body.
  - Display name key `edgerunnerslucy_dispname`, full name key `edgerunnerslucy_dispnamefull`, affiliation `Factions.MaineGang`.
  - Its author notes it copies the custom-character mod's record and only adds the template path.
- `Custom Character - Edgerunners Lucy` 2.2 defines `Character.EdgerunnersLucy` (`r6/tweaks/xbaebsae/Custom_Character_EdgerunnersLucy_xBaebsae.yaml`), also `$base: Character.Panam`, plus a photo-mode puppet.
  - Its archive's localization (`archive/pc/mod/CustomCharacter_EdgerunnersLucy_xBaebsae.xl` → `...\_core\edgerunners_lucy.json`) reads: display name "Lucy", full name "Lucyna Kushinada", affiliation "Maine's Gang (formerly)". These were read from the archive bytes, not in the game.
  - Appearances: `edgerunners_lucy_default`, `_no_jacket`, `_david_jacket`, and one more.
  - A small CET mod (`LucySpawns`) places static Lucys at fixed spots from `.ent` paths (`data/lucy_spawns_export.json`).
- **Audio:** a scan of the 168 MB archive found no WEM, RIFF, Ogg or sound-bank signature. The mod ships no voice.
- `$base: Character.Panam` copies Panam's flats, probably including her voice tag. So NCA's own "Greet" (`reds/UI/Interactions/GreetEntry.reds` → `NpcHandle.PlayVoiceOver(n"greeting")`, `NpcHandle.reds` 1095-1101) may play Panam's vanilla greeting for Lucy. This is unverified and is NCA's business, but a player may notice it next to our Lucy voice.

**Rita Wheeler.**
- She is not in the NCA AIO zip (no match for `rita` or `wheeler` in any script, yaml or json). She is the base game's Mox bouncer at Lizzie's Bar, record **`Character.lizzies_bouncer`**.
- The reference spawner's character database in `ref mods\` lists her as "Rita Wheeler", record `Character.lizzies_bouncer`, appearance `gang__mox_wa__beyond_bouncer_01`. NCA's import setting is the likely way a player gets "NCA Rita Wheeler".
- A web search found no separate "Rita for NCA" mod (open question D7).
- NCA's generic Mox mercs (`Modules/Mercs/MoxMercsModule.reds`) are other records ("Baseball Mox" is `Character.the_mox_1_melee2_baseball_wa`, not Rita).

**Can we reliably recognise "NCA's Lucy" or "NCA's Rita"?** Yes, as "Lucy" and "Rita", by record, with the full display name as a fallback:
- Lucy: `Character.EdgerunnersLucy_Merc`, `NCA.Character.EdgerunnersLucy_Merc`, `Character.EdgerunnersLucy`; name "Lucyna Kushinada".
- Rita: `Character.lizzies_bouncer`, `NCA.Character.lizzies_bouncer`; name "Rita Wheeler" (her in-game display name is unconfirmed: the game often labels minor NPCs by faction, so the record is the reliable key).
- The bare name "Lucy" is never used: other game characters are called Lucy (for example Lucy Thackery, `Character.sts_wat_kab_02_lucy`).
- We do not need to know that NCA (rather than another spawner) made the body: NCA's tag is never matched (`docs/SPAWNED_CHARACTERS.md`, "No other mod's tag ... is ever matched").

**NCA's own behaviour, which we must not fight.**
- Follow, catch-up, hold, explore and roam behaviours, ticked by NCA's own system (`reds/Npc/Behavior/*.reds`, `NpcHandle.Tick` 156-176).
- Combat: NCA wraps `ScriptedPuppet.IsAggressive` and `SimpleCombatConditon.Check` for its followers (`reds/Npc/Hooks/NpcHooks.reds`).
- Cars: `PassengerBehavior` mounts the follower into a seat of V's car with an `AIMountCommand` (`reds/Npc/Behavior/PassengerBehavior.reds`). `DriverBehavior` and `ChauffeurBehavior` let her drive.
- Despawn beyond 100 m (5 s), then "commute" (`NpcHandle.Tick`).
- God mode, a friendly attitude, and V's attitude group (`NpcHandle.Resolve` 84-119).
- It switches off the game's `GenericTalk` and `ReturnTalk` interactions and shows its own interaction menu (Greet, Follow, Drive me, Hold, Send away; `reds/UI/InteractionMenu.reds`, `UI/Hooks/InteractionMenuHooks.reds`). Our talk keys are CET bindings, so there is no key clash.
- It also wraps `NPCPuppet.OnDeath`, `MarkForDefeat`, `ScriptedPuppet.OnDamageReceived` and the nameplate controller, only for its own followers.

Our spawned-character policy already stays out of all of this:
- Our hold-free eye contact only turns the eyes and head (`beginFocus` with `keepAI`).
- There is no AI command, mount, seat, attitude, equipment or scanner rename.
- There is no adoption into our party.
- Bark muting applies only during a conversation the player starts.

**Licence.** NCA's source is MIT for personal, non-commercial use, and extensions that require it may be distributed without permission if they do not include its files (`reds/LICENSE.md`). We include none of its files, so the main mod ships no NCA file at all. That is the intended soft dependency.

## 2. What works today, and what this branch adds

**Today (`main`), with NCA installed:**

| | Lucy (NCA) | Rita (NCA) |
|---|---|---|
| Recognised as spawned by another mod | yes (managed, none of our tags, not quest) | yes |
| Profile | none: the clone or Lucy record is not on the roster; affiliation `MaineGang` matches no archetype; not crowd → "does not have a conversation profile configured yet" | the generic `npc-mox-female` (affiliation `TheMox`), session-only memory, the archetype voice, and only with "Talk to ordinary NPCs" on |
| Face | prepared at spawn by `PrepareSpawnedFace` (the graph of Lucy's custom rig is unknown, live check) | prepared |
| Group chat, reactions, connection pre-open | group chat as a generic; reactions and the pre-open lane are roster-only | as a generic |
| Ride context | no: party rows and activities exist only for our own companions | no |

**Built on this branch:**
- **Profiles** `lucy-kushinada` and `rita-wheeler` in the normal character data:
  - dossiers `research/cyberpunk/dossiers/<key>.json` (validated);
  - roster rows in `characters/roster.json` (82 rows), built by `buildProfiles` with `intrinsicPacks: []` and matching byte for byte;
  - first-person copies in `characters/first-person-profiles.json`;
  - `characters/profile-text/<key>.txt`;
  - visible appearance in `characters/appearance.json`;
  - `research/cyberpunk/generated/profile-plan.json`, `coverage.json` and `characters/profile-build-report.json`.
  - Content:
    - Lucy is present through a mod presentation, like Alt. She knows her own Edgerunners history and nothing from *Edgerunners 2*, and spawning her establishes nothing about canon.
    - Rita stays sparse, as the sources are. Her quest facts (The Corpo-Rat, The Information) are conditional, not baseline.
    - Both speaking styles are written for car-ride and gig chatter.
    - Lore uncertainties are listed in each dossier's `uncertainties` (Lucy's hair colours and outfit details, Rita's look, which sources were blocked).
- **Recognition is data only.**
  - The rows carry the records above. `mod/init.lua` already hashes every roster record with `TweakDBID.new` at load (~line 480), so a record that does not exist (no NCA, no Lucy mod) is two unused table entries.
  - The aliases are full names only.
  - No code of ours names NCA, its tag or these records (a test checks this). There is nothing to detect and nothing per frame, and a player without NCA pays nothing.
- **`invite: false`** on both rows, honoured by `definitionFor` in `mod/manager.lua`: no companion definition, so the Manager shows "Profile only", the Companion Manager lists them as unavailable and the party queue refuses them. Without this, every player would have seen an invitable "Lucy Kushinada" whose record may not exist. `buildProfiles` keeps the field on rebuilds (`...preserved`).
- **Ride context.**
  - `convaiSpawnedPeople.riders` in `mod/init.lua`: when a turn's context is read (`turn-context.lua`, cached 5 s) and V sits in a vehicle, it returns the remembered spawned roster characters mounted in V's own vehicle, with the seat the engine reports (`GetMountingInfoSingleWithObjects`).
  - They join the turn context's party, and `turn-context.lua` `classify` turns the seat into `passenger` or `driving`. The bridge already words those: "You are with V in person, riding along in V's vehicle through ...", or "driving V's vehicle" when NCA's chauffeur drives V. Other speakers hear "Also with V: Lucy Kushinada".
  - Nothing is read while V is on foot or while no spawned character is remembered.
  - Quest context (V's tracked job, the journal), place, time, weather, combat and loot already reach any named roster profile, spawned or not (gated on `isAmbientProfile`, not on party membership).
- **Face:** `scripts/Build-FacialGraphs.mjs` accepts one clone prefix in a record name, and `r6/scripts/CyberpunkConvai/FaceFeature.reds` `NamedRecords` is regenerated (`--reds`). It is used only for game-placed characters (the game's own Rita with story talk on). A spawned body takes `PrepareSpawnedFace` first.
- **Knowledge audience:** both keys are in `profileKeys` of `characters/world-knowledge.json` and its generated twin.
- **Multilingual twin voices** (placeholders, for when the twins exist): `characters/multilingual-voice-map.json`, Lucy Seraphina and Rita Arabella. Both are non-main-cast voices.
- **Convai voices** (placeholders): Lucy `Claire (Whispering Young-Adult American Female)`, unused elsewhere; Rita `Rachel (Neutral Adult American Female)`, which no tier-1 companion uses.
- **Tests:**
  - `bridge/nca-followers.test.mjs`: rows and records, resolution by base and clone record and by full name, never the bare "Lucy", the game-placed Rita under the story setting, the soft dependency, the seat classification, `riders` (only V's own vehicle, roster only, enabled profiles, nothing read on foot or with nobody remembered, a failing read drops the row), and the wiring (one caller, nothing in `onUpdate`).
  - `bridge/manager.test.mjs`: `invite = false`.
  - Count pins in `bridge/first-person-profiles.test.mjs` are 82.

**Memory.** Memory is keyed by profile:
- Convai long-term memory needs the character ID (D1).
- The Mistral and local AI routes keep `runtime/local-memory/player/<key>.json`.
- NCA's Lucy, a Lucy from any other spawner and (with story talk on) the game's own Rita at Lizzie's share one memory per character, like a spawned Judy and our Judy.
- NCA respawns its followers with new entity IDs after a load; the memory does not depend on the entity.

## 3. Voice

How references work (from `docs/GAME_VOICE_REFERENCES.md`, `docs/LOCAL_VOICES.md`, `docs/VOICE_CAST_PREPARATION.md`):
- Clips are cut from game audio by `scripts/Extract-VoiceReferences.py` from an explicit list of line IDs (StringIDs), checked against the subtitle text.
- Pocket, OmniVoice and Voxtral each read per-character configs under `runtime/` (git-ignored, shipped through the Hugging Face bucket).
- A profile with no reference falls back: OmniVoice → Pocket → the Convai voice. On Voxtral, or on Mistral or local text with a local voice and no reference, the reply is text only (`bridge/voice-selection.mjs`, `bridge/voxtral-voice.mjs`).
- Named characters never borrow another character's clip (`bridge/voice-profile-registry.mjs`; `docs/VOICE_CAST_PREPARATION.md` ~101-103 and ~168).

**Rita** has voice lines in the game (bouncer barks and her lines at Lizzie's).
- The pipeline can take them like any other character's, but nothing in the repo knows her lines yet. A scene-level discovery pass has to find her StringIDs first: speaker, voice tag and scene, never the voice tag alone, which docs say does not prove identity (`docs/VOICE_CAST_PREPARATION.md` 44-60).
- The clips would ship like every other character's game-derived clip, under the existing CD Projekt notice (`docs/PACKAGING.md` 357-358).

**Lucy** has no game voice and the custom-character mod ships no audio. Options, without a decision:

| | Option | What it means | Flags |
|---|---|---|---|
| a | Convai voice only (placeholder Claire) | Works on the Convai provider. On Pocket or OmniVoice she is text only (a local voice never hands a turn to the Convai voice, 2026-10-21); on Voxtral, or Mistral or local text with a local voice, she is text only too. | none |
| b | Borrow an existing cast member's reference | Gives her a local voice everywhere | Breaks the project's rule against borrowing an unrelated cloned voice; she would sound like someone the player knows |
| c | A clip from the anime | The closest likeness | **Rights concern, not decided here:** the series' audio belongs to its rights holders, and the voice is a real actor's. The Pocket weights' licence has a no-cloning-without-consent clause (`docs/PACKAGING.md` 352-355). Needs the user's call. |
| d | A designed voice, rendered once as a reference clip | Own voice, no likeness | Against the current rule "No cloned/generated speech is used as a reference" (`docs/LOCAL_VOICES.md` ~209); needs a rule change |
| e | A generic game NPC voice set as her reference | A local voice from game audio | Same "unrelated NPC" rule as b, softer: nobody would recognise it |

## 4. Open decisions for the user

Each has a suggested default.

| | Decision | Options | Suggested default |
|---|---|---|---|
| D1 | **Convai characters for Lucy and Rita.** Without IDs neither can talk on any provider. | (A) Provision both and their multilingual twins (`Provision-Characters.mjs --apply --only lucy-kushinada,rita-wheeler`, `Create-MultilingualProfiles.mjs --apply --only ...`, `TIER1_KEYS`, untick the language box by hand, copy the IDs into `packaging/release-data/`). (B) A roster flag that lets a profile without an ID talk on Mistral and the local AI only (a bridge change at the ID check, `routeFor` and the connection plan). | A: the same as every other roster character. It writes to the Convai account, so it waits for your go. |
| D2 | **Lucy's voice** | a to e above | a for now: the Convai voice, no local reference. Revisit after a, c or d is chosen. |
| D3 | **Rita's voice** | Game audio through the usual pipeline, or the Convai voice only | Game audio, after a discovery pass finds her lines |
| D4 | **The game's own Rita at Lizzie's.** Her record is on the roster now, so she is a named character. | (A) Keep it: with "Talk to story characters" on (off by default) she talks as Rita with face and voice only; with it off she is refused like other named game characters, so the generic Mox chat with her is gone. (B) List only the NCA clone record. A spawned body with the original record (NCA's default-records mode, other spawners) would then fall back to the name. | A: one character, one profile, one memory |
| D5 | **Our Model browser** still attaches Lucy's or Rita's profile when a player picks the raw record there (only if the record exists) | (A) Leave it: an explicit player choice spawns our own copy with full systems, as for any record. (B) Drop the profile for `invite: false` rows. | A |
| D6 | **Placeholder voices** (Convai: Claire, Rachel; twins: Seraphina, Arabella) | Keep or pick others | Keep until D2 and D3 |
| D7 | **Which mod is "NCA Rita Wheeler"?** | Ask the player which file they use | Support by record (done); ask only if a live check fails |
| D8 | **Edgerunners 2** (all episodes on Netflix 20 Oct) | Add nothing (Lucy's last canon is the first series), or revise her dossier after it airs | Nothing now; revisit |
| D9 | **On-foot company.** A spawned follower near V on foot is not in other speakers' "Also with V" (nothing of ours knows what she is doing). | Add rows without an activity, or leave it | Leave it; the car is the case the player asked for |

## 5. Work list

| Item | Size | State |
|---|---|---|
| Research, this plan | M | done |
| Dossiers, roster rows, first person, appearance, profile text, plan and coverage | M | done |
| Recognition data (records, aliases), `invite: false` | S | done |
| Ride context (`riders`, `classify` seat) | S | done |
| Face named records (clone prefix), regenerated `FaceFeature.reds` | S | done; needs `scripts/Compile-Redscript.ps1` and a game restart to install |
| World-knowledge audience, twin voice map | S | done |
| Tests | S | done |
| D1 Convai provisioning, release data, `packaging/release-plan.json` | S | needs your go |
| Rita's line discovery and reference clips (Pocket, OmniVoice short and long), `voice.localProfiles` and `preparedLocalProfiles` | M | after D3 |
| Lucy's local voice | S-M | after D2 |
| Cold or warm manner lists, trait table (`bridge/emotion-*.mjs`, `mod/facial-playback.lua`), `prominence` | S | optional |
| README: a line under the characters other mods spawn, naming NCA's Lucy and Rita | S | after D1 |
| Live checks (below) | M | needs the game |

**Live checks** (the Scripts install with the reds, a game restart, NCA 1.6.9, Lucy for NCA and the Edgerunners Lucy mod, Rita through NCA's import; after D1):
1. Recruit Lucy and Rita with NCA.
   - Talk to each by text and voice: each answers as herself in her voice with lip sync.
   - `probe.log` shows the profile key and `face=true/prepared:...`. If Lucy's rig reads `stale:` or `unsupported-rig`, send the line.
   - NCA keeps them following while they talk (eyes and head only).
2. Let NCA seat Lucy in V's car and drive.
   - Talk to her: the reply knows she is riding along. The log has `Turn context: ... party=1 activity=lucy-kushinada=passenger`.
   - Let NCA's chauffeur drive: `activity=lucy-kushinada=driving`.
3. Group key with both: both answer, each in her own voice.
4. Neither appears as invitable in the Companion Manager (Profile only) or the phone.
5. A side job with a fight: with Battle reactions on, either may speak an opening or closing line.
6. Save, load, talk again: the earlier conversation is remembered (memory by profile).
7. Without NCA and the Lucy mods: no new log line, no notice, no change. FPS and the perf probe show no new per-frame row.
8. NCA's Greet: note whose vanilla voice Lucy greets with (Panam's is expected).

## Files changed on this branch

| File | Change |
|---|---|
| `research/cyberpunk/dossiers/lucy-kushinada.json`, `rita-wheeler.json` | new dossiers |
| `characters/roster.json`, `first-person-profiles.json`, `appearance.json`, `profile-build-report.json`, `profile-text/*.txt` | the two profiles |
| `research/cyberpunk/generated/profile-plan.json`, `coverage.json`, `world-knowledge.json`; `characters/world-knowledge.json` | plan rows, coverage, knowledge audience |
| `characters/multilingual-voice-map.json` | twin voice placeholders |
| `mod/manager.lua` | `invite = false` |
| `mod/init.lua` | `convaiSpawnedPeople.riders`, the party and activity callbacks |
| `mod/turn-context.lua` | `classify`: the `mounted` seat |
| `scripts/Build-FacialGraphs.mjs`, `r6/scripts/CyberpunkConvai/FaceFeature.reds` | clone-prefixed records |
| `bridge/nca-followers.test.mjs` (new), `bridge/manager.test.mjs`, `bridge/first-person-profiles.test.mjs` | tests |

## 6. Decisions taken and work done (2026-10-18, later the same day)

**The user's decisions.** D1 yes (Convai characters for both and their twins). D3 and D4: Rita uses her own game lines and stays one named character with one profile and one memory. D2: Lucy gets real clips of her English-dub voice from the anime, research first, nothing downloaded until the user approves. D5 to D9: the suggested defaults (leave the Model browser as is; keep the placeholder voices until the real ones are in; ask nothing of the player about the Rita mod; nothing for Edgerunners 2 yet; leave on-foot company out).

**D1, done.** Created with `Provision-Characters.mjs --apply --only <key>` and `Create-MultilingualProfiles.mjs --roster named --only <key> --apply`, each verified by readback (biography, speaking style, samples, voice, model). No other character was read for writing or changed: `runtime/characters.json` differs from before in exactly two keys.

| Character | Convai ID | Convai voice |
|---|---|---|
| Lucy Kushinada | `97634ae6-cb10-11f1-8511-42010a7be02f` | Claire (Whispering Young-Adult American Female), placeholder: soft and calm; revisit when her real voice is chosen |
| Lucy Kushinada Multilingual | `a537a2b6-cb10-11f1-a9df-42010a7be02f` | Azure Seraphina |
| Rita Wheeler | `73c06244-cb11-11f1-a63a-42010a7be02f` | Katie (Husky Young-Adult American Female) |
| Rita Wheeler Multilingual | `7a784d5e-cb11-11f1-8e7f-42010a7be02f` | Azure Arabella |

- Rita's Convai voice was changed from the placeholder Rachel before her character was created (roster row, plan row and build report). Katie is the husky young adult voice; Rachel is neutral. The measured pitch of her game lines is average (about 190 to 220 Hz), so "low" is carried by her delivery, which Katie's husk fits best. Katie is also Panam's and Claire Russell's voice on the Convai provider.
- Release data: the two original IDs in `packaging/release-data/characters.json`, the two twin rows in `packaging/release-data/multilingual-profiles.json` (only these rows were added; the file is otherwise as it was). Both are in `TIER1_KEYS` (26) and in `mod/auto-connect.lua` `M.TIER1`, so the pre-open lane treats a follower as a first-rank profile.
- The twins' language boxes are unticked and `languageBoxOff: true` is recorded (section 7); `multilingualTwins` still skips any twin whose flag is not true.
- **Routing on every provider, checked.** After the ID gate (`!ids[profile.key]` at the text and microphone turn starts), nothing per profile depends on a Convai ID except the Convai route itself: the knowledge route is keyed by profile key (both keys are in the world-knowledge audience), `localTurn` (Mistral and Local AI) carries the key and the name only, local memory is `runtime/local-memory/player/<key>.json`, and the voice choice reads the roster and the voice configs. `bridge/nca-followers.test.mjs` pins the data (IDs, twins, voice map), tier-1 membership and these gates, and runs the real knowledge router and relationship routing for both keys. No live talk turn was made.

**D3 and D4, Rita's voice, done offline.** Her lines are the nine of the actor `lizzies_bouncer` in the Corpo-Rat scene `q000_corpo_04_lizzies_club` (scene-level attribution; details, clips, checks and hashes in `docs/GAME_VOICE_REFERENCES.md`, "Hand-extracted references for Rita Wheeler"). The door guards of The Information and the Lizzie's mood scene speak with other voice tags and are not hers on the evidence. Two short references (omni-short 9.98 s; omni-long and Pocket 11.71 s) were built and wired into the three live voice configs; Voxtral takes the long set. To ship, upload the three WAVs and the three configs to the Hugging Face bucket (paths in that section). Limits: only nine lines of 1.3 to 2.9 s exist, so the long set is shorter than the usual 12 to 18 s; all four shouted lines are left out; no listening review yet (an audition in the game is the first live check for her voice).

**D2, Lucy, research only.** Candidates, tool and pipeline are in the report to the user; nothing was downloaded, no tool installed, and her Convai voice stays the placeholder. She has `unprepared` in the three voice configs (the same entry a profile without a clip has): on Pocket or Omni she falls back to the Convai voice, and on Voxtral, or Mistral or local text with a local voice, she is text only until a reference exists.

**Work list changes.** D1, release data, `TIER1_KEYS`, auto-connect, the README line and Rita's references are done. Open: upload Rita's files; Lucy's voice (the three online clips did not qualify, section 7); the live checks above, plus an audition of Rita's voice. The language boxes are done (section 7).

## 7. Lucy's voice from the three official clips: no span qualifies (2026-10-18, later)

**Downloads (user-approved, untrusted data, each in its own new folder under the temp directory).** `yt-dlp.exe` from the official yt-dlp releases (no JS runtime was needed; it only warned), then the audio track and the English captions only (no video) of the three Netflix Anime uploads: `Zuzys9Ld_5M` (a compilation, audio only, no captions), `HI8ubzVgvio` (Lucy meets David, English dub, captions) and `Zq4zTcIM0yQ` (the car chase, captions). The files were opened only by ffmpeg, soundfile and Whisper; none was executed, and the Python that read them ran with `-I`.

**Checks (scripts in `scripts/clip-search/lucy/`, nothing played, nothing cut).**
1. `analyze_external.py`: Whisper small.en word timestamps, per-utterance pitch, level, floor and stereo side/mid. Whisper hallucinated repeated phrases over the music and effects stretches, so the caption cue times were used for the cuts instead.
2. `cue_metrics.py`: for every caption cue, the speech level against the quietest 10 percent of frames inside the cue and the 0.3 s before and after. In `HI8ubzVgvio` the in-cue floors are 12 to 22 dB under the speech peaks and the quietest frame next to any cue is minus 38 dB (speech peaks sit near minus 13 dB); in `Zq4zTcIM0yQ` the floors are 5 to 12 dB under the speech peaks.
3. `gap_bed.py`: the gaps between cues of 0.8 s or more. The gap level is minus 15 to minus 27 dB against speech peaks near minus 13 dB, the spectral flatness is about zero (tonal, not noise) and a narrow spectral peak of 12 to 18 dB sits in every gap: a music or effects bed runs continuously under all dialogue in both captioned clips. Across all three files the only near-silent frames (about 7 percent) are digital-silence padding at the file ends; every frame of actual content is above minus 30 dB.
4. Speaker identity is also unproven: the captions carry no speaker names, David's dub voice overlaps Lucy's pitch range in several lines (cue medians of 120 to 250 Hz on both), and the car chase has Tyger Claws and Maxim lines mixed in.

**Result.** The standing rule was to refuse any span with music, other voices or SFX under it. Every captioned span has a continuous bed, so **no segment qualifies and the total reference length is 0 s**. No Omni short, Omni long or Pocket file was built, the three live configs were not touched, and Lucy keeps her `unprepared` entries (Convai voice on Pocket and Omni, text only on Voxtral or local text with a local voice). No sample was rendered because there is no new voice; the placeholder Convai voice is unchanged.

**What would change this.** There is no denoiser or source separator on disk (a separation model is a new download, so it needs approval, and a separated stem would still be processed audio, not a clean reference for a clone), or a clip with a dialogue-only track. The better first step is her game voice: the scenes' audio is clean and already attributed (the Rita route). Whether Lucy speaks in the base-game scenes has not been checked yet.

**Language boxes.** Both twins' boxes are unticked (`language_hardening_mode` off, set through the signed-in dashboard, readback confirmed). `languageBoxOff: true` is now recorded for `lucy-kushinada` and `rita-wheeler` in `runtime/multilingual-profiles.json` and `packaging/release-data/multilingual-profiles.json`; the `awaitingLanguageBox` allowance is gone from `bridge/multilingual.test.mjs`, so the installed-map test is strict again, and with the runtime map present all 55 multilingual and NCA tests pass (0 skipped).

## 8. Lucy: music removed with Demucs, four candidate clips waiting for the user's ear (2026-10-18, night)

Section 7 found a bed under every line. The user then approved a vocal separator, so the three clips were run through Demucs.

**Install (separate from every mod Python).** A new venv at `%TEMP%\demucs-venv` made from the packaged CPython 3.11 (read only, nothing was installed into `vendor`, omni or the packaged Pythons). The existing PyTorch there is a CUDA build, so it could not be reused without touching it; CPU `torch` from PyPI is 241 MB (under the 300 MB limit). Demucs 4.1.0 loads its htdemucs weights (`955717e8.safetensors`, about 80 MB) from the Hugging Face repository `adefossez/HTDemucs`, not from the older `dl.fbaipublicfiles.com` URL (the 4.1.0 package changed its loader), so the weights came from the Demucs author's own HF repo; they landed in the user's HF cache and were removed again afterwards together with the venv (about 1.5 GB). **To recreate:**
```
<packaged python> -m venv %TEMP%\demucs-venv
%TEMP%\demucs-venv\Scripts\python.exe -I -m pip install torch==2.8.0 torchaudio==2.8.0 demucs==4.1.0 numpy
%TEMP%\demucs-venv\Scripts\python.exe -I scripts\clip-search\lucy\separate_vocals.py <out_dir> <name>=<44.1 kHz stereo WAV> ...
```
(About 35 to 45 s of CPU per clip of 3 minutes.)

**What the stems show.** `cue_metrics.py` on the vocals stems: inside the captioned lines the quietest frames fall to -45 to -70 dB (the mix was -25 to -35 dB), so between words there is real silence. The car-chase clip stays poor (floors -25 to -45 dB, engines and shouting leak through) and is rejected. The compilation has no captions and Whisper loops on its stem, so no speaker can be certified: rejected. `gap_bed.py` is not meaningful on a stem (the uncaptioned gaps contain other sung or spoken vocals), so the floor inside the lines and in the pauses next to them is the check.

**The captions are not the dub.** The Netflix English captions differ from what the dub says (for example the caption "I only steal from Arasaka suits" is David's dub line "Is it stealing if I only hit Arasaka suits?"). The captions give rough timing only; the real words come from Whisper on the stem (`analyze_external.py` on the stem), and speakers come from the dialogue structure of the scene (Lucy proposes the deal, explains the split and the trainee; David answers each time). Speech edges for the cuts are read from the stem's loud regions, not from the captions.

**Candidates (mono 24 kHz, 15 ms fades, no EQ/denoise/gain), all from "David and the Mystery Girl" (`HI8ubzVgvio`).** Saved to `C:\Users\akshi\Downloads\AI-NPC-Lucy-Clips\` with a README:
| File | Length | Clip time | Words (dub) | Pause floor (mix) |
|---|---|---|---|---|
| `lucy-1-lesson-number-one.wav` | 5.2 s | 113.1-118.3 | Listen up. Lesson number one. Less judgment, more awareness. | -72 dB (-31) |
| `lucy-2-trainee.wav` | 2.3 s | 130.4-132.7 | Plus, got a trainee to supervise now. (wording least certain) | -55 dB (-27) |
| `lucy-3-seventy-thirty.wav` | 4.7 s | 138.9-143.6 | 70-30. And I'll pay the second the job's done. I think that's fair. | -75 dB (-28) |
| `lucy-4-crazy-idea.wav` | 3.0 s | 80.2-83.2 | Hey, crazy idea. How about we work together? | -62 dB (-33) |

Total 15.2 s. Speech to pause SNR is 40 to 61 dB; Whisper reads clips 1, 3 and 4 back word for word. Metrics cannot hear artefacts such as watery or ghost-voice leftovers, so the user confirms by ear that these are Lucy and clean.

**Not done at that point, by instruction (done later the same night, section 9):** no reference built, no config changed, `lucy-kushinada` still `unprepared`, no sample rendered. When the user confirms, the build is the usual recipe (`build_reference`, 0.4 s gaps, short <= 10 s, long <= 18 s; 15.2 s of material makes one long set and one short set) followed by the three configs and `voice.localProfiles`.

## 9. Lucy's references built and wired; samples rendered (2026-10-18, night)

The user approved clips 2, 3 and 4 by ear as clearly Lucy and clean; clip 1 was dropped. `scripts/clip-search/lucy/build_lucy.py` built omni-short (8.08 s: clips 3 and 4), omni-long and Pocket (10.78 s: all three, 0.4 s gaps) and replaced her `unprepared` in `pocket-voices.autobest.json`, `local-voices.autobest-short.json` and `local-voices.autobest-long.json`; `lucy-kushinada` is in `voice.localProfiles` (78, `preparedLocalProfiles` 78). The long set is shorter than the usual 12 to 18 s, as Rita's is, and is not padded. Details, hashes and the ship steps are in `docs/GAME_VOICE_REFERENCES.md`, "Lucy Kushinada: web-clip reference".

Checks: the Omni registry loader and `validatePocketConfig` accept the live files; the voice, packaging, multilingual and NCA tests pass (263) and the five Python voice tests pass. Samples (`render_sample_omni.py`, `render_sample_pocket.mjs`, no game, no bridge): the same line in both engines, 5.64 s (Omni long, 32 steps) and 4.64 s (Pocket on the CPU in 1.5 s of generation), both read back word for word by Whisper; median pitch 185 Hz (Omni) and 149 Hz (Pocket). Whether the voice sounds like her is the user's ear.

**To ship:** the six WAVs `runtime/voice-references/picked/autobest/{omni-short,omni-long,pocket}/{rita-wheeler,lucy-kushinada}.wav` to `final/voice-references/picked/autobest/<kind>/`, and the three configs `runtime/pocket-voices.autobest.json`, `runtime/local-voices.autobest-short.json` and `runtime/local-voices.autobest-long.json` to `final/voice-configs/`.

## 10. Every NCA follower, not only Lucy and Rita (branch `nca-compat`, 2026-10-18)

Scope set by the user: a Night City Allies follower gets exactly what any character another mod spawned already gets, and nothing else: talk by text and voice, its own voice, lip sync and facial emotion, memory, and recognition as the right profile. No movement, follow, combat, driving or workspot work and no new system for them; NCA owns all of that. Unit-tested; not merged, not installed, not seen in the game. Research source: NCA 1.6.9 (`ref mods\`, extracted to a new temp folder, nothing run).

**The rule.** A record named `NCA.<X>` resolves exactly as `<X>` does.
- `mod/character-catalog.lua`: `M.CLONE_PREFIXES = {'NCA.'}`; `M.build` registers every roster record that starts with `Character.` again under each prefix, after all explicit records (so Lucy's and Rita's explicit `NCA.` rows keep their owner). `mod/init.lua` already hashes every record of that table with `TweakDBID.new` at load, so the clone names are hashed there with no further change. NCA names its clone with the same hash of the same string (`NCACloneName.Character`, `TDBID.Create`), so the live record ID should match (live check 9).
- `M.originalRecordName`: `NCA.Character.x` reads as `Character.x`. `archetypeFacts` in `mod/init.lua` uses it for the record-name fact, so a clone's record tokens and quest prefix still classify.
- It covers all current roster rows (82 on this branch) and every later one, including the 28 on `cast-expansion`, with no per-row data and no edit to any roster row. The one NCA constant is data in the catalog; no code names NCA's mod, tag or namespace (a test pins it).
- Memory and voice are keyed by the resolved profile key, so a clone shares them with the original character and with our own copy.

**Face.** Nothing to change. A spawned (managed, not ours) body takes `PrepareSpawnedFace` in `Face.reds` `OnWorldInitialize` before the named-record list is read, and that function chooses by the live graph path alone, not by record. The generated `NamedRecords` list in `FaceFeature.reds` is used only for characters the game itself placed, which never carry an `NCA.` record, so extending it would be dead data checked on every crowd spawn. The generator is unchanged and `FaceFeature.reds` is not regenerated. Tests pin both facts.

**Task 2, numbered clones (`NCA.<number>`).** NCA uses the original's debug name when `TDBID.Create(debugName)` gives the same ID, else the number (`NCACloneName.Identity`). The game's names for the eight story records are known to our own `recordName` read, so their clones should be named. If one is numbered, only the display-name fallback applies: `catalog.names` lower-cases and collapses spaces (accents kept, so both "Judy Álvarez" and "Judy Alvarez" are aliases). Checked against the roster: Judy Alvarez, Panam Palmer, Jackie Welles, Kerry Eurodyne, Misty Olszewski, Rogue Amendiares and River Ward match; the bare "Judy", "Jackie", "Rogue", "River", "Goro", "Lucy" and "Rita" match nobody (no roster name or alias is any of them; tested).
- Open: Takemura's roster name and alias are "Takemura" only. If the game's display name is "Goro Takemura", a numbered clone of him would not resolve by name (live check 11). Adding an alias is a roster edit and was left for `cast-expansion` to settle.
- Bare aliases that already exist on the roster (Alt, Kerry, Misty, Panam, Vik, Nix, Shank, Thompson, Takemura and a few of ours) are not NCA-specific: a spawned person whose display name is exactly one of them resolves to that profile. Left as is.

**Task 3, NCA's mercs and roamers.** The 378 records NCA 1.6.9 offers in its Mercs, Characters and Locations modules were compared with the roster: the only overlaps are the characters it also offers by name (Judy, Jackie, Kerry, Misty, Panam, Rogue, Sobchak, Takemura, and the commented-out Claire and Thompson). `Character.Brick`, `Royce`, `Totentanz_Bouncer` and `Weyland` are not roster records. Decision: mercs and roamers are ordinary talkable people.
- By faction when an archetype covers it (the clone copies the record's flats, so the affiliation survives), by record token through the clone's original debug name, else (new) a **resident by body** (`resident-male` or `resident-female`) for a spawned human no archetype knows: `character-catalog.lua` `resolve`, spawned only, never a child, never `human == false` (Wyvern and Griffin drones), never a body with no gender. A game-placed unclassified person is unchanged.
- Quest-prefixed records NCA offers as mercs (`sq024_..._racer` "Sword Mox", `q003_maelstrom_netrunner`, `mq032_...`) already took the spawned story-bound fallback: faction archetype, else resident.
- They need "Talk to ordinary NPCs" on, as any ordinary person does.

**Task 4, what was checked.**
- **Busy gate.** It does not refuse NCA followers. The "busy right now" refusal (`mod/world-talk.lua`, called from `mod/init.lua`) runs only when `primary.story`, which is false for any spawned character (`profileIdentity` sets `story` only for unmanaged, non-spawned bodies, and `convaiWorldPolicy.story` returns false for a spawned one). NCA does not mark followers as quest actors (no `IsQuest` in its source), so the face-side `TalkRefusal` spawned branch, which refuses only a quest-marked body, does not either. Whether the engine reports `IsQuest` true for a clone of a MainQuest record is unverified (live check 10).
- **Commands.** Talking to a spawned character queues one event, the look-at (eyes and head). The AI hold and the turn are behind `!keepAI`, the chest weight is 0 for `keepAI`, and nothing else is sent (`Engagement.reds` `ConvaiBeginFocus`; a test pins the single `SendCommand` behind the guard). Bark muting (`vanilla-reactions.lua`) only drops reaction stimuli and sends nothing.
- **Car context.** Unchanged and not extended. `convaiSpawnedPeople.riders` already reads any spawned roster character seated in V's own vehicle, so with the clone rule every NCA follower on the roster gets "riding along" or "driving" in the turn context, not only Lucy and Rita. A generic merc has no roster profile and is not listed.
- **Duplicates (our Judy beside NCA's Judy).** Unchanged from `docs/SPAWNED_CHARACTERS.md`: one profile, one voice and one memory; a group round keeps one speaker per profile (ours wins unless the spawned one was addressed); the face is prepared per body and audio is per reply, so no slot is shared. Nothing new, not re-tested live.
- Group key, battle reactions and the auto-connect pre-open list work through the same roster-profile rules as every spawned character, so NCA followers are included through the resolved key. Not extended.

**What ships.** Lua only: `mod/character-catalog.lua` and `mod/init.lua`, so the **Scripts zip** (CET Lua). No redscript changed (no game restart for this), and nothing in the **Runtime** (no data, voice, bridge or Convai change). It takes effect on a CET reload.

**Tests.** `bridge/nca-compat.test.mjs` (new, 14): the clone of every roster record resolves to its own profile; the rule is generic and an explicit clone row keeps its owner; `originalRecordName`; NCA's eight story records; numbered clones by name and the bare names; mercs (faction, token, resident, quest clone, never a child, a machine or a named character); the face and memory facts; the busy gate and the command check as source contracts; the soft dependency. `bridge/nca-followers.test.mjs` is unchanged and passes.

**Live checks** (the Scripts install, a CET reload, NCA 1.6.9; 1 to 8 are section 5's, then the new ones):
1. Recruit Lucy and Rita with NCA. Talk to each by text and voice: each answers as herself with lip sync; `probe.log` shows the profile key and `face=true/prepared:...`; NCA keeps them following while they talk.
2. Let NCA seat Lucy in V's car and drive: `Turn context: ... party=1 activity=lucy-kushinada=passenger` (and `driving` with the chauffeur).
3. Group key with both: both answer, each in her own voice.
4. Neither appears as invitable in the Companion Manager or the phone.
5. A side job with a fight and Battle reactions on: either may speak an opening or closing line.
6. Save, load, talk again: the earlier conversation is remembered.
7. Without NCA and the Lucy mods: no new log line, no notice, no change; no new per-frame row in the perf probe.
8. NCA's Greet: note whose vanilla voice Lucy greets with (Panam's is expected).
9. **NCA's Judy.** Recruit Judy with NCA. Talk by text and voice: she answers as Judy Alvarez with Judy's voice, lip sync and expressions; `probe.log` shows `judy-alvarez` and `face=true/prepared:player_woman_photomode_sermo`; no "does not have a conversation profile" notice and no "busy" notice (also while she walks and when she is seated in V's car); she keeps following with only eyes and head turning. Drive with her seated: the turn context shows `activity=judy-alvarez=passenger`. Memory: tell her something, save, load, ask again.
10. **NCA's Panam**, the same as 9 (`panam-palmer`; her face graph is whatever the log reads, send the line if it says `stale:` or `unsupported-rig`). If any NCA story companion logs `skipped:quest` at face time, the engine reports `IsQuest` for the clone: send the line.
11. **Goro, only if the clone is numbered.** Recruit Goro through NCA: if he talks, nothing to do; if "does not have a conversation profile" shows, send the probe line (a numbered clone whose display name is not "Takemura").
12. **A generic NCA merc or Mox.** Talk with "Talk to ordinary NPCs" on: a faction archetype or a resident answers (no named character, no "no profile" notice); a Wyvern or Griffin drone gets the notice. Confirm NCA's quest-record merc ("Sword Mox") answers as a Mox.
13. **Duplicate.** Invite our own Judy beside NCA's Judy: both talk as Judy, a group round gives one speaker for the profile, lips move on whichever body speaks, no probe-log error.

## 11. Seats in V's car: our companions yield to NCA's riders (branch `fix/nca-seats`, 2026-10-19)

Live bug (2026-10-18, 20:29Z): V, our Rosalind Myers and NCA's Lucy, Rita and Judy in V's car; Judy did not get in and the other three sat in one spot. Cause and fix are in `docs/COMPANION_VEHICLES_DESIGN.md`, "Other mods' riders". In short: NCA mounts its followers the moment V gets in and picks seats without checking occupancy (front passenger seat to its best-liked rider, then the free passenger seats in the vehicle's seat order, one per rider); our fleet chose `seat_front_right` for Rosalind from what was free at that moment, before NCA's followers had started to mount. Now the fleet asks once per boarding how many followers another mod is about to seat (spawned-character service, V's attitude group, friendly, outside every vehicle; nothing NCA-specific is named) and keeps the seats NCA's plan uses out of our choice for 25 s. A companion left without a seat takes the ordinary no-free-seat path (overflow car, or waiting for Alt). We still never move, seat, command or dismiss an NCA follower. Lua only: CET reload, no restart.

**Live checks.** NCA 1.6.9 with Lucy, Rita and Judy as followers, our Rosalind (or anyone) invited:
1. Get into V's car with Rosalind and two NCA followers: Rosalind takes the seat NCA does not (`probe.log` `seat-reserved` through the Developer snapshot, or just look); the three sit in three different seats.
2. With three NCA followers and Rosalind: Rosalind gets her own overflow car (or waits if she cannot drive); nobody shares a seat and NCA's third follower is seated or dismissed by NCA, never stuck in a body.
3. Rosalind alone: she still takes the front passenger seat as before.

**Second round (2026-10-19, branch `fix/nca-seats-2`).** The first fix did not work in the 21:05Z check (Alex plus force-spawned Lucy, Rita and Judy): details and findings in `docs/COMPANION_VEHICLES_DESIGN.md`, "Second live check". NCA's `NCA:ForceSpawnCharacter` followers are not in NCA's squad, so NCA plans no seats for them; the engine's follower AI seats them. Our companions now wait for counted followers to take their seats (at most 12 s), choose from the real occupancy, adopt a companion the engine seated, and exit from the car they are really in. Every boarding and exit decision is one `Companion recovery vehicle-...` line in `probe.log`. Check both ways of getting the followers (NCA's normal recruit, so they are in its squad, and the debug command): `vehicle-boarding` shows which riders were counted and why.

