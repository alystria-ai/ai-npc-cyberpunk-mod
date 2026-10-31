# Real quests: the story packs in the game's journal, tracker and map

Branch `feat/real-quests`, 31 Oct 2026. Built, compiled for game 2.5 and 2.31, tested offline. Nothing of it has been seen in the game yet: the live check list
is at the end. The story packs stay off for players (docs/STORY_PACKS_INACTIVE.md): this only shows with the development switch.

The owner's live test of 31 Oct: a started pack must show as a real quest. This adds, for every story pack and hangout in progress:

* a **journal entry** in the game's Journal screen (Quests), with the pack's title, its description and the current objective, listed with the side jobs, and
  the finished ones (succeeded or failed) with the finished quests,
* the **objective in the HUD quest tracker** while it is the tracked quest, with the game's own intro, tick-off, success and failure animations,
* the pack becomes the **tracked quest when it starts** (unless the game's tracked quest is a main job),
* a **quest waypoint** on the map, the minimap and in the world at the stage's place, when that place has a position,
* **cleanup** on every way out: an ending, a failure, the story finishing it first, a load, Story packs going off, the play file going away.

## 1. The decision

Three ways were looked at.

**A. A shipped journal archive with placeholder entries, filled by our scripts.** The game's journal is a tree loaded from `.journal` resources. A mod adds to it
with an archive whose `.xl` file names its journal resource (the framework that merges it is a RED4ext plugin this mod does not require today). The quest
mods in the research library that have real journal entries all work this way: the entries, their map pins and their texts are authored once in the archive,
and a script only flips their states (`ChangeEntryState`, track and untrack). Against it for us: a new required framework, a WolvenKit cooked archive per
slot, texts that are localization keys fixed at build time (114 packs and 367 stages of text that comes from data and may come from community packs), and
journal map pins that point at world nodes placed at build time, while our places are data and mostly not measured yet. It also writes quest state into the
save, which this mod never does (docs/MOD_COMPATIBILITY.md, "What is written into a save").

**B. A journal entry made at runtime through the journal system.** Not possible. `JournalManager` only reads entries and changes the state of existing ones.
The shipped scripts do have a family of scripted quest functions (`CreateScriptedQuestFromTemplate`, `DeleteScriptedQuest`, `SetScriptedQuestEntryState`,
`SetScriptedQuestObjectiveDescription`, `SetScriptedQuestMappinData`), but they are empty script stubs that return false, not natives (the decompiled
`core/systems/journalManager.swift`, lines 96 to 120). Codeware exposes the fields of journal classes (`JournalQuest.title`, `JournalContainerEntry.entries`)
but gives no way to register a new entry with the journal manager, and editing the loaded tree behind the manager's back is unverifiable offline and risks a
crash in the save code.

**C. Our own quest log, drawn by the game's own journal screen, tracker and map (chosen).** The quests live in a script system of ours that is never saved,
and the game's UI classes are wrapped so they draw these quests next to the game's. Evidence it fits, from the decompiled scripts:

* `QuestTrackerGameController.UpdateTrackerData` is called only on journal callbacks (state, tracked, counter, optional), on the menu flag and on
  `TrackedQuestPhaseUpdateRequest`. It hides the tracker when no journal objective is tracked, and its objective rows are `QuestTrackerObjectiveLogicController`
  widgets whose `SetData` takes a plain string and a null entry (the tracked map pin line already uses it that way). So a wrapper can fill the tracker with
  our title and objective, with the game's animations, and no new tick.
* `questLogGameController.BuildQuestList` builds the list from `QuestListItemData`, a script class. Our rows are the same class with one added field, so the
  game's list, filters, sorting and selection carry them. The few places that ask the journal about the row's entry are wrapped for our rows only.
* `MappinSystem.RegisterMappin(MappinData, Vector4)` places a pin at a position at runtime, `SetMappinPosition` moves it and `UnregisterMappin` removes it. The
  world map lets V track any pin that has no journal entry (`CanPlayerTrackMappin` is the opposite of `CanQuestTrackMappin`, which needs a journal entry).
* A CET quest engine in the research library draws its quests into the same tracker and journal controllers, which confirms the shape. Nothing was copied.

It needs no new dependency (vanilla classes only: no Codeware, no archive), it works the same on 2.5 and 2.31 (both compile), the text comes from the pack data
as it is, and nothing is written into a save.

The honest limit of C: the **road route** (the GPS line) is drawn by the game only to a tracked journal objective or to a pin V tracks on the world map, and
the map screen's `TrackMappin` is native to that screen. So the waypoint is a quest pin on the map, the minimap and in the world, and V presses Track on it
once in the map for the route. The tracker then shows the quest's name and objective for it.

## 2. How it works

```
bridge/bond-pack-runner.mjs playState()  ->  runtime/quest-play.json  "journal": [rows]      (bridge/quest-journal.mjs builds the rows)
mod/quest-play.lua apply()               ->  mod/quest-journal.lua apply(rows)              (diffs them against what it showed)
mod/quest-journal.lua                    ->  PlayerPuppet.ConvaiQuestLogSet / Remove / Clear (r6/scripts/CyberpunkConvai/QuestLog.reds)
QuestLog.reds ConvaiQuestLog             ->  the tracker, the journal screen and the map pin redraw on one UI event
```

**The journal block** (bridge side, `bridge/quest-journal.mjs`). One row per pack in progress (every stage, the talk only stages too) and per finished pack
(the newest 12), newest first:

```jsonc
{"pack": "panam-sunset-coffee", "kind": "quest", "character": "panam-palmer", "title": "Coffee at the Sunset",
 "description": "Panam has a rare free morning ...", "objective": "Meet Panam at the Sunset Motel",
 "state": "active",            // or "succeeded", "failed"
 "serial": 1, "since": 2592000, // the stage's game clock: the game drops a row stamped later than the loaded save, as it does for a stage
 "endedAt": 2595000,           // finished rows only
 "place": {"id": "sunset", "name": "the Sunset Motel forecourt in Rocky Ridge", "radius": 25, "x": 0, "y": 0, "z": 0, "named": "afterlife"}}
```

* **Texts.** Every shipped pack now has a `description` (the journal text, at most 300 characters) and every stage an `objective` (the tracker line, at most
  80 characters, an instruction like "Meet Panam at the Sunset Motel"). Both are optional in the format and validated (`bridge/bond-packs.mjs`): without them
  the summary and the stage label are used. A finished quest's text gets the ending's own sentence (`memory`) after the description.
* **Outcome.** An ending's optional `outcome` (`succeeded` or `failed`) decides. Without it, an ending that costs bond points or a `stood-up` ending is a
  failure, anything else a success. An ending reached because the story finished the quest first (`unfinishedWhen`) is not shown at all.
* **The place.** The stage's place is its `pin`, else the place it waits for, else the end of a drive, else its cast's spot, else the first place any primitive
  names. Its position is the pack's own (`x, y, z`), else the named place of Night City its name points at (`bridge/named-places-data.mjs`, with positions
  measured in the game through `quest capture:<id>` too), else, on the game side, a position the probe captured for that pack place id
  (`runtime/quest-place-capture.json`). Today 31 of the 281 stage places have a position (14 packs: the Afterlife, Lizzie's Bar, Megabuilding H10, the
  Totentanz, Judy's flat). The others need a capture in the game.
* **Rollback.** The rows are computed from the runner's state, which follows the save (a load of an earlier save rewinds or forgets a pack). So a load can
  never leave a ghost entry: the next play file simply has no row for it.

**The game side.** `mod/quest-journal.lua` is built with the quest modules (only with Character bonds and Story packs on, which needs the development switch).
It is pure (its one native layer is `M.gameWorld`, the four player methods), event driven (it runs only when a play file is applied) and sends a row only when
what the game shows of it changed.

`r6/scripts/CyberpunkConvai/QuestLog.reds`:

| Part | What it does |
|---|---|
| `ConvaiQuestLog` (a `ScriptableSystem`, no persistent field) | the quests, the tracked one, the pins. `Set`, `Remove`, `Clear(forget)`, `TrackByPlayer`, `Untrack`, `Status` |
| `PlayerPuppet.ConvaiQuestLogSet/Remove/Clear/Status` | the calls Lua makes |
| `QuestTrackerGameController` | after the game's own `UpdateTrackerData`: our title and objective when ours is tracked, the game's objectives hidden (not removed) under it. A new objective plays the intro, the old one its tick-off. The ending plays success or failure once. The tracked map pin line names our quest when V tracks its waypoint |
| `questLogGameController`, `SimpleQuestListItemController`, `QuestListItemData`, `QuestDetailsPanelController`, `QuestDetailsObjectiveController` | our rows in the Journal's quest list (side jobs while active, finished afterwards), the details panel (title, description, objective), track and untrack by click, by the track key and by the objective row |

**Tracking, and the main story.** The game's tracked quest is never changed: the scripts never call `TrackEntry` or `UntrackEntry` (the mod's rule that the
journal is only read, guarded by `bridge/redscript-compat.test.mjs`). Instead the tracker shows ours over it:

