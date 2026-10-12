// Headless tests of the clearance core. The two fixtures are recorded from mod/companion-clearance.lua
// by bridge/companion-clearance-native.test.mjs: for each case the inputs, the queries the Lua issued, its
// result, the budget it spent and the wire text the plugin must answer with. Here the C++ core is
// run against a fake Probe that answers exactly as the Lua's fake world did.

#include "Fixture.hpp"
#include "Test.hpp"

#include "systems/clearance/core/ClearanceCore.hpp"

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <sstream>
#include <string>
#include <vector>

using namespace convai::clearance;

namespace
{
constexpr double kTolerance = 1e-9;
constexpr int kNoBudget = 1000000;

double Field(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = aObject ? yyjson_obj_get(aObject, aKey) : nullptr;
    return value && yyjson_is_num(value) ? yyjson_get_num(value) : std::nan("");
}

Vec3 PointOf(yyjson_val* aObject)
{
    return {Field(aObject, "x"), Field(aObject, "y"), Field(aObject, "z")};
}

// Lua "or 0": a missing field is zero, a present one is used as given.
double OrZero(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = aObject ? yyjson_obj_get(aObject, aKey) : nullptr;
    if (!value || yyjson_is_null(value))
    {
        return 0.0;
    }
    return yyjson_is_num(value) ? yyjson_get_num(value) : std::nan("");
}

Shape ShapeOf(yyjson_val* aObject)
{
    if (!aObject || yyjson_is_null(aObject))
    {
        return {}; // the humanoid default
    }
    return {Field(aObject, "radius"), Field(aObject, "height")};
}

int RemainingOf(yyjson_val* aBudget)
{
    if (!aBudget || !yyjson_is_obj(aBudget))
    {
        return kNoBudget;
    }
    return static_cast<int>(Field(aBudget, "limit") - Field(aBudget, "used"));
}

std::string Text(yyjson_val* aValue)
{
    return aValue && yyjson_is_str(aValue) ? std::string(yyjson_get_str(aValue), yyjson_get_len(aValue)) : std::string();
}

int GroupIndex(const std::string& aName, const char* const* aList)
{
    for (int index = 0; index < kGroupCount; ++index)
    {
        if (aName == aList[index])
        {
            return index;
        }
    }
    return -1;
}

// Answers like the recorder's fake spatial system: the query with index hitAt is the first hit.
class FakeProbe final : public Probe
{
public:
    struct Query
    {
        std::string group;
        Box box;
        Vec3 from;
        Vec3 to;
    };

    int hitAt = -1;
    bool floorMode = false;
    bool rayHit = false;
    double rayZ = 0;
    int failAt = -1; // index of the query that reports an error
    std::vector<Query> queries;

    Hit Overlap(const Box& aBox, int aGroup) override
    {
        const int index = static_cast<int>(queries.size());
        queries.push_back({kGroups[aGroup], aBox, {}, {}});
        if (index == failAt)
        {
            return Hit::Error;
        }
        return index == hitAt ? Hit::Blocked : Hit::Free;
    }

    Hit Ray(const Vec3& aFrom, const Vec3& aTo, const char* aGroup, double* aHitZ) override
    {
        const int index = static_cast<int>(queries.size());
        queries.push_back({aGroup, {}, aFrom, aTo});
        if (index == failAt)
        {
            return Hit::Error;
        }
        if (floorMode)
        {
            if (!rayHit)
            {
                return Hit::Free;
            }
            if (aHitZ)
            {
                *aHitZ = rayZ;
            }
            return Hit::Blocked;
        }
        return index == hitAt ? Hit::Blocked : Hit::Free;
    }

