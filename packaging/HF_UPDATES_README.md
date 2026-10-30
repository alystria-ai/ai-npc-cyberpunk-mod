# Runtime updates

This is the text for `updates/README.md` in `alystria-ai/ai-npc-cyberpunk-mod-packs`. Everything below the line is the file. These are the Runtime update zips for game 2.5, the default game, up to 0.3.3. **Since 0.3.4 they are not offered any more** (owner decision 2026-10-28): the update (`AI-Companions-LLM-Update.zip`) carries all of the code, and an install older than its Runtime base takes the full install (`AI-Companions-LLM.zip`). A release adds no row here any more. The folder stays on Hugging Face for old links. The update zips of the older game 2.31 are in `game-2.31/updates/`, with their own README (`packaging/HF_UPDATES_README_2_31.md`).

---

# Runtime updates (old)

**You do not need these any more.** Since 0.3.4 the update on [Nexus Mods](https://www.nexusmods.com/cyberpunk2077/mods/35436?tab=files) carries all of the mod's code, and it runs on any Runtime of version 0.3.3 or newer. If your install is older than 0.3.3, or Settings > Help says the Runtime is too old, install the full install from [Nexus Mods](https://www.nexusmods.com/cyberpunk2077/mods/35436?tab=files) over it: one zip, no steps, nothing to apply in order. Your settings and memories are kept.

These are the small zips that brought a Runtime up to date step by step, up to 0.3.3, for game **2.5**. If you stay on the older game 2.31, the old steps are in [`updates/game-2.31/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/updates/game-2.31) and the same applies to you with the full install for game 2.31.

If you still want to use them (a Runtime of 0.3.0 or newer, or on a slow connection): **apply the update zips from this folder one by one, starting from your version.** Extract each one into your Cyberpunk 2077 folder over your existing Runtime, in the place of the full Runtime, then the next one, until you reach the newest. If Windows asks about files that already exist, choose **Replace**: that is always safe. You do not delete anything yourself: files a version no longer needs are removed by the mod the next time the game starts. The update zip and any optional packs are downloaded as usual.

With Vortex, drop each update zip onto the Mods page one by one, oldest first, together with the new update zip. When Vortex asks, choose "Replace the existing mod" (it may first ask to replace the file, say yes), then click Deploy. With Mod Organizer 2, extract each one into the Runtime mod's folder.

Every step is kept here. If you are not sure which version you have, use the full install instead. It works for new installs and for any update.

Game 2.5 builds start with version 0.3.1, so the first step here is special. It is for a player who has the Runtime of version 0.3.0 (the last one made for game 2.31) and moved their game to 2.5: `Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip` brings that Runtime to 0.3.1 for game 2.5 in one step. Use it with the Scripts for game 2.5. Any other starting point needs the full Runtime. The steps after it are named `Runtime-Update-<from version>-to-<to version>.zip`. The steps, in the order you apply them:

| Step | Size |
|---|---|
| `Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip` | 1.7 MiB |
| `Runtime-Update-0.3.1-to-0.3.2.zip` | 2.1 MiB |
| `Runtime-Update-0.3.2-to-0.3.3.zip` | 1.5 MiB |

Never mix the two games: an update zip of one game belongs to the Runtime of that game only.
