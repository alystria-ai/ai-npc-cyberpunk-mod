module CyberpunkConvai

// Real quests for the story packs (docs/REAL_QUESTS.md): a started pack shows as a quest of the game's own journal (its title, its description and the current
// objective), its objective is in the HUD quest tracker when it is the tracked quest, and the stage's place has a quest waypoint on the map and the minimap.
//
// The game cannot add a journal entry at runtime: its journal is a tree loaded from archives, and the scripted quest functions of JournalManager
// (CreateScriptedQuestFromTemplate and the others) are empty in the shipped scripts. So the quests live here, in a script system that is never saved, and the
// game's own journal screen, quest tracker and tracked map pin are taught to show them next to the game's quests. Lua fills the system from the bridge's play
// file (mod/quest-journal.lua): at every change of a stage, at a session start and after a load. The save holds nothing of it, so a load can never leave a
// ghost entry: the bridge state rebuilds the list.
//
// Cost: nothing per frame. The system changes only when Lua calls it. The tracker redraws on the game's own journal events and on one UI event this system
// queues when it changes. The journal screen adds the quests when it builds its list (when it opens, or when an entry changes while it is open).
//
// Tracking: the HUD tracker shows one quest, the game's or one of these. A pack that starts takes the tracker unless the tracked game quest is a main job (the
// main story keeps the tracker, V can still pick the pack in the journal). The journal is otherwise only read (TrackEntry is never called). The one write,
// owner decision 31 Oct 2026: when a pack starts and takes the tracker while a game SIDE job is tracked, that job is really untracked (one UntrackEntry, in
// TakeTracker only, never for a main job, never when V picks a pack by hand), so the journal shows exactly one tracked mark. Nothing is restored later: when
// the pack ends or V tracks something else, that side job stays untracked. The pack lets go of the tracker when it ends, when V tracks a game quest in the
// journal, and when the game moves its tracked objective (the story moved on, so the story gets the tracker back).
//
// The map: the waypoint is a quest pin at the place's position. The game draws the road route only to a pin V tracks on the world map, so V tracks it there
// once for the route (no script can do that for V: the map screen's TrackMappin is the only way in).

public class ConvaiQuestEntry extends IScriptable {
    public let id: String;
    public let title: String;
    public let description: String;
    public let objective: String;
    // 0 active, 1 succeeded, 2 failed.
    public let state: Int32;
    // The game clock (seconds) of the stage or of the ending: the journal sorts by it.
    public let since: Int32;
    public let hasPlace: Bool;
    public let position: Vector4;
    public let hasMappin: Bool;
    public let mappin: NewMappinID;
    public let visited: Bool;
    // A stand-in journal hash for the quest list (negative, so it never meets a game entry's).
    public let hash: Int32;

    public final func IsActive() -> Bool { return this.state == 0; }

    public final func JournalState() -> gameJournalEntryState {
        if this.state == 1 { return gameJournalEntryState.Succeeded; }
        if this.state == 2 { return gameJournalEntryState.Failed; }
        return gameJournalEntryState.Active;
    }

    public final func Timestamp() -> GameTime {
        let seconds: Int32 = Max(this.since, 0);
        let days: Int32 = seconds / 86400;
        let rest: Int32 = seconds - days * 86400;
        let hours: Int32 = rest / 3600;
        rest -= hours * 3600;
        let minutes: Int32 = rest / 60;
        return GameTime.MakeGameTime(days, hours, minutes, rest - minutes * 60);
    }
}

// Queued to every game controller when the quests changed: the tracker and an open journal redraw.
public class ConvaiQuestLogChanged extends Event {}

// Asked by a quest of this system in the journal screen: track it, or untrack it when it is the tracked one.
public class ConvaiQuestTrackToggle extends Event {
    public let id: String;
}

// A quest of this system was picked in the journal's list.
public class ConvaiQuestSelected extends Event {
    public let id: String;
}

public class ConvaiQuestLog extends ScriptableSystem {
    private let m_entries: array<ref<ConvaiQuestEntry>>;
    private let m_tracked: String;
    // The game's tracked objective (its journal hash, 0 for none) as last seen: when it changes to another one while a quest of this system has the tracker,
    // the game's quest moved on and gets the tracker back.
    private let m_gameHash: Int32;
    private let m_nextHash: Int32;
    // The tracked quest that just ended: the tracker plays its success or failure once and then lets it go.
    private let m_closing: ref<ConvaiQuestEntry>;

    public static func Get(game: GameInstance) -> ref<ConvaiQuestLog> {
        return GameInstance.GetScriptableSystemsContainer(game).Get(n"CyberpunkConvai.ConvaiQuestLog") as ConvaiQuestLog;
    }

    private func OnAttach() -> Void {
        this.m_nextHash = -1000;
    }

    // The session ends (a load, the main menu): the pins went with the world. Nothing is asked of the map.
    private func OnDetach() -> Void {
        this.Forget();
    }

    public final func Count() -> Int32 { return ArraySize(this.m_entries); }
    public final func Entries() -> array<ref<ConvaiQuestEntry>> { return this.m_entries; }
    public final func TrackedId() -> String { return this.m_tracked; }

