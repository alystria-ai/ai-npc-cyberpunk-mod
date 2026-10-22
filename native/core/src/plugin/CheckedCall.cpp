#include "CheckedCall.hpp"

#include "core/Log.hpp"

#include <RED4ext/RTTISystem.hpp>
#include <RED4ext/RTTITypes.hpp>
#include <RED4ext/Scripting/CProperty.hpp>
#include <RED4ext/Scripting/Functions.hpp>
#include <RED4ext/Scripting/Utils.hpp>

#include <cstring>
#include <unordered_map>
#include <unordered_set>

namespace convai::game
{
using RED4ext::CBaseFunction;
namespace rt = RED4ext::rtti;

namespace
{
std::string Describe(const char* aType, uint32_t aSize)
{
    return std::string(aType ? aType : "any type") + (aSize ? " (" + std::to_string(aSize) + " bytes)" : std::string());
}

// The game's type for an expected RTTI name, or null when the game does not know the name.
const rt::IType* ExpectedType(const char* aName)
{
    auto* rtti = RED4ext::CRTTISystem::Get();
    return rtti && aName ? rtti->GetType(RED4ext::CName(aName)) : nullptr;
}

// aActual is the game's type, aExpected the name the call site gave. Empty when they agree.
std::string TypeProblem(const rt::IType* aActual, const char* aExpected, bool aStrongHandleOnly)
{
    if (!aExpected)
    {
        return {};
    }
    if (!aActual)
    {
        return "has no type";
    }
    const rt::ERTTIType kind = aActual->GetType();
    if (std::strcmp(aExpected, "handle") == 0)
    {
        const bool strong = kind == rt::ERTTIType::Handle;
        const bool weak = kind == rt::ERTTIType::WeakHandle;
        if (aStrongHandleOnly ? !strong : !(strong || weak))
        {
            return std::string("is ") + aActual->GetName().ToString() + ", not a " +
                   (aStrongHandleOnly ? "strong " : "") + "handle";
        }
        return {};
    }
    if (const rt::IType* expected = ExpectedType(aExpected))
    {
        if (expected != aActual)
        {
            return std::string("is ") + aActual->GetName().ToString() + ", expected " + aExpected;
        }
        return {};
    }
    // The game's RTTI does not know that name: compare by the name the type carries.
    if (std::strcmp(aActual->GetName().ToString(), aExpected) != 0)
    {
        return std::string("is ") + aActual->GetName().ToString() + ", expected " + aExpected;
    }
    return {};
}

// One parameter against what the call passes. Empty when they agree.
std::string ParamProblem(const CBaseFunction* aFunction, uint32_t aIndex, const char* aType, uint32_t aSize)
{
    const RED4ext::CProperty* param = aFunction->params[aIndex];
    const rt::IType* type = param ? param->type : nullptr;
    if (!type)
    {
        return "parameter " + std::to_string(aIndex) + " has no type";
    }
    // An out parameter may be smaller than the buffer we pass, never larger.
    const uint32_t size = type->GetSize();
    if (aSize != 0 && (param->flags.isOut ? size > aSize : size != aSize))
    {
        return "parameter " + std::to_string(aIndex) + " (" + type->GetName().ToString() + ") is " +
               std::to_string(size) + " bytes, the call passes " + std::to_string(aSize);
    }
    const std::string problem = TypeProblem(type, aType, false);
    return problem.empty() ? problem : "parameter " + std::to_string(aIndex) + " " + problem;
}

// Folds a value into a 64-bit key (the cache of Verified and Invoke).
void Mix(uint64_t& aKey, uint64_t aValue) noexcept
{
    aKey = (aKey ^ aValue) * 0x100000001B3ull + 0x9E3779B97F4A7C15ull;
}

template<typename T>
double As(const unsigned char* aStorage)
{
    T value;
    std::memcpy(&value, aStorage, sizeof(value));
    return static_cast<double>(value);
}
} // namespace

std::string CheckSignature(const CBaseFunction* aFunction, std::initializer_list<Arg> aParams, const Returns& aReturns)
{
    if (!aFunction)
    {
        return "no function";
    }
    if (aFunction->params.Size() != aParams.size())
    {
        return "takes " + std::to_string(aFunction->params.Size()) + " parameters, the call passes " +
               std::to_string(aParams.size());
    }
    uint32_t index = 0;
    for (const Arg& expected : aParams)
    {
        const std::string problem = ParamProblem(aFunction, index, expected.type, expected.size);
        if (!problem.empty())
        {
            return problem;
        }
        ++index;
    }
    const rt::IType* returned = aFunction->returnType ? aFunction->returnType->type : nullptr;
    switch (aReturns.kind)
    {
    case Returns::Kind::Nothing:
        if (aFunction->returnType)
        {
            return std::string("returns ") + (returned ? returned->GetName().ToString() : "a value") +
                   ", the call expects none";
        }
        break;
    case Returns::Kind::Fits:
    {
        if (!returned)
        {
            return "returns nothing, the call expects " + Describe(aReturns.type, aReturns.maxSize);
        }
        if (aReturns.maxSize != 0 && returned->GetSize() > aReturns.maxSize)
        {
            return std::string("returns ") + returned->GetName().ToString() + " (" +
                   std::to_string(returned->GetSize()) + " bytes), the buffer holds " +
                   std::to_string(aReturns.maxSize);
        }
        const std::string problem = TypeProblem(returned, aReturns.type, true);
        if (!problem.empty())
        {
            return "return value " + problem;
        }
        break;
    }
    case Returns::Kind::Unchecked:
        break;
    }
    return {};
}

bool Verified(const CBaseFunction* aFunction, std::initializer_list<Arg> aParams, const Returns& aReturns)
{
    if (!aFunction)
    {
        return false;
    }
    // The call-site shape: the declared types are string literals, so their addresses identify them.
    uint64_t key = reinterpret_cast<uintptr_t>(aFunction) * 0x9E3779B97F4A7C15ull;
    for (const Arg& arg : aParams)
    {
        Mix(key, reinterpret_cast<uintptr_t>(arg.type));
        Mix(key, arg.size);
    }
    Mix(key, static_cast<uint64_t>(aReturns.kind));
    Mix(key, reinterpret_cast<uintptr_t>(aReturns.type));
    Mix(key, aReturns.maxSize);
    static std::unordered_map<uint64_t, bool> results;
    const auto found = results.find(key);
    if (found != results.end())
    {
        return found->second;
    }
    const std::string problem = CheckSignature(aFunction, aParams, aReturns);
    results.emplace(key, problem.empty());
    if (!problem.empty())
    {
        CONVAI_WARN("Game access: %s does not match what the plugin calls it with (%s); that call stays on the Lua path",
                    aFunction->fullName.ToString(), problem.c_str());
    }
    return problem.empty();
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
            std::initializer_list<TypedArg> aArgs)
{
    if (!aFunction || aFunction->params.Size() != aArgs.size())
    {
        return false;
    }
    // The signature check is cached per function and argument shape. The return half is Value's: it is
    // constructed by the function's own return type and read back only as the kind it is.
    uint64_t key = reinterpret_cast<uintptr_t>(aFunction) * 0x9E3779B97F4A7C15ull;
    for (const TypedArg& arg : aArgs)
    {
        Mix(key, reinterpret_cast<uintptr_t>(arg.type));
        Mix(key, arg.size);
    }
    static std::unordered_map<uint64_t, bool> results;
    auto found = results.find(key);
    if (found == results.end())
    {
        std::string problem;
        uint32_t index = 0;
        for (const TypedArg& arg : aArgs)
        {
            problem = ParamProblem(aFunction, index, arg.type, arg.size);
            if (!problem.empty())
            {
                break;
            }
            ++index;
        }
        found = results.emplace(key, problem.empty()).first;
        if (!problem.empty())
        {
            CONVAI_WARN("Game access: %s does not match what the plugin calls it with (%s); that call stays on the Lua "
                        "path",
                        aFunction->fullName.ToString(), problem.c_str());
        }
    }
    if (!found->second)
    {
        return false;
    }
    RED4ext::StackArgs_t args;
    args.reserve(aArgs.size());
    for (const TypedArg& arg : aArgs)
    {
        args.emplace_back(nullptr, arg.value);
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

bool ExecuteForObject(void* aInstance, CBaseFunction* aFunction, RED4ext::StackArgs_t& aArgs, Object& aOut)
{
    if (!aFunction || !aFunction->returnType)
    {
        return false;
    }
    Value value;
    if (!value.Prepare(aFunction))
    {
        return false;
    }
    return RED4ext::ExecuteFunction(aInstance, aFunction, value.Data(), aArgs) && value.Handle(aOut);
}
} // namespace convai::game
