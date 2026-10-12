// ConvaiNativePassage: the standing-spot search inside a lift car (mod/companion-passage.lua
// M.carSpot) in one call per update, off the CET Lua path. The "car" here is an elevator car, not a
// vehicle: the queries are floor and wall rays and the clearance body check, all through the
// clearance system's GameProbe (SpatialQueriesSystem), the same C++ that ConvaiNativeClearance uses.
// docs/NATIVE_VEHICLES.md has the wire format and the in-game checks.
//
//   CarSpot(vx, vy, vz, candidates, occupied, radius, height, carQueries, carFloor, remaining,
//           index, hasFloor, floor) -> String   "<status> <used> ..." (PassageCore.hpp), "" = ask Lua
//   SelfTest()                                -> String   "ok", "wait <reason>" or "fail <reason>"
//   Stats()                                   -> String   counters as JSON, for the CET console
//
// The candidates ("x y ux uy" per candidate) and the occupied points ("x y" per point) are decimal
// text built by the Lua shim once per search and once per call. Lua keeps the search state (the
// candidate list, the next index, the car floor) and the per-update query budget; this call is told
// the state and the budget left and hands back the new state and the queries it issued.

#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "core/Log.hpp"

#include "systems/clearance/ClearanceGame.hpp"
#include "systems/passage/core/PassageCore.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace
{
using namespace convai;

constinit rtti::StaticClass g_class("ConvaiNativePassage");
constexpr const char* kSystem = "passage";
constexpr int kBudgetCap = 1000000;
constexpr size_t kMaxCandidates = 64;
constexpr size_t kMaxOccupied = 64;

// Game thread only.
struct Counters
{
    unsigned long long calls = 0;
    unsigned long long spot = 0;
    unsigned long long none = 0;
    unsigned long long pending = 0;
    unsigned long long deferred = 0;
    unsigned long long fallbacks = 0;
    unsigned long long badInput = 0;
    unsigned long long queriesUsed = 0;
} g_counters;

// A fault inside a body (an exception caught by Guard) answers "fallback, code 9": the Lua shim
// switches the system off for the session and runs its own path.
const std::string kFault = "4 0 9";

// Whitespace-separated finite numbers; false on anything else or on more than aMax numbers.
bool ParseNumbers(const std::string& aText, std::vector<double>& aOut, size_t aMax)
{
    aOut.clear();
    const char* cursor = aText.c_str();
    while (*cursor)
    {
        while (*cursor == ' ')
        {
            ++cursor;
        }
        if (!*cursor)
        {
            break;
        }
        char* end = nullptr;
        const double value = std::strtod(cursor, &end);
        if (end == cursor || (*end != '\0' && *end != ' ') || aOut.size() >= aMax || !(std::abs(value) < 1.0e7))
        {
            return false;
        }
        aOut.push_back(value);
        cursor = end;
    }
    return true;
}

void CarSpot(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    double vx = 0, vy = 0, vz = 0, radius = 0, height = 0, carFloor = 0, floor = 0;
    RED4ext::CString candidatesText;
    RED4ext::CString occupiedText;
    int32_t carQueries = 0, remaining = 0, index = 1;
    bool hasFloor = false;
    rtti::ReadArgs(aFrame, &vx, &vy, &vz, &candidatesText, &occupiedText, &radius, &height, &carQueries, &carFloor,
                   &remaining, &index, &hasFloor, &floor);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               ++g_counters.calls;
                               std::vector<double> numbers;
                               passage::CarSpotInput input;
                               input.v = {vx, vy, vz};
                               input.body = {radius, height};
                               input.carQueries = std::clamp(carQueries, 0, 1000);
                               input.carFloor = carFloor;
                               input.remaining = std::clamp(remaining, 0, kBudgetCap);

                               if (!ParseNumbers(candidatesText.c_str(), numbers, kMaxCandidates * 4) ||
                                   numbers.empty() || numbers.size() % 4 != 0)
                               {
                                   ++g_counters.badInput;
                                   return std::string();
                               }
                               for (size_t at = 0; at < numbers.size(); at += 4)
                               {
                                   input.candidates.push_back(
                                       {numbers[at], numbers[at + 1], numbers[at + 2], numbers[at + 3]});
                               }
                               if (!ParseNumbers(occupiedText.c_str(), numbers, kMaxOccupied * 2) ||
                                   numbers.size() % 2 != 0)
                               {
                                   ++g_counters.badInput;
                                   return std::string();
                               }
                               for (size_t at = 0; at < numbers.size(); at += 2)
                               {
                                   input.occupied.push_back({numbers[at], numbers[at + 1]});
                               }
                               if (index < 1 || static_cast<size_t>(index) > input.candidates.size() + 1 ||
                                   !(std::abs(floor) < 1.0e7) || !(std::abs(carFloor) < 1.0e7))
                               {
                                   ++g_counters.badInput;
                                   return std::string();
                               }
                               input.state.index = index;
                               input.state.hasFloor = hasFloor;
                               input.state.floor = hasFloor ? floor : 0.0;

                               clearance::GameProbe probe;
                               const passage::CarSpotOutcome outcome = passage::CarSpot(probe, input);
                               g_counters.queriesUsed += static_cast<unsigned long long>(outcome.used);
                               g_counters.deferred += outcome.deferred ? 1 : 0;
                               switch (outcome.status)
                               {
                               case passage::Status::Spot:
                                   ++g_counters.spot;
                                   break;
                               case passage::Status::None:
                                   ++g_counters.none;
                                   break;
                               case passage::Status::Pending:
                                   ++g_counters.pending;
                                   break;
                               case passage::Status::Fallback:
                                   ++g_counters.fallbacks;
                                   break;
                               }
                               return passage::FormatCarSpot(outcome);
                           },
                           kFault));
}