    public final func Find(id: String) -> ref<ConvaiQuestEntry> {
        for entry in this.m_entries {
            if Equals(entry.id, id) { return entry; }
        }
        return null;
    }

    public final func TrackedEntry() -> ref<ConvaiQuestEntry> {
        if StrLen(this.m_tracked) == 0 { return null; }
        let entry: ref<ConvaiQuestEntry> = this.Find(this.m_tracked);
        if !IsDefined(entry) || !entry.IsActive() { return null; }
        return entry;
    }

    public final func EntryForMappin(id: NewMappinID) -> ref<ConvaiQuestEntry> {
        for entry in this.m_entries {
            if entry.hasMappin && entry.mappin.value == id.value { return entry; }
        }
        return null;
    }

    public final func Closing() -> ref<ConvaiQuestEntry> { return this.m_closing; }
    public final func ClosingDone() -> Void { this.m_closing = null; }

    // A quest from the play file, new or changed. track: 0 leave the tracker as it is, 1 track it if nothing is tracked (a session start), 2 take the tracker
    // (a pack that just started; never over a main job).
    public final func Set(id: String, title: String, description: String, objective: String, state: Int32, since: Int32, hasPlace: Bool, position: Vector4,
            track: Int32) -> Bool {
        if StrLen(id) == 0 { return false; }
        let entry: ref<ConvaiQuestEntry> = this.Find(id);
        if !IsDefined(entry) {
            entry = new ConvaiQuestEntry();
            entry.id = id;
            this.m_nextHash -= 1;
            entry.hash = this.m_nextHash;
            ArrayPush(this.m_entries, entry);
        }
        let wasActive: Bool = entry.IsActive();
        entry.title = title;
        entry.description = description;
        entry.objective = objective;
        entry.state = Clamp(state, 0, 2);
        entry.since = since;
        entry.hasPlace = hasPlace;
        entry.position = position;
        this.UpdatePin(entry);
        if !entry.IsActive() {
            if Equals(this.m_tracked, id) {
                if wasActive { this.m_closing = entry; }
                this.m_tracked = "";
            }
        } else {
            if track == 2 { this.TakeTracker(id, true); }
            if track == 1 && StrLen(this.m_tracked) == 0 && !IsDefined(this.Journal().GetTrackedEntry()) { this.TakeTracker(id, false); }
        }
        this.Changed();
        return true;
    }

    public final func Remove(id: String) -> Bool {
        let i: Int32 = 0;
        while i < ArraySize(this.m_entries) {
            if Equals(this.m_entries[i].id, id) {
                this.DropPin(this.m_entries[i], false);
                if IsDefined(this.m_closing) && Equals(this.m_closing.id, id) { this.m_closing = null; }
                ArrayErase(this.m_entries, i);
                if Equals(this.m_tracked, id) { this.m_tracked = ""; }
                this.Changed();
                return true;
            }
            i += 1;
        }
        return false;
    }

    // Everything goes. forget: the world already went (a load), so the pins are dropped without asking the map and no game quest is tracked again.
    public final func Clear(forget: Bool) -> Void {
        if forget {
            this.Forget();
        } else {
            for entry in this.m_entries { this.DropPin(entry, false); }
            ArrayClear(this.m_entries);
            this.m_closing = null;
            this.m_tracked = "";
        }
        this.Changed();
    }

    private final func Forget() -> Void {
        for entry in this.m_entries { this.DropPin(entry, true); }
        ArrayClear(this.m_entries);
        this.m_tracked = "";
        this.m_gameHash = 0;
        this.m_closing = null;
    }

    // V picked one of these quests in the journal: it has the tracker, over any game quest (V chose).
    public final func TrackByPlayer(id: String) -> Void {
        this.TakeTracker(id, false);
        this.Changed();
    }

    // V untracked it in the journal.
    public final func Untrack() -> Void {
        this.m_tracked = "";
        this.Changed();
    }

    // V tracked a game quest in the journal: it has the tracker now.
    public final func GameQuestTracked() -> Void {
        this.m_tracked = "";
    }

    // The tracker's every redraw: the game's tracked objective now (its hash, 0 for none). Another objective than the one seen before, while a quest of this
    // system has the tracker, means the game's quest moved on: the tracker goes back to it. Returns whether this system let go.
    public final func GameTracking(hash: Int32) -> Bool {
        let letGo: Bool = StrLen(this.m_tracked) > 0 && hash != 0 && hash != this.m_gameHash;
        this.m_gameHash = hash;
        if letGo { this.m_tracked = ""; }
        return letGo;
    }

    public final func Status() -> String {
        let pins: Int32 = 0;
        for entry in this.m_entries { if entry.hasMappin { pins += 1; } }
        return "quests=" + IntToString(ArraySize(this.m_entries)) + " tracked=" + this.m_tracked + " pins=" + IntToString(pins)
            + " game=" + IntToString(this.m_gameHash);
    }

    // ---- inside ------------------------------------------------------------------------------------------------------------------------------

    private final func Journal() -> ref<JournalManager> {
        return GameInstance.GetJournalManager(this.GetGameInstance());
    }

