# Companions change outfits

Settings > Companion behavior > **Companions change outfits** (on by default, in Mod Configuration Menu and Native Settings UI alike). Party companions change into
other looks of their own by the game's time of day, now and then for variety, and into casual clothes at home. Only while nobody is looking, and only for the
mod's own party copies. Added 2026-10-25 on branch `feat/outfits`; built and unit-tested, **not seen in the game yet** (live checks at the end).

## What the player sees

- **By time of day.** A character with several looks has a day look and a night look (19:00 to 05:59 game time is night). When the hour turns and the look worn does
  not suit it, the copy changes into one that does.
- **Variety.** On an hour change, once a copy has worn a look for 4 game hours, there is a 30 % chance it changes into another look that suits the hour.
- **At home.** In V's apartment (the game's district is one of the five apartment records, below) a copy that has a casual home look puts it on, and takes it off
  when V leaves with them. Another feature can also put a companion at home by name (the home outfit API, below).
- **Only out of sight.** A change is due, then waits until the game's own camera test says the copy is outside what V can see; it does not happen in a fight, a
  scene, a call, a ride, on a lift or a seat, or while a command (a tactic) or the copy's own recovery is running (the same blockers the stance module uses). A new copy is created in the right clothes straight away (it is placed in view, so nothing is
  changed in front of V).
- **Off.** Nothing is loaded, ticked or changed. Turning it off keeps what the companions wear until their copies are dismissed (nothing runs to change them back).

## Which characters, how many

15 characters, 42 outfits, all in `mod/companion-outfits-data.lua` (kinds: any / day / night / home):

| Character (record) | Outfits | Home look |
| --- | --- | --- |
| Judy (`Character.Judy`) | 2 | tank top, boxer shorts, flip-flops |
| Panam (`Character.Panam`) | 4 | shirt and trousers, no jacket |
| River Ward (`Character.Sobchak`) | 3 | tank top and trousers |
| Kerry Eurodyne (`Character.Kerry`) | 3 | t-shirt and trousers |
| Jackie Welles (`Character.Jackie`) | 5 | none |
| Rogue (`Character.Rogue`) | 3 | none |
| Solomon Reed (`Character.reed`) | 4 | none |
| Alex (`Character.alex`) | 3 | none |
| Evelyn Parker (`Character.Evelyn`) | 2 | the dress without the fur coat |
| Goro Takemura (`Character.Takemura`) | 2 | none |
| Thompson (`Character.Thompson`) | 2 | without the coat |
| Yorinobu Arasaka (`Character.Yorinobu`) | 3 | none |
| Claire Russell (`Character.Claire`) | 2 | none |
| Joss Kutcher (`Character.sq021_joss`) | 2 | pyjamas |
| Ozob Bozo (`Character.Ozob`) | 2 | none |

Everyone else has one suitable look in the game's data, or a template shared with crowd members (Dennis Cranmer, Coach Fred, Steven Santos and Pedro Aimar: their
appearance lists belong to other people), and keeps the look they have. Johnny is not listed (his phantom controller maps the physical copy to one solid look,
`companion-appearance.lua`). Characters from other mods and any model record the table does not name are not touched.

## How appearances are listed and applied

**Listed.** Nothing is listed at run time: the list is a curated table, one entry per model record, and every name in it is a name the record's own entity template
lists, so a character cannot be given another character's look. The reference mod (a third-party appearance tool, studied as data) reads the same lists at run time
by loading the record's `entityTemplatePath` from the resource depot and reading the template's `appearances` names, and it keeps a database of them per record;
it also shows names that only its own archives add, which the installed game does not have, so its lists were not copied. Ours were read from the installed game
(`scripts/Extract-CompanionOutfitEvidence.mjs`, WolvenKit CLI 9.0.1): the template of each record from the shipped REDmod tweak sources
(`tools/redmod/tweaks`, `entityTemplatePath`, through parent records), the template unbundled and serialised, its `appearances[].name` list written to
`characters/companion-outfit-evidence.json`. Game 2.5 and game 2.31 list identical names for all 15 templates; the script fails if two games disagree. The clothing
meshes of the looks that were chosen were checked in the `.app` files (a look whose only clothes are underwear, a bloody jacket, a prostitute outfit, an accessory
removed from the character's signature look: left out; the rule is in the file's header and enforced by `bridge/companion-outfits.test.mjs`).

**Applied.** On the party copy's puppet: `PrefetchAppearanceChange(name)` to load the look (no visible change), a second later `ScheduleAppearanceChange(name)` when
the copy is still unseen, and `GetCurrentAppearanceName()` a second after that to confirm. A look that does not show within 20 s is given up (the name a recreated
copy would use is put back, and the look is not tried again in the session). No respawn, no new entity. The reference mod does the same two calls (prefetch then
schedule) for its own changes. The copy's `entry.appearance` is set to the new name, so a copy recreated after fast travel is made in the same clothes
(`companions.lua`, the existing recreation path).

**Face.** An appearance change rebuilds the copy's `face_rig` with the vanilla graph. The redscript half already prepares such a rebuild again for our own copies
(`Face.reds` `OnReassemble`, `FaceOwner` kind 1, written 2026-10-19 on `fix/face-replaced-model` and not yet seen in the game). No redscript was added for outfits.
Live check below: talk right after a change and read the `Face request` line in `probe.log`.

## Bios: what the character is told about her clothes