    int ErrorCode() const override
    {
        return 3;
    }
};

void CheckVec(yyjson_val* aArray, double aX, double aY, double aZ)
{
    CHECK(aArray && yyjson_arr_size(aArray) == 3);
    if (aArray && yyjson_arr_size(aArray) == 3)
    {
        CHECK_NEAR(yyjson_get_num(yyjson_arr_get(aArray, 0)), aX, kTolerance);
        CHECK_NEAR(yyjson_get_num(yyjson_arr_get(aArray, 1)), aY, kTolerance);
        CHECK_NEAR(yyjson_get_num(yyjson_arr_get(aArray, 2)), aZ, kTolerance);
    }
}

// Numbers compare within a tolerance, everything else must be equal.
void CheckWire(const std::string& aActual, const std::string& aExpected)
{
    std::istringstream actual(aActual);
    std::istringstream expected(aExpected);
    std::string a;
    std::string e;
    int position = 0;
    while (true)
    {
        const bool haveActual = static_cast<bool>(actual >> a);
        const bool haveExpected = static_cast<bool>(expected >> e);
        if (haveActual != haveExpected)
        {
            convai::test::Fail(__FILE__, __LINE__, "wire length differs: '" + aActual + "' vs '" + aExpected + "'");
            return;
        }
        if (!haveActual)
        {
            return;
        }
        char* endA = nullptr;
        char* endE = nullptr;
        const double numberA = std::strtod(a.c_str(), &endA);
        const double numberE = std::strtod(e.c_str(), &endE);
        if (*endA != '\0' || *endE != '\0' || std::fabs(numberA - numberE) > kTolerance)
        {
            convai::test::Fail(__FILE__, __LINE__,
                               "wire token " + std::to_string(position) + " differs: '" + aActual + "' vs '" + aExpected + "'");
            return;
        }
        ++position;
    }
}

void CheckQueriesOfBoxes(const FakeProbe& aProbe, yyjson_val* aQueries)
{
    CHECK(aQueries && yyjson_arr_size(aQueries) == aProbe.queries.size());
    size_t index;
    size_t count;
    yyjson_val* item;
    yyjson_arr_foreach(aQueries, index, count, item)
    {
        if (index >= aProbe.queries.size())
        {
            return;
        }
        const FakeProbe::Query& query = aProbe.queries[index];
        CHECK_EQ(query.group, Text(yyjson_obj_get(item, "group")));
        CheckVec(yyjson_obj_get(item, "half"), query.box.half.x, query.box.half.y, query.box.half.z);
        CheckVec(yyjson_obj_get(item, "center"), query.box.center.x, query.box.center.y, query.box.center.z);
        CheckVec(yyjson_obj_get(item, "rot"), query.box.roll, query.box.pitch, query.box.yaw);
    }
}

void CheckQueriesOfRays(const FakeProbe& aProbe, yyjson_val* aQueries)
{
    CHECK(aQueries && yyjson_arr_size(aQueries) == aProbe.queries.size());
    size_t index;
    size_t count;
    yyjson_val* item;
    yyjson_arr_foreach(aQueries, index, count, item)
    {
        if (index >= aProbe.queries.size())
        {
            return;
        }
        const FakeProbe::Query& query = aProbe.queries[index];
        CHECK_EQ(query.group, Text(yyjson_obj_get(item, "group")));
        CheckVec(yyjson_obj_get(item, "from"), query.from.x, query.from.y, query.from.z);
        CheckVec(yyjson_obj_get(item, "to"), query.to.x, query.to.y, query.to.z);
    }
}

Status StatusOf(const std::string& aName)
{
    if (aName == "clear")
        return Status::Clear;
    if (aName == "blocked")
        return Status::Blocked;
    if (aName == "deferred")
        return Status::Deferred;
    if (aName == "unavailable")
        return Status::Unavailable;
    if (aName == "geometry")
        return Status::Geometry;
    return Status::Fallback;
}
} // namespace

