#pragma once

// Lift-car standing spots, game-free part. Ported from mod/companion-passage.lua M.carSpot: the
// search for a spot beside V inside a lift car, by physics alone (the car floor carries no
// navmesh). One call spends at most carQueries nominal units of work; the search state (which
// candidate is next, the floor under V's feet) lives in the Lua table the caller keeps, and is
// passed in and handed back here.
//
// The "car" in this system is an elevator car, not a vehicle: the queries are SyncRaycast and
// Overlap calls through the clearance system's Probe (systems/clearance/core/ClearanceCore.hpp),
// and the body check is clearance::CheckBody, the same C++ the clearance system uses.
//
// Lua semantics kept (each checked by the fixture replay, which feeds the recorded answers of the
// fake spatial system back to the C++ loop and compares the queries it issues, in order):
//   - the floor under V is read first (three Static/Dynamic/Terrain rays, the highest hit wins)
//     and must lie within carFloor of V's own height, else 'no-car-floor';
//   - a candidate within 0.9 m (ground distance) of an occupied position is skipped without a
//     query and without spending units;
//   - per candidate: spend 3 for the floor rays, then (floor within carFloor of V) spend 2 for the
//     wall rays (Static, Dynamic; the first non-free ray is a wall), then (no wall) spend 6 and
//     check the body at the candidate's feet (CheckBody, feet rounded to float32 first);
//   - the loop ends at the end of the candidates or when spent >= carQueries, whichever is first;
//     candidates exhausted -> 'no-car-floor', else Pending (call again next update);
//   - a budget wait (fewer queries left than a step needs) returns Pending with `deferred` set; it
//     is the only case where the Lua budget's deferred counter goes up by one;
//   - a spot is (x, y, floor + 0.05) of the candidate.

#include "systems/clearance/core/ClearanceCore.hpp"

#include <string>
#include <vector>

namespace convai::passage
{
inline constexpr int kFloorGroupCount = 3;
inline constexpr const char* kFloorGroups[kFloorGroupCount] = {"Static", "Dynamic", "Terrain"};
inline constexpr int kWallGroupCount = 2;
inline constexpr const char* kWallGroups[kWallGroupCount] = {"Static", "Dynamic"};
inline constexpr double kOccupiedRadius = 0.9;

// One standing candidate: its position and the unit direction from V towards it.
struct Candidate
{
    double x = 0.0;
    double y = 0.0;
    double ux = 0.0;
    double uy = 0.0;
};

struct Point2
{
    double x = 0.0;
    double y = 0.0;
};

// The search state the Lua keeps in its `state` table.
struct SearchState
{
    int index = 1;          // 1-based index of the next candidate
    bool hasFloor = false;  // state.floor is set
    double floor = 0.0;     // the car floor under V's feet
};

struct CarSpotInput
{
    clearance::Vec3 v;                    // V's feet
    std::vector<Candidate> candidates;    // fixed when the search began
    std::vector<Point2> occupied;         // spots already taken by other companions
    clearance::Shape body;                // the companion's body, validated by CheckBody
    int carQueries = 24;                  // M.policy.carQueries
    double carFloor = 0.3;                // M.policy.carFloor
    int remaining = 1000000;              // queries left in this update's budget
    SearchState state;
};

enum class Status : int
{
    Spot = 0,     // a standing spot was found
    None = 1,     // no spot: reason says why
    Pending = 2,  // keep searching on the next update
    Fallback = 4  // a game call failed: the shim runs its own path (state untouched)
};

enum class Reason : int
{
    NoCarFloor = 1,
    PhysicsUnavailable = 2
};

struct CarSpotOutcome
{
    Status status = Status::Pending;
    int used = 0;           // queries issued (rays and overlaps), the Lua budget.used increase
    bool deferred = false;  // the Lua budget's deferred counter goes up by one
    SearchState state;      // the state after the call (not updated on Fallback)
    clearance::Vec3 spot;   // Spot: x, y, z of Vector4.new(c.x, c.y, floor + .05, 1), before float32
    Reason reason = Reason::NoCarFloor; // None
    int code = 0;           // Fallback: Probe::ErrorCode
};

// Lua M.carSpot after the candidates exist.
CarSpotOutcome CarSpot(clearance::Probe& aProbe, const CarSpotInput& aInput);

// Lua floorAt: the highest hit of the three floor rays from (x, y, top) down to (x, y, bottom).
// Returns false and sets aDeferred when fewer than three queries are left; aFound/aZ say whether a
// floor was hit. A probe error is reported through aError.
struct FloorRead
{
    bool deferred = false;
    bool error = false;
    bool found = false;
    double z = 0.0;
    int used = 0;
};
FloorRead FloorAt(clearance::Probe& aProbe, double aX, double aY, double aTop, double aBottom, int aRemaining);

// --- wire format -----------------------------------------------------------------------------
//
//   "<status> <used> <deferred> <index> <hasFloor> <floor>" followed by, by status:
//     0 Spot      " <x> <y> <z>"
//     1 None      " <reason>"          (1 no-car-floor, 2 physics-unavailable)
//     2 Pending   nothing
//   "4 <used> <code>"                   Fallback (the Lua adds `used` to its budget and runs itself)
// Flags are 0/1; numbers use %.17g (non-finite numbers are the words nan, inf, -inf).
std::string FormatNumber(double aValue);
std::string FormatCarSpot(const CarSpotOutcome& aOutcome);
} // namespace convai::passage
