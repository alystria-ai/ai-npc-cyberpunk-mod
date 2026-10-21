// Headless tests of the chauffeur sample: the decisions of DecideActor, DecideDrive and DecideWaypoint,
// and their wire format. The parity fixtures are recorded from the real mod/companion-chauffeur-native.lua
// by a fengari test: raw reads in, the Lua's own tables out, and the wire text each section must carry.

#include "Fixture.hpp"
#include "Test.hpp"
#include "Wire.hpp"

#include "systems/chauffeur/core/ChauffeurCore.hpp"

#include <cstdint>
#include <cstdlib>
#include <limits>
#include <string>

using namespace convai::chauffeur;
using convai::test::Fixture;

namespace
{
// Lookups tolerate a missing or non-object parent, so a malformed case fails a check instead of crashing.
yyjson_val* Member(yyjson_val* aObject, const char* aKey)
{
    return aObject && yyjson_is_obj(aObject) ? yyjson_obj_get(aObject, aKey) : nullptr;
}

std::string TextOf(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = Member(aObject, aKey);
    return value && yyjson_is_str(value) ? std::string(yyjson_get_str(value), yyjson_get_len(value)) : std::string();
}

bool Flag(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = Member(aObject, aKey);
    return value && yyjson_is_true(value);
}

double NumberOf(yyjson_val* aObject, const char* aKey, double aFallback = 0.0)
{
    yyjson_val* value = Member(aObject, aKey);
    return value && yyjson_is_num(value) ? yyjson_get_num(value) : aFallback;
}

int IntOf(yyjson_val* aObject, const char* aKey, int aFallback)
{
    return static_cast<int>(NumberOf(aObject, aKey, aFallback));
}

// Entity hashes and mappin ids are decimal strings in the fixture (exact beyond 2^53); a number is accepted too.
uint64_t IdOf(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = Member(aObject, aKey);
    if (value && yyjson_is_str(value))
    {
        return std::strtoull(TextOf(aObject, aKey).c_str(), nullptr, 10);
    }
    return value && yyjson_is_num(value) ? static_cast<uint64_t>(yyjson_get_num(value)) : 0;
}

Vec3 PointAt(double aX, double aY, double aZ)
{
    Vec3 point;
    point.x = aX;
    point.y = aY;
    point.z = aZ;
    return point;
}

// Zero everywhere except one axis: 0 = x, 1 = y, 2 = z.
Vec3 WithAxis(int aAxis, double aValue)
{
    Vec3 point;
    if (aAxis == 0)
    {
        point.x = aValue;
    }
    else if (aAxis == 1)
    {
        point.y = aValue;
    }
    else
    {
        point.z = aValue;
    }
    return point;
}

Vec3 PointOf(yyjson_val* aObject)
{
    return PointAt(NumberOf(aObject, "x"), NumberOf(aObject, "y"), NumberOf(aObject, "z"));
}

// The raw reads of one recorded "raw" section, the way the game layer collects them.
ActorRaw ActorOf(yyjson_val* aObject)
{
    ActorRaw raw;
    raw.npcPresent = Flag(aObject, "npcPresent");
    raw.attached = Flag(aObject, "attached");
    raw.dead = Flag(aObject, "dead");
    raw.sameEntity = Flag(aObject, "sameEntity");
    raw.ownerPresent = Flag(aObject, "ownerPresent");
    raw.ownerReady = Flag(aObject, "ownerReady");
    raw.managed = Flag(aObject, "managed");
    raw.tagged = Flag(aObject, "tagged");
    raw.inCombat = Flag(aObject, "inCombat");
    return raw;
}

PlayerRaw PlayerOf(yyjson_val* aObject)
{
    PlayerRaw raw;
    raw.id = IdOf(aObject, "id");
    raw.passenger = Flag(aObject, "passenger");
    raw.combat = Flag(aObject, "combat");
    return raw;
}

SummonRaw SummonOf(yyjson_val* aObject)
{
    SummonRaw raw;
    raw.summoned = IdOf(aObject, "summoned");
    raw.state = NumberOf(aObject, "state");
    return raw;
}

CarRaw CarOf(yyjson_val* aObject)
{
    CarRaw raw;
    raw.live = Flag(aObject, "live");
    raw.id = IdOf(aObject, "id");
    raw.carValid = Flag(aObject, "carValid");
    raw.positionValid = Flag(aObject, "positionValid");
    raw.position = PointOf(Member(aObject, "position"));
    return raw;
}

AutoRaw AutoOf(yyjson_val* aObject)
{
    AutoRaw raw;
    raw.enabled = Flag(aObject, "enabled");
    raw.delamain = Flag(aObject, "delamain");
    raw.available = Flag(aObject, "available");
    raw.laneValid = Flag(aObject, "laneValid");
    raw.destination = static_cast<DestinationType>(IntOf(aObject, "destination", 0));
    raw.freeRoam = Flag(aObject, "freeRoam");
    raw.remaining = NumberOf(aObject, "remaining");
    raw.vehicle = IdOf(aObject, "vehicle");
    raw.destinationId = IdOf(aObject, "destinationId");
    return raw;
}

WaypointRaw WaypointOf(yyjson_val* aObject)
{
    WaypointRaw raw;
    raw.tracked = Flag(aObject, "tracked");
    raw.quest = Flag(aObject, "quest");
    raw.id = IdOf(aObject, "id");
    raw.pinPresent = Flag(aObject, "pinPresent");
    raw.hasDestination = Flag(aObject, "hasDestination");
    raw.destination = PointOf(Member(aObject, "destination"));
    raw.hasMarker = Flag(aObject, "hasMarker");
    raw.marker = PointOf(Member(aObject, "marker"));
    raw.rawName = TextOf(aObject, "rawName");
    return raw;
}

CommandRead CommandOf(yyjson_val* aObject)
{
    CommandRead command;
    command.present = Flag(aObject, "present");
    command.id = static_cast<uint32_t>(NumberOf(aObject, "id"));
    command.className = TextOf(aObject, "className");
    return command;
}

// The drive reads. The raw also carries an "active" key the core must ignore; it is never read here.
DriveRaw DriveOf(yyjson_val* aObject)
{
    DriveRaw raw;
    raw.aiPresent = Flag(aObject, "aiPresent");
    raw.typesValid = Flag(aObject, "typesValid");
    raw.hasOperation = Flag(aObject, "hasOperation");
    raw.hasReceipt = Flag(aObject, "hasReceipt");
    raw.receiptId = NumberOf(aObject, "receiptId");
    raw.receiptClass = TextOf(aObject, "receiptClass");
    raw.current = CommandOf(Member(aObject, "current"));
    raw.direct = CommandOf(Member(aObject, "direct"));
    raw.initial = CommandOf(Member(aObject, "initial"));
    raw.given = CommandOf(Member(aObject, "given"));
    raw.executing = Flag(aObject, "executing");
    raw.automatic = Flag(aObject, "automatic");
    raw.enabled = Flag(aObject, "enabled");
    raw.commands = Flag(aObject, "commands");
    raw.scene = Flag(aObject, "scene");
    raw.reservations = NumberOf(aObject, "reservations");
    raw.state = IntOf(aObject, "state", -1);
    raw.activeCheck = IntOf(aObject, "activeCheck", -1);
    raw.hasTelemetry = Flag(aObject, "hasTelemetry");
    raw.pathLength = NumberOf(aObject, "pathLength");
    raw.pathProgress = NumberOf(aObject, "pathProgress");
    return raw;
}

// An actor that passes every check: attached, alive, the same entity, managed, tagged, calm.
ActorRaw ValidActor()
{
    ActorRaw raw;
    raw.npcPresent = true;
    raw.attached = true;
    raw.dead = false;
    raw.sameEntity = true;
    raw.ownerPresent = true;
    raw.ownerReady = true;
    raw.managed = true;
    raw.tagged = true;
    raw.inCombat = false;
    return raw;
}

// A drive with an operation whose receipt is 1801 of the drive class, and no command handles read yet.
DriveRaw HandleDrive()
{
    DriveRaw raw;
    raw.hasOperation = true;
    raw.hasReceipt = true;
    raw.receiptId = 1801.0;
    raw.receiptClass = "AIVehicleDriveToPointAutonomousCommand";
    return raw;
}
} // namespace

