# Talking to ordinary NPCs (archetype profiles)

First slice and second batch, 2026-10-08. Unnamed NPCs that the game gives no story role (gang members, NCPD officers, corporate guards, faction soldiers, vendors, pedestrians) can now be talked to with the usual talk keys. Each is routed to
a generic **archetype** Convai character, one per kind of person and gender: 37 kinds, 74 characters (22 kinds and 44 characters in the first slice, 15 kinds and 30 characters in the second).
A named roster character the game placed in the world (the real Judy) is never routed to Convai at all; only the copy the mod spawns talks (docs/WORLD_COMPANIONS.md, 2026-10-11).


Not yet seen in game: every TweakDB read below is from code and the shipped REDmod tweak sources, so the
in-game check list at the end must pass before this is trusted.

## Files

| File | Role |
| --- | --- |
| `characters/archetypes.json` | Source of truth: keys, variants, detection rules per kind (`bases`), Convai voice, local voiceset families. |
| `characters/archetype-profiles/<base>.json` | Profile text per kind: identity, lore background, knowledge limits, speaking style, slang, original sample lines, sources. |
| `scripts/Build-ArchetypeProfiles.mjs` | Builds `characters/archetype-roster.json` (the three Convai fields, same format and marker as the named roster), review text in `characters/archetype-profile-text/`, and the generated detection block in `mod/character-catalog.lua`. `--check` fails when either is stale. |
| `scripts/Provision-Characters.mjs --roster archetypes` | Creates/updates the 74 Convai characters with the normal payload, marker recovery and readback. IDs go into `runtime/characters.json` under the `npc-*` keys. |
| `mod/character-catalog.lua` | Classifier (`classify`, `classifyBase`, `describe`) and the generated `ARCHETYPES` data; `resolve` now tries archetypes before the resident fallback. |
| `mod/init.lua` | Reads the TweakDB facts of a targeted NPC (cached per entity), the current district, and sends both with the request. |
| `bridge/protocol.mjs` | `parseArchetype`, `archetypeContext` (per-turn "who you are, where you are" text), `isAmbientProfile` (residents + `npc-*`). |
| `scripts/archetype-voices/` | Local-voice reference builder and config registration (below). |
| `bridge/voice-variants.mjs` | Several local voices per profile, picked per NPC (below, `docs/LOCAL_VOICES.md`). |
| `bridge/vendor-memory.mjs` | Remembers V at one-shop vendors across sessions (below, `docs/PLAYER_MEMORY.md`). |
| `scripts/Extract-ArchetypeRecordGenders.mjs`, `characters/archetype-record-genders.json` | Vendor record genders from the tweak sources, for the Model browser mapping. |
| `characters/archetype-voices.json` | Tracked receipt of the chosen voiceset and clip IDs per archetype (no dialogue text). |

The archetypes are kept out of `characters/roster.json` on purpose: they are not researched named
characters, have no dossier, are not invitable and would otherwise appear in every per-character list.
The bridge reads `characters/archetype-roster.json` next to the roster; a missing file means no archetypes.
The detection data is generated into the existing `character-catalog.lua` rather than a new mod file so the
install and release manifests did not change (another agent owns packaging).

## Detection

The adapter gathers plain facts about the NPC under the crosshair (each read guarded, cached per entity):

