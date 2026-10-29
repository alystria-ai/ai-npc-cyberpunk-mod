# Pictures in the phone Chat (proof, 2026-10-29)

A character can send a prepared picture into V's phone Chat. This is a one-day proof of the plumbing, not a feature: nothing ships to players, no setting
shows, and the two test pictures are generated cards. Branch `feat/phone-images`.

## How it works

1. **The game's own row has a picture slot.** The message row (`MessangerItemRenderer`, library item `Message` of `phone_quest_submenu_sms.inkwidget`)
   holds an `inkImage` called `photo` (450 x 450, margin top 20) in the same vertical panel as the text, so the bubble grows with it. It is the same on
   game 2.5 and 2.31 (read from both installs' `basegame_1_engine.archive`). Until now `ConvaiChatRender` hid it.
2. **The third string of `SetMessageView` is the contact's name, not a picture** (the earlier research note guessed otherwise). The game's own picture
   route is `imageId` (a TweakDB `UIIcon` record) and `InkImageUtils.RequestSetImage`. That needs a TweakDB record, so it is not used here: the mod sets
   the atlas and the part on the `photo` widget itself, as `PhoneChatTabs.reds` does for the game's own atlases.
3. **Data.** `ConvaiPhoneChatLine` has four optional fields: `imageAtlas`, `imagePart`, `imageWidth`, `imageHeight`. A Chat row in `phone-chat.lua`
   (`M.history[contact][i]`) may carry `image = {atlas, part, width, height}`. `M.cleanImage` accepts only an atlas of the mod's own folder
   (`cyberpunk_convai\phone_images\<key>.inkatlas`), a lower-case part name and a size of 1 to 4096; anything else is dropped, also when the row is read
   back from `phone-history.json` (the picture is saved with its row like any line). `M.deliverImage(contact, caption, image)` is the entry point a
   scripted event would use.
4. **Row.** `ConvaiChatRender` hides the slot first (the list recycles rows, so a text-only line never inherits the picture of an earlier one), sets the
   text, and only for a line with an atlas and a part calls `ConvaiChatShowImage`: `SetAtlasResource(ResRef.FromString(atlas))`, `SetTexturePart`,
   `SetFitToContent(false)`, `SetSize` (the picture's shape inside 450 wide and 600 tall), `SetVisible(true)`. Once, when the row is built. Nothing per
   frame, no timer. If the archive is not installed the atlas does not resolve and the slot stays empty: the row is a text line.
5. **Archive.** `scripts/Build-PhoneImages.ps1` builds `convai_phone_images.archive` from `assets/phone-images/images.json`: each PNG imported to `.xbm`
   with WolvenKit (the console the facial and gesture builds use, `vendor/wolvenkit-console-9.0.1`; defaults: uncompressed true colour, mip chain,
   `isGamma` off, `TEXG_Generic_Color`), one `.inkatlas` per picture (`scripts/Build-PhoneImageAtlas.mjs`: three identical slots, one full-texture part
   named like the key, the shape a working mod atlas has), packed under `cyberpunk_convai\phone_images\`. Build with
   `powershell scripts/Build-PhoneImages.ps1 -VendorDirectory <checkout>\vendor` (a worktree has no `vendor`); output
   `runtime\phone-images\package\convai_phone_images.archive`, 57 KB for the two cards. The archive is NOT in the release plan, the development file
   list or any package: it is a test file for now.
6. **Developer trigger.** `scripts/Send-JohnnyProbe.ps1 phoneimage send:card_wide` writes the existing developer mailbox request
   (`runtime/diagnostic-request.txt`, polled by `init.lua` with the other developer requests, never per frame); `mod/johnny-probe.lua` runs it only with
   Developer mode ON and loads `mod/phone-image-probe.lua` (listed in `devOnlyLua`: never in a player's Scripts). Actions: `list`,
   `send:<picture>[:<contact or character key>]`, `text`. A send goes to the open chat's character, or to the first contact when no chat is open.

## Install the test build over game 2.5 (a player install; never `mod/diagnostics.lua`)

Game folder `G = E:\SteamLibrary\steamapps\common\Cyberpunk 2077`, mod folder `M = G\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod`.
Close the game first.

| From (the `wt-phoneimg` worktree) | To |
|---|---|
| `r6\scripts\CyberpunkConvai\PhoneChat.reds` | `G\r6\scripts\CyberpunkConvai\PhoneChat.reds` |
| `mod\phone-chat.lua` | `M\phone-chat.lua` |
| `mod\johnny-probe.lua` | `M\johnny-probe.lua` |
| `mod\phone-image-probe.lua` (new) | `M\phone-image-probe.lua` |
| `runtime\phone-images\package\convai_phone_images.archive` (build it, or take the copy in `deliverables\phone-images\`) | `G\archive\pc\mod\convai_phone_images.archive` |

The installed `init.lua`, `phone-chat.lua` and `PhoneChat.reds` equal main's (checked by hash on 2026-10-29); the installed `johnny-probe.lua` is older
than main's and the copy above replaces it. Game 2.31 (`E:\SteamLibrary\Cyberpunk2077-2.31`): the same five files, same names. The game recompiles the
redscripts at start (the first start after the copy takes longer).

## Live check (game 2.5 first, then 2.31)

Start the game, load a save, Settings, Development, Developer mode ON. Open the phone, Chat tab, open a conversation with any character (the text box
focuses by itself). Leave the phone open. From a PowerShell window in the worktree:

1. `powershell -File scripts\Send-JohnnyProbe.ps1 phoneimage list`. Check: the report lists `card_tall`, `card_wide`, the contacts and the open chat.
2. `powershell -File scripts\Send-JohnnyProbe.ps1 phoneimage text`. Check: a normal grey received bubble "Text-only test line, no picture." (the "before" look).
3. `powershell -File scripts\Send-JohnnyProbe.ps1 phoneimage send:card_wide`. Check: within about a second a new received bubble shows the caption
   "Test picture card_wide (1024 x 576)" and under it the wide card. Look at: (a) the picture shows at all (not an empty box); (b) the bubble grows to
   hold it and the picture is not cut off at the bottom or right; (c) the picture is not stretched (the pink circle is round); (d) the TL, TR, BL, BR
   corner labels are all there and not mirrored; (e) the yellow frame is closed on all four sides; (f) the 16 grey steps run from black to white
   without a washed-out or too dark middle (a colour-space mistake would show here), the skin tone bar is not orange or grey; (g) the chat scrolls to
   the new bubble and the box below stays usable.
4. `powershell -File scripts\Send-JohnnyProbe.ps1 phoneimage send:card_tall`. Check: the tall card shows at most 600 px high and about 340 wide, same
   points (a) to (g); the bubble and the scroll still work with a row this tall (scroll up and down, the picture row does not overlap its neighbours).
5. Scroll up through the chat, then down again. Check: the text-only line from step 2 still has no picture and no gap (the row was recycled).
6. Close the chat (Esc twice), reopen it. Check: both pictures are still there (they are saved with the history).
7. Open the chat of another character (J or the list), then send `phoneimage send:card_wide:<her key>` (for example `judy-alvarez`). Check: it appears
   only in her chat, and the first chat has no stray picture on its text rows.
8. FPS: watch the counter while the chat with the pictures is open and while scrolling. Check: no drop against the same chat without pictures.
9. Remove `G\archive\pc\mod\convai_phone_images.archive`, start the game, open the chat. Check: the picture lines are text only (caption, empty slot
   hidden or blank), no crash, no error in `AiNpcCyberpunkMod.log`.
10. Developer mode OFF, then `send:card_wide` again. Check: nothing appears (the request is read and dropped).

Each step on 2.31 too. What can differ there: the compiled redscript (it compiled against both game installs offline) and the `photo` widget (identical in
both archives), so a difference would come from the engine's atlas loading.

## Not known until the live check

* Whether `SetAtlasResource` with a `ResRef` built from a string at run time loads an atlas from a mod archive (the facial archive uses the same
  `ResRef.FromString` for animgraphs, and the game's own atlases load by `r"..."` literal, which is the same type).
* Whether the list row's height follows the picture on its own (the row's `fitToContent` panel suggests it) or clips a tall picture, and whether the
  list needs a second layout pass after an async atlas load.
* Whether the colours are right: `isGamma` is off in the import (the wiki's advice for UI textures); the grey ramp and skin bar answer it.
* The texture format: the import keeps it uncompressed true colour (about 3 MB of video memory per 1024 x 576 picture, about 4 MB for the tall one;
  the archive stores it compressed). For a shipped pack a BC7 import setting is the next step (about a quarter of the video memory).
* The character's language model sees only the caption text of the row, not the picture (`recentPhoneConversation` sends text only).
