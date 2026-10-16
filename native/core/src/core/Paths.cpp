#include "Paths.hpp"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <vector>

namespace convai::paths
{
std::wstring Utf8ToWide(std::string_view aText)
{
    if (aText.empty())
    {
        return {};
    }
    const int length = MultiByteToWideChar(CP_UTF8, 0, aText.data(), static_cast<int>(aText.size()), nullptr, 0);
    if (length <= 0)
    {
        return {};
    }
    std::wstring wide(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, aText.data(), static_cast<int>(aText.size()), wide.data(), length);
    return wide;
}

std::string WideToUtf8(std::wstring_view aText)
{
    if (aText.empty())
    {
        return {};
    }
    const int length =
        WideCharToMultiByte(CP_UTF8, 0, aText.data(), static_cast<int>(aText.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0)
    {
        return {};
    }
    std::string narrow(static_cast<size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, aText.data(), static_cast<int>(aText.size()), narrow.data(), length, nullptr,
                        nullptr);
    return narrow;
}

bool IsValidChannel(std::string_view aChannel) noexcept
{
    if (aChannel.empty() || aChannel.size() > 96)
    {
        return false;
    }
    for (size_t i = 0; i < aChannel.size(); ++i)
    {
        const char c = aChannel[i];
        const bool alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
        if (i == 0 ? !alnum : !(alnum || c == '.' || c == '_' || c == '-'))
        {
            return false;
        }
    }
    return aChannel.find("..") == std::string_view::npos;
}

namespace
{
std::wstring ParentOf(const std::wstring& aPath)
{
    const size_t slash = aPath.find_last_of(L"\\/");
    return slash == std::wstring::npos ? std::wstring() : aPath.substr(0, slash);
}
} // namespace

std::wstring GameRootFromExecutable()
{
    std::vector<wchar_t> buffer(32768);
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size())
    {
        return {};
    }
    std::wstring path(buffer.data(), length);
    return ParentOf(ParentOf(ParentOf(path))); // exe -> x64 -> bin -> root
}

std::wstring ResolveRuntimeDirectory()
{
    wchar_t overrideBuffer[4096];
    const DWORD overrideLength = GetEnvironmentVariableW(L"CYBERPUNK_CONVAI_NATIVE_RUNTIME", overrideBuffer,
                                                         static_cast<DWORD>(std::size(overrideBuffer)));
    if (overrideLength > 0 && overrideLength < std::size(overrideBuffer))
    {
        return std::wstring(overrideBuffer, overrideLength);
    }
    const std::wstring root = GameRootFromExecutable();
    if (root.empty())
    {
        return {};
    }
    return root + L"\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\AiNpcCyberpunkMod\\runtime";
}

std::wstring LongPath(const std::wstring& aPath)
{
    if (aPath.size() < MAX_PATH - 12 || aPath.rfind(L"\\\\?\\", 0) == 0)
    {
        return aPath;
    }
    if (aPath.size() > 2 && aPath[1] == L':' && aPath[2] == L'\\')
    {
        return L"\\\\?\\" + aPath;
    }
    if (aPath.rfind(L"\\\\", 0) == 0)
    {
        return L"\\\\?\\UNC\\" + aPath.substr(2);
    }
    return aPath;
}

std::wstring Join(const std::wstring& aDirectory, std::string_view aChannel)
{
    return LongPath(aDirectory + L"\\" + Utf8ToWide(aChannel));
}
} // namespace convai::paths
