// Headless tests of the passage core (lift-car standing spots). The fixture is recorded from
// mod/companion-passage.lua by bridge/companion-passage-native.test.mjs: for each case the inputs, the
// steps (one per update) with the queries the Lua issued in each, the budget it spent and the wire text
// the plugin must answer with. Here the C++ search runs step by step against a probe that answers
// exactly as the Lua's fake world did, and the queries it issues are compared with the recording.

#include "Fixture.hpp"
#include "Test.hpp"
#include "Wire.hpp"

#include "systems/passage/core/PassageCore.hpp"

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

using namespace convai::passage;
namespace clearance = convai::clearance;
using convai::test::Fixture;

namespace
{
constexpr double kRelativeTolerance = 1e-5;
constexpr int kDefaultCarQueries = 24;
constexpr int kNoBudget = 1000000;
// The fixture holds 66 steps in 50 cases; the floor keeps coverage from quietly shrinking.
constexpr int kMinimumSteps = 60;
constexpr double kFloorZ = 10.0;
constexpr int kFailingCode = 7;

size_t SizeOf(yyjson_val* aArray)
{
    return aArray && yyjson_is_arr(aArray) ? yyjson_arr_size(aArray) : 0;
}

yyjson_val* At(yyjson_val* aArray, size_t aIndex)
{
    return aArray && yyjson_is_arr(aArray) ? yyjson_arr_get(aArray, aIndex) : nullptr;
}

double Field(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = aObject && yyjson_is_obj(aObject) ? yyjson_obj_get(aObject, aKey) : nullptr;
    return value && yyjson_is_num(value) ? yyjson_get_num(value) : std::nan("");
}

double ElementOf(yyjson_val* aArray, size_t aIndex)
{
    yyjson_val* value = At(aArray, aIndex);
    return value && yyjson_is_num(value) ? yyjson_get_num(value) : std::nan("");
}

int IntOf(yyjson_val* aObject, const char* aKey)
{
    return static_cast<int>(Field(aObject, aKey));
}

bool Flag(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = aObject && yyjson_is_obj(aObject) ? yyjson_obj_get(aObject, aKey) : nullptr;
    return value && yyjson_is_true(value);
}

std::string TextOf(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = aObject && yyjson_is_obj(aObject) ? yyjson_obj_get(aObject, aKey) : nullptr;
    return value && yyjson_is_str(value) ? std::string(yyjson_get_str(value), yyjson_get_len(value)) : std::string();
}

// Lua: a tolerance of 1e-5 * (1 + |expected|); the recorded values are float32 and the core works in doubles.
bool NearValue(double aExpected, double aActual)
{
    return std::fabs(aActual - aExpected) <= kRelativeTolerance * (1.0 + std::fabs(aExpected));
}

// A recorded array of three numbers against three computed ones.
bool SameVector(yyjson_val* aArray, double aX, double aY, double aZ)
{
    return SizeOf(aArray) == 3 && NearValue(ElementOf(aArray, 0), aX) && NearValue(ElementOf(aArray, 1), aY) &&
           NearValue(ElementOf(aArray, 2), aZ);
}

clearance::Vec3 PointOf(yyjson_val* aObject)
{
    clearance::Vec3 point;
    point.x = Field(aObject, "x");
    point.y = Field(aObject, "y");
    point.z = Field(aObject, "z");
    return point;
}

std::vector<Candidate> CandidatesOf(yyjson_val* aList)
{
    std::vector<Candidate> candidates;
    for (size_t index = 0; index < SizeOf(aList); ++index)
    {
        yyjson_val* item = At(aList, index);
        Candidate candidate;
        candidate.x = Field(item, "x");
        candidate.y = Field(item, "y");
        candidate.ux = Field(item, "ux");
        candidate.uy = Field(item, "uy");
        candidates.push_back(candidate);
    }
    return candidates;
}

std::vector<Point2> OccupiedOf(yyjson_val* aList)
{
    std::vector<Point2> points;
    for (size_t index = 0; index < SizeOf(aList); ++index)
    {
        yyjson_val* item = At(aList, index);
        Point2 point;
        point.x = Field(item, "x");
        point.y = Field(item, "y");
        points.push_back(point);
    }
    return points;
}

// The body is the humanoid default unless the case gives a body object.
clearance::Shape BodyOf(yyjson_val* aBody)
{
    clearance::Shape shape;
    if (aBody && yyjson_is_obj(aBody))
    {
        shape.radius = Field(aBody, "radius");
        shape.height = Field(aBody, "height");
    }
    return shape;
}

int CarQueriesOf(yyjson_val* aInput)
{
    yyjson_val* value = yyjson_obj_get(aInput, "carQueries");
    return value && yyjson_is_num(value) ? static_cast<int>(yyjson_get_num(value)) : kDefaultCarQueries;
}

// Each step gets the budget the recorder reset to: limit minus used, or the default when there is no table.
int RemainingOf(yyjson_val* aBudget)
{
    if (!aBudget || !yyjson_is_obj(aBudget))
    {
        return kNoBudget;
    }
    return static_cast<int>(Field(aBudget, "limit") - Field(aBudget, "used"));
}

Status StatusOf(const std::string& aName)
{
    if (aName == "spot")
    {
        return Status::Spot;
    }
    if (aName == "none")
    {
        return Status::None;
    }
    if (aName == "pending")
    {
        return Status::Pending;
    }
    return Status::Fallback;
}

// Answers each recorded query in order. A query that differs from the recording, or one asked past the
// end of the recording, is a failure: the probe reports Error and keeps the first message.
class ReplayProbe final : public clearance::Probe
{
public:
    explicit ReplayProbe(yyjson_val* aQueries) : m_queries(aQueries) {}

