#include "systems/chauffeur/core/ChauffeurCore.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>

namespace convai::chauffeur
{
namespace
{
void AppendFlag(std::string& aOut, bool aValue)
{
    aOut += aValue ? " 1" : " 0";
}

void AppendId(std::string& aOut, uint64_t aValue)
{
    aOut += ' ';
    aOut += std::to_string(aValue);
}

void AppendInt(std::string& aOut, int aValue)
{
    aOut += ' ';
    aOut += std::to_string(aValue);
}

void AppendNumber(std::string& aOut, double aValue)
{
    aOut += ' ';
    aOut += FormatNumber(aValue);
}
} // namespace

bool RoutePositionValid(const Vec3& aPoint)
{
    const double values[3] = {aPoint.x, aPoint.y, aPoint.z};
    for (const double value : values)
    {
        if (!std::isfinite(value) || std::fabs(value) > kRouteLimit)
        {
            return false;
        }
    }
    return true;
}

bool ValidCommandId(uint32_t aId)
{
    return aId != kUnassignedCommandId;
}

ActorResult DecideActor(const ActorRaw& aRaw)
{
    ActorResult result;
    result.attached = aRaw.npcPresent && aRaw.attached;
    result.dead = result.attached && aRaw.dead;
    result.valid = result.attached && !result.dead && aRaw.sameEntity && aRaw.ownerPresent && aRaw.ownerReady
        && aRaw.managed && aRaw.tagged;
    result.calm = result.valid && !aRaw.inCombat;
    return result;
}

bool CommandMatches(const CommandRead& aCommand, bool aHasReceipt, double aReceiptId, const std::string& aReceiptClass)
{
    return aHasReceipt && aCommand.present && aCommand.className == aReceiptClass && ValidCommandId(aCommand.id)
        && static_cast<double>(aCommand.id) == aReceiptId;
}

StateSource PlanState(const DriveRaw& aRaw)
{
    if (!aRaw.hasOperation || !aRaw.hasReceipt)
    {
        return StateSource::None;
    }
    const bool ownedActive = CommandMatches(aRaw.direct, aRaw.hasReceipt, aRaw.receiptId, aRaw.receiptClass);
    // Lua: handle = operation.handle or ownedActive and direct
    if (aRaw.given.present)
    {
        return CommandMatches(aRaw.given, aRaw.hasReceipt, aRaw.receiptId, aRaw.receiptClass) ? StateSource::Given
                                                                                             : StateSource::None;
    }
    if (ownedActive)
    {
        return StateSource::Direct;
    }
    return StateSource::None;
}

DriveResult DecideDrive(const DriveRaw& aRaw)
{
    DriveResult result;
    if (!aRaw.aiPresent)
    {
        result.status = DriveStatus::AiMissing;
        return result;
    }
    if (!aRaw.typesValid)
    {
        result.status = DriveStatus::TypesInvalid;
        return result;
    }
    if (aRaw.hasOperation && !aRaw.hasReceipt)
    {
        result.status = DriveStatus::IdentityMissing;
        return result;
    }
    result.status = DriveStatus::Ok;

    const bool ownedActive = CommandMatches(aRaw.direct, aRaw.hasReceipt, aRaw.receiptId, aRaw.receiptClass);
    const bool foreign = (aRaw.current.present
                             && !CommandMatches(aRaw.current, aRaw.hasReceipt, aRaw.receiptId, aRaw.receiptClass))
        || (aRaw.initial.present && !CommandMatches(aRaw.initial, aRaw.hasReceipt, aRaw.receiptId, aRaw.receiptClass))
        || aRaw.automatic || aRaw.enabled || (aRaw.executing && !ownedActive);

    result.ready = aRaw.commands && !aRaw.scene;
    result.reservations = aRaw.reservations;
    result.busy = aRaw.current.present || aRaw.initial.present || aRaw.executing;
    result.foreign = foreign;
    result.ownedActive = ownedActive;

    if (!aRaw.hasOperation)
    {
        result.state = kStateNone;
    }
    else if (PlanState(aRaw) != StateSource::None)
    {
        result.state = aRaw.state;
    }
    else if (aRaw.activeCheck == 1)
    {
        result.state = 0; // NotExecuting
    }
    else if (aRaw.activeCheck == 0)
    {
        result.state = 3; // Cancelled
    }
    else
    {
        result.state = kStatePending; // IsCommandActive not asked (-1)
    }

    result.hasCommandId = aRaw.hasReceipt;
    result.commandId = aRaw.receiptId;

    result.hasCurrentId = aRaw.current.present && ValidCommandId(aRaw.current.id);
    if (result.hasCurrentId)
    {
        result.currentId = static_cast<double>(aRaw.current.id);
    }
    result.currentClass = aRaw.current.present ? aRaw.current.className : std::string();

    result.hasRemaining = aRaw.hasTelemetry;
    if (aRaw.hasTelemetry)
    {
        // Lua math.max(0, length - progress); NaN and -0.0 both give 0.
        const double difference = aRaw.pathLength - aRaw.pathProgress;
        result.remaining = difference > 0.0 ? difference : 0.0;
    }
    return result;
}

WaypointResult DecideWaypoint(const WaypointRaw& aRaw)
{
    WaypointResult result;
    const bool present = aRaw.tracked && aRaw.id != 0 && aRaw.pinPresent && aRaw.hasDestination && aRaw.hasMarker
        && RoutePositionValid(aRaw.destination) && RoutePositionValid(aRaw.marker);
    if (!present)
    {
        return result;
    }
    result.present = true;
    result.id = aRaw.id;
    result.position = aRaw.destination;
    result.marker = aRaw.marker;
    result.quest = aRaw.quest;
    result.rawName = aRaw.rawName;
    return result;
}

// %.17g reads back exactly in Lua.
std::string FormatNumber(double aValue)
{
    if (std::isnan(aValue))
    {
        return "nan";
    }
    if (std::isinf(aValue))
    {
        return aValue > 0.0 ? "inf" : "-inf";
    }
    char text[48];
    std::snprintf(text, sizeof(text), "%.17g", aValue);
    return text;
}

std::string FormatActor(const ActorResult& aResult)
{
    std::string out = "A";
    AppendFlag(out, aResult.attached);
    AppendFlag(out, aResult.dead);
    AppendFlag(out, aResult.valid);
    AppendFlag(out, aResult.calm);
    return out;
}

std::string FormatPlayer(const PlayerRaw& aRaw)
{
    std::string out = "P";
    AppendId(out, aRaw.id);
    AppendFlag(out, aRaw.passenger);
    AppendFlag(out, aRaw.combat);
    return out;
}

std::string FormatSummon(const SummonRaw& aRaw)
{
    std::string out = "S";
    AppendId(out, aRaw.summoned);
    AppendNumber(out, aRaw.state);
    return out;
}

std::string FormatAuto(const AutoRaw& aRaw)
{
    std::string out = "U";
    AppendFlag(out, aRaw.enabled);
    AppendFlag(out, aRaw.delamain);
    AppendFlag(out, aRaw.available);
    AppendFlag(out, aRaw.laneValid);
    AppendInt(out, static_cast<int>(aRaw.destination));
    AppendFlag(out, aRaw.freeRoam);
    AppendNumber(out, aRaw.remaining);
    AppendId(out, aRaw.vehicle);
    AppendId(out, aRaw.destinationId);
    return out;
}

std::string FormatCar(const CarRaw& aRaw)
{
    std::string out = "C";
    AppendFlag(out, aRaw.live);
    AppendId(out, aRaw.id);
    AppendFlag(out, aRaw.carValid);
    AppendFlag(out, aRaw.positionValid);
    if (aRaw.positionValid)
    {
        AppendNumber(out, aRaw.position.x);
        AppendNumber(out, aRaw.position.y);
        AppendNumber(out, aRaw.position.z);
    }
    else
    {
        AppendNumber(out, 0.0);
        AppendNumber(out, 0.0);
        AppendNumber(out, 0.0);
    }
    return out;
}

std::string FormatDrive(const DriveResult& aResult)
{
    if (aResult.status != DriveStatus::Ok)
    {
        std::string out = "D";
        AppendInt(out, static_cast<int>(aResult.status));
        return out;
    }

    std::string out = "D";
    AppendInt(out, static_cast<int>(DriveStatus::Ok));
    AppendFlag(out, aResult.ready);
    AppendNumber(out, aResult.reservations);
    AppendFlag(out, aResult.busy);
    AppendFlag(out, aResult.foreign);
    AppendFlag(out, aResult.ownedActive);

    out += ' ';
    if (aResult.state == kStateNone)
    {
        out += '-';
    }
    else if (aResult.state == kStatePending)
    {
        out += '?';
    }
    else
    {
        out += std::to_string(aResult.state);
    }

    out += ' ';
    out += aResult.hasCommandId ? FormatNumber(aResult.commandId) : std::string("-");
    out += ' ';
    out += aResult.hasCurrentId ? FormatNumber(aResult.currentId) : std::string("-");
    out += ' ';
    out += aResult.hasRemaining ? FormatNumber(aResult.remaining) : std::string("-");
    out += ' ';
    out += aResult.currentClass.empty() ? std::string("-") : aResult.currentClass;
    return out;
}

std::string FormatWaypoint(const WaypointResult& aResult)
{
    if (!aResult.present)
    {
        return "W 0";
    }
    std::string out = "W 1";
    AppendId(out, aResult.id);
    AppendNumber(out, aResult.position.x);
    AppendNumber(out, aResult.position.y);
    AppendNumber(out, aResult.position.z);
    AppendNumber(out, aResult.marker.x);
    AppendNumber(out, aResult.marker.y);
    AppendNumber(out, aResult.marker.z);
    AppendFlag(out, aResult.quest);
    out += ' ';
    out += aResult.rawName.empty() ? std::string("-") : aResult.rawName;
    return out;
}
} // namespace convai::chauffeur
