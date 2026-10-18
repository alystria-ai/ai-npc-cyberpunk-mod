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
- **`invite: false`** on both rows, honoured by `definitionFor` in `mod/manager.lua`: no companion definition, so the Manager shows "Profile only", MCM lists them as unavailable and the party queue refuses them. Without this, every player would have seen an invitable "Lucy Kushinada" whose record may not exist. `buildProfiles` keeps the field on rebuilds (`...preserved`).
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
| a | Convai voice only (placeholder Claire) | Works on the Convai provider. On Pocket or OmniVoice she falls back to the Convai voice; on Voxtral, or Mistral or local text with a local voice, she is text only. | none |
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
4. Neither appears as invitable in the Companion Manager (Profile only), MCM or the phone.
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
- The twins stay unused until the language box is unticked (`multilingualTwins` skips a twin whose `languageBoxOff` is not true and logs it). That is the one manual step; see the report to the user for the exact list.
- **Routing on every provider, checked.** After the ID gate (`!ids[profile.key]` at the text and microphone turn starts), nothing per profile depends on a Convai ID except the Convai route itself: the knowledge route is keyed by profile key (both keys are in the world-knowledge audience), `localTurn` (Mistral and Local AI) carries the key and the name only, local memory is `runtime/local-memory/player/<key>.json`, and the voice choice reads the roster and the voice configs. `bridge/nca-followers.test.mjs` pins the data (IDs, twins, voice map), tier-1 membership and these gates, and runs the real knowledge router and relationship routing for both keys. No live talk turn was made.

**D3 and D4, Rita's voice, done offline.** Her lines are the nine of the actor `lizzies_bouncer` in the Corpo-Rat scene `q000_corpo_04_lizzies_club` (scene-level attribution; details, clips, checks and hashes in `docs/GAME_VOICE_REFERENCES.md`, "Hand-extracted references for Rita Wheeler"). The door guards of The Information and the Lizzie's mood scene speak with other voice tags and are not hers on the evidence. Two short references (omni-short 9.98 s; omni-long and Pocket 11.71 s) were built and wired into the three live voice configs; Voxtral takes the long set. To ship, upload the three WAVs and the three configs to the Hugging Face bucket (paths in that section). Limits: only nine lines of 1.3 to 2.9 s exist, so the long set is shorter than the usual 12 to 18 s; all four shouted lines are left out; no listening review yet (an audition in the game is the first live check for her voice).

**D2, Lucy, research only.** Candidates, tool and pipeline are in the report to the user; nothing was downloaded, no tool installed, and her Convai voice stays the placeholder. She has `unprepared` in the three voice configs (the same entry a profile without a clip has): on Pocket or Omni she falls back to the Convai voice, and on Voxtral, or Mistral or local text with a local voice, she is text only until a reference exists.

**Work list changes.** D1, release data, `TIER1_KEYS`, auto-connect, the README line and Rita's references are done. Open: the user unticks the two language boxes and the map then records `languageBoxOff: true` in `runtime/multilingual-profiles.json` and the release data; upload Rita's files; Lucy's clips (needs the user's download approval); the live checks above, plus an audition of Rita's voice.
