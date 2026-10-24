module CyberpunkConvai

// Save-bound identity only. No vanilla quest facts, save files, NPCs, or provider
// memory are changed here. See research/cyberpunk/SAVE_IDENTITY.md for evidence
// and the qualification boundary. Loading this file does not seed an identity.
public class ConvaiKnowledgeSnapshot {
    public let version: Int32 = 1;
    public let ready: Bool;
    public let restored: Bool;
    public let resolved: Bool;
    public let generation: Int32;
    public let revision: Int32;
    public let activationId: String;
    public let faulted: Bool;
    public let saving: Bool;
    public let schema: Int32;
    public let campaign: array<Int32>;
    public let branch: array<Int32>;
    public let branchEpoch: Int32;
    public let ledgerSequence: Int32;
    public let checkpointSequence: Int32;
    public let checkpointBranch: array<Int32>;
    public let checkpointBranchEpoch: Int32;
    public let checkpointLedgerSequence: Int32;
    public let restoredBranch: array<Int32>;
    public let restoredBranchEpoch: Int32;
    public let restoredLedgerSequence: Int32;
    public let restoredCheckpointSequence: Int32;
    public let restoredCheckpointValid: Bool;
    // This is an engine serialization callback receipt, NOT disk success.
    public let serializationCompleted: Int32;
}

// The save-bound state needs Codeware's session callbacks and services. Without Codeware the two classes below do not exist (so
// the scripts still compile: a compile error would disable every redscript mod) and Lua finds no knowledge state, which it
// already treats as "not available" (mod/knowledge-state.lua). mod/setup-check.lua tells the player Codeware is missing.
@if(ModuleExists("Codeware"))
public class ConvaiKnowledgeState extends ScriptableSystem {
    // Do not change persisted field types after shipping. Strings are not
    // persistable: an opaque 128-bit ID is eight unsigned 16-bit Int32 limbs.
    private persistent let m_schema: Int32;
    private persistent let m_campaign: array<Int32>;
    private persistent let m_branch: array<Int32>;
    private persistent let m_branchEpoch: Int32;
    private persistent let m_ledgerSequence: Int32;
    private persistent let m_checkpointSequence: Int32;
    private persistent let m_checkpointBranch: array<Int32>;
    private persistent let m_checkpointBranchEpoch: Int32;
    private persistent let m_checkpointLedgerSequence: Int32;

    // All leases, lifecycle signals and receipts are deliberately transient.
    private let m_attached: Bool;
    private let m_sessionReady: Bool;
    private let m_restoreExpected: Bool;
    private let m_restoreCompleted: Bool;
    private let m_resolved: Bool;
    private let m_generation: Int32;
    private let m_revision: Int32;
    private let m_activationId: String;
    private let m_faulted: Bool;
    private let m_saving: Bool;
    private let m_serializationCompleted: Int32;
    private let m_restoredBranch: array<Int32>;
    private let m_restoredBranchEpoch: Int32;
    private let m_restoredLedgerSequence: Int32;
    private let m_restoredCheckpointSequence: Int32;
    private let m_restoredCheckpointValid: Bool;
    private let m_callbacks: wref<CallbackSystem>;

    public static func Get() -> ref<ConvaiKnowledgeState> {
        return GameInstance.GetScriptableSystemsContainer(GetGameInstance())
            .Get(n"CyberpunkConvai.ConvaiKnowledgeState") as ConvaiKnowledgeState;
    }

    private func OnAttach() -> Void {
        this.m_attached = true;
        this.m_callbacks = ConvaiCallbackSystem();
        this.m_callbacks.RegisterCallback(n"Session/BeforeSave", this, n"OnKnowledgeBeforeSave");
        this.m_callbacks.RegisterCallback(n"Session/AfterSave", this, n"OnKnowledgeAfterSave");
        let lifecycle = ConvaiKnowledgeLifecycle.Get();
        if IsDefined(lifecycle) { lifecycle.Synchronize(this); }
    }

    private func OnDetach() -> Void {
        this.Invalidate();
        if IsDefined(this.m_callbacks) {
            this.m_callbacks.UnregisterCallback(n"Session/BeforeSave", this, n"OnKnowledgeBeforeSave");
            this.m_callbacks.UnregisterCallback(n"Session/AfterSave", this, n"OnKnowledgeAfterSave");
        }
        this.m_callbacks = null;
    }

    private func OnRestored(saveVersion: Int32, gameVersion: Int32) -> Void {
        // The engine calls this after restoring this system's persistent fields.
        // Keep an immutable receipt: subsequent live writes are not saved yet.
        this.m_restoreCompleted = true;
        this.m_restoredBranch = this.m_branch;
        this.m_restoredBranchEpoch = this.m_branchEpoch;
        this.m_restoredLedgerSequence = this.m_ledgerSequence;
        this.m_restoredCheckpointSequence = this.m_checkpointSequence;
        this.m_restoredCheckpointValid = this.ValidIdentity() && this.m_checkpointSequence > 0
            && this.SameToken(this.m_checkpointBranch, this.m_branch)
            && this.m_checkpointBranchEpoch == this.m_branchEpoch
            && this.m_checkpointLedgerSequence == this.m_ledgerSequence;
    }

