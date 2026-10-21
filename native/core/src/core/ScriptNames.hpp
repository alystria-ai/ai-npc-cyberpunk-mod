#pragma once

// Names of script functions as the game registers them. The script compiler appends the parameter
// types to the name of a function it has to tell apart, after a ';': the static NPCPuppet.IsInCombat(puppet)
// is "IsInCombat;ScriptedPuppet" and PlayerPuppet's member is "IsInCombat;" (r6/cache/final.redscripts,
// 2026-10-13), so a lookup by the plain name finds neither. No game types here, so the headless tests run it.

namespace convai
{
// True when aText is aName, optionally behind a "Class::" prefix, and either ends there or continues
// with ';' and a parameter signature. "IsInCombat;ScriptedPuppet", "IsInCombat;", "NPCPuppet::IsInCombat"
// and "IsInCombat" are IsInCombat; "IsInCombatWith" and "XIsInCombat" are not.
bool ScriptNameIs(const char* aText, const char* aName);

// True when aText is "aClass::aName", optionally followed by ';' and a parameter signature: the full
// name a function registered on a class can carry ("NPCPuppet::IsInCombat;ScriptedPuppet"). The class must
// match exactly ("ScriptedPuppet::IsInCombat" is not NPCPuppet's), and aText without a "Class::" prefix is
// never a match, so a function of another class with the same short name is not taken for this one.
bool ScriptNameInClass(const char* aText, const char* aClass, const char* aName);
} // namespace convai
