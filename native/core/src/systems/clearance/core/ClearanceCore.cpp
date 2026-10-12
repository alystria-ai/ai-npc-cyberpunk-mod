#include "systems/clearance/core/ClearanceCore.hpp"

#include <algorithm>
#include <cmath>

// The control flow of mod/companion-clearance.lua: budget check, group order, early return on the
// first hit, the order of the validity checks. The arithmetic is done in double in the Lua's order.

namespace convai::clearance
{
namespace
{
Outcome Make(Status aStatus, int aUsed = 0)
{
    Outcome outcome;
    outcome.status = aStatus;
    outcome.used = aUsed;
    return outcome;
}

Outcome Failed(Probe& aProbe, int aUsed)
{
    Outcome outcome = Make(Status::Fallback, aUsed);
    outcome.code = aProbe.ErrorCode();
    return outcome;
}
} // namespace

// Lua overlap(extents, center, rotation).
Outcome CheckBox(Probe& aProbe, const Box& aBox, int aRemaining)
{
    // Never certify part of a box: with fewer than six queries left nothing is queried.
    if (aRemaining < kGroupCount)
    {
        return Make(Status::Deferred);
    }
    const Box box = RoundToFloat32(aBox);
    Outcome outcome;
    for (int group = 0; group < kGroupCount; ++group)
    {
        ++outcome.used;
        const Hit hit = aProbe.Overlap(box, group);
        if (hit == Hit::Error)
        {
            return Failed(aProbe, outcome.used);
        }
        if (hit == Hit::Blocked)
        {
            outcome.status = Status::Blocked;
            outcome.group = group;
            outcome.box = box;
            return outcome;
        }
    }
    return outcome;
}

// Lua M.body: the standing box at the feet, 0.1 m above the floor, no rotation.
Outcome CheckBody(Probe& aProbe, const Vec3& aFeet, const Shape& aShape, int aRemaining)
{
    if (!IsPoint(aFeet) || !ValidShape(aShape))
    {
        return Make(Status::Unavailable);
    }
    const double half = aShape.height * 0.5;
    Box box;
    box.half = {aShape.radius, aShape.radius, half};
    box.center = {aFeet.x, aFeet.y, aFeet.z + half + 0.1};
    return CheckBox(aProbe, box, aRemaining);
}

// Lua M.recheck: the stored rejection box, checked again.
Outcome CheckRecheck(Probe& aProbe, const Box& aRejected, int aRemaining)
{
    const Vec3& e = aRejected.half;
    if (!IsPoint(aRejected.center) || !IsPoint(e) || e.x <= 0 || e.y <= 0 || e.z <= 0 || e.x > 100 || e.y > 100 ||
        e.z > 10)
    {
        return Make(Status::Unavailable);
    }
    return CheckBox(aProbe, aRejected, aRemaining);
}

// Lua M.segment.
Outcome CheckSegment(Probe& aProbe, const Vec3& aFrom, const Vec3& aTo, const Shape& aShape, int aStartBox,
                     bool aNativeOriginProjection, int aRemaining)
{
    if (!IsPoint(aFrom) || !IsPoint(aTo) || !ValidShape(aShape))
    {
        return Make(Status::Unavailable);
    }
    const double dx = aTo.x - aFrom.x;
    const double dy = aTo.y - aFrom.y;
    const double dz = aTo.z - aFrom.z;
    const double length = std::sqrt(dx * dx + dy * dy);
    // Bound work even for a malformed long path leg. Dividing at changes in height keeps a sloping
    // route from becoming one box through the floor.
    const int count = SegmentBoxes(aFrom, aTo);
    const double allowedRise = std::max(0.35, length * 0.8);
    // A caller can certify only the first native path point as an origin projection. Every other
    // leg keeps the ordinary step rule.
    const bool strictNativeConnector = aNativeOriginProjection && length <= 0.02 && dz > 0 && dz <= 0.65;
    const bool projectedOrigin = strictNativeConnector && dz > 0.35;
    if (count > kMaxSegmentBoxes || (std::fabs(dz) > allowedRise && !projectedOrigin))
    {
        Outcome outcome = Make(Status::Geometry);
        outcome.kind = count > kMaxSegmentBoxes ? GeometryKind::RouteSize : GeometryKind::StepSlope;
        outcome.length = length;
        outcome.rise = std::fabs(dz);
        outcome.deltaZ = dz;
        outcome.allowedRise = allowedRise;
        outcome.boxCount = count;
        return outcome;
    }
    // Vector4.new keeps the direction as float32 before the game turns it into angles.
    const Euler rotation = length > 0.001 ? OrientationOf(ToFloat32(dx / length), ToFloat32(dy / length)) : Euler{};

    Outcome total;
    total.boxCount = count;
    for (int index = aStartBox; index <= count; ++index)
    {
        const double a = static_cast<double>(index - 1) / count;
        const double b = static_cast<double>(index) / count;
        const double low = std::min(aFrom.z + dz * a, aFrom.z + dz * b);
        const double high = std::max(aFrom.z + dz * a, aFrom.z + dz * b);
        // Walking may step onto a kerb or stair: sweep the body above the 0.35 m step band,
        // including the higher head end. For the one projected connector the sweep starts at the
        // reported root + 0.1 instead.
        const double bottom = low + (strictNativeConnector ? 0.1 : 0.35);
        const double top = high + aShape.height + 0.1;
        const double half = (top - bottom) * 0.5;
        const double middle = (a + b) * 0.5;
        Box box;
        box.half = {aShape.radius, length / (2.0 * count) + aShape.radius, half};
        box.center = {aFrom.x + dx * middle, aFrom.y + dy * middle, bottom + half};
        box.roll = rotation.roll;
        box.pitch = rotation.pitch;
        box.yaw = rotation.yaw;

        const Outcome boxOutcome = CheckBox(aProbe, box, aRemaining - total.used);
        total.used += boxOutcome.used;
        switch (boxOutcome.status)
        {
        case Status::Deferred:
            total.status = Status::Deferred;
            total.nextBox = index;
            return total;
        case Status::Blocked:
            total.status = Status::Blocked;
            total.group = boxOutcome.group;
            total.box = boxOutcome.box;
            total.boxIndex = index;
            return total;
        case Status::Fallback:
            total.status = Status::Fallback;
            total.code = boxOutcome.code;
            return total;
        default:
            break;
        }
    }
    return total;
}

// companions.lua visibleFromCrosshair: Clear when no group is hit.
Outcome CheckSight(Probe& aProbe, const Vec3& aFrom, const Vec3& aTo, int aRemaining)
{
    if (!IsPoint(aFrom) || !IsPoint(aTo))
    {
        return Make(Status::Unavailable);
    }
    if (aRemaining < kGroupCount)
    {
        return Make(Status::Deferred);
    }
    // Vector4.new keeps float32.
    const Vec3 from{ToFloat32(aFrom.x), ToFloat32(aFrom.y), ToFloat32(aFrom.z)};
    const Vec3 to{ToFloat32(aTo.x), ToFloat32(aTo.y), ToFloat32(aTo.z)};
    Outcome outcome;
    for (int group = 0; group < kGroupCount; ++group)
    {
        ++outcome.used;
        const Hit hit = aProbe.Ray(from, to, kSightGroups[group], nullptr);
        if (hit == Hit::Error)
        {
            return Failed(aProbe, outcome.used);
        }
        if (hit == Hit::Blocked)
        {
            outcome.status = Status::Blocked;
            outcome.group = group;
            return outcome;
        }
    }
    return outcome;
}

// companions.lua floorBelow.
Outcome CheckFloor(Probe& aProbe, const Vec3& aAt, double aMaxDrop)
{
    if (!IsPoint(aAt) || !IsFinite(aMaxDrop))
    {
        return Make(Status::Unavailable);
    }
    const Vec3 from{ToFloat32(aAt.x), ToFloat32(aAt.y), ToFloat32(aAt.z + 0.6)};
    const Vec3 to{ToFloat32(aAt.x), ToFloat32(aAt.y), ToFloat32(aAt.z - 0.8)};
    double hitZ = 0;
    const Hit hit = aProbe.Ray(from, to, "Static", &hitZ);
    if (hit == Hit::Error)
    {
        return Failed(aProbe, 0);
    }
    if (hit != Hit::Blocked)
    {
        return Make(Status::Blocked);
    }
    const double drop = aAt.z - hitZ;
    if (drop < 0.05 || drop > aMaxDrop)
    {
        return Make(Status::Blocked);
    }
    Outcome outcome;
    outcome.z = hitZ;
    return outcome;
}
} // namespace convai::clearance
