// ConvaiNative: detection, version check, kill switches and status. Lua's mod/native-core.lua
// calls these first; every other system is used only after CheckVersion(api) returns true.

#include "plugin/GameAccess.hpp"
#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "core/FileIo.hpp"
#include "core/Log.hpp"
#include "core/Paths.hpp"
#include "core/Switches.hpp"
#include "core/Version.hpp"

#include <cstdio>

namespace
{
using namespace convai;

constinit rtti::StaticClass g_class("ConvaiNative", "core");

std::string ToString(const RED4ext::CString& aText)
{
    return std::string(aText.c_str(), aText.Length());
}

std::string StatusJson()
{
    const FileIoStats io = GlobalFileIo().Stats();
    char ioJson[896];
    std::snprintf(ioJson, sizeof(ioJson),
                  "{\"running\":%s,\"writes\":%llu,\"skippedIdentical\":%llu,\"coalesced\":%llu,\"fallbacks\":%llu,"
                  "\"failures\":%llu,\"removes\":%llu,\"renames\":%llu,\"appendFlushes\":%llu,\"polls\":%llu,"
                  "\"reads\":%llu,\"publishes\":%llu,\"jsonRejected\":%llu,\"mainThreadReads\":%llu,"
                  "\"maxOpMicros\":%llu,\"pending\":%llu,\"watchEvents\":%llu,\"watchWakes\":%llu}",
                  GlobalFileIo().Running() ? "true" : "false", io.writes, io.writesSkippedIdentical,
                  io.writesCoalesced, io.writeFallbacks, io.writeFailures, io.removes, io.renames, io.appendsFlushed,
                  io.polls, io.reads, io.publishes, io.jsonRejected, io.mainThreadReads, io.maxOpMicros, io.pending,
                  io.watchEvents, io.watchWakes);
    std::string names = "[";
    for (const auto& system : systems::All())
    {
        names += (names.size() > 1 ? ",\"" : "\"") + JsonEscape(system.name) + "\"";
    }
    names += "]";
    std::string out = "{\"plugin\":\"";
    out += kPluginVersion;
    out += "\",\"api\":" + std::to_string(kApiVersion);
    out += ",\"game\":\"" + std::to_string(kGameMajor) + "." + std::to_string(kGameMinor) + "\"";
    out += ",\"runtime\":\"" + JsonEscape(paths::WideToUtf8(GlobalFileIo().RuntimeDirectory())) + "\"";
    // Mod Organizer 2's virtual file system is loaded: file replaces use MoveFileExW, which it sees.
    out += std::string(",\"vfs\":") + (fileio::VirtualFileSystemLoaded() ? "true" : "false");
    out += ",\"systems\":" + names;
    out += ",\"switches\":" + GlobalSwitches().DescribeJson();
    // How an NPC's combat flag is read (unresolved until a companion first asks, then the route or "none").
    out += ",\"combat\":" + game::CombatRouteJson();
    out += ",\"io\":";
    out += ioJson;
    out += ",\"lastProblem\":\"" + JsonEscape(log::LastProblem()) + "\"}";
    return out;
}

void ApiVersion(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, kApiVersion);
}

void PluginVersion(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, std::string(kPluginVersion));
}

void CheckVersion(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    int32_t luaApi = 0;
    rtti::ReadArgs(aFrame, &luaApi);
    const bool ok = rtti::Guard(
        "core",
        [&] {
            const bool compatible = luaApi == kApiVersion && GlobalFileIo().Running();
            if (!compatible)
            {
                CONVAI_WARN("Lua asked for API %d, plugin has %d (io running: %s)", luaApi, kApiVersion,
                            GlobalFileIo().Running() ? "yes" : "no");
            }
            return compatible;
        },
        false);
    rtti::Return(aOut, ok);
}

void SystemEnabled(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    RED4ext::CString name;
    rtti::ReadArgs(aFrame, &name);
    rtti::Return(aOut, rtti::Guard("core", [&] { return GlobalSwitches().Enabled(ToString(name)); }, false));
}

void Status(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard("core", [] { return StatusJson(); }, std::string("{}")));
}

void GameProbe(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard("core", [] { return game::ProbeJson(); },
                                   std::string("{\"ok\":false,\"reason\":\"fault\"}")));
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    g_class.Static("ApiVersion", &ApiVersion, "Int32", {});
    g_class.Static("PluginVersion", &PluginVersion, "String", {});
    g_class.Static("CheckVersion", &CheckVersion, "Bool", {{"Int32", "luaApi"}});
    g_class.Static("SystemEnabled", &SystemEnabled, "Bool", {{"String", "system"}});
    g_class.Static("Status", &Status, "String", {});
    g_class.Static("GameProbe", &GameProbe, "String", {});
}
} // namespace

CONVAI_SYSTEM(core, {
    .name = "core",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
