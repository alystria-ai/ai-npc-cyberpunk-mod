// ConvaiNativeIo: the bridge mailbox, lease and log files, off the game thread.
// Lua side: mod/native-core.lua routes io.open/os.rename/os.remove for whitelisted runtime files
// through these when the plugin is present and the "io" switch is on.

#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "core/FileIo.hpp"

#include <algorithm>
#include <cstring>
#include <source_location>

namespace
{
using namespace convai;

constinit rtti::StaticClass g_class("ConvaiNativeIo", "io");
constexpr const char* kSystem = "io";

std::string ToString(const RED4ext::CString& aText)
{
    return std::string(aText.c_str(), aText.Length());
}

// The handshake file proves where file IO writes (mod/native-core.lua writes, flushes and removes it before it knows
// whether "io" is on), so it works while the switch is off: switched off at startup, "io" would otherwise stay on Lua
// until the game restarts, whatever the file later says.
constexpr const char* kHandshakeChannel = "native-handshake.txt";

template<typename F, typename R>
R IoGuard(const RED4ext::CString& aChannel, F&& aBody, R aFallback,
          std::source_location aNative = std::source_location::current()) noexcept
{
    return std::strcmp(aChannel.c_str(), kHandshakeChannel) == 0 ? rtti::GuardAlways(kSystem, std::forward<F>(aBody), std::move(aFallback), aNative)
                                         : rtti::Guard(kSystem, std::forward<F>(aBody), std::move(aFallback), aNative);
}

void Write(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    RED4ext::CString channel;
    RED4ext::CString text;
    rtti::ReadArgs(aFrame, &channel, &text);
    rtti::Return(aOut, IoGuard(
                           channel, [&] { return GlobalFileIo().Write(ToString(channel), ToString(text)); },
                           false));
}

void Append(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    RED4ext::CString channel;
    RED4ext::CString text;
    rtti::ReadArgs(aFrame, &channel, &text);
    rtti::Return(aOut, rtti::Guard(
                           kSystem, [&] { return GlobalFileIo().Append(ToString(channel), ToString(text)); }, false));
}

void Remove(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    RED4ext::CString channel;
    rtti::ReadArgs(aFrame, &channel);
    rtti::Return(aOut, IoGuard(channel, [&] { return GlobalFileIo().Remove(ToString(channel)); }, false));
}

void Rename(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    RED4ext::CString from;
    RED4ext::CString to;
    rtti::ReadArgs(aFrame, &from, &to);
    rtti::Return(aOut, rtti::Guard(
                           kSystem, [&] { return GlobalFileIo().Rename(ToString(from), ToString(to)); }, false));
}

void Watch(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    RED4ext::CString channel;
    int32_t periodMs = 0;
    bool json = false;
    rtti::ReadArgs(aFrame, &channel, &periodMs, &json);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               return GlobalFileIo().Watch(ToString(channel),
                                                           static_cast<uint32_t>(std::max(periodMs, 0)), json);
                           },
                           false));
}

void Read(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    RED4ext::CString channel;
    rtti::ReadArgs(aFrame, &channel);
    rtti::Return(aOut, rtti::Guard(
                           kSystem, [&] { return GlobalFileIo().Read(ToString(channel)).content; }, std::string()));
}

void Revision(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    RED4ext::CString channel;
    rtti::ReadArgs(aFrame, &channel);
    rtti::Return(aOut, rtti::Guard(kSystem, [&] { return GlobalFileIo().Revision(ToString(channel)); }, 0));
}

// Flush also runs while "io" is off: Lua flushes the native queue when the switch turns off, before it writes the files
// itself, so an older queued write cannot land after a newer one.
void Flush(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    int32_t timeoutMs = 0;
    rtti::ReadArgs(aFrame, &timeoutMs);
    rtti::Return(aOut, rtti::GuardAlways(
                           kSystem,
                           [&] { return GlobalFileIo().Flush(static_cast<uint32_t>(std::clamp(timeoutMs, 0, 2000))); },
                           false));
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    g_class.Static("Write", &Write, "Bool", {{"String", "channel"}, {"String", "text"}});
    g_class.Static("Append", &Append, "Bool", {{"String", "channel"}, {"String", "text"}});
    g_class.Static("Remove", &Remove, "Bool", {{"String", "channel"}});
    g_class.Static("Rename", &Rename, "Bool", {{"String", "from"}, {"String", "to"}});
    g_class.Static("Watch", &Watch, "Bool", {{"String", "channel"}, {"Int32", "periodMs"}, {"Bool", "json"}});
    g_class.Static("Read", &Read, "String", {{"String", "channel"}});
    g_class.Static("Revision", &Revision, "Int32", {{"String", "channel"}});
    g_class.Static("Flush", &Flush, "Bool", {{"Int32", "timeoutMs"}});
}
} // namespace

CONVAI_SYSTEM(io, {
    .name = "io",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