TEST(clearance_boxes_match_the_lua)
{
    convai::test::Fixture fixture("clearance-boxes");
    int blocked = 0;
    int deferred = 0;
    int geometry = 0;
    int unavailable = 0;
    for (const auto& item : fixture.Cases())
    {
        const std::string fn = item.Str("input", "fn");
        const bool segment = fn == "segment";
        yyjson_val* input = item.Get("input");
        FakeProbe probe;
        probe.hitAt = static_cast<int>(item.Num("input", "hitAt"));
        const int remaining = RemainingOf(yyjson_obj_get(input, "budget"));

        Outcome outcome;
        if (fn == "body")
        {
            outcome = CheckBody(probe, PointOf(yyjson_obj_get(input, "feet")), ShapeOf(yyjson_obj_get(input, "dimensions")),
                                remaining);
        }
        else if (fn == "recheck")
        {
            yyjson_val* rejection = yyjson_obj_get(input, "rejection");
            yyjson_val* rotation = rejection ? yyjson_obj_get(rejection, "rotation") : nullptr;
            Box box;
            box.center = PointOf(rejection ? yyjson_obj_get(rejection, "center") : nullptr);
            box.half = PointOf(rejection ? yyjson_obj_get(rejection, "halfExtents") : nullptr);
            box.roll = OrZero(rotation, "roll");
            box.pitch = OrZero(rotation, "pitch");
            box.yaw = OrZero(rotation, "yaw");
            outcome = CheckRecheck(probe, box, remaining);
        }
        else
        {
            CHECK_EQ(fn, std::string("segment"));
            yyjson_val* startValue = yyjson_obj_get(input, "startBox");
            const int start = startValue && yyjson_is_num(startValue) ? static_cast<int>(yyjson_get_num(startValue)) : 1;
            outcome = CheckSegment(probe, PointOf(yyjson_obj_get(input, "from")), PointOf(yyjson_obj_get(input, "to")),
                                   ShapeOf(yyjson_obj_get(input, "dimensions")), start,
                                   yyjson_is_true(yyjson_obj_get(input, "projection")), remaining);
        }

        const std::string name = item.Name();
        const Status expected = StatusOf(item.Str("output", "status"));
        if (outcome.status != expected)
        {
            convai::test::Fail(__FILE__, __LINE__,
                               name + ": status " + std::to_string(static_cast<int>(outcome.status)) + " vs " +
                                   item.Str("output", "status"));
            continue;
        }
        CHECK_EQ(outcome.used, static_cast<int>(item.Num("output", "used")));
        CheckQueriesOfBoxes(probe, item.Get("output", "queries"));
        CheckWire(FormatOutcome(outcome, segment), item.Str("output", "wire"));

        switch (expected)
        {
        case Status::Blocked: {
            ++blocked;
            yyjson_val* rejection = item.Get("output", "rejection");
            CHECK_EQ(outcome.group, GroupIndex(Text(yyjson_obj_get(rejection, "group")), kGroups));
            yyjson_val* center = yyjson_obj_get(rejection, "center");
            yyjson_val* half = yyjson_obj_get(rejection, "halfExtents");
            yyjson_val* rotation = yyjson_obj_get(rejection, "rotation");
            CHECK_NEAR(outcome.box.center.x, Field(center, "x"), kTolerance);
            CHECK_NEAR(outcome.box.center.y, Field(center, "y"), kTolerance);
            CHECK_NEAR(outcome.box.center.z, Field(center, "z"), kTolerance);
            CHECK_NEAR(outcome.box.half.x, Field(half, "x"), kTolerance);
            CHECK_NEAR(outcome.box.half.y, Field(half, "y"), kTolerance);
            CHECK_NEAR(outcome.box.half.z, Field(half, "z"), kTolerance);
            CHECK_NEAR(outcome.box.roll, Field(rotation, "roll"), kTolerance);
            CHECK_NEAR(outcome.box.pitch, Field(rotation, "pitch"), kTolerance);
            CHECK_NEAR(outcome.box.yaw, Field(rotation, "yaw"), kTolerance);
            if (segment)
            {
                CHECK_EQ(outcome.boxIndex, static_cast<int>(Field(rejection, "box")));
                CHECK_EQ(outcome.boxCount, static_cast<int>(Field(rejection, "boxes")));
            }
            break;
        }
        case Status::Deferred:
            ++deferred;
            if (segment && item.Has("output", "next"))
            {
                CHECK_EQ(outcome.nextBox, static_cast<int>(item.Num("output", "next")));
            }
            break;
        case Status::Geometry: {
            ++geometry;
            yyjson_val* rejection = item.Get("output", "rejection");
            const std::string kind = Text(yyjson_obj_get(rejection, "geometryType"));
            CHECK_EQ(static_cast<int>(outcome.kind), kind == "route-size" ? 1 : 2);
            CHECK_NEAR(outcome.length, Field(rejection, "length"), kTolerance);
            CHECK_NEAR(outcome.rise, Field(rejection, "rise"), kTolerance);
            CHECK_NEAR(outcome.deltaZ, Field(rejection, "deltaZ"), kTolerance);
            CHECK_NEAR(outcome.allowedRise, Field(rejection, "allowedRise"), kTolerance);
            CHECK_EQ(outcome.boxCount, static_cast<int>(Field(rejection, "boxes")));
            break;
        }
        case Status::Unavailable:
            ++unavailable;
            CHECK_EQ(outcome.used, 0);
            break;
        default:
            break;
        }
    }
    CHECK(fixture.Count() >= 80);
    CHECK(blocked >= 12 && deferred >= 5 && geometry >= 8 && unavailable >= 15);
}

