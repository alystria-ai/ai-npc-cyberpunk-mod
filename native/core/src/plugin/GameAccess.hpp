#pragma once

// How a C++ system reaches game objects and calls game functions: through RTTI, by name.
//
// No addresses, no hooks, no struct layouts beyond what the RED4ext SDK already pins. Every call
// resolves the class and function by name once (cached) and goes through the game's own script
// function invoker, so it behaves exactly like the same call made from redscript or CET.
//
//   auto player = convai::game::Player();                 // Handle<IScriptable>, may be empty
//   RED4ext::Vector4 position{};
//   if (convai::game::Call(player, "GetWorldPosition", &position)) { ... }
//   bool inCombat = false;
//   convai::game::Call(player, "IsInCombat", &inCombat);
//   auto quests = convai::game::System("QuestsSystem");   // a game system by its class name
//   int32_t value = 0;
//   convai::game::Call(quests, "GetFactStr", &value, RED4ext::CString("q001_done"));
//
// Rules:
//   - Game thread only. These run inside natives the Lua calls, or the plugin's game-thread tick.
//   - Every helper returns false/empty instead of throwing on a missing class or function, so a
//     renamed function after a patch degrades to "unavailable", not a crash.
//   - Mod-spawned copies only: helpers do not decide policy. A system that acts on an NPC must
//     receive the entity from Lua, which already applied the world policy (convaiWorldPolicy:
//     only mod-spawned copies get mod systems, ordinary NPCs get the talk path only, game-placed
//     named characters get nothing).

#include <RED4ext/RED4ext.hpp>
#include <RED4ext/Scripting/Natives/ScriptGameInstance.hpp>
#include <RED4ext/Scripting/Natives/Vector4.hpp>

#include <string>
#include <utility>

