#pragma once

// The one way every system calls a game function it found by name.
//
// RED4ext's ExecuteFunction trusts its caller completely: it never compares the number of arguments with
// what the function declares, it reads each argument through the function's own parameter type, and it
// writes the return value, whatever its size, into the buffer it is given. A function found by name alone
// (the game's RTTI has no signatures to match against) can change in a patch, or be shadowed by another
// script mod's function of the same name on a subclass, and then the call reads past our arguments or
// overruns our return buffer. So no call is made until the function has been checked against what the call
// site expects, and a function that does not match is a logged miss: the system reports "unavailable" and
// the Lua shim keeps its own path, exactly as for a function that does not exist.
//
// The check is made once per function and call-site shape and cached, so a call costs one small hash lookup.
// What is checked:
//   - the parameter count;
//   - each parameter: its size, and its RTTI type (by identity with the type the game knows under the
//     expected name; "handle" accepts a strong or a weak handle, which have the same layout; nullptr checks
//     the size only, for a struct whose RTTI name the plugin does not rely on);
//   - the return value: that there is none when none is expected, otherwise that it fits the buffer the
//     caller supplies and is the expected type.
// Value (below) is the other half: a return value constructed by the function's own return type and
// destroyed with it, so handles, strings and arrays are released like a script local, and read back only
// as the kind it really is.
//
// Game thread only.

#include <RED4ext/CName.hpp>
#include <RED4ext/RED4ext.hpp>
#include <RED4ext/Scripting/Natives/Vector4.hpp>
#include <RED4ext/Scripting/Stack.hpp>

#include <cstdint>
#include <initializer_list>
#include <string>
#include <type_traits>

namespace convai::game
{
using Object = RED4ext::Handle<RED4ext::IScriptable>;

// One expected parameter. type: the RTTI name the script uses ("Bool", "Float", "CName", "Vector4", "EntityID",
// "String"), or "handle" for any handle, or nullptr to check the size only. size: bytes of the C++ object the
// call site passes (0: not checked). An `out` parameter may be declared smaller than our buffer, never larger.
struct Arg
{
    const char* type = nullptr;
    uint32_t size = 0;
};

// What the call site expects back.
struct Returns
{
    enum class Kind : uint8_t
    {
        Nothing,   // the function returns no value
        Fits,      // a value of `type` (nullptr: any) that fits in `maxSize` bytes
        Unchecked, // the caller reads the value through a Value, which checks the type it reads
    };
    Kind kind = Kind::Unchecked;
    const char* type = nullptr;
    uint32_t maxSize = 0;

    static constexpr Returns Nothing() noexcept
    {
        return {Kind::Nothing, nullptr, 0};
    }
    // "handle" requires a strong handle: a buffer that is a strong Handle must not receive a weak one.
    static constexpr Returns Fits(const char* aType, uint32_t aMaxSize) noexcept
    {
        return {Kind::Fits, aType, aMaxSize};
    }
    static constexpr Returns Unchecked() noexcept
    {
        return {Kind::Unchecked, nullptr, 0};
    }
};

// Empty when aFunction takes the parameters listed and returns what aReturns says; otherwise why not.
std::string CheckSignature(const RED4ext::CBaseFunction* aFunction, std::initializer_list<Arg> aParams,
                           const Returns& aReturns);

// CheckSignature, cached per function and call-site shape. A mismatch is logged once (WARN) with the function's
// full name and the reason, and answers false for every later call.
bool Verified(const RED4ext::CBaseFunction* aFunction, std::initializer_list<Arg> aParams, const Returns& aReturns);

template<typename T>
struct IsHandle : std::false_type
{
};
template<typename T>
struct IsHandle<RED4ext::Handle<T>> : std::true_type
{
};
template<typename T>
struct IsHandle<RED4ext::WeakHandle<T>> : std::true_type
{
};

// The RTTI name a C++ type stands for in Arg and Returns: nullptr for any type this does not know, which then
// checks the size only. Integers are deliberately not named: the same 4 or 8 bytes carry an Int32, an enum or an
// ID in the game's RTTI, and the call sites pass whichever integer is at hand.
template<typename T>
constexpr const char* RttiNameOf() noexcept
{
    using U = std::remove_cv_t<std::remove_reference_t<T>>;
    if constexpr (std::is_same_v<U, bool>)
    {
        return "Bool";
    }
    else if constexpr (std::is_same_v<U, float>)
    {
        return "Float";
    }
    else if constexpr (std::is_same_v<U, double>)
    {
        return "Double";
    }
    else if constexpr (std::is_same_v<U, RED4ext::CName>)
    {
        return "CName";
    }
    else if constexpr (std::is_same_v<U, RED4ext::CString>)
    {
        return "String";
    }
    else if constexpr (std::is_same_v<U, RED4ext::Vector4>)
    {
        return "Vector4";
    }
    else if constexpr (IsHandle<U>::value)
    {
        return "handle";
    }
    else
    {
        return nullptr;
    }
}

template<typename T>
constexpr Arg ArgOf() noexcept
{
    return Arg{RttiNameOf<T>(), static_cast<uint32_t>(sizeof(std::remove_cv_t<std::remove_reference_t<T>>))};
}

// The return value of a call, constructed by the function's own return type and destroyed with
// it, so handles, strings and arrays are released exactly like a script local.
class Value
{
public:
    Value() = default;
    ~Value();
    Value(const Value&) = delete;
    Value& operator=(const Value&) = delete;

