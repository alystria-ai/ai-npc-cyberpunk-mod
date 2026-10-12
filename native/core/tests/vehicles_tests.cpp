// Headless tests of the vehicle inspection and mounting answers, and of their wire format: the part of
// the "vehicles" system that needs no game. The parity fixtures are recorded from the real
// mod/companion-vehicle-native.lua by a fengari test.

#include "Fixture.hpp"
#include "Test.hpp"
#include "Wire.hpp"

#include "systems/vehicles/core/VehiclesCore.hpp"

#include <cmath>
#include <cstdlib>
#include <string>

using namespace convai::vehicles;
using convai::test::Fixture;

namespace
{
std::string TextOf(yyjson_val* aValue)
{
    return aValue && yyjson_is_str(aValue) ? std::string(yyjson_get_str(aValue), yyjson_get_len(aValue)) : std::string();
}

bool BoolOf(yyjson_val* aValue)
{
    return aValue && yyjson_is_true(aValue);
}

// The raw reads of one recorded "input", the way the game layer collects them.
InspectRaw RawOf(const convai::test::FixtureCase& aCase)
{
    InspectRaw raw;
    raw.attached = aCase.Bool("input", "attached");
    raw.isVehicle = aCase.Bool("input", "isVehicle");
    raw.owned = aCase.Bool("input", "owned");
    raw.destroyed = aCase.Bool("input", "destroyed");
    raw.aiPresent = aCase.Bool("input", "ai");
    raw.mackinaw = aCase.Bool("input", "mackinaw");
    raw.distanceSquared = aCase.Num("input", "distanceSquared");
    raw.playerMounted = aCase.Bool("input", "playerMounted");
    raw.scene = aCase.Bool("input", "scene");

    yyjson_val* velocity = aCase.Get("input", "velocity");
    raw.velocityX = yyjson_get_num(yyjson_arr_get(velocity, 0));
    raw.velocityY = yyjson_get_num(yyjson_arr_get(velocity, 1));
    raw.velocityZ = yyjson_get_num(yyjson_arr_get(velocity, 2));

    yyjson_val* seats = aCase.Get("input", "seats");
    size_t index;
    size_t count;
    yyjson_val* seat;
    yyjson_arr_foreach(seats, index, count, seat)
    {
        SeatRead read;
        read.name = TextOf(yyjson_obj_get(seat, "name"));
        read.hasSlot = BoolOf(yyjson_obj_get(seat, "hasSlot"));
        read.reserved = BoolOf(yyjson_obj_get(seat, "reserved"));
        // A "no info" occupant slot is recorded with noInfo; the game layer maps it to 0 (nobody).
        yyjson_val* occupant = yyjson_obj_get(seat, "occupant");
        if (!BoolOf(yyjson_obj_get(seat, "noInfo")) && yyjson_is_str(occupant))
        {
            read.occupant = std::strtoull(TextOf(occupant).c_str(), nullptr, 10);
        }
        raw.seats.push_back(read);
    }
    return raw;
}
} // namespace

TEST(vehicles_inspect_matches_the_lua)
{
    Fixture fixture("vehicles-inspect");
    int checked = 0;
    for (const auto& item : fixture.Cases())
    {
        const InspectResult result = DecideInspect(RawOf(item));
        CHECK_WIRE(FormatInspect(result), item.Str("output", "wire"));
        CHECK_EQ(static_cast<int>(result.status), static_cast<int>(item.Num("output", "status")));
        if (static_cast<int>(result.status) == 2)
        {
            CHECK_EQ(result.seats.size(), yyjson_arr_size(item.Get("output", "seats")));
        }
        ++checked;
    }
    CHECK(checked >= 35);
}

TEST(vehicles_mounting_matches_the_lua)
{
    Fixture fixture("vehicles-mounting");
    int checked = 0;
    for (const auto& item : fixture.Cases())
    {
        const std::string info = item.Str("input", "info");
        const bool attached = item.Bool("input", "attached");
        // "none" has no parent; "zero" reads a zero hash. Neither, nor a detached body, is mounted.
        const uint64_t parentHash = info == "none" ? 0 : std::strtoull(item.Str("input", "parent").c_str(), nullptr, 10);
        const bool mounted = attached && info != "none" && parentHash != 0;
        CHECK_WIRE(FormatMounting(mounted, parentHash, item.Str("input", "seat")), item.Str("output", "wire"));
        ++checked;
    }
    CHECK(checked >= 8);
}

TEST(vehicles_keep_seat_rule)
{
    CHECK_EQ(KeepSeat("seat_back_right", true, true), false);
    CHECK_EQ(KeepSeat("seat_back_right", true, false), true);
    CHECK_EQ(KeepSeat("seat_front_left", true, true), true);
    CHECK_EQ(KeepSeat("seat_front_left", false, false), false);
    CHECK_EQ(KeepSeat("seat_back_right", false, false), false);
    CHECK_EQ(std::string(kMackinawRecord), std::string("Vehicle.v_standard3_thorton_mackinaw_ncu_player"));
}

TEST(vehicles_number_format)
{
    CHECK_EQ(FormatNumber(NAN), "nan");
    CHECK_EQ(FormatNumber(INFINITY), "inf");
    CHECK_EQ(FormatNumber(-INFINITY), "-inf");
    CHECK_EQ(FormatNumber(0.0), "0");
    CHECK_EQ(FormatNumber(5.0), "5");
    CHECK_EQ(FormatNumber(0.1), "0.10000000000000001");
}

TEST(vehicles_order_of_decisions)
{
    InspectRaw raw;
    raw.attached = false;
    CHECK(DecideInspect(raw).status == InspectStatus::Detached);
    raw.isVehicle = false;
    CHECK(DecideInspect(raw).status == InspectStatus::Detached);

    raw.attached = true;
    CHECK(DecideInspect(raw).status == InspectStatus::NotVehicle);

    raw.isVehicle = true;
    raw.owned = true;
    raw.aiPresent = false;
    CHECK(DecideInspect(raw).status == InspectStatus::NoAi);

    raw.owned = false;
    CHECK(DecideInspect(raw).status == InspectStatus::Ready);

    raw.destroyed = true;
    const InspectResult destroyed = DecideInspect(raw);
    CHECK(destroyed.status == InspectStatus::Ready);
    CHECK(destroyed.invalid);
}
