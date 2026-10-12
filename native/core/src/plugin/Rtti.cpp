#include "Rtti.hpp"

#include <RED4ext/RTTISystem.hpp>

#include <algorithm>
#include <mutex>
#include <string>
#include <unordered_map>

namespace convai::rtti
{
void NoteFault(const char* aSystem, const char* aWhat) noexcept
{
    try
    {
        static std::mutex mutex;
        static std::unordered_map<std::string, int> faults;
        int count = 0;
        {
            std::lock_guard<std::mutex> lock(mutex);
            count = ++faults[aSystem ? aSystem : "?"];
        }
        CONVAI_ERROR("Native fault in %s (%d): %s", aSystem ? aSystem : "?", count, aWhat ? aWhat : "");
        if (count >= 3)
        {
            GlobalSwitches().Trip(aSystem ? aSystem : "?", "3 faults in its natives");
        }
    }
    catch (...)
    {
    }
}

namespace
{
std::vector<StaticClass*>& Registry()
{
    static std::vector<StaticClass*> classes;
    return classes;
}

void Enroll(StaticClass* aClass)
{
    auto& classes = Registry();
    if (std::find(classes.begin(), classes.end(), aClass) == classes.end())
    {
        classes.push_back(aClass);
    }
}
} // namespace

bool StaticClass::Fail(const std::string& aReason) noexcept
{
    m_registered = false;
    try
    {
        CONVAI_ERROR("RTTI: %s (%s) not registered, system %s is disabled and Lua keeps its own path: %s", m_name,
                     m_system ? m_system : "?", m_system ? m_system : "?", aReason.c_str());
        GlobalSwitches().Trip(m_system ? m_system : m_name, "natives not registered: " + aReason);
    }
    catch (...)
    {
    }
    return false;
}

bool StaticClass::RegisterType()
{
    Enroll(this);
    if (m_class)
    {
        return true;
    }
    try
    {
        auto* rtti = RED4ext::CRTTISystem::Get();
        if (!rtti)
        {
            return Fail("the RTTI system is not available");
        }
        RED4ext::CNamePool::Add(m_name);
        auto* type = new RED4ext::TTypedClass<StaticHost>(m_name);
        type->flags = {.isNative = true};
        rtti->RegisterType(type);
        m_class = type;
        return true;
    }
    catch (const std::exception& error)
    {
        return Fail(std::string("class registration threw: ") + error.what());
    }
    catch (...)
    {
        return Fail("class registration threw a structured exception");
    }
}

void StaticClass::Record(Pending&& aNative)
{
    Enroll(this);
    if (!m_pending)
    {
        m_pending = new std::vector<Pending>();
    }
    m_pending->push_back(std::move(aNative));
}

bool StaticClass::Commit() noexcept
{
    if (m_committed)
    {
        return m_registered;
    }
    m_committed = true;
    if (m_system && GlobalSwitches().Tripped(m_system))
    {
        // The system already failed (its registration threw half way): none of what it recorded
        // is registered.
        m_registered = false;
        return false;
    }
    try
    {
        if (!m_class)
        {
            return Fail("the class was never registered");
        }
        auto* rtti = RED4ext::CRTTISystem::Get();
        auto* parent = rtti ? rtti->GetClass("IScriptable") : nullptr;
        if (!parent)
        {
            return Fail("the game's IScriptable class is not available");
        }
        const std::vector<Pending> none;
        const std::vector<Pending>& pending = m_pending ? *m_pending : none;
        if (pending.empty())
        {
            return Fail("the system recorded no natives");
        }

        // 1. Every type of every native must exist. Nothing is built before this passes.
        std::vector<NativeSignature> signatures;
        signatures.reserve(pending.size());
        for (const Pending& native : pending)
        {
            signatures.push_back(native.signature);
        }
        const std::string problem = CheckSignatures(signatures, [rtti](const std::string& aType) {
            return rtti->GetType(RED4ext::CName(aType.c_str())) != nullptr;
        });
        if (!problem.empty())
        {
            return Fail(problem);
        }

        // 2. Build every function and prove each kept all its parameters and its return type.
        if (!m_class->parent)
        {
            m_class->parent = parent;
        }
        RED4ext::CBaseFunction::Flags flags{};
        flags.isNative = true;
        flags.isStatic = true;
        flags.isFinal = true;
        std::vector<RED4ext::CClassFunction*> built;
        built.reserve(pending.size());
        for (const Pending& native : pending)
        {
            const std::string& name = native.signature.name;
            RED4ext::CClassFunction* function = native.create ? native.create(m_class, name.c_str(), flags) : nullptr;
            if (!function)
            {
                return Fail("could not create " + name);
            }
            for (const auto& param : native.signature.params)
            {
                if (!function->AddParam(RED4ext::CName(param.first.c_str()), param.second.c_str()))
                {
                    return Fail(name + " parameter '" + param.second + "' (" + param.first + ") was refused");
                }
            }
            if (!native.signature.returnType.empty() &&
                !function->SetReturnType(RED4ext::CName(native.signature.returnType.c_str())))
            {
                return Fail(name + " return type " + native.signature.returnType + " was refused");
            }
            if (function->params.Size() != native.signature.params.size())
            {
                return Fail(name + " has " + std::to_string(function->params.Size()) + " parameters, expected " +
                            std::to_string(native.signature.params.size()));
            }
            if (!native.signature.returnType.empty() && !function->returnType)
            {
                return Fail(name + " has no return type");
            }
            built.push_back(function);
        }

        // 3. Only now does the class gain functions.
        for (RED4ext::CClassFunction* function : built)
        {
            m_class->RegisterFunction(function);
        }
        for (const Pending& native : pending)
        {
            if (!m_class->GetFunction(native.signature.name.c_str()))
            {
                return Fail(native.signature.name + " is missing after registration");
            }
        }
        m_registered = true;
        CONVAI_INFO("RTTI: %s registered %zu natives (system %s)", m_name, pending.size(), m_system ? m_system : "?");
        return true;
    }
    catch (const std::exception& error)
    {
        return Fail(std::string("registration threw: ") + error.what());
    }
    catch (...)
    {
        return Fail("registration threw a structured exception");
    }
}

void CommitAll() noexcept
{
    try
    {
        for (StaticClass* type : Registry())
        {
            type->Commit();
        }
    }
    catch (...)
    {
    }
}
} // namespace convai::rtti
