#include "systems/vehicles/VehicleReflect.hpp"

#include "core/Log.hpp"

#include <RED4ext/RTTISystem.hpp>
#include <RED4ext/RTTITypes.hpp>
#include <RED4ext/Scripting/Natives/ScriptGameInstance.hpp>
#include <RED4ext/Scripting/Utils.hpp>

#include <cstring>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace convai::vreflect
{
using RED4ext::CBaseFunction;
using RED4ext::CClass;
namespace rt = RED4ext::rtti;

namespace
{
// True the first time a message key is reported, so a name the game does not have is logged once.
bool FirstMiss(const std::string& aKey)
{
    static std::unordered_set<std::string> reported;
    return reported.insert(aKey).second;
}
} // namespace

namespace
{
// "name(2 member on A, 0 static on B)": what the class chain does have under a short name, for the
// log line of a miss (an overload with other parameters is the usual reason).
std::string Candidates(CClass* aType, const char* aName)
{
    std::string text;
    for (CClass* type = aType; type; type = type->parent)
    {
        auto note = [&](const CBaseFunction* aFunction) {
            if (aFunction && convai::game::FunctionIs(aFunction, aName))
            {
                text += text.empty() ? "" : ", ";
                text += std::to_string(aFunction->params.Size()) + (aFunction->flags.isStatic ? " static on " : " member on ");
                text += type->GetName().ToString();
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
    return text.empty() ? std::string("none under that name") : text;
}
} // namespace

CBaseFunction* FindMember(CClass* aType, const char* aName, uint32_t aParamCount)
{
    if (!aType || !aName || !*aName)
    {
        return nullptr;
    }
    for (CClass* type = aType; type; type = type->parent)
    {
        for (RED4ext::CClassFunction* function : type->funcs)
        {
            if (function && convai::game::FunctionIs(function, aName) && !function->flags.isStatic &&
                function->params.Size() == aParamCount)
            {
                return function;
            }
        }
    }
    return nullptr;
}

CBaseFunction* Find(Slot& aSlot, RED4ext::IScriptable* aInstance, const char* aName, uint32_t aParamCount)
{
    CClass* type = aInstance ? aInstance->GetType() : nullptr;
    if (!type)
    {
        return nullptr;
    }
    for (const Slot::Entry& entry : aSlot.entries)
    {
        if (entry.type == type)
        {
            return entry.function;
        }
    }
    CBaseFunction* function = FindMember(type, aName, aParamCount);
    Slot::Entry* entry = nullptr;
    for (Slot::Entry& candidate : aSlot.entries)
    {
        if (!candidate.type)
        {
            entry = &candidate;
            break;
        }
    }
    if (!entry)
    {
        entry = &aSlot.entries[aSlot.next];
        aSlot.next = (aSlot.next + 1) % Slot::kEntries;
    }
    entry->type = type;
    entry->function = function;
    if (!function && FirstMiss(std::string(type->GetName().ToString()) + "." + aName))
    {
        CONVAI_WARN("Vehicles: no member %s with %u parameters on %s (has: %s)", aName,
                    static_cast<unsigned>(aParamCount), type->GetName().ToString(), Candidates(type, aName).c_str());
    }
    return function;
}

bool Call(Slot& aSlot, const Object& aObject, const char* aName, Value* aValue, std::initializer_list<TypedArg> aArgs)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    CBaseFunction* function = Find(aSlot, aObject.instance, aName, static_cast<uint32_t>(aArgs.size()));
    return function && Invoke(aObject.instance, function, aValue, aArgs);
}

bool CallBool(Slot& aSlot, const Object& aObject, const char* aName, bool& aOut, std::initializer_list<TypedArg> aArgs)
{
    Value value;
    return Call(aSlot, aObject, aName, &value, aArgs) && value.Bool(aOut);
}

bool CallNumber(Slot& aSlot, const Object& aObject, const char* aName, double& aOut,
                std::initializer_list<TypedArg> aArgs)
{
    Value value;
    return Call(aSlot, aObject, aName, &value, aArgs) && value.Number(aOut);
}

bool CallId(Slot& aSlot, const Object& aObject, const char* aName, uint64_t& aOut, std::initializer_list<TypedArg> aArgs)
{
    Value value;
    return Call(aSlot, aObject, aName, &value, aArgs) && value.Id(aOut);
}

bool CallObject(Slot& aSlot, const Object& aObject, const char* aName, Object& aOut,
                std::initializer_list<TypedArg> aArgs)
{
    Value value;
    return Call(aSlot, aObject, aName, &value, aArgs) && value.Handle(aOut);
}

Object GlobalSystem(const char* aFunctionName)
{
    // "GetMountingFacility;GameInstance" -> GameInstance.GetMountingFacility, which the game declares as a
    // static function of the class GameInstance (not a global function; see convai::game::GameSystem).
    std::string shortName(aFunctionName ? aFunctionName : "");
    const size_t semicolon = shortName.find(';');
    if (semicolon != std::string::npos)
    {
        shortName.resize(semicolon);
    }
    return convai::game::GameSystem(shortName.c_str());
}

CBaseFunction* StaticFunction(const char* aClassName, const char* aName, uint32_t aParamCount)
{
    return convai::game::StaticFunction(aClassName, aName, aParamCount);
}

int64_t EnumValue(const char* aEnumName, const char* aMemberName)
{
    static std::unordered_map<std::string, int64_t> values;
    const std::string key = std::string(aEnumName) + "." + aMemberName;
    auto found = values.find(key);
    if (found != values.end())
    {
        return found->second;
    }
    int64_t value = -1;
    auto* rtti = RED4ext::CRTTISystem::Get();
    RED4ext::CEnum* type = rtti ? rtti->GetEnum(RED4ext::CName(aEnumName)) : nullptr;
    if (type)
    {
        const RED4ext::CName member(aMemberName);
        for (uint32_t index = 0; index < type->hashList.Size() && index < type->valueList.Size(); ++index)
        {
            if (type->hashList[index] == member)
            {
                value = type->valueList[index];
                break;
            }
        }
    }
    if (value >= 0)
    {
        values.emplace(key, value);
    }
    else if (FirstMiss("enum " + key))
    {
        CONVAI_WARN("Vehicles: enum member %s not found", key.c_str());
    }
    return value;
}
} // namespace convai::vreflect
