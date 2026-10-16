// CyberpunkConvaiNative.dll: the RED4ext lifecycle and nothing else.
//
// The plugin moves the mod's hot game-thread work out of CET Lua, one system at a time. Each
// system registers RTTI natives that the Lua calls when it detects the plugin; when the plugin is
// missing, refused or switched off, the Lua runs its original path unchanged.
//
// Safety rules (docs/NATIVE_REWRITE_PLAN.md, "Architecture"):
//   - Version-pinned: Query declares game 2.31, so RED4ext refuses the DLL after a patch, and Main
//     re-checks the product version. The Lua probe then finds no ConvaiNative class.
//   - RTTI registration only: no hooks, no addresses, no game memory reads of our own.
//   - Fail soft: a failure in Load logs and returns false (RED4ext unloads us); nothing here
//     can stop the game from starting. Natives never throw across the boundary (rtti::Guard).
//   - Separate from CyberpunkConvaiLauncher.dll, which stays runtime-independent, so a patch-day
//     refusal of this plugin never stops the bridge from starting.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <RED4ext/RED4ext.hpp>

#include "Rtti.hpp"
#include "Systems.hpp"
#include "core/FileIo.hpp"
#include "core/Log.hpp"
#include "core/Paths.hpp"
#include "core/Switches.hpp"
#include "core/Version.hpp"

namespace convai::systems
{
std::vector<System>& All()
{
    static std::vector<System> systems;
    return systems;
}
} // namespace convai::systems

namespace
{
RED4ext::v1::PluginHandle g_handle = nullptr;
const RED4ext::v1::Sdk* g_sdk = nullptr;
bool g_started = false;

void LogSink(convai::log::Level aLevel, const char* aMessage)
{
    if (!g_sdk || !g_sdk->logger)
    {
        return;
    }
    switch (aLevel)
    {
    case convai::log::Level::Info:
        g_sdk->logger->Info(g_handle, aMessage);
        break;
    case convai::log::Level::Warn:
        g_sdk->logger->Warn(g_handle, aMessage);
        break;
    case convai::log::Level::Error:
        g_sdk->logger->Error(g_handle, aMessage);
        break;
    }
}

void RegisterTypes()
{
    for (const auto& system : convai::systems::All())
    {
        if (system.registerTypes)
        {
            try
            {
                system.registerTypes();
            }
            catch (...)
            {
                CONVAI_ERROR("System %s failed to register its types", system.name);
                convai::GlobalSwitches().Trip(system.name, "type registration failed");
            }
        }
    }
}

void PostRegisterTypes()
{
    for (const auto& system : convai::systems::All())
    {
        if (system.postRegisterTypes)
        {
            try
            {
                system.postRegisterTypes();
            }
            catch (...)
            {
                CONVAI_ERROR("System %s failed to register its functions", system.name);
                convai::GlobalSwitches().Trip(system.name, "registration failed");
            }
        }
    }
    // Every system has recorded its natives. Each class now registers all of them or none, and a
    // system whose class cannot (an unknown parameter type, a refused parameter) is tripped.
    convai::rtti::CommitAll();
}

void ControlFileChanged(std::string_view aContent)
{
    convai::GlobalSwitches().ParseFile(aContent);
}

bool Load()
{
    convai::log::SetSink(&LogSink);

    const auto* runtime = g_sdk ? g_sdk->runtime : nullptr;
    const convai::GameVersion game =
        runtime ? convai::GameVersionFromSemVer(runtime->major, runtime->minor, runtime->patch) : convai::GameVersion{};
    if (!convai::IsSupportedGame(game))
    {
        CONVAI_ERROR("Game version %d.%02d (product %d.%d.%lld) is not the supported %d.%02d; the mod keeps its Lua path",
                     game.major, game.minor, runtime ? static_cast<int>(runtime->major) : -1,
                     runtime ? static_cast<int>(runtime->minor) : -1,
                     runtime ? static_cast<long long>(runtime->patch) : -1LL, convai::kGameMajor, convai::kGameMinor);
        return false;
    }

    const std::wstring runtimeDirectory = convai::paths::ResolveRuntimeDirectory();
    auto& io = convai::GlobalFileIo();
    if (!io.Start(runtimeDirectory))
    {
        CONVAI_ERROR("File IO did not start; the mod keeps its Lua path");
        return false;
    }
    io.SetControlFile("native-off.txt", &ControlFileChanged);

    auto* rtti = RED4ext::CRTTISystem::Get();
    if (!rtti)
    {
        CONVAI_ERROR("The RTTI system is not available; the mod keeps its Lua path");
        return false;
    }
    rtti->AddRegisterCallback(&RegisterTypes);
    rtti->AddPostRegisterCallback(&PostRegisterTypes);

    for (const auto& system : convai::systems::All())
    {
        if (system.start)
        {
            try
            {
                system.start();
            }
            catch (...)
            {
                convai::GlobalSwitches().Trip(system.name, "start failed");
            }
        }
    }
    g_started = true;
    CONVAI_INFO("CyberpunkConvaiNative %s loaded: API %d, %zu systems, runtime %s", convai::kPluginVersion,
                convai::kApiVersion, convai::systems::All().size(),
                convai::paths::WideToUtf8(runtimeDirectory).c_str());
    return true;
}

void Unload()
{
    if (!g_started)
    {
        return;
    }
    auto& systems = convai::systems::All();
    for (auto it = systems.rbegin(); it != systems.rend(); ++it)
    {
        if (it->stop)
        {
            try
            {
                it->stop();
            }
            catch (...)
            {
            }
        }
    }
    convai::GlobalFileIo().Stop(2000);
    g_started = false;
    CONVAI_INFO("CyberpunkConvaiNative unloaded");
    convai::log::SetSink(nullptr);
}
} // namespace

RED4EXT_C_EXPORT bool RED4EXT_CALL Main(RED4ext::v1::PluginHandle aHandle, RED4ext::v1::EMainReason aReason,
                                        const RED4ext::v1::Sdk* aSdk)
{
    try
    {
        switch (aReason)
        {
        case RED4ext::v1::EMainReason::Load:
            g_handle = aHandle;
            g_sdk = aSdk;
            return Load();
        case RED4ext::v1::EMainReason::Unload:
            Unload();
            return true;
        }
    }
    catch (...)
    {
        CONVAI_ERROR("Unexpected exception in Main");
        return false;
    }
    return true;
}

RED4EXT_C_EXPORT void RED4EXT_CALL Query(RED4ext::v1::PluginInfo* aInfo)
{
    aInfo->name = L"CyberpunkConvaiNative";
    aInfo->author = L"AI NPC Cyberpunk Mod";
    aInfo->version = RED4EXT_V1_SEMVER(convai::kPluginMajor, convai::kPluginMinor, convai::kPluginPatch);
    aInfo->runtime = RED4EXT_V1_RUNTIME_VERSION_2_31;
    aInfo->sdk = RED4EXT_V1_SDK_VERSION_CURRENT;
}

RED4EXT_C_EXPORT uint32_t RED4EXT_CALL Supports()
{
    return RED4EXT_API_VERSION_1;
}
