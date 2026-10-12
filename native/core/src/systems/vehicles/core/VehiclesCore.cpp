#include "systems/vehicles/core/VehiclesCore.hpp"

#include <cmath>
#include <cstdio>
#include <string>

namespace convai::vehicles
{
namespace
{
void AppendText(std::string& aOut, const std::string& aText)
{
    aOut += ' ';
    aOut += aText;
}

const char* FlagText(bool aValue)
{
    return aValue ? "1" : "0";
}
} // namespace

bool KeepSeat(const std::string& aName, bool aHasSlot, bool aMackinaw)
{
    return aHasSlot && !(aMackinaw && aName == kMackinawHiddenSeat);
}

InspectResult DecideInspect(const InspectRaw& aRaw)
{
    InspectResult result;
    if (!aRaw.attached)
    {
        result.status = InspectStatus::Detached;
        return result;
    }
    if (!aRaw.isVehicle)
    {
        result.status = InspectStatus::NotVehicle;
        return result;
    }
    if (aRaw.owned && !aRaw.aiPresent)
    {
        result.status = InspectStatus::NoAi;
        return result;
    }

    result.status = InspectStatus::Ready;
    result.invalid = aRaw.destroyed;
    result.aiPresent = aRaw.aiPresent;
    result.playerMounted = aRaw.playerMounted;
    result.scene = aRaw.scene;
    const double vx = aRaw.velocityX;
    const double vy = aRaw.velocityY;
    const double vz = aRaw.velocityZ;
    result.speed = std::sqrt(vx * vx + vy * vy + vz * vz);
    result.playerGap = std::sqrt(aRaw.distanceSquared);
    for (const SeatRead& seat : aRaw.seats)
    {
        if (!KeepSeat(seat.name, seat.hasSlot, aRaw.mackinaw))
        {
            continue;
        }
        result.seats.push_back(SeatInfo{seat.name, seat.occupant, aRaw.aiPresent && seat.reserved});
    }
    return result;
}

std::string FormatNumber(double aValue)
{
    if (std::isnan(aValue))
    {
        return "nan";
    }
    if (std::isinf(aValue))
    {
        return aValue < 0.0 ? "-inf" : "inf";
    }
    char text[48];
    std::snprintf(text, sizeof(text), "%.17g", aValue);
    return text;
}

std::string FormatInspect(const InspectResult& aResult)
{
    std::string out = "V " + std::to_string(static_cast<int>(aResult.status));
    if (aResult.status != InspectStatus::Ready)
    {
        return out;
    }
    AppendText(out, FlagText(aResult.invalid));
    AppendText(out, FlagText(aResult.aiPresent));
    AppendText(out, FlagText(aResult.playerMounted));
    AppendText(out, FlagText(aResult.scene));
    AppendText(out, FormatNumber(aResult.speed));
    AppendText(out, FormatNumber(aResult.playerGap));
    AppendText(out, std::to_string(aResult.seats.size()));
    for (const SeatInfo& seat : aResult.seats)
    {
        AppendText(out, seat.name);
        AppendText(out, std::to_string(seat.occupant));
        AppendText(out, FlagText(seat.reserved));
    }
    return out;
}

std::string FormatMounting(bool aMounted, uint64_t aParentHash, const std::string& aSeat)
{
    if (!aMounted)
    {
        return "M -";
    }
    std::string out = "M " + std::to_string(aParentHash);
    AppendText(out, aSeat);
    return out;
}
} // namespace convai::vehicles