    // byItself: a pack that just started, which never takes the tracker from a main job. The game's tracked objective is noted, so a later move of it is seen.
    // When a pack that just started takes the tracker from a game side job, that job is untracked in the journal (once, here, nowhere else) so the journal
    // shows one tracked mark. A main job, or a tracked entry whose quest cannot be told, is left alone. V's own pick of a pack untracks nothing.
    private final func TakeTracker(id: String, byItself: Bool) -> Void {
        let journal: ref<JournalManager> = this.Journal();
        let tracked: wref<JournalEntry> = journal.GetTrackedEntry();
        if IsDefined(tracked) {
            let quest: wref<JournalQuest> = questLogGameController.GetTopQuestEntry(journal, tracked);
            if byItself && IsDefined(quest) && Equals(journal.GetQuestType(quest), gameJournalQuestType.MainQuest) { return; }
            if byItself && IsDefined(quest) {
                journal.UntrackEntry();
                this.m_gameHash = 0;
            } else {
                this.m_gameHash = journal.GetEntryHash(tracked);
            }
        } else {
            this.m_gameHash = 0;
        }
        this.m_tracked = id;
    }

    private final func UpdatePin(entry: ref<ConvaiQuestEntry>) -> Void {
        if !entry.hasPlace || !entry.IsActive() {
            this.DropPin(entry, false);
            return;
        }
        let mappins: ref<MappinSystem> = GameInstance.GetMappinSystem(this.GetGameInstance());
        if !IsDefined(mappins) { return; }
        if entry.hasMappin {
            mappins.SetMappinPosition(entry.mappin, entry.position);
            return;
        }
        let data: MappinData;
        data.mappinType = t"Mappins.QuestStaticMappinDefinition";
        data.variant = gamedataMappinVariant.DefaultQuestVariant;
        data.active = true;
        data.visibleThroughWalls = true;
        entry.mappin = mappins.RegisterMappin(data, entry.position);
        entry.hasMappin = true;
    }

    private final func DropPin(entry: ref<ConvaiQuestEntry>, forget: Bool) -> Void {
        if !entry.hasMappin { return; }
        entry.hasMappin = false;
        if forget { return; }
        let mappins: ref<MappinSystem> = GameInstance.GetMappinSystem(this.GetGameInstance());
        if IsDefined(mappins) { mappins.UnregisterMappin(entry.mappin); }
    }

    private final func Changed() -> Void {
        let ui: ref<UISystem> = GameInstance.GetUISystem(this.GetGameInstance());
        if IsDefined(ui) { ui.QueueEvent(new ConvaiQuestLogChanged()); }
    }
}

// ---- the calls Lua makes (mod/quest-journal.lua) -------------------------------------------------------------------------------------------------

@addMethod(PlayerPuppet)
public final func ConvaiQuestLogSet(id: String, title: String, description: String, objective: String, state: Int32, since: Int32, hasPlace: Bool,
        x: Float, y: Float, z: Float, track: Int32) -> Bool {
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.GetGame());
    if !IsDefined(log) { return false; }
    return log.Set(id, title, description, objective, state, since, hasPlace, new Vector4(x, y, z, 1.0), track);
}

@addMethod(PlayerPuppet)
public final func ConvaiQuestLogRemove(id: String) -> Bool {
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.GetGame());
    return IsDefined(log) && log.Remove(id);
}

@addMethod(PlayerPuppet)
public final func ConvaiQuestLogClear(forget: Bool) -> Bool {
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.GetGame());
    if !IsDefined(log) { return false; }
    log.Clear(forget);
    return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiQuestLogStatus() -> String {
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.GetGame());
    if !IsDefined(log) { return "unavailable"; }
    return log.Status();
}

// ---- the HUD quest tracker -----------------------------------------------------------------------------------------------------------------------

@addField(QuestTrackerGameController)
private let m_convaiObjective: wref<inkWidget>;

@addField(QuestTrackerGameController)
private let m_convaiShown: String;

@addField(QuestTrackerGameController)
private let m_convaiObjectiveText: String;

@addField(QuestTrackerGameController)
private let m_convaiClosing: Bool;

// Objectives of this system that are being ticked off (they hide and leave by themselves when the animation ends).
@addField(QuestTrackerGameController)
private let m_convaiLeaving: array<wref<inkWidget>>;

// The game fills the tracker from its tracked journal objective (and hides it when there is none). Afterwards the tracked quest of this system, when there is
// one, takes the tracker: its title, its objective, and the game's objectives hidden underneath.
@wrapMethod(QuestTrackerGameController)
private final func UpdateTrackerData() -> Void {
    wrappedMethod();
    this.ConvaiUpdateTracker();
}

@addMethod(QuestTrackerGameController)
protected cb func OnConvaiQuestLogChanged(evt: ref<ConvaiQuestLogChanged>) -> Bool {
    this.UpdateTrackerData();
    return false;
}

