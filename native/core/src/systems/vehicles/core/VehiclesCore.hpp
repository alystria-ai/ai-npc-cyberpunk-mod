#pragma once

// Vehicle inspection, game-free part. Ported from mod/companion-vehicle-native.lua: M.inspect (the
// seat, speed and scene read of one car, about 58 CET calls and 35 property reads per car) and the
// negative answer of M.mounting (is this body mounted to anything).
//
// The game side (VehiclesGame.cpp) only collects the raw reads, in the same order the Lua makes
// them; everything the Lua decides after the reads is decided here, so the headless tests replay
// what the real Lua module recorded (tests/fixtures/vehicles-inspect.json) with no game. The Lua
// shim (mod/companion-vehicle-native.lua) decodes the wire text below into the same tables.
//
// Lua semantics kept (each checked by the fixture replay):
//   id()           a zero entity hash is nil ("no occupant"); 0 is used for nil here
//   seat filter    a seat is listed when the car has an occupant slot of that name, and the
//                  shared record of the Mackinaw (Vehicle.v_standard3_thorton_mackinaw_ncu_player)
//                  never lists "seat_back_right"
//   speed          math.sqrt(vx^2 + vy^2 + vz^2) of the linear velocity, in doubles
//   playerGap      math.sqrt(GetDistanceToPlayerSquared()) (NaN for a negative square, like Lua)
//   order          not a vehicle -> {ready=false, invalid=true}; an owned car without a driving AI
//                  component -> {ready=false, error=...} (the error text stays in the Lua shim)

#include <cstdint>
#include <string>
#include <vector>

namespace convai::vehicles
{
inline constexpr const char* kMackinawRecord = "Vehicle.v_standard3_thorton_mackinaw_ncu_player";
inline constexpr const char* kMackinawHiddenSeat = "seat_back_right";

// Lua: entity:HasOccupantSlot(seatName) and not (mackinaw and name(seatName) == 'seat_back_right').
bool KeepSeat(const std::string& aName, bool aHasSlot, bool aMackinaw);

// One seat of the car's record, as the game answered. occupant and reserved are read only for a
// seat KeepSeat() accepts; elsewhere they stay 0 / false and are ignored.
struct SeatRead
{
    std::string name;
    bool hasSlot = false;
    uint64_t occupant = 0; // MountingInfo.childId.hash, 0 = nobody
    bool reserved = false; // ai:IsSeatReserved(seatName), false without an AI component
};

struct InspectRaw
{
    bool attached = true;  // entity:IsAttached()
    bool isVehicle = true; // entity:IsVehicle()
    bool owned = false;    // vehicle.owned: a car the mod created itself
    bool destroyed = false;
    bool aiPresent = false; // entity:GetAIComponent() is not nil
    bool mackinaw = false;  // entity:GetRecordID() == the Mackinaw record
    std::vector<SeatRead> seats; // every seat of the record seat set, in record order
    double velocityX = 0.0;      // GetLinearVelocity (float32 values, widened)
    double velocityY = 0.0;
    double velocityZ = 0.0;
    double distanceSquared = 0.0; // GetDistanceToPlayerSquared
    bool playerMounted = false;   // IsPlayerMounted
    bool scene = false;           // IsPerformingSceneAnimation
};

enum class InspectStatus : int
{
    NotVehicle = 0, // {ready=false, invalid=true}
    NoAi = 1,       // owned car without the native driving AI: {ready=false, error=...}
    Ready = 2,
    Detached = 3 // not attached: the shim re-resolves the handle and asks again (or runs the Lua)
};

struct SeatInfo
{
    std::string name;
    uint64_t occupant = 0; // 0 = nil
    bool reserved = false;
};

struct InspectResult
{
    InspectStatus status = InspectStatus::Detached;
    bool invalid = false; // Ready: the car is destroyed
    bool aiPresent = false;
    bool playerMounted = false;
    bool scene = false;
    double speed = 0.0;
    double playerGap = 0.0;
    std::vector<SeatInfo> seats;
};

// Order: !attached -> Detached; !isVehicle -> NotVehicle; owned && !aiPresent -> NoAi; else Ready
// with the seats filtered by KeepSeat, speed and playerGap as above.
InspectResult DecideInspect(const InspectRaw& aRaw);

// --- wire format ----------------------------------------------------------------------------
//
// One String of space-separated tokens; the Lua shim splits it with string.gmatch.
//
//   Inspect:  "V <status>"                      for status 0 (NotVehicle), 1 (NoAi), 3 (Detached)
//             "V 2 <invalid> <aiPresent> <playerMounted> <scene> <speed> <playerGap> <seatCount>
//              {<name> <occupant> <reserved>}*"  for Ready; flags are 0/1, occupant is the decimal
//             entity hash or 0, reserved is 0/1. Numbers use %.17g; a non-finite number is written
//             as the word nan, inf or -inf (never anything else).
//   Mounting: "M -"                    not attached or not mounted
//             "M <parentHash> <seat>"  mounted: decimal hash of the parent entity and the slot name
//
std::string FormatNumber(double aValue);
std::string FormatInspect(const InspectResult& aResult);
std::string FormatMounting(bool aMounted, uint64_t aParentHash, const std::string& aSeat);
} // namespace convai::vehicles
