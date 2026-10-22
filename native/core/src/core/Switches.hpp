#pragma once

#include <atomic>
#include <cstddef>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

// Kill switches: which native systems the Lua side may use right now.
//
// Sources, any of which turns a system off:
//   1. runtime\native-off.txt, re-read by the IO worker about once a second. One system name per
//      line ("io", "knowledge", ...) or "all". '#' starts a comment. A missing file means all on.
//   2. A trip: a system that keeps failing (exceptions in its natives) turns itself off for the
//      rest of the session and says why in Status().
// The Lua shim asks SystemEnabled() at most every 0.5 s and falls back to its own path when false.

namespace convai
{
class Switches
{
public:
    void ParseFile(std::string_view aContent);
    void Trip(std::string_view aSystem, std::string_view aReason);

    bool Enabled(std::string_view aSystem) const;

    // The lock-free form of !Enabled() for the hot path (rtti::Guard asks it on every native call):
    // two atomic flags per system, set by ParseFile and Trip, so a switch that flips takes effect on
    // the very next call instead of after Lua's next 0.5 s read. "core" is never off: its natives
    // (CheckVersion, SystemEnabled, Status) are how Lua and the reports learn what the switches say.
    bool Off(const char* aSystem) const noexcept;

    // True when aSystem tripped (the file switches do not count). The reason is in DescribeJson().
    bool Tripped(std::string_view aSystem) const;

    // {"off":["io"],"tripped":{"gaze":"3 exceptions"}} - for Status().
    std::string DescribeJson() const;

private:
    // A fixed table so the flags can be read without the mutex. Slots are only ever added (under the
    // mutex, name written before the count is published) and never removed.
    static constexpr size_t kSlots = 32;
    struct Slot
    {
        char name[32] = {};
        std::atomic<bool> fileOff{false};
        std::atomic<bool> tripped{false};
    };
    Slot* SlotLocked(std::string_view aSystem, bool aCreate);

    mutable std::mutex m_mutex;
    Slot m_slots[kSlots];
    std::atomic<size_t> m_slotCount{0};
    std::atomic<bool> m_allOffFlag{false};
    bool m_allOff = false;
    std::vector<std::string> m_off;
    std::vector<std::pair<std::string, std::string>> m_tripped;
};

Switches& GlobalSwitches();

// JSON string escaping shared by the Status builders.
std::string JsonEscape(std::string_view aText);
} // namespace convai
