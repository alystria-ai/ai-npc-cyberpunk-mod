#pragma once

// The chauffeur sample, game-free part. Ported from mod/companion-chauffeur-native.lua: M.sample
// (80-120 CET calls, ten times a second while a companion trip runs) and M.inspectDrive (about 30
// calls, also used by retarget, stop and brake).
//
// The game side (ChauffeurGame.cpp) collects raw reads; everything the Lua decides after the reads
// is decided here, and the wire text below carries the decisions to the Lua shim
// (mod/companion-chauffeur-native.lua). The headless tests replay what the real Lua module
// recorded (tests/fixtures/chauffeur-*.json): raw reads in, the Lua's own tables out, and the wire
// text the encoder in bridge/companion-chauffeur-native.test.mjs derives from those tables.
//
// The sample is cut into sections that can fail independently. A section the plugin could not
// read is written as "<tag> !" and the Lua shim runs the original code for that section only:
//
//   A actor    attached, dead, valid (managed, tagged, same entity, owner ready), calm
//   P player   entity hash, passenger seat state, in combat
//   S summon   hash of the summoned vehicle, summon state
//   U auto     the AutoDrive system: enabled, delamain, available, lane, destination, free roam
//   C car      the leased car: live, hash, valid, world position
//   D drive    the car's AI command reads (also the whole answer of Drive())
//   W waypoint the tracked destination: hash, position, marker, the raw display name
//
// Lua semantics kept (each checked by the fixture replay):
//   ids        a zero hash is nil; 0 stands for nil in the raw structs and on the wire
//   commandID  an AI command id outside [0, 4294967295) is nil (4294967295 is the constructor's
//              "unassigned" sentinel)
//   matches    a command matches the receipt when its class name and its id are both equal
//   foreign    current-and-not-ours, or initial-and-not-ours, or automatic, or enabled, or
//              executing-and-not-ownedActive
//   routePos   x, y and z must be numbers, not NaN and |v| <= 1e7 (note <=, unlike clearance)

#include <cstdint>
#include <string>

