module CyberpunkConvai

// Names for nameless ordinary NPCs in the scanner (docs/NPC_NAMES.md).
//
// The name itself is made by mod/npc-names.lua, which also decides who gets one (never a story or named character, a companion
// of the mod, or an NPC in combat). Lua observes NPCPuppet.CompileScannerChunks (the game's own function that fills the scanner's
// blackboard for the NPC being scanned; it runs when the scanner asks for that NPC, never per frame) and, after the game has
// written its chunk, calls this one method with the name. Nothing here runs unless Lua calls it.
//
// What the game writes (NPCPuppet.CompileScannerChunks, from the 2.x script dump): a ScannerName chunk in
// UI_ScannerModules.ScannerName. With an archetype shown ("Pedestrian") the chunk holds text params TEXT_PRIMARY (the name) and
// TEXT_SECONDARY (the archetype); otherwise it holds the plain name. Only the primary text / the plain name is replaced; the
// archetype line, level, health and every other chunk stay the game's own.

@addMethod(NPCPuppet)
public final func ConvaiApplyScannerName(name: String) -> Bool {
    if StrLen(name) == 0 {
        return false;
    }
    let definitions = GetAllBlackboardDefs().UI_ScannerModules;
    let board = GameInstance.GetBlackboardSystem(this.GetGame()).Get(definitions);
    if !IsDefined(board) {
        return false;
    }
    let chunk = FromVariant<ref<ScannerName>>(board.GetVariant(definitions.ScannerName));
    if !IsDefined(chunk) {
        return false;
    }
    if chunk.HasArchetype() {
        let params = chunk.GetTextParams();
        if !IsDefined(params) {
            return false;
        }
        params.UpdateLocalizedString("TEXT_PRIMARY", name);
        chunk.SetTextParams(params);
    } else {
        chunk.Set(name);
    }
    board.SetVariant(definitions.ScannerName, ToVariant(chunk), true);
    return true;
}
