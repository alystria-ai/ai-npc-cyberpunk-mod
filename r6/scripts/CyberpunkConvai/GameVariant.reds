// No module line: Face.reds is in the global module, and a global function is visible from every module.
// The game-version-specific engine accessors, the only place this mod's scripts differ between the two game builds it ships for.
//
// The mod is built twice from one source tree, once per game version (docs/GAME_VERSIONS.md). This is the 2.31 file. The 2.5 build
// replaces it with packaging/game-variants/2.5/r6/scripts/CyberpunkConvai/GameVariant.reds: 2.5 has its own CallbackSystem and
// ScriptableServiceContainer getters with an optional game-instance parameter, and redscript 0.5.32 refuses a call that leaves it out,
// while 2.31 only has Codeware's getters without one.
//
// Callers use ConvaiCallbackSystem() and ConvaiServiceContainer(); nothing else in the folder names the getters.

@if(ModuleExists("Codeware"))
public func ConvaiCallbackSystem() -> ref<CallbackSystem> {
    return GameInstance.GetCallbackSystem();
}

@if(ModuleExists("Codeware"))
public func ConvaiServiceContainer() -> ref<ScriptableServiceContainer> {
    return GameInstance.GetScriptableServiceContainer();
}