TEST(clearance_rays_match_the_lua)
{
    convai::test::Fixture fixture("clearance-rays");
    int sights = 0;
    int floors = 0;
    for (const auto& item : fixture.Cases())
    {
        const std::string fn = item.Str("input", "fn");
        yyjson_val* input = item.Get("input");
        FakeProbe probe;
        probe.hitAt = static_cast<int>(item.Num("input", "hitAt"));
        if (fn == "sight")
        {
            ++sights;
            const Outcome outcome = CheckSight(probe, PointOf(yyjson_obj_get(input, "from")),
                                               PointOf(yyjson_obj_get(input, "to")), RemainingOf(yyjson_obj_get(input, "budget")));
            CHECK_EQ(outcome.status == Status::Clear, item.Bool("output", "visible"));
            CHECK_EQ(outcome.used, static_cast<int>(item.Num("output", "used")));
            CheckQueriesOfRays(probe, item.Get("output", "queries"));
            CheckWire(FormatSight(outcome), item.Str("output", "wire"));
        }
        else
        {
            CHECK_EQ(fn, std::string("floor"));
            ++floors;
            probe.floorMode = true;
            probe.rayHit = yyjson_is_true(yyjson_obj_get(input, "rayHit"));
            probe.rayZ = Field(input, "rayZ");
            yyjson_val* dropValue = yyjson_obj_get(input, "maxDrop");
            const double maxDrop = dropValue && yyjson_is_num(dropValue) ? yyjson_get_num(dropValue) : 0.35;
            const Outcome outcome = CheckFloor(probe, PointOf(yyjson_obj_get(input, "at")), maxDrop);
            const bool found = item.Has("output", "z");
            CHECK_EQ(outcome.status == Status::Clear, found);
            if (found && outcome.status == Status::Clear)
            {
                CHECK_NEAR(outcome.z, item.Num("output", "z"), kTolerance);
            }
            CHECK_EQ(outcome.used, 0);
            CheckQueriesOfRays(probe, item.Get("output", "queries"));
            CheckWire(FormatFloor(outcome), item.Str("output", "wire"));
        }
    }
    CHECK(sights >= 8 && floors >= 8);
}

TEST(clearance_a_failed_query_is_a_fallback_and_counts_what_was_asked)
{
    FakeProbe probe;
    probe.failAt = 2;
    const Outcome body = CheckBody(probe, {0, 0, 0}, {}, 192);
    CHECK(body.status == Status::Fallback);
    CHECK_EQ(body.used, 3);
    CHECK_EQ(body.code, 3);
    CHECK_EQ(FormatOutcome(body, false), std::string("4 3 3"));

    FakeProbe segmentProbe;
    segmentProbe.failAt = 7;
    const Outcome segment = CheckSegment(segmentProbe, {0, 0, 0}, {0, 6, 0}, {}, 1, false, 192);
    CHECK(segment.status == Status::Fallback);
    CHECK_EQ(segment.used, 8);

    FakeProbe ray;
    ray.failAt = 0;
    const Outcome sight = CheckSight(ray, {0, 0, 0}, {1, 1, 1}, 192);
    CHECK(sight.status == Status::Fallback);
    CHECK_EQ(FormatSight(sight), std::string("4 1 3"));
    ray.floorMode = true;
    ray.queries.clear();
    ray.failAt = 0;
    const Outcome floor = CheckFloor(ray, {0, 0, 0}, 0.35);
    CHECK(floor.status == Status::Fallback);
    CHECK_EQ(FormatFloor(floor), std::string("-1 3"));
}

TEST(clearance_wire_examples)
{
    Outcome clear;
    clear.used = 6;
    CHECK_EQ(FormatOutcome(clear, false), std::string("0 6"));

    Outcome deferred;
    deferred.status = Status::Deferred;
    deferred.used = 12;
    deferred.nextBox = 3;
    CHECK_EQ(FormatOutcome(deferred, true), std::string("2 12 3"));
    CHECK_EQ(FormatOutcome(deferred, false), std::string("2 12"));

    Outcome unavailable;
    unavailable.status = Status::Unavailable;
    CHECK_EQ(FormatOutcome(unavailable, true), std::string("3 0"));

    Outcome blocked;
    blocked.status = Status::Blocked;
    blocked.used = 3;
    blocked.group = 2;
    blocked.box.center = {1, 2, 3};
    blocked.box.half = {0.5, 0.25, 1.5};
    blocked.box.yaw = 90;
    blocked.boxIndex = 2;
    blocked.boxCount = 3;
    CHECK_EQ(FormatOutcome(blocked, false), std::string("1 3 3 1 2 3 0.5 0.25 1.5 0 0 90"));
    CHECK_EQ(FormatOutcome(blocked, true), std::string("1 3 3 1 2 3 0.5 0.25 1.5 0 0 90 2 3"));

    Outcome floor;
    floor.z = 49.5;
    CHECK_EQ(FormatFloor(floor), std::string("1 49.5"));
    floor.status = Status::Blocked;
    CHECK_EQ(FormatFloor(floor), std::string("0 0"));
}

