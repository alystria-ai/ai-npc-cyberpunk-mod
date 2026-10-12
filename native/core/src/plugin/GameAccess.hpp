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

// Cached CRTTISystem lookups.
RED4ext::CClass* Class(const char* aName);
RED4ext::CBaseFunction* Method(RED4ext::CClass* aClass, const char* aName);

// GetPlayer(GameInstance). Empty while no player exists (menus, loading).
Object Player();

// GameInstance.Get<System>() style access, e.g. System("QuestsSystem") calls
// ScriptGameInstance.GetQuestsSystem(). Empty on failure.
Object System(const char* aSystemName);

bool IsA(const Object& aObject, const char* aClassName);

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
