#include "Switches.hpp"

#include "Log.hpp"
#include "Paths.hpp"

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

std::string DecodeControlText(std::string_view aContent)
{
    // Windows PowerShell 5.1 writes UTF-16 with a byte order mark for ">" and Out-File, and a UTF-8 byte
    // order mark for "Set-Content -Encoding utf8"; Notepad offers both. Either one used to turn the first
    // name into three stray bytes plus "all" (or every character into two bytes), and the switch was silently ignored.
    const auto byteAt = [&](size_t i) { return static_cast<unsigned char>(aContent[i]); };
    if (aContent.size() >= 3 && byteAt(0) == 0xEF && byteAt(1) == 0xBB && byteAt(2) == 0xBF)
    {
        return std::string(aContent.substr(3));
    }
    bool utf16 = false;
    bool bigEndian = false;
    size_t start = 0;
    if (aContent.size() >= 2 && byteAt(0) == 0xFF && byteAt(1) == 0xFE)
    {
        utf16 = true;
        start = 2;
    }
    else if (aContent.size() >= 2 && byteAt(0) == 0xFE && byteAt(1) == 0xFF)
    {
        utf16 = true;
        bigEndian = true;
        start = 2;
    }
    else if (aContent.size() >= 4)
    {
        // No byte order mark: names are ASCII, so UTF-16 shows as a zero byte after (or before) every character.
        size_t zeroEven = 0;
        size_t zeroOdd = 0;
        const size_t pairs = std::min<size_t>(aContent.size() / 2, 64);
        for (size_t i = 0; i < pairs; ++i)
        {
            zeroEven += byteAt(2 * i) == 0 ? 1 : 0;
            zeroOdd += byteAt(2 * i + 1) == 0 ? 1 : 0;
        }
        if (zeroOdd * 2 > pairs && zeroEven == 0)
        {
            utf16 = true;
        }
        else if (zeroEven * 2 > pairs && zeroOdd == 0)
        {
            utf16 = true;
            bigEndian = true;
        }
    }
    if (!utf16)
    {
        return std::string(aContent);
    }
    std::wstring wide;
    wide.reserve((aContent.size() - start) / 2);
    for (size_t i = start; i + 1 < aContent.size(); i += 2)
    {
        const unsigned lo = byteAt(bigEndian ? i + 1 : i);
        const unsigned hi = byteAt(bigEndian ? i : i + 1);
        wide.push_back(static_cast<wchar_t>(lo | (hi << 8)));
    }
    return paths::WideToUtf8(wide);
}

void Switches::ParseFile(std::string_view aRawContent)
{
    const std::string decoded = DecodeControlText(aRawContent);
    const std::string_view aContent = decoded;
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
    // Mirror into the lock-free flags: every known slot is recomputed, named systems get a slot. A file full of
    // made-up names must not use up the slots a real trip needs, so the last eight are kept for trips.
    for (const std::string& name : m_off)
    {
        if (m_slotCount.load(std::memory_order_relaxed) < kSlots - 8)
        {
            SlotLocked(name, true);
        }
        else
        {
            SlotLocked(name, false);
        }
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
