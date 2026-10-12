#pragma once

#include <functional>
#include <string>
#include <utility>
#include <vector>

// The RTTI signature of one native, free of any RED4ext type so the headless tests can run the
// check. The plugin registers a system's natives all or none: before it creates a single function
// it asks CheckSignatures whether every parameter and return type exists in the game's RTTI.
// (RED4ext's AddParam and SetReturnType return false without a message when a type name is
// unknown, which leaves the function registered with a parameter missing.)

namespace convai
{
struct NativeSignature
{
    std::string name;
    std::string returnType; // empty: no return value
    std::vector<std::pair<std::string, std::string>> params; // type, name
};

using TypeExists = std::function<bool(const std::string&)>;

// Empty when every type resolves; else one line naming the first native and type that does not,
// for example: "Frame parameter 'ctl' has type array:Double, which this game's RTTI does not have".
std::string CheckSignatures(const std::vector<NativeSignature>& aNatives, const TypeExists& aTypeExists);
} // namespace convai