    bool failed = false;
    std::string message;

    // Every recorded query has been asked, and nothing else.
    bool Done() const
    {
        return m_next == SizeOf(m_queries);
    }

    clearance::Hit Overlap(const clearance::Box& aBox, int aGroup) override
    {
        const std::string group = clearance::kGroups[aGroup];
        yyjson_val* item = Next();
        if (!item)
        {
            return clearance::Hit::Error;
        }
        if (TextOf(item, "kind") != "overlap" || TextOf(item, "group") != group)
        {
            return Mismatch("expected overlap " + group + ", recorded " + TextOf(item, "kind") + " " +
                            TextOf(item, "group"));
        }
        if (!SameVector(yyjson_obj_get(item, "half"), aBox.half.x, aBox.half.y, aBox.half.z) ||
            !SameVector(yyjson_obj_get(item, "center"), aBox.center.x, aBox.center.y, aBox.center.z) ||
            !SameVector(yyjson_obj_get(item, "rot"), aBox.roll, aBox.pitch, aBox.yaw))
        {
            return Mismatch("overlap " + group + " box differs from the recording");
        }
        return Flag(item, "hit") ? clearance::Hit::Blocked : clearance::Hit::Free;
    }

    clearance::Hit Ray(const clearance::Vec3& aFrom, const clearance::Vec3& aTo, const char* aGroup,
                       double* aHitZ) override
    {
        yyjson_val* item = Next();
        if (!item)
        {
            return clearance::Hit::Error;
        }
        if (TextOf(item, "kind") != "ray" || std::strcmp(TextOf(item, "group").c_str(), aGroup) != 0)
        {
            return Mismatch(std::string("expected ray ") + aGroup + ", recorded " + TextOf(item, "kind") + " " +
                            TextOf(item, "group"));
        }
        if (!SameVector(yyjson_obj_get(item, "from"), aFrom.x, aFrom.y, aFrom.z) ||
            !SameVector(yyjson_obj_get(item, "to"), aTo.x, aTo.y, aTo.z))
        {
            return Mismatch(std::string("ray ") + aGroup + " endpoints differ from the recording");
        }
        if (!Flag(item, "hit"))
        {
            return clearance::Hit::Free;
        }
        if (aHitZ)
        {
            *aHitZ = Field(item, "z");
        }
        return clearance::Hit::Blocked;
    }

private:
    yyjson_val* Next()
    {
        if (failed)
        {
            return nullptr;
        }
        if (m_next >= SizeOf(m_queries))
        {
            Mismatch("asked beyond the " + std::to_string(m_next) + " recorded queries");
            return nullptr;
        }
        return At(m_queries, m_next++);
    }

    clearance::Hit Mismatch(const std::string& aWhat)
    {
        if (!failed)
        {
            failed = true;
            message = "query " + std::to_string(m_next) + ": " + aWhat;
        }
        return clearance::Hit::Error;
    }

    yyjson_val* m_queries;
    size_t m_next = 0;
};

// Every query is counted; query number m_failAt (1-based, 0 = never) reports Error. Floor rays (from and
// to share x and y) hit at kFloorZ; other rays are free; overlaps are free.
class FailingProbe final : public clearance::Probe
{
public:
    explicit FailingProbe(int aFailAt) : m_failAt(aFailAt) {}