    public func SessionReady(restored: Bool, generation: Int32) -> Void {
        if generation <= 0 || this.m_sessionReady { return; }
        this.m_sessionReady = true;
        this.m_restoreExpected = restored;
        this.m_generation = generation;
    }

    public func Invalidate() -> Void {
        this.m_attached = false;
        this.m_sessionReady = false;
        this.m_resolved = false;
        this.m_activationId = "";
    }

    private func IsReady() -> Bool {
        return this.m_attached && this.m_sessionReady && this.m_generation > 0
            && (!this.m_restoreExpected || this.m_restoreCompleted) && !this.m_faulted;
    }

    private func ValidToken(value: array<Int32>) -> Bool {
        if ArraySize(value) != 8 { return false; }
        let nonzero: Bool;
        let i = 0;
        while i < 8 {
            if value[i] < 0 || value[i] > 65535 { return false; }
            nonzero = nonzero || value[i] != 0;
            i += 1;
        }
        return nonzero;
    }

    private func SameToken(a: array<Int32>, b: array<Int32>) -> Bool {
        if ArraySize(a) != 8 || ArraySize(b) != 8 { return false; }
        let i = 0;
        while i < 8 {
            if a[i] != b[i] { return false; }
            i += 1;
        }
        return true;
    }

    private func ValidIdentity() -> Bool {
        return this.m_schema == 1 && this.ValidToken(this.m_campaign)
            && this.ValidToken(this.m_branch) && this.m_branchEpoch > 0
            && this.m_ledgerSequence >= 0;
    }

    private func CanMutate(generation: Int32, revision: Int32, activationId: String) -> Bool {
        return this.IsReady() && !this.m_saving && generation == this.m_generation
            && revision == this.m_revision && this.m_revision < 2147483647
            && StrLen(activationId) == 32 && Equals(activationId, this.m_activationId);
    }

    // A fresh bridge activation claims a CAS lease, then separately resolves
    // the loaded cursor against its durable ledger. Claiming is not resolution.
    public func ClaimSession(generation: Int32, revision: Int32, previous: String, next: String) -> Bool {
        if !this.IsReady() || this.m_saving || generation != this.m_generation
            || revision != this.m_revision || this.m_revision >= 2147483647
            || !Equals(previous, this.m_activationId) || StrLen(next) != 32 { return false; }
        this.m_activationId = next;
        this.m_resolved = false;
        this.m_revision += 1;
        return true;
    }

    public func Seed(generation: Int32, revision: Int32, activationId: String,
        campaign: array<Int32>, branch: array<Int32>) -> Bool {
        if !this.CanMutate(generation, revision, activationId) || this.m_schema != 0
            || ArraySize(this.m_campaign) != 0 || ArraySize(this.m_branch) != 0
            || !this.ValidToken(campaign) || !this.ValidToken(branch) { return false; }
        this.m_campaign = campaign;
        this.m_branch = branch;
        this.m_schema = 1;
        this.m_branchEpoch = 1;
        this.m_ledgerSequence = 0;
        this.m_resolved = true;
        this.m_revision += 1;
        return true;
    }

    public func Resume(generation: Int32, revision: Int32, activationId: String) -> Bool {
        if !this.CanMutate(generation, revision, activationId) || !this.ValidIdentity()
            || this.m_resolved { return false; }
        this.m_resolved = true;
        this.m_revision += 1;
        return true;
    }

    public func Advance(generation: Int32, revision: Int32, activationId: String, nextSequence: Int32) -> Bool {
        if !this.CanMutate(generation, revision, activationId) || !this.ValidIdentity()
            || !this.m_resolved || this.m_ledgerSequence >= 2147483647
            || nextSequence != this.m_ledgerSequence + 1 { return false; }
        // The bridge must durably append first. A crash before this assignment
        // leaves an unreferenced tail, never a save pointing past the journal.
        this.m_ledgerSequence = nextSequence;
        this.m_revision += 1;
        return true;
    }

    public func Fork(generation: Int32, revision: Int32, activationId: String,
        branch: array<Int32>, epoch: Int32) -> Bool {
        if !this.CanMutate(generation, revision, activationId) || !this.ValidIdentity()
            || !this.ValidToken(branch) || this.SameToken(branch, this.m_branch)
            || epoch <= this.m_branchEpoch { return false; }
        // The new journal's immutable parent is the previously captured cursor.
        // Its own sequence starts at zero; ancestry stays in the bridge ledger.
        this.m_branch = branch;
        this.m_branchEpoch = epoch;
        this.m_ledgerSequence = 0;
        this.m_resolved = true;
        this.m_revision += 1;
        return true;
    }

