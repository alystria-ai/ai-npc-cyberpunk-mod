#pragma once

// Parity fixtures: inputs and outputs recorded from the Lua implementation by a fengari test
// (bridge/<module>-native.test.mjs, CONVAI_WRITE_FIXTURES=1) into tests/fixtures/<name>.json:
//
//   {"system": "<name>", "source": "mod/<module>.lua", "cases": [
//       {"name": "...", "input": {...}, "output": {...}}, ...]}
//
// A C++ test replays every case through the native core and compares:
//
//   TEST(gaze_matches_lua) {
//       convai::test::Fixture fixture("gaze-angles");
//       for (auto item : fixture.Cases()) {
//           const auto out = AimAngles(item.Num("input", "yaw"), item.Num("input", "pitch"));
//           CHECK_NEAR(out.yaw, item.Num("output", "yaw"), 1e-9);
//       }
//       CHECK(fixture.Count() > 0);
//   }

#include "Test.hpp"

#include <yyjson.h>

#include <cmath>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#ifndef CONVAI_FIXTURE_DIR
#error "CMake defines CONVAI_FIXTURE_DIR for convai_core_tests"
#endif

namespace convai::test
{
class FixtureCase
{
public:
    explicit FixtureCase(yyjson_val* aCase) : m_case(aCase) {}

    std::string Name() const { return Str("name"); }
    // A value under a section ("input" / "output"), or the case itself when aSection is empty.
    yyjson_val* Get(const char* aSection, const char* aKey = nullptr) const
    {
        yyjson_val* node = aSection && *aSection ? yyjson_obj_get(m_case, aSection) : m_case;
        return aKey && node ? yyjson_obj_get(node, aKey) : node;
    }
    bool Has(const char* aSection, const char* aKey) const
    {
        yyjson_val* value = Get(aSection, aKey);
        return value && !yyjson_is_null(value);
    }
    double Num(const char* aSection, const char* aKey) const
    {
        yyjson_val* value = Get(aSection, aKey);
        return value && yyjson_is_num(value) ? yyjson_get_num(value) : std::nan("");
    }
    bool Bool(const char* aSection, const char* aKey) const
    {
        yyjson_val* value = Get(aSection, aKey);
        return value && yyjson_is_true(value);
    }
    std::string Str(const char* aSection, const char* aKey = nullptr) const
    {
        yyjson_val* value = aKey ? Get(aSection, aKey) : yyjson_obj_get(m_case, aSection);
        return value && yyjson_is_str(value) ? std::string(yyjson_get_str(value), yyjson_get_len(value)) : std::string();
    }

private:
    yyjson_val* m_case;
};

class Fixture
{
public:
    explicit Fixture(const std::string& aName)
    {
        const std::string path = std::string(CONVAI_FIXTURE_DIR) + "/" + aName + ".json";
        std::ifstream file(path, std::ios::binary);
        const std::string text((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
        m_doc = yyjson_read(text.data(), text.size(), 0);
        if (!m_doc)
        {
            Fail(__FILE__, __LINE__, "cannot read fixture " + path);
        }
    }
    ~Fixture()
    {
        if (m_doc)
        {
            yyjson_doc_free(m_doc);
        }
    }
    Fixture(const Fixture&) = delete;
    Fixture& operator=(const Fixture&) = delete;

    std::vector<FixtureCase> Cases() const
    {
        std::vector<FixtureCase> cases;
        yyjson_val* list = m_doc ? yyjson_obj_get(yyjson_doc_get_root(m_doc), "cases") : nullptr;
        size_t index;
        size_t count;
        yyjson_val* item;
        yyjson_arr_foreach(list, index, count, item)
        {
            cases.emplace_back(item);
        }
        return cases;
    }
    size_t Count() const { return Cases().size(); }

private:
    yyjson_doc* m_doc = nullptr;
};
} // namespace convai::test

// Absolute tolerance. Use 1e-9 for double math done in the same order as the Lua, about 1e-4
// where the game hands over float32 values.
#define CHECK_NEAR(a, b, tolerance)                                                                                    \
    do                                                                                                                 \
    {                                                                                                                  \
        const double nearLeft = (a);                                                                                   \
        const double nearRight = (b);                                                                                  \
        if (!(std::fabs(nearLeft - nearRight) <= (tolerance)))                                                         \
            ::convai::test::Fail(__FILE__, __LINE__,                                                                   \
                                 "CHECK_NEAR(" #a ", " #b "): " + ::convai::test::Describe(nearLeft, nearRight));     \
    } while (0)
