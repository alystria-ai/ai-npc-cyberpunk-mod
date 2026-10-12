#include "systems/clearance/core/ClearanceCore.hpp"

#include <cstdio>
#include <string>

namespace convai::clearance
{
namespace
{
void AppendInt(std::string& aOut, int aValue)
{
    char text[32];
    std::snprintf(text, sizeof(text), " %d", aValue);
    aOut += text;
}

// %.17g reads back exactly in Lua.
void AppendNumber(std::string& aOut, double aValue)
{
    char text[48];
    std::snprintf(text, sizeof(text), " %.17g", aValue);
    aOut += text;
}
} // namespace

std::string FormatOutcome(const Outcome& aOutcome, bool aSegment)
{
    std::string out = std::to_string(static_cast<int>(aOutcome.status));
    AppendInt(out, aOutcome.used);
    switch (aOutcome.status)
    {
    case Status::Blocked:
        AppendInt(out, aOutcome.group + 1);
        AppendNumber(out, aOutcome.box.center.x);
        AppendNumber(out, aOutcome.box.center.y);
        AppendNumber(out, aOutcome.box.center.z);
        AppendNumber(out, aOutcome.box.half.x);
        AppendNumber(out, aOutcome.box.half.y);
        AppendNumber(out, aOutcome.box.half.z);
        AppendNumber(out, aOutcome.box.roll);
        AppendNumber(out, aOutcome.box.pitch);
        AppendNumber(out, aOutcome.box.yaw);
        if (aSegment)
        {
            AppendInt(out, aOutcome.boxIndex);
            AppendInt(out, aOutcome.boxCount);
        }
        break;
    case Status::Deferred:
        if (aSegment)
        {
            AppendInt(out, aOutcome.nextBox);
        }
        break;
    case Status::Fallback:
        AppendInt(out, aOutcome.code);
        break;
    case Status::Geometry:
        AppendInt(out, static_cast<int>(aOutcome.kind));
        AppendNumber(out, aOutcome.length);
        AppendNumber(out, aOutcome.rise);
        AppendNumber(out, aOutcome.deltaZ);
        AppendNumber(out, aOutcome.allowedRise);
        AppendInt(out, aOutcome.boxCount);
        break;
    case Status::Clear:
    case Status::Unavailable:
        break;
    }
    return out;
}

std::string FormatSight(const Outcome& aOutcome)
{
    std::string out = std::to_string(static_cast<int>(aOutcome.status));
    AppendInt(out, aOutcome.used);
    if (aOutcome.status == Status::Blocked)
    {
        AppendInt(out, aOutcome.group + 1);
    }
    else if (aOutcome.status == Status::Fallback)
    {
        AppendInt(out, aOutcome.code);
    }
    return out;
}

std::string FormatFloor(const Outcome& aOutcome)
{
    std::string out;
    switch (aOutcome.status)
    {
    case Status::Clear:
        out = "1";
        AppendNumber(out, aOutcome.z);
        break;
    case Status::Fallback:
        out = "-1";
        AppendInt(out, aOutcome.code);
        break;
    default:
        out = "0 0";
        break;
    }
    return out;
}
} // namespace convai::clearance
