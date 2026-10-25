// No module line: Face.reds is in the global module, and a global function is visible from every module.
// The game-version-specific engine accessors, the only place this mod's scripts differ between the two game builds it ships for.
//
// The mod is built twice from one source tree, once per game version (docs/GAME_VERSIONS.md). This is the 2.31 file. The 2.5 build replaces it with
// packaging/game-variants/2.5/r6/scripts/CyberpunkConvai/GameVariant.reds, which differs in the key target (Codeware 2.31's InputTarget.Key takes the
// key's action, 2.5's own InputTarget.Key does not) and in whether a key event calls into Lua as it happens (ConvaiKeyNotifyInEvent).
//
// Callers use ConvaiCallbackSystem(), ConvaiServiceContainer(), ConvaiKeyTarget(), ConvaiKeyTargetsByAction() and ConvaiKeyNotifyInEvent(); nothing else in
// the folder names those engine functions.

@if(ModuleExists("Codeware"))
public func ConvaiCallbackSystem() -> ref<CallbackSystem> {
    return GameInstance.GetCallbackSystem();
}

// A key callback target. 2.31's Codeware target filters by the key's action; the target of 2.5 has no action parameter, so every action of the key arrives and
// the handlers check the action themselves.
@if(ModuleExists("Codeware"))
public func ConvaiKeyTarget(key: EInputKey, action: EInputAction) -> ref<InputTarget> {
    return InputTarget.Key(key, action);
}

// Whether a key target filters by the key's action (KeyBinds.reds adds a press target and a release target for each key it listens to when it does).
@if(ModuleExists("Codeware"))
public func ConvaiKeyTargetsByAction() -> Bool {
    return true;
}

// Whether a key event of the mod's own bindings may call into Lua while the game is delivering it (KeyBinds.reds ConvaiKeyBindNotify, which Lua observes).
// 2.5: yes, live-tested. 2.31: no; game 2.31 froze while a key was being set (25 Oct, Codeware 1.20.6, Dark Future's input mods beside it), and no key
// callback had called into Lua there before. Lua reads the keys on its 10 Hz tick instead.
public func ConvaiKeyNotifyInEvent() -> Bool {
    return false;
}

@if(ModuleExists("Codeware"))
public func ConvaiServiceContainer() -> ref<ScriptableServiceContainer> {
    return GameInstance.GetScriptableServiceContainer();
}
