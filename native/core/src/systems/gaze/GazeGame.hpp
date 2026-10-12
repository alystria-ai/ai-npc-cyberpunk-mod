#pragma once

// Gaze: fills a LookAtAddEvent that Lua created, through RTTI by name.
//
// Lua keeps creating the event (LookAtAddEvent.new()), queuing it on the NPC and removing it, so
// the exact-handle ownership and retry rules in mod/companion-actuator.lua are unchanged. Fill
// does the 30-odd property and method calls that configure the request in one native call.
//
// Game thread only.

#include "plugin/GameAccess.hpp"
#include "systems/gaze/core/GazeCore.hpp"

#include <cstdint>
#include <string>

namespace convai::gaze
{
enum class FillResult : int32_t
{
    Built = 0,       // the event is complete; Lua queues it
    Declined = 1,    // this input could not be built (for example the target provider is missing); Lua builds it itself
    Unavailable = 2, // the game's classes do not match what this code expects; Lua keeps the path for the session
};

FillResult Fill(const convai::game::Object& aEvent, const convai::game::Object& aPlayer, const LookPlan& aPlan);

// Why the last call was not Built (or why the layout did not resolve). Empty after a build.
const std::string& Problem();
} // namespace convai::gaze