| Fact | Source (CET) | Notes |
| --- | --- | --- |
| `affiliation` | `npc:GetAffiliation()` | Script method on `NPCPuppet`: `Character.Affiliation().EnumName()`, e.g. `Maelstrom`, `TygerClaws`, `NCPD`, `Arasaka`, `Barghest`, `TheMox`. |
| `vendor`, `vendorType` | `npc:IsVendor()`, `TweakDBInterface.GetCharacterRecord(id):VendorID():VendorType():EnumName()` | Same path the game's `IsRipperdoc()` uses. Types: `RipperDoc`, `Gunsmith`, `Food`, `Drinks`, `GrilledFood`, `Clothing`, ... |
| `quest` | `record:Quest():EnumName()` | `MainQuest`, `SideQuest`, `MinorQuest` mark story actors; they are never routed to an archetype (vendors excepted unless main quest). |
| `police`, `crowd`, `children`, `human` | `IsCharacterPolice`, `IsCrowd`, `IsCharacterChildren`, `GetNPCType() == Human` | Children and machines are never archetypes (children keep the old resident fallback). |
| `recordName`, `recordId` | `TDBID.ToStringDEBUG(GetRecordID())`, `tostring(GetRecordID())` | Crowd record names (`Character.CorpoMan`, `HomelessFemale`, `LowlifeMale`, `CitizenAldecaldosMale`, ...) pick the resident kind; the known names are also matched by TweakDBID string, so this works even if `ToStringDEBUG` has no names. |
| gender | `GetBodyType()` (`WomanAverage` checked before `man`), else `GetResolvedGenderName()` | No gender, no archetype. |
| district | `PreventionSystem:GetCurrentDistrict()`, district record `EnumName()` and parents | Sent as context, e.g. "Kabuki, Watson". |

Precedence: managed copy, named roster profile (record or name), then **vendor** (a vendor type wins over the
record's gang affiliation; some vendors inherit gang records), story-bound check, **police** (MaxTac records
excluded), **corporate security** (Arasaka, Militech, Kang Tao, or `security_*` records), **gang** by
affiliation, **resident kind** (crowd members with a known crowd record), and finally the existing
`resident-male` / `resident-female` fallback for any other crowd member. With the setting off nothing is read
and the old behaviour is unchanged.

Second batch, what changed in the rules: a **faction** category sits between corporate security and gang
(order: vendor, story-bound check, police, corporate security, faction, gang, resident). A faction base matches by
affiliation **or** by a case-insensitive token in the record name (`recordTokens`), because the shipped faction records
(`kab_trauma_soldier_ranged2_dian_ma`, `cpz_kangtao_ranger1_ranged2_dian_ma`, `afterlife_merc_*`, `generic_merc_*`,
`street_goon_*`, `generic_grunt_*`) carry the faction in their names. Corporate security is now **Arasaka** (plus the
`security_*` and `civilianguard_*` records of any employer); Militech and Kang Tao have their own soldier kinds. Skill-trainer
vendors (`VendorType.SkillTrainer`) are split by record name: `melee` -> melee weapons dealer, `netrun`/`techstore` ->
netrunner vendor; a plain skill trainer stays unprofiled.

### The kinds (bases) in this slice

| Category | Kinds | Rule |
| --- | --- | --- |
| Gangs | Maelstrom, Tyger Claws, Valentinos, 6th Street, Animals, Voodoo Boys, Scavengers, Wraiths, Mox, Aldecaldos, Barghest | affiliation (`*Android` variants included where they exist) |
| Police | NCPD | affiliation `NCPD` or police flag, not `maxtac*` |
| Corporate security | one kind; the employer comes from the affiliation as per-turn context | Arasaka / Militech / KangTao, `security_*`, `civilianguard_*` |
| Vendors | ripperdoc, weapons dealer, food and drink vendor, bartender, clothing vendor | vendor type; bartender = food/drink vendor whose record is one of the bartender records (from `Bartender_NPC_Base` in the tweak sources) or contains `barman`/`bartender` |
| Residents | corporate worker, street local, nomad, person living rough | crowd + crowd record (names and prefixes in `archetypes.json`) |

Second batch (15 kinds, both genders):

| Category | Kinds | Rule |
| --- | --- | --- |
| Vendors | medic shop vendor, junk dealer, melee weapons dealer, netrunner vendor, market stall vendor | vendor type `Medical`; `Junk` and `TechJunk`; `SkillTrainer` + record token `melee`; `SkillTrainer` + `netrun` / `techstore`; `Kiosk` and `Market` (taken out of the food vendor) |
| Factions | Militech soldier, Kang Tao soldier, NetWatch agent, Trauma Team responder, Biotechnica employee, mercenary, street goon | affiliation `Militech`, `KangTao`, `NetWatch`, `TraumaTeam`, `Biotechnica`, `AfterlifeMercs`/`AfterlifeMercRogue`; plus the record tokens in `characters/archetypes.json` (`generic_merc`, `afterlife_*` for mercenaries; `street_goon`, `generic_grunt`, ... for goons; plain `Unaffiliated` alone is not a goon) |
| Residents | club-goer, city worker, Dogtown resident | crowd records: `Nightlife*`, dancers, bouncer; `Worker*`, service and morning-crowd records, cooks and waiters; the Dogtown `ep1_combat_zone_citizen_*` records (stacks, pacific, obese, elder, service medical/vendor), moved out of the street local. Dogtown outcasts stay "person living rough", Dogtown business people stay "corporate worker" |

