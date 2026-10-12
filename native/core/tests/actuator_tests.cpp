// Headless tests of the companion tick maths and its wire format: the part of the "actuator" system
// that needs no game. The parity fixture is recorded from the real mod/companions.lua by
// bridge/companion-tick-native.test.mjs.

#include "Fixture.hpp"
#include "Test.hpp"

#include "systems/actuator/core/ActuatorCore.hpp"

#include <chrono>
#include <cmath>
#include <sstream>
#include <string>
#include <vector>

using namespace convai::actuator;
using convai::test::Fixture;

namespace
{
std::vector<std::string> Split(const std::string& aText, char aSeparator)
{
    std::vector<std::string> parts;
    std::string current;
    std::istringstream stream(aText);
    while (std::getline(stream, current, aSeparator))
    {
        parts.push_back(current);
    }
    return parts;
}

SenseInput InputOf(const convai::test::FixtureCase& aCase)
{
    SenseInput input;
    input.hasPrevious = aCase.Bool("input", "hasPrevious");
    input.previousX = aCase.Num("input", "previousX");
    input.previousY = aCase.Num("input", "previousY");
    input.x = aCase.Num("input", "x");
    input.y = aCase.Num("input", "y");
    input.z = aCase.Num("input", "z");
    input.forwardX = aCase.Num("input", "forwardX");
    input.forwardY = aCase.Num("input", "forwardY");
    input.playerX = aCase.Num("input", "playerX");
    input.playerY = aCase.Num("input", "playerY");
    input.playerZ = aCase.Num("input", "playerZ");
    input.step = aCase.Num("input", "step");
    return input;
}
} // namespace

TEST(actuator_tick_maths_match_the_lua)
{
    Fixture fixture("actuator-sense");
    int checked = 0;
    for (const auto& item : fixture.Cases())
    {
        if (item.Name() == "wire-layout")
        {
            continue;
        }
        const SenseMath out = ComputeSense(InputOf(item));
        CHECK_NEAR(out.speed, item.Num("output", "speed"), 1e-9);
        CHECK_NEAR(out.direction.x, item.Num("output", "directionX"), 1e-9);
        CHECK_NEAR(out.direction.y, item.Num("output", "directionY"), 1e-9);
        CHECK_NEAR(out.playerGap, item.Num("output", "playerGap"), 1e-9);
        CHECK_NEAR(out.facingError, item.Num("output", "facingError"), 1e-9);
        ++checked;
    }
    CHECK(checked >= 30);
}

TEST(actuator_wire_round_trips_every_recorded_case_exactly)
{
    Fixture fixture("actuator-sense");
    int checked = 0;
    for (const auto& item : fixture.Cases())
    {
        if (item.Name() == "wire-layout")
        {
            continue;
        }
        const SenseInput input = InputOf(item);
        SenseWire wire;
        wire.flags = kFlagCombatKnown | kFlagStateKnown | kFlagIdKnown | (checked % 2 ? kFlagInCombat : 0);
        wire.x = input.x;
        wire.y = input.y;
        wire.z = input.z;
        wire.forwardX = input.forwardX;
        wire.forwardY = input.forwardY;
        wire.state = checked % kCommandStateCount;
        wire.commandId = 4000000000.0 + checked;
        wire.math = ComputeSense(input);
        const std::string text = EncodeSense(wire);
        CHECK(!text.empty());
        CHECK(text.find('\n') == std::string::npos);
        SenseWire back;
        CHECK(DecodeSense(text, back));
        CHECK_EQ(back.flags, wire.flags);
        CHECK_EQ(back.x, wire.x);
        CHECK_EQ(back.y, wire.y);
        CHECK_EQ(back.z, wire.z);
        CHECK_EQ(back.forwardY, wire.forwardY);
        CHECK_EQ(back.state, wire.state);
        CHECK_EQ(back.commandId, wire.commandId);
        CHECK_EQ(back.math.speed, wire.math.speed);
        CHECK_EQ(back.math.direction.x, wire.math.direction.x);
        CHECK_EQ(back.math.playerGap, wire.math.playerGap);
        CHECK_EQ(back.math.facingError, wire.math.facingError);
        ++checked;
    }
    CHECK(checked >= 30);
}

