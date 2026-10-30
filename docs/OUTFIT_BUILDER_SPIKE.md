# Outfit builder spike

Written 2026-10-30 on branch `feat/more-outfits`. The question: can the mod build NEW looks out of the game's own clothing pieces, about 4 to 8 per character, without
shipping a single mesh, so "Companions change outfits" (docs/COMPANION_OUTFITS.md) has far more to choose from than the looks the game's own templates list?

**The game was not launched for this spike.** Everything below is read from the game's data, from the frameworks' documentation and scripts, and from offline compiles.
What was only compiled and not seen on screen is said so in each place. The proof is small and lives under `research/outfit-builder-spike/`, so nothing of it ships.

## Verdict

- **Route (b), Codeware at run time on our own copies: the most promising, and the one to live-test first.** It needs no new requirement (Codeware is already required),
  adds about 3 KB of redscript and about 400 bytes of data per built look, and its three operations compile cleanly against the script bundles of game 2.5 and game 2.31.
  Whether a built look looks right on screen is not known yet. The unknowns are listed under "What the live check must answer".
- **Route (a), new appearances through ArchiveXL: possible on paper, second choice.** It needs ArchiveXL as an optional requirement with a different build per game version,
  a small `.app` file of ours per set of looks (a patch cannot add a definition to an existing `.app`), and it could not be tried here: ArchiveXL is not in the 2.5 game folder
  and installing anything into the game was out of bounds. It is the fallback if route (b) shows a problem with skinning or with the body's hidden parts.
- **Nothing better turned up (c).** The game's item system (clothing items equipped on a puppet) is built around V's body and V's slots. NPC looks are plain lists of mesh
  components inside an appearance definition, so working on those components is the natural level.

## What a look is made of (read from the installed game, both versions)

`scripts/Inspect-OutfitMeshes.mjs` unbundles a character's entity template and its `.app` and lists each look's components. Panam, whose looks are the proof:

- A look is an appearance definition in `base\characters\appearances\main_npc\panam.app`. Its components are mesh components that point at ordinary game meshes:
  shoes, trousers, a belt, a jacket, a shirt (with or without sleeves), gloves, the body, the head, hair and nails.
- The clothes are separate meshes of the character's own folder (`base\characters\main_npc\panam\...`). The default look wears the jacket over a sleeveless shirt, the
  `no_jacket` look wears a sleeved shirt with no jacket, and `no_jacket_and_harness` wears the same shirt and trousers with their clean mesh appearance (`no_dirt`).
  So the pieces to mix already exist, and the game's own looks use only some combinations of them.
- Each look carries its own copy of the body component with its own `chunkMask`, the bit field that hides the parts of the body that clothes cover. The default look's
  body mask differs from the `no_jacket` look's. A built look that changes which clothes are worn changes what the mask ought to hide.