    int count = 0;

    clearance::Hit Overlap(const clearance::Box&, int) override
    {
        return Count() ? clearance::Hit::Error : clearance::Hit::Free;
    }

    clearance::Hit Ray(const clearance::Vec3& aFrom, const clearance::Vec3& aTo, const char*, double* aHitZ) override
    {
        if (Count())
        {
            return clearance::Hit::Error;
        }
        const bool floorRay = aFrom.x == aTo.x && aFrom.y == aTo.y;
        if (!floorRay)
        {
            return clearance::Hit::Free;
        }
        if (aHitZ)
        {
            *aHitZ = kFloorZ;
        }
        return clearance::Hit::Blocked;
    }

    int ErrorCode() const override
    {
        return kFailingCode;
    }

private:
    bool Count()
    {
        ++count;
        return m_failAt > 0 && count == m_failAt;
    }

    int m_failAt;
};

// Floor rays answer from a per-group table (kFloorGroups order); overlaps are always free.
class ScriptedProbe final : public clearance::Probe
{
public:
    bool hit[kFloorGroupCount] = {false, false, false};
    double z[kFloorGroupCount] = {0.0, 0.0, 0.0};
    int rays = 0;

    clearance::Hit Overlap(const clearance::Box&, int) override
    {
        return clearance::Hit::Free;
    }

    clearance::Hit Ray(const clearance::Vec3&, const clearance::Vec3&, const char* aGroup, double* aHitZ) override
    {
        ++rays;
        for (int group = 0; group < kFloorGroupCount; ++group)
        {
            if (std::strcmp(aGroup, kFloorGroups[group]) == 0)
            {
                if (!hit[group])
                {
                    return clearance::Hit::Free;
                }
                if (aHitZ)
                {
                    *aHitZ = z[group];
                }
                return clearance::Hit::Blocked;
            }
        }
        return clearance::Hit::Free;
    }
};

// One candidate straight ahead of V on the X axis, V at (0, 0, kFloorZ), no occupied spots, default body.
CarSpotInput SingleCandidateInput()
{
    CarSpotInput input;
    input.v.x = 0.0;
    input.v.y = 0.0;
    input.v.z = kFloorZ;
    Candidate candidate;
    candidate.x = 1.0;
    candidate.y = 0.0;
    candidate.ux = 1.0;
    candidate.uy = 0.0;
    input.candidates.push_back(candidate);
    input.remaining = kNoBudget;
    return input;
}
} // namespace

TEST(passage_carspot_matches_the_lua)
{
    Fixture fixture("passage-carspot");
    int steps = 0;
    for (const auto& item : fixture.Cases())
    {
        yyjson_val* input = item.Get("input");
        yyjson_val* output = item.Get("output");
        const std::vector<Candidate> candidates = CandidatesOf(yyjson_obj_get(output, "candidates"));
        const std::vector<Point2> occupied = OccupiedOf(yyjson_obj_get(input, "occupied"));
        yyjson_val* stepList = yyjson_obj_get(output, "steps");
        const size_t stepCount = SizeOf(stepList);

        SearchState state;
        for (size_t index = 0; index < stepCount; ++index)
        {
            yyjson_val* step = At(stepList, index);
            ++steps;

            CarSpotInput carInput;
            carInput.v = PointOf(yyjson_obj_get(input, "v"));
            carInput.candidates = candidates;
            carInput.occupied = occupied;
            carInput.body = BodyOf(yyjson_obj_get(input, "body"));
            carInput.carQueries = CarQueriesOf(input);
            carInput.carFloor = 0.3;
            carInput.remaining = RemainingOf(yyjson_obj_get(input, "budget"));
            carInput.state = state;

            ReplayProbe probe(yyjson_obj_get(step, "queries"));
            const CarSpotOutcome outcome = CarSpot(probe, carInput);

            CHECK_EQ(probe.message, std::string());
            CHECK(!probe.failed);
            CHECK(probe.Done());
            CHECK_WIRE(FormatCarSpot(outcome), TextOf(step, "wire"));
            CHECK_EQ(outcome.used, IntOf(step, "used"));
            CHECK_EQ(outcome.deferred, IntOf(step, "deferred") == 1);
            if (index + 1 == stepCount)
            {
                CHECK(outcome.status == StatusOf(TextOf(step, "status")));
            }
            state = outcome.state;
        }
    }
    CHECK(steps >= kMinimumSteps);
}

