module CyberpunkConvai

// A filter in front of mod/companion-locomotion.lua (docs/COMPANION_IMPROVEMENTS_2026-10-17.md, item 2).
//
// The game runs AIMoveToCommandHandler.UpdateCommand every AI tick for every NPC that is walking on a move command. A Lua
// observer on that engine method paid the CET call into Lua for all of them, with or without a party. Here the filter is
// one Bool read in script: the movement controller marks the move commands it creates (ConvaiMarkOwned, called from
// Lua once per command) and only a marked command is reported, through ConvaiOwnedMoveUpdate, an empty method that Lua
// observes instead. A command of the game's own NPCs, of a quest, of another mod or of a spawner is never marked, so for
// all of them this costs the original call, one type test and one Bool read, and Lua never runs.
//
// Safety: the wrapper always runs the original first and returns its result unchanged; it reads one field and calls an empty
// method, and nothing else. Lua checks at install time that both methods exist, and falls back to observing the engine
// method itself when they do not (mod/companion-locomotion.lua), so a stale or missing script half never loses the
// behaviour and never breaks a start. Nothing here holds a reference to an NPC, a context or a command beyond the call.

@addField(AIMoveToCommand)
public let m_convaiOwned: Bool;

// Called from Lua on a move command of one of our companions before it is sent. No-op effect for anything else.
@addMethod(AIMoveToCommand)
public final func ConvaiMarkOwned() -> Void {
    this.m_convaiOwned = true;
}

// Empty on purpose: mod/companion-locomotion.lua observes it, so Lua runs only for a command marked above.
@addMethod(AIMoveToCommandHandler)
public final func ConvaiOwnedMoveUpdate(context: ScriptExecutionContext, command: ref<AICommand>) -> Void {
}

@wrapMethod(AIMoveToCommandHandler)
protected func UpdateCommand(context: ScriptExecutionContext, command: ref<AICommand>) -> AIbehaviorUpdateOutcome {
    let outcome: AIbehaviorUpdateOutcome = wrappedMethod(context, command);
    let move: ref<AIMoveToCommand> = command as AIMoveToCommand;
    if IsDefined(move) && move.m_convaiOwned {
        this.ConvaiOwnedMoveUpdate(context, command);
    };
    return outcome;
}
