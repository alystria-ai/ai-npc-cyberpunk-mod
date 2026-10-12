#pragma once

// Wire text comparison for the parity tests. The Lua recorders run under fengari, whose
// string.format('%.17g') prints the shortest text that reads back exactly (0.1, 1e-12), while the
// plugin prints C's %.17g (0.10000000000000001). Both are the same double, which is all the Lua
// shims need (they read with tonumber), so tokens are equal when they are the same text or parse
// to the same double. Every other token (flags, ids, words like nan and inf) must match exactly.

#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

namespace convai::test
{
inline std::vector<std::string> WireTokens(const std::string& aText)
{
    std::vector<std::string> tokens;
    std::string current;
    for (const char c : aText)
    {
        if (c == ' ')
        {
            tokens.push_back(current);
            current.clear();
        }
        else
        {
            current += c;
        }
    }
    tokens.push_back(current);
    return tokens;
}

inline bool SameToken(const std::string& aLeft, const std::string& aRight)
{
    if (aLeft == aRight)
    {
        return true;
    }
    char* leftEnd = nullptr;
    char* rightEnd = nullptr;
    const double left = std::strtod(aLeft.c_str(), &leftEnd);
    const double right = std::strtod(aRight.c_str(), &rightEnd);
    if (aLeft.empty() || aRight.empty() || *leftEnd != '\0' || *rightEnd != '\0')
    {
        return false;
    }
    // strtod also reads "nan" and "inf": those only match as identical text, handled above.
    return std::isfinite(left) && std::isfinite(right) && left == right;
}

inline bool SameWire(const std::string& aLeft, const std::string& aRight)
{
    const auto left = WireTokens(aLeft);
    const auto right = WireTokens(aRight);
    if (left.size() != right.size())
    {
        return false;
    }
    for (size_t index = 0; index < left.size(); ++index)
    {
        if (!SameToken(left[index], right[index]))
        {
            return false;
        }
    }
    return true;
}
} // namespace convai::test

// CHECK_WIRE(actual, expected): equal wire text, numbers compared as doubles.
#define CHECK_WIRE(actual, expected)                                                                                   \
    do                                                                                                                 \
    {                                                                                                                  \
        const std::string wireActual = (actual);                                                                       \
        const std::string wireExpected = (expected);                                                                   \
        if (!::convai::test::SameWire(wireActual, wireExpected))                                                       \
            ::convai::test::Fail(__FILE__, __LINE__,                                                                   \
                                 "CHECK_WIRE(" #actual ", " #expected "): " + ::convai::test::Describe(wireActual, wireExpected)); \
    } while (0)