Not made, and why: *cyberware shop* (no NPC is distinct from a ripperdoc: the `*_cyberware_store_*` vendors are `RipperDoc`
type and the NPC records called cyberware are the netrunner shops), *drop points* and *vending machines* (devices, not NPCs;
`DropPoint` and `VendingMachine` vendor types are never talked to), plain *skill trainers* (no NPC record has one without
the melee or netrunner trainer), *Petrochem / other corporate staff* (no such affiliation exists; `Zetatech`, `Corpbud` and
`OA` appear on vehicles and props, and corporate pedestrians already have the corporate worker), *Badlands raiders* (the
Wraiths are the raiders; nothing else is distinct), *MaxTac* (kept unprofiled on purpose), sex workers (not made).

District flavour (Watson, Westbrook, Heywood, Santo Domingo, Pacifica, City Center, Badlands, Dogtown) is
per-turn context, not separate profiles: the same street-local profile speaks from Kabuki or Arroyo.

## Profiles

Every profile backstory has: the identity of the kind ("You are an unnamed Maelstrom ganger in Night City, a
man."), lore background lines (turf, culture, business, rivals), shared archetype rules (no fixed name or
history, V is a stranger, nothing about V's story, the Relic or Johnny, rumor is rumor, use the per-turn place,
never claim to sell/arrest/open/give anything), knowledge limits for the kind (leadership and quest-dependent
events are rumor only), and the ownership marker `[CyberpunkConvai profile v2:<key>]`. The speaking style
carries the tone, a slang list ("use sparingly") and the shared spoken-reply rules; samples are original
one-line utterances without speaker labels. Gang lore was written from game knowledge with leadership and
quest outcomes deliberately left out (Mox and Maelstrom leaders, Saul/Panam, Hansen's fate). Sources list
the local tweak files and the wiki page (not fetched).

Convai settings match the residents: English (`en-US`) only, Convai long-term memory **off** (vendor memory is local, see below), default verbosity and
state-of-mind settings, model `fast-gemma-4-31b-it`, Kokoro voice per variant (in `archetypes.json`).

**Multilingual twins (2026-10-08).** All 74 archetypes have a "<name> Multilingual" twin
(`node scripts/Create-MultilingualProfiles.mjs --roster archetypes --apply`; the 30 of the second batch are in `characters/multilingual-voice-map.json` with varied non-main-cast Azure voices, reused between kinds that do not meet): a faithful clone, en-US only, memory off,
a matched Azure multilingual voice from `characters/multilingual-voice-map.json`, marker `:multilingual`. With
Multilingual conversations on, the bridge routes an archetype to its twin like a named character; a twin is used once its
language box is marked off (web session). See `docs/MULTILINGUAL_PROFILES.md`.

## Identity and memory

- **Several voices per archetype variant (second batch).** Each variant has 1 to 4 local voices (`voiceCount` in
  `characters/archetypes.json`: 2 by default, 3 for the big gangs' men, police, corporate security, food vendors and the
  crowd kinds), each a different game voice actor: the profile key is voice 1, `<key>-v2`, `-v3`, `-v4` the others.
  The voice of an NPC is picked deterministically: SHA-256 of `<profile key>|<seed>`, modulo the number of voices the
  current engine can speak, where the seed is the shop record of a one-shop vendor (so a ripperdoc keeps his voice for
  good) and otherwise the NPC's entity ID (so one pedestrian keeps his voice while the world is loaded). Routing,
  provider choice and the Convai fallback still use the profile key; a variant that is not ready falls back to the
  profile's first voice. The Convai cloud voice stays one voice per character. `bridge/voice-variants.mjs`,
  `docs/LOCAL_VOICES.md` ("Several voices per profile").
- **Conversation scope = one physical NPC in one loaded world.** Archetypes are ambient profiles
  (`isAmbientProfile`): the bridge partitions sessions by the actor's entity hash, exactly like the residents,
  so two Maelstrom gangers never share a conversation, and the same one keeps it while the world stays loaded.
  An ambient turn without an entity is refused (`ambient-entity-unavailable`). Save-bound quest knowledge and
  verified identity are never attached to ambient profiles.
- **No Convai memory; vendor memory is local.** Convai long-term memory is disabled on all 74 (as on the residents),
  so nothing one ganger heard leaks to every other ganger. After a load the world token changes and the NPC starts fresh.
- **Vendor memory (second batch).** A shopkeeper V returns to remembers V: the game sends `archetype.memoryKey`, the TweakDB
  record of a vendor that has a record of its own (`wat_kab_ripperdoc_01`; `Character.vendorRecords` in the generated Lua,
  131 records from the shipped tweak sources, excluding the shared street-stall records such as `Character.Kiosk`, which
  stand at many stalls). The identity is the **record**, not the entity: it is the same shop in every save and session, and
  there is exactly one per shop. Only vendor archetypes get a key (not crowd, goons, factions, invited Model-browser copies,
  main-quest vendors). Convai's own memory is per (character, end user) and the runtime has exactly one end-user ID, so
  a per-vendor provider memory would need an end-user ID per shop (rejected in the memory design) and all ripperdocs would
  share one memory. So the memory is local: the last 10 delivered private exchanges per record in
  `runtime/vendor-memory.json`, re-injected as per-turn context (`bridge/vendor-memory.mjs`). **Forget all memories**
  also clears it (a Forget-all fence stops in-flight turns from writing); Forget selected character does not touch it, because
  archetypes are not in the picker. Details: `docs/PLAYER_MEMORY.md`, "Vendor memory". The setting text says unnamed people
  forget you after a load, "except shopkeepers you come back to" (15 locales).
- **Auto-connect** treats archetypes as generic (prominence 3, after named characters). An ambient profile has no
  connection without its body, so the game publishes the entity ID of each warmed or partnered character
  (`entities` in `runtime/nearby-connections.json`) and the bridge opens that NPC's own route; the existing caps
  (2 slots, 2 partners, one start every 3 s, 40 s release) are unchanged.

## Latency

A first reply from a fresh resident or archetype should be as quick as a companion's (2026-10-08 fix):

- **No memory admission.** An ambient turn takes `PlayerMemory.beginSessionConversation`: it records the Forget-all target
  locally (a registry check of a few ms) and never calls Convai. Before, every first ambient turn after a bridge start ran
  the named-character path, `enableMemory` (a 2.2 MB `/character/list`, `/character/get`, and when memory was off an
  `/character/update` and a readback): 6.7 s measured on `resident-male`, which also switched that character's Convai
  memory **on**, against this design.
- **Connection overlapped with input.** The talk keys (text and voice) put the addressed NPC's entity in
  `runtime/conversation-prewarm.json`; the bridge opens that NPC's exact route at once, while V types or the microphone
  starts, and the submitted turn reuses the page (same transport identity). Looking at or standing near a resident
  (Auto-connect) and a conversation partner do the same. Two residents share a profile key, so the NPC being addressed
  always wins the profile's private slot.
- **Visible stages.** `runtime/bridge-latency.json` per turn: `submissionStages.memory` (`mode` session-only or provider,
  `beginMs`, `refreshMs` when a memory change replaced the pages) and `connectionWarm` (the turn's connection when it
  arrived: `state` none/connecting/ready, `role`, `samePage`, `startedMsAgo`, `warmMs`); `timing.connectionReused`
  and `poolWaitMs` then show whether the turn waited for the warm-up.

## UI

- Settings > Conversations > **Talk to ordinary NPCs** (On by default), translated in all 15 locales.
- Archetypes are **not** listed on the Characters page, in Who can talk or in the profile assignment list:
  they are not invitable companions (no spawn record, no identity of their own), and 44 rows would bury the
  named cast. The one setting governs all of them; the two residents keep their own Who can talk rows.

## Model browser (installed character models)

Home > Model browser lists every `gamedataCharacter_Record`. A record without a named profile is now classified
from TweakDB alone (a spawned copy has no live body to read): `record:Affiliation()`, `IsCrowd()`, `IsChild()`,
`CharacterType()` (Human only), `Quest()`, `VendorID():VendorType()` and the record name
(`characterCatalog.classifyRecord`, facts read in `manager.lua`). The same precedence as live NPCs applies, plus:

- Gender comes from the record name (`_ma`/`_wa`/`_mb`, `Woman`, `CorpoManBig`, `barman`, ...). Vendor records
  name no gender (`Character.wat_kab_ripperdoc_01`), so `scripts/Extract-ArchetypeRecordGenders.mjs` reads it
  from the shipped tweak sources (the `*_NPC_Base_Female` parent or the `_wa.ent` template) into
  `characters/archetype-record-genders.json` (134 vendor records, plus the 131 one-shop vendor records used for vendor memory), which the builder embeds in the Lua block.
  No gender, no profile.
- Story actors stay silent followers: a `MainQuest`/`SideQuest`/`MinorQuest` tag or a `q###_`, `sq###_`, `mq###_`
  record name. Children, androids and MaxTac too.
- A crowd record without a resident kind uses the generic resident (`resident-male`/`resident-female`).

The row says "Conversation: Maelstrom ganger (archetype)" (named records keep "Conversation: <name>",
others "No conversation profile ..."), and the status row adds "{count} of them can talk." for the current search.

Invited, an archetype (or resident) copy joins as a model, with nothing to prepare, because a generic profile has no memory
of its own and no connection without a body (`manager-party.lua` `ambientProfile`). Its profile is assigned
as it spawns, so it talks with that archetype's Convai character and voice. Its per-turn context is built from the
profile key and the district. The session identity is the copy's entity, so each invited copy has its own
conversation for as long as it exists, with no long-term memory, the same as live archetype NPCs. Party,
auto-connect (generic prominence) and the follow/leave actions treat it like any generic party member.

## Local voices

`python scripts/archetype-voices/build_archetype_voices.py` (about 6 minutes, archive reads, no GPU/network)
then `node scripts/archetype-voices/register_archetype_voices.mjs`. No training, likeness search, clip search or
Kaggle (user decision: these characters do not merit it).

- One generic voiceset actor per voice from the game's own NPC voicesets (`gang_mls_*`, `gang_tcl_*`,
  `ncpd_*`, `sec_*`, `merc_*`, `civ_*`, ...): the candidate with the most clean lines; an actor is used by one key only.
  Second batch: each variant gets `voiceCount` distinct actors (pass 1 builds every key's first voice in catalogue
  order, pass 2 and 3 the `-v2` and `-v3` voices from the remaining actors). A key that is already "ready" in the manifest is
  reused as it is (`--rebuild KEYS` to redo one), so the 44 voices of the first slice did not change by a byte.