* a pack that starts takes the tracker, unless the game's tracked quest is a main job (then V can pick the pack in the Journal),
* at a session start or after a load, the newest pack in progress takes the tracker only if no game quest is tracked,
* it lets go when the pack ends, when V tracks a game quest in the Journal, and when the game moves its tracked objective (the story moved on, so the story
  gets the tracker back at once). The game quest stays tracked underneath all along and keeps its route.

**Cleanup.**

| Event | What happens |
|---|---|
| a stage moves on | the objective changes in the tracker and the Journal, the pin moves to the new place or goes |
| an ending (success or failure) | the entry moves to the finished quests, the tracker plays the ending and lets go, the pin goes |
| the story finishes the quest first, a memory reset forgets it, a load rewinds before its start | the row is gone from the play file: the entry and the pin are removed |
| a load or the main menu | the system forgets everything without asking the map (the pins went with the world), and the restore of the new world rebuilds it from the play file |
| Story packs or Character bonds off (Settings, at once) | the entries, the tracker line and the pins are removed, the stages reaped |
| the play file goes away | the same |

**One pin per place.** When the journal marks the stage's place, the `pin` primitive (`mod/quest-places.lua`) adds no second pin of its own.

## 3. FPS and latency

Nothing runs per frame and nothing polls. The bridge builds the rows inside the play file it already writes when the pack state changes. The game side runs
when a play file is applied (a stage change, a session start, a load): a string compare per row, and a call into the scripts only for a row that changed. The
tracker redraws on the game's own journal callbacks plus one UI event when our list changes. The Journal screen adds our rows when it builds its list, which
it does when it opens. No timer, no tick, no new file. A turn gains nothing: the journal block is not part of any prompt.

