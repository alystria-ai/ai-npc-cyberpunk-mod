#pragma once

// The natives registration pattern every system uses.
//
// One system = one RTTI class of static functions, named ConvaiNative<System> (the core class is
// plain ConvaiNative). CET reads RTTI directly, so Lua calls them as ConvaiNativeIo.Write(...)
// with no redscript declaration. There is deliberately no .reds file: a .reds "native" that no
// DLL registered would stop the game from starting, while a missing DLL here only means the Lua
// probe fails and the Lua path keeps running.
//
//   constinit convai::rtti::StaticClass g_class("ConvaiNativeExample", "example");   // class, system
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
//   // Main calls CommitAll() after every PostRegisterTypes: all natives of the class register, or none.
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

#include "core/Signatures.hpp"

#include <atomic>
#include <exception>
#include <functional>
#include <initializer_list>
#include <string>
#include <utility>
#include <vector>

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
// therefore only stores the names; the CClass is built inside RegisterType(), which runs from
// the RTTI register callback that Main(Load) installs. It is never destroyed (RTTI keeps it).
//
// Registration is all or nothing per system. Static() only records a native; CommitAll() (Main,
// after every system's PostRegisterTypes) then resolves every parameter and return type of the
// whole class against the game's RTTI, builds every function, checks each came out with its
// parameters, and only then adds them to the class. When anything fails, no function is added,
// the system's kill switch is tripped with the reason (the Lua shim reads it through
// ConvaiNative.SystemEnabled and keeps its own path), and the class stays an empty shell that
// Lua cannot call into. Nothing registered by a failed system is ever callable.
class StaticClass
{
public:
    constexpr StaticClass(const char* aName, const char* aSystem) noexcept
        : m_name(aName)
        , m_system(aSystem)
    {
    }

    // From the RTTI register callback. Returns false (and trips the system) when the class could
    // not be built.
    bool RegisterType();

    // From the RTTI post-register callback: records one native, registers nothing yet.
    template<typename TOut>
    void Static(const char* aName, RED4ext::ScriptingFunction_t<TOut> aFunction, const char* aReturnType,
                std::initializer_list<Param> aParams)
    {
        Pending native;
        native.signature.name = aName ? aName : "";
        native.signature.returnType = aReturnType ? aReturnType : "";
        for (const Param& param : aParams)
        {
            native.signature.params.emplace_back(param.type ? param.type : "", param.name ? param.name : "");
        }
        native.create = [aFunction](RED4ext::CClass* aClass, const char* aFunctionName,
                                    RED4ext::CBaseFunction::Flags aFlags) -> RED4ext::CClassFunction* {
            return RED4ext::CClassStaticFunction::Create(aClass, aFunctionName, aFunctionName, aFunction, aFlags);
        };
        Record(std::move(native));
    }

    // Builds and registers everything recorded, or nothing. True when the system is usable.
    bool Commit() noexcept;

    const char* Name() const noexcept
    {
        return m_name;
    }

    const char* System() const noexcept
    {
        return m_system;
    }

    // True once Commit() registered every native.
    bool Registered() const noexcept
    {
        return m_registered;
    }

private:
    struct Pending
    {
        NativeSignature signature;
        std::function<RED4ext::CClassFunction*(RED4ext::CClass*, const char*, RED4ext::CBaseFunction::Flags)> create;
    };

    void Record(Pending&& aNative);
    bool Fail(const std::string& aReason) noexcept;

    const char* m_name;
    const char* m_system;
    RED4ext::TTypedClass<StaticHost>* m_class = nullptr;
    bool m_committed = false;
    bool m_registered = false;
    std::vector<Pending>* m_pending = nullptr; // heap, so the object stays constant-initialised
};

// Commits every class that built its type or recorded a native (a class whose RegisterType failed
// or never ran fails its commit, which trips its system). Runs from the post-register callback
// after every system has recorded its natives.
void CommitAll() noexcept;

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