Decision: **the appearance text stays as it is, and the turn says when the clothes differ.** `characters/appearance.json` describes the base look ("You wear a light grey
tank top.") and is baked into the Convai backstory and the Mistral/Local persona, so it cannot follow a change. Per-outfit bios would need a Convai re-provision for
every outfit and ~40 new texts. Instead `companions.activityInputs` carries `outfit = 'home' | 'changed'` (nil in the base look) from `mod/companion-outfits.lua`
`status`, `mod/turn-context.lua` forwards it on the party row, and `bridge/turn-context.mjs` adds one sentence to the in-person block, right after the place:

- `home`: "You are in casual clothes for home, not the outfit your appearance notes describe. Your hair, face, tattoos and cyberware are the same."
- `changed`: "You have changed clothes: you are not wearing the outfit your appearance notes describe. Your hair, face, tattoos and cyberware are the same."

It is said only to the companion in person (never on the phone, in a call or to a stranger), it counts as part of the Company and vehicle kind of Dynamic info (that
switch off drops the party row and with it this sentence), and it is the first thing a budget cut keeps after the place. The base of each character is the template
default (Kerry: the appearance `companion-records.lua` selects), which is the look the bio was written for; where the bio and that default already disagreed before
this feature (the bio was written from a picture) nothing gets worse.

## Home outfit API

A global, `convaiOutfitApi`, defined by `mod/init.lua`; safe to call at any time (it loads the module on first use) and with the setting off (it then only remembers):

```lua
convaiOutfitApi.setHome('judy-alvarez', true)   -- put this companion in casual home clothes (next time nobody is looking), if the character has them
convaiOutfitApi.setHome('judy-alvarez', false)  -- keep them out of home clothes, even in V's apartment
convaiOutfitApi.setHome('judy-alvarez', nil)    -- follow V's whereabouts again (the default)
convaiOutfitApi.isHome('judy-alvarez')          -- true / false / nil (nil: following the district)
convaiOutfitApi.hasHomeOutfit('Character.Judy') -- does this model record have a home look
```

`key` is a profile key (`judy-alvarez`) or a model record (`Character.Judy`). A call reduces the wait to the next check to one second, so the change is made as soon as
nobody is looking. A copy that is created afterwards under that key starts in the home look. Answers last for the session (a load or a death clears them; fast
travel keeps them). Without a call, "home" means the game's district record for V's apartment: `LittleChina_VApartment`, `Northside_Apartment`,
`JapanTown_Apartment`, `Glen_Apartment`, `CorpoPlaza_Apartment` (the same five `bridge/place-names.mjs` `HOME_PLACES` lists), read at each check only when a party copy
has a home look.

## Cost

Nothing per frame. `init.lua` calls `convaiOutfitTick` from the 10 Hz branch of `onUpdate` (after the 0.1 s gate, with `padTalk` and `voiceActivation`): with the setting
off that is one boolean and the module is not loaded; on, the module subtracts the elapsed time from one counter and returns. Every 20 s it reads the ready copies the
list knows (usually none or two), the game clock (one native read) and, only when a copy wants to change, the world (the battle observer's read) and the copy's view
(`GameInstance.GetCameraSystem():IsInCameraFrustum(npc, 2.0, 0.75)`, the margins the game's own reaction and vehicle code uses for "could be seen"; the camera
direction against the copy is the fallback, and an unreadable view counts as seen). A change is two native calls on one copy and a read-back. No game handle is kept
between checks (a member remembers a serial, a name and numbers). Measured in unit tests: 210 ticks of 0.1 s read the party twice; 800 ticks with the world not ready
or the setting off read nothing.

## Files

`mod/companion-outfits.lua` (decision, check cycle, home, status), `mod/companion-outfits-data.lua` (the curated list), `mod/companions.lua` (`outfitRows`,
`outfitBusy`, `changeAppearance`, the `spawnOutfit` and `outfitCreated` hooks, `outfitStatus` in `activityInputs`), `mod/init.lua` (wiring, the API global),
`mod/manager.lua` and `mod/manager-ui.lua` (the setting `companionOutfits`), `mod/turn-context.lua` and `bridge/turn-context.mjs` (the clothes sentence),
15 locale files, `characters/companion-outfit-evidence.json` and `scripts/Extract-CompanionOutfitEvidence.mjs`.
Tests: `bridge/companion-outfits.test.mjs` (the list against the evidence, the decision, the cycle, the hooks, the wiring), `bridge/turn-context.test.mjs`,
`bridge/manager.test.mjs`, `bridge/settings-file-lua.test.mjs`, `bridge/nsui-labels.test.mjs`.

## Limits

- Fifteen characters. The game's data gives the rest one suitable look; more would need another mod's looks, which are not "their own".
- A copy that wears a look the list does not hold (a world character's copy in the clothes the original wore) is left alone.
- Aaron, Hanako, Voodoo Queen and a few more have variants that only add or remove a detail the character is known by, or whose meshes could not be told apart in the
  `.app` files; they are not in the table.
- Mid-session changes of the setting do not revert anyone.

## Live check owed (game restart for nothing: Lua only, CET reload; bridge restart for the clothes sentence)

Overlay `mod/` and `bridge/` of the branch (never `mod/diagnostics.lua`), CET reload, bridge restart. See the 2026-10-25 captain's log entry in `TODO.md` for the numbered list.
