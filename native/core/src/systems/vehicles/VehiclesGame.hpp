#pragma once

// The game side of the vehicles system: the raw reads of one car (VehiclesCore.hpp decides what they
// mean). The calls are made in the order mod/companion-vehicle-native.lua M.inspect makes them,
// stopping where the Lua would stop. Lua hands over the car entity it already holds; nothing here
// enumerates vehicles, so the world policy stays in Lua (only mod-made and chauffeur-leased cars
// are passed in).
//
// Every read returns false when a game function is missing or a call failed: the native then
// answers "" and the Lua shim runs the original code for that call. Game thread only.

#include "systems/vehicles/VehicleReflect.hpp"
#include "systems/vehicles/core/VehiclesCore.hpp"

#include <cstdint>
#include <string>

namespace convai::vehicles::game
{
using Object = convai::game::Object;

// Lua M.inspect: IsAttached, IsVehicle, IsDestroyed, the AI component, the record id, the seat set
// (HasOccupantSlot, the mounting info of each seat, IsSeatReserved), velocity, the squared gap to
// V, IsPlayerMounted, IsPerformingSceneAnimation.
bool ReadInspect(const Object& aEntity, bool aOwned, InspectRaw& aRaw);

struct MountRead
{
    bool mounted = false;
    uint64_t parent = 0; // entity hash of the mount parent
    std::string seat;
};

// Lua M.mounting: IsAttached, then GetMountingInfoSingleWithObjects(npc).
bool ReadMounting(const Object& aNpc, MountRead& aOut);

// The entity hash of an entity (GetEntityID), 0 when unavailable.
bool ReadEntityHash(const Object& aEntity, uint64_t& aOut);
} // namespace convai::vehicles::game
