#include "Switches.hpp"

#include "Log.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>

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
        CONVAI_INFO("Kill switches changed: all=%s, %zu named", allOff ? "off" : "on", off.size());
    }
    m_allOff = allOff;
    m_off = std::move(off);
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
