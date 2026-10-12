// ConvaiNativeVehicles: the vehicle inspection and mount reads of mod/companion-vehicle-native.lua
// in one call each, off the CET Lua path. Lua side: M.inspect (about 58 CET calls and 35 property
// reads per car) and the not-mounted answer of M.mounting; docs/NATIVE_VEHICLES.md has the wire
// format and the in-game checks.
//
//   Inspect(entity, owned)  -> String   "V <status> ..." (VehiclesCore.hpp), "" = ask the game from Lua
//   Mounting(npc)           -> String   "M -" or "M <parentHash> <seat>", "" = ask the game from Lua
//   Stats()                 -> String   counters as JSON, for the CET console
//
// The entity and the npc always come from Lua, which only passes cars the mod made or leased and
// companions it spawned; nothing here enumerates anything.

#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "core/Log.hpp"

#include "systems/vehicles/VehiclesGame.hpp"
#include "systems/vehicles/core/VehiclesCore.hpp"

#include <cstdio>

namespace
{
using namespace convai;
using vehicles::game::Object;

constinit rtti::StaticClass g_class("ConvaiNativeVehicles", "vehicles");
constexpr const char* kSystem = "vehicles";

// Game thread only.
struct Counters
{
    unsigned long long inspect = 0;
    unsigned long long inspectReady = 0;
    unsigned long long inspectOther = 0;
    unsigned long long inspectUnavailable = 0;
    unsigned long long mounting = 0;
    unsigned long long mountingNone = 0;
    unsigned long long mountingMounted = 0;
    unsigned long long mountingUnavailable = 0;
} g_counters;

void Inspect(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    Object entity;
    bool owned = false;
    rtti::ReadArgs(aFrame, &entity, &owned);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               ++g_counters.inspect;
                               vehicles::InspectRaw raw;
                               if (!vehicles::game::ReadInspect(entity, owned, raw))
                               {
                                   ++g_counters.inspectUnavailable;
                                   return std::string();
                               }
                               const vehicles::InspectResult result = vehicles::DecideInspect(raw);
                               if (result.status == vehicles::InspectStatus::Ready)
                               {
                                   ++g_counters.inspectReady;
                               }
                               else
                               {
                                   ++g_counters.inspectOther;
                               }
                               return vehicles::FormatInspect(result);
                           },
                           std::string()));
}

void Mounting(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    Object npc;
    rtti::ReadArgs(aFrame, &npc);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               ++g_counters.mounting;
                               vehicles::game::MountRead read;
                               if (!vehicles::game::ReadMounting(npc, read))
                               {
                                   ++g_counters.mountingUnavailable;
                                   return std::string();
                               }
                               if (read.mounted)
                               {
                                   ++g_counters.mountingMounted;
                               }
                               else
                               {
                                   ++g_counters.mountingNone;
                               }
                               return vehicles::FormatMounting(read.mounted, read.parent, read.seat);
                           },
                           std::string()));
}

void Stats(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [] {
                               char text[384];
                               std::snprintf(text, sizeof(text),
                                             "{\"inspect\":%llu,\"inspectReady\":%llu,\"inspectOther\":%llu,"
                                             "\"inspectUnavailable\":%llu,\"mounting\":%llu,\"mountingNone\":%llu,"
                                             "\"mountingMounted\":%llu,\"mountingUnavailable\":%llu}",
                                             g_counters.inspect, g_counters.inspectReady, g_counters.inspectOther,
                                             g_counters.inspectUnavailable, g_counters.mounting,
                                             g_counters.mountingNone, g_counters.mountingMounted,
                                             g_counters.mountingUnavailable);
                               return std::string(text);
                           },
                           std::string("{}")));
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    g_class.Static("Stats", &Stats, "String", {});
    // All or nothing: rtti::CommitAll checks every parameter and return type of every native against the
    // game's RTTI before it registers any of them, and a system with an unknown type is disabled whole.
    g_class.Static("Inspect", &Inspect, "String", {{"handle:gameObject", "entity"}, {"Bool", "owned"}});
    g_class.Static("Mounting", &Mounting, "String", {{"handle:gameObject", "npc"}});
}
} // namespace

CONVAI_SYSTEM(vehicles, {
    .name = "vehicles",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
