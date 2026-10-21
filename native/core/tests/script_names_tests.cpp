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

TEST(script_name_in_class_needs_the_exact_class_and_the_name)
{
    CHECK(ScriptNameInClass("NPCPuppet::IsInCombat;ScriptedPuppet", "NPCPuppet", "IsInCombat"));
    CHECK(ScriptNameInClass("NPCPuppet::IsInCombat", "NPCPuppet", "IsInCombat"));
    CHECK(ScriptNameInClass("NPCPuppet::IsPuppetInCombat;", "NPCPuppet", "IsPuppetInCombat"));
    CHECK(!ScriptNameInClass("ScriptedPuppet::IsInCombat;ScriptedPuppet", "NPCPuppet", "IsInCombat"));
    CHECK(!ScriptNameInClass("NPCPuppetX::IsInCombat", "NPCPuppet", "IsInCombat"));
    CHECK(!ScriptNameInClass("IsInCombat;ScriptedPuppet", "NPCPuppet", "IsInCombat")); // no class prefix
    CHECK(!ScriptNameInClass("NPCPuppet::IsInCombatWithTarget;ScriptedPuppetEntity", "NPCPuppet", "IsInCombat"));
    CHECK(!ScriptNameInClass("NPCPuppet::IsInComba", "NPCPuppet", "IsInCombat"));
    CHECK(!ScriptNameInClass(nullptr, "NPCPuppet", "IsInCombat"));
    CHECK(!ScriptNameInClass("NPCPuppet::IsInCombat", "", "IsInCombat"));
    CHECK(!ScriptNameInClass("NPCPuppet::IsInCombat", "NPCPuppet", nullptr));
}
