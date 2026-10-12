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
// hierarchy and a hit is cached, so a call site costs one lookup per class per session. A miss is
// not cached (the scripts may not have finished loading); it is logged once per name and class.
struct Slot
{
    RED4ext::CClass* type = nullptr;
    RED4ext::CBaseFunction* function = nullptr;
    bool resolved = false;
};

// The member function aName of the instance's class chain that takes exactly aParamCount parameters.
//
// CClass::GetFunction(shortName) is not enough here: it answers the first function of that short
// name, statics before members, class by class. The game declares several overloads under one name
// (IsAttached and IsVehicle exist as members and as static functions that take a GameObject; IsInCombat
// is a member of one class and a static of ScriptedPuppet; IsDestroyed is a member and a static
// taking a GameInstance and an EntityID), so the first match can be a function with other parameters.
// This lookup skips static functions and any overload with another parameter count, nearest class first.
RED4ext::CBaseFunction* FindMember(RED4ext::CClass* aType, const char* aName, uint32_t aParamCount);

RED4ext::CBaseFunction* Find(Slot& aSlot, RED4ext::IScriptable* aInstance, const char* aName, uint32_t aParamCount);

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

// A GameInstance.<Something>(gameInstance) system getter named like "GetMountingFacility;GameInstance"
// (the text after the ';' is ignored): the system handle, or empty when the function or the world is
// missing. The game declares these as native static functions of the class GameInstance, not as global
// functions (the first live run found no global of that name); convai::game::GameSystem finds them
// there, logs the route it used once, and falls back to the instance's own system lookup.
Object GlobalSystem(const char* aFunctionName);

// A static function of a class or of the nearest base class that declares it, with exactly aParamCount
// parameters, resolved once. The name is matched as a script name (convai::game::FunctionIs): the game
// registers NPCPuppet's static IsInCombat(puppet) as "IsInCombat;ScriptedPuppet". Null when there is none.
// aClassName is the game's native class name (script-defined classes have no other name).
RED4ext::CBaseFunction* StaticFunction(const char* aClassName, const char* aName, uint32_t aParamCount);

// The numeric value of an enum member by its name ("Passenger"), -1 when the enum or member is unknown.
// aEnumName is the game's native enum name (gamePSMVehicle, gamedataVehicleType ...).
int64_t EnumValue(const char* aEnumName, const char* aMemberName);
} // namespace convai::vreflect
