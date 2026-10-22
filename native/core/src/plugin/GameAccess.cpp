#include "GameAccess.hpp"

#include "core/Log.hpp"
#include "core/ScriptNames.hpp"
#include "core/Switches.hpp"

#include <RED4ext/GameEngine.hpp>
#include <RED4ext/RTTISystem.hpp>

#include <cstdio>
#include <cstring>
#include <unordered_map>
#include <unordered_set>

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

namespace
{
// Defined with the combat-flag helpers below.
RED4ext::CBaseFunction* ListFunction(RED4ext::DynArray<RED4ext::CBaseFunction*>& aList, const char* aClass,
                                     const char* aName, uint32_t aParams, int aStatic);
} // namespace

RED4ext::CBaseFunction* StaticFunction(const char* aClassName, const char* aName, uint32_t aParamCount)
{
    static std::unordered_map<std::string, RED4ext::CBaseFunction*> functions;
    static std::unordered_set<std::string> listed; // names whose function lists were read (once each)
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
    // Live 2026-10-16 to 21 the chain of NPCPuppet held no function named IsInCombat although the game defines a static
    // of that name there, so a static of a script-defined class may be reachable only through the game's lists of
    // every class function and every global function (full name "Class::Name;signature"). They are large, so they are
    // read once, at the first miss of a name, and a name that is still missing after that is remembered as missing
    // (the hot callers ask on every sample or tick, and a rescan is a hitch on the game thread each time).
    const char* route = "class chain";
    if (!function && type && !listed.count(key))
    {
        auto* rtti = RED4ext::CRTTISystem::Get();
        if (rtti)
        {
            listed.insert(key);
            RED4ext::DynArray<RED4ext::CBaseFunction*> list;
            rtti->GetClassFunctions(list);
            function = ListFunction(list, aClassName, aName, aParamCount, 1);
            route = "class-function list";
            if (!function)
            {
                RED4ext::DynArray<RED4ext::CBaseFunction*> globals;
                rtti->GetGlobalFunctions(globals);
                function = ListFunction(globals, aClassName, aName, aParamCount, -1);
                route = "global-function list";
            }
        }
    }
    if (function)
    {
        CONVAI_INFO("Game access: static %s.%s resolved as %s (%s)", aClassName, aName, function->shortName.ToString(),
                    route);
        functions.emplace(key, function);
    }
    else if (type && listed.count(key))
    {
        // The chain and both lists were searched: it stays missing for the session.
        functions.emplace(key, nullptr);
    }
    if (!function && FirstMiss("static " + key))
    {
        CONVAI_WARN("Game access: no static function %s.%s with %u parameters (%s; also not in the class-function or "
                    "global-function lists)",
                    aClassName, aName, static_cast<unsigned>(aParamCount),
                    type ? Declared(type, aName).c_str() : "the class is not known");
    }
    return function;
}