namespace convai::game
{
using Object = RED4ext::Handle<RED4ext::IScriptable>;

// Cached CRTTISystem lookups. Class() takes the game's native RTTI name (entLookAtAddEvent,
// gameSpatialQueriesSystem, gameObject); GetClass alone does not know the script aliases, so a miss
// is retried as a script name (LookAtAddEvent). A miss is never cached, a hit always is.
RED4ext::CClass* Class(const char* aName);
RED4ext::CBaseFunction* Method(RED4ext::CClass* aClass, const char* aName);

// True when aFunction is the script function aName. The script compiler names a function that has
// overloads, or parameters it wants to tell apart, with the parameter types appended after a ';':
// the game's static NPCPuppet.IsInCombat(puppet) is registered as "IsInCombat;ScriptedPuppet" and
// PlayerPuppet's member as "IsInCombat;" (final.redscripts, 2026-10-13), so a lookup by the plain
// name (CClass::GetFunction) finds neither. A "Class::" prefix is ignored. Matches the plain name too.
bool FunctionIs(const RED4ext::CBaseFunction* aFunction, const char* aName);

// A static function of the class or of the nearest base class that declares one named aName with
// exactly aParamCount parameters (FunctionIs naming), resolved once and cached when found. Null when
// there is none; a miss logs once what the class does have under that name.
// aClassName is the game's native class name (script-defined classes have no other name).
RED4ext::CBaseFunction* StaticFunction(const char* aClassName, const char* aName, uint32_t aParamCount);

// GetPlayer(GameInstance). Empty while no player exists (menus, loading).
Object Player();

// A game system by its class name, e.g. System("QuestsSystem"): the instance's own system lookup for that
// class. Empty on failure.
Object System(const char* aSystemName);

// The game's own GameInstance.<aShortName>(gameInstance) system getter ("GetMountingFacility",
// "GetMappinSystem", "GetScriptableSystemsContainer", "GetSceneSystem"), the call redscript and CET make.
// These are NOT global functions: in final.redscripts (2026-10-13) they are native static functions of
// the class GameInstance (native name ScriptGameInstance) that take the game instance as their one
// parameter. They are looked up there first, then as globals ("Name;GameInstance" and by short name),
// then in every class's functions; the route that worked is logged once. If no function can be found or
// run, the system is asked for by its native class name (the instance's own system lookup).
// Empty while the world or the function is missing.
Object GameSystem(const char* aShortName);

bool IsA(const Object& aObject, const char* aClassName);

// ---- the combat flag of a puppet ---------------------------------------------------------------
// What the Lua reads as NPCPuppet.IsInCombat(npc). Live 2026-10-16 to 21 the plugin found no function of
// that name on NPCPuppet's class chain (RED4ext log: "no static function NPCPuppet.IsInCombat with 1
// parameters (nothing under that name)"), although final.redscripts defines it there: a static function
// "IsInCombat;ScriptedPuppet" of NPCPuppet (flags: static, final) whose body is
//     return IntEnum(npc.GetPuppetStateBlackboard().GetInt(GetAllBlackboardDefs().PuppetState.HighLevel))
//            == gamedataNPCHighLevelState.Combat
// NPCPuppet also has the member IsPuppetInCombat() (one statement: IsInCombat(this)), and ScriptedPuppet the
// member GetHighLevelStateFromBlackboard() (the same blackboard read, answering the enum). So the flag is
// read through the first of these that resolves, in this order, resolved once and then cached:
//   1. the static IsInCombat(puppet) on the class chain (statics, then static members, nearest class first);
//   2. the same static in the game's list of every class function (full name NPCPuppet::IsInCombat;...);
//   3. the same static as a global function (RTTI function table, a few full names);
//   4. the member NPCPuppet.IsPuppetInCombat() on the class chain, then in the list of class functions;
//   5. the member ScriptedPuppet.GetHighLevelStateFromBlackboard() (chain, then list) compared with the value
//      of gamedataNPCHighLevelState.Combat.
// Which route resolved, or every candidate tried when none did, is logged once to the RED4ext log and is in
// ConvaiNative.GameProbe() ("combat"). With no route the flag is UNKNOWN: PuppetInCombat answers false, and
// every caller leaves that one field to the Lua (the actuator's combat flag, the faces Safe check, the
// chauffeur's calm flag), which is what happens today; nothing else changes and nothing is switched off.
enum class CombatRoute
{
    Unresolved,
    StaticChain,
    StaticClassList,
    StaticGlobal,
    MemberIsPuppetInCombat,
    HighLevelState,
    None
};

// True and aOut set when the flag was read. False when it is unknown: no route resolved, the puppet is not a
// ScriptedPuppet, or the game call failed. A miss is looked up again on every 256th call.
bool PuppetInCombat(const Object& aPuppet, bool& aOut);
// A route exists (resolving it if it has not been tried yet).
bool CombatAvailable();
const char* CombatRouteName();
// {"route":"static-chain","function":"NPCPuppet::IsInCombat;ScriptedPuppet","attempts":1,"tried":"..."}
std::string CombatRouteJson();

// aObject.<aMethod>(aArgs...) -> *aOut. aOut may be nullptr for void methods.
template<typename TOut, typename... TArgs>
bool Call(const Object& aObject, const char* aMethod, TOut* aOut, TArgs&&... aArgs)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    auto* type = aObject.instance->GetType();
    auto* function = type ? Method(type, aMethod) : nullptr;
    if (!function)
    {
        return false;
    }
    RED4ext::StackArgs_t args;
    ((args.emplace_back(nullptr, &aArgs)), ...);
    return RED4ext::ExecuteFunction(aObject.instance, function, aOut, args);
}

// A property by name, e.g. Property<bool>(player, "inCrouch", value).
template<typename T>
bool Property(const Object& aObject, const char* aName, T& aOut)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    auto* type = aObject.instance->GetType();
    auto* property = type ? type->GetProperty(aName) : nullptr;
    if (!property)
    {
        return false;
    }
    aOut = property->GetValue<T>(aObject.instance);
    return true;
}

// One self-test used by ConvaiNative.GameProbe(): the player's position and combat flag as JSON,
// or an "unavailable" reason. Proves the helpers in game before any system relies on them.
std::string ProbeJson();
} // namespace convai::game