// Whether a widget is still a child of the objective list (the game's own pass may have emptied it when its quest changed).
@addMethod(QuestTrackerGameController)
private final func ConvaiInList(widget: wref<inkWidget>) -> Bool {
    if !IsDefined(widget) { return false; }
    let i: Int32 = 0;
    while i < inkCompoundRef.GetNumChildren(this.m_ObjectiveContainer) {
        if inkCompoundRef.GetWidgetByIndex(this.m_ObjectiveContainer, i) == widget { return true; }
        i += 1;
    }
    return false;
}

@addMethod(QuestTrackerGameController)
private final func ConvaiOurs(widget: wref<inkWidget>) -> Bool {
    if widget == this.m_convaiObjective { return true; }
    for leaving in this.m_convaiLeaving { if leaving == widget { return true; } }
    return false;
}

@addMethod(QuestTrackerGameController)
private final func ConvaiForgetObjective() -> Void {
    if IsDefined(this.m_convaiObjective) {
        inkCompoundRef.RemoveChild(this.m_ObjectiveContainer, this.m_convaiObjective);
    }
    for leaving in this.m_convaiLeaving {
        if this.ConvaiInList(leaving) { inkCompoundRef.RemoveChild(this.m_ObjectiveContainer, leaving); }
    }
    ArrayClear(this.m_convaiLeaving);
    this.m_convaiObjective = null;
    this.ConvaiGameObjectivesVisible(true);
    this.m_convaiShown = "";
    this.m_convaiObjectiveText = "";
    this.m_convaiClosing = false;
}

// The game's objectives under a quest of this system: hidden while it has the tracker, never removed (the game's own pass keeps updating them, no intro
// animation or sound plays again), shown again when it lets go.
@addMethod(QuestTrackerGameController)
private final func ConvaiGameObjectivesVisible(visible: Bool) -> Void {
    let i: Int32 = 0;
    let widget: wref<inkWidget>;
    let controller: wref<QuestTrackerObjectiveLogicController>;
    while i < inkCompoundRef.GetNumChildren(this.m_ObjectiveContainer) {
        widget = inkCompoundRef.GetWidgetByIndex(this.m_ObjectiveContainer, i);
        if IsDefined(widget) && !this.ConvaiOurs(widget) {
            controller = widget.GetController() as QuestTrackerObjectiveLogicController;
            if !visible || !IsDefined(controller) || !controller.IsReadyToRemove() { widget.SetVisible(visible); }
        }
        i += 1;
    }
}

@addMethod(QuestTrackerGameController)
private final func ConvaiShowFrame(title: String) -> Void {
    inkWidgetRef.SetVisible(this.m_questTrackerContainer, true);
    inkTextRef.SetText(this.m_QuestTitle, title);
    inkWidgetRef.SetState(this.m_QuestTitle, n"Quest");
    this.ConvaiGameObjectivesVisible(false);
}

@addMethod(QuestTrackerGameController)
private final func ConvaiUpdateTracker() -> Void {
    if !IsDefined(this.m_player) || !IsDefined(this.m_journalManager) { return; }
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.m_player.GetGame());
    if !IsDefined(log) { return; }
    let tracked: wref<JournalEntry> = this.m_journalManager.GetTrackedEntry();
    log.GameTracking(IsDefined(tracked) ? this.m_journalManager.GetEntryHash(tracked) : 0);
    let controller: wref<QuestTrackerObjectiveLogicController>;
    let entry: ref<ConvaiQuestEntry> = log.TrackedEntry();
    // The game's own pass may have emptied the list (its tracked quest changed): what of ours is gone is forgotten.
    if !this.ConvaiInList(this.m_convaiObjective) { this.m_convaiObjective = null; }
    if !IsDefined(entry) {
        // Nothing of this system has the tracker. The game's quest, if one is tracked, was drawn by its own pass. A quest of this system that just ended plays
        // its success or failure first, then the tracker lets it go and the game's objectives come back into view.
        // The tracked quest just ended: its objective plays the success or failure animation, then the tracker lets it go.
        let closing: ref<ConvaiQuestEntry> = log.Closing();
        if IsDefined(closing) && Equals(closing.id, this.m_convaiShown) && IsDefined(this.m_convaiObjective) {
            controller = this.m_convaiObjective.GetController() as QuestTrackerObjectiveLogicController;
            if IsDefined(controller) && !controller.IsReadyToRemove() {
                this.ConvaiShowFrame(closing.title);
                if !this.m_convaiClosing {
                    this.m_convaiClosing = true;
                    if closing.state == 2 { controller.SetFailed(); } else { controller.SetFinished(); }
                }
                return;
            }
            log.ClosingDone();
        }
        this.ConvaiForgetObjective();
        return;
    }
    if NotEquals(this.m_convaiShown, entry.id) {
        if IsDefined(this.m_convaiObjective) { inkCompoundRef.RemoveChild(this.m_ObjectiveContainer, this.m_convaiObjective); }
        this.m_convaiObjective = null;
        this.m_convaiObjectiveText = "";
        this.m_convaiClosing = false;
    }
    this.m_convaiShown = entry.id;
    this.ConvaiShowFrame(entry.title);
    if !IsDefined(this.m_convaiObjective) || NotEquals(this.m_convaiObjectiveText, entry.objective) {
        if IsDefined(this.m_convaiObjective) {
            // The stage moved on: the old objective is ticked off and hides itself.
            controller = this.m_convaiObjective.GetController() as QuestTrackerObjectiveLogicController;
            if IsDefined(controller) { controller.SetFinished(); ArrayPush(this.m_convaiLeaving, this.m_convaiObjective); }
        }
        let widget: wref<inkWidget> = this.SpawnFromLocal(inkWidgetRef.Get(this.m_ObjectiveContainer), n"Objective");
        if !IsDefined(widget) { return; }
        controller = widget.GetController() as QuestTrackerObjectiveLogicController;
        if IsDefined(controller) {
            controller.SetData(entry.objective, true, false, 0, 0, null, true);
            controller.PlayIntroAnim();
            this.PlaySound(n"MapPin", n"OnCreate");
        }
        this.m_convaiObjective = widget;
        this.m_convaiObjectiveText = entry.objective;
    }
    // Objectives of ours that played their tick-off animation leave.
    let keep: array<wref<inkWidget>>;
    for leaving in this.m_convaiLeaving {
        if this.ConvaiInList(leaving) {
            controller = leaving.GetController() as QuestTrackerObjectiveLogicController;
            if IsDefined(controller) && controller.IsReadyToRemove() { inkCompoundRef.RemoveChild(this.m_ObjectiveContainer, leaving); } else { ArrayPush(keep, leaving); }
        }
    }
    this.m_convaiLeaving = keep;
}