TEST(actuator_wire_layout_matches_the_lua_shim)
{
    Fixture fixture("actuator-sense");
    bool found = false;
    for (const auto& item : fixture.Cases())
    {
        if (item.Name() != "wire-layout")
        {
            continue;
        }
        found = true;
        CHECK_EQ(item.Str("output", "fields"), std::string(WireFields()));

        // "name=value" pairs, sorted by name
        auto pairs = [](const std::string& aText) {
            std::vector<std::pair<std::string, int>> out;
            for (const auto& token : Split(aText, ' '))
            {
                const size_t equals = token.find('=');
                out.emplace_back(token.substr(0, equals), std::stoi(token.substr(equals + 1)));
            }
            return out;
        };
        const std::vector<std::pair<std::string, int>> capabilities = {
            {"commandId", kCapCommandId},     {"commandState", kCapCommandState}, {"inCombat", kCapInCombat},
            {"isAttached", kCapIsAttached},   {"isDead", kCapIsDead},            {"worldForward", kCapWorldForward},
            {"worldPosition", kCapWorldPosition}};
        CHECK(pairs(item.Str("output", "capabilities")) == capabilities);
        const std::vector<std::pair<std::string, int>> flags = {{"combatKnown", kFlagCombatKnown},
                                                                {"idKnown", kFlagIdKnown},
                                                                {"inCombat", kFlagInCombat},
                                                                {"stateKnown", kFlagStateKnown}};
        CHECK(pairs(item.Str("output", "flags")) == flags);
        CHECK_EQ(static_cast<int>(item.Num("output", "required")), kCapRequired);

        const auto labels = Split(item.Str("output", "states"), '|');
        CHECK_EQ(static_cast<int>(labels.size()), kCommandStateCount);
        for (int state = 0; state < kCommandStateCount; ++state)
        {
            CHECK_EQ(labels[state], "AICommandState : " + std::string(CommandStateName(state)) + " (" +
                                        std::to_string(state) + ")");
        }
    }
    CHECK(found);
    CHECK_EQ(std::string(CommandStateName(-1)), std::string());
    CHECK_EQ(std::string(CommandStateName(kCommandStateCount)), std::string());
}

TEST(actuator_first_tick_has_no_speed_and_short_forward_vectors_face_up)
{
    SenseInput input;
    input.x = 5.0;
    input.y = 5.0;
    input.forwardX = 0.00005;
    input.forwardY = 0.0;
    input.playerX = 5.0;
    input.playerY = 5.0; // on the same ground spot: bearing is (0, 1)
    SenseMath out = ComputeSense(input);
    CHECK_EQ(out.speed, 0.0);
    CHECK_EQ(out.direction.x, 0.0);
    CHECK_EQ(out.direction.y, 1.0);
    CHECK_NEAR(out.facingError, 0.0, 1e-12);
    input.hasPrevious = true;
    input.previousX = 5.0;
    input.previousY = 2.0;
    input.step = 0.5;
    CHECK_NEAR(ComputeSense(input).speed, 6.0, 1e-12);
}

TEST(actuator_wire_refuses_non_finite_values_and_garbage)
{
    SenseWire wire;
    wire.x = std::nan("");
    CHECK(EncodeSense(wire).empty());
    wire.x = 1.0;
    wire.math.playerGap = INFINITY;
    CHECK(EncodeSense(wire).empty());
    wire.math.playerGap = 2.0;
    const std::string good = EncodeSense(wire);
    CHECK(!good.empty());
    SenseWire back;
    CHECK(DecodeSense(good, back));
    CHECK(!DecodeSense("", back));
    CHECK(!DecodeSense("1 2 3", back));
    CHECK(!DecodeSense(good + " 7", back));
    CHECK(!DecodeSense(good + " ", back));
    CHECK(!DecodeSense("a b c d e f g h i j k l m n", back));
}

// Not a gate (machines differ); prints the cost of one tick's maths and wire encoding so a change
// that makes it slower shows up in the log.
TEST(actuator_tick_cost_is_microseconds)
{
    SenseInput input;
    input.hasPrevious = true;
    input.previousX = 1234.5;
    input.previousY = -3200.25;
    input.x = 1234.75;
    input.y = -3200.0;
    input.z = 17.7;
    input.forwardX = 0.2;
    input.forwardY = -0.97;
    input.playerX = 1233.0;
    input.playerY = -3201.0;
    input.playerZ = 17.7;
    input.step = 0.1;
    constexpr int kRounds = 200000;
    size_t bytes = 0;
    const auto start = std::chrono::steady_clock::now();
    for (int round = 0; round < kRounds; ++round)
    {
        SenseWire wire;
        wire.flags = kFlagCombatKnown | kFlagStateKnown | kFlagIdKnown;
        wire.x = input.x + round * 1e-6;
        wire.y = input.y;
        wire.z = input.z;
        wire.state = 2;
        wire.commandId = round;
        input.x = wire.x;
        wire.math = ComputeSense(input);
        bytes += EncodeSense(wire).size();
    }
    const double micros =
        std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count() / kRounds;
    std::printf("  actuator tick maths + encode: %.3f us per companion tick (%zu bytes per reply)\n", micros,
                bytes / kRounds);
    CHECK(micros < 50.0);
}
