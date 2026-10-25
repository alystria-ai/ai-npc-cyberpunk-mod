// No module line: Face.reds is in the global module, and a global function is visible from every module.
// The 2.5 build's GameVariant.reds (it replaces r6/scripts/CyberpunkConvai/GameVariant.reds when the release is built with --game 2.5).
//
// Cyberpunk 2077 2.5 ships its own CallbackSystem and ScriptableServiceContainer (Codeware 2.5 binds its types to them). The getters work without an
// argument here (redscript 0.5.32 compiled the no-argument calls against the 2.5 scripts), so they are the same as in the 2.31 file. The one
// difference is the key target: InputTarget.Key of 2.5 takes a Float where Codeware 2.31 takes an EInputAction (and so ConvaiKeyTargetsByAction answers no). See docs/GAME_VERSIONS.md.

@if(ModuleExists("Codeware"))
public func ConvaiCallbackSystem() -> ref<CallbackSystem> {
    return GameInstance.GetCallbackSystem();
}

// A key callback target. 2.5's InputTarget.Key has no action parameter, so every action of the key arrives and the handlers check the action
// themselves (Manager.reds, PhoneChat.reds, PhoneContacts.reds).
@if(ModuleExists("Codeware"))
public func ConvaiKeyTarget(key: EInputKey, action: EInputAction) -> ref<InputTarget> {
    return InputTarget.Key(key);
}

// Whether a key target filters by the key's action. 2.5's does not: one target gets every action of the key, so KeyBinds.reds adds one target per key.
@if(ModuleExists("Codeware"))
public func ConvaiKeyTargetsByAction() -> Bool {
    return false;
}

@if(ModuleExists("Codeware"))
public func ConvaiServiceContainer() -> ref<ScriptableServiceContainer> {
    return GameInstance.GetScriptableServiceContainer();
}
