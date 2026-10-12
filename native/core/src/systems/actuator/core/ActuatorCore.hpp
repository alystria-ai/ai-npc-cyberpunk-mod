#pragma once

// The companion tick, game-free part. mod/companions.lua senses every ready companion ten times a
// second: it reads the body's position and forward vector, computes speed, heading, distance to V
// and the facing error, and mod/companion-actuator.lua reads the state of the companion's owned AI
// command. Done from CET that is about eight native calls and a dozen property reads per companion
// per tick. The plugin does all of it in one call and returns a single line of text (the wire
// format below); the Lua shim (mod/companion-tick-native.lua) decodes it into the same fields.
//
// Everything here follows the Lua in the same order of operations, in doubles, so the results
// match mod/companion-space.lua. The parity fixture tests/fixtures/actuator-sense.json is recorded
// from the real mod/companions.lua by bridge/companion-tick-native.test.mjs.
//
// Lua semantics kept:
//   unit(x, y)     a vector shorter than 0.0001 becomes (0, 1)
//   angle(a, b)    both inputs are normalised again, the dot is clamped to [-1, 1], degrees
//   speed          0 when the companion has no previous position, else ground distance / step
//   playerGap      3D distance (z included), facingError uses the ground bearing only

#include <cstdint>
#include <string>
#include <string_view>

namespace convai::actuator
{
struct Unit2
{
    double x = 0.0;
    double y = 1.0;
};

// math.sqrt(x*x + y*y) < 0.0001 -> (0, 1), else (x / length, y / length).
Unit2 UnitOf(double aX, double aY);

// Degrees between two ground directions; both are normalised first (space.angle).
double AngleDegrees(double aAx, double aAy, double aBx, double aBy);

// space.ground / space.distance
double GroundDistance(double aAx, double aAy, double aBx, double aBy);
double Distance3(double aAx, double aAy, double aAz, double aBx, double aBy, double aBz);

struct SenseInput
{
    bool hasPrevious = false; // entry.position was set on an earlier tick
    double previousX = 0.0;
    double previousY = 0.0;
    double x = 0.0; // GetWorldPosition
    double y = 0.0;
    double z = 0.0;
    double forwardX = 0.0; // GetWorldForward
    double forwardY = 0.0;
    double playerX = 0.0; // V's position this tick
    double playerY = 0.0;
    double playerZ = 0.0;
    double step = 0.1; // seconds since the previous tick
};

struct SenseMath
{
    double speed = 0.0;       // entry.speed
    Unit2 direction;          // entry.direction
    double playerGap = 0.0;   // entry.playerGap
    double facingError = 0.0; // entry.facingError, degrees
};

SenseMath ComputeSense(const SenseInput& aInput);

// The AI command states, as the game numbers them (AICommandState). The Lua label for state n is
// "AICommandState : <name> (<n>)".
constexpr int kCommandStateCount = 7;
const char* CommandStateName(int aState);

// Reads that could not be made are reported as these, never guessed.
constexpr int kStateUnavailable = -1;
constexpr int kIdUnavailable = -1;

// Life(): what became of the body since the last tick.
enum class Life : int32_t
{
    Unavailable = -1, // the call could not be made: Lua asks the game itself
    Missing = 0,      // not attached
    Dead = 1,
    Alive = 2,
};

// flags in the wire format
constexpr int kFlagCombatKnown = 1;
constexpr int kFlagInCombat = 2;
constexpr int kFlagStateKnown = 4;
constexpr int kFlagIdKnown = 8;

// What the plugin resolved at start (Capabilities()). The shim uses the natives only when
// kCapRequired is fully present, and falls back to Lua for any single read that is missing.
constexpr int kCapIsAttached = 1;
constexpr int kCapIsDead = 2;
constexpr int kCapWorldPosition = 4;
constexpr int kCapWorldForward = 8;
constexpr int kCapCommandState = 16; // GetAIControllerComponent + GetCommandState
constexpr int kCapCommandId = 32;
constexpr int kCapInCombat = 64;
constexpr int kCapRequired = kCapIsAttached | kCapIsDead | kCapWorldPosition | kCapWorldForward;

struct SenseWire
{
    int flags = 0;
    double x = 0.0, y = 0.0, z = 0.0, w = 1.0;
    double forwardX = 0.0, forwardY = 0.0;
    int state = kStateUnavailable;
    double commandId = kIdUnavailable;
    SenseMath math;
};

// "flags x y z w fx fy state id speed dx dy gap facing": 14 numbers, one space apart, shortest
// round-trip decimal (std::to_chars), no locale. Empty when a value is not finite.
std::string EncodeSense(const SenseWire& aWire);
bool DecodeSense(std::string_view aText, SenseWire& aOut);

// The field order, for the Lua shim's decoder and the parity fixture.
const char* WireFields();
} // namespace convai::actuator
