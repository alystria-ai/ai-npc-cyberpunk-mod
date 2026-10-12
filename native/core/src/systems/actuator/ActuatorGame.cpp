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

// A zero-argument call that returns a bool (any size the game writes fits the buffer).
bool CallBool(Slot& aSlot, const Object& aObject, const char* aName, bool& aOut)
{
    if (!aObject || !aObject.instance)
    {
        return false;
    }
    CBaseFunction* function = Find(aSlot, aObject.instance, aName);
    if (!function || !function->returnType)
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
    if (!function || !function->returnType)
    {
        return false;
    }
    aOut = RED4ext::Vector4{};
    return RED4ext::ExecuteFunction(static_cast<void*>(aObject.instance), function, &aOut);
}

// NPCPuppet.IsInCombat(npc), a static function resolved once.
struct StaticSlot
{
    CBaseFunction* function = nullptr;
    bool resolved = false;
};
StaticSlot g_combat;

CBaseFunction* CombatFunction()
{
    if (!g_combat.resolved)
    {
        g_combat.resolved = true;
        CClass* type = convai::game::Class("NPCPuppet");
        CBaseFunction* function = type ? type->GetFunction("IsInCombat") : nullptr;
        if (function && function->flags.isStatic && function->params.Size() == 1 && function->returnType)
        {
            g_combat.function = function;
        }
        else
        {
            CONVAI_WARN("Actuator: NPCPuppet.IsInCombat is not a one-argument static function");
        }
    }
    return g_combat.function;
}

bool ReadCombat(const Object& aNpc, bool& aOut)
{
    CBaseFunction* function = CombatFunction();
    if (!function)
    {
        return false;
    }
    static RED4ext::StackArgs_t args;
    args.clear();
    args.emplace_back(nullptr, const_cast<Object*>(&aNpc));
    uint64_t buffer = 0;
    if (!RED4ext::ExecuteFunction(static_cast<void*>(nullptr), function, &buffer, args))
    {
        return false;
    }
    aOut = (buffer & 0xFF) != 0;
    return true;
}

int32_t ReadState(const Object& aNpc, const Object& aCommand)
{
    Object ai;
    if (!aNpc || !aNpc.instance || !aCommand || !aCommand.instance)
    {
        return kStateUnavailable;
    }
    CBaseFunction* controller = Find(g_aiController, aNpc.instance, "GetAIControllerComponent");
    if (!controller || !controller->returnType ||
        !RED4ext::ExecuteFunction(static_cast<void*>(aNpc.instance), controller, &ai) || !ai || !ai.instance)
    {
        return kStateUnavailable;
    }
    CBaseFunction* function = Find(g_commandState, ai.instance, "GetCommandState");
    if (!function || !function->returnType || function->params.Size() != 1)
    {
        return kStateUnavailable;
    }
    static RED4ext::StackArgs_t args;
    args.clear();
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
    static int32_t caps = -1;
    if (caps >= 0)
    {
        return caps;
    }
    caps = 0;
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
    caps |= CombatFunction() ? kCapInCombat : 0;
    CONVAI_INFO("Actuator: capabilities 0x%x (required 0x%x)", static_cast<unsigned>(caps),
                static_cast<unsigned>(kCapRequired));
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
