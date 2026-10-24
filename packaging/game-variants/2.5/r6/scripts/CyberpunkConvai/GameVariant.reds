// No module line: Face.reds is in the global module, and a global function is visible from every module.
// The 2.5 build's GameVariant.reds (it replaces r6/scripts/CyberpunkConvai/GameVariant.reds when the release is built with --game 2.5).
//
// Cyberpunk 2077 2.5 ships its own CallbackSystem and ScriptableServiceContainer (Codeware 2.5 binds its types to them). Their getters
// take an optional game instance, and redscript 0.5.32 cannot resolve a call that leaves out an optional parameter of these
// natives (a redscript bug fixed after 0.5.32), so the instance is passed. See docs/GAME_VERSIONS.md.

@if(ModuleExists("Codeware"))
public func ConvaiCallbackSystem() -> ref<CallbackSystem> {
    return GameInstance.GetCallbackSystem(GetGameInstance());
}

@if(ModuleExists("Codeware"))
public func ConvaiServiceContainer() -> ref<ScriptableServiceContainer> {
    return GameInstance.GetScriptableServiceContainer(GetGameInstance());
}
