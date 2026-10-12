// ConvaiNativeActuator: the companion tick's game reads in one call each.
// Lua side: mod/companion-tick-native.lua, used by mod/companions.lua (the per-companion sense
// step, ten times a second) and mod/companion-actuator.lua (the command-state read).
//
//   Capabilities()                       -> Int32   kCap* bits of the game functions this build has
//   Life(npc)                            -> Int32   0 missing, 1 dead, 2 alive, -1 ask the game from Lua
//   CommandState(npc, command)           -> Int32   AICommandState number, -1 unavailable
//   Sense(npc, command, hasPrev, prevX, prevY, playerX, playerY, playerZ, step)  -> String (wire)
//   SenseIdle(npc, hasPrev, prevX, prevY, playerX, playerY, playerZ, step)       -> String (wire)
//
// The npc and the command always come from Lua, which only passes mod-spawned companions and the
// command it owns; nothing here enumerates NPCs. Sense returns "" when the body's position or
// forward vector could not be read, and Lua then runs its original code for that companion.

#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "ActuatorGame.hpp"

namespace
{
using namespace convai;
using actuator::game::Object;

constinit rtti::StaticClass g_class("ConvaiNativeActuator", "actuator");
constexpr const char* kSystem = "actuator";

void Capabilities(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(kSystem, [] { return actuator::game::Capabilities(); }, int32_t{0}));
}

void Life(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    Object npc;
    rtti::ReadArgs(aFrame, &npc);
    rtti::Return(aOut, rtti::Guard(
                           kSystem, [&] { return static_cast<int32_t>(actuator::game::ReadLife(npc)); },
                           static_cast<int32_t>(actuator::Life::Unavailable)));
}

void CommandState(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    Object npc;
    Object command;
    rtti::ReadArgs(aFrame, &npc, &command);
    rtti::Return(aOut, rtti::Guard(kSystem, [&] { return actuator::game::ReadCommandState(npc, command); },
                                   static_cast<int32_t>(actuator::kStateUnavailable)));
}

void Sense(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    Object npc;
    Object command;
    actuator::game::SenseRequest request;
    rtti::ReadArgs(aFrame, &npc, &command, &request.hasPrevious, &request.previousX, &request.previousY,
                   &request.playerX, &request.playerY, &request.playerZ, &request.step);
    rtti::Return(aOut, rtti::Guard(kSystem, [&] { return actuator::game::Sense(npc, &command, request); },
                                   std::string()));
}

void SenseIdle(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    Object npc;
    actuator::game::SenseRequest request;
    rtti::ReadArgs(aFrame, &npc, &request.hasPrevious, &request.previousX, &request.previousY, &request.playerX,
                   &request.playerY, &request.playerZ, &request.step);
    rtti::Return(aOut, rtti::Guard(kSystem, [&] { return actuator::game::Sense(npc, nullptr, request); },
                                   std::string()));
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    // All or nothing: the plugin checks every type of every native before it registers any of them
    // (rtti::CommitAll), and a system with an unknown type is disabled whole.
    g_class.Static("Capabilities", &Capabilities, "Int32", {});
    g_class.Static("Life", &Life, "Int32", {{"handle:gameObject", "npc"}});
    g_class.Static("CommandState", &CommandState, "Int32",
                   {{"handle:gameObject", "npc"}, {"handle:AICommand", "command"}});
    g_class.Static("Sense", &Sense, "String",
                   {{"handle:gameObject", "npc"},
                    {"handle:AICommand", "command"},
                    {"Bool", "hasPrevious"},
                    {"Double", "previousX"},
                    {"Double", "previousY"},
                    {"Double", "playerX"},
                    {"Double", "playerY"},
                    {"Double", "playerZ"},
                    {"Double", "step"}});
    g_class.Static("SenseIdle", &SenseIdle, "String",
                   {{"handle:gameObject", "npc"},
                    {"Bool", "hasPrevious"},
                    {"Double", "previousX"},
                    {"Double", "previousY"},
                    {"Double", "playerX"},
                    {"Double", "playerY"},
                    {"Double", "playerZ"},
                    {"Double", "step"}});
}
} // namespace

CONVAI_SYSTEM(actuator, {
    .name = "actuator",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