// V tracked the waypoint of one of these quests on the world map: the tracked pin line names the quest and its objective, not the kind of pin.
@wrapMethod(QuestTrackerGameController)
protected cb func OnTrackedMappinSpawned(newItem: ref<inkWidget>, userData: ref<IScriptable>) -> Bool {
    let result: Bool = wrappedMethod(newItem, userData);
    if !IsDefined(this.m_currentMappin) || !IsDefined(this.m_player) { return result; }
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.m_player.GetGame());
    let entry: ref<ConvaiQuestEntry> = IsDefined(log) ? log.EntryForMappin(this.m_currentMappin.GetNewMappinID()) : null;
    if !IsDefined(entry) { return result; }
    inkTextRef.SetText(this.m_TrackedMappinTitle, entry.title);
    let controller: ref<QuestTrackerObjectiveLogicController> = newItem.GetController() as QuestTrackerObjectiveLogicController;
    if IsDefined(controller) { controller.SetData(entry.objective, true, false, 0, 0, null, true); controller.SetState(n"world"); }
    return result;
}

// ---- the journal screen --------------------------------------------------------------------------------------------------------------------------

@addField(QuestListItemData)
public let m_convaiEntry: ref<ConvaiQuestEntry>;

@addField(QuestListItemData)
public let m_convaiDistance: Float;

@addField(UpdateTrackedObjectiveEvent)
public let m_convaiTracked: String;

@addField(questLogGameController)
private let m_convaiOpened: ref<ConvaiQuestEntry>;

// The list the game built, plus these quests: the active ones with the side jobs, the finished ones with the finished.
@wrapMethod(questLogGameController)
private final func BuildQuestList() -> Void {
    wrappedMethod();
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.m_game);
    if !IsDefined(log) || log.Count() == 0 { return; }
    let player: ref<GameObject> = this.GetPlayerControlledObject();
    let here: Vector4 = IsDefined(player) ? player.GetWorldPosition() : new Vector4(0.0, 0.0, 0.0, 1.0);
    let tracked: String = log.TrackedId();
    for entry in log.Entries() {
        let data: ref<QuestListItemData> = new QuestListItemData();
        data.m_questType = entry.IsActive() ? QuestListItemType.SideQuest : QuestListItemType.Finished;
        data.m_journalManager = this.m_journalManager;
        data.m_playerLevel = this.m_playerLevel;
        data.m_recommendedLevel = this.m_playerLevel;
        data.m_State = entry.JournalState();
        data.m_lastUpdateTimestamp = entry.Timestamp();
        data.m_isTrackedQuest = Equals(entry.id, tracked);
        data.m_convaiEntry = entry;
        data.m_convaiDistance = entry.IsActive() && entry.hasPlace && IsDefined(player) ? Vector4.Distance(here, entry.position) : 0.0;
        data.m_distance = data.m_convaiDistance;
        ArrayPush(this.m_listData, data);
        ArrayPush(this.m_questTypeList, data.m_questType);
    }
    let list: array<ref<IScriptable>>;
    for item in this.m_listData { ArrayPush(list, item); }
    this.m_virtualListController.SetData(list);
}

@addMethod(questLogGameController)
protected cb func OnConvaiQuestLogChanged(evt: ref<ConvaiQuestLogChanged>) -> Bool {
    this.OnJournalReady(0u, n"None", JournalNotifyOption.Notify, JournalChangeType.Undefined);
    return false;
}

