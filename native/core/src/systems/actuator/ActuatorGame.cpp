#include "ActuatorGame.hpp"

#include "core/Log.hpp"

#include <RED4ext/RTTISystem.hpp>
#include <RED4ext/Scripting/Natives/Vector4.hpp>

#include <cmath>

namespace convai::actuator::game
{
namespace
{
using RED4ext::CBaseFunction;
using RED4ext::CClass;

// One resolved function per call site, valid for one instance class. The companion bodies are
// all NPCPuppet and the AI component always the same class, so the slot hits every time after the
// first tick; a different class re-resolves (the lookup walks the class hierarchy).
struct Slot
{
    CClass* type = nullptr;
    CBaseFunction* function = nullptr;
    bool resolved = false;
};

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
        CONVAI_WARN("Actuator: %s not found on %s", aName, type->GetName().ToString());
    }
    return aSlot.function;
}

Slot g_isAttached, g_isDead, g_position, g_forward, g_aiController, g_commandState;

// A zero-argument call that returns a Bool. The function is checked (no parameters, a Bool back) before it runs:
// a function of another shape is "unavailable", and Lua reads the value itself.
bool CallBool(Slot& aSlot, const Object& aObject, const char* aName, bool& aOut)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    CBaseFunction* function = Find(aSlot, aObject.instance, aName);
    if (!function || !convai::game::Verified(function, {}, convai::game::Returns::Fits("Bool", 1)))
    {
        return false;
    }
    uint64_t buffer = 0;
    if (!RED4ext::ExecuteFunction(static_cast<void*>(aObject.instance), function, &buffer))
    {
        return false;
    }
    aOut = (buffer & 0xFF) != 0;
    return true;
}

bool CallVector(Slot& aSlot, const Object& aObject, const char* aName, RED4ext::Vector4& aOut)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    CBaseFunction* function = Find(aSlot, aObject.instance, aName);
    if (!function ||
        !convai::game::Verified(function, {},
                                convai::game::Returns::Fits("Vector4", static_cast<uint32_t>(sizeof(RED4ext::Vector4)))))
    {
        return false;
    }
    aOut = RED4ext::Vector4{};
    return RED4ext::ExecuteFunction(static_cast<void*>(aObject.instance), function, &aOut);
}

// The combat flag: whichever route of convai::game::PuppetInCombat resolved (the static NPCPuppet.IsInCombat(npc)
// by script name, or the equivalent members; see GameAccess.hpp). Unknown (false) leaves the flag to the Lua,
// which proves it against its own read; the route is logged once by the game helper.
bool ReadCombat(const Object& aNpc, bool& aOut)
{
    return convai::game::PuppetInCombat(aNpc, aOut);
}

int32_t ReadState(const Object& aNpc, const Object& aCommand)
{
    Object ai;
    if (!aNpc || !aNpc.instance || !aCommand || !aCommand.instance)
    {
        return kStateUnavailable;
    }
    CBaseFunction* controller = Find(g_aiController, aNpc.instance, "GetAIControllerComponent");
    RED4ext::StackArgs_t none;
    // The component comes back as a strong or a weak handle; ExecuteForObject converts either (never a weak
    // reference written into our strong Handle as it is).
    if (!controller || !convai::game::Verified(controller, {}, convai::game::Returns::Unchecked()) ||
        !convai::game::ExecuteForObject(static_cast<void*>(aNpc.instance), controller, none, ai) || !ai || !ai.instance)
    {
        return kStateUnavailable;
    }
    CBaseFunction* function = Find(g_commandState, ai.instance, "GetCommandState");
    // GetCommandState(command) reads the command's fields: one handle in, an enum of at most 8 bytes out, and the
    // object has to be an AICommand.
    if (!function ||
        !convai::game::Verified(function, {convai::game::Arg{"handle", static_cast<uint32_t>(sizeof(Object))}},
                                convai::game::Returns::Fits(nullptr, 8)) ||
        !convai::game::IsA(aCommand, "AICommand"))
    {
        return kStateUnavailable;
    }
    RED4ext::StackArgs_t args; // a local: another mod's observer of the call can re-enter
    args.emplace_back(nullptr, const_cast<Object*>(&aCommand));
    uint64_t buffer = 0; // an enum of 1 to 8 bytes lands in the low bytes
    if (!RED4ext::ExecuteFunction(static_cast<void*>(ai.instance), function, &buffer, args))
    {
        return kStateUnavailable;
    }
    const int32_t state = static_cast<int32_t>(buffer & 0xFF);
    return state < kCommandStateCount ? state : kStateUnavailable;
}
} // namespace

