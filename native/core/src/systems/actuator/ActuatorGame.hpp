#pragma once

// The companion tick's game reads. Lua hands over the body (and the owned AI command, when there
// is one); nothing here enumerates NPCs or chooses targets, so the world policy stays in Lua:
// only mod-spawned copies are ever passed in.
//
// Every read resolves its game function by name once per class (hierarchy included) and caches
// the answer, misses too, so a function a patch renamed turns that one read into "unavailable"
// and Lua keeps asking the game itself for it. Game thread only.

#include "plugin/GameAccess.hpp"

#include "core/ActuatorCore.hpp"

#include <string>

namespace convai::actuator::game
{
using Object = convai::game::Object;

// Resolves everything once and returns the kCap* bits that exist in this game build.
int32_t Capabilities();

// IsAttached, then IsDeadNoStatPool.
Life ReadLife(const Object& aNpc);

// GetAIControllerComponent():GetCommandState(command) -> the AICommandState number, or
// kStateUnavailable when the body is detached, the AI component is gone or the call failed.
int32_t ReadCommandState(const Object& aNpc, const Object& aCommand);

struct SenseRequest
{
    bool hasPrevious = false;
    double previousX = 0.0;
    double previousY = 0.0;
    double playerX = 0.0;
    double playerY = 0.0;
    double playerZ = 0.0;
    double step = 0.1;
};

// Position, forward, command state (when aCommand is set), command id and the in-combat flag, plus
// the tick math, as the wire text. Empty when the position or forward could not be read (or are
// not finite): the shim then runs the original Lua for this companion.
std::string Sense(const Object& aNpc, const Object* aCommand, const SenseRequest& aRequest);
} // namespace convai::actuator::game
