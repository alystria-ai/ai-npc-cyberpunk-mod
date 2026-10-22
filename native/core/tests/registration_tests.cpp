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

TEST(registration_accepts_faces_with_array_float)
{
    // The faces natives as FacesNatives.cpp records them: the control array and the speech vector are
    // array:Float, which this game has (it has no array:Double).
    const std::vector<NativeSignature> faces = {
        Native("Frame", "Int32",
               {{"handle:IScriptable", "actor"}, {"handle:IScriptable", "feature"}, {"Int32", "nid"},
                {"array:Float", "ctl"}, {"array:Float", "speech"}}),
        Native("Speaker", "Int32", {{"handle:IScriptable", "actor"}, {"String", "entity"}}),
        Native("Safe", "Int32", {{"handle:IScriptable", "actor"}}),
        Native("Turn", "String", {{"Int32", "nid"}}),
        Native("Applied", "String", {{"Int32", "nid"}}),
        Native("ZeroPose", "Bool", {{"Int32", "nid"}}),
        Native("NoteReset", "Bool", {{"Int32", "nid"}}),
        Native("Release", "Bool", {{"Int32", "nid"}}),
        Native("Clear", "Bool"),
        Native("Check", "Int32", {{"array:Float", "ctl"}, {"array:Float", "speech"}}),
        Native("Info", "String"),
    };
    CHECK_EQ(CheckSignatures(faces, GameTypes()), std::string());
}

TEST(registration_refuses_a_system_with_an_array_the_game_lacks)
{
    // A fake system (not faces) with an array:Double parameter: the game has no such type, and AddParam
    // drops the parameter without a message, so the whole system must be refused, naming the type.
    const std::vector<NativeSignature> fake = {
        Native("Ping", "Int32", {{"handle:IScriptable", "actor"}, {"String", "entity"}}),
        Native("Feed", "Int32", {{"handle:IScriptable", "actor"}, {"Int32", "nid"}, {"array:Double", "ctl"}}),
        Native("Info", "String"),
    };
    const std::string problem = CheckSignatures(fake, GameTypes());
    CHECK(!problem.empty());
    CHECK(problem.find("Feed") != std::string::npos);
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
    CHECK(!switches.Tripped("fake"));
    switches.Trip("fake", "natives not registered: Feed parameter 'ctl' has type array:Double");
    CHECK(switches.Tripped("fake"));
    CHECK(!switches.Enabled("fake"));
    CHECK(switches.Enabled("io"));
    CHECK(switches.Enabled("core"));
    CHECK(!switches.Tripped("io"));
    // The kill-switch file is not a trip, and a file with nothing in it does not clear a trip.
    switches.ParseFile("gaze");
    CHECK(!switches.Tripped("gaze"));
    CHECK(!switches.Enabled("gaze"));
    switches.ParseFile("");
    CHECK(switches.Tripped("fake"));
    CHECK(!switches.Enabled("fake"));
    CHECK(switches.DescribeJson().find("array:Double") != std::string::npos);
}

TEST(off_flags_follow_the_file_and_trips_at_once_and_never_cover_core)
{
    Switches switches;
    CHECK(!switches.Off("faces"));
    switches.ParseFile("faces\n");
    CHECK(switches.Off("faces"));
    CHECK(!switches.Off("vehicles"));
    switches.ParseFile("");
    CHECK(!switches.Off("faces"));
    switches.Trip("vehicles", "structured exception 0xC0000005 at x in y");
    CHECK(switches.Off("vehicles"));
    CHECK(!switches.Off("faces"));
    // "all" turns every system off but never core: its natives report what the switches say.
    switches.ParseFile("all");
    CHECK(switches.Off("faces"));
    CHECK(switches.Off("anything"));
    CHECK(!switches.Off("core"));
    switches.ParseFile("");
    CHECK(!switches.Off("faces"));
    CHECK(switches.Off("vehicles")); // a file with nothing in it does not clear a trip
}

TEST(control_files_parse_with_a_byte_order_mark_and_as_utf16)
{
    const auto utf16 = [](const std::string& aText, bool aBigEndian, bool aBom) {
        std::string out;
        if (aBom)
        {
            out += aBigEndian ? std::string("\xFE\xFF", 2) : std::string("\xFF\xFE", 2);
        }
        for (const char c : aText)
        {
            out += aBigEndian ? std::string(1, '\0') + c : c + std::string(1, '\0');
        }
        return out;
    };
    const std::string text = "# off for now\r\nFaces\r\nvehicles\r\n";
    const std::string utf8Bom = std::string("\xEF\xBB\xBF") + text;
    for (const std::string& content :
         {text, utf8Bom, utf16(text, false, true), utf16(text, true, true), utf16(text, false, false),
          utf16(text, true, false)})
    {
        Switches switches;
        switches.ParseFile(content);
        CHECK(switches.Off("faces"));
        CHECK(switches.Off("vehicles"));
        CHECK(!switches.Off("gaze"));
        CHECK(!switches.Enabled("faces"));
        CHECK(switches.Enabled("io"));
    }
    // "all" as the first line of a file with a byte order mark is the case that used to be ignored.
    Switches all;
    all.ParseFile(std::string("\xEF\xBB\xBF") + "all\r\n");
    CHECK(all.Off("faces"));
    CHECK_EQ(DecodeControlText(std::string("\xEF\xBB\xBF") + "all"), std::string("all"));
    // Plain text and an empty file pass through.
    CHECK_EQ(DecodeControlText("io\n"), std::string("io\n"));
    CHECK(DecodeControlText("").empty());
}
