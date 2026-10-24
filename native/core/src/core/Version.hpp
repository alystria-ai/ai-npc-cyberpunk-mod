#pragma once

// Versions the Lua side checks before it uses any native system.
//
// kApiVersion changes when a Lua-visible native signature or its meaning changes in a way an
// older mod/native-core.lua cannot handle. The Lua shim passes the API it was written for to
// ConvaiNative.CheckVersion; a mismatch keeps every system on the Lua path.

namespace convai
{
constexpr int kApiVersion = 1;

constexpr int kPluginMajor = 0;
constexpr int kPluginMinor = 1;
constexpr int kPluginPatch = 0;
constexpr const char* kPluginVersion = "0.1.0";

// The one game build this plugin is compiled and tested for. Two variants are built from this source
// (CMake option CONVAI_GAME, scripts/Build-NativeCore.ps1 -Game): 2.31 (file version 3.0.80.51928, the
// default) and 2.5 (3.0.88.46235, CONVAI_GAME_2_5). RED4ext refuses the DLL on any other build because
// Query declares this runtime, and Main re-checks the product version as a second guard.
#if defined(CONVAI_GAME_2_5)
constexpr int kGameMajor = 2;
constexpr int kGameMinor = 50; // RED4ext's SemVer 2.5.0
constexpr const char* kGameLabel = "2.5";
#else
constexpr int kGameMajor = 2;
constexpr int kGameMinor = 31;
constexpr const char* kGameLabel = "2.31";
#endif

// RED4ext hands the game's product version over as a SemVer that splits CD Projekt's two-digit
// minor (RED4ext.SDK Api/v1/Runtime.hpp): 1.03 -> 1.0.3, 1.10 -> 1.1.0, 2.31 -> 2.3.1, 2.50 -> 2.5.0.
struct GameVersion
{
    int major = -1;
    int minor = -1; // CD Projekt's minor: 31 for 2.31
};

constexpr GameVersion GameVersionFromSemVer(int aMajor, int aMinor, long long aPatch) noexcept
{
    if (aMajor < 0 || aMinor < 0 || aMinor > 9 || aPatch < 0 || aPatch > 9)
    {
        return {}; // not a CD Projekt product version
    }
    return {aMajor, aMinor * 10 + static_cast<int>(aPatch)};
}

constexpr bool IsSupportedGame(const GameVersion& aVersion) noexcept
{
    return aVersion.major == kGameMajor && aVersion.minor == kGameMinor;
}
} // namespace convai
