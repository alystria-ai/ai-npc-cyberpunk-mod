// ConvaiNativeChauffeur: the chauffeur sample of mod/companion-chauffeur-native.lua in one call, off
// the CET Lua path. M.sample reads 80-120 values ten times a second while a companion trip runs and
// M.inspectDrive about 30 more (also for retarget, stop and brake); docs/NATIVE_VEHICLES.md has the
// wire format and the in-game checks.
//
//   Sample(npc, player, car, owner, given, actorHash, carHash, hasOperation, hasReceipt, receiptId,
//          receiptClass) -> String   "A .. P .. C .. [D ..] U .. W .." (ChauffeurCore.hpp), "" = ask Lua
//   Drive(car, carHash, given, hasOperation, hasReceipt, receiptId, receiptClass)
//                                       -> String   "0" (not the live leased car) | "1 D .." | "" = ask Lua
//   Stats()                             -> String   counters as JSON, for the CET console
//
// The entities come from Lua, which only passes a companion the mod spawned and the car the trip
// leased; nothing here enumerates anything. Hashes travel as decimal digits (the Lua strips CET's
// type suffix). "given" is the AI command the Lua trip holds (a handle; empty when there is none).

#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "core/Log.hpp"

#include "systems/chauffeur/ChauffeurGame.hpp"

#include <cstdio>
#include <cstdlib>

namespace
{
using namespace convai;
using chauffeur::game::Object;

constinit rtti::StaticClass g_class("ConvaiNativeChauffeur", "chauffeur");
constexpr const char* kSystem = "chauffeur";

// Game thread only.
struct Counters
{
    unsigned long long sample = 0;
    unsigned long long sampleSections = 0; // answers where every section was read
    unsigned long long sampleFailedSections = 0;
    unsigned long long drive = 0;
    unsigned long long driveNotLive = 0;
    unsigned long long driveUnavailable = 0;
} g_counters;

// Decimal digits to a hash; false for anything else (an empty text is the nil id).
bool ParseHash(const RED4ext::CString& aText, uint64_t& aOut)
{
    aOut = 0;
    const char* text = aText.c_str();
    if (!text || !*text)
    {
        return true;
    }
    for (const char* cursor = text; *cursor; ++cursor)
    {
        if (*cursor < '0' || *cursor > '9')
        {
            return false;
        }
    }
    aOut = std::strtoull(text, nullptr, 10);
    return true;
}

bool HasFailedSection(const std::string& aText)
{
    // A failed section is the tag token followed by "!".
    return aText.find(" !") != std::string::npos || aText.rfind("A !", 0) == 0;
}

void Sample(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    Object npc, player, car, owner, given;
    RED4ext::CString actorText, carText, receiptClass;
    bool hasOperation = false, hasReceipt = false;
    double receiptId = 0.0;
    rtti::ReadArgs(aFrame, &npc, &player, &car, &owner, &given, &actorText, &carText, &hasOperation, &hasReceipt,
                   &receiptId, &receiptClass);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               ++g_counters.sample;
                               chauffeur::game::SampleArgs args;
                               args.npc = npc;
                               args.player = player;
                               args.car = car;
                               args.owner = owner;
                               if (!ParseHash(actorText, args.actorHash) || !ParseHash(carText, args.carHash))
                               {
                                   return std::string();
                               }
                               args.drive.given = given;
                               args.drive.hasOperation = hasOperation;
                               args.drive.hasReceipt = hasReceipt;
                               args.drive.receiptId = receiptId;
                               args.drive.receiptClass = receiptClass.c_str();
                               const std::string text = chauffeur::game::Sample(args);
                               if (HasFailedSection(text))
                               {
                                   ++g_counters.sampleFailedSections;
                               }
                               else
                               {
                                   ++g_counters.sampleSections;
                               }
                               return text;
                           },
                           std::string()));
}

void Drive(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    Object car, given;
    RED4ext::CString carText, receiptClass;
    bool hasOperation = false, hasReceipt = false;
    double receiptId = 0.0;
    rtti::ReadArgs(aFrame, &car, &carText, &given, &hasOperation, &hasReceipt, &receiptId, &receiptClass);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               ++g_counters.drive;
                               uint64_t carHash = 0;
                               if (!ParseHash(carText, carHash))
                               {
                                   ++g_counters.driveUnavailable;
                                   return std::string();
                               }
                               chauffeur::game::DriveArgs args;
                               args.given = given;
                               args.hasOperation = hasOperation;
                               args.hasReceipt = hasReceipt;
                               args.receiptId = receiptId;
                               args.receiptClass = receiptClass.c_str();
                               const std::string text = chauffeur::game::Drive(car, carHash, args);
                               if (text.empty())
                               {
                                   ++g_counters.driveUnavailable;
                               }
                               else if (text == "0")
                               {
                                   ++g_counters.driveNotLive;
                               }
                               return text;
                           },
                           std::string()));
}

void Stats(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [] {
                               char text[320];
                               std::snprintf(text, sizeof(text),
                                             "{\"sample\":%llu,\"sampleComplete\":%llu,\"sampleFailedSections\":%llu,"
                                             "\"drive\":%llu,\"driveNotLive\":%llu,\"driveUnavailable\":%llu}",
                                             g_counters.sample, g_counters.sampleSections,
                                             g_counters.sampleFailedSections, g_counters.drive,
                                             g_counters.driveNotLive, g_counters.driveUnavailable);
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
    g_class.Static("Sample", &Sample, "String",
                   {{"handle:gameObject", "npc"},
                    {"handle:gameObject", "player"},
                    {"handle:gameObject", "car"},
                    {"handle:IScriptable", "owner"},
                    {"handle:IScriptable", "given"},
                    {"String", "actorHash"},
                    {"String", "carHash"},
                    {"Bool", "hasOperation"},
                    {"Bool", "hasReceipt"},
                    {"Double", "receiptId"},
                    {"String", "receiptClass"}});
    g_class.Static("Drive", &Drive, "String",
                   {{"handle:gameObject", "car"},
                    {"String", "carHash"},
                    {"handle:IScriptable", "given"},
                    {"Bool", "hasOperation"},
                    {"Bool", "hasReceipt"},
                    {"Double", "receiptId"},
                    {"String", "receiptClass"}});
}
} // namespace

CONVAI_SYSTEM(chauffeur, {
    .name = "chauffeur",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