int32_t Capabilities()
{
    // Cached only once every required function was found: a read before the scripts loaded (main
    // menu) must not freeze an incomplete answer for the session.
    static int32_t cached = -1;
    if (cached >= 0)
    {
        return cached;
    }
    int32_t caps = 0;
    CClass* puppet = convai::game::Class("NPCPuppet");
    auto has = [&](CClass* aType, const char* aName) { return aType && aType->GetFunction(aName) != nullptr; };
    caps |= has(puppet, "IsAttached") ? kCapIsAttached : 0;
    caps |= has(puppet, "IsDeadNoStatPool") ? kCapIsDead : 0;
    caps |= has(puppet, "GetWorldPosition") ? kCapWorldPosition : 0;
    caps |= has(puppet, "GetWorldForward") ? kCapWorldForward : 0;
    CClass* ai = convai::game::Class("AIHumanComponent");
    if (!ai)
    {
        ai = convai::game::Class("AIComponent");
    }
    caps |= has(puppet, "GetAIControllerComponent") && has(ai, "GetCommandState") ? kCapCommandState : 0;
    CClass* command = convai::game::Class("AICommand");
    caps |= command && command->GetProperty("id") ? kCapCommandId : 0;
    caps |= convai::game::CombatAvailable() ? kCapInCombat : 0;
    CONVAI_INFO("Actuator: capabilities 0x%x (required 0x%x), combat flag route %s", static_cast<unsigned>(caps),
                static_cast<unsigned>(kCapRequired), convai::game::CombatRouteName());
    if ((caps & kCapRequired) == kCapRequired)
    {
        cached = caps;
    }
    return caps;
}

Life ReadLife(const Object& aNpc)
{
    bool attached = false;
    if (!CallBool(g_isAttached, aNpc, "IsAttached", attached))
    {
        return Life::Unavailable;
    }
    if (!attached)
    {
        return Life::Missing;
    }
    bool dead = false;
    if (!CallBool(g_isDead, aNpc, "IsDeadNoStatPool", dead))
    {
        return Life::Unavailable;
    }
    return dead ? Life::Dead : Life::Alive;
}

int32_t ReadCommandState(const Object& aNpc, const Object& aCommand)
{
    bool attached = false;
    if (!CallBool(g_isAttached, aNpc, "IsAttached", attached) || !attached)
    {
        return kStateUnavailable;
    }
    return ReadState(aNpc, aCommand);
}

std::string Sense(const Object& aNpc, const Object* aCommand, const SenseRequest& aRequest)
{
    RED4ext::Vector4 position{};
    RED4ext::Vector4 forward{};
    if (!CallVector(g_position, aNpc, "GetWorldPosition", position) ||
        !CallVector(g_forward, aNpc, "GetWorldForward", forward))
    {
        return {};
    }
    SenseWire wire;
    wire.x = position.X;
    wire.y = position.Y;
    wire.z = position.Z;
    wire.w = position.W;
    wire.forwardX = forward.X;
    wire.forwardY = forward.Y;
    if (aCommand && *aCommand)
    {
        const int32_t state = ReadState(aNpc, *aCommand);
        if (state != kStateUnavailable)
        {
            wire.flags |= kFlagStateKnown;
            wire.state = state;
        }
        uint32_t id = 0;
        if (convai::game::Property(*aCommand, "id", id))
        {
            wire.flags |= kFlagIdKnown;
            wire.commandId = static_cast<double>(id);
        }
    }
    bool combat = false;
    if (ReadCombat(aNpc, combat))
    {
        wire.flags |= kFlagCombatKnown | (combat ? kFlagInCombat : 0);
    }
    SenseInput input;
    input.hasPrevious = aRequest.hasPrevious;
    input.previousX = aRequest.previousX;
    input.previousY = aRequest.previousY;
    input.x = wire.x;
    input.y = wire.y;
    input.z = wire.z;
    input.forwardX = wire.forwardX;
    input.forwardY = wire.forwardY;
    input.playerX = aRequest.playerX;
    input.playerY = aRequest.playerY;
    input.playerZ = aRequest.playerZ;
    input.step = aRequest.step;
    wire.math = ComputeSense(input);
    return EncodeSense(wire);
}
} // namespace convai::actuator::game
