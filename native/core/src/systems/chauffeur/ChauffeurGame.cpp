#include "systems/chauffeur/ChauffeurGame.hpp"

#include "core/Log.hpp"

#include <RED4ext/CName.hpp>
#include <RED4ext/NativeTypes.hpp>
#include <RED4ext/RTTITypes.hpp>
#include <RED4ext/Scripting/Natives/Generated/ent/EntityID.hpp>
#include <RED4ext/Scripting/Natives/Vector4.hpp>

#include <cmath>
#include <cstring>

namespace convai::chauffeur::game
{
namespace
{
using namespace convai::vreflect;

constexpr const char* kDriveClass = "AIVehicleDriveToPointAutonomousCommand";
constexpr const char* kTag = "CyberpunkConvaiCompanion";

// One slot per call site (Find re-resolves when the instance class differs).
Slot g_npcAttached, g_npcDead, g_npcId, g_ownerReady, g_ownerManaged, g_ownerTagged, g_playerId, g_playerCombat,
    g_carAttached, g_carVehicle, g_carPlayer, g_carDestroyed, g_carId, g_carRecord, g_recordType, g_typeValue,
    g_carPosition, g_container, g_autoEnabled, g_autoDelamain, g_autoAvailable, g_autoLane, g_autoFreeRoam,
    g_autoRemaining, g_autoVehicle, g_vehicleId, g_destMappin, g_destType, g_destPosition, g_getMappin, g_pinPosition,
    g_pinName, g_ai, g_current, g_direct, g_initial, g_executing, g_automatic, g_driveEnabled, g_commands, g_scene,
    g_reserved, g_cmdState, g_pathLength, g_pathProgress;

bool Present(const Object& aObject)
{
    return static_cast<bool>(aObject) && aObject.instance != nullptr;
}

// A Vector4 or Vector3 return value as doubles (the Lua reads .x .y .z of either).
bool ReadPoint(const Value& aValue, Vec3& aOut)
{
    const std::string type = aValue.TypeName();
    if (type == "Vector4")
    {
        const auto* v = static_cast<const RED4ext::Vector4*>(aValue.Data());
        aOut = {v->X, v->Y, v->Z};
        return true;
    }
    if (type == "Vector3")
    {
        const auto* v = static_cast<const float*>(aValue.Data());
        aOut = {v[0], v[1], v[2]};
        return true;
    }
    return false;
}

// Game.GetScriptableSystemsContainer():Get(CName.new('AutoDriveSystem'))
Object AutoSystem()
{
    Object container = GlobalSystem("GetScriptableSystemsContainer;GameInstance");
    if (!Present(container))
    {
        return {};
    }
    RED4ext::CName name("AutoDriveSystem");
    Object system;
    if (!CallObject(g_container, container, "Get", system, {&name}))
    {
        return {};
    }
    return system;
}

int64_t Member(const char* aEnum, const char* aMember)
{
    return EnumValue(aEnum, aMember);
}

// ---- A: the actor ------------------------------------------------------------------------------

bool ReadActor(const SampleArgs& aArgs, ActorRaw& aRaw)
{
    aRaw = ActorRaw{};
    aRaw.npcPresent = Present(aArgs.npc);
    if (!aRaw.npcPresent)
    {
        return true;
    }
    if (!CallBool(g_npcAttached, aArgs.npc, "IsAttached", aRaw.attached))
    {
        return false;
    }
    if (!aRaw.attached)
    {
        return true;
    }
    if (!CallBool(g_npcDead, aArgs.npc, "IsDeadNoStatPool", aRaw.dead))
    {
        return false;
    }
    if (aRaw.dead)
    {
        return true;
    }
    uint64_t hash = 0;
    if (!CallId(g_npcId, aArgs.npc, "GetEntityID", hash))
    {
        return false;
    }
    aRaw.sameEntity = hash == aArgs.actorHash;
    aRaw.ownerPresent = Present(aArgs.owner);
    if (!aRaw.sameEntity || !aRaw.ownerPresent)
    {
        return true;
    }
    if (!CallBool(g_ownerReady, aArgs.owner, "IsReady", aRaw.ownerReady))
    {
        return false;
    }
    if (!aRaw.ownerReady)
    {
        return true;
    }
    RED4ext::EntityID id{};
    id.hash = aArgs.actorHash;
    if (!CallBool(g_ownerManaged, aArgs.owner, "IsManaged", aRaw.managed, {&id}))
    {
        return false;
    }
    if (!aRaw.managed)
    {
        return true;
    }
    RED4ext::CName tag(kTag);
    if (!CallBool(g_ownerTagged, aArgs.owner, "IsTagged", aRaw.tagged, {&id, &tag}))
    {
        return false;
    }
    if (!aRaw.tagged)
    {
        return true;
    }
    // Lua: NPCPuppet.IsInCombat(npc), only for a valid actor. The flag is read through whichever route of
    // convai::game::PuppetInCombat resolved. When none did (or the call failed) it is UNKNOWN, not an unavailable
    // section: the actor section still answers, with calm marked "?", and the Lua asks the one field itself.
    // Live 2026-10-18 a missing function here failed every sample and put the system on Lua after 20 of them.
    aRaw.combatKnown = convai::game::PuppetInCombat(aArgs.npc, aRaw.inCombat);
    if (!aRaw.combatKnown)
    {
        aRaw.inCombat = false;
    }
    return true;
}

// ---- P: the player -----------------------------------------------------------------------------

bool ReadPlayer(const SampleArgs& aArgs, PlayerRaw& aRaw)
{
    aRaw = PlayerRaw{};
    if (!Present(aArgs.player))
    {
        return false;
    }
    if (!CallId(g_playerId, aArgs.player, "GetEntityID", aRaw.id))
    {
        return false;
    }
    RED4ext::CBaseFunction* function = StaticFunction("PlayerPuppet", "GetCurrentVehicleState", 1);
    const int64_t passenger = Member("gamePSMVehicle", "Passenger");
    Value state;
    Object player = aArgs.player;
    double number = 0.0;
    if (!function || passenger < 0 || !Invoke(nullptr, function, &state, {&player}) || !state.Number(number))
    {
        return false;
    }
    aRaw.passenger = static_cast<int64_t>(number) == passenger;
    return CallBool(g_playerCombat, aArgs.player, "IsInCombat", aRaw.combat);
}

// ---- C: the leased car -------------------------------------------------------------------------

bool ReadCar(const SampleArgs& aArgs, CarRaw& aRaw)
{
    aRaw = CarRaw{};
    if (!Present(aArgs.car))
    {
        return true;
    }
    bool flag = false;
    if (!CallBool(g_carAttached, aArgs.car, "IsAttached", flag))
    {
        return false;
    }
    if (!flag)
    {
        return true;
    }
    if (!CallBool(g_carVehicle, aArgs.car, "IsVehicle", flag))
    {
        return false;
    }
    if (!flag)
    {
        return true;
    }
    bool playerVehicle = false;
    if (!CallBool(g_carPlayer, aArgs.car, "IsPlayerVehicle", playerVehicle))
    {
        return false;
    }
    if (!playerVehicle)
    {
        return true;
    }
    uint64_t hash = 0;
    if (!CallId(g_carId, aArgs.car, "GetEntityID", hash))
    {
        return false;
    }
    if (hash != aArgs.carHash)
    {
        return true;
    }
    aRaw.live = true;
    aRaw.id = hash;

    // carValid = IsPlayerVehicle and not IsDestroyed and the record type is Car.
    bool destroyed = false;
    if (!CallBool(g_carDestroyed, aArgs.car, "IsDestroyed", destroyed))
    {
        return false;
    }
    if (!destroyed)
    {
        const int64_t car = Member("gamedataVehicleType", "Car");
        Object record;
        if (car < 0 || !CallObject(g_carRecord, aArgs.car, "GetRecord", record))
        {
            return false;
        }
        // A missing record or type makes the Lua throw; the section fails so the Lua runs and throws the same way.
        Object type;
        double value = 0.0;
        if (!Present(record) || !CallObject(g_recordType, record, "Type", type) || !Present(type) ||
            !CallNumber(g_typeValue, type, "Type", value))
        {
            return false;
        }
        aRaw.carValid = static_cast<int64_t>(value) == car;
    }

    Value position;
    if (!Call(g_carPosition, aArgs.car, "GetWorldPosition", &position))
    {
        return false;
    }
    Vec3 point;
    if (!ReadPoint(position, point))
    {
        return false;
    }
    aRaw.position = point;
    aRaw.positionValid = RoutePositionValid(point);
    return true;
}

// ---- U and W: the AutoDrive system and the tracked destination -----------------------------------

bool ReadAuto(const Object& aSystem, AutoRaw& aRaw, DestinationType& aKind)
{
    aRaw = AutoRaw{};
    const int64_t tracked = Member("gameAutodriveDestinationType", "PlayerTracked");
    const int64_t quest = Member("gameAutodriveDestinationType", "Quest");
    const int64_t valid = Member("gameAutodriveLaneValidityResult", "OnValidLane");
    if (tracked < 0 || quest < 0 || valid < 0)
    {
        return false;
    }
    double number = 0.0;
    if (!CallId(g_destMappin, aSystem, "GetAutodriveDestinationMappinID", aRaw.destinationId))
    {
        return false;
    }
    if (!CallNumber(g_destType, aSystem, "GetAutodriveDestinationType", number))
    {
        return false;
    }
    const int64_t kind = static_cast<int64_t>(number);
    aRaw.destination = kind == quest      ? DestinationType::Quest
                       : kind == tracked ? DestinationType::PlayerTracked
                                         : DestinationType::None;
    aKind = aRaw.destination;
    if (!CallBool(g_autoEnabled, aSystem, "GetAutodriveEnabled", aRaw.enabled) ||
        !CallBool(g_autoDelamain, aSystem, "GetAutodriveIsDelamain", aRaw.delamain))
    {
        return false;
    }
    Object vehicle;
    if (!CallObject(g_autoVehicle, aSystem, "GetAutodriveVehicle", vehicle))
    {
        return false;
    }
    if (Present(vehicle) && !CallId(g_vehicleId, vehicle, "GetEntityID", aRaw.vehicle))
    {
        return false;
    }
    if (!CallBool(g_autoAvailable, aSystem, "GetAutodriveAvailable", aRaw.available))
    {
        return false;
    }
    if (!CallNumber(g_autoLane, aSystem, "CheckCurrentLaneValidity", number))
    {
        return false;
    }
    aRaw.laneValid = static_cast<int64_t>(number) == valid;
    return CallBool(g_autoFreeRoam, aSystem, "GetFreeRoamEnabled", aRaw.freeRoam) &&
           CallNumber(g_autoRemaining, aSystem, "GetDistanceToCurrentDestination", aRaw.remaining);
}

// Lua waypoint(): the selected native destination and its map pin.
bool ReadWaypoint(const Object& aSystem, const AutoRaw& aAuto, WaypointRaw& aRaw)
{
    aRaw = WaypointRaw{};
    aRaw.tracked = aAuto.destination != DestinationType::None;
    aRaw.quest = aAuto.destination == DestinationType::Quest;
    aRaw.id = aAuto.destinationId;
    if (!aRaw.tracked || aRaw.id == 0)
    {
        return true;
    }
    Object maps = GlobalSystem("GetMappinSystem;GameInstance");
    if (!Present(maps))
    {
        return false;
    }
    uint64_t mappinId = aRaw.id;
    Object pin;
    if (!CallObject(g_getMappin, maps, "GetMappin", pin, {&mappinId}))
    {
        return false;
    }
    aRaw.pinPresent = Present(pin);
    if (!aRaw.pinPresent)
    {
        return true;
    }
    Value destination;
    if (!Call(g_destPosition, aSystem, "GetAutodriveDestination", &destination) ||
        !ReadPoint(destination, aRaw.destination))
    {
        return false;
    }
    aRaw.hasDestination = true;
    Value marker;
    if (!Call(g_pinPosition, pin, "GetWorldPosition", &marker) || !ReadPoint(marker, aRaw.marker))
    {
        return false;
    }
    aRaw.hasMarker = true;
    if (RoutePositionValid(aRaw.destination) && RoutePositionValid(aRaw.marker))
    {
        // Lua pin:GetDisplayName(): only a String counts; anything else gives the fallback name.
        Value name;
        if (Call(g_pinName, pin, "GetDisplayName", &name) && name.TypeName() == "String")
        {
            aRaw.rawName = static_cast<const RED4ext::CString*>(name.Data())->c_str();
        }
    }
    return true;
}

// ---- D: the car's drive-command reads ------------------------------------------------------------

bool ReadCommand(const Object& aHandle, CommandRead& aOut)
{
    aOut = CommandRead{};
    if (!Present(aHandle))
    {
        return true;
    }
    aOut.present = true;
    RED4ext::CClass* type = aHandle.instance->GetType();
    if (!type)
    {
        return false;
    }
    aOut.className = type->GetName().ToString();
    RED4ext::CProperty* property = type->GetProperty("id");
    if (!property || !property->type || std::strcmp(property->type->GetName().ToString(), "Uint32") != 0)
    {
        return false;
    }
    aOut.id = property->GetValue<uint32_t>(aHandle.instance);
    return true;
}

bool ReadDrive(const Object& aCar, const DriveArgs& aArgs, DriveRaw& aRaw)
{
    aRaw = DriveRaw{};
    Object ai;
    if (!CallObject(g_ai, aCar, "GetAIComponent", ai))
    {
        return false;
    }
    aRaw.aiPresent = Present(ai);
    if (!aRaw.aiPresent)
    {
        return true;
    }
    aRaw.hasOperation = aArgs.hasOperation;
    aRaw.hasReceipt = aArgs.hasReceipt;
    aRaw.receiptId = aArgs.receiptId;
    aRaw.receiptClass = aArgs.receiptClass;

    Object current, direct, initial;
    {
        RED4ext::CName vehicleCommand("AIVehicleCommand");
        RED4ext::CName driveClass(kDriveClass);
        bool inherit = true;
        bool exact = false;
        if (!CallObject(g_current, ai, "GetEnqueuedOrExecutingCommand", current, {&vehicleCommand, &inherit}) ||
            !CallObject(g_direct, ai, "GetEnqueuedOrExecutingCommand", direct, {&driveClass, &exact}) ||
            !CallObject(g_initial, ai, "GetInitCmd", initial))
        {
            return false;
        }
    }
    if (!ReadCommand(current, aRaw.current) || !ReadCommand(direct, aRaw.direct) ||
        !ReadCommand(initial, aRaw.initial) || !ReadCommand(aArgs.given, aRaw.given))
    {
        return false;
    }

    Object autoSystem = AutoSystem();
    if (!Present(autoSystem))
    {
        return false;
    }
    if (!CallBool(g_executing, aCar, "IsExecutingAnyCommand", aRaw.executing) ||
        !CallBool(g_automatic, aCar, "IsAutoDriveModeEnabled", aRaw.automatic) ||
        !CallBool(g_driveEnabled, autoSystem, "GetAutodriveEnabled", aRaw.enabled) ||
        !CallBool(g_commands, aCar, "CommandsFromDriverEnabled", aRaw.commands) ||
        !CallNumber(g_reserved, ai, "GetReservedSeatsCount", aRaw.reservations))
    {
        return false;
    }
    // Lua: ready = commands and not entity:IsPerformingSceneAnimation().
    if (aRaw.commands && !CallBool(g_scene, aCar, "IsPerformingSceneAnimation", aRaw.scene))
    {
        return false;
    }

    if (aRaw.hasOperation && aRaw.hasReceipt)
    {
        const StateSource source = PlanState(aRaw);
        if (source != StateSource::None)
        {
            Object handle = source == StateSource::Given ? aArgs.given : direct;
            Value state;
            RED4ext::CBaseFunction* function = Find(g_cmdState, ai.instance, "GetCommandState", 1);
            double number = 0.0;
            if (!function || !Invoke(ai.instance, function, &state, {&handle}) || !state.Number(number) ||
                number < 0.0 || number > 6.0)
            {
                return false;
            }
            aRaw.state = static_cast<int>(number);
        }
    }

    // The path telemetry is optional in the Lua (a pcall): a missing or unreadable value is just absent.
    double length = 0.0;
    double progress = 0.0;
    if (CallNumber(g_pathLength, aCar, "GetCurrentSlotLocalPathLength", length) &&
        CallNumber(g_pathProgress, aCar, "GetCurrentSlotLocalPathProgression", progress) && !std::isnan(length) &&
        !std::isnan(progress))
    {
        aRaw.hasTelemetry = true;
        aRaw.pathLength = length;
        aRaw.pathProgress = progress;
    }
    return true;
}

void Append(std::string& aOut, const std::string& aSection)
{
    if (!aOut.empty())
    {
        aOut += ' ';
    }
    aOut += aSection;
}
} // namespace

std::string Sample(const SampleArgs& aArgs)
{
    std::string out;

    ActorRaw actor;
    Append(out, ReadActor(aArgs, actor) ? FormatActor(DecideActor(actor)) : std::string("A !"));

    PlayerRaw player;
    Append(out, ReadPlayer(aArgs, player) ? FormatPlayer(player) : std::string("P !"));

    CarRaw car;
    const bool carRead = ReadCar(aArgs, car);
    Append(out, carRead ? FormatCar(car) : std::string("C !"));
    if (carRead && car.live)
    {
        DriveRaw drive;
        Append(out, ReadDrive(aArgs.car, aArgs.drive, drive) ? FormatDrive(DecideDrive(drive)) : std::string("D !"));
    }

    AutoRaw autoRaw;
    DestinationType kind = DestinationType::None;
    Object autoSystem = AutoSystem();
    const bool autoRead = Present(autoSystem) && ReadAuto(autoSystem, autoRaw, kind);
    Append(out, autoRead ? FormatAuto(autoRaw) : std::string("U !"));

    // W is last: its raw name is the rest of the text.
    WaypointRaw waypointRaw;
    if (autoRead && ReadWaypoint(autoSystem, autoRaw, waypointRaw))
    {
        Append(out, FormatWaypoint(DecideWaypoint(waypointRaw)));
    }
    else
    {
        Append(out, "W !");
    }
    return out;
}

std::string Drive(const Object& aCar, uint64_t aCarHash, const DriveArgs& aArgs)
{
    if (!Present(aCar))
    {
        return "0";
    }
    SampleArgs args;
    args.car = aCar;
    args.carHash = aCarHash;
    args.drive = aArgs;
    CarRaw car;
    if (!ReadCar(args, car))
    {
        return std::string();
    }
    if (!car.live)
    {
        return "0";
    }
    DriveRaw drive;
    if (!ReadDrive(aCar, aArgs, drive))
    {
        return std::string();
    }
    return "1 " + FormatDrive(DecideDrive(drive));
}
} // namespace convai::chauffeur::game
