// ConvaiNativeClearance: collision clearance checks for companions, off the CET Lua path.
// Lua side: mod/companion-clearance.lua routes body, recheck, segment, sightClear and floorZ here
// when the plugin is present and the "clearance" switch is on; docs/NATIVE_CLEARANCE.md has the
// wire format and the in-game checks. One call replaces the 14 CET calls per box of the Lua.
//
// Every answer is one String of space-separated numbers (ClearanceCore.hpp, "wire format").
// Lua owns the per-update query budget: each call is told what is left and reports what it used.

#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "core/Log.hpp"

#include "systems/clearance/ClearanceGame.hpp"
#include "systems/clearance/core/ClearanceCore.hpp"

#include <algorithm>
#include <cstdio>

namespace
{
using namespace convai;
using namespace convai::clearance;

constinit rtti::StaticClass g_class("ConvaiNativeClearance", "clearance");
constexpr const char* kSystem = "clearance";
constexpr int kBudgetCap = 1000000;

// Game thread only.
struct Counters
{
    unsigned long long body = 0;
    unsigned long long box = 0;
    unsigned long long segment = 0;
    unsigned long long sight = 0;
    unsigned long long floor = 0;
    unsigned long long queriesUsed = 0;
    unsigned long long blocked = 0;
    unsigned long long deferred = 0;
    unsigned long long fallbacks = 0;
} g_counters;

// A fault inside a body (an exception or access violation caught by Guard) answers "fallback, code
// 9": the Lua shim switches the system off for the session and runs its own path.
const std::string kFault = "4 0 9";

int Budget(int32_t aRemaining)
{
    return std::clamp(aRemaining, 0, kBudgetCap);
}

void Count(const Outcome& aOutcome)
{
    g_counters.queriesUsed += static_cast<unsigned long long>(aOutcome.used);
    switch (aOutcome.status)
    {
    case Status::Blocked:
        ++g_counters.blocked;
        break;
    case Status::Deferred:
        ++g_counters.deferred;
        break;
    case Status::Fallback:
        ++g_counters.fallbacks;
        break;
    default:
        break;
    }
}

// Body(feet x y z, radius, height, remaining) : String
void Body(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    double x = 0, y = 0, z = 0, radius = 0, height = 0;
    int32_t remaining = 0;
    rtti::ReadArgs(aFrame, &x, &y, &z, &radius, &height, &remaining);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               GameProbe probe;
                               const Outcome outcome =
                                   CheckBody(probe, {x, y, z}, {radius, height}, Budget(remaining));
                               ++g_counters.body;
                               Count(outcome);
                               return FormatOutcome(outcome, false);
                           },
                           kFault));
}

// Box(centre x y z, half extents x y z, roll, pitch, yaw, remaining) : String   (Lua M.recheck)
void RecheckBox(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    double cx = 0, cy = 0, cz = 0, hx = 0, hy = 0, hz = 0, roll = 0, pitch = 0, yaw = 0;
    int32_t remaining = 0;
    rtti::ReadArgs(aFrame, &cx, &cy, &cz, &hx, &hy, &hz, &roll, &pitch, &yaw, &remaining);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               GameProbe probe;
                               clearance::Box box;
                               box.half = {hx, hy, hz};
                               box.center = {cx, cy, cz};
                               box.roll = roll;
                               box.pitch = pitch;
                               box.yaw = yaw;
                               const Outcome outcome = CheckRecheck(probe, box, Budget(remaining));
                               ++g_counters.box;
                               Count(outcome);
                               return FormatOutcome(outcome, false);
                           },
                           kFault));
}

// Segment(from x y z, to x y z, radius, height, startBox, nativeOriginProjection, remaining) : String
void Segment(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    double fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0, radius = 0, height = 0;
    int32_t startBox = 1;
    bool projection = false;
    int32_t remaining = 0;
    rtti::ReadArgs(aFrame, &fx, &fy, &fz, &tx, &ty, &tz, &radius, &height, &startBox, &projection, &remaining);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               GameProbe probe;
                               const Outcome outcome =
                                   CheckSegment(probe, {fx, fy, fz}, {tx, ty, tz}, {radius, height},
                                                std::clamp(startBox, 1, kBudgetCap), projection, Budget(remaining));
                               ++g_counters.segment;
                               Count(outcome);
                               return FormatOutcome(outcome, true);
                           },
                           kFault));
}

// Sight(from x y z, to x y z, remaining) : String   (companions.lua visibleFromCrosshair)
void Sight(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    double fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
    int32_t remaining = 0;
    rtti::ReadArgs(aFrame, &fx, &fy, &fz, &tx, &ty, &tz, &remaining);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               GameProbe probe;
                               const Outcome outcome = CheckSight(probe, {fx, fy, fz}, {tx, ty, tz}, Budget(remaining));
                               ++g_counters.sight;
                               Count(outcome);
                               return FormatSight(outcome);
                           },
                           kFault));
}

