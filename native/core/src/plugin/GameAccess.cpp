#include "GameAccess.hpp"

#include "core/Log.hpp"

#include <RED4ext/GameEngine.hpp>
#include <RED4ext/RTTISystem.hpp>

#include <cstdio>
#include <unordered_map>

namespace convai::game
{
namespace
{
// Game thread only, so no locking. Misses are cached too (nullptr), so a function that a patch
// renamed costs one failed lookup per session, not one per call.
std::unordered_map<std::string, RED4ext::CClass*>& Classes()
{
    static std::unordered_map<std::string, RED4ext::CClass*> classes;
    return classes;
}

std::unordered_map<std::string, RED4ext::CBaseFunction*>& Methods()
{
    static std::unordered_map<std::string, RED4ext::CBaseFunction*> methods;
    return methods;
}
} // namespace

RED4ext::CClass* Class(const char* aName)
{
    auto& classes = Classes();
    auto it = classes.find(aName);
    if (it != classes.end())
    {
        return it->second;
    }
    auto* rtti = RED4ext::CRTTISystem::Get();
    RED4ext::CClass* type = rtti ? rtti->GetClass(aName) : nullptr;
    classes.emplace(aName, type);
    if (!type)
    {
        CONVAI_WARN("Game access: class %s not found", aName);
    }
    return type;
}

RED4ext::CBaseFunction* Method(RED4ext::CClass* aClass, const char* aName)
{
    if (!aClass)
    {
        return nullptr;
    }
    std::string key = aClass->GetName().ToString();
    key += '.';
    key += aName;
    auto& methods = Methods();
    auto it = methods.find(key);
    if (it != methods.end())
    {
        return it->second;
    }
    RED4ext::CBaseFunction* function = aClass->GetFunction(aName);
    methods.emplace(key, function);
    if (!function)
    {
        CONVAI_WARN("Game access: %s not found", key.c_str());
    }
    return function;
}

Object Player()
{
    Object player;
    RED4ext::ScriptGameInstance gameInstance;
    if (!RED4ext::ExecuteGlobalFunction("GetPlayer;GameInstance", &player, gameInstance))
    {
        return {};
    }
    return player;
}

Object System(const char* aSystemName)
{
    auto* type = Class(aSystemName);
    auto* engine = RED4ext::CGameEngine::Get();
    if (!type || !engine || !engine->framework || !engine->framework->gameInstance)
    {
        return {};
    }
    RED4ext::IScriptable* system = engine->framework->gameInstance->GetSystem(type);
    if (!system)
    {
        return {};
    }
    return Object(system);
}

bool IsA(const Object& aObject, const char* aClassName)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    auto* wanted = Class(aClassName);
    auto* type = aObject.instance->GetType();
    return wanted && type && type->IsA(wanted);
}

std::string ProbeJson()
{
    Object player = Player();
    if (!player)
    {
        return R"({"ok":false,"reason":"no player"})";
    }
    RED4ext::Vector4 position{};
    if (!Call(player, "GetWorldPosition", &position))
    {
        return R"({"ok":false,"reason":"GetWorldPosition failed"})";
    }
    bool inCombat = false;
    const bool combatKnown = Call(player, "IsInCombat", &inCombat);
    const bool isPlayerPuppet = IsA(player, "PlayerPuppet");
    char text[256];
    std::snprintf(text, sizeof(text),
                  R"({"ok":true,"x":%.3f,"y":%.3f,"z":%.3f,"inCombat":%s,"playerPuppet":%s})", position.X,
                  position.Y, position.Z, combatKnown ? (inCombat ? "true" : "false") : "null",
                  isPlayerPuppet ? "true" : "false");
    return text;
}
} // namespace convai::game
