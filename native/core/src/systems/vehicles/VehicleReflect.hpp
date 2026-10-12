#pragma once

// Calls into the game by name for the vehicle group (vehicles, chauffeur, passage): one resolved
// function per call site, a return value with the right lifetime, and a few global-function
// helpers. Everything goes through the game's own script invoker (RED4ext::ExecuteFunction), the
// same calls CET makes, so a renamed function after a patch makes a call return false ("unavailable")
// and the Lua shim keeps running its own code; nothing throws and nothing is guessed.
//
// Game thread only. Nothing here is held between native calls except function pointers and the
// class they were resolved for (which live as long as the game).

#include "plugin/GameAccess.hpp"

#include <RED4ext/CName.hpp>
#include <RED4ext/RED4ext.hpp>
#include <RED4ext/Scripting/Stack.hpp>

#include <cstdint>
#include <initializer_list>
#include <string>

namespace convai::vreflect
{
using Object = convai::game::Object;

// A resolved function for one call site, valid for one instance class. The lookup walks the class
// hierarchy and is cached (misses too), so a call site costs one lookup per class per session.
struct Slot
{
    RED4ext::CClass* type = nullptr;
    RED4ext::CBaseFunction* function = nullptr;
    bool resolved = false;
};

RED4ext::CBaseFunction* Find(Slot& aSlot, RED4ext::IScriptable* aInstance, const char* aName);

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

// aInstance.function(args...). The args are pointers to values of the parameter types, in order
// (every parameter, optional ones included). aValue receives the return value (may be null for a
// function that returns nothing; a returned value that is not wanted is still released).
bool Invoke(RED4ext::IScriptable* aInstance, RED4ext::CBaseFunction* aFunction, Value* aValue,
            std::initializer_list<void*> aArgs = {});

// aObject.aName(args...) with the function cached in aSlot.
bool Call(Slot& aSlot, const Object& aObject, const char* aName, Value* aValue,
          std::initializer_list<void*> aArgs = {});
bool CallBool(Slot& aSlot, const Object& aObject, const char* aName, bool& aOut,
              std::initializer_list<void*> aArgs = {});
bool CallNumber(Slot& aSlot, const Object& aObject, const char* aName, double& aOut,
                std::initializer_list<void*> aArgs = {});
bool CallId(Slot& aSlot, const Object& aObject, const char* aName, uint64_t& aOut,
            std::initializer_list<void*> aArgs = {});
// A returned handle; false only when the call failed or the return is not a handle (a null handle
// answers true with aOut empty).
bool CallObject(Slot& aSlot, const Object& aObject, const char* aName, Object& aOut,
                std::initializer_list<void*> aArgs = {});

// A GameInstance.<Something>(gameInstance) global such as "GetMountingFacility;GameInstance":
// the system handle, or empty when the function or the world is missing.
Object GlobalSystem(const char* aFunctionName);

// A static function of a class (NPCPuppet.IsInCombat, PlayerPuppet.GetCurrentVehicleState ...),
// resolved once. Null when it is not a static function with aParamCount parameters.
RED4ext::CBaseFunction* StaticFunction(const char* aClassName, const char* aName, uint32_t aParamCount);

// The numeric value of an enum member by its name ("Passenger"), -1 when the enum or member is unknown.
int64_t EnumValue(const char* aEnumName, const char* aMemberName);
} // namespace convai::vreflect
