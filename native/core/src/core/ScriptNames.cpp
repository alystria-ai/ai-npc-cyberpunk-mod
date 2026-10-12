#include "core/ScriptNames.hpp"

#include <cstring>

namespace convai
{
bool ScriptNameIs(const char* aText, const char* aName)
{
    if (!aText || !aName || !*aName)
    {
        return false;
    }
    const char* signature = std::strchr(aText, ';');
    const char* scope = std::strstr(aText, "::");
    if (scope && (!signature || scope < signature))
    {
        aText = scope + 2;
    }
    const size_t length = std::strlen(aName);
    return std::strncmp(aText, aName, length) == 0 && (aText[length] == 0 || aText[length] == ';');
}
} // namespace convai
