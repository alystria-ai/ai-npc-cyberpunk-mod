#pragma once

// Calls into the game by name for the vehicle group (vehicles, chauffeur, passage): one resolved
// function per call site, a return value with the right lifetime, and a few global-function
// helpers. Everything goes through the game's own script invoker (RED4ext::ExecuteFunction), the
// same calls CET makes, so a renamed function after a patch makes a call return false ("unavailable")
// and the Lua shim keeps running its own code; nothing throws and nothing is guessed.
//
// Game thread only. Nothing here is held between native calls except function pointers and the
// class they were resolved for (which live as long as the game).

#include "plugin/CheckedCall.hpp"
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

// The resolved functions of one call site, one entry per instance class it has met. A call site is
// often asked about several classes in turn (the mounting check alternates car, NPC and player every
// frame while V rides with a companion), and each new class costs a walk over its whole class chain
// (about 1,500 functions, a name lookup and compare each). So a site keeps a few (class, function)
// pairs, and a class it has already resolved is one pointer compare. A miss is kept too (function
// null): the scripts are loaded by the time any native runs, so the answer for a class does not change
// within a session, and an optional function that a class lacks is not searched for again on every
// sample. When all entries are taken the oldest is replaced.
struct Slot
{
    static constexpr unsigned kEntries = 6;
    struct Entry
    {
        RED4ext::CClass* type = nullptr;
        RED4ext::CBaseFunction* function = nullptr; // null: this class has no such function
    };
    Entry entries[kEntries];
    unsigned next = 0; // the entry to replace when none is free
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

// The return value of a call and the checked invocation live in plugin/CheckedCall.hpp, shared by every system:
// the call is made only when the function's parameters match the typed arguments, and the return value is read
// back only as the kind it is.
using convai::game::Arg;
using convai::game::TypedArg;
using convai::game::Value;
using convai::game::Invoke;

// aObject.aName(args...) with the function cached in aSlot. Each argument names the RTTI type it stands for:
// {{&seatName, "CName"}, {&id, "EntityID"}}.
bool Call(Slot& aSlot, const Object& aObject, const char* aName, Value* aValue,
          std::initializer_list<TypedArg> aArgs = {});
bool CallBool(Slot& aSlot, const Object& aObject, const char* aName, bool& aOut,
              std::initializer_list<TypedArg> aArgs = {});
bool CallNumber(Slot& aSlot, const Object& aObject, const char* aName, double& aOut,
                std::initializer_list<TypedArg> aArgs = {});
bool CallId(Slot& aSlot, const Object& aObject, const char* aName, uint64_t& aOut,
            std::initializer_list<TypedArg> aArgs = {});
// A returned handle; false only when the call failed or the return is not a handle (a null handle
// answers true with aOut empty).
bool CallObject(Slot& aSlot, const Object& aObject, const char* aName, Object& aOut,
                std::initializer_list<TypedArg> aArgs = {});

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
