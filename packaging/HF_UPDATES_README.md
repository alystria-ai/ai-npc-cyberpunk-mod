# Runtime updates

This is the text for `updates/README.md` in `alystria-ai/ai-npc-cyberpunk-mod-packs`. Everything below the line is the file. These are the update zips for game 2.5, the default game. A release adds one row to the table for its own step (`Runtime-Update-<previous version>-to-<this version>.zip` and its size). The update zips of the older game 2.31 are in `game-2.31/updates/`, with their own README (`packaging/HF_UPDATES_README_2_31.md`).

---

# Runtime updates

Small zips that bring a Runtime you already have up to date, instead of downloading the full Runtime (`Runtime.zip` at the top of this repository). These are for game **2.5**. If you stay on the older game 2.31, use the zips in [`game-2.31/updates/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/game-2.31/updates) instead.

**From 0.3.4 the mod's code comes with the Scripts, so you need these only when Settings > Help says the Runtime base is too old (it names the version).** **Apply the update zips from this folder one by one, starting from your version.** Extract each one into your Cyberpunk 2077 folder over your existing Runtime, in the place of the full Runtime, then the next one, until you reach the newest. If Windows asks about files that already exist, choose **Replace**: that is always safe. You do not delete anything yourself: files a version no longer needs are removed by the mod the next time the game starts. The Scripts and any optional packs are downloaded as usual.

With Vortex, drop each update zip onto the Mods page one by one, oldest first, together with the new Scripts. When Vortex asks, choose "Replace the existing mod" (it may first ask to replace the file, say yes), then click Deploy. With Mod Organizer 2, extract each one into the Runtime mod's folder.

Every step is kept here. If you are not sure which version you have, use the full Runtime instead. It works for new installs and for any update.

Game 2.5 builds start with version 0.3.1, so the first step here is special. It is for a player who has the Runtime of version 0.3.0 (the last one made for game 2.31) and moved their game to 2.5: `Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip` brings that Runtime to 0.3.1 for game 2.5 in one step. Use it with the Scripts for game 2.5. Any other starting point needs the full Runtime. The steps after it are named `Runtime-Update-<from version>-to-<to version>.zip`. The steps, in the order you apply them:

| Step | Size |
|---|---|
| `Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip` | 1.7 MiB |
| `Runtime-Update-0.3.1-to-0.3.2.zip` | 2.1 MiB |
| `Runtime-Update-0.3.2-to-0.3.3.zip` | 1.5 MiB |

Never mix the two games: an update zip of one game belongs to the Runtime of that game only.
