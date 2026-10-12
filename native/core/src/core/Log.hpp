#pragma once

#include <string>

// Plugin-wide logging. The core library has no RED4ext dependency, so the plugin installs a sink
// that forwards to RED4ext's logger (red4ext/logs/), and the headless tests install one that
// prints. Every call is safe from any thread and never throws.

namespace convai::log
{
enum class Level
{
    Info,
    Warn,
    Error
};

using Sink = void (*)(Level aLevel, const char* aMessage);

void SetSink(Sink aSink) noexcept;
void Write(Level aLevel, const char* aFormat, ...) noexcept;

// The last warning or error, for Status(). Empty when nothing went wrong.
std::string LastProblem();

#define CONVAI_INFO(...) ::convai::log::Write(::convai::log::Level::Info, __VA_ARGS__)
#define CONVAI_WARN(...) ::convai::log::Write(::convai::log::Level::Warn, __VA_ARGS__)
#define CONVAI_ERROR(...) ::convai::log::Write(::convai::log::Level::Error, __VA_ARGS__)
} // namespace convai::log
