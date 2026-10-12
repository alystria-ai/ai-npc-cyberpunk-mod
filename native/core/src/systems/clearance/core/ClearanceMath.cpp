#include "systems/clearance/core/ClearanceCore.hpp"

#include <algorithm>
#include <cmath>

namespace convai::clearance
{
bool IsFinite(double aValue)
{
    return !std::isnan(aValue) && std::fabs(aValue) < kFiniteLimit;
}

bool IsPoint(const Vec3& aPoint)
{
    return IsFinite(aPoint.x) && IsFinite(aPoint.y) && IsFinite(aPoint.z);
}

bool ValidShape(const Shape& aShape)
{
    return IsFinite(aShape.radius) && IsFinite(aShape.height) && aShape.radius >= 0.2 && aShape.radius <= 3 &&
           aShape.height >= 0.5 && aShape.height <= 6;
}

int SegmentBoxes(const Vec3& aFrom, const Vec3& aTo)
{
    const double dx = aTo.x - aFrom.x;
    const double dy = aTo.y - aFrom.y;
    const double length = std::sqrt(dx * dx + dy * dy);
    const double horizontal = std::ceil(length / 2);
    const double vertical = std::ceil(std::fabs(aTo.z - aFrom.z) / 0.2);
    const double boxes = std::min(std::max({1.0, horizontal, vertical}), 1000000000.0);
    return static_cast<int>(boxes);
}

double ToFloat32(double aValue)
{
    return static_cast<double>(static_cast<float>(aValue));
}

Box RoundToFloat32(const Box& aBox)
{
    Box box;
    box.half = {ToFloat32(aBox.half.x), ToFloat32(aBox.half.y), ToFloat32(aBox.half.z)};
    box.center = {ToFloat32(aBox.center.x), ToFloat32(aBox.center.y), ToFloat32(aBox.center.z)};
    box.roll = ToFloat32(aBox.roll);
    box.pitch = ToFloat32(aBox.pitch);
    box.yaw = ToFloat32(aBox.yaw);
    return box;
}

Euler OrientationOf(double aDx, double aDy)
{
    constexpr double kPi = 3.14159265358979323846;
    Euler euler;
    // "+ 0.0" turns a negative zero into a positive one, so (0, -1) is +180 and not -180.
    euler.yaw = std::atan2(-aDx + 0.0, aDy) * 180.0 / kPi;
    return euler;
}
} // namespace convai::clearance
