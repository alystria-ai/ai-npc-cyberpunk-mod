#include "systems/passage/core/PassageCore.hpp"

#include <cmath>
#include <cstdio>

namespace convai::passage
{
namespace
{
using clearance::Hit;
using clearance::Probe;
using clearance::Vec3;

// Lua ground(a, b): distance on the ground plane.
double Ground(const Candidate& aCandidate, const Point2& aPoint)
{
    const double dx = aCandidate.x - aPoint.x;
    const double dy = aCandidate.y - aPoint.y;
    return std::sqrt(dx * dx + dy * dy);
}

// Lua wallBetween: the first wall ray that is not free is a wall (Lua: `~= false`).
struct WallRead
{
    bool deferred = false;
    bool error = false;
    bool wall = false;
    int used = 0;
};

WallRead WallBetween(Probe& aProbe, const Vec3& aFrom, const Vec3& aTo, int aRemaining)
{
    WallRead read;
    if (aRemaining < kWallGroupCount)
    {
        read.deferred = true;
        return read;
    }
    for (int group = 0; group < kWallGroupCount; ++group)
    {
        const Hit hit = aProbe.Ray(aFrom, aTo, kWallGroups[group], nullptr);
        ++read.used;
        if (hit == Hit::Error)
        {
            read.error = true;
            return read;
        }
        if (hit != Hit::Free)
        {
            read.wall = true;
            return read;
        }
    }
    return read;
}

CarSpotOutcome Fallback(CarSpotOutcome aOutcome, int aUsed, int aCode)
{
    aOutcome.status = Status::Fallback;
    aOutcome.used = aUsed;
    aOutcome.deferred = false;
    aOutcome.code = aCode;
    return aOutcome;
}

CarSpotOutcome Pending(CarSpotOutcome aOutcome, int aUsed, bool aDeferred)
{
    aOutcome.status = Status::Pending;
    aOutcome.used = aUsed;
    aOutcome.deferred = aDeferred;
    return aOutcome;
}

CarSpotOutcome NoSpot(CarSpotOutcome aOutcome, int aUsed, Reason aReason)
{
    aOutcome.status = Status::None;
    aOutcome.used = aUsed;
    aOutcome.reason = aReason;
    return aOutcome;
}
} // namespace

FloorRead FloorAt(Probe& aProbe, double aX, double aY, double aTop, double aBottom, int aRemaining)
{
    FloorRead read;
    if (aRemaining < kFloorGroupCount)
    {
        read.deferred = true;
        return read;
    }
    for (int group = 0; group < kFloorGroupCount; ++group)
    {
        double z = 0.0;
        const Hit hit = aProbe.Ray({aX, aY, aTop}, {aX, aY, aBottom}, kFloorGroups[group], &z);
        ++read.used;
        if (hit == Hit::Error)
        {
            read.error = true;
            return read;
        }
        if (hit == Hit::Blocked && (!read.found || z > read.z))
        {
            read.found = true;
            read.z = z;
        }
    }
    return read;
}

CarSpotOutcome CarSpot(Probe& aProbe, const CarSpotInput& aInput)
{
    CarSpotOutcome out;
    out.state = aInput.state;
    SearchState& state = out.state;
    int used = 0;
    int spent = 0;
    const int count = static_cast<int>(aInput.candidates.size());
    const double top = aInput.v.z + 0.9;
    const double bottom = aInput.v.z - 0.6;

    if (!state.hasFloor)
    {
        // No car floor seen under V's own feet: nothing beside V will do.
        const FloorRead floor = FloorAt(aProbe, aInput.v.x, aInput.v.y, top, bottom, aInput.remaining - used);
        used += floor.used;
        if (floor.error)
        {
            return Fallback(out, used, aProbe.ErrorCode());
        }
        if (floor.deferred)
        {
            return Pending(out, used, true);
        }
        if (!floor.found || std::fabs(floor.z - aInput.v.z) > aInput.carFloor)
        {
            return NoSpot(out, used, Reason::NoCarFloor);
        }
        state.hasFloor = true;
        state.floor = floor.z;
        spent = kFloorGroupCount;
    }

    while (state.index <= count && spent < aInput.carQueries)
    {
        const Candidate& candidate = aInput.candidates[static_cast<size_t>(state.index - 1)];
        bool free = true;
        for (const Point2& other : aInput.occupied)
        {
            if (Ground(candidate, other) < kOccupiedRadius)
            {
                free = false;
                break;
            }
        }
        if (free)
        {
            spent += kFloorGroupCount;
            const FloorRead floor =
                FloorAt(aProbe, candidate.x, candidate.y, top, bottom, aInput.remaining - used);
            used += floor.used;
            if (floor.error)
            {
                return Fallback(out, used, aProbe.ErrorCode());
            }
            if (floor.deferred)
            {
                return Pending(out, used, true);
            }
            if (floor.found && std::fabs(floor.z - aInput.v.z) <= aInput.carFloor)
            {
                // From just outside V's own body to the spot, at waist height.
                spent += kWallGroupCount;
                const Vec3 from{aInput.v.x + candidate.ux * 0.35, aInput.v.y + candidate.uy * 0.35, aInput.v.z + 1.0};
                const Vec3 to{candidate.x, candidate.y, floor.z + 1.0};
                const WallRead wall = WallBetween(aProbe, from, to, aInput.remaining - used);
                used += wall.used;
                if (wall.error)
                {
                    return Fallback(out, used, aProbe.ErrorCode());
                }
                if (wall.deferred)
                {
                    return Pending(out, used, true);
                }
                if (!wall.wall)
                {
                    spent += 6;
                    // The Lua hands clearance.body a Vector4, which keeps float32 coordinates.
                    const Vec3 feet{clearance::ToFloat32(candidate.x), clearance::ToFloat32(candidate.y),
                                    clearance::ToFloat32(floor.z)};
                    const clearance::Outcome body =
                        clearance::CheckBody(aProbe, feet, aInput.body, aInput.remaining - used);
                    used += body.used;
                    if (body.status == clearance::Status::Fallback)
                    {
                        return Fallback(out, used, body.code != 0 ? body.code : aProbe.ErrorCode());
                    }
                    if (body.status == clearance::Status::Deferred)
                    {
                        return Pending(out, used, true);
                    }
                    if (body.status == clearance::Status::Clear)
                    {
                        out.status = Status::Spot;
                        out.used = used;
                        out.spot = {candidate.x, candidate.y, floor.z + 0.05};
                        return out;
                    }
                    // Blocked or Unavailable: this candidate does not fit, try the next.
                }
            }
        }
        ++state.index;
    }
    if (state.index > count)
    {
        return NoSpot(out, used, Reason::NoCarFloor);
    }
    return Pending(out, used, false);
}

std::string FormatNumber(double aValue)
{
    if (std::isnan(aValue))
    {
        return "nan";
    }
    if (std::isinf(aValue))
    {
        return aValue > 0 ? "inf" : "-inf";
    }
    char text[48];
    std::snprintf(text, sizeof(text), "%.17g", aValue);
    return text;
}

std::string FormatCarSpot(const CarSpotOutcome& aOutcome)
{
    if (aOutcome.status == Status::Fallback)
    {
        return "4 " + std::to_string(aOutcome.used) + " " + std::to_string(aOutcome.code);
    }
    std::string out = std::to_string(static_cast<int>(aOutcome.status));
    out += " " + std::to_string(aOutcome.used);
    out += aOutcome.deferred ? " 1" : " 0";
    out += " " + std::to_string(aOutcome.state.index);
    out += aOutcome.state.hasFloor ? " 1" : " 0";
    out += " " + FormatNumber(aOutcome.state.floor);
    if (aOutcome.status == Status::Spot)
    {
        out += " " + FormatNumber(aOutcome.spot.x) + " " + FormatNumber(aOutcome.spot.y) + " " +
               FormatNumber(aOutcome.spot.z);
    }
    else if (aOutcome.status == Status::None)
    {
        out += " " + std::to_string(static_cast<int>(aOutcome.reason));
    }
    return out;
}
} // namespace convai::passage
