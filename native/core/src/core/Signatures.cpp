#include "core/Signatures.hpp"

namespace convai
{
std::string CheckSignatures(const std::vector<NativeSignature>& aNatives, const TypeExists& aTypeExists)
{
    if (!aTypeExists)
    {
        return "no type resolver";
    }
    for (const NativeSignature& native : aNatives)
    {
        if (native.name.empty())
        {
            return "a native has no name";
        }
        if (!native.returnType.empty() && !aTypeExists(native.returnType))
        {
            return native.name + " returns " + native.returnType + ", which this game's RTTI does not have";
        }
        for (const auto& param : native.params)
        {
            if (param.first.empty() || !aTypeExists(param.first))
            {
                return native.name + " parameter '" + param.second + "' has type " +
                       (param.first.empty() ? std::string("(none)") : param.first) +
                       ", which this game's RTTI does not have";
            }
        }
    }
    return {};
}
} // namespace convai