Object Player()
{
    auto* rtti = RED4ext::CRTTISystem::Get();
    RED4ext::CBaseFunction* function = rtti ? rtti->GetFunction(RED4ext::CName("GetPlayer;GameInstance")) : nullptr;
    // GetPlayer(GameInstance) -> a handle (strong or weak: ExecuteForObject converts either).
    if (!function || !Verified(function, {ArgOf<RED4ext::ScriptGameInstance>()}, Returns::Unchecked()))
    {
        return {};
    }
    RED4ext::ScriptGameInstance gameInstance;
    RED4ext::StackArgs_t args;
    args.emplace_back(nullptr, &gameInstance);
    Object player;
    if (!ExecuteForObject(nullptr, function, args, player))
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
        if (Verified(entry.function, {ArgOf<RED4ext::ScriptGameInstance>()}, Returns::Unchecked()) &&
            ExecuteForObject(nullptr, entry.function, args, system))
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

// ---- the combat flag of a puppet (see GameAccess.hpp) ------------------------------------------
namespace
{
struct CombatState
{
    CombatRoute route = CombatRoute::Unresolved;
    RED4ext::CBaseFunction* function = nullptr;
    RED4ext::CClass* owner = nullptr; // the puppet has to be of this class
    int64_t combatValue = -1;         // gamedataNPCHighLevelState.Combat, for the state route
    uint32_t stateSize = 1;           // bytes of that enum
    uint32_t calls = 0;               // asks while no route was known
    uint32_t attempts = 0;            // resolutions made
    bool settled = false;             // every route was tried, lists included, and none exists: never searched again
    std::string tried;                // the last unresolved attempt, for the probe
};

CombatState& Combat()
{
    static CombatState state;
    return state;
}

const char* RouteName(CombatRoute aRoute)
{
    switch (aRoute)
    {
    case CombatRoute::StaticChain:
        return "static-chain";
    case CombatRoute::StaticClassList:
        return "static-class-list";
    case CombatRoute::StaticGlobal:
        return "static-global";
    case CombatRoute::MemberIsPuppetInCombat:
        return "member-IsPuppetInCombat";
    case CombatRoute::HighLevelState:
        return "state-blackboard";
    case CombatRoute::None:
        return "none";
    default:
        return "unresolved";
    }
}

const char* OwnerOf(RED4ext::CBaseFunction* aFunction)
{
    RED4ext::CClass* owner = aFunction ? aFunction->GetParent() : nullptr;
    return owner ? owner->GetName().ToString() : "";
}

// The function takes one puppet (a ScriptedPuppet or a class derived from it).
bool TakesPuppet(const RED4ext::CBaseFunction* aFunction)
{
    if (!aFunction || aFunction->params.Size() != 1 || !aFunction->params[0] || !aFunction->params[0]->type)
    {
        return false;
    }
    return std::strstr(aFunction->params[0]->type->GetName().ToString(), "Puppet") != nullptr;
}

// A function of the class chain, nearest class first: aStatic selects statics or members, aParams the overload.
RED4ext::CBaseFunction* ChainFunction(RED4ext::CClass* aClass, const char* aName, uint32_t aParams, bool aStatic)
{
    for (RED4ext::CClass* cls = aClass; cls; cls = cls->parent)
    {
        if (aStatic)
        {
            for (RED4ext::CClassStaticFunction* candidate : cls->staticFuncs)
            {
                if (candidate && candidate->params.Size() == aParams && FunctionIs(candidate, aName))
                {
                    return candidate;
                }
            }
        }
        for (RED4ext::CClassFunction* candidate : cls->funcs)
        {
            if (candidate && (candidate->flags.isStatic != 0) == aStatic && candidate->params.Size() == aParams &&
                FunctionIs(candidate, aName))
            {
                return candidate;
            }
        }
    }
    return nullptr;
}

// A function of one of the game's function lists whose owner class is aClass (or whose full name says so).
// aStatic: 1 static only, 0 member only, -1 either (a global function has no static flag).
RED4ext::CBaseFunction* ListFunction(RED4ext::DynArray<RED4ext::CBaseFunction*>& aList, const char* aClass,
                                     const char* aName, uint32_t aParams, int aStatic)
{
    for (RED4ext::CBaseFunction* candidate : aList)
    {
        if (!candidate || candidate->params.Size() != aParams || !FunctionIs(candidate, aName))
        {
            continue;
        }
        if (aStatic >= 0 && (candidate->flags.isStatic != 0) != (aStatic == 1))
        {
            continue;
        }
        if (ScriptNameInClass(candidate->fullName.ToString(), aClass, aName) ||
            std::strcmp(OwnerOf(candidate), aClass) == 0)
        {
            return candidate;
        }
    }
    return nullptr;
}

std::string Describe(RED4ext::CBaseFunction* aFunction)
{
    char text[256];
    std::snprintf(text, sizeof(text), "%s|%s|%up|%s|%s", aFunction->fullName.ToString(),
                  aFunction->shortName.ToString(), static_cast<unsigned>(aFunction->params.Size()),
                  aFunction->flags.isStatic ? "static" : "member", OwnerOf(aFunction));
    return text;
}

bool Mentions(RED4ext::CBaseFunction* aFunction, const char* const* aNeedles, size_t aCount)
{
    const char* full = aFunction->fullName.ToString();
    const char* shortName = aFunction->shortName.ToString();
    for (size_t index = 0; index < aCount; ++index)
    {
        if ((full && std::strstr(full, aNeedles[index])) || (shortName && std::strstr(shortName, aNeedles[index])))
        {
            return true;
        }
    }
    return false;
}

constexpr const char* kCombatNames[] = {"IsInCombat", "IsPuppetInCombat", "GetHighLevelStateFromBlackboard"};
constexpr const char* kCombatWords[] = {"Combat", "HighLevel"};

std::string ChainSummary(RED4ext::CClass* aClass)
{
    std::string out;
    int shown = 0;
    for (RED4ext::CClass* cls = aClass; cls && shown < 10; cls = cls->parent, ++shown)
    {
        out += out.empty() ? "" : " > ";
        out += std::string(cls->GetName().ToString()) + "(" + std::to_string(cls->funcs.Size()) + " funcs, " +
               std::to_string(cls->staticFuncs.Size()) + " statics)";
    }
    return out;
}

std::string ChainCombatNames(RED4ext::CClass* aClass)
{
    std::string out;
    int count = 0;
    for (RED4ext::CClass* cls = aClass; cls; cls = cls->parent)
    {
        auto note = [&](RED4ext::CBaseFunction* aFunction) {
            if (aFunction && count < 12 && Mentions(aFunction, kCombatWords, 2))
            {
                out += (out.empty() ? "" : "; ") + Describe(aFunction);
                ++count;
            }
        };
        for (RED4ext::CClassFunction* function : cls->funcs)
        {
            note(function);
        }
        for (RED4ext::CClassStaticFunction* function : cls->staticFuncs)
        {
            note(function);
        }
    }
    return out.empty() ? std::string("none") : out;
}

std::string ListCombatNames(RED4ext::DynArray<RED4ext::CBaseFunction*>& aList)
{
    std::string out;
    int count = 0;
    for (RED4ext::CBaseFunction* function : aList)
    {
        if (function && count < 14 && Mentions(function, kCombatNames, 3))
        {
            out += (out.empty() ? "" : "; ") + Describe(function);
            ++count;
        }
    }
    return out.empty() ? std::string("none") : out;
}

// Takes a route only when the function matches the way PuppetInCombat calls it: no parameters for a member, the
// puppet (one handle) for a static, and a value that fits the 8-byte buffer (a Bool, or the 1 to 8 byte enum of the
// high-level state). A function of another shape is skipped and the next route is tried.
bool SetCombat(CombatState& aState, CombatRoute aRoute, RED4ext::CBaseFunction* aFunction, RED4ext::CClass* aOwner)
{
    const bool member = aRoute == CombatRoute::MemberIsPuppetInCombat || aRoute == CombatRoute::HighLevelState;
    const Returns returns = aRoute == CombatRoute::HighLevelState ? Returns::Fits(nullptr, 8) : Returns::Fits("Bool", 1);
    const bool matches = member ? Verified(aFunction, {}, returns)
                                : Verified(aFunction, {Arg{"handle", static_cast<uint32_t>(sizeof(Object))}}, returns);
    if (!matches)
    {
        return false;
    }
    aState.route = aRoute;
    aState.function = aFunction;
    aState.owner = aOwner;
    aState.tried.clear();
    CONVAI_INFO("Game access: combat flag read through %s: %s (owner class %s)", RouteName(aRoute),
                Describe(aFunction).c_str(), aOwner ? aOwner->GetName().ToString() : "?");
    return true;
}

void ResolveCombat(CombatState& aState)
{
    auto* rtti = RED4ext::CRTTISystem::Get();
    if (!rtti)
    {
        return;
    }
    ++aState.attempts;
    // The lists of every function are large (tens of thousands of entries, two name lookups each): they are read
    // once, on the first attempt, and the answer then stands for the session (see EnsureCombat).
    const bool deep = aState.attempts == 1;
    RED4ext::CClass* npc = Class("NPCPuppet");
    RED4ext::CClass* scripted = Class("ScriptedPuppet");
    if (!npc || !scripted)
    {
        aState.tried = "the class NPCPuppet or ScriptedPuppet is not known yet";
        return;
    }
    std::string tried;
    auto add = [&](const std::string& aText) { tried += (tried.empty() ? "" : "; ") + aText; };

    // 1. The static on the class chain.
    if (RED4ext::CBaseFunction* function = ChainFunction(npc, "IsInCombat", 1, true))
    {
        if (SetCombat(aState, CombatRoute::StaticChain, function, scripted))
        {
            return;
        }
    }
    add("1 static IsInCombat(1 parameter) on the NPCPuppet class chain: none");

    RED4ext::DynArray<RED4ext::CBaseFunction*> classList;
    RED4ext::DynArray<RED4ext::CBaseFunction*> globalList;
    bool listed = false;
    auto loadLists = [&] {
        if (!listed)
        {
            listed = true;
            rtti->GetClassFunctions(classList);
            rtti->GetGlobalFunctions(globalList);
        }
    };

    // 2. The same static in the list of every class function.
    if (deep)
    {
        loadLists();
        if (RED4ext::CBaseFunction* function = ListFunction(classList, "NPCPuppet", "IsInCombat", 1, 1))
        {
            if (SetCombat(aState, CombatRoute::StaticClassList, function, scripted))
            {
                return;
            }
        }
        add("2 static NPCPuppet::IsInCombat in the class-function list (" + std::to_string(classList.Size()) +
            " entries): none");
    }

    // 3. As a global function.
    for (const char* name : {"NPCPuppet::IsInCombat;ScriptedPuppet", "NPCPuppet::IsInCombat", "IsInCombat;ScriptedPuppet"})
    {
        RED4ext::CBaseFunction* function = rtti->GetFunction(RED4ext::CName(name));
        if (function && TakesPuppet(function))
        {
            if (SetCombat(aState, CombatRoute::StaticGlobal, function, scripted))
            {
                return;
            }
        }
    }
    if (deep)
    {
        if (RED4ext::CBaseFunction* function = ListFunction(globalList, "NPCPuppet", "IsInCombat", 1, -1))
        {
            if (SetCombat(aState, CombatRoute::StaticGlobal, function, scripted))
            {
                return;
            }
        }
    }
    add("3 global function NPCPuppet::IsInCombat (RTTI table, 3 names" +
        std::string(deep ? ", " + std::to_string(globalList.Size()) + " globals listed" : "") + "): none");

    // 4. The member NPCPuppet.IsPuppetInCombat(); the base class has one too that always answers false, so only
    // NPCPuppet's own counts.
    {
        RED4ext::CBaseFunction* function = ChainFunction(npc, "IsPuppetInCombat", 0, false);
        if (function && std::strcmp(OwnerOf(function), "NPCPuppet") != 0)
        {
            function = nullptr;
        }
        if (!function && deep)
        {
            loadLists();
            function = ListFunction(classList, "NPCPuppet", "IsPuppetInCombat", 0, 0);
        }
        if (function)
        {
            if (SetCombat(aState, CombatRoute::MemberIsPuppetInCombat, function, npc))
            {
                return;
            }
        }
        add("4 member NPCPuppet.IsPuppetInCombat(): none");
    }

    // 5. The member ScriptedPuppet.GetHighLevelStateFromBlackboard() against gamedataNPCHighLevelState.Combat.
    {
        RED4ext::CBaseFunction* function = ChainFunction(scripted, "GetHighLevelStateFromBlackboard", 0, false);
        if (!function && deep)
        {
            loadLists();
            function = ListFunction(classList, "ScriptedPuppet", "GetHighLevelStateFromBlackboard", 0, 0);
        }
        RED4ext::CEnum* state = rtti->GetEnum(RED4ext::CName("gamedataNPCHighLevelState"));
        int64_t combat = -1;
        if (state)
        {
            const RED4ext::CName member("Combat");
            for (uint32_t index = 0; index < state->hashList.Size() && index < state->valueList.Size(); ++index)
            {
                if (state->hashList[index] == member)
                {
                    combat = state->valueList[index];
                    break;
                }
            }
        }
        const bool returnsState = function && function->returnType && function->returnType->type &&
                                  function->returnType->type->GetName() == RED4ext::CName("gamedataNPCHighLevelState");
        if (function && returnsState && combat >= 0)
        {
            aState.combatValue = combat;
            aState.stateSize = state->actualSize > 0 && state->actualSize <= 8 ? static_cast<uint32_t>(state->actualSize) : 1;
            if (SetCombat(aState, CombatRoute::HighLevelState, function, scripted))
            {
                return;
            }
        }
        add(std::string("5 member ScriptedPuppet.GetHighLevelStateFromBlackboard() with the enum value: ") +
            (function ? "found" : "function missing") + (returnsState ? "" : ", return type not the state enum") +
            (combat >= 0 ? "" : ", enum member Combat missing"));
    }

    // Nothing resolved: say what the game does have, once. The deep attempt has looked everywhere, so the scripts
    // do not have the function and a later look would only repeat the same scan on the game thread.
    aState.route = CombatRoute::None;
    aState.settled = deep;
    aState.tried = tried;
    CONVAI_WARN("Game access: combat flag: no route resolved (attempt %u); the Lua keeps reading it. Tried: %s",
                aState.attempts, tried.c_str());
    if (deep)
    {
        CONVAI_WARN("Game access: combat flag: NPCPuppet chain: %s", ChainSummary(npc).c_str());
        CONVAI_WARN("Game access: combat flag: chain functions named like Combat or HighLevel: %s",
                    ChainCombatNames(npc).c_str());
        loadLists();
        CONVAI_WARN("Game access: combat flag: class-function list (%u entries): %s",
                    static_cast<unsigned>(classList.Size()), ListCombatNames(classList).c_str());
        CONVAI_WARN("Game access: combat flag: global-function list (%u entries): %s",
                    static_cast<unsigned>(globalList.Size()), ListCombatNames(globalList).c_str());
    }
}

// Resolves when no route is known: the first ask. A failed first ask (the classes are not known yet) is retried
// every 256th call, which costs only the class lookups; once the full scan has found nothing it is not repeated.
bool EnsureCombat(CombatState& aState)
{
    if (aState.function)
    {
        return true;
    }
    if (aState.settled)
    {
        return false;
    }
    if ((aState.calls++ & 0xFF) == 0)
    {
        ResolveCombat(aState);
    }
    return aState.function != nullptr;
}
} // namespace

bool CombatAvailable()
{
    return EnsureCombat(Combat());
}

const char* CombatRouteName()
{
    return RouteName(Combat().route);
}

std::string CombatRouteJson()
{
    const CombatState& state = Combat();
    std::string out = "{\"route\":\"";
    out += RouteName(state.route);
    out += "\",\"function\":\"";
    out += state.function ? JsonEscape(Describe(state.function)) : std::string();
    out += "\",\"attempts\":" + std::to_string(state.attempts);
    out += ",\"tried\":\"" + JsonEscape(state.tried.substr(0, 700)) + "\"}";
    return out;
}

bool PuppetInCombat(const Object& aPuppet, bool& aOut)
{
    if (!aPuppet || !aPuppet.instance)
    {
        return false;
    }
    CombatState& state = Combat();
    if (!EnsureCombat(state))
    {
        return false;
    }
    RED4ext::CClass* type = aPuppet.instance->GetType();
    if (!type || !state.owner || !type->IsA(state.owner))
    {
        return false;
    }
    RED4ext::StackArgs_t args; // a local: another script mod's observer of IsInCombat can re-enter during the call
    uint64_t buffer = 0;
    bool executed = false;
    if (state.route == CombatRoute::MemberIsPuppetInCombat || state.route == CombatRoute::HighLevelState)
    {
        executed = RED4ext::ExecuteFunction(static_cast<void*>(aPuppet.instance), state.function, &buffer);
    }
    else
    {
        args.emplace_back(nullptr, const_cast<Object*>(&aPuppet));
        executed = RED4ext::ExecuteFunction(static_cast<void*>(nullptr), state.function, &buffer, args);
    }
    if (!executed)
    {
        return false;
    }
    if (state.route == CombatRoute::HighLevelState)
    {
        uint64_t value = buffer;
        if (state.stateSize < 8)
        {
            value &= (uint64_t{1} << (8 * state.stateSize)) - 1;
        }
        aOut = static_cast<int64_t>(value) == state.combatValue;
    }
    else
    {
        aOut = (buffer & 0xFF) != 0;
    }
    return true;
}

std::string ProbeJson()
{
    Object player = Player();
    if (!player)
    {
        return R"({"ok":false,"reason":"no player","combat":)" + CombatRouteJson() + "}";
    }
    RED4ext::Vector4 position{};
    if (!Call(player, "GetWorldPosition", &position))
    {
        return R"({"ok":false,"reason":"GetWorldPosition failed","combat":)" + CombatRouteJson() + "}";
    }
    bool inCombat = false;
    const bool combatKnown = Call(player, "IsInCombat", &inCombat);
    const bool isPlayerPuppet = IsA(player, "PlayerPuppet");
    char text[256];
    std::snprintf(text, sizeof(text),
                  R"({"ok":true,"x":%.3f,"y":%.3f,"z":%.3f,"inCombat":%s,"playerPuppet":%s)", position.X,
                  position.Y, position.Z, combatKnown ? (inCombat ? "true" : "false") : "null",
                  isPlayerPuppet ? "true" : "false");
    // How an NPC's combat flag is read: resolved on the first read of a companion (see CombatRoute), so
    // "unresolved" until one exists.
    return std::string(text) + ",\"combat\":" + CombatRouteJson() + "}";
}
} // namespace convai::game
