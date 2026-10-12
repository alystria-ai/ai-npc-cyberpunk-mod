#include "Log.hpp"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <mutex>

namespace convai::log
{
namespace
{
std::atomic<Sink> g_sink{nullptr};
std::mutex g_problemMutex;
std::string g_lastProblem;
} // namespace

void SetSink(Sink aSink) noexcept
{
    g_sink.store(aSink);
}

void Write(Level aLevel, const char* aFormat, ...) noexcept
{
    char text[1024];
    va_list args;
    va_start(args, aFormat);
    const int written = std::vsnprintf(text, sizeof(text), aFormat, args);
    va_end(args);
    if (written < 0)
    {
        return;
    }

    if (aLevel != Level::Info)
    {
        try
        {
            std::lock_guard<std::mutex> lock(g_problemMutex);
            g_lastProblem = text;
        }
        catch (...)
        {
        }
    }

    if (const Sink sink = g_sink.load())
    {
        sink(aLevel, text);
    }
}

std::string LastProblem()
{
    std::lock_guard<std::mutex> lock(g_problemMutex);
    return g_lastProblem;
}
} // namespace convai::log
