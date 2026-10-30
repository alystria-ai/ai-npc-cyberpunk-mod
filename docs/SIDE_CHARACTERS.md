# Side characters to invite

The 575 minor characters of the cast sweep (`docs/CAST_SWEEP.md`) can be invited. The Companion Manager home page has two lists:

* **Main characters to invite**: the list that was called Characters to invite (the shipped story cast and the player's own characters).
* **Side characters to invite**: the everyday people of Night City, from shopkeepers to fixers. An invited side character is our own copy with
  the full systems, like the main cast. The game's own placed copy of the same person is unchanged (talk plus face and audio only).

## Which are invitable

`scripts/cast-sweep/invite-check.py` looks every minor row's first record (the one the Companion Manager spawns) up in the TweakDB of game 2.5
and of the game 2.31 copy, base and Phantom Liberty (`tweakdb.bin`, `tweakdb_ep1.bin`, by CRC32 plus name length), checks the entity template
flat, and reads the game's own `isChild` flag through the parent chain. Its result is `scripts/cast-sweep/side-invite-records.json`.
`scripts/cast-sweep/side-invite.mjs` turns that into `invite: true` or `false` in `characters/roster.json` (`--check` verifies), then
`node scripts/Build-GameRoster.mjs` rebuilds `characters/game-roster.json`.

Result: **557 of 575 are invitable**, and every record is in both game versions. 109 of them are Phantom Liberty bodies (record in
`tweakdb_ep1.bin`): without the expansion the game has no such record and the row reads Profile only. The 18 left out are all children or
possible children: 14 carry the game's `isChild` flag (arabelle-luvasha, brandon-soto, dorian, dorothy-allred, eric, jaime, jason-foreman,
john-crimi, luka-soto, maurice, percival-wemys-madison, piggy, sarah-balbo, simon), and 4 have a card that says kid, daughter or oldest son
without a flag (doris-soto, marcus-barros, sofia-ramirez, randy-kutcher). The mod's talk and companion rules already refuse children.

## The page

`mod/manager-ui.lua` `M.sideRows`, view `side`, built on demand when the page opens, never per frame:

* The list is `snapshot.side` (`mod/manager.lua` `sideProfiles`): the minor profiles with `invite ~= false`, in name order, worked out once for
  the loaded roster (`M.configure` drops the cache).
* **Search** works like the main list and searches all 557 whatever the letter group: case and accents are ignored and every typed word has to be
  the start of a word of the name (or key), the rule of the phone's Chat search. A **Search characters** section sits above the list in
  both hosts. **Search by name** opens the mod's own text box (titled "Search characters", Enter applies, Esc cancels, an empty Enter shows all). In Mod Configuration
  Menu a second row points at its own Search box (top right, dim until it is clicked), which keeps working. Once a search is on the section reads "search: pan · 2 found"
  with **Clear search**, and the title of the list says the same.
* **Starts with** groups by the first letter of the name (the Model browser's control). The roster holds no district or faction field, only a
  free-text summary, so the letter is the one reliable group. The groups are worked out the first time the page is built for a list and held.
* **Paging**: twelve rows a page (`PAGE_SIZE`), the same page control as the other long lists. A page build reads twelve rows, never all 557.
* Each row is `Invite` or `Add copy (n)` with the same description as the main list, and the party queue, notices and chauffeur status follow.
* There is no Favorites block here (favorites belong to the main list and the Model browser).
* The MCM host and the search box take the `side` view like `characters` (`mod/mcm-host.lua`).

## Voice

The fallback archetype voice of `characters/cast-sweep-voices.json`. A separate job replaces them with clips built from the game files.

## Convai

Each invitable side character has a Convai original and a multilingual twin, created with the cast expansion recipe
(`docs/CAST_EXPANSION_RECIPE.md` step 9): `node scripts/cast-sweep/provision-batches.mjs [--apply] [--size 40]` runs
`Provision-Characters.mjs` and `Create-MultilingualProfiles.mjs` per batch of keys. It skips what exists and stops at the first failed batch, so
running it again resumes. Ids land in `runtime/characters.json` and `runtime/multilingual-profiles.json`. `node packaging/Refresh-ReleaseData.mjs`
copies them to `packaging/release-data/`, which the package installs. A twin is used by the router only once its language box is off
(`languageBoxOff: true`, a signed-in dashboard step, `docs/MULTILINGUAL_PROFILES.md`), and until then the original answers every language.