## 4. Not done, uncertain, decisions for the owner

* **Unverified in the game:** all of it. The likeliest things to need a fix after the live test: the look of the quest pin (`Mappins.QuestStaticMappinDefinition`
  with `DefaultQuestVariant`, a technique seen working in a map mod of the library), the tracker's hidden game objectives coming back after ours lets go, a
  recycled Journal row switching between a game quest and ours, and the details panel's objective row style.
* **The road route** needs V to track the pin on the world map once (section 1).
* **Most places have no position yet** (31 of 281). A capture per place (`quest capture:<placeId>`) gives the waypoint at once, and the positions should then
  be pasted into the packs.
* **Two tracked marks in the Journal** can show when ours took the tracker over a game quest: the game still has its quest tracked underneath. Decision for
  the owner: keep this (no save write, the main story is never touched), or let a starting pack really untrack the game's quest (one journal write the save
  keeps, against the rule of docs/MOD_COMPATIBILITY.md).
* **A setting** to turn off "a starting pack takes the tracker" may come later, as the brief said.
* **Texts are English only**, like all pack text (owner decision 29 Oct). The 367 objectives and 114 descriptions were written from the pack data and checked
  for length and wording. The owner may want to read a few.
* **No toast** ("New quest") is shown: the tracker's intro animation and sound are the signal. The game's own toast needs a journal entry.

## 5. Files

`bridge/quest-journal.mjs` (new), `bridge/bond-pack-runner.mjs` (the `journal` block), `bridge/bond-packs.mjs` (`description`, `objective`, `outcome`),
`characters/bond-packs/*.json` (the texts), `mod/quest-journal.lua` (new), `mod/quest-play.lua` (hands the block over, `settingOff`), `mod/quest-places.lua`
(one pin per place), `mod/init.lua` and `mod/manager-ui.lua` (wiring, the setting change), `r6/scripts/CyberpunkConvai/QuestLog.reds` (new), the manifests
(`scripts/development-files.json`, `packaging/release-plan.json`, `packaging/runtime-layout.mjs`), docs/MOD_COMPATIBILITY.md (the 20 new wrappers).
Tests: `bridge/quest-journal.test.mjs`, `bridge/quest-journal-lua.test.mjs`, and updates to `bridge/quest-wiring-lua.test.mjs` and
`bridge/quest-round2-wiring.test.mjs`.