TEST(chauffeur_sample_sections_match_the_lua)
{
    Fixture fixture("chauffeur-sample");
    int checked = 0;
    for (const auto& item : fixture.Cases())
    {
        yyjson_val* raw = item.Get("input", "raw");
        yyjson_val* wires = item.Get("output", "wires");
        yyjson_val* car = Member(raw, "car");

        CHECK_WIRE(FormatActor(DecideActor(ActorOf(Member(raw, "actor")))), TextOf(wires, "A"));
        CHECK_WIRE(FormatPlayer(PlayerOf(Member(raw, "player"))), TextOf(wires, "P"));
        CHECK_WIRE(FormatSummon(SummonOf(Member(raw, "summon"))), TextOf(wires, "S"));
        CHECK_WIRE(FormatCar(CarOf(car)), TextOf(wires, "C"));
        CHECK_WIRE(FormatAuto(AutoOf(Member(raw, "auto"))), TextOf(wires, "U"));
        CHECK_WIRE(FormatWaypoint(DecideWaypoint(WaypointOf(Member(raw, "waypoint")))), TextOf(wires, "W"));

        // The drive section is only written while the car is live; otherwise the key is absent.
        if (Flag(car, "live"))
        {
            CHECK(Member(wires, "D") != nullptr);
            CHECK_WIRE(FormatDrive(DecideDrive(DriveOf(Member(raw, "drive")))), TextOf(wires, "D"));
        }
        else
        {
            CHECK(Member(wires, "D") == nullptr);
        }
        ++checked;
    }
    CHECK(checked >= 40);
}

