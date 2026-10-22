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

Value::~Value()
{
    if (m_live && m_type)
    {
        m_type->Destruct(m_storage);
    }
}

bool Value::Prepare(const CBaseFunction* aFunction)
{
    if (m_live)
    {
        return false;
    }
    if (!aFunction || !aFunction->returnType || !aFunction->returnType->type)
    {
        return false;
    }
    const rt::IType* type = aFunction->returnType->type;
    if (type->GetSize() > sizeof(m_storage))
    {
        return false;
    }
    m_type = type;
    m_type->Construct(m_storage);
    m_live = true;
    return true;
}

std::string Value::TypeName() const
{
    return m_type ? std::string(m_type->GetName().ToString()) : std::string();
}

bool Value::Bool(bool& aOut) const
{
    if (!m_live || !m_type || m_type->GetType() != rt::ERTTIType::Fundamental ||
        std::strcmp(m_type->GetName().ToString(), "Bool") != 0)
    {
        return false;
    }
    aOut = m_storage[0] != 0;
    return true;
}

namespace
{
template<typename T>
double As(const unsigned char* aStorage)
{
    T value;
    std::memcpy(&value, aStorage, sizeof(value));
    return static_cast<double>(value);
}
} // namespace

bool Value::Number(double& aOut) const
{
    if (!m_live || !m_type)
    {
        return false;
    }
    if (m_type->GetType() == rt::ERTTIType::Enum)
    {
        switch (m_type->GetSize())
        {
        case 1:
            aOut = As<int8_t>(m_storage);
            return true;
        case 2:
            aOut = As<int16_t>(m_storage);
            return true;
        case 4:
            aOut = As<int32_t>(m_storage);
            return true;
        case 8:
            aOut = As<int64_t>(m_storage);
            return true;
        default:
            return false;
        }
    }
    if (m_type->GetType() != rt::ERTTIType::Fundamental)
    {
        return false;
    }
    const char* name = m_type->GetName().ToString();
    if (std::strcmp(name, "Float") == 0)
    {
        aOut = As<float>(m_storage);
    }
    else if (std::strcmp(name, "Double") == 0)
    {
        aOut = As<double>(m_storage);
    }
    else if (std::strcmp(name, "Int8") == 0)
    {
        aOut = As<int8_t>(m_storage);
    }
    else if (std::strcmp(name, "Uint8") == 0)
    {
        aOut = As<uint8_t>(m_storage);
    }
    else if (std::strcmp(name, "Int16") == 0)
    {
        aOut = As<int16_t>(m_storage);
    }
    else if (std::strcmp(name, "Uint16") == 0)
    {
        aOut = As<uint16_t>(m_storage);
    }
    else if (std::strcmp(name, "Int32") == 0)
    {
        aOut = As<int32_t>(m_storage);
    }
    else if (std::strcmp(name, "Uint32") == 0)
    {
        aOut = As<uint32_t>(m_storage);
    }
    else if (std::strcmp(name, "Int64") == 0)
    {
        aOut = As<int64_t>(m_storage);
    }
    else if (std::strcmp(name, "Uint64") == 0)
    {
        aOut = As<uint64_t>(m_storage);
    }
    else
    {
        return false;
    }
    return true;
}

bool Value::Id(uint64_t& aOut) const
{
    if (!m_live || !m_type || m_type->GetSize() != sizeof(uint64_t))
    {
        return false;
    }
    std::memcpy(&aOut, m_storage, sizeof(aOut));
    return true;
}

bool Value::Name(RED4ext::CName& aOut) const
{
    if (!m_live || !m_type || m_type->GetType() != rt::ERTTIType::Name)
    {
        return false;
    }
    std::memcpy(&aOut, m_storage, sizeof(aOut));
    return true;
}

bool Value::Handle(Object& aOut) const
{
    if (!m_live || !m_type)
    {
        return false;
    }
    if (m_type->GetType() == rt::ERTTIType::Handle)
    {
        aOut = *reinterpret_cast<const Object*>(m_storage);
        return true;
    }
    if (m_type->GetType() == rt::ERTTIType::WeakHandle)
    {
        const auto& weak = *reinterpret_cast<const RED4ext::WeakHandle<RED4ext::IScriptable>*>(m_storage);
        aOut = Object(weak);
        return true;
    }
    return false;
}

bool Invoke(RED4ext::IScriptable* aInstance, CBaseFunction* aFunction, Value* aValue,
            std::initializer_list<void*> aArgs)
{
    if (!aFunction || aFunction->params.Size() != aArgs.size())
    {
        return false;
    }
    RED4ext::StackArgs_t args;
    args.reserve(aArgs.size());
    for (void* value : aArgs)
    {
        args.emplace_back(nullptr, value);
    }
    Value scratch;
    Value* value = aValue ? aValue : &scratch;
    void* out = nullptr;
    if (aFunction->returnType)
    {
        if (!value->Prepare(aFunction))
        {
            return false;
        }
        out = value->Data();
    }
    return RED4ext::ExecuteFunction(static_cast<void*>(aInstance), aFunction, out, args);
}

bool Call(Slot& aSlot, const Object& aObject, const char* aName, Value* aValue, std::initializer_list<void*> aArgs)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    CBaseFunction* function = Find(aSlot, aObject.instance, aName, static_cast<uint32_t>(aArgs.size()));
    return function && Invoke(aObject.instance, function, aValue, aArgs);
}

bool CallBool(Slot& aSlot, const Object& aObject, const char* aName, bool& aOut, std::initializer_list<void*> aArgs)
{
    Value value;
    return Call(aSlot, aObject, aName, &value, aArgs) && value.Bool(aOut);
}

bool CallNumber(Slot& aSlot, const Object& aObject, const char* aName, double& aOut,
                std::initializer_list<void*> aArgs)
{
    Value value;
    return Call(aSlot, aObject, aName, &value, aArgs) && value.Number(aOut);
}

bool CallId(Slot& aSlot, const Object& aObject, const char* aName, uint64_t& aOut, std::initializer_list<void*> aArgs)
{
    Value value;
    return Call(aSlot, aObject, aName, &value, aArgs) && value.Id(aOut);
}

bool CallObject(Slot& aSlot, const Object& aObject, const char* aName, Object& aOut,
                std::initializer_list<void*> aArgs)
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
