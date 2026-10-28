// CyberpunkConvaiNative.dll: the RED4ext lifecycle and nothing else.
//
// The plugin moves the mod's hot game-thread work out of CET Lua, one system at a time. Each
// system registers RTTI natives that the Lua calls when it detects the plugin; when the plugin is
// missing, refused or switched off, the Lua runs its original path unchanged.
//
// Safety rules (docs/NATIVE_REWRITE_PLAN.md, "Architecture"):
//   - Version-pinned: Query declares the game build this variant targets (2.31 or 2.5), so RED4ext refuses the DLL after a patch, and Main
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
bool g_ioStarted = false;      // the file IO threads run (they must be stopped on any failed Load)
bool g_callbacksAdded = false; // RED4ext holds function pointers into this DLL

// The load failed after the DLL handed out pointers into itself: a library RED4ext frees would
// leave dangling callbacks, so keep it mapped for the rest of the process.
void FailLoad() noexcept
{
    try
    {
        if (g_ioStarted)
        {
            convai::GlobalFileIo().Stop(2000);
            g_ioStarted = false;
        }
    }
    catch (...)
    {
    }
    if (g_callbacksAdded)
    {
        convai::PinThisModule();
    }
}

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

// From 0.3.4 this DLL ships in the Scripts (red4ext/plugins/AiNpcCyberpunkCode/); a Runtime of 0.3.3 or older still has its own copy in
// red4ext/plugins/AiNpcCyberpunkModNative/. The launcher beside this DLL renames that copy before RED4ext reaches it (docs/PACKAGING.md,
// "Code in the Scripts"), so normally only this one loads. When it could not (the old copy was loaded first, or the rename failed and the
// old copy loads after this one), exactly one copy must run: this one stands down and the other serves this session.
bool AnotherCopyServes() noexcept
{
    HMODULE self = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCWSTR>(&AnotherCopyServes), &self))
    {
        return false;
    }
    const HMODULE first = GetModuleHandleW(L"CyberpunkConvaiNative.dll");
    if (first && first != self)
    {
        return true;
    }
    const std::wstring root = convai::paths::GameRootFromExecutable();
    if (root.empty())
    {
        return false;
    }
    const std::wstring old = root + L"\\red4ext\\plugins\\AiNpcCyberpunkModNative\\CyberpunkConvaiNative.dll";
    wchar_t own[MAX_PATH * 4];
    const DWORD length = GetModuleFileNameW(self, own, static_cast<DWORD>(std::size(own)));
    if (length > 0 && length < std::size(own) && _wcsicmp(own, old.c_str()) == 0)
    {
        return false; // this IS the old place (a development install)
    }
    const HMODULE oldLoaded = GetModuleHandleW(old.c_str());
    if (oldLoaded && oldLoaded != self)
    {
        return true;
    }
    return GetFileAttributesW(old.c_str()) != INVALID_FILE_ATTRIBUTES;
}

bool Load()
{
    convai::log::SetSink(&LogSink);

    if (AnotherCopyServes())
    {
        CONVAI_ERROR("An older Runtime's copy of this plugin (red4ext\\plugins\\AiNpcCyberpunkModNative) is loaded or still in place; "
                     "this copy stands down for this session and the launcher retires the old one");
        return false;
    }

    const auto* runtime = g_sdk ? g_sdk->runtime : nullptr;
    const convai::GameVersion game =
        runtime ? convai::GameVersionFromSemVer(runtime->major, runtime->minor, runtime->patch) : convai::GameVersion{};
    if (!convai::IsSupportedGame(game))
    {
        CONVAI_ERROR("Game version %d.%02d (product %d.%d.%lld) is not the supported %s; this is the %s variant, the mod keeps its Lua path",
                     game.major, game.minor, runtime ? static_cast<int>(runtime->major) : -1,
                     runtime ? static_cast<int>(runtime->minor) : -1,
                     runtime ? static_cast<long long>(runtime->patch) : -1LL, convai::kGameLabel, convai::kGameLabel);
        return false;
    }

    // Everything that can still fail comes before file IO starts: its two threads run code of this
    // DLL, so a "return false" after them (RED4ext then unloads the library) would leave them
    // running in unmapped memory.
    auto* rtti = RED4ext::CRTTISystem::Get();
    if (!rtti)
    {
        CONVAI_ERROR("The RTTI system is not available; the mod keeps its Lua path");
        return false;
    }

    const std::wstring runtimeDirectory = convai::paths::ResolveRuntimeDirectory();
    auto& io = convai::GlobalFileIo();
    if (!io.Start(runtimeDirectory))
    {
        CONVAI_ERROR("File IO did not start; the mod keeps its Lua path");
        return false;
    }
    g_ioStarted = true;
    io.SetControlFile("native-off.txt", &ControlFileChanged);

    // From here the DLL must stay mapped: RED4ext calls these callbacks later.
    rtti->AddRegisterCallback(&RegisterTypes);
    rtti->AddPostRegisterCallback(&PostRegisterTypes);
    g_callbacksAdded = true;

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
    g_ioStarted = false;
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
            if (!Load())
            {
                FailLoad();
                return false;
            }
            return true;
        case RED4ext::v1::EMainReason::Unload:
            Unload();
            return true;
        }
    }
    catch (...)
    {
        CONVAI_ERROR("Unexpected exception in Main");
        FailLoad();
        return false;
    }
    return true;
}

RED4EXT_C_EXPORT void RED4EXT_CALL Query(RED4ext::v1::PluginInfo* aInfo)
{
    aInfo->name = L"CyberpunkConvaiNative";
    aInfo->author = L"AI NPC Cyberpunk Mod";
    aInfo->version = RED4EXT_V1_SEMVER(convai::kPluginMajor, convai::kPluginMinor, convai::kPluginPatch);
#if defined(CONVAI_GAME_2_5)
    aInfo->runtime = RED4EXT_V1_RUNTIME_VERSION_2_50;
#else
    aInfo->runtime = RED4EXT_V1_RUNTIME_VERSION_2_31;
#endif
    aInfo->sdk = RED4EXT_V1_SDK_VERSION_CURRENT;
}

RED4EXT_C_EXPORT uint32_t RED4EXT_CALL Supports()
{
    return RED4EXT_API_VERSION_1;
}
