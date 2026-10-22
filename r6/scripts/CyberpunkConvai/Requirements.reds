module CyberpunkConvai

// Which requirements these scripts were compiled against.
//
// Every file in this folder that needs Codeware guards that code with @if(ModuleExists(...)) and carries a plain
// stand-in for the same methods, so a missing requirement never stops the whole redscript compile (a compile error disables
// every redscript mod, not only this one). The game then runs these scripts without the part that needs the missing mod.
// mod/setup-check.lua asks this one getter once per check (at load and when the Help page opens, never per frame) and tells the
// player which requirement is missing. A player without any of this mod's scripts has no such method, which is how the Lua side
// knows the scripts did not compile at all.
//
// The answer is fixed when the scripts compile, so a mod installed afterwards shows up after the next game start.

@if(ModuleExists("Codeware"))
public func ConvaiHasCodeware() -> Bool { return true; }
@if(!ModuleExists("Codeware"))
public func ConvaiHasCodeware() -> Bool { return false; }

// Codeware's UI modules came after its first versions: the text input needs the second, the notification input box the first.
@if(ModuleExists("Codeware.UI"))
public func ConvaiHasCodewareUi() -> Bool { return true; }
@if(!ModuleExists("Codeware.UI"))
public func ConvaiHasCodewareUi() -> Bool { return false; }

@if(ModuleExists("Codeware.UI.TextInput"))
public func ConvaiHasCodewareTextInput() -> Bool { return true; }
@if(!ModuleExists("Codeware.UI.TextInput"))
public func ConvaiHasCodewareTextInput() -> Bool { return false; }

// The requirements found, as lowercase words separated by spaces: "codeware codeware-ui codeware-textinput".
@addMethod(PlayerPuppet)
public final func ConvaiRequirements() -> String {
    let found = "";
    if ConvaiHasCodeware() { found += "codeware "; }
    if ConvaiHasCodewareUi() { found += "codeware-ui "; }
    if ConvaiHasCodewareTextInput() { found += "codeware-textinput "; }
    if StrLen(found) > 0 { found = StrLeft(found, StrLen(found) - 1); }
    return found;
}
