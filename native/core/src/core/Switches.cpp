#include "Switches.hpp"

#include "Log.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>

namespace convai
{
namespace
{
std::string Trim(std::string_view aText)
{
    size_t start = 0;
    size_t end = aText.size();
    while (start < end && std::isspace(static_cast<unsigned char>(aText[start])))
    {
        ++start;
    }
    while (end > start && std::isspace(static_cast<unsigned char>(aText[end - 1])))
    {
        --end;
    }
    std::string out(aText.substr(start, end - start));
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}
} // namespace

void Switches::ParseFile(std::string_view aContent)
{
    bool allOff = false;
    std::vector<std::string> off;
    size_t position = 0;
    while (position <= aContent.size())
    {
        size_t end = aContent.find('\n', position);
        if (end == std::string_view::npos)
        {
            end = aContent.size();
        }
        std::string_view line = aContent.substr(position, end - position);
        const size_t hash = line.find('#');
        if (hash != std::string_view::npos)
        {
            line = line.substr(0, hash);
        }
        std::string name = Trim(line);
        if (!name.empty() && name.size() <= 64)
        {
            if (name == "all")
            {
                allOff = true;
            }
            else
            {
                off.push_back(std::move(name));
            }
        }
        position = end + 1;
    }

    std::lock_guard<std::mutex> lock(m_mutex);
    if (allOff != m_allOff || off != m_off)
    {
        std::string names;
        for (const std::string& name : off)
        {
            names += (names.empty() ? "" : ", ") + name;
        }
        CONVAI_INFO("Kill switches changed: all=%s, %zu named (%s)", allOff ? "off" : "on", off.size(),
                    names.c_str());
    }
    m_allOff = allOff;
    m_off = std::move(off);
    // Mirror into the lock-free flags: every known slot is recomputed, named systems get a slot.
    for (const std::string& name : m_off)
    {
        SlotLocked(name, true);
    }
    const size_t count = m_slotCount.load(std::memory_order_relaxed);
    for (size_t i = 0; i < count; ++i)
    {
        const bool named = std::find(m_off.begin(), m_off.end(), std::string_view(m_slots[i].name)) != m_off.end();
        m_slots[i].fileOff.store(named, std::memory_order_release);
    }
    m_allOffFlag.store(allOff, std::memory_order_release);
}

Switches::Slot* Switches::SlotLocked(std::string_view aSystem, bool aCreate)
{
    const size_t count = m_slotCount.load(std::memory_order_relaxed);
    for (size_t i = 0; i < count; ++i)
    {
        if (aSystem == m_slots[i].name)
        {
            return &m_slots[i];
        }
    }
    if (!aCreate || count >= kSlots || aSystem.empty() || aSystem.size() >= sizeof(Slot::name))
    {
        return nullptr;
    }
    std::memcpy(m_slots[count].name, aSystem.data(), aSystem.size());
    m_slots[count].name[aSystem.size()] = '\0';
    m_slotCount.store(count + 1, std::memory_order_release);
    return &m_slots[count];
}

bool Switches::Off(const char* aSystem) const noexcept
{
    if (!aSystem || std::strcmp(aSystem, "core") == 0)
    {
        return false;
    }
    if (m_allOffFlag.load(std::memory_order_acquire))
    {
        return true;
    }
    const size_t count = m_slotCount.load(std::memory_order_acquire);
    for (size_t i = 0; i < count; ++i)
    {
        if (std::strcmp(aSystem, m_slots[i].name) == 0)
        {
            return m_slots[i].fileOff.load(std::memory_order_acquire) ||
                   m_slots[i].tripped.load(std::memory_order_acquire);
        }
    }
    return false;
}

void Switches::Trip(std::string_view aSystem, std::string_view aReason)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    for (const auto& [name, reason] : m_tripped)
    {
        if (name == aSystem)
        {
            return;
        }
    }
    m_tripped.emplace_back(std::string(aSystem), std::string(aReason));
    if (Slot* slot = SlotLocked(aSystem, true))
    {
        slot->tripped.store(true, std::memory_order_release);
    }
    CONVAI_ERROR("System '%.*s' turned itself off: %.*s", static_cast<int>(aSystem.size()), aSystem.data(),
                 static_cast<int>(aReason.size()), aReason.data());
}

bool Switches::Enabled(std::string_view aSystem) const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_allOff)
    {
        return false;
    }
    for (const auto& name : m_off)
    {
        if (name == aSystem)
        {
            return false;
        }
    }
    for (const auto& [name, reason] : m_tripped)
    {
        if (name == aSystem)
        {
            return false;
        }
    }
    return true;
}

bool Switches::Tripped(std::string_view aSystem) const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    for (const auto& [name, reason] : m_tripped)
    {
        if (name == aSystem)
        {
            return true;
        }
    }
    return false;
}

std::string Switches::DescribeJson() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    std::string out = "{\"allOff\":";
    out += m_allOff ? "true" : "false";
    out += ",\"off\":[";
    for (size_t i = 0; i < m_off.size(); ++i)
    {
        out += (i ? ",\"" : "\"") + JsonEscape(m_off[i]) + "\"";
    }
    out += "],\"tripped\":{";
    for (size_t i = 0; i < m_tripped.size(); ++i)
    {
        out += (i ? ",\"" : "\"") + JsonEscape(m_tripped[i].first) + "\":\"" + JsonEscape(m_tripped[i].second) + "\"";
    }
    out += "}}";
    return out;
}

Switches& GlobalSwitches()
{
    static Switches switches;
    return switches;
}

std::string JsonEscape(std::string_view aText)
{
    std::string out;
    out.reserve(aText.size() + 8);
    for (const char c : aText)
    {
        switch (c)
        {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            if (static_cast<unsigned char>(c) < 0x20)
            {
                char escaped[8];
                std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(c));
                out += escaped;
            }
            else
            {
                out += c;
            }
        }
    }
    return out;
}
} // namespace convai