    private cb func OnKnowledgeBeforeSave(event: ref<GameSessionEvent>) -> Bool {
        if event.IsPreGame() || !this.IsReady() || !this.ValidIdentity() || !this.m_resolved { return false; }
        if this.m_saving || this.m_checkpointSequence >= 2147483647 || this.m_revision >= 2147483647 {
            this.m_faulted = true;
            return false;
        }
        // Codeware guarantees that serialization waits for this callback.
        // No disk or network I/O and no quest capture occurs on this boundary.
        this.m_saving = true;
        this.m_checkpointSequence += 1;
        this.m_checkpointBranch = this.m_branch;
        this.m_checkpointBranchEpoch = this.m_branchEpoch;
        this.m_checkpointLedgerSequence = this.m_ledgerSequence;
        this.m_revision += 1;
        return false;
    }

    private cb func OnKnowledgeAfterSave(event: ref<GameSessionEvent>) -> Bool {
        if event.IsPreGame() || !this.m_saving || !this.IsReady() { return false; }
        this.m_serializationCompleted = this.m_checkpointSequence;
        this.m_saving = false;
        if this.m_revision >= 2147483647 { this.m_faulted = true; } else { this.m_revision += 1; }
        return false;
    }

    public func GetSnapshot() -> ref<ConvaiKnowledgeSnapshot> {
        let result = new ConvaiKnowledgeSnapshot();
        result.ready = this.IsReady();
        result.restored = this.m_restoreCompleted;
        result.resolved = this.m_resolved;
        result.generation = this.m_generation;
        result.revision = this.m_revision;
        result.activationId = this.m_activationId;
        result.faulted = this.m_faulted;
        result.saving = this.m_saving;
        result.schema = this.m_schema;
        result.campaign = this.m_campaign;
        result.branch = this.m_branch;
        result.branchEpoch = this.m_branchEpoch;
        result.ledgerSequence = this.m_ledgerSequence;
        result.checkpointSequence = this.m_checkpointSequence;
        result.checkpointBranch = this.m_checkpointBranch;
        result.checkpointBranchEpoch = this.m_checkpointBranchEpoch;
        result.checkpointLedgerSequence = this.m_checkpointLedgerSequence;
        result.restoredBranch = this.m_restoredBranch;
        result.restoredBranchEpoch = this.m_restoredBranchEpoch;
        result.restoredLedgerSequence = this.m_restoredLedgerSequence;
        result.restoredCheckpointSequence = this.m_restoredCheckpointSequence;
        result.restoredCheckpointValid = this.m_restoredCheckpointValid;
        result.serializationCompleted = this.m_serializationCompleted;
        return result;
    }
}

// The service subscribes before sessions start, so a new-game Ready event is
// not missed by a ScriptableSystem that attaches later. It persists NO state.
@if(ModuleExists("Codeware"))
public class ConvaiKnowledgeLifecycle extends ScriptableService {
    private let m_generation: Int32;
    private let m_ready: Bool;
    private let m_restored: Bool;
    private let m_exhausted: Bool;

    public static func Get() -> ref<ConvaiKnowledgeLifecycle> {
        return ConvaiServiceContainer()
            .GetService(n"CyberpunkConvai.ConvaiKnowledgeLifecycle") as ConvaiKnowledgeLifecycle;
    }

    private cb func OnLoad() -> Void {
        let callbacks = ConvaiCallbackSystem();
        callbacks.RegisterCallback(n"Session/BeforeStart", this, n"OnKnowledgeStart");
        callbacks.RegisterCallback(n"Session/Ready", this, n"OnKnowledgeReady");
        callbacks.RegisterCallback(n"Session/BeforeEnd", this, n"OnKnowledgeEnd");
    }

    private cb func OnKnowledgeStart(event: ref<GameSessionEvent>) -> Bool {
        this.m_ready = false;
        this.m_restored = false;
        if this.m_generation >= 2147483647 { this.m_exhausted = true; }
        if !this.m_exhausted { this.m_generation += 1; }
        return false;
    }

    private cb func OnKnowledgeReady(event: ref<GameSessionEvent>) -> Bool {
        this.m_ready = !event.IsPreGame() && !this.m_exhausted;
        this.m_restored = event.IsRestored();
        let state = ConvaiKnowledgeState.Get();
        if IsDefined(state) { this.Synchronize(state); }
        return false;
    }

    private cb func OnKnowledgeEnd(event: ref<GameSessionEvent>) -> Bool {
        this.m_ready = false;
        let state = ConvaiKnowledgeState.Get();
        if IsDefined(state) { state.Invalidate(); }
        return false;
    }

    public func Synchronize(state: ref<ConvaiKnowledgeState>) -> Void {
        if this.m_ready && this.m_generation > 0 {
            state.SessionReady(this.m_restored, this.m_generation);
        }
    }
}
