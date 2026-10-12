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

// The one game build this plugin is compiled and tested for: 2.31 (file version 3.0.80.51928).
// RED4ext refuses the DLL on any other build because Query declares this runtime, and Main
// re-checks the product version as a second guard.
constexpr int kGameMajor = 2;
constexpr int kGameMinor = 31;
} // namespace convai