TEST(passage_fallback_when_a_game_call_fails)
{
    struct FailureCase
    {
        int failAt;
        const char* wire;
    };
    const FailureCase failures[] = {{1, "4 1 7"}, {4, "4 4 7"}, {7, "4 7 7"}, {9, "4 9 7"}};
    for (const FailureCase& item : failures)
    {
        FailingProbe probe(item.failAt);
        const CarSpotOutcome outcome = CarSpot(probe, SingleCandidateInput());
        CHECK(outcome.status == Status::Fallback);
        CHECK_EQ(outcome.used, item.failAt);
        CHECK_EQ(outcome.code, kFailingCode);
        CHECK_EQ(probe.count, item.failAt);
        CHECK_WIRE(FormatCarSpot(outcome), item.wire);
        CHECK_EQ(outcome.state.index, 1);
        CHECK_EQ(outcome.state.hasFloor, item.failAt > 3); // the floor under V is read by the first three queries
    }

    FailingProbe clean(0);
    const CarSpotOutcome spot = CarSpot(clean, SingleCandidateInput());
    CHECK(spot.status == Status::Spot);
    CHECK_EQ(spot.used, 14);
    CHECK_EQ(clean.count, 14);
    CHECK_NEAR(spot.spot.x, 1.0, 1e-9);
    CHECK_NEAR(spot.spot.y, 0.0, 1e-9);
    CHECK_NEAR(spot.spot.z, kFloorZ + 0.05, 1e-9);
}

TEST(passage_wire_format)
{
    CarSpotOutcome spot;
    spot.status = Status::Spot;
    spot.used = 14;
    spot.deferred = false;
    spot.state.index = 1;
    spot.state.hasFloor = true;
    spot.state.floor = 50.0;
    spot.spot.x = 100.95;
    spot.spot.y = 200.0;
    spot.spot.z = 50.05;
    CHECK_WIRE(FormatCarSpot(spot), "0 14 0 1 1 50 100.95 200 50.05");

    CarSpotOutcome none;
    none.status = Status::None;
    none.used = 3;
    none.reason = Reason::NoCarFloor;
    CHECK_WIRE(FormatCarSpot(none), "1 3 0 1 0 0 1");
    none.reason = Reason::PhysicsUnavailable;
    CHECK_WIRE(FormatCarSpot(none), "1 3 0 1 0 0 2");

    CarSpotOutcome pending;
    pending.status = Status::Pending;
    pending.deferred = true;
    pending.used = 0;
    pending.state.index = 1;
    CHECK_WIRE(FormatCarSpot(pending), "2 0 1 1 0 0");

    CarSpotOutcome fallback;
    fallback.status = Status::Fallback;
    fallback.used = 5;
    fallback.code = 3;
    CHECK_WIRE(FormatCarSpot(fallback), "4 5 3");

    CHECK_EQ(FormatNumber(NAN), std::string("nan"));
    CHECK_EQ(FormatNumber(INFINITY), std::string("inf"));
    CHECK_EQ(FormatNumber(-INFINITY), std::string("-inf"));
}

TEST(passage_floor_at_takes_the_highest_hit)
{
    ScriptedProbe probe;
    probe.hit[0] = true; // Static
    probe.z[0] = 10.0;
    probe.hit[2] = true; // Terrain
    probe.z[2] = 9.0;
    const FloorRead read = FloorAt(probe, 0.0, 0.0, 10.9, 9.4, 3);
    CHECK(read.found);
    CHECK(!read.deferred);
    CHECK(!read.error);
    CHECK_NEAR(read.z, 10.0, 1e-12);
    CHECK_EQ(read.used, 3);
    CHECK_EQ(probe.rays, 3);

    ScriptedProbe starved;
    starved.hit[0] = true;
    starved.z[0] = 10.0;
    const FloorRead few = FloorAt(starved, 0.0, 0.0, 10.9, 9.4, 2);
    CHECK(few.deferred);
    CHECK_EQ(few.used, 0);
    CHECK_EQ(starved.rays, 0);

    ScriptedProbe terrain;
    terrain.hit[2] = true;
    terrain.z[2] = 9.5;
    const FloorRead low = FloorAt(terrain, 0.0, 0.0, 10.9, 9.4, 3);
    CHECK(low.found);
    CHECK_NEAR(low.z, 9.5, 1e-12);
}
