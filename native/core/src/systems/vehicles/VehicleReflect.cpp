#include "systems/vehicles/VehicleReflect.hpp"

#include "core/Log.hpp"

#include <RED4ext/RTTISystem.hpp>
#include <RED4ext/RTTITypes.hpp>
#include <RED4ext/Scripting/Natives/ScriptGameInstance.hpp>
#include <RED4ext/Scripting/Utils.hpp>

#include <cstring>
#include <string>
#include <unordered_map>

namespace convai::vreflect
{
using RED4ext::CBaseFunction;
using RED4ext::CClass;
namespace rt = RED4ext::rtti;

CBaseFunction* Find(Slot& aSlot, RED4ext::IScriptable* aInstance, const char* aName)
{
    CClass* type = aInstance ? aInstance->GetType() : nullptr;
    if (!type)
    {
        return nullptr;
    }
    if (aSlot.resolved && aSlot.type == type)
    {
        return aSlot.function;
    }
    aSlot.type = type;
    aSlot.resolved = true;
    aSlot.function = type->GetFunction(aName);
    if (!aSlot.function)
    {
        CONVAI_WARN("Vehicles: %s not found on %s", aName, type->GetName().ToString());
    }
    return aSlot.function;
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
    if (!aFunction)
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
    CBaseFunction* function = Find(aSlot, aObject.instance, aName);
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
    static std::unordered_map<std::string, CBaseFunction*> functions;
    CBaseFunction* function = nullptr;
    auto found = functions.find(aFunctionName);
    if (found != functions.end())
    {
        function = found->second;
    }
    else
    {
        auto* rtti = RED4ext::CRTTISystem::Get();
        function = rtti ? rtti->GetFunction(RED4ext::CName(aFunctionName)) : nullptr;
        functions.emplace(aFunctionName, function);
        if (!function)
        {
            CONVAI_WARN("Vehicles: global function %s not found", aFunctionName);
        }
    }
    if (!function)
    {
        return {};
    }
    RED4ext::ScriptGameInstance gameInstance;
    Value value;
    if (!value.Prepare(function))
    {
        return {};
    }
    RED4ext::StackArgs_t args;
    args.emplace_back(nullptr, &gameInstance);
    if (!RED4ext::ExecuteFunction(static_cast<void*>(nullptr), function, value.Data(), args))
    {
        return {};
    }
    Object system;
    value.Handle(system);
    return system;
}

CBaseFunction* StaticFunction(const char* aClassName, const char* aName, uint32_t aParamCount)
{
    static std::unordered_map<std::string, CBaseFunction*> functions;
    const std::string key = std::string(aClassName) + "." + aName;
    auto found = functions.find(key);
    if (found != functions.end())
    {
        return found->second;
    }
    CClass* type = convai::game::Class(aClassName);
    CBaseFunction* function = type ? type->GetFunction(aName) : nullptr;
    if (function && !(function->flags.isStatic && function->params.Size() == aParamCount))
    {
        CONVAI_WARN("Vehicles: %s is not a static function with %u parameters", key.c_str(), aParamCount);
        function = nullptr;
    }
    functions.emplace(key, function);
    return function;
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
    if (value < 0)
    {
        CONVAI_WARN("Vehicles: enum member %s not found", key.c_str());
    }
    values.emplace(key, value);
    return value;
}
} // namespace convai::vreflect
