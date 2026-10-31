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
* **Favorites** work as on the main list (`docs/MANAGER_UI.md`, "Favorites"): once a side character is in the party her row is Add to favorites with Add copy under it, and a Favorites block sits above the list on page 1 (her Invite / Add copy row and Remove from favorites), narrowed by the search and the Starts with group like the list. They are the same favorites as the main list (`runtime/favorites.json`, scope `characters`), so the phone's Chat tab lists them first too. The block is built from the favorite keys and a position index held with the letter groups, never by walking the 557.
* The MCM host and the search box take the `side` view like `characters` (`mod/mcm-host.lua`).

## Who the copy is

Reported on Discord on 31 Oct: a player picked one named side character and got another look of that record. Root cause: the Companion Manager spawned `records[1]` with no appearance name. A record whose entity template lists many looks, or defaults to `random`, then gets a different look at every spawn, so the chosen person was a stranger of the same kind. A copy remade after a fast travel had no look to be remade in either.

Every spawn now asks for the character's own look. `mod/companions.lua` `ownLook` takes the first hit of:

1. the roster row's `appearanceName` (`characters/roster.json`, also in `game-roster.json`, passed through `mod/manager.lua` `definitionFor`),
2. the base look of the curated outfit table (`mod/companion-outfits-data.lua`), whatever the outfit setting says,
3. the look the last copy of that record was seen in, kept in `runtime/spawn-looks.json`. It is read once, and written once per new person when the copy attaches (`learnLook` reads `GetCurrentAppearanceName` once). The same value is kept on the copy, so a fast travel remakes the same person.

A look from the outfit module, a world character's adopted look, a fast travel receipt and the spawn record of Kerry and Johnny all still come first. Nothing runs per frame.

With Developer mode on, the `Companion spawn:` line of every spawn (see "A record with no visible body" below) says which look was asked for and where it came from: `look asked for <name> (roster|curated|remembered|outfit|adopted original|returning|spawn record|look that made the body show)`, or `none (the template default) (the game picks)` for a first copy of an unknown person. When the game's pick is read back and kept, one more line says `Companion look: record ... was given ... by the game, kept for the next copy`. The look that made a body show in the body check (`rememberLook`) comes before the others, the body check compares against the look now asked for, and a look repaired by it replaces the remembered one. A record with no visible body forgets its remembered look.

### Where the names come from

The repo holds no game appearance lists for the side cast (no tweakdb appearance names, no extracted templates). Only the 19 records of the outfit table are proven against the installed game (`characters/companion-outfit-evidence.json`), and `node scripts/cast-sweep/spawn-looks.mjs` writes their base look into the roster rows (`--check` verifies, `--report` counts the rest), then `node scripts/Build-GameRoster.mjs`. Result of 31 Oct: 19 rows have a name. **663 invitable rows still have none** (557 side characters and 106 of the shipped cast, `--report` lists the keys). Those rows are pinned at runtime by the learned look (step 3): the first copy shows whatever the game picks, and from then on that record is always that person. To remove even the first pick, add `appearanceName` to the row with a name the record's own template lists (WolvenKit, as `scripts/Extract-CompanionOutfitEvidence.mjs` does for the outfit table) and rerun the two scripts.

## A record with no visible body

Owner live test of 31 Oct 2026 (game 2.5): Aiko Harada (`aiko-harada`, records `Character.q307_fia_reception` and `Character.q307_nurse`, both Phantom Liberty quest records) came out with no body to see.

What the code does, in `mod/companions.lua` and `mod/companion-records.lua`. A copy is created from one record with `DynamicEntitySystem:CreateEntity`, and the look is whatever the template gives when the spawn asks for none (`spec.appearanceName` stays empty unless an outfit, an adoption or a private spawn record decides one). The invite check in `scripts/cast-sweep/invite-check.py` only proves the record and its `entityTemplatePath` flat exist. It does not prove the record resolves a look outside its quest, and before this change only the first record of a profile was ever tried (`mod/manager.lua` `definitionFor`).

What is not known without the game: why this record gives no mesh. The likely causes are a template whose default look is a placeholder of the quest scene (so no look is resolved outside the quest), a body controlled by the quest streaming (`gamePhantomEntityComponent`, which `mod/companion-appearance.lua` already switches off), or a record that needs its quest world. Only a log from the game can tell them apart, so the code does not guess. It looks, repairs what it can and falls back safely.

What happens now:

* **Spawn log (Developer mode only).** Every spawn writes one `probe.log` line: `Companion spawn: <name> (<key>) record <record> (<n> of <m>), spawn record <private clone or the record itself>, look asked for <name or none (the template default)>, the record names <its own appearanceName flat or none>`. A report of the next invisible character needs this line and the `Companion body:` lines below.
* **Order of records.** A profile with several records is now registered with all of them (`records` in the definition). A copy is made from the first one that the game has and that this session has not seen without a body. A roster row can list `badRecords`: those go to the end of the order (they are still tried when nothing else is left, so a character is never left with no record). `badRecords` is carried into `characters/game-roster.json` by `scripts/Build-GameRoster.mjs`. Nothing is marked in the data yet, because no record is proven bad.
* **Body check.** Two seconds after a fresh copy attaches, the code reads her components (`entMeshComponent`, `entSkinnedMeshComponent`, enabled or not). A mesh shown means a body, and the check ends. No components at all means nothing to judge by, and the check ends with no action. No mesh shown gets one more look three seconds later, because the look may still be loading.
* **Repair.** If there is still no mesh and the record names a look of its own (its `appearanceName` flat) that she does not wear, that look is applied once with `ScheduleAppearanceChange`. If a mesh shows afterwards the look is remembered for the session and the next copy of that record asks for it from the start.
* **Fallback.** If there is still no mesh, the record is set aside for the session. When the profile has another record the game has, the bodyless copy is dismissed and the character is invited again through the same doors as the phone's Invite (`companions.onBodyMissing` in `mod/init.lua`: an immersive appointment when that setting is on, else the party queue), and the new copy takes the next record. With no other record she stays where she is and the log says so. A visiting copy (Immersive invitations) is only looked at and her record set aside while she walks. She is judged again once she joins V. A copy made again after fast travel is not looked at.
* **Log lines.** `Companion body: <name> record <record> (appearance ..., N components, N meshes, N shown): shown` or `no mesh shown yet, looking again` or `trying the look the record names, <look>` or `NO VISIBLE BODY, the record is set aside ...`. These are written in Developer mode only. The hook line `Companion body: ... inviting again with <record>` is always written (it is rare).

To mark a record that the owner has seen fail: add `"badRecords": ["Character.q307_fia_reception"]` to the roster row, run `node scripts/Build-GameRoster.mjs`, and the order changes at the next start. The marks of a session are not saved. They start again empty at every start, so a record that works in another save is not lost.

Tests: `bridge/companion-body.test.mjs` (fake components, the order, the repair, the fallback, the visitor, no Developer mode, no components).

## Voice

45 of the 575 side characters speak with a voice of their own: one game line each (`clip` in `characters/cast-sweep-voices.json`), rebuilt on the player's PC from the game files (`docs/VOICE_EXTRACTION.md`). 27 were found by a name at the start of the voice file name, 18 more by a voice tag that is proven to be the person's (`link`, rule and rejections in `docs/CAST_SWEEP.md`, "Own voices by voice tag" and "Voice models"): Cassius Ryder, Katherine McCannon, Milt Nauman, Susanna Quinn, Theo Price, Dorian, Driss "Scorpion" Meriana, Emmerick Bronson, Fredrik Persson, Gottfrid Persson, Mark Muratovich, Matilda K. Rose, Michael Maldonado, Reverend Colver, Roh Chi-Won, Roxanne Sumner, Taylor Gibbs and Tom Caldera. 137 more speak with the archetype voice of the generic voice model the game's scenes give them (`voiceModel` in the same file, `docs/CAST_SWEEP.md`, "Voice models"), and the other 393 keep a guessed archetype voice because no scene lets them speak.

## Convai

Each invitable side character has a Convai original and a multilingual twin, created with the cast expansion recipe
(`docs/CAST_EXPANSION_RECIPE.md` step 9): `node scripts/cast-sweep/provision-batches.mjs [--apply] [--size 40]` runs
`Provision-Characters.mjs` and `Create-MultilingualProfiles.mjs` per batch of keys. It skips what exists and stops at the first failed batch, so
running it again resumes. Ids land in `runtime/characters.json` and `runtime/multilingual-profiles.json`. `node packaging/Refresh-ReleaseData.mjs`
copies them to `packaging/release-data/`, which the package installs. A twin is used by the router only once its language box is off
(`languageBoxOff: true`, a signed-in dashboard step, `docs/MULTILINGUAL_PROFILES.md`), and until then the original answers every language.

## The Runtime setup check allows the whole id map (31 Oct, evening)

Talking to an invited side character on Convai failed while Local AI worked. The Runtime's setup check (`inspectSetup` in `packaging/runtime-layout.mjs`) still refused a `characters.json` of more than 256 ids and answered `character-profiles` ("setup required"), so the supervisor never started the bridge. The shipped map holds 766 ids (the 703 roster rows and the archetypes), so the bound is now `MAX_CHARACTER_IDS` = 4096, the same as the routing, the player memory registry and the Chat reset journal. `packaging/runtime-bootstrap.test.mjs` checks the shipped map itself.

The data is complete. All 557 invitable side characters have a Convai original and a verified twin in `packaging/release-data/`. The 17 side rows with no ids are children and cannot be invited.

If an install still says a side character "does not have a conversation profile configured yet", look for `Kept the edited characters.json` in the Runtime's start log. `packaging/runtime/prepare-state.mjs` installs the shipped id map only over an unedited copy, so a state `characters.json` changed by hand or by `scripts/Provision-Characters.mjs` keeps its older, shorter list.

Bounds on counts that stay, all above what is used today: world knowledge packs 1024 profiles (703 used), the local voice registry 1024, the phone reset epochs 2048 (766 used).