    // False when the function returns nothing or the value is bigger than the buffer.
    bool Prepare(const RED4ext::CBaseFunction* aFunction);
    void* Data()
    {
        return m_storage;
    }
    const void* Data() const
    {
        return m_storage;
    }
    // The RTTI name of the return type ("" when not prepared).
    std::string TypeName() const;

    bool Bool(bool& aOut) const;
    // Any integer, enum, Float or Double, widened to a double.
    bool Number(double& aOut) const;
    // An 8-byte struct: EntityID, TweakDBID, MappinID ...
    bool Id(uint64_t& aOut) const;
    bool Name(RED4ext::CName& aOut) const;
    // A Handle or WeakHandle; aOut is empty for a null handle. False for any other type.
    bool Handle(Object& aOut) const;

private:
    alignas(16) unsigned char m_storage[96] = {};
    const RED4ext::rtti::IType* m_type = nullptr;
    bool m_live = false;
};

// One argument of a call whose argument list is built by hand: a pointer to a value of the parameter's type, and
// what the call site says that type is. The C++ type of the pointee gives the size; aType is the RTTI name as in Arg.
struct TypedArg
{
    void* value = nullptr;
    const char* type = nullptr;
    uint32_t size = 0;

    template<typename T>
    TypedArg(T* aValue, const char* aType = RttiNameOf<T>()) noexcept
        : value(aValue)
        , type(aType)
        , size(static_cast<uint32_t>(sizeof(T)))
    {
    }
    // A raw buffer (an enum, an array's storage): the size is the caller's to state.
    TypedArg(void* aValue, const char* aType, uint32_t aSize) noexcept
        : value(aValue)
        , type(aType)
        , size(aSize)
    {
    }
};

// aInstance.function(args...) (aInstance null for a static function). Every parameter is passed, optional ones
// included; the call is made only when the function matches the arguments (count, sizes, types). aValue receives
// the return value (may be null: a returned value that is not wanted is still released).
bool Invoke(RED4ext::IScriptable* aInstance, RED4ext::CBaseFunction* aFunction, Value* aValue,
            std::initializer_list<TypedArg> aArgs = {});

// A function whose return value is an object: runs it and fills aOut from a strong or a weak handle (the return
// type decides, so the strong Handle buffer never receives a weak reference). False for any other return type.
// aArgs is the argument list as the SDK wants it; the caller has checked the parameters.
bool ExecuteForObject(void* aInstance, RED4ext::CBaseFunction* aFunction, RED4ext::StackArgs_t& aArgs, Object& aOut);
} // namespace convai::game
