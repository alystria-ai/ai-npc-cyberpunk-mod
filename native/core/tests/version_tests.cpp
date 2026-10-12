// The game-version guard in Load(): RED4ext reports 2.31 as SemVer 2.3.1.

#include "Test.hpp"

#include "core/Version.hpp"

using namespace convai;

TEST(version_semver_maps_to_cd_projekt_versions)
{
    const GameVersion current = GameVersionFromSemVer(2, 3, 1);
    CHECK_EQ(current.major, 2);
    CHECK_EQ(current.minor, 31);
    CHECK_EQ(GameVersionFromSemVer(1, 0, 3).minor, 3);   // 1.03
    CHECK_EQ(GameVersionFromSemVer(1, 1, 0).minor, 10);  // 1.10
    CHECK_EQ(GameVersionFromSemVer(2, 0, 1).minor, 1);   // 2.01
    CHECK_EQ(GameVersionFromSemVer(2, 3, 0).minor, 30);  // 2.30
}

TEST(version_only_2_31_is_supported)
{
    CHECK(IsSupportedGame(GameVersionFromSemVer(2, 3, 1)));
    CHECK(!IsSupportedGame(GameVersionFromSemVer(2, 3, 0)));  // 2.30
    CHECK(!IsSupportedGame(GameVersionFromSemVer(2, 3, 2)));  // a later patch
    CHECK(!IsSupportedGame(GameVersionFromSemVer(2, 31, 0))); // never a two-digit SemVer minor
    CHECK(!IsSupportedGame(GameVersionFromSemVer(3, 1, 0)));
    CHECK(!IsSupportedGame(GameVersion{}));
    CHECK_EQ(GameVersionFromSemVer(2, 3, 10).major, -1);
    CHECK_EQ(GameVersionFromSemVer(-1, 3, 1).major, -1);
}
