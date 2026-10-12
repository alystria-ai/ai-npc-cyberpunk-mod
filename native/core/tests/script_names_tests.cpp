// The names the game's script compiler gives functions: the plain name, with a parameter signature after
// a ';', or behind a class prefix. See core/ScriptNames.hpp.

#include "Test.hpp"

#include "core/ScriptNames.hpp"

using namespace convai;

TEST(script_name_matches_the_plain_name_and_the_compiler_signature_forms)
{
    CHECK(ScriptNameIs("IsInCombat", "IsInCombat"));
    CHECK(ScriptNameIs("IsInCombat;ScriptedPuppet", "IsInCombat")); // static NPCPuppet.IsInCombat(puppet)
    CHECK(ScriptNameIs("IsInCombat;", "IsInCombat"));               // PlayerPuppet's member
    CHECK(ScriptNameIs("GetPlayer;GameInstance", "GetPlayer"));
    CHECK(ScriptNameIs("NPCPuppet::IsInCombat;ScriptedPuppet", "IsInCombat"));
    CHECK(ScriptNameIs("NPCPuppet::IsInCombat", "IsInCombat"));
    CHECK(ScriptNameIs("RegisterToHUDManagerByTask;Bool", "RegisterToHUDManagerByTask"));
}

TEST(script_name_does_not_match_other_names)
{
    CHECK(!ScriptNameIs("IsInCombatWith", "IsInCombat"));
    CHECK(!ScriptNameIs("IsInCombatWith;GameObject", "IsInCombat"));
    CHECK(!ScriptNameIs("XIsInCombat", "IsInCombat"));
    CHECK(!ScriptNameIs("IsInComba", "IsInCombat"));
    CHECK(!ScriptNameIs("", "IsInCombat"));
    CHECK(!ScriptNameIs("Other;IsInCombat", "IsInCombat")); // the name is only the part before the signature
    CHECK(!ScriptNameIs("IsInCombat", ""));
    CHECK(!ScriptNameIs(nullptr, "IsInCombat"));
    CHECK(!ScriptNameIs("IsInCombat", nullptr));
}