- Lines: subtitled, English, at least 4 words, no `!`, not all caps, no combat words, no voiceset barks, no
  helmet/holocall/rewind assets, no effect names, not flagged by the scene-metadata combat fallback
  (`scripts/combat_flags/` via `source_combat`); after decoding, 1.5 to 9 s, no clipping, not band-limited, and
  within +4 / -8 dB of the actor's median loudness (shouted lines removed).
- References: whole clips, 0.4 s gaps, 24 kHz mono 16-bit; OmniVoice short at most 10 s, long at most 18 s,
  Pocket at most 20 s; at least 2 clips each. All 178 keys are ready (44 first-slice voices, 30 new variants, 2 generic residents and 102 extra voices); none fell back to the cloud voice.
- Written to `runtime/voice-references/archetypes/<omni-short|omni-long|pocket>/<key>.wav` and registered in the
  live configs (`pocket-voices.autobest.json`, `local-voices.autobest-short.json`, `local-voices.autobest-long.json`)
  and the base configs; backups in `runtime/backups/archetype-voices-*`. The voice profile limit was raised from
  128 to 256 and now to 1024 (`bridge/voice-profile-registry.mjs`, `resident-voice-worker.py`, `pocket_voice_runtime.py`);
  the live configs hold 255 profiles. `register_archetype_voices.mjs` only adds new keys now and leaves the entries of
  already registered keys byte-identical.
