#include "Test.hpp"

#include "core/Log.hpp"
#include "core/Paths.hpp"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstring>
#include <filesystem>

namespace convai::test
{
namespace
{
int g_failures = 0;
const char* g_current = "";
} // namespace

std::vector<Case>& Cases()
{
    static std::vector<Case> cases;
    return cases;
}

void Fail(const char* aFile, int aLine, const std::string& aMessage)
{
    ++g_failures;
    std::printf("  FAIL %s (%s:%d): %s\n", g_current, aFile, aLine, aMessage.c_str());
}

TempDir::TempDir()
{
    wchar_t base[MAX_PATH];
    GetTempPathW(MAX_PATH, base);
    static int counter = 0;
    path = std::wstring(base) + L"convai-native-test-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
           std::to_wstring(++counter);
    std::filesystem::create_directories(path);
}

TempDir::~TempDir()
{
    std::error_code ignored;
    std::filesystem::remove_all(path, ignored);
}

void WriteRaw(const std::wstring& aPath, const std::string& aData)
{
    HANDLE file = CreateFileW(aPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
    {
        return;
    }
    DWORD wrote = 0;
    WriteFile(file, aData.data(), static_cast<DWORD>(aData.size()), &wrote, nullptr);
    CloseHandle(file);
}

std::string ReadRaw(const std::wstring& aPath, bool* aExists)
{
    HANDLE file = CreateFileW(aPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (aExists)
    {
        *aExists = file != INVALID_HANDLE_VALUE;
    }
    if (file == INVALID_HANDLE_VALUE)
    {
        return {};
    }
    std::string out;
    char buffer[65536];
    DWORD got = 0;
    while (ReadFile(file, buffer, sizeof(buffer), &got, nullptr) && got > 0)
    {
        out.append(buffer, got);
    }
    CloseHandle(file);
    return out;
}

void SleepMs(unsigned aMs)
{
    Sleep(aMs);
}
} // namespace convai::test

int main(int argc, char** argv)
{
    using namespace convai::test;
    convai::log::SetSink([](convai::log::Level aLevel, const char* aMessage) {
        if (aLevel != convai::log::Level::Info)
        {
            std::printf("    [log] %s\n", aMessage);
        }
    });
    const char* filter = argc > 1 ? argv[1] : nullptr;
    int run = 0;
    for (const Case& test : Cases())
    {
        if (filter && !std::strstr(test.name, filter))
        {
            continue;
        }
        g_current = test.name;
        const int before = g_failures;
        std::printf("%s\n", test.name);
        test.body();
        std::printf("  %s\n", g_failures == before ? "ok" : "FAILED");
        ++run;
    }
    std::printf("\n%d tests, %d failures\n", run, g_failures);
    return g_failures == 0 && run > 0 ? 0 : 1;
}