- Every component holds two handles to bindings: `parentTransform` and `skinning` (both bind to the character's skeleton). A component made from nothing would have
  neither. A copy of a sibling garment of the same entity carries both.
- A look also has an `AppearanceProxyMesh`, a baked far-distance stand-in of the look's original clothes.
- Game 2.5 and game 2.31 hold the same pieces: for Panam's three looks every component name, mesh path, mesh appearance and chunk mask is identical in both installs.

## Route (b): Codeware at run time

Codeware is already used by the mod. Its scripts in both game folders (2.5: Codeware 1.21.0, 2.31: Codeware 1.20.6) expose what is needed: `Entity.AddComponent`,
`Entity.GetComponents`, `ISerializable.Clone`, the writable fields of the skinned mesh components (`mesh`, `meshAppearance`, `chunkMask`, `isEnabled`), and
`IComponent.ChangeAppearance` and `LoadAppearance`. Codeware's own documentation says components must be added at the right moment, for example when the entity is
assembled, and that an `Entity/Reassemble` callback fires when components are added or removed.

`research/outfit-builder-spike/OutfitBuilder.reds` adds three methods to `GameObject`, called from Lua on one of our own copies, once, when the copy changes its look:

- `ConvaiOutfitToggle(name, on)` shows or hides one of the look's own pieces (the belt, the jacket).
- `ConvaiOutfitTint(name, appearance)` gives a piece another mesh appearance of its own mesh (Panam's shirt and trousers in `no_dirt`).
- `ConvaiOutfitAdd(like, name, mesh, appearance)` adds a piece: a copy of a sibling garment of the same entity (it keeps the sibling's skinning and transform bindings),
  pointed at another mesh the game ships.

Each is guarded by `@if(ModuleExists("Codeware"))` with a plain stand-in that answers false, the pattern the mod's other redscript files use. Nothing runs per frame,
nothing is kept between calls, no component is held alive.

The proof data is `research/outfit-builder-spike/built-looks.json`: three Panam looks, each a look of her own template plus a few operations.

| Built look | Starts from | Operations |
| --- | --- | --- |
| Clean clothes with the jacket | `panam_no_jacket_and_harness` | add the jacket |
| Shirt and gloves | `panam_no_jacket` | add the gloves |
| Jacket and gloves over the clean shirt, no belt | `panam_no_jacket` | clean shirt, belt off, add the jacket and the gloves |

`bridge/outfit-builder-spike.test.mjs` checks that every look starts from a look of its template, that every piece it touches exists in the base look (recorded in
`panam-components.json`), that every added mesh and mesh appearance is one the game's own definitions use, that no look holds undress, and that the redscript has the
three methods with a stand-in each and nothing per frame.

**Compile checks** (`research/outfit-builder-spike/Compile-Check.ps1`, an isolated copy in the temp folder, the game folders are only read):

| Game | Codeware scripts | Result |
| --- | --- | --- |
| 2.5 | with | compiles, no error |
| 2.31 | with | compiles, no error |
| 2.5 | without | no error in our file (other installed redscript mods fail there because they need Codeware) |

### Sizes

| Part | Size |
| --- | --- |
| `OutfitBuilder.reds` (3 methods and 3 stand-ins) | about 3.0 KB |
| the three proof looks as data | about 1.3 KB, so about 0.4 KB a look |
| 8 built looks for each of the 19 listed characters, at that rate | about 60 KB of data |
| meshes, textures, archives | none |

## Route (a): ArchiveXL

From ArchiveXL's resource patching documentation: an `.xl` file can patch an existing `.ent` (its `appearances`, `components`, `entity` and `visualTags`) and an existing
`.app` (its `components`, `partsValues` and `visualTags`, but not `partsOverrides`). That adds an appearance name to a character's own template, so a look could be
requested the way the mod already requests one (`ScheduleAppearanceChange`). A new definition needs an `.app` of ours, because patching an `.app` changes the components of
definitions that exist and does not add definitions. Those files would be authored with WolvenKit from the game's own definitions.

- **Requirement:** ArchiveXL as an optional requirement of a look pack. The releases page lists a separate build per game version (1.26 and later for 2.31, 1.28 and later
  for 2.5, as read on 2026-10-30), and the 2.31 test folder holds 1.27.5. A player of either game needs the matching build.
- **Size:** an `.xl` file of a few hundred bytes plus a few KB per definition. This is an estimate, nothing was built: no archive of ours exists for it.
- **Strength:** the engine builds the look from a definition, so the body mask, the skinning and the proxy mesh can all be set the way the game's own looks set them.
- **Weakness:** one more thing to install, two builds to pair with two games, an asset build per look, and an `.app` that has to be authored and checked per body type.
- **Not tried:** it could not run here. It is the fallback, not the plan.

## What the live check must answer (route b)

The proof is built and compiled. None of this has been seen in the game:

1. Does the cloned component show the new mesh on the copy, attached to the body and moving with it (skinning), on a spawned copy of Panam after her look changed?
2. Does the body show holes or clipping where a built look wears a piece the base look's `chunkMask` did not expect? The proof looks add pieces over a body whose mask already
   hides the torso and arms, so the first outcome to watch is the jacket over the sleeved shirt.
3. Are the added pieces kept when the game rebuilds the entity (a fast travel, a change of look through the existing path)? If not, the operations are applied again after
   each rebuild, on the `Entity/Reassemble` callback, registered for our copies only.
4. Do the far-distance proxy mesh and the first-person variants of the template matter for a companion? The proxy stands in for the base look's clothes at a distance.
5. Do `ConvaiOutfitTint` and `ConvaiOutfitToggle` do what they say on the clothes (shirt `no_dirt`, belt off)?

How to run it: apply the three methods from CET to one of our own party copies of Panam (for example `npc:ConvaiOutfitAdd(CName.new("t1_001_wa_shirt__panam7726"),
CName.new("g1_001_wa_gloves__panam0112"), "base\\characters\\main_npc\\panam\\g1_001_wa_gloves__panam.mesh", CName.new("default"))`), after the file is placed with the
other native scripts.

## Risks, and game 2.31

- Both games hold identical pieces for the proof (checked), and the Codeware scripts of both expose every call used and compile. The 2.31 side is therefore no more risky than
  2.5 for route (b). For route (a) the build pairing above is the risk.
- A built look is only as good as its mask. Looks that add clothes over an already covered body are the safe first set. Looks that remove clothes (a toggled-off jacket over a
  body mask that hides the torso) can leave holes, so they come last and only for pieces the live check shows are safe.
- Only our own spawned copies are ever touched. A character the game placed never gets these calls, the same rule as the rest of "Companions change outfits".
- Shipping it means registering the file in `scripts/development-files.json` and the release plan, and adding the guards the other redscript files have (the guard tests read
  every file in `r6/scripts/CyberpunkConvai/`). That is why the proof is kept apart until a live check says the route works.

## If the live check passes: how it plugs in

The data model already has what is needed: a row is a name, a kind and, for a built look, a base look and a list of operations. The rotation, the formal pick and the saved
last pick (docs/COMPANION_OUTFITS.md) work on names and kinds only, so built looks rotate with the game's own looks without a change there. `mod/companion-outfits.lua` would
ask for the base appearance exactly as it does today and call the operations once the read-back shows the base look, then again after a rebuild. The character editor's list of
looks would show a built look by its label. Each character's built looks are a few lines of data, to be checked mesh by mesh with `scripts/Inspect-OutfitMeshes.mjs` before
they are listed, the same rule as for the game's own looks.