// SelfTest() : String   "ok", "wait <reason>" or "fail <reason>": the clearance system's probe of
// the live world (the same queries this system issues).
void SelfTestNative(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [] {
                               const std::string result = clearance::SelfTest();
                               if (result != "ok")
                               {
                                   CONVAI_INFO("Passage self-test: %s", result.c_str());
                               }
                               return result;
                           },
                           std::string("fail the self-test faulted")));
}

void Stats(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [] {
                               char text[320];
                               std::snprintf(text, sizeof(text),
                                             "{\"calls\":%llu,\"spot\":%llu,\"none\":%llu,\"pending\":%llu,"
                                             "\"deferred\":%llu,\"fallbacks\":%llu,\"badInput\":%llu,"
                                             "\"queriesUsed\":%llu}",
                                             g_counters.calls, g_counters.spot, g_counters.none,
                                             g_counters.pending, g_counters.deferred, g_counters.fallbacks,
                                             g_counters.badInput, g_counters.queriesUsed);
                               return std::string(text);
                           },
                           std::string("{}")));
}

// A function whose parameter type the game does not know would register with a missing
// parameter, and then misread its arguments. Check every type first and skip the function (the
// Lua shim sees the native missing and stays on its own path).
bool TypesExist(std::initializer_list<const char*> aTypes)
{
    auto* rtti = RED4ext::CRTTISystem::Get();
    for (const char* name : aTypes)
    {
        if (!rtti || !rtti->GetType(name))
        {
            CONVAI_ERROR("Passage: RTTI type %s is unknown, natives that use it are not registered", name);
            return false;
        }
    }
    return true;
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    g_class.Static("SelfTest", &SelfTestNative, "String", {});
    g_class.Static("Stats", &Stats, "String", {});
    if (TypesExist({"String", "Bool", "Int32", "Double"}))
    {
        g_class.Static("CarSpot", &CarSpot, "String",
                       {{"Double", "vx"},
                        {"Double", "vy"},
                        {"Double", "vz"},
                        {"String", "candidates"},
                        {"String", "occupied"},
                        {"Double", "radius"},
                        {"Double", "height"},
                        {"Int32", "carQueries"},
                        {"Double", "carFloor"},
                        {"Int32", "remaining"},
                        {"Int32", "index"},
                        {"Bool", "hasFloor"},
                        {"Double", "floor"}});
    }
}
} // namespace

CONVAI_SYSTEM(passage, {
    .name = "passage",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
