// Headless tests of the gaze plan: the numbers mod/companion-actuator.lua look() writes into a
// LookAtAddEvent. The replay compares every recorded Lua request (bridge/gaze-native.test.mjs).

#include "Fixture.hpp"
#include "Test.hpp"

#include "systems/gaze/core/GazeCore.hpp"

#include <cmath>
#include <limits>
#include <string>

using namespace convai;

TEST(gaze_plan_matches_the_lua_requests)
{
    test::Fixture fixture("gaze-requests");
    size_t seatedCases = 0;
    size_t offsetCases = 0;
    for (const auto& item : fixture.Cases())
    {
        const std::string style = item.Str("input", "style");
        const bool seated = item.Bool("input", "seated");
        const gaze::LookPlan plan =
            gaze::Plan(style == "full", item.Num("input", "height"), item.Num("input", "strength"), seated);

        CHECK_NEAR(plan.softLimitDegrees, item.Num("output", "soft"), 1e-9);
        CHECK_NEAR(plan.hardLimitDegrees, item.Num("output", "hard"), 1e-9);
        CHECK_NEAR(plan.backLimitDegrees, item.Num("output", "back"), 1e-9);
        CHECK_NEAR(plan.hardLimitDistance, item.Num("output", "distance"), 1e-9);
        CHECK_EQ(plan.hasWorldOffset, item.Bool("output", "hasWorldOffset"));
        CHECK_NEAR(plan.hasWorldOffset ? plan.worldOffsetZ : 0.0, item.Num("output", "worldOffsetZ"), 1e-9);
        CHECK_EQ(std::string(plan.targetSlot), item.Str("output", "slot"));
        CHECK_EQ(std::string(plan.bodyPart), item.Str("output", "body"));
        CHECK_EQ(std::string(plan.styleName), item.Str("output", "styleValue"));
        CHECK_NEAR(item.Num("output", "offset"), 0.0, 1e-9); // the local target offset stays zero

        yyjson_val* parts = item.Get("output", "parts");
        CHECK_EQ(static_cast<size_t>(plan.partCount), yyjson_arr_size(parts));
        for (int i = 0; i < plan.partCount; ++i)
        {
            yyjson_val* part = yyjson_arr_get(parts, static_cast<size_t>(i));
            CHECK_EQ(std::string(plan.parts[i].name), std::string(yyjson_get_str(yyjson_obj_get(part, "name"))));
            CHECK_NEAR(plan.parts[i].weight, yyjson_get_num(yyjson_obj_get(part, "weight")), 1e-9);
            CHECK_NEAR(plan.parts[i].suppress, yyjson_get_num(yyjson_obj_get(part, "suppress")), 1e-9);
            CHECK_NEAR(static_cast<double>(plan.parts[i].mode), yyjson_get_num(yyjson_obj_get(part, "mode")), 1e-9);
        }
        seatedCases += seated ? 1 : 0;
        offsetCases += plan.hasWorldOffset ? 1 : 0;
    }
    CHECK(fixture.Count() >= 400);
    CHECK(seatedCases > 100);
    CHECK(offsetCases > 100);
}

TEST(gaze_plan_zero_height_writes_no_world_offset)
{
    CHECK(!gaze::Plan(true, 0.0, 1.0, false).hasWorldOffset);
    CHECK(!gaze::Plan(true, -0.0, 1.0, false).hasWorldOffset);
    CHECK(gaze::Plan(true, 0.05, 1.0, false).hasWorldOffset);
    CHECK(gaze::Plan(false, -0.3, 1.0, true).hasWorldOffset);
}

TEST(gaze_plan_non_finite_numbers_pass_through_like_the_lua)
{
    // Lua tests height ~= 0, which is true for NaN; the weight is the product, so it stays NaN.
    const double nan = std::numeric_limits<double>::quiet_NaN();
    const gaze::LookPlan plan = gaze::Plan(true, nan, nan, false);
    CHECK(plan.hasWorldOffset);
    CHECK(std::isnan(plan.worldOffsetZ));
    CHECK(std::isnan(plan.parts[0].weight));
    CHECK_NEAR(plan.parts[1].weight, 0.0, 0.0);
}

TEST(gaze_plan_seated_has_only_the_head_part)
{
    const gaze::LookPlan seated = gaze::Plan(false, 0.0, 1.0, true);
    CHECK_EQ(seated.partCount, 1);
    CHECK_EQ(std::string(seated.parts[0].name), std::string("Head"));
    const gaze::LookPlan standing = gaze::Plan(false, 0.0, 1.0, false);
    CHECK_EQ(standing.partCount, 2);
    CHECK_EQ(std::string(standing.parts[1].name), std::string("Chest"));
    CHECK_NEAR(standing.parts[0].weight, 0.05, 1e-12);
    CHECK_NEAR(gaze::Plan(true, 0.0, 1.5, false).parts[0].weight, 0.27, 1e-12);
}