TEST(chauffeur_drive_matches_the_lua)
{
    Fixture fixture("chauffeur-drive");
    int checked = 0;
    for (const auto& item : fixture.Cases())
    {
        yyjson_val* raw = item.Get("input", "raw");
        CHECK_WIRE(FormatDrive(DecideDrive(DriveOf(Member(raw, "drive")))), TextOf(item.Get("output", "wires"), "D"));
        ++checked;
    }
    CHECK(checked >= 40);
}

TEST(chauffeur_pure_helpers)
{
    // routePosition: every axis, |value| <= 1e7 exactly; NaN and the infinities never pass.
    const double limit = kRouteLimit;
    CHECK(RoutePositionValid(PointAt(limit, -limit, 0.0)));
    CHECK(RoutePositionValid(PointAt(0.0, 0.0, 0.0)));
    CHECK(!RoutePositionValid(PointAt(limit + 1.0, 0.0, 0.0)));
    for (int axis = 0; axis < 3; ++axis)
    {
        CHECK(RoutePositionValid(WithAxis(axis, limit)));
        CHECK(RoutePositionValid(WithAxis(axis, -limit)));
        CHECK(!RoutePositionValid(WithAxis(axis, limit + 1.0)));
        CHECK(!RoutePositionValid(WithAxis(axis, -(limit + 1.0))));
        CHECK(!RoutePositionValid(WithAxis(axis, std::numeric_limits<double>::quiet_NaN())));
        CHECK(!RoutePositionValid(WithAxis(axis, std::numeric_limits<double>::infinity())));
        CHECK(!RoutePositionValid(WithAxis(axis, -std::numeric_limits<double>::infinity())));
    }

    // commandID: the unassigned sentinel is the only invalid id.
    CHECK(ValidCommandId(0));
    CHECK(ValidCommandId(4294967294u));
    CHECK(!ValidCommandId(4294967295u));
    CHECK(!ValidCommandId(kUnassignedCommandId));

    // matches: needs a receipt, a present handle, the same class and the same id; the sentinel never matches.
    const std::string driveClass = "AIVehicleDriveToPointAutonomousCommand";
    CommandRead handle;
    handle.present = true;
    handle.id = 1801;
    handle.className = driveClass;
    CHECK(CommandMatches(handle, true, 1801.0, driveClass));
    CHECK(!CommandMatches(handle, false, 1801.0, driveClass));
    CHECK(!CommandMatches(handle, true, 1802.0, driveClass));
    CHECK(!CommandMatches(handle, true, 1801.0, "AIOtherCommand"));
    CommandRead absent = handle;
    absent.present = false;
    CHECK(!CommandMatches(absent, true, 1801.0, driveClass));
    CommandRead sentinel = handle;
    sentinel.id = kUnassignedCommandId;
    CHECK(!CommandMatches(sentinel, true, 4294967295.0, driveClass));

    // DecideDrive state with an operation and no handle read: activeCheck 1 -> 0, 0 -> 3, -1 -> pending.
    DriveRaw raw = HandleDrive();
    raw.activeCheck = 1;
    const DriveResult active = DecideDrive(raw);
    CHECK(active.status == DriveStatus::Ok);
    CHECK_EQ(active.state, 0);
    CHECK_WIRE(FormatDrive(active), "D 3 0 0 0 0 0 0 1801 - - -");

    raw.activeCheck = 0;
    CHECK_EQ(DecideDrive(raw).state, 3);

    raw.activeCheck = -1;
    const DriveResult pending = DecideDrive(raw);
    CHECK_EQ(pending.state, kStatePending);
    CHECK_EQ(pending.state, -2);
    CHECK_WIRE(FormatDrive(pending), "D 3 0 0 0 0 0 ? 1801 - - -");

    // No operation: the state stays nil, and the wire says so with "-".
    DriveRaw noOperation;
    const DriveResult none = DecideDrive(noOperation);
    CHECK_EQ(none.state, kStateNone);
    CHECK_WIRE(FormatDrive(none), "D 3 0 0 0 0 0 - - - - -");

    // Lua FormatNumber: nan, inf and -inf are words; finite values use %.17g.
    CHECK_EQ(FormatNumber(std::numeric_limits<double>::quiet_NaN()), std::string("nan"));
    CHECK_EQ(FormatNumber(std::numeric_limits<double>::infinity()), std::string("inf"));
    CHECK_EQ(FormatNumber(-std::numeric_limits<double>::infinity()), std::string("-inf"));

    // DecideActor truth table: each gate turns off the layers after it.
    const ActorResult good = DecideActor(ValidActor());
    CHECK(good.attached);
    CHECK(!good.dead);
    CHECK(good.valid);
    CHECK(good.calm);

    ActorRaw noNpc = ValidActor();
    noNpc.npcPresent = false;
    const ActorResult noNpcResult = DecideActor(noNpc);
    CHECK(!noNpcResult.attached);
    CHECK(!noNpcResult.valid);
    CHECK(!noNpcResult.calm);

    ActorRaw dead = ValidActor();
    dead.dead = true;
    const ActorResult deadResult = DecideActor(dead);
    CHECK(deadResult.attached);
    CHECK(deadResult.dead);
    CHECK(!deadResult.valid);
    CHECK(!deadResult.calm);

    ActorRaw inCombat = ValidActor();
    inCombat.inCombat = true;
    const ActorResult combatResult = DecideActor(inCombat);
    CHECK(combatResult.valid);
    CHECK(!combatResult.calm);

    ActorRaw otherEntity = ValidActor();
    otherEntity.sameEntity = false;
    CHECK(!DecideActor(otherEntity).valid);

    // An unreadable combat flag is unknown, not an unavailable sample: a valid actor answers with calm marked "?",
    // and the flag's value, whatever it holds, is not used. An actor that is not valid has no combat read to miss.
    ActorRaw unknown = ValidActor();
    unknown.combatKnown = false;
    unknown.inCombat = true;
    const ActorResult unknownResult = DecideActor(unknown);
    CHECK(unknownResult.valid);
    CHECK(!unknownResult.calmKnown);
    CHECK(!unknownResult.calm);
    CHECK_WIRE(FormatActor(unknownResult), "A 1 0 1 ?");
    ActorRaw unknownDead = ValidActor();
    unknownDead.combatKnown = false;
    unknownDead.dead = true;
    const ActorResult unknownDeadResult = DecideActor(unknownDead);
    CHECK(unknownDeadResult.calmKnown);
    CHECK_WIRE(FormatActor(unknownDeadResult), "A 1 1 0 0");
    CHECK_WIRE(FormatActor(DecideActor(ValidActor())), "A 1 0 1 1");
}

