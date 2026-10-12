#include "Rtti.hpp"

#include <mutex>
#include <string>
#include <unordered_map>

namespace convai::rtti
{
void NoteFault(const char* aSystem, const char* aWhat) noexcept
{
    try
    {
        static std::mutex mutex;
        static std::unordered_map<std::string, int> faults;
        int count = 0;
        {
            std::lock_guard<std::mutex> lock(mutex);
            count = ++faults[aSystem ? aSystem : "?"];
        }
        CONVAI_ERROR("Native fault in %s (%d): %s", aSystem ? aSystem : "?", count, aWhat ? aWhat : "");
        if (count >= 3)
        {
            GlobalSwitches().Trip(aSystem ? aSystem : "?", "3 faults in its natives");
        }
    }
    catch (...)
    {
    }
}
} // namespace convai::rtti