@addMethod(questLogGameController)
protected cb func OnConvaiQuestSelected(evt: ref<ConvaiQuestSelected>) -> Bool {
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.m_game);
    let entry: ref<ConvaiQuestEntry> = IsDefined(log) ? log.Find(evt.id) : null;
    if !IsDefined(entry) { return false; }
    entry.visited = true;
    this.m_convaiOpened = entry;
    // The game's own selection is let go, so picking a game quest afterwards shows it again.
    this.m_curreentQuest = null;
    this.m_questData = null;
    this.m_appliedQuestData = null;
    this.m_detailsPanelCtrl.ConvaiShow(entry, Equals(entry.id, log.TrackedId()));
    if this.m_entryAnimProxy.IsPlaying() { this.m_entryAnimProxy.Stop(); }
    this.m_entryAnimProxy = this.PlayLibraryAnimation(n"entry_fade_in");
    this.ConvaiTrackHint(entry, log);
    return true;
}

@addMethod(questLogGameController)
protected cb func OnConvaiQuestTrackToggle(evt: ref<ConvaiQuestTrackToggle>) -> Bool {
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.m_game);
    let entry: ref<ConvaiQuestEntry> = IsDefined(log) ? log.Find(evt.id) : null;
    if !IsDefined(entry) || !entry.IsActive() { return false; }
    if Equals(log.TrackedId(), entry.id) { log.Untrack(); } else { log.TrackByPlayer(entry.id); }
    this.m_trackedQuest = null;
    for data in this.m_listData {
        data.m_isTrackedQuest = IsDefined(data.m_convaiEntry) && Equals(data.m_convaiEntry.id, log.TrackedId());
    }
    let update: ref<UpdateTrackedObjectiveEvent> = new UpdateTrackedObjectiveEvent();
    update.m_convaiTracked = log.TrackedId();
    this.QueueEvent(update);
    this.PlaySound(n"MapPin", n"OnCreate");
    this.PlayRumble(RumbleStrength.SuperLight, RumbleType.Fast, RumblePosition.Right);
    if IsDefined(this.m_convaiOpened) { this.ConvaiTrackHint(this.m_convaiOpened, log); }
    return true;
}

@addMethod(questLogGameController)
private final func ConvaiTrackHint(entry: ref<ConvaiQuestEntry>, log: ref<ConvaiQuestLog>) -> Void {
    if !entry.IsActive() { return; }
    this.m_buttonHintsController.AddButtonHint(n"track", GetLocalizedText(Equals(entry.id, log.TrackedId()) ? "UI-Quests-Untrack" : "UI-UserActions-TrackQuest"));
}

// A game quest picked in the list: the quest of this system shown before is let go.
@wrapMethod(questLogGameController)
protected cb func OnQuestListItemSelected(e: ref<QuestlListItemSelected>) -> Bool {
    this.m_convaiOpened = null;
    return wrappedMethod(e);
}

// A track request that names neither a quest nor an objective would track nothing (or untrack the game's quest): one of these quests sent it. Dropped.
// A game quest tracked from the journal takes the tracker from these quests at once, so the list marks are right.
@wrapMethod(questLogGameController)
protected cb func OnRequestChangeTrackedObjective(e: ref<RequestChangeTrackedObjective>) -> Bool {
    if !IsDefined(e.m_quest) && !IsDefined(e.m_objective) { return true; }
    let log: ref<ConvaiQuestLog> = ConvaiQuestLog.Get(this.m_game);
    if IsDefined(log) { log.GameQuestTracked(); }
    for data in this.m_listData {
        if IsDefined(data.m_convaiEntry) { data.m_isTrackedQuest = false; }
    }
    return wrappedMethod(e);
}

// The track key while one of these quests is open in the details panel.
@wrapMethod(questLogGameController)
protected cb func OnReleaseInput(e: ref<inkPointerEvent>) -> Bool {
    if e.IsAction(n"track") && IsDefined(this.m_convaiOpened) && !IsDefined(this.m_curreentQuest) && !e.IsHandled() && !this.m_listPanelHoverd {
        let toggle: ref<ConvaiQuestTrackToggle> = new ConvaiQuestTrackToggle();
        toggle.id = this.m_convaiOpened.id;
        this.QueueEvent(toggle);
        return true;
    }
    return wrappedMethod(e);
}

// ---- the list rows -------------------------------------------------------------------------------------------------------------------------------

@wrapMethod(QuestListItemData)
public final func GetFirstObjective() -> wref<JournalQuestObjective> {
    if IsDefined(this.m_convaiEntry) { return null; }
    return wrappedMethod();
}

@wrapMethod(QuestListItemData)
public final func isVisited() -> Bool {
    if IsDefined(this.m_convaiEntry) { return this.m_convaiEntry.visited; }
    return wrappedMethod();
}

@wrapMethod(QuestListItemData)
public final func SetVisited() -> Void {
    if IsDefined(this.m_convaiEntry) { this.m_convaiEntry.visited = true; return; }
    wrappedMethod();
}

@wrapMethod(QuestListItemData)
public final func GetDistances() -> array<ref<QuestListDistanceData>> {
    if IsDefined(this.m_convaiEntry) {
        let distances: array<ref<QuestListDistanceData>>;
        if this.m_convaiDistance > 0.0 {
            let distance: ref<QuestListDistanceData> = new QuestListDistanceData();
            distance.m_distance = this.m_convaiDistance;
            ArrayPush(distances, distance);
        }
        return distances;
    }
    return wrappedMethod();
}