TEST(chauffeur_wire_format)
{
    // A waypoint whose display name has spaces: the name is the rest of the text.
    WaypointResult waypoint;
    waypoint.present = true;
    waypoint.id = 3001;
    waypoint.position = PointAt(10.0, 20.0, 3.0);
    waypoint.marker = PointAt(10.0, 20.0, 4.2);
    waypoint.quest = false;
    waypoint.rawName = "North Oak Overpass";
    CHECK_WIRE(FormatWaypoint(waypoint), "W 1 3001 10 20 3 10 20 4.2 0 North Oak Overpass");

    // An empty display name is "-" at the end.
    waypoint.quest = true;
    waypoint.rawName.clear();
    CHECK_WIRE(FormatWaypoint(waypoint), "W 1 3001 10 20 3 10 20 4.2 1 -");

    WaypointResult none;
    CHECK_WIRE(FormatWaypoint(none), "W 0");

    // A live car whose position does not read: the position is written as zeros.
    CarRaw car;
    car.live = true;
    car.id = 2001;
    car.carValid = true;
    car.positionValid = false;
    car.position = PointAt(5.0, 6.0, 7.0);
    CHECK_WIRE(FormatCar(car), "C 1 2001 1 0 0 0 0");

    // Drive statuses without a command body.
    DriveResult drive;
    drive.status = DriveStatus::AiMissing;
    CHECK_WIRE(FormatDrive(drive), "D 0");
    drive.status = DriveStatus::TypesInvalid;
    CHECK_WIRE(FormatDrive(drive), "D 1");
    drive.status = DriveStatus::IdentityMissing;
    CHECK_WIRE(FormatDrive(drive), "D 2");

    // The other sections, one example each.
    ActorResult actor;
    actor.attached = true;
    actor.dead = false;
    actor.valid = true;
    actor.calm = false;
    CHECK_WIRE(FormatActor(actor), "A 1 0 1 0");

    PlayerRaw player;
    player.id = 1;
    player.passenger = true;
    player.combat = false;
    CHECK_WIRE(FormatPlayer(player), "P 1 1 0");

    SummonRaw summon;
    summon.summoned = 2001;
    summon.state = 0.0;
    CHECK_WIRE(FormatSummon(summon), "S 2001 0");

    AutoRaw autoRaw;
    autoRaw.enabled = false;
    autoRaw.delamain = false;
    autoRaw.available = true;
    autoRaw.laneValid = true;
    autoRaw.destination = DestinationType::PlayerTracked;
    autoRaw.freeRoam = false;
    autoRaw.remaining = 99.0;
    autoRaw.vehicle = 0;
    autoRaw.destinationId = 3001;
    CHECK_WIRE(FormatAuto(autoRaw), "U 0 0 1 1 1 0 99 0 3001");
}
