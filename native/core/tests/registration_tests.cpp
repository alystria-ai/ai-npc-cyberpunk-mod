// The all-or-nothing registration check (core/Signatures.hpp) and the trip it relies on. The RTTI
// side (rtti::StaticClass::Commit) needs the game and is not run here; what decides whether a
// system registers is this pure check plus Switches, so both are covered without loading the DLL.

#include "Test.hpp"

#include "core/Signatures.hpp"
#include "core/Switches.hpp"

#include <set>

using namespace convai;

namespace
{
// The types this game's RTTI has for the plugin's natives: the engine fundamentals, the class
// handles the systems use, and arrays of Float, Int32, String and Bool, but not array:Double (the
// game creates an array type only when it or a script needs it; the exe has no array:Double).
TypeExists GameTypes()
{
    static const std::set<std::string> known = {"Bool",           "Int32",          "Uint32",
                                                "Float",          "Double",         "String",
                                                "CName",          "handle:gameObject",
                                                "handle:AICommand", "handle:IScriptable",
                                                "array:Float",    "array:Int32",    "array:String",
                                                "array:Bool"};
    return [](const std::string& aType) { return known.count(aType) != 0; };
}

NativeSignature Native(const char* aName, const char* aReturn,
                       std::vector<std::pair<std::string, std::string>> aParams = {})
{
    NativeSignature native;
    native.name = aName;
    native.returnType = aReturn;
    native.params = std::move(aParams);
    return native;
}
} // namespace

TEST(registration_accepts_a_system_whose_types_all_exist)
{
    const std::vector<NativeSignature> actuator = {
        Native("Capabilities", "Int32"),
        Native("Life", "Int32", {{"handle:gameObject", "npc"}}),
        Native("Sense", "String",
               {{"handle:gameObject", "npc"}, {"handle:AICommand", "command"}, {"Bool", "hasPrevious"},
                {"Double", "previousX"}}),
    };
    CHECK_EQ(CheckSignatures(actuator, GameTypes()), std::string());
    CHECK_EQ(CheckSignatures({}, GameTypes()), std::string());
}

TEST(registration_refuses_faces_for_array_double)
{
    // Frame and Check take array:Double (the game clock and the speech vector). The game has no such
    // type, and AddParam drops the parameter without a message, so the whole system must be refused.
    const std::vector<NativeSignature> faces = {
        Native("Speaker", "Int32", {{"handle:IScriptable", "actor"}, {"String", "entity"}}),
        Native("Frame", "Int32",
               {{"handle:IScriptable", "actor"}, {"Int32", "nid"}, {"array:Double", "ctl"}}),
        Native("Info", "String"),
    };
    const std::string problem = CheckSignatures(faces, GameTypes());
    CHECK(!problem.empty());
    CHECK(problem.find("Frame") != std::string::npos);
    CHECK(problem.find("'ctl'") != std::string::npos);
    CHECK(problem.find("array:Double") != std::string::npos);
}

TEST(registration_refuses_an_unknown_return_type_and_malformed_natives)
{
    CHECK(!CheckSignatures({Native("Fetch", "array:Double")}, GameTypes()).empty());
    CHECK(!CheckSignatures({Native("Bad", "Int32", {{"", "x"}})}, GameTypes()).empty());
    CHECK(!CheckSignatures({Native("", "Int32")}, GameTypes()).empty());
    CHECK(!CheckSignatures({Native("Ok", "Int32")}, TypeExists{}).empty());
    // A native without a return value is fine.
    CHECK_EQ(CheckSignatures({Native("Fire", "")}, GameTypes()), std::string());
}

TEST(registration_failure_trips_the_system_and_keeps_the_others)
{
    Switches switches;
    CHECK(!switches.Tripped("faces"));
    switches.Trip("faces", "natives not registered: Frame parameter 'ctl' has type array:Double");
    CHECK(switches.Tripped("faces"));
    CHECK(!switches.Enabled("faces"));
    CHECK(switches.Enabled("io"));
    CHECK(switches.Enabled("core"));
    CHECK(!switches.Tripped("io"));
    // The kill-switch file is not a trip, and a file with nothing in it does not clear a trip.
    switches.ParseFile("gaze");
    CHECK(!switches.Tripped("gaze"));
    CHECK(!switches.Enabled("gaze"));
    switches.ParseFile("");
    CHECK(switches.Tripped("faces"));
    CHECK(!switches.Enabled("faces"));
    CHECK(switches.DescribeJson().find("array:Double") != std::string::npos);
}
