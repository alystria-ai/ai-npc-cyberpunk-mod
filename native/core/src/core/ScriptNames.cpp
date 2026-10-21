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

bool ScriptNameInClass(const char* aText, const char* aClass, const char* aName)
{
    if (!aText || !aClass || !*aClass || !aName || !*aName)
    {
        return false;
    }
    const size_t classLength = std::strlen(aClass);
    if (std::strncmp(aText, aClass, classLength) != 0 || std::strncmp(aText + classLength, "::", 2) != 0)
    {
        return false;
    }
    const char* rest = aText + classLength + 2;
    const size_t nameLength = std::strlen(aName);
    return std::strncmp(rest, aName, nameLength) == 0 && (rest[nameLength] == 0 || rest[nameLength] == ';');
}
} // namespace convai