TEST(clearance_math_edges)
{
    CHECK(IsFinite(9999999.0) && !IsFinite(10000000.0) && !IsFinite(-10000000.0) && !IsFinite(std::nan("")));
    CHECK(!IsFinite(INFINITY));
    CHECK(ValidShape({0.2, 0.5}) && ValidShape({3, 6}) && !ValidShape({0.19, 2}) && !ValidShape({0.4, 6.01}));
    CHECK_EQ(SegmentBoxes({0, 0, 0}, {0, 0, 0}), 1);
    CHECK_EQ(SegmentBoxes({0, 0, 0}, {0, 6, 0}), 3);
    CHECK_EQ(SegmentBoxes({0, 0, 0}, {0, 0.3, 0.6}), 3); // 0.6 / 0.2 is 2.9999999999999996, which rounds up
    CHECK_EQ(SegmentBoxes({0, 0, 0}, {0, 1.2, 1}), 5);
    CHECK_EQ(SegmentBoxes({0, 0, 0}, {0, 130, 0}), 65);
    CHECK(SegmentBoxes({0, 0, 0}, {9999999, 9999999, 9999999}) > 1000000); // large, but a valid int
    CHECK_EQ(ToFloat32(0.1), static_cast<double>(0.1f));
    const Box rounded = RoundToFloat32({{0.4, 0.4, 1.05}, {1.0000000001, 2, 3}, 0, 0, 90.00000001});
    CHECK_EQ(rounded.center.x, 1.0);
    CHECK_EQ(rounded.yaw, 90.0);
}

TEST(clearance_orientation_convention)
{
    // +Y is forward and a positive yaw turns left; the shim checks this against the game.
    CHECK_NEAR(OrientationOf(0, 1).yaw, 0.0, 1e-12);
    CHECK_NEAR(OrientationOf(1, 0).yaw, -90.0, 1e-12);
    CHECK_NEAR(OrientationOf(-1, 0).yaw, 90.0, 1e-12);
    CHECK_NEAR(OrientationOf(0, -1).yaw, 180.0, 1e-12);
    CHECK_NEAR(OrientationOf(0.6, 0.8).yaw, -36.86989764584402, 1e-9);
    CHECK_EQ(OrientationOf(0.6, 0.8).roll, 0.0);
    CHECK_EQ(OrientationOf(0.6, 0.8).pitch, 0.0);
}

TEST(clearance_a_hit_costs_only_the_queries_up_to_it)
{
    for (int group = 0; group < kGroupCount; ++group)
    {
        FakeProbe probe;
        probe.hitAt = group;
        const Outcome outcome = CheckBody(probe, {0, 0, 0}, {}, 192);
        CHECK(outcome.status == Status::Blocked);
        CHECK_EQ(outcome.used, group + 1);
        CHECK_EQ(outcome.group, group);
    }
    FakeProbe probe;
    const Outcome tight = CheckBody(probe, {0, 0, 0}, {}, 5);
    CHECK(tight.status == Status::Deferred);
    CHECK_EQ(tight.used, 0);
    CHECK(probe.queries.empty());
}

// The plugin side of a check is arithmetic and a few virtual calls; the game's own queries cost the
// same as before. Printed so the number can be quoted next to the CET call cost (about 58 us a call).
TEST(clearance_core_overhead_is_microseconds)
{
    struct FreeProbe final : Probe
    {
        Hit Overlap(const Box&, int) override { return Hit::Free; }
        Hit Ray(const Vec3&, const Vec3&, const char*, double*) override { return Hit::Free; }
    } probe;
    constexpr int kRuns = 20000;
    const auto begin = std::chrono::steady_clock::now();
    int used = 0;
    for (int run = 0; run < kRuns; ++run)
    {
        used += CheckBody(probe, {0, 0, double(run % 7)}, {}, 192).used;
        used += CheckSegment(probe, {0, 0, 0}, {0, 6, 0.2}, {}, 1, false, 192).used; // 3 boxes, 18 queries
    }
    const double micros =
        std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - begin).count() / kRuns;
    std::printf("    core: body + 3-box segment = %.2f us per pair (%d queries each)\n", micros, used / kRuns);
    CHECK_EQ(used / kRuns, 24);
    CHECK(micros < 100.0);
}