namespace convai::chauffeur
{
inline constexpr double kRouteLimit = 10000000.0;
inline constexpr uint32_t kUnassignedCommandId = 4294967295u;
// AICommandState numbers (NotExecuting 0 ... Failure 6) use convai::actuator::CommandStateName.

struct Vec3
{
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

// Lua routePosition(): x, y, z all finite and |value| <= 1e7.
bool RoutePositionValid(const Vec3& aPoint);
// Lua commandID(handle): valid unless the id is the unassigned sentinel.
bool ValidCommandId(uint32_t aId);

// --- actor -----------------------------------------------------------------------------------

struct ActorRaw
{
    bool npcPresent = false; // entry.npc is not nil
    bool attached = false;   // npc:IsAttached()
    bool dead = false;       // npc:IsDeadNoStatPool(), read only when attached
    bool sameEntity = false; // entityID(npc:GetEntityID()) == the entry's entity id
    bool ownerPresent = false;
    bool ownerReady = false; // owner:IsReady()
    bool managed = false;    // owner:IsManaged(entry.entityID)
    bool tagged = false;     // owner:IsTagged(entry.entityID, CyberpunkConvaiCompanion)
    bool inCombat = false;   // NPCPuppet.IsInCombat(npc), read only when the actor is valid
    // False when the plugin could not read the combat flag (no route to it in this game build, or the call failed):
    // the flag is then UNKNOWN, not "unavailable sample": the wire says '?' for calm and the Lua reads that one field.
    bool combatKnown = true;
};

struct ActorResult
{
    bool attached = false;
    bool dead = false;
    bool valid = false;
    bool calm = false;
    bool calmKnown = true; // false: the actor is valid but its combat flag was not read, calm is the Lua's to decide
};

// attached = npcPresent and attached; dead = attached and dead; valid = attached and not dead and
// sameEntity and ownerPresent and ownerReady and managed and tagged; calm = valid and not inCombat. When the
// actor is valid and the combat flag is unknown, calmKnown is false (calm stays false and is not to be used).
ActorResult DecideActor(const ActorRaw& aRaw);

// --- drive (Lua inspectDrive) ----------------------------------------------------------------

// One AICommand handle as the Lua sees it: its class name and its id.
struct CommandRead
{
    bool present = false;
    uint32_t id = 0;
    std::string className;
};

// Lua matches(handle): receipt and handle and className(handle) == receipt.class and
// commandID(handle) == receipt.id.
bool CommandMatches(const CommandRead& aCommand, bool aHasReceipt, double aReceiptId, const std::string& aReceiptClass);

struct DriveRaw
{
    bool aiPresent = true;   // entity:GetAIComponent() is not nil
    bool typesValid = true;  // the four Bool reads and the seat reservation count have the right types
    bool hasOperation = false;
    bool hasReceipt = false; // M.driveReceipt(operation) is not nil
    double receiptId = 0.0;
    std::string receiptClass;
    CommandRead current;  // ai:GetEnqueuedOrExecutingCommand('AIVehicleCommand', true)
    CommandRead direct;   // ai:GetEnqueuedOrExecutingCommand(DRIVE_CLASS, false)
    CommandRead initial;  // ai:GetInitCmd()
    CommandRead given;    // operation.handle, the command the Lua trip holds
    bool executing = false;   // entity:IsExecutingAnyCommand()
    bool automatic = false;   // entity:IsAutoDriveModeEnabled()
    bool enabled = false;     // AutoDriveSystem:GetAutodriveEnabled()
    bool commands = false;    // entity:CommandsFromDriverEnabled()
    bool scene = false;       // entity:IsPerformingSceneAnimation()
    double reservations = 0.0; // ai:GetReservedSeatsCount()
    int state = -1;       // AICommandState of the planned handle (PlanState), -1 not read
    int activeCheck = -1; // ai:IsCommandActive(receipt.id): -1 not read, 0 false, 1 true
    bool hasTelemetry = false; // GetCurrentSlotLocalPathLength/Progression: both numbers, neither NaN
    double pathLength = 0.0;
    double pathProgress = 0.0;
};

// Which handle the state is read from: operation.handle, else the owned drive command when it
// matches, else none (then IsCommandActive decides). Valid only for hasOperation and hasReceipt.
enum class StateSource : int
{
    None = 0,
    Given = 1,
    Direct = 2
};
// handle = operation.handle or (ownedActive and direct); it is used when it matches the receipt.
StateSource PlanState(const DriveRaw& aRaw);

enum class DriveStatus : int
{
    AiMissing = 0,       // {known=false, error='Vehicle driving AI is unavailable.'}
    TypesInvalid = 1,    // {known=false, error='Vehicle control information is unavailable.'}
    IdentityMissing = 2, // an operation without a receipt: 'The driving command identity is unavailable.'
    Ok = 3
};

inline constexpr int kStateNone = -1;    // no operation: state stays nil
inline constexpr int kStatePending = -2; // IsCommandActive has not been asked: the Lua shim asks it

struct DriveResult
{
    DriveStatus status = DriveStatus::AiMissing;
    bool ready = false; // commands and not scene
    double reservations = 0.0;
    bool busy = false; // current ~= nil or initial ~= nil or executing
    bool foreign = false;
    bool ownedActive = false;
    int state = kStateNone; // 0..6 AICommandState, kStateNone, kStatePending
    bool hasCommandId = false; // commandId = receipt and receipt.id
    double commandId = 0.0;
    bool hasCurrentId = false; // currentId = commandID(current)
    double currentId = 0.0;
    std::string currentClass; // className(current), empty when there is no current command
    bool hasRemaining = false;
    double remaining = 0.0; // max(0, length - progress)
};

// Order: !aiPresent -> AiMissing; !typesValid -> TypesInvalid; hasOperation && !hasReceipt ->
// IdentityMissing; else Ok. State with an operation: PlanState != None -> raw.state; else
// activeCheck 1 -> NotExecuting (0), 0 -> Cancelled (3), -1 -> kStatePending.
DriveResult DecideDrive(const DriveRaw& aRaw);

// --- car, summon, player, auto, waypoint -----------------------------------------------------

struct CarRaw
{
    bool live = false;         // attached, a vehicle, and a player vehicle (the Lua liveCar checks)
    uint64_t id = 0;           // the entity hash of the live car, 0 = nil
    bool carValid = false;     // not destroyed and the record type is Car
    bool positionValid = false; // RoutePositionValid(GetWorldPosition)
    Vec3 position;
};

struct PlayerRaw
{
    uint64_t id = 0;
    bool passenger = false; // PlayerPuppet.GetCurrentVehicleState == Passenger
    bool combat = false;    // player:IsInCombat()
};

struct SummonRaw
{
    uint64_t summoned = 0; // blackboard SummonedVehicleEntityID hash, 0 = nil
    double state = 0.0;    // blackboard SummonState (Uint); the Lua derives enRoute = state == 1
};

enum class DestinationType : int
{
    None = 0,
    PlayerTracked = 1,
    Quest = 2
};

struct AutoRaw
{
    bool enabled = false;
    bool delamain = false;
    bool available = false;
    bool laneValid = false; // CheckCurrentLaneValidity() == OnValidLane
    DestinationType destination = DestinationType::None;
    bool freeRoam = false;
    double remaining = 0.0;      // GetDistanceToCurrentDestination
    uint64_t vehicle = 0;        // hash of GetAutodriveVehicle():GetEntityID(), 0 = nil
    uint64_t destinationId = 0;  // GetAutodriveDestinationMappinID().value, 0 = nil
};

struct WaypointRaw
{
    bool tracked = false;     // the destination type is PlayerTracked or Quest
    bool quest = false;       // the destination type is Quest
    uint64_t id = 0;          // mappin id, 0 = nil
    bool pinPresent = false;  // MappinSystem:GetMappin(id) is not nil
    bool hasDestination = false; // GetAutodriveDestination() answered
    Vec3 destination;
    bool hasMarker = false;   // pin:GetWorldPosition() answered
    Vec3 marker;
    std::string rawName;      // pin:GetDisplayName(), empty when it failed or is not text
};

struct WaypointResult
{
    bool present = false;
    uint64_t id = 0;
    Vec3 position;
    Vec3 marker;
    bool quest = false;
    std::string rawName;
};

// present = tracked and id ~= 0 and pinPresent and both positions answer and pass RoutePositionValid.
WaypointResult DecideWaypoint(const WaypointRaw& aRaw);

// --- wire format -----------------------------------------------------------------------------
//
// Space-separated tokens. Flags are 0/1; an id is the decimal entity hash or 0 for nil; numbers use
// %.17g and a non-finite number is the word nan, inf or -inf; "-" is a nil number or text.
//
//   A  "A <attached> <dead> <valid> <calm>"                  calm is "?" when the actor is valid and its combat flag
//                                                            could not be read; the Lua then asks NPCPuppet.IsInCombat itself
//   P  "P <id> <passenger> <combat>"
//   S  "S <summoned> <state>"
//   U  "U <enabled> <delamain> <available> <laneValid> <destType> <freeRoam> <remaining> <vehicle> <destId>"
//        destType: 0 None, 1 PlayerTracked, 2 Quest
//   C  "C <live> <id> <carValid> <posValid> <x> <y> <z>"      (x y z are 0 when posValid is 0)
//   D  "D <status>"                                           for status 0, 1, 2
//      "D 3 <ready> <reservations> <busy> <foreign> <ownedActive> <state> <commandId> <currentId>
//          <remaining> <currentClass>"
//        state: "-" none, "?" pending IsCommandActive, else 0..6; commandId, currentId, remaining
//        and currentClass are "-" when nil
//   W  "W 0"                                                  no waypoint
//      "W 1 <id> <px> <py> <pz> <mx> <my> <mz> <quest> <rawName>"   rawName is the rest of the text
//
// A failed section is "<tag> !", written by the game layer, never by these functions.
//
// Drive() answers "<live> <id> " followed by the D section, so the shim can check the entity.
std::string FormatNumber(double aValue);
std::string FormatActor(const ActorResult& aResult);
std::string FormatPlayer(const PlayerRaw& aRaw);
std::string FormatSummon(const SummonRaw& aRaw);
std::string FormatAuto(const AutoRaw& aRaw);
std::string FormatCar(const CarRaw& aRaw);
std::string FormatDrive(const DriveResult& aResult);
std::string FormatWaypoint(const WaypointResult& aResult);
} // namespace convai::chauffeur
