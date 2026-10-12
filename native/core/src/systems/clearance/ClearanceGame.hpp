#pragma once

// The game side of the clearance system: a Probe that asks SpatialQueriesSystem.
//
//   Overlap(primitiveDimension : Vector4, position : Vector4, rotation : EulerAngles,
//           collisionGroup : CName, out result : TraceResult) : Bool          (true means HIT)
//   SyncRaycastByCollisionGroup(start : Vector4, end : Vector4, collisionGroup : CName,
//           out result : TraceResult, staticOnly : Bool, dynamicOnly : Bool) : Bool
//
// Both are called through the game's own script invoker (RED4ext::ExecuteFunction), with every
// parameter supplied, the same call CET makes for mod/companion-clearance.lua. A miss anywhere
// (system, function, invoker) is reported as Hit::Error with a small code; it never throws.
//
// Game thread only. Nothing here is held between native calls: the system pointer is looked up
// again for each native call, so a save load or a menu round trip cannot leave a stale pointer.

#include "systems/clearance/core/ClearanceCore.hpp"

#include <cstdint>
#include <string>

namespace RED4ext
{
struct IScriptable;
struct CBaseFunction;
} // namespace RED4ext

namespace convai::clearance
{
// Error codes of Probe::ErrorCode.
enum ProbeError : int
{
    kErrorNone = 0,
    kErrorNoSystem = 1,
    kErrorNoOverlap = 2,
    kErrorInvoke = 3,
    kErrorNoRay = 4,
    kErrorBadGroup = 5,
    kErrorFault = 9
};

class GameProbe final : public Probe
{
public:
    GameProbe();

    bool Ready() const
    {
        return m_system != nullptr;
    }

    Hit Overlap(const Box& aBox, int aGroup) override;
    Hit Ray(const Vec3& aFrom, const Vec3& aTo, const char* aGroup, double* aHitZ) override;
    int ErrorCode() const override
    {
        return m_error;
    }

private:
    RED4ext::IScriptable* m_system = nullptr;
    RED4ext::CBaseFunction* m_overlap = nullptr;
    RED4ext::CBaseFunction* m_ray = nullptr;
    int m_error = kErrorNone;
};

// Counters for Stats(): what the game's queries cost, so the in-game check can read it.
struct QueryStats
{
    std::uint64_t overlaps = 0;
    std::uint64_t rays = 0;
    std::uint64_t errors = 0;
    std::uint64_t micros = 0;    // total time inside the game's query calls
    std::uint64_t maxMicros = 0; // slowest single query
};
QueryStats GetQueryStats();

// One benign probe of the live world: "ok", "wait <reason>" (no world yet, ask again later) or
// "fail <reason>" (the invocations do not behave: keep the Lua path).
std::string SelfTest();
} // namespace convai::clearance
