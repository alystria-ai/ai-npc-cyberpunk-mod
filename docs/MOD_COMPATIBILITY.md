# Mod compatibility: what the mod hooks, what it writes into a save, how to read a failure

Written 2026-10-28 after a player report on 0.3.3 (Mistral text, Pocket and Mistral voices, heavily modded game, game version not given): CTDs within
5 to 10 minutes, other redscript mods that "won't compile" while this mod is enabled, and, after disabling the mod and loading a save made with it, old
intro messages and old phone messages of other mods firing again and Eviction Notice landlords calling although V rents nothing from them.

`bridge/redscript-compat.test.mjs` keeps the facts in this file true (prefixes, the wrapped list below, nothing replaced, nothing saved).

## Short answer

* Nothing in this mod's scripts, Lua or native plugin writes quest, journal, phone, contact, item, money or stat state that another mod reads, except one
  `UntrackEntry` of a tracked game side job when a story pack (off for players for now) starts and takes the tracker. The only
  save writes are described under "What is written into a save", and none of them has a name any other mod uses.
* Nothing in the scripts can break another mod's compile by name: every added field and method carries the `Convai` prefix, every class is `Convai…`, nothing
  is replaced, the wrapped game methods run the original (one exception, below). Combined with other mods' `@replaceMethod` and `@wrapMethod` of the same methods the
  compile succeeds (tested below).
* What does disable every redscript mod is a compile error in ANY script set. The one way this mod's scripts fail a compile on an otherwise working game
  is the **wrong game build**: the 2.31 Scripts on game 2.5 fail with `NO_MATCHING_OVERLOAD` in `GameVariant.reds` (tested below). Six installs on 27 Oct
  paired Scripts and Runtime of different games, so this happens. The game then starts with NO redscript mods, a save made in that state lacks their
  state, and they run their first-time logic again later. That fits both symptom 2 and symptom 3 better than anything the mod writes, but it is a
  hypothesis until the player's `redscript_rCURRENT.log` is read.
* One real conflict exists outside redscript: `archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive` replaces a vanilla quest file (see "Archives").

## What the scripts hook

The scripts add to and wrap game classes. They never use `@replaceMethod`, `@replaceGlobal` or `@wrapGlobal`.

Added fields and methods (all prefixed, none saved):

| On class | Names | Prefix |
|---|---|---|
| `PlayerPuppet` | 171 fields and methods | `m_convai…`, `Convai…`, `OnConvai…` |
| `NPCPuppet` | 26 (face state and helpers) | `m_convai…`, `Convai…` |
| `NewHudPhoneGameController`, `PhoneMessagePopupGameController`, `MessengerDialogViewController`, `MessangerItemRenderer`, `PhoneDialerLogicController`, `PhoneDialerSelectionController`, `PhoneContactItemVirtualController`, `HoloAudioCallLogicController`, `HudPhoneAvatarController`, `ContactData`, `JournalNotificationData` | phone Chat tab, holocall, key handling | `m_convai…`, `convai…`, `Convai…` |
| `AIMoveToCommand`, `AIMoveToCommandHandler` | the companion movement filter | `m_convaiOwned`, `ConvaiMarkOwned`, `ConvaiOwnedMoveUpdate` |
| `QuestTrackerGameController`, `questLogGameController`, `QuestListItemData`, `SimpleQuestListItemController`, `QuestDetailsPanelController`, `QuestDetailsObjectiveController`, `UpdateTrackedObjectiveEvent` | the story packs as real quests (`QuestLog.reds`) | `m_convai…`, `Convai…`, `OnConvai…` |

Script classes declared by the mod: all `Convai…` (`ConvaiFaceService`, `ConvaiManagerPopup`, `ConvaiPhoneChatInput`,
`ConvaiBarkGate`, and so on). Global functions: `ConvaiCallbackSystem`, `ConvaiKeyTarget`, `ConvaiKeyTargetsByAction`, `ConvaiKeyNotifyInEvent`,
`ConvaiServiceContainer`, `ConvaiHasCodeware`, `ConvaiHasCodewareUi`, `ConvaiHasCodewareTextInput`. Files with a `module` line use `module CyberpunkConvai`.
`Face.reds`, `FaceFeature.reds`, `GameVariant.reds` and `Speech.reds` have none (global module); their names are `Convai…` as well.

