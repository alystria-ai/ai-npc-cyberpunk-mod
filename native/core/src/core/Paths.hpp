#pragma once

#include <string>
#include <string_view>

// Where the plugin may touch the disk, and nothing else.
//
// Every file the natives read or write is a "channel": a bare file name inside the mod's
// runtime folder (<game>\bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\runtime).
// A channel can never hold a path separator, a drive, "..", or a control character, so a Lua
// caller cannot reach any other folder through the natives.

namespace convai::paths
{
std::wstring Utf8ToWide(std::string_view aText);
std::string WideToUtf8(std::wstring_view aText);

// [A-Za-z0-9][A-Za-z0-9._-]{0,95}, and no "..".
bool IsValidChannel(std::string_view aChannel) noexcept;

// The folder of the running executable's grandparent (Cyberpunk2077.exe lives in <game>\bin\x64).
std::wstring GameRootFromExecutable();

// The mod's runtime folder. The environment variable CYBERPUNK_CONVAI_NATIVE_RUNTIME overrides
// it (the headless tests use this); otherwise it is derived from the game root.
std::wstring ResolveRuntimeDirectory();

// aDirectory\aChannel, with the \\?\ prefix when the result is too long for the plain Win32 form.
std::wstring Join(const std::wstring& aDirectory, std::string_view aChannel);
std::wstring LongPath(const std::wstring& aPath);
} // namespace convai::paths