@wrapMethod(QuestListItemData)
public final func QuestLastUpdateTime() -> Void {
    if IsDefined(this.m_convaiEntry) { return; }
    wrappedMethod();
}

@wrapMethod(QuestListItemData)
public final func GetEntryHash() -> Int32 {
    if IsDefined(this.m_convaiEntry) { return this.m_convaiEntry.hash; }
    return wrappedMethod();
}

@wrapMethod(QuestListItemData)
public final func GetTrackedOrNearest() -> ref<QuestListDistanceData> {
    if IsDefined(this.m_convaiEntry) { return this.GetNearestDistance(); }
    return wrappedMethod();
}

@addMethod(SimpleQuestListItemController)
private final func ConvaiEntry() -> ref<ConvaiQuestEntry> {
    return IsDefined(this.m_data) ? this.m_data.m_convaiEntry : null;
}

// A row of this system: drawn like a game quest's, from the system's text (the game's draw asks the journal about an entry these quests do not have).
@wrapMethod(SimpleQuestListItemController)
protected cb func OnDataChanged(value: Variant) -> Bool {
    let data: ref<QuestListItemData> = FromVariant<ref<IScriptable>>(value) as QuestListItemData;
    if !IsDefined(data) || !IsDefined(data.m_convaiEntry) { return wrappedMethod(value); }
    let entry: ref<ConvaiQuestEntry> = data.m_convaiEntry;
    this.m_data = data;
    if this.m_data.m_isTrackedQuest && !this.m_tracked {
        this.m_tracked = true;
        this.PlayDistanceMarkerAnimation(this.m_distanceAnim_toTracked, true);
        this.PlayToggleIconAnimation(true, true);
    } else {
        if !this.m_data.m_isTrackedQuest && this.m_tracked {
            this.m_tracked = false;
            this.PlayDistanceMarkerAnimation(this.m_hovered ? this.m_distanceAnim_toHover : this.m_distanceAnim_toDefault, true);
            this.PlayToggleIconAnimation(false, true);
        }
    }
    let questType: CName = QuestTypeIconUtils.GetIconState(this.m_data.m_questType);
    inkTextRef.SetText(this.m_title, entry.title);
    if entry.IsActive() {
        inkTextRef.SetText(this.m_description, entry.objective);
        inkWidgetRef.SetVisible(this.m_description, StrLen(entry.objective) > 0);
    } else {
        inkWidgetRef.SetVisible(this.m_description, true);
        inkTextRef.SetText(this.m_description, entry.state == 1 ? "LocKey#27564" : "LocKey#27566");
    }
    inkWidgetRef.SetVisible(this.m_ep1Icon, false);
    inkImageRef.SetTexturePart(this.m_typeIcon, QuestTypeIconUtils.GetIcon(this.m_data.m_questType));
    inkWidgetRef.SetState(this.m_typeIcon, questType);
    inkWidgetRef.SetState(this.m_questItemBg, questType);
    inkWidgetRef.SetState(this.m_hoverIndicator, questType);
    inkWidgetRef.SetState(this.m_questItemFrame, questType);
    inkWidgetRef.SetVisible(this.m_difficultIcon, false);
    this.UpdateState();
    this.UpdateFixerData();
    this.UpdateDistancesText();
    return true;
}

@wrapMethod(SimpleQuestListItemController)
protected cb func OnToggledOn(itemController: wref<inkVirtualCompoundItemController>) -> Bool {
    let entry: ref<ConvaiQuestEntry> = this.ConvaiEntry();
    if !IsDefined(entry) { return wrappedMethod(itemController); }
    if !this.m_toggled {
        this.m_toggled = true;
        let evt: ref<ConvaiQuestSelected> = new ConvaiQuestSelected();
        evt.id = entry.id;
        this.QueueEvent(evt);
        if this.m_hovered { this.PlaySound(n"Button", n"OnPress"); }
        this.UpdateState();
    }
    return true;
}

@wrapMethod(SimpleQuestListItemController)
protected cb func OnTrackBtnRelease(e: ref<inkPointerEvent>) -> Bool {
    let entry: ref<ConvaiQuestEntry> = this.ConvaiEntry();
    if !IsDefined(entry) { return wrappedMethod(e); }
    if entry.IsActive() && (e.IsAction(n"track") || e.IsAction(n"click") || e.IsAction(n"tap")) {
        let toggle: ref<ConvaiQuestTrackToggle> = new ConvaiQuestTrackToggle();
        toggle.id = entry.id;
        this.QueueEvent(toggle);
    }
    return true;
}

@wrapMethod(SimpleQuestListItemController)
protected cb func OnPress(e: ref<inkPointerEvent>) -> Bool {
    let entry: ref<ConvaiQuestEntry> = this.ConvaiEntry();
    if !IsDefined(entry) { return wrappedMethod(e); }
    if (e.IsAction(n"click") || e.IsAction(n"tap") || e.IsAction(n"track")) && e.GetTarget() == this.m_rootWidget && entry.IsActive() {
        if this.m_toggled && !this.m_tracked || e.IsAction(n"track") {
            let toggle: ref<ConvaiQuestTrackToggle> = new ConvaiQuestTrackToggle();
            toggle.id = entry.id;
            this.QueueEvent(toggle);
            e.Consume();
            e.Handle();
        }
    }
    return true;
}

