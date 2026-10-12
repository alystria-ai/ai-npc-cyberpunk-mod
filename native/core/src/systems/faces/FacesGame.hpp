#pragma once

// The game side of the faces system: the ConvaiFaceFeature object and the actor checks.
//
// Everything resolves through RTTI by name (plugin/GameAccess.hpp) and every function returns a
// "not available" answer instead of throwing, so a renamed class or function after a patch hands
// the frame back to the Lua path (status -3 / answer -1), it never crashes.

#include "plugin/GameAccess.hpp"
#include "systems/faces/core/FacesCore.hpp"

#include <cstdint>
#include <string>

namespace convai::faces::game
{
// Writes every field the frame marked into the ConvaiFaceFeature object (float properties found
// once per class by name). False when the object's class lacks a field that has to be written;
// then nothing was written.
bool WriteFields(RED4ext::IScriptable* aFeature, const FrameOutput& aOut);

// actor.ConvaiFaceApply(feature). Result: 1 applied, 0 the game rejected the frame, -1 the
// function could not be called.
int ApplyFeature(const convai::game::Object& aActor, const convai::game::Object& aFeature);

// Lua speaker(): the entity id matches, attached, not dead, and ConvaiFaceReady(). 1 yes, 0 no,
// -1 a call was unavailable (Lua then runs its own check).
int SpeakerCheck(const convai::game::Object& aActor, std::uint64_t aEntityHash);

// Lua safeExpressionActor(): autonomous AI, not in combat, not in a scene or dialogue, no
// injury or incapacitation status. 1 safe, 0 not, -1 a call was unavailable.
int SafeCheck(const convai::game::Object& aActor);

// Which pieces resolved, as JSON, for ConvaiNativeFaces.Info().
std::string InfoJson();
} // namespace convai::faces::game
