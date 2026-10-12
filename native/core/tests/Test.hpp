#pragma once

// A tiny test harness: no third-party framework to vendor. Each tests/<system>_tests.cpp adds
// TEST(name) { ... } blocks; CMake globs them into convai_core_tests.
//
//   TEST(io_write_through) { CHECK(io.Write("a.json", "{}")); CHECK_EQ(io.Read("a.json").content, "{}"); }
//
// Run: convai_core_tests [substring]  (only tests whose name contains the substring)

#include <cstdio>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

namespace convai::test
{
struct Case
{
    const char* name;
    void (*body)();
};

std::vector<Case>& Cases();
void Fail(const char* aFile, int aLine, const std::string& aMessage);

struct Registrar
{
    Registrar(const char* aName, void (*aBody)())
    {
        Cases().push_back({aName, aBody});
    }
};

template<typename A, typename B>
std::string Describe(const A& aLeft, const B& aRight)
{
    std::ostringstream out;
    out << "'" << aLeft << "' != '" << aRight << "'";
    return out.str();
}

// A scratch folder under %TEMP%, removed when the scope ends.
struct TempDir
{
    TempDir();
    ~TempDir();
    std::wstring path;
};

void WriteRaw(const std::wstring& aPath, const std::string& aData);
std::string ReadRaw(const std::wstring& aPath, bool* aExists = nullptr);
void SleepMs(unsigned aMs);
} // namespace convai::test

#define TEST(name)                                                                                                     \
    static void name();                                                                                                \
    static ::convai::test::Registrar name##_registrar(#name, &name);                                                   \
    static void name()

#define CHECK(expr)                                                                                                    \
    do                                                                                                                 \
    {                                                                                                                  \
        if (!(expr))                                                                                                   \
            ::convai::test::Fail(__FILE__, __LINE__, "CHECK(" #expr ")");                                              \
    } while (0)

#define CHECK_EQ(a, b)                                                                                                 \
    do                                                                                                                 \
    {                                                                                                                  \
        const auto& checkLeft = (a);                                                                                   \
        const auto& checkRight = (b);                                                                                  \
        if (!(checkLeft == checkRight))                                                                                \
            ::convai::test::Fail(__FILE__, __LINE__,                                                                   \
                                 "CHECK_EQ(" #a ", " #b "): " + ::convai::test::Describe(checkLeft, checkRight));     \
    } while (0)