@wrapMethod(SimpleQuestListItemController)
protected cb func OnUpdateTrackedObjectiveEvent(e: ref<UpdateTrackedObjectiveEvent>) -> Bool {
    let entry: ref<ConvaiQuestEntry> = this.ConvaiEntry();
    if !IsDefined(entry) { return wrappedMethod(e); }
    let tracked: Bool = Equals(e.m_convaiTracked, entry.id);
    if tracked && !this.m_tracked {
        this.m_tracked = true;
        this.PlayDistanceMarkerAnimation(this.m_distanceAnim_toTracked);
        this.PlayToggleIconAnimation(true);
    } else {
        if !tracked && this.m_tracked {
            this.m_tracked = false;
            this.PlayDistanceMarkerAnimation(this.m_hovered ? this.m_distanceAnim_toHover : this.m_distanceAnim_toDefault, true);
            this.PlayToggleIconAnimation(false);
        }
    }
    this.UpdateState();
    return true;
}

// ---- the details panel ---------------------------------------------------------------------------------------------------------------------------

@addMethod(QuestDetailsPanelController)
public final func ConvaiShow(entry: ref<ConvaiQuestEntry>, tracked: Bool) -> Void {
    // The game's quest shown before is let go, so it is drawn again when it is picked again.
    this.m_currentQuestData = null;
    this.m_scrollContainerCtrl.SetScrollPosition(0.00);
    inkWidgetRef.SetVisible(this.m_noSelectedQuestContainer, false);
    inkWidgetRef.SetVisible(this.m_contentContainer, true);
    inkTextRef.SetText(this.m_questTitle, entry.title);
    inkTextRef.SetText(this.m_questLevel, "");
    inkWidgetRef.SetVisible(this.m_ep1Marker, false);
    inkTextRef.SetText(this.m_questDescription, entry.description);
    inkCompoundRef.RemoveAllChildren(this.m_activeObjectives);
    inkCompoundRef.RemoveAllChildren(this.m_optionalObjectives);
    inkCompoundRef.RemoveAllChildren(this.m_codexLinksContainer);
    inkCompoundRef.RemoveAllChildren(this.m_missionLinksContainer);
    inkCompoundRef.RemoveAllChildren(this.m_fluffLinksContainer);
    inkCompoundRef.RemoveAllChildren(this.m_mapLinksContainer);
    inkWidgetRef.SetVisible(this.m_fluffShardLinkLine, false);
    inkWidgetRef.SetVisible(this.m_codexLinkLine, false);
    inkWidgetRef.SetVisible(this.m_missionLinkLine, false);
    this.m_objectiveActionsCount = 0;
    if StrLen(entry.objective) == 0 { return; }
    let widget: wref<inkWidget> = this.SpawnFromLocal(inkWidgetRef.Get(this.m_activeObjectives), n"questObjective");
    if !IsDefined(widget) { return; }
    widget.SetHAlign(inkEHorizontalAlign.Left);
    widget.SetVAlign(inkEVerticalAlign.Top);
    let controller: ref<QuestDetailsObjectiveController> = widget.GetController() as QuestDetailsObjectiveController;
    if IsDefined(controller) { controller.ConvaiSetup(entry, tracked && entry.IsActive()); }
}

@addField(QuestDetailsObjectiveController)
private let m_convaiId: String;

@addMethod(QuestDetailsObjectiveController)
public final func ConvaiSetup(entry: ref<ConvaiQuestEntry>, tracked: Bool) -> Void {
    this.m_objective = null;
    this.m_convaiId = entry.IsActive() ? entry.id : "";
    inkTextRef.SetText(this.m_objectiveName, entry.objective);
    this.m_isTracked = tracked;
    inkWidgetRef.SetState(this.m_trackingMarker, tracked ? n"Tracked" : n"Default");
    this.m_hovered = false;
    this.UpdateState();
}

@wrapMethod(QuestDetailsObjectiveController)
protected cb func OnUpdateTrackedObjectiveEvent(e: ref<UpdateTrackedObjectiveEvent>) -> Bool {
    if StrLen(this.m_convaiId) == 0 { return wrappedMethod(e); }
    this.m_isTracked = Equals(e.m_convaiTracked, this.m_convaiId);
    inkWidgetRef.SetState(this.m_trackingMarker, this.m_isTracked ? n"Tracked" : n"Default");
    return true;
}

@wrapMethod(QuestDetailsObjectiveController)
protected cb func OnRelease(e: ref<inkPointerEvent>) -> Bool {
    if StrLen(this.m_convaiId) == 0 { return wrappedMethod(e); }
    if e.IsAction(n"click") || e.IsAction(n"tap") || e.IsAction(n"track") {
        let toggle: ref<ConvaiQuestTrackToggle> = new ConvaiQuestTrackToggle();
        toggle.id = this.m_convaiId;
        e.Handle();
        this.QueueEvent(toggle);
    }
    return true;
}
