#pragma once

// The natives registration pattern every system uses.
//
// One system = one RTTI class of static functions, named ConvaiNative<System> (the core class is
// plain ConvaiNative). CET reads RTTI directly, so Lua calls them as ConvaiNativeIo.Write(...)
// with no redscript declaration. There is deliberately no .reds file: a .reds "native" that no
// DLL registered would stop the game from starting, while a missing DLL here only means the Lua
// probe fails and the Lua path keeps running.
//
//   static convai::rtti::StaticClass g_class("ConvaiNativeExample");
//
//   static void Add(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
//   {
//       int32_t a = 0, b = 0;
//       convai::rtti::ReadArgs(aFrame, &a, &b);           // reads every param and the ParamEnd
//       convai::rtti::Return(aOut, convai::rtti::Guard("example", [&] { return a + b; }, 0));
//   }
//
//   void RegisterTypes() { g_class.RegisterType(); }
//   void PostRegisterTypes() { g_class.Static("Add", &Add, "Int32", {{"Int32", "a"}, {"Int32", "b"}}); }
//
// Rules:
//   - Natives run on the game thread. Keep them to microseconds: copy, compute, enqueue.
//   - Every native body goes through Guard(): an exception (or, with /EHa, an access violation)
//     is logged, counted against the system, and the fallback is returned. Three faults trip the
//     system's kill switch, so Lua returns to its own path for the rest of the session.
//   - Parameter types are RTTI names: "Bool", "Int32", "Uint32", "Float", "Double", "String",
//     "CName", "Vector4", "handle:entEntity", "whandle:gameObject", ...

#include <RED4ext/RED4ext.hpp>
#include <RED4ext/RTTITypes.hpp>
#include <RED4ext/Scripting/IScriptable.hpp>
#include <RED4ext/Scripting/Utils.hpp>

#include "core/Log.hpp"
#include "core/Switches.hpp"

#include <atomic>
#include <exception>
#include <initializer_list>
#include <string>
#include <utility>

namespace convai::rtti
{
// Never instantiated: the classes only carry static functions.
struct StaticHost : RED4ext::IScriptable
{
    RED4ext::CClass* GetNativeType() override
    {
        return nullptr;
    }
};

struct Param
{
    const char* type;
    const char* name;
};

// Constructing a CClass resolves game addresses through RED4ext, so the class object must not
// exist before RED4ext has loaded us: a global TTypedClass would run the SDK's address resolver
// at DLL load and show a modal error box when the DLL is loaded without RED4ext. StaticClass
// therefore only stores the name; the CClass is built inside RegisterType(), which runs from
// the RTTI register callback that Main(Load) installs. It is never destroyed (RTTI keeps it).
class StaticClass
{
public:
    explicit constexpr StaticClass(const char* aName) noexcept
        : m_name(aName)
    {
    }

    // From the RTTI register callback.
    void RegisterType()
    {
        if (m_class)
        {
            return;
        }
        RED4ext::CNamePool::Add(m_name);
        m_class = new RED4ext::TTypedClass<StaticHost>(m_name);
        m_class->flags = {.isNative = true};
        RED4ext::CRTTISystem::Get()->RegisterType(m_class);
    }

    // From the RTTI post-register callback.
    template<typename TOut>
    void Static(const char* aName, RED4ext::ScriptingFunction_t<TOut> aFunction, const char* aReturnType,
                std::initializer_list<Param> aParams)
    {
        if (!m_class)
        {
            CONVAI_ERROR("RTTI: %s.%s registered before its class", m_name, aName);
            return;
        }
        if (!m_parented)
        {
            m_class->parent = RED4ext::CRTTISystem::Get()->GetClass("IScriptable");
            m_parented = true;
        }
        RED4ext::CBaseFunction::Flags flags{};
        flags.isNative = true;
        flags.isStatic = true;
        flags.isFinal = true;
        auto* function = RED4ext::CClassStaticFunction::Create(m_class, aName, aName, aFunction, flags);
        if (!function)
        {
            CONVAI_ERROR("RTTI: could not create %s.%s", m_name, aName);
            return;
        }
        for (const Param& param : aParams)
        {
            function->AddParam(param.type, param.name);
        }
        if (aReturnType)
        {
            function->SetReturnType(aReturnType);
        }
        m_class->RegisterFunction(function);
    }

    const char* Name() const noexcept
    {
        return m_name;
    }

private:
    const char* m_name;
    RED4ext::TTypedClass<StaticHost>* m_class = nullptr;
    bool m_parented = false;
};

// Reads each parameter in order, then steps over the ParamEnd opcode.
template<typename... T>
void ReadArgs(RED4ext::CStackFrame* aFrame, T*... aOut)
{
    (RED4ext::GetParameter(aFrame, aOut), ...);
    aFrame->code++;
}

inline void ReadNoArgs(RED4ext::CStackFrame* aFrame)
{
    aFrame->code++;
}

template<typename T, typename V>
void Return(T* aOut, V&& aValue)
{
    if (aOut)
    {
        *aOut = std::forward<V>(aValue);
    }
}

inline void Return(RED4ext::CString* aOut, const std::string& aValue)
{
    if (aOut)
    {
        *aOut = RED4ext::CString(aValue.c_str(), static_cast<uint32_t>(aValue.size()));
    }
}

void NoteFault(const char* aSystem, const char* aWhat) noexcept;

// Runs aBody; on any exception logs it, counts it against aSystem and returns aFallback.
template<typename F, typename R>
R Guard(const char* aSystem, F&& aBody, R aFallback) noexcept
{
    try
    {
        return aBody();
    }
    catch (const std::exception& error)
    {
        NoteFault(aSystem, error.what());
    }
    catch (...)
    {
        NoteFault(aSystem, "structured exception");
    }
    return aFallback;
}
} // namespace convai::rtti