// Floor(at x y z, maxDrop) : String   (companions.lua floorBelow)
void Floor(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    double x = 0, y = 0, z = 0, maxDrop = 0;
    rtti::ReadArgs(aFrame, &x, &y, &z, &maxDrop);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               GameProbe probe;
                               const Outcome outcome = CheckFloor(probe, {x, y, z}, maxDrop);
                               ++g_counters.floor;
                               Count(outcome);
                               return FormatFloor(outcome);
                           },
                           std::string("-1 9")));
}

// Orientation(dx, dy) : String   "roll pitch yaw" of a unit horizontal direction. The Lua shim
// compares it with Quaternion.BuildFromDirectionVector/ToEulerAngles before the native path runs.
void Orientation(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    double dx = 0, dy = 0;
    rtti::ReadArgs(aFrame, &dx, &dy);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               const Euler euler = OrientationOf(dx, dy);
                               char text[128];
                               std::snprintf(text, sizeof(text), "%.17g %.17g %.17g", euler.roll, euler.pitch,
                                             euler.yaw);
                               return std::string(text);
                           },
                           std::string("error")));
}

// SelfTest() : String   "ok", "wait <reason>" or "fail <reason>" (ClearanceGame.hpp).
void SelfTestNative(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [] {
                               const std::string result = SelfTest();
                               if (result != "ok")
                               {
                                   CONVAI_INFO("Clearance self-test: %s", result.c_str());
                               }
                               return result;
                           },
                           std::string("fail the self-test faulted")));
}

// Stats() : String   counters as JSON, for the CET console: print(ConvaiNativeClearance.Stats())
void Stats(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [] {
                               const QueryStats game = GetQueryStats();
                               char text[640];
                               std::snprintf(
                                   text, sizeof(text),
                                   "{\"calls\":{\"body\":%llu,\"box\":%llu,\"segment\":%llu,\"sight\":%llu,\"floor\":%llu},"
                                   "\"queriesUsed\":%llu,\"blocked\":%llu,\"deferred\":%llu,"
                                   "\"fallbacks\":%llu,\"game\":{\"overlaps\":%llu,\"rays\":%llu,\"errors\":%llu,"
                                   "\"micros\":%llu,\"maxMicros\":%llu}}",
                                   g_counters.body, g_counters.box, g_counters.segment, g_counters.sight,
                                   g_counters.floor, g_counters.queriesUsed,
                                   g_counters.blocked, g_counters.deferred, g_counters.fallbacks,
                                   static_cast<unsigned long long>(game.overlaps),
                                   static_cast<unsigned long long>(game.rays),
                                   static_cast<unsigned long long>(game.errors),
                                   static_cast<unsigned long long>(game.micros),
                                   static_cast<unsigned long long>(game.maxMicros));
                               return std::string(text);
                           },
                           std::string("{}")));
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    g_class.Static("Body", &Body, "String",
                   {{"Double", "x"}, {"Double", "y"}, {"Double", "z"}, {"Double", "radius"}, {"Double", "height"},
                    {"Int32", "remaining"}});
    g_class.Static("Box", &RecheckBox, "String",
                   {{"Double", "cx"}, {"Double", "cy"}, {"Double", "cz"}, {"Double", "hx"}, {"Double", "hy"},
                    {"Double", "hz"}, {"Double", "roll"}, {"Double", "pitch"}, {"Double", "yaw"},
                    {"Int32", "remaining"}});
    g_class.Static("Segment", &Segment, "String",
                   {{"Double", "fx"}, {"Double", "fy"}, {"Double", "fz"}, {"Double", "tx"}, {"Double", "ty"},
                    {"Double", "tz"}, {"Double", "radius"}, {"Double", "height"}, {"Int32", "startBox"},
                    {"Bool", "projection"}, {"Int32", "remaining"}});
    g_class.Static("Sight", &Sight, "String",
                   {{"Double", "fx"}, {"Double", "fy"}, {"Double", "fz"}, {"Double", "tx"}, {"Double", "ty"},
                    {"Double", "tz"}, {"Int32", "remaining"}});
    g_class.Static("Floor", &Floor, "String",
                   {{"Double", "x"}, {"Double", "y"}, {"Double", "z"}, {"Double", "maxDrop"}});
    g_class.Static("Orientation", &Orientation, "String", {{"Double", "dx"}, {"Double", "dy"}});
    g_class.Static("SelfTest", &SelfTestNative, "String", {});
    g_class.Static("Stats", &Stats, "String", {});
}
} // namespace

CONVAI_SYSTEM(clearance, {
    .name = "clearance",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
