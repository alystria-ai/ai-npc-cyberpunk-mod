# Story packs are inactive in 0.4.0

Owner decision, 31 Oct 2026: release 0.4.0 ships **without** the story packs (the character quests and hangouts in `characters/bond-packs/`, the reach-outs in `characters/reach-outs/`). They are not ready. The plan is to rebuild them as real game quests (a journal entry, an objective tracker, waypoints) in a later update.

Everything else of the quest update ships and works: bonds and bond levels, the bond line in talk, romance with side characters, the Relationships and Romantic relationships pages, side characters, Chat search.

## What is off, and how

One switch, off in every release build: the **development switch**.

| Where | Without the switch | With the switch |
|---|---|---|
| Settings > Companions | no **Story packs** row and no **Characters text first** row | both rows are there |
| `mod/manager.lua` | `M.storyPacks()` and `M.reachOuts()` answer false, whatever the settings file saved. The snapshot says `storyPacks = false`, `reachOuts = false`, `storyPacksAvailable = false` | they answer what the settings file saved (both off by default) |
| Bridge | `parseBonds` (bridge/bonds.mjs) drops the `packs` and `reach` flags of every request. `bondPacks` is built empty and inert, `questSync` does nothing, no poll timer or media poll ever runs | as before |
| Files | `bond-packs.json`, `bond-effects.json`, `quest-play.json`, `quest-gift-allowlist.json` are neither read nor written. An existing `bond-packs.json` is left as it is | as before |
| Game side | `convaiQuestTick` builds nothing (one boolean at the start of a world), so `mod/quest-play.lua` and the other `mod/quest-*.lua` files are never loaded, nothing is armed, no map pin, no play file read, no per-frame work | the quest system is built when Character bonds and Story packs are both on |

To turn the packs back on for development, create an empty file named `story-packs-dev.flag` in the `runtime` folder of the mod (`...\mods\AiNpcCyberpunkMod\runtime\story-packs-dev.flag`), then reload mods and restart the service. Both halves look for the same file once per start. The bridge also accepts the environment variable `CYBERPUNK_CONVAI_STORY_PACKS=1` (the bridge only, handy for scripts). The file is never packaged. Tests that need the packs import `bridge/story-packs-dev-on.mjs` (bridge side) or run on `bridge/manager-fixture.mjs` (which has the file in its fake file system).

A "Story packs on" saved by a dev or test install does nothing in a release build: the value stays in the settings file and the gate ignores it.

## Characters text first

The reach-outs (a character texting, calling or Johnny speaking up first) are **off with the packs**. They run on the quest system: the bridge hands them to the game in the quest play file, the game side module `mod/quest-reach.lua` is built with the quest modules, and their texts go out through the quest line player. A reach-out can also invite to a hangout or follow a finished pack. Making plain "just a text" reach-outs work alone would mean loading the quest modules, so they return with the packs.

## What ships

The pack data (`characters/bond-packs/`, 1.1 MB, and `characters/reach-outs/`), the bridge modules and the `mod/quest-*.lua` files still ship, unchanged. That keeps the release guard (every quest data file ships) as it is and lets the switch above turn the system on in a release install for a test. Nothing in them runs.
