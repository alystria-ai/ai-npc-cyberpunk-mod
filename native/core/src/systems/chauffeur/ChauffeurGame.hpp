#pragma once

// The game side of the chauffeur system: the raw reads behind mod/companion-chauffeur-native.lua
// M.sample (leased-car path) and M.inspectDrive. ChauffeurCore.hpp decides what the reads mean and
// writes the wire text; this file only asks the game, in the order and with the short-circuits of
// the Lua, through the same calls CET makes (vehicles/VehicleReflect.hpp).
//
// What stays in Lua on purpose: the blackboard summon reads, the mounting reads (the vehicles
// plugin already answers those in one call), the car's display name, the record-id string check,
// the localized waypoint name, and IsCommandActive (overloaded in the game scripts).
//
// A section whose read fails (a game function is missing or answers a type this code does not
// know) is written "<tag> !" and the Lua shim runs the whole original sample instead.
// Game thread only.

#include "systems/chauffeur/core/ChauffeurCore.hpp"
#include "systems/vehicles/VehicleReflect.hpp"

#include <cstdint>
#include <string>

namespace convai::chauffeur::game
{
using Object = convai::game::Object;

// The command-receipt facts the Lua shim hands over for the D section.
struct DriveArgs
{
    Object given;            // operation.handle (the command the Lua trip holds), may be empty
    bool hasOperation = false;
    bool hasReceipt = false; // M.driveReceipt(operation) ~= nil and operation.carId == car.id
    double receiptId = 0.0;
    std::string receiptClass;
};

struct SampleArgs
{
    Object npc;    // entry.npc, may be empty
    Object player;
    Object car;    // Game.FindEntityByID(leased.entityID), may be empty
    Object owner;  // entry.system or Game.GetDynamicEntitySystem()
    uint64_t actorHash = 0; // entry.entityID hash, 0 = nil
    uint64_t carHash = 0;   // leased.id, 0 = nil
    DriveArgs drive;
};

// The leased-car sample: "A ... P ... C ... [D ...] U ... W ..." (sections that failed read "X !").
// The D section is present only when the car is live. "" when nothing at all could be read.
std::string Sample(const SampleArgs& aArgs);

// Lua inspectDrive for a car the shim already found: "0" when the entity is not the live leased car,
// else "1 " followed by the D section. "" when the reads failed (the shim runs the original).
std::string Drive(const Object& aCar, uint64_t aCarHash, const DriveArgs& aArgs);
} // namespace convai::chauffeur::game