Wrapped game methods (63). Each wrapper runs `wrappedMethod` (the original and every other mod's wrapper beneath ours), with three kinds of exception listed
below the table: calls skipped only while the mod's own AI chat page is open, calls skipped only for a row of the mod's own quests in the journal screen, and
`NewHudPhoneGameController.SelectOtherTab`, which never runs it.

<!-- wrapped-methods:start -->
```
AIMoveToCommandHandler.UpdateCommand
DialerContactDataView.SortItem
GameObject.PlayVoiceOver
JournalEntryListItemController.OnDataChanged
MessengerDialogViewController.OnDelayedJournalUpdate
MessengerDialogViewController.OnJournalUpdate
MessengerDialogViewController.OnJournalUpdateDelayed
MessengerDialogViewController.UpdateData
NewHudPhoneGameController.AcceptAction
NewHudPhoneGameController.AlternativeAcceptAction
NewHudPhoneGameController.Back
NewHudPhoneGameController.DisableContactsInput
NewHudPhoneGameController.EnableContactsInput
NewHudPhoneGameController.OnAction
NewHudPhoneGameController.OnContactListAction
NewHudPhoneGameController.OnContactListClosed
NewHudPhoneGameController.OnContactSelectionChanged
NewHudPhoneGameController.OnHoloAudioCallSpawned
NewHudPhoneGameController.OnInitialize
NewHudPhoneGameController.OnOpenSmsMessenger
NewHudPhoneGameController.OnPhoneCall
NewHudPhoneGameController.OnSmsMessageLostFocus
NewHudPhoneGameController.OnUninitialize
NewHudPhoneGameController.SelectOtherTab
NewHudPhoneGameController.SetScreenType
PhoneContactItemVirtualController.OnDataChanged
PhoneContactItemVirtualController.OnDeselected
PhoneContactItemVirtualController.OnInitialize
PhoneContactItemVirtualController.OnSelected
PhoneDialerLogicController.RefreshInputHints
PhoneDialerLogicController.ShowTitle
PhoneDialerSelectionController.SetupWidgets
PhoneDialerSelectionController.UpdateHightlight
PhoneMessagePopupGameController.OnAction
PhoneMessagePopupGameController.OnChoiceEntryStateChanged
PhoneMessagePopupGameController.OnDelayedDotsAnimation
PhoneMessagePopupGameController.OnGotFocus
PhoneMessagePopupGameController.OnHandleMenuInput
PhoneMessagePopupGameController.OnUninitialize
PhoneMessagePopupGameController.SetFocus
PhoneMessagePopupGameController.SetupData
PlayerPuppet.OnDetach
PlayerPuppet.OnGameAttached
QuestDetailsObjectiveController.OnRelease
QuestDetailsObjectiveController.OnUpdateTrackedObjectiveEvent
QuestListItemData.GetDistances
QuestListItemData.GetEntryHash
QuestListItemData.GetFirstObjective
QuestListItemData.GetTrackedOrNearest
QuestListItemData.QuestLastUpdateTime
QuestListItemData.SetVisited
QuestListItemData.isVisited
QuestTrackerGameController.OnTrackedMappinSpawned
QuestTrackerGameController.UpdateTrackerData
SimpleQuestListItemController.OnDataChanged
SimpleQuestListItemController.OnPress
SimpleQuestListItemController.OnToggledOn
SimpleQuestListItemController.OnTrackBtnRelease
SimpleQuestListItemController.OnUpdateTrackedObjectiveEvent
questLogGameController.BuildQuestList
questLogGameController.OnQuestListItemSelected
questLogGameController.OnReleaseInput
questLogGameController.OnRequestChangeTrackedObjective
```
<!-- wrapped-methods:end -->

Where the original is skipped (AI chat page open only): `PhoneMessagePopupGameController` `SetupData` (the native one changes journal state, which a
chat with a mod character must not), `OnUninitialize`, `OnGotFocus`, `OnChoiceEntryStateChanged`, `OnDelayedDotsAnimation`, `OnAction` and
`OnHandleMenuInput` (while typing); `MessengerDialogViewController` `OnJournalUpdate`, `OnJournalUpdateDelayed`, `OnDelayedJournalUpdate`, `UpdateData`.
A phone-overhaul mod that wraps the same methods therefore still runs for every vanilla message; it is bypassed only inside the AI chat page.
Always skipped: `NewHudPhoneGameController.SelectOtherTab` (the phone's Tab key). The mod makes it cycle Unread, Contacts and Chat through its own
`ConvaiSelectPhoneTab`, so a phone mod that wraps `SelectOtherTab` beneath ours never runs while this mod is installed. It is the one wrapper that behaves like
a replace; `bridge/redscript-compat.test.mjs` names it so a second one cannot appear unnoticed.
Skipped for the mod's own quests only (the story packs as real quests, `QuestLog.reds`, docs/REAL_QUESTS.md): the journal screen's list rows, details
objective and list data (`SimpleQuestListItemController`, `QuestDetailsObjectiveController`, `QuestListItemData`) run the original for every game quest and
draw a row of the mod's own from its text instead (the original would ask the journal about an entry that does not exist). `OnRequestChangeTrackedObjective`
drops a request that names neither a quest nor an objective (only the mod's rows can send one) and runs the original for every other. `OnReleaseInput` handles
the track key itself only while one of the mod's quests is open in the details panel. `UpdateTrackerData`, `BuildQuestList`, `OnTrackedMappinSpawned` and
`OnQuestListItemSelected` always run the original first. A quest-log or HUD-tracker mod that wraps or replaces these keeps working for the game's quests; one
that replaces `UpdateTrackerData` or `BuildQuestList` and reads its own data hides the mod's quests from the tracker or the list.

Elsewhere: `GameObject.PlayVoiceOver` (declared with the game's own `-> DelayID`, so other mods' wrappers stacked on it compile) returns an empty `DelayID` early for four ambient contexts (`greeting`, `fear_foll`, `stlh_curious_grunt`, `bump`) within 15 m of V
while a mod conversation is open. `AIMoveToCommandHandler.UpdateCommand` runs for every walking NPC each AI tick: one type test and one Bool read.

Other mods that change these classes, in practice: phone UI overhauls (the 39 phone wraps), voice-over and bark mods (`PlayVoiceOver`), AI-movement mods
(`UpdateCommand`). Redscript lets any number of `@wrapMethod` stack and lets one `@replaceMethod` sit beneath them.

### Compile tests run on 2026-10-28

`scripts/Compile-Redscript.ps1` (the game's `scc.exe`, an isolated copy, nothing installed), the project's scripts plus synthetic "other mod" files:

| Test | Result |
|---|---|
| 2.5 build against the 2.5 game | compiles |
| 2.31 build against the 2.31 game (with Dark Future, Flesh and Chrome, Injuries, MCM and the others installed there) | compiles |
| 2.5 build against the 2.31 game | compiles |
| **2.31 build against the 2.5 game** | **fails**: `[NO_MATCHING_OVERLOAD] … GameVariant.reds:20:12`, then `REDScript compilation has failed. - CyberpunkConvai` |
| another mod `@replaceMethod`s `NewHudPhoneGameController.OnInitialize`, `PhoneMessagePopupGameController.SetupData`, `MessengerDialogViewController.UpdateData`, `PlayerPuppet.OnGameAttached`, `GameObject.PlayVoiceOver` (the exact vanilla signatures); its folder sorts before and after ours | compiles both ways |
| another mod `@wrapMethod`s the same five | compiles (those synthetic wrappers returned nothing; see the next row) |
| Much Better Contracts 2.1 and Rebecca NPV for Night City Allies 1.4 (with Night City Allies 1.6.11, Audioware 1.10.1, TweakXL 1.12.0), 2.5 | **failed** before 28 Oct: our `PlayVoiceOver` wrapper declared `-> Void`, theirs `return wrappedMethod(...)` as the game's `DelayID` (`can't coerce 'Void' into 'DelayID'`, SecurityReplay.reds:35 / Greeting.reds:64). Fixed: ours declares the game's own signature and returns the original's value; `GAME_RETURN_TYPES` in the test holds it. Compiles now, and the 2.31 build still compiles |
| two other mods `@replaceMethod` one method we wrap | compiles (the later file silently wins) |

`Compile-Redscript.ps1` was changed for this: it now also puts every other RED4ext plugin's `Scripts` folder (TweakXL, ArchiveXL) on the compile, as the game does;
without them Dark Future failed to compile in the check ("unresolved reference TweakDBManager") although the game compiles it. It also closes the compiler's standard
input: `scc.exe` waited for a key press after an error and hung the script.

## What is written into a save

Default install, default settings: **nothing.** Details:

| What | Where | Written when | Saved? | After the mod is removed |
|---|---|---|---|---|
| Quest fact `cyberpunkconvai_hm_<8 hex digits>` (0 to 5) and `cyberpunkconvai_hm_v1` | `mod/housemate-registry.lua` | only when Settings > Housemates is On (default Off) and V lets someone stay | yes, with the save | inert: no other name matches; nothing reads it |
| Quest fact `cyberpunkconvai_mem_v1_*` | `mod/fact-identity.lua` | never in a player install: development file, loaded only by `diagnostics.lua`, its write gates default off | n/a | n/a |
| Quest facts `dlc6_apart_*_purchased`, `cyberpunkconvai_hm_probe` | `mod/housemate-survey.lua` (`housemate own`, `housemate qualify` commands) | only by a typed developer command in a file that is not packaged | n/a | n/a |
| Persistent fields of a `ScriptableSystem` | `KnowledgeState.reds` | never: in `retiredRedscript`, never in any released Scripts zip (checked against the release builder's first commit, 2026-10-08) | n/a | n/a |
| Entities spawned (companions, copies, cars, holocall actors) | `DynamicEntitySpec` with `persistState=false`, `persistSpawn=false` in every spawn | at runtime | not kept by the save | gone on the next load |
| TweakDB records `CyberpunkConvai.*` (clones) | `mod/companion-records.lua` | every load, in memory | no | gone |

The story packs as real quests (`QuestLog.reds`, only with the development switch of docs/STORY_PACKS_INACTIVE.md) are runtime only as well: a script system
that holds no persistent field, quest map pins registered at runtime (the map keeps none over a load), and the journal screen and HUD tracker drawing the
mod's quests next to the game's. The game's tracked quest is changed in exactly one case (`TrackEntry` is never called): when a pack starts and takes the tracker while a game side job is tracked,
that job is untracked with one `UntrackEntry` on the journal manager (`ConvaiQuestLog.TakeTracker`), so the Journal shows one tracked mark. That is a journal write
the save keeps (the tracked quest). A tracked main job is never untracked, nothing is re-tracked later, and it happens once, never per frame (docs/REAL_QUESTS.md,
owner decision of 31 Oct 2026, guarded by `bridge/redscript-compat.test.mjs`).

Everything else the mod does to the game is runtime only: UI widgets, blackboard values for UI (`HideDialogLine`, `WarningMessage`, `ScannerName`), AI events
on its own copies, stat modifiers on its own copies. Journal, phone and contacts are only READ (`GetEntry`, `GetContactDataArray`, `GetQuests`), with the one `UntrackEntry` above. The Chat tab
adds a `ContactData` row and a `JournalNotificationData` object in memory; no journal entry is created. A holocall never uses `PhoneSystem`, never writes
`questTriggerCallRequest` or a phone blackboard (`Holocall.reds` header). The phone Chat page wraps the messenger so a vanilla message that arrives while it is
open is not marked read by that open page: a UI listener skip, not a journal write.

Two gameplay effects exist that a save does keep: the `call-police` NPC reaction (`mod/npc-reactions.lua`, vanilla `CrimeWitnessRequestToPreventionSystem`) can
raise V's wanted level when an ordinary NPC chooses it in a conversation, and companion tactics set attitudes between its own copies and game NPCs and restore
them (`mod/companion-tactics.lua`). Neither touches quests or phone.

Nothing in the repository mentions or touches Eviction Notice, landlord or rent state.

What can make other mods repeat their first-time logic is a game session with no redscript mods in it (a failed compile, see above), whatever the cause. Turning this
mod off or on changes none of their state.

## Archives (not redscript, but a real conflict)

`archive/pc/mod/` receives three archives in the Runtime package. Compared by path hash against every vanilla archive of the 2.5 game:

* `convai_facial.archive` (13 entries) and `convai_gestures.archive` (58): only new `cyberpunk_convai\…` resources, no vanilla path.
* **`cyberpunk_convai_ambient_driver_guard.archive` (1 entry) replaces the vanilla `base\open_world\passenger\phases\thepassenger.questphase`**
  (`scripts/Build-AmbientJohnnyDriverGuard.py`; one AND node gets a Driver condition). It was built from the **2.31** file and is shipped in BOTH builds. The
  2.5 game's copy of that file is a different file (archive hash `e5d3e6d3…` in 2.5, `acbec4f6…` in 2.31, checked 2026-10-28 in `basegame_4_gamedata.archive`).
  On 2.5 the mod therefore replaces the current quest phase with the older edited one, and any other mod that overrides the same file (a Johnny or passenger
  mod) is overridden or overrides it depending on archive order. This is the largest compatibility risk found outside redscript. The fix is to ship it for the
  2.31 build only (or rebuild it from the 2.5 file); it touches `packaging/release.config.json`, the 2.5 Runtime, the removal list for installs that already
  have the file, and the update zips, so it was not done in this change.

## Native plugin (`red4ext/plugins/AiNpcCyberpunkModNative`)

Read in full on 2026-10-28; no change made.

* No hooks or detours, no pattern scans, no raw addresses. It works through RTTI lookups and `ExecuteFunction`, each guarded; no `Object` or `WeakHandle`
  is stored between calls (caches hold only `CClass*` and `CBaseFunction*`). Natives run on the CET game thread; its own two threads only touch files.
* Registered RTTI names (all unique, all static natives on `IScriptable` subclasses): `ConvaiNative`, `ConvaiNativeActuator`, `ConvaiNativeChauffeur`,
  `ConvaiNativeClearance`, `ConvaiNativeFaces`, `ConvaiNativeGaze`, `ConvaiNativeIo`, `ConvaiNativePassage`, `ConvaiNativeVehicles`.
* The launcher `CyberpunkConvai.dll` is plain C, reads no game memory and hooks nothing; it starts the Node service and ties its lifetime to the game with a pipe.
* Possible, not likely and not fixed here: the RED4ext SDK resolves some addresses lazily and terminates the process with a message box when its database lacks one
  (`CGameEngine::Get`, `Handle(T*)`, `GetProperty`); a failed class registration leaves an empty parentless `ConvaiNative*` class in RTTI (`Rtti.cpp`, the parent is set
  only after the checks); the structured-exception guard (`Rtti.cpp`, `Rtti.hpp`) swallows access violations raised inside OTHER mods' script code that a call
  of ours ran, so a crash that should name that mod can turn into a later random one. Vtable-slot calls (`GetClassByScriptName`, `GetClassFunctions`) depend on the
  pinned SDK matching the exe.
* `ConvaiFaceService` (redscript, needs Codeware) registers callbacks for every `NPCPuppet` spawn (`Entity/Initialize`), for every appearance rebuild
  (`Entity/Reassemble`) and for every entity extraction (`Entity/Extract`, unfiltered). It only changes `face_rig`'s graph, only when it is one of four vanilla
  crowd graphs (or on a character it owns), and only when `ResourceRef.IsLoaded(graph)` is true. A mod that swaps face rigs or facial graphs is the one most
  likely to meet it.

A 5 to 10 minute CTD on a heavy list is at least as likely to be memory or VRAM: the Node service, Local AI, voice workers and the hidden audio browser run beside the game.
Which text and voice provider the player uses (here Mistral and Pocket, so no local LLM) narrows that.

## How to read a redscript failure

The compiler runs at game start. Its log is `<game>\r6\logs\redscript_rCURRENT.log`. One compile error ANYWHERE fails the whole compile: the game then runs with
vanilla scripts, and every redscript mod is off, not only the one with the error.

```
[ERROR - …] [UNRESOLVED_TYPE] At …\r6\scripts\FleshAndChrome\FleshAndChrome_WeaponSway.reds:258:1:
public class FACWeaponModInjector extends ScriptableTweak {
class 'ScriptableTweak' not found
…
[ERROR - …] REDScript compilation has failed.
- CyberpunkConvai
```

* The path after `At` names the mod folder that holds the broken file. The last lines (`- ModName`) list the mod folders that had errors. A folder listed there is
  the one to look at first; a mod can be listed only because it uses something a missing plugin should have provided.
* `UNRESOLVED_TYPE` / `UNRESOLVED_REF` / `UNRESOLVED_METHOD` on a name from Codeware, TweakXL or ArchiveXL (`TweakDBManager`, `ScriptableTweak`, `ScriptableService`,
  `InputTarget`): that plugin's scripts did not reach the compile. Its plugin is missing, the wrong version for the game, or RED4ext did not load at all (then
  every mod that imports a plugin is listed, whoever they are). This looks like "the other mods fail" and is not the fault of a mod in the list.
* `NO_MATCHING_OVERLOAD` at `GameVariant.reds`: this mod's Scripts are for the other game. Install the Scripts for the game that is installed (2.5 is the default
  download; the 2.31 one is the optional file). `mod/setup-check.lua` says the same in game when the CET half loads (`build: problem scripts-wrong`).
* An error whose path is under another mod and names a game class or method: that mod is out of date for the game, or two other mods change the same method
  incompatibly in their own code. Neither a replace beside wraps nor two replaces of one method is a compile error, so such overlaps never show in this log.
* No `CyberpunkConvai` line and no error, yet the mod does nothing: the CET half is fine and the scripts were not found; check `r6\scripts\CyberpunkConvai`.
* This mod compiles without Codeware, Codeware.UI or Codeware.UI.TextInput on purpose (`@if(ModuleExists(…))` with a stand-in for every guarded method,
  `Requirements.reds`), so a missing or older Codeware never fails the compile by this mod's doing; it is reported in game by the setup check instead.

Reproduce a compile offline, against a game folder, without installing anything:
`powershell scripts\Compile-Redscript.ps1 -GameVersion 2.5` or `-GameVersion 2.31 -GameDirectory E:/SteamLibrary/Cyberpunk2077-2.31`. The log path is printed. Run it
with the player's other redscript mods in the game folder's `r6\scripts` to test a combination.

## What to ask a player who reports crashes or "mods won't compile"

1. In game, Settings > Help > Help and support > Generate report, and send the file (it holds the end of the mod, service, CET, redscript and RED4ext logs). If
   the game does not start the service, `runtime\convai-report-lua.txt` in `bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod`.
2. If that is not possible, these files from the Cyberpunk 2077 folder:
   * `r6\logs\redscript_rCURRENT.log` (the compile result; most important)
   * `red4ext\logs\red4ext.log` (which plugins loaded, and any "incompatible with the current patch")
   * `bin\x64\plugins\cyber_engine_tweaks\cyber_engine_tweaks.log` and `…\mods\AiNpcCyberpunkMod\runtime\probe.log`
3. For a crash: the newest folder in `%LOCALAPPDATA%\REDEngine\ErrorReports` (its `callstack.txt` or `reports.log`), and the time of the crash.
4. Two facts: the game version (the exe's file version in Properties > Details: 3.0.88 is 2.5, 3.0.80 is 2.31) and which Scripts zip was installed
   (the 2.5 default, or the file named "for game 2.31").
5. How the mod was disabled when the save problem appeared: only the CET mod folder or also `r6\scripts\CyberpunkConvai`, and whether any redscript error was
   shown at the first start after that.