- The Voodoo Boys female uses a Caribbean civilian voiceset (`civ_mid_f_71_car_25`; the gang has almost no
  female lines). The nomad residents use `civ_low_*` actors (the Aldecaldos archetypes took the best
  `gang_ald_*` actors). Accents follow the voiceset (Tyger Claws Japanese, Valentinos Mexican, Scavengers Russian).
- The two generic residents (`resident-male`, `resident-female`) now have local voices too (`residentVoices` in
  `characters/archetypes.json`, three voices each: `civ_mid_m_22_enus_30`, `civ_cbz_f_02_enus_30`, ...).
- Not accent-matched everywhere (picks are the cleanest distinct actors of the listed families): for instance Kang Tao
  uses `sec_*` actors, Dogtown `civ_low_*`/`civ_mid_*`. Weakest: `npc-homeless-female-v2` has 9.9 s of clean material, so
  its three references are the same audio. Nothing has been listened to yet.
- The receipt `characters/archetype-voices.json` lists voiceset and clip IDs per key (no dialogue).

## Install

Development install (second batch, install at a break in testing: CET reload for `mod/character-catalog.lua`, `mod/mcm.lua`
and the 15 locale files; bridge restart for `bridge/` and the new `runtime/` data; the live bridge keeps running the old build
until restarted): `.\scripts\Install-DevelopmentMod.ps1` (the changed mod files are already in
`scripts/development-files.json`), then restart the conversation bridge so it loads the archetype roster, the 44
IDs in `runtime/characters.json` and the extended voice configs. Release packaging must add
`characters/archetype-roster.json` to the runtime package and generate archetype references on the player's
machine like the named ones (packaging agent).

