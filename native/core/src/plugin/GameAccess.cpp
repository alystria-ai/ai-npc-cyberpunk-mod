#include "GameAccess.hpp"

#include "core/Log.hpp"
#include "core/ScriptNames.hpp"

#include <RED4ext/GameEngine.hpp>
#include <RED4ext/RTTISystem.hpp>

#include <cstdio>
#include <cstring>
#include <unordered_map>

namespace convai::game
{
namespace
{
// Game thread only, so no locking. Only hits are cached: a miss before the scripts finished loading
// (a class the game defines in script) must not stay a miss for the whole session. A miss logs once
// per name and is looked up again on the next call (one hash lookup for a class, one walk of the
// class chain for a method; the callers only reach it behind a capability check).
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

// True the first time a name is reported missing.
bool FirstMiss(const std::string& aKey)
{
    static std::unordered_map<std::string, bool> reported;
    return reported.emplace(aKey, true).second;
}
} // namespace

RED4ext::CClass* Class(const char* aName)
{
    if (!aName || !*aName)
    {
        return nullptr;
    }
    auto& classes = Classes();
    auto it = classes.find(aName);
    if (it != classes.end())
    {
        return it->second;
    }
    auto* rtti = RED4ext::CRTTISystem::Get();
    RED4ext::CClass* type = rtti ? rtti->GetClass(aName) : nullptr;
    if (!type && rtti)
    {
        // Redscript and CET know many native classes by an alias (LookAtAddEvent for entLookAtAddEvent,
        // SpatialQueriesSystem for gameSpatialQueriesSystem), and GetClass only answers to the native
        // name. Callers pass the native name; a script name still resolves here.
        type = rtti->GetClassByScriptName(aName);
    }
    if (type)
    {
        classes.emplace(aName, type);
    }
    else if (FirstMiss(std::string("class ") + aName))
    {
        CONVAI_WARN("Game access: class %s not found", aName);
    }
    return type;
}

bool FunctionIs(const RED4ext::CBaseFunction* aFunction, const char* aName)
{
    return aFunction && aName && *aName &&
           (convai::ScriptNameIs(aFunction->shortName.ToString(), aName) ||
            convai::ScriptNameIs(aFunction->fullName.ToString(), aName));
}

namespace
{
// What the class chain declares under a script name, for the log line of a miss.
std::string Declared(RED4ext::CClass* aType, const char* aName)
{
    std::string text;
    for (RED4ext::CClass* type = aType; type; type = type->parent)
    {
        auto note = [&](const RED4ext::CBaseFunction* aFunction) {
            if (FunctionIs(aFunction, aName))
            {
                text += text.empty() ? "" : ", ";
                text += std::string(aFunction->shortName.ToString()) + " (" + std::to_string(aFunction->params.Size()) +
                        (aFunction->flags.isStatic ? " parameters, static" : " parameters, member") + " on " +
                        type->GetName().ToString() + ")";
            }
        };
        for (const RED4ext::CClassFunction* function : type->funcs)
        {
            note(function);
        }
        for (const RED4ext::CClassStaticFunction* function : type->staticFuncs)
        {
            note(function);
        }
    }
    return text.empty() ? std::string("nothing under that name") : text;
}
} // namespace

RED4ext::CBaseFunction* Method(RED4ext::CClass* aClass, const char* aName)
{
    if (!aClass || !aName || !*aName)
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
    // GetFunction compares the registered short name exactly, and that name carries the parameter
    // signature for the functions the script compiler told apart ("IsInCombat;ScriptedPuppet"), so it
    // finds none of them. Walk the chain by script name: members before statics, nearest class first.
    for (RED4ext::CClass* type = aClass; type && !function; type = type->parent)
    {
        for (RED4ext::CClassFunction* candidate : type->funcs)
        {
            if (FunctionIs(candidate, aName))
            {
                function = candidate;
                break;
            }
        }
        for (RED4ext::CClassStaticFunction* candidate : type->staticFuncs)
        {
            if (function)
            {
                break;
            }
            if (FunctionIs(candidate, aName))
            {
                function = candidate;
            }
        }
    }
    if (function)
    {
        methods.emplace(key, function);
    }
    else if (FirstMiss(key))
    {
        CONVAI_WARN("Game access: %s not found", key.c_str());
    }
    return function;
}

RED4ext::CBaseFunction* StaticFunction(const char* aClassName, const char* aName, uint32_t aParamCount)
{
    static std::unordered_map<std::string, RED4ext::CBaseFunction*> functions;
    const std::string key = std::string(aClassName) + "." + aName + "/" + std::to_string(aParamCount);
    auto found = functions.find(key);
    if (found != functions.end())
    {
        return found->second;
    }
    RED4ext::CClass* type = Class(aClassName);
    RED4ext::CBaseFunction* function = nullptr;
    for (RED4ext::CClass* cls = type; cls && !function; cls = cls->parent)
    {
        for (RED4ext::CClassStaticFunction* candidate : cls->staticFuncs)
        {
            if (candidate && candidate->params.Size() == aParamCount && FunctionIs(candidate, aName))
            {
                function = candidate;
                break;
            }
        }
        for (RED4ext::CClassFunction* candidate : cls->funcs)
        {
            if (function)
            {
                break;
            }
            if (candidate && candidate->flags.isStatic && candidate->params.Size() == aParamCount &&
                FunctionIs(candidate, aName))
            {
                function = candidate;
            }
        }
    }
    if (function)
    {
        CONVAI_INFO("Game access: static %s.%s resolved as %s", aClassName, aName, function->shortName.ToString());
        functions.emplace(key, function);
    }
    else if (FirstMiss("static " + key))
    {
        CONVAI_WARN("Game access: no static function %s.%s with %u parameters (%s)", aClassName, aName,
                    static_cast<unsigned>(aParamCount),
                    type ? Declared(type, aName).c_str() : "the class is not known");
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

namespace
{
// The one parameter is the game instance: the type is ScriptGameInstance natively, GameInstance in script.
bool IsGameInstanceParam(const RED4ext::CBaseFunction* aFunction)
{
    if (!aFunction || aFunction->params.Size() != 1 || !aFunction->params[0] || !aFunction->params[0]->type)
    {
        return false;
    }
    const char* type = aFunction->params[0]->type->GetName().ToString();
    return std::strcmp(type, "ScriptGameInstance") == 0 || std::strcmp(type, "GameInstance") == 0;
}

// The one-parameter (GameInstance) function behind GameInstance.<aShortName>, and how it was found.
RED4ext::CBaseFunction* ResolveSystemGetter(const char* aShortName, bool aDeep, std::string& aRoute)
{
    auto* rtti = RED4ext::CRTTISystem::Get();
    if (!rtti)
    {
        return nullptr;
    }
    // 1. A static (or member) function of the class GameInstance, native name ScriptGameInstance.
    for (const char* className : {"ScriptGameInstance", "GameInstance"})
    {
        RED4ext::CClass* type = rtti->GetClass(className);
        if (!type)
        {
            type = rtti->GetClassByScriptName(className);
        }
        for (RED4ext::CClass* cls = type; cls; cls = cls->parent)
        {
            for (RED4ext::CClassStaticFunction* candidate : cls->staticFuncs)
            {
                if (candidate && FunctionIs(candidate, aShortName) && IsGameInstanceParam(candidate))
                {
                    aRoute = std::string("static function of class ") + cls->GetName().ToString();
                    return candidate;
                }
            }
            for (RED4ext::CClassFunction* candidate : cls->funcs)
            {
                if (candidate && FunctionIs(candidate, aShortName) && IsGameInstanceParam(candidate))
                {
                    aRoute = std::string("function of class ") + cls->GetName().ToString();
                    return candidate;
                }
            }
        }
    }
    // 2. A global function, "<name>;GameInstance" or any global of that short name with the one parameter.
    const std::string full = std::string(aShortName) + ";GameInstance";
    if (RED4ext::CBaseFunction* global = rtti->GetFunction(RED4ext::CName(full.c_str())))
    {
        if (global->params.Size() == 1)
        {
            aRoute = "global function " + full;
            return global;
        }
    }
    RED4ext::DynArray<RED4ext::CBaseFunction*> globals;
    rtti->GetGlobalFunctions(globals);
    for (RED4ext::CBaseFunction* candidate : globals)
    {
        if (FunctionIs(candidate, aShortName) && IsGameInstanceParam(candidate))
        {
            aRoute = std::string("global function ") + candidate->fullName.ToString();
            return candidate;
        }
    }
    // 3. Any class function of the game (once: the list is large).
    if (!aDeep)
    {
        return nullptr;
    }
    RED4ext::DynArray<RED4ext::CBaseFunction*> classFunctions;
    rtti->GetClassFunctions(classFunctions);
    for (RED4ext::CBaseFunction* candidate : classFunctions)
    {
        if (FunctionIs(candidate, aShortName) && IsGameInstanceParam(candidate))
        {
            aRoute = std::string("class function ") + candidate->fullName.ToString();
            return candidate;
        }
    }
    return nullptr;
}

// The native class names the instance's own system lookup knows, interface first.
std::pair<const char*, const char*> SystemClasses(const std::string& aShortName)
{
    if (aShortName == "GetMountingFacility")
    {
        return {"gamemountingIMountingFacility", "gamemountingMountingFacility"};
    }
    if (aShortName == "GetMappinSystem")
    {
        return {"gamemappinsIMappinSystem", "gamemappinsMappinSystem"};
    }
    if (aShortName == "GetScriptableSystemsContainer")
    {
        return {"gameIScriptableSystemsContainer", "gameScriptableSystemsContainer"};
    }
    if (aShortName == "GetSceneSystem")
    {
        return {"gameISceneSystem", "scnSceneSystem"};
    }
    return {nullptr, nullptr};
}
} // namespace

Object GameSystem(const char* aShortName)
{
    if (!aShortName || !*aShortName)
    {
        return {};
    }
    // Hits are cached with the route. A miss is looked up again every 64th call (the scripts may not
    // have loaded yet) and reported once.
    struct Entry
    {
        RED4ext::CBaseFunction* function = nullptr;
        bool functionFailed = false;
        uint32_t misses = 0;
        bool announced = false;
    };
    static std::unordered_map<std::string, Entry> entries;
    Entry& entry = entries[aShortName];
    if (!entry.function && !entry.functionFailed && (entry.misses == 0 || (entry.misses & 0x3F) == 0))
    {
        std::string route;
        entry.function = ResolveSystemGetter(aShortName, entry.misses == 0, route);
        if (entry.function)
        {
            CONVAI_INFO("Game access: GameInstance.%s resolved as %s (%s)", aShortName,
                        entry.function->fullName.ToString(), route.c_str());
        }
        else if (entry.misses == 0)
        {
            auto* rtti = RED4ext::CRTTISystem::Get();
            auto* classType = rtti ? rtti->GetClass("ScriptGameInstance") : nullptr;
            CONVAI_WARN("Game access: no function GameInstance.%s found (class ScriptGameInstance %s, %u static "
                        "functions); asking the instance for the system by class",
                        aShortName, classType ? "exists" : "missing",
                        classType ? static_cast<unsigned>(classType->staticFuncs.Size()) : 0u);
        }
    }
    if (entry.function)
    {
        RED4ext::ScriptGameInstance gameInstance;
        Object system;
        RED4ext::StackArgs_t args;
        args.emplace_back(nullptr, &gameInstance);
        if (RED4ext::ExecuteFunction(static_cast<void*>(nullptr), entry.function, &system, args))
        {
            return system;
        }
        // The function exists but cannot be run: do not try it again, use the instance's lookup.
        entry.function = nullptr;
        entry.functionFailed = true;
        CONVAI_WARN("Game access: GameInstance.%s could not be executed; asking the instance for the system by class",
                    aShortName);
    }
    ++entry.misses;
    const auto classes = SystemClasses(aShortName);
    for (const char* name : {classes.first, classes.second})
    {
        if (!name)
        {
            continue;
        }
        Object system = System(name);
        if (system)
        {
            if (!entry.announced)
            {
                entry.announced = true;
                CONVAI_INFO("Game access: GameInstance.%s answered by the instance's system lookup (%s)", aShortName,
                            name);
            }
            return system;
        }
    }
    return {};
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
