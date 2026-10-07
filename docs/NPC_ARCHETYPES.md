# Talking to ordinary NPCs (archetype profiles)

First slice, 2026-10-08. Unnamed NPCs that the game gives no story role (gang members, NCPD officers,
corporate guards, vendors, pedestrians) can now be talked to with the usual talk keys. Each is routed to
a generic **archetype** Convai character, one per kind of person and gender: 22 kinds, 44 characters.
Named roster characters are unaffected and always win.

Not yet seen in game: every TweakDB read below is from code and the shipped REDmod tweak sources, so the
in-game check list at the end must pass before this is trusted.

## Files

| File | Role |
| --- | --- |
| `characters/archetypes.json` | Source of truth: keys, variants, detection rules per kind (`bases`), Convai voice, local voiceset families. |
| `characters/archetype-profiles/<base>.json` | Profile text per kind: identity, lore background, knowledge limits, speaking style, slang, original sample lines, sources. |
| `scripts/Build-ArchetypeProfiles.mjs` | Builds `characters/archetype-roster.json` (the three Convai fields, same format and marker as the named roster), review text in `characters/archetype-profile-text/`, and the generated detection block in `mod/character-catalog.lua`. `--check` fails when either is stale. |
| `scripts/Provision-Characters.mjs --roster archetypes` | Creates/updates the 44 Convai characters with the normal payload, marker recovery and readback. IDs go into `runtime/characters.json` under the `npc-*` keys. |
| `mod/character-catalog.lua` | Classifier (`classify`, `classifyBase`, `describe`) and the generated `ARCHETYPES` data; `resolve` now tries archetypes before the resident fallback. |
| `mod/init.lua` | Reads the TweakDB facts of a targeted NPC (cached per entity), the current district, and sends both with the request. |
| `bridge/protocol.mjs` | `parseArchetype`, `archetypeContext` (per-turn "who you are, where you are" text), `isAmbientProfile` (residents + `npc-*`). |
| `scripts/archetype-voices/` | Local-voice reference builder and config registration (below). |
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

### The kinds (bases) in this slice

| Category | Kinds | Rule |
| --- | --- | --- |
| Gangs | Maelstrom, Tyger Claws, Valentinos, 6th Street, Animals, Voodoo Boys, Scavengers, Wraiths, Mox, Aldecaldos, Barghest | affiliation (`*Android` variants included where they exist) |
| Police | NCPD | affiliation `NCPD` or police flag, not `maxtac*` |
| Corporate security | one kind; the employer comes from the affiliation as per-turn context | Arasaka / Militech / KangTao, `security_*`, `civilianguard_*` |
| Vendors | ripperdoc, weapons dealer, food and drink vendor, bartender, clothing vendor | vendor type; bartender = food/drink vendor whose record is one of the bartender records (from `Bartender_NPC_Base` in the tweak sources) or contains `barman`/`bartender` |
| Residents | corporate worker, street local, nomad, person living rough | crowd + crowd record (names and prefixes in `archetypes.json`) |

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

Convai settings match the residents: English (`en-US`) only, long-term memory **off**, default verbosity and
state-of-mind settings, model `fast-gemma-4-31b-it`, Kokoro voice per variant (in `archetypes.json`).

**Multilingual twins: not created in this slice.** `scripts/Create-MultilingualProfiles.mjs` only accepts
roster keys and that script belongs to the multilingual agent. Without a twin an archetype keeps its English
original when Multilingual conversations is on (documented behaviour for profiles without twins);
`bridge/multilingual.test.mjs` exempts `npc-*` keys from the installed-twin check. Follow-up below.

## Identity and memory

- **One voice per archetype variant.** Every Maelstrom man sounds the same. Chosen over several voices per
  variant because the Convai cloud voice is per character anyway (local and cloud stay consistent), because
  44 references is already a lot of conditioning to keep cached, and because the same pedestrian then always
  keeps the same voice without a per-NPC assignment table. Several voices per variant, assigned by hashing
  the entity, is a follow-up.
- **Conversation scope = one physical NPC in one loaded world.** Archetypes are ambient profiles
  (`isAmbientProfile`): the bridge partitions sessions by the actor's entity hash, exactly like the residents,
  so two Maelstrom gangers never share a conversation, and the same one keeps it while the world stays loaded.
  An ambient turn without an entity is refused (`ambient-entity-unavailable`). Save-bound quest knowledge and
  verified identity are never attached to ambient profiles.