## In-game check list

1. `npc:GetAffiliation()` returns enum names (`Maelstrom`, `TygerClaws`, ...) for gang members in Watson,
   Japantown, Heywood, Santo Domingo, Pacifica, Badlands and Dogtown (Barghest).
2. `IsVendor()` and `VendorID():VendorType():EnumName()` return `RipperDoc`, `Gunsmith`, `Food`, `Clothing` for
   the Kabuki ripperdoc, a gunsmith, a noodle stall and a clothing shop; a vendor with a gang record (Kabuki
   gunsmith 02) routes to the weapons dealer, not Maelstrom.
3. A bartender (Lizzie's, El Coyote Cojo, Afterlife is named Claire and must stay Claire) routes to the bartender.
4. `record:Quest():EnumName()` exists and main/side quest gang actors (for example in The Pickup) are not routed.
5. NCPD patrol officers route to NCPD; MaxTac are not routed; Arasaka / Militech / Kang Tao guards route to
   corporate security and the per-turn context names the employer.
6. `TDBID.ToStringDEBUG` returns `Character.*` names for crowd NPCs; corporate pedestrians in City Center,
   homeless people, street locals and Badlands nomads route to their kinds; other pedestrians keep the
   resident fallback; children are never routed.
7. `GetResolvedGenderName()` / body type picks the right variant for women in each category.
8. `PreventionSystem:GetCurrentDistrict()` gives the district and area (log line "Archetype conversation: ...").
9. The talk keys (text and voice) open a conversation with an archetype; the reply stays in role, does not know
   V's story, uses the place, and never claims a sale/arrest/access.
10. Two NPCs of the same kind have separate conversations; the same NPC keeps its conversation until a load.
11. Local voices: listen to each archetype on Pocket and OmniVoice (short/long); especially the accented
    voicesets, homeless female (12 s source) and the 4 to 5 s OmniVoice short references.
12. The setting Off restores the old behaviour (gang members unprofiled, pedestrians as residents).
13. Performance: gaze/scan calls stay cheap (facts cached per entity).
14. Hostile NPCs in combat: talking is possible; decide whether to block it.
15. Model browser: Maelstrom, Tyger Claws, NCPD and Arasaka records show "Conversation: ... (archetype)"; quest
    records (`q###_`), MaxTac, androids and children show "No conversation profile"; the talk count looks sane. In CET,
    `record:Affiliation():EnumName()`, `Quest()` and `VendorID()` return what `manager.lua` expects.
16. Invite a Maelstrom grunt and a female Tyger Claw from the Model browser: each joins, answers as that archetype
    with its voice, follows, can be sent away (Leave V's Party), and two copies of one record talk separately.
17. Invite a vendor record (a ripperdoc) and a crowd record (CorpoWoman): the right gender variant and kind.

### Second batch checks

18. Vendors: a medic store counter (Medical), a junkshop (Junk), a Little China melee vendor (`wat_lch_melee_01`, SkillTrainer),
    a Kabuki netrunner/techstore vendor and a kiosk/market stall route to their kinds; the log line "Archetype conversation:"
    shows `base=`. Confirm `VendorID():VendorType():EnumName()` is `SkillTrainer` for the melee and netrunner vendors (the split
    relies on the record name tokens `melee`, `netrun`, `techstore`).
19. Factions: Militech and Kang Tao soldiers now route to their own kinds (a `security_*` guard of either employer is still
    "corporate security"); NetWatch, Trauma Team, Biotechnica staff, Afterlife-style mercenaries and street goons
    (`street_goon_*`, `generic_grunt_*`) route by `GetAffiliation()` enum or record name. Confirm the enum names
    (`NetWatch`, `TraumaTeam`, `Biotechnica`, `AfterlifeMercs`) and that `TDBID.ToStringDEBUG` gives the record names the tokens expect.
20. Residents: nightlife (club NPCs in Kabuki/Japantown), workers (cooks, waiters, municipal workers), Dogtown pedestrians
    in the stacks.
21. Voices: talk to several pedestrians of one kind: they should not all sound alike, and the same pedestrian keeps his voice
    for a whole conversation and after walking away and back; two Maelstrom men differ. A ripperdoc keeps one voice across
    sessions. `runtime/voice-routing.log` (voice routing log) names the voice key used.
22. Vendor memory: talk to a ripperdoc (or a medic, gunsmith), load a save, talk again: he remembers; another ripperdoc does
    not know what you told the first one; a pedestrian does not remember. Settings > Memory > Forget all memories empties
    `runtime/vendor-memory.json`.
23. Generic residents (`resident-male`, `resident-female`) have a local voice with Pocket and OmniVoice.
24. Multilingual: the 30 new twins need the language box unticked in the web session before the bridge routes to them.
25. Latency: after a bridge restart, open the text box on a pedestrian, wait ~4 s, send. In `runtime/bridge-latency.json`
    the turn shows `submissionStages.memory.mode` "session-only" with `memoryAdmissionMs` under ~50, `connectionWarm.state`
    "ready" with `samePage` true, and `timing.connectionReused` true. A voice turn to a pedestrian you looked at shows the same.

## Follow-up plan

1. In-game verification of the lists above (first slice 1-17, second batch 18-24); fix any fact read that fails (each is isolated and guarded).
2. ~~Multilingual twins for the archetypes~~ (done for all 74; the language box of the 30 second-batch twins is set through the web session).
3. ~~More vendor kinds~~, ~~more factions~~, ~~more resident kinds~~, ~~several voices per variant~~, ~~vendor memory~~, ~~local voices for the generic residents~~ (second batch, 2026-10-08; see above for what was deliberately not made).
4. Still open: Kurtz militia in base Pacifica (Barghest covers Dogtown), religious/jogger/fitness crowd kinds, sex workers (with care), children as a separate safe profile if wanted.
5. A per-shop or "Shopkeepers" row in the Forget picker (needs strings in the 15 locales); today Forget all clears vendor memory.
6. Listening checks of the new voices (accents are not matched everywhere) and a decision on whether the weak `npc-homeless-female-v2` is worth keeping.
7. Packaging: `characters/archetype-roster.json` is shipped and the references/configs come from the HF bucket `final/` (`docs/PACKAGING.md`); refresh `final/` and `packaging/release-data` after any new profile or voice.
8. Optional: block or tone talk with hostile NPCs in combat; let the phone and group chat list nearby archetypes.
