#include "ActuatorCore.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <system_error>

namespace convai::actuator
{
namespace
{
constexpr double kPi = 3.14159265358979323846;

void AppendNumber(std::string& aOut, double aValue)
{
    char buffer[40];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), aValue);
    aOut.append(buffer, result.ptr);
}

void AppendInt(std::string& aOut, int aValue)
{
    char buffer[16];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), aValue);
    aOut.append(buffer, result.ptr);
}

bool ParseDouble(std::string_view aToken, double& aOut)
{
    const auto result = std::from_chars(aToken.data(), aToken.data() + aToken.size(), aOut);
    return result.ec == std::errc() && result.ptr == aToken.data() + aToken.size();
}
} // namespace

Unit2 UnitOf(double aX, double aY)
{
    const double length = std::sqrt(aX * aX + aY * aY);
    if (length < 0.0001)
    {
        return {0.0, 1.0};
    }
    return {aX / length, aY / length};
}

double AngleDegrees(double aAx, double aAy, double aBx, double aBy)
{
    const Unit2 a = UnitOf(aAx, aAy);
    const Unit2 b = UnitOf(aBx, aBy);
    const double dot = std::max(-1.0, std::min(1.0, a.x * b.x + a.y * b.y));
    return std::acos(dot) * (180.0 / kPi);
}

double GroundDistance(double aAx, double aAy, double aBx, double aBy)
{
    const double dx = aAx - aBx;
    const double dy = aAy - aBy;
    return std::sqrt(dx * dx + dy * dy);
}

double Distance3(double aAx, double aAy, double aAz, double aBx, double aBy, double aBz)
{
    const double dx = aAx - aBx;
    const double dy = aAy - aBy;
    const double dz = aAz - aBz;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

SenseMath ComputeSense(const SenseInput& aInput)
{
    SenseMath out;
    out.speed = aInput.hasPrevious
                    ? GroundDistance(aInput.previousX, aInput.previousY, aInput.x, aInput.y) / aInput.step
                    : 0.0;
    out.direction = UnitOf(aInput.forwardX, aInput.forwardY);
    out.playerGap = Distance3(aInput.x, aInput.y, aInput.z, aInput.playerX, aInput.playerY, aInput.playerZ);
    // space.bearing(at, player) is unit(player - at); space.angle normalises both again.
    const Unit2 toPlayer = UnitOf(aInput.playerX - aInput.x, aInput.playerY - aInput.y);
    out.facingError = AngleDegrees(out.direction.x, out.direction.y, toPlayer.x, toPlayer.y);
    return out;
}

const char* CommandStateName(int aState)
{
    static const char* const kNames[kCommandStateCount] = {"NotExecuting", "Enqueued",  "Executing", "Cancelled",
                                                           "Interrupted",  "Success",   "Failure"};
    return aState >= 0 && aState < kCommandStateCount ? kNames[aState] : "";
}

const char* WireFields()
{
    return "flags x y z w fx fy state id speed dx dy gap facing";
}

std::string EncodeSense(const SenseWire& aWire)
{
    const double values[] = {aWire.x,
                             aWire.y,
                             aWire.z,
                             aWire.w,
                             aWire.forwardX,
                             aWire.forwardY,
                             aWire.commandId,
                             aWire.math.speed,
                             aWire.math.direction.x,
                             aWire.math.direction.y,
                             aWire.math.playerGap,
                             aWire.math.facingError};
    for (const double value : values)
    {
        if (!std::isfinite(value))
        {
            return {};
        }
    }
    std::string out;
    out.reserve(160);
    AppendInt(out, aWire.flags);
    for (int index = 0; index < 6; ++index)
    {
        out += ' ';
        AppendNumber(out, values[index]);
    }
    out += ' ';
    AppendInt(out, aWire.state);
    out += ' ';
    AppendNumber(out, aWire.commandId);
    for (int index = 7; index < 12; ++index)
    {
        out += ' ';
        AppendNumber(out, values[index]);
    }
    return out;
}

bool DecodeSense(std::string_view aText, SenseWire& aOut)
{
    double fields[14];
    size_t count = 0;
    size_t start = 0;
    bool finished = false;
    while (!finished)
    {
        if (count == 14)
        {
            return false; // more tokens than fields
        }
        size_t stop = aText.find(' ', start);
        if (stop == std::string_view::npos)
        {
            stop = aText.size();
            finished = true;
        }
        if (!ParseDouble(aText.substr(start, stop - start), fields[count]))
        {
            return false;
        }
        ++count;
        start = stop + 1;
    }
    if (count != 14)
    {
        return false;
    }
    aOut.flags = static_cast<int>(fields[0]);
    aOut.x = fields[1];
    aOut.y = fields[2];
    aOut.z = fields[3];
    aOut.w = fields[4];
    aOut.forwardX = fields[5];
    aOut.forwardY = fields[6];
    aOut.state = static_cast<int>(fields[7]);
    aOut.commandId = fields[8];
    aOut.math.speed = fields[9];
    aOut.math.direction = {fields[10], fields[11]};
    aOut.math.playerGap = fields[12];
    aOut.math.facingError = fields[13];
    return true;
}
} // namespace convai::actuator