- **No durable memory.** Convai long-term memory is disabled on all 44 (as on the residents), so nothing one
  ganger heard leaks to every other ganger. After a load the world token changes and the NPC starts fresh.
  Persistent world NPCs (vendors) do have stable entity IDs; per-NPC durable memory keyed on that is a follow-up.
- **Auto-connect** treats archetypes as generic (prominence 3, after named characters). Ambient profiles cannot
  be warmed without their entity, so in practice they connect on first talk; the existing caps (2 slots,
  one start every 3 s, 40 s release) are unchanged.

## UI

- Settings > Conversations > **Talk to ordinary NPCs** (On by default), translated in all 15 locales.
- Archetypes are **not** listed on the Characters page, in Who can talk or in the profile assignment list:
  they are not invitable companions (no spawn record, no identity of their own), and 44 rows would bury the
  named cast. The one setting governs all of them; the two residents keep their own Who can talk rows.

## Local voices

`python scripts/archetype-voices/build_archetype_voices.py` (about 6 minutes, archive reads, no GPU/network)
then `node scripts/archetype-voices/register_archetype_voices.mjs`. No training, likeness search, clip search or
Kaggle (user decision: these characters do not merit it).

- One generic voiceset actor per archetype from the game's own NPC voicesets (`gang_mls_*`, `gang_tcl_*`,
  `ncpd_*`, `sec_*`, `civ_*`, ...): the candidate with the most clean lines; an actor is used by one archetype only.
- Lines: subtitled, English, at least 4 words, no `!`, not all caps, no combat words, no voiceset barks, no
  helmet/holocall/rewind assets, no effect names, not flagged by the scene-metadata combat fallback
  (`scripts/combat_flags/` via `source_combat`); after decoding, 1.5 to 9 s, no clipping, not band-limited, and
  within +4 / -8 dB of the actor's median loudness (shouted lines removed).
- References: whole clips, 0.4 s gaps, 24 kHz mono 16-bit; OmniVoice short at most 10 s, long at most 18 s,
  Pocket at most 20 s; at least 2 clips each. All 44 ready; none fell back to the cloud voice.
- Written to `runtime/voice-references/archetypes/<omni-short|omni-long|pocket>/<key>.wav` and registered in the
  live configs (`pocket-voices.autobest.json`, `local-voices.autobest-short.json`, `local-voices.autobest-long.json`)
  and the base configs; backups in `runtime/backups/archetype-voices-*`. The voice profile limit was raised from
  128 to 256 (`bridge/voice-profile-registry.mjs`, `resident-voice-worker.py`, `pocket_voice_runtime.py`).
- The Voodoo Boys female uses a Caribbean civilian voiceset (`civ_mid_f_71_car_25`; the gang has almost no
  female lines). The nomad residents use `civ_low_*` actors (the Aldecaldos archetypes took the best
  `gang_ald_*` actors). Accents follow the voiceset (Tyger Claws Japanese, Valentinos Mexican, Scavengers Russian).
- The two generic residents (`resident-male`, `resident-female`) still have no local voice (Convai voice).

## Install

Development install: `.\scripts\Install-DevelopmentMod.ps1` (the changed mod files are already in
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

## Follow-up plan

1. In-game verification of the list above; fix any fact read that fails (each is isolated and guarded).
2. Multilingual twins for the 44 archetypes: give `Create-MultilingualProfiles.mjs` an archetype roster option
   (multilingual agent), add voices to the twin voice map, set the language box through the web session.
3. More vendor kinds: medic store, netrunner/cyberware vendor (`Cyberware`), junk shop (`Junk`, `TechJunk`),
   melee vendor, drop points (device, not an NPC), skill trainers.
4. MaxTac (probably keep unprofiled), NetWatch, Trauma Team, Biotechnica, Afterlife mercs, Kurtz militia
   in base Pacifica, Militech in Dogtown, generic street goons (`Unaffiliated`).
5. More resident kinds: nightlife, workers, sex workers (with care), religious, joggers, Dogtown
   (`ep1_combat_zone_*`) residents, children as a separate safe profile if wanted.
6. Several voices per variant assigned deterministically from the entity hash; local voices for the two
   generic residents.
7. Per-NPC durable memory for persistent world NPCs (vendors) keyed on their stable entity, with an explicit
   end-user scope per NPC, if Convai memory is wanted for them.
8. Packaging: ship `characters/archetype-roster.json`; generate archetype references on install.
9. Optional: block or tone talk with hostile NPCs in combat; let the phone and group chat list nearby archetypes.