## 6. Live check list (owner)

Close the game first. Install the branch's files over the 2.5 game as in docs/QUEST_PRIMITIVES.md section 7, plus `mod/quest-journal.lua` (CET mod folder),
`r6/scripts/CyberpunkConvai/QuestLog.reds` (the game recompiles the scripts at start), `bridge/quest-journal.mjs`, `bridge/bond-pack-runner.mjs` and
`bridge/bond-packs.mjs` (the Runtime's `app\bridge\`), and `characters/bond-packs/*.json` (where the shipped packs are). Never copy `mod/diagnostics.lua`.

Switch the packs on for the test: create an empty file `story-packs-dev.flag` in the mod's runtime folder
(`...\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod\runtime\story-packs-dev.flag`), start the game, then in Settings > Companions turn on
Character bonds, Story packs and Immersive invitations, and Developer mode for the probe. Use a save with Panam in the roster, bond 3 or more with her and
`q104_02_av_chase` finished (the pilot, "Coffee at the Sunset"). The probe is `scripts/Send-JohnnyProbe.ps1 quest <action>`.

1. Talk to Panam (in person or a text) until she brings up the coffee. Check the HUD tracker shows **Coffee at the Sunset** with the objective
   **Meet Panam at the Sunset Motel**, with the usual objective intro animation and sound. If a game side job was tracked before, check it is hidden under
   ours. If a main job was tracked, check the main job stays in the tracker.
2. Open the Journal (Quests). Check **Coffee at the Sunset** is in the list with the side jobs, its line reads the objective, and opening it shows the title,
   the description ("Panam has a rare free morning at the Sunset Motel ...") and the objective with the tracked mark.
3. In the Journal, click the objective (or press the track key) to untrack it. Check the tracker goes back to the game's quest (or hides). Track it again.
   Then track a game quest. Check the game quest takes the tracker and ours shows untracked.
4. The waypoint, part one: the Sunset Motel has no position yet, so check there is **no** pin. Drive to the Sunset Motel forecourt, run
   `quest capture:sunset`, then load the last save (or wait for the next stage). Check a yellow quest pin now sits on the forecourt on the map and the minimap,
   and only one.
5. On the world map, select that pin and press Track. Check the road route appears, and the tracker's map pin line reads the quest's name and objective (not
   "custom location").
6. Walk into the forecourt. Check the tracker ticks the objective off and shows **Walk around Rocky Ridge with Panam**, the Journal shows the new objective,
   and the pin goes (the lookout has no position unless you capture `lookout` too, which gives a pin there).
7. Finish the quest (walk off for the quick way, or play it through). Check the tracker plays the success animation once and lets go, the pin is gone, and the
   Journal lists the quest with the finished quests, marked completed, with the ending's sentence after the description. For a failure, start it in a new save
   and never go: after 3 game hours check the failed mark (cold coffee).
8. Save during the quest, load that save. Check the entry, the objective and the pin come back exactly once. Load a save from before the quest started.
   Check the entry, the tracker line and the pin are gone right after the load (the game drops a row stamped later than the save's clock), and that they do
   not come back after the next talk with anyone (the bridge then forgets the quest too).
9. Turn Story packs off in Settings during a stage. Check the tracker line, the Journal entry and the pin go at once. Turn it back on. Check they return.
10. `quest status`. Check its `journal` part lists the pack and its state (`held`), and its `game` line reads `quests=1 tracked=panam-sunset-coffee pins=1` (or `pins=0`
    without a position).
11. FPS and latency: in a crowd, compare the counter with a quest tracked and with Story packs off. Check there is no difference, and the reply time of a
    talk turn is the same.
12. For a pack whose places already have positions (one of the 14 in section 2), check the pin shows without any capture: Viktor's "Roadwork" hangout pins
    the courtyard loop around Megabuilding H10.

If something is wrong, send: a screenshot of the tracker, the Journal and the map, `runtime/quest-play.json`, the `[QuestJournal]` and `Quest play` lines of the
CET log (`...\mods\AiNpcCyberpunkMod\AiNpcCyberpunkMod.log`), the `quest status` output, and `r6/logs/redscript_rCURRENT.log` if the game said the scripts
did not compile.
