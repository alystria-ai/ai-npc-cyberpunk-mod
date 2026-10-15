# YouTube on V's TV

Status (2026-10-15): the first version is on main (branch `youtube-tv`). The second pass, on branch `youtube-tv-2`, adds captions read from the player's page and removes the optional key box, following the user's decisions of 2026-10-15. A third pass, branches `youtube-home` and `youtube-home-2`, fixes V's-home detection (see "V's homes"), makes the row read "YouTube" on the TV, and keeps the key binding for the couch (see "The couch"). All are unit-tested, and headless smoke tests played a real video through the official player; the second one also read its captions. It is behind a setting that is off by default until the FPS check passes. It has not been seen playing in the game yet; the live checks are at the end.

In V's apartments the TV offers **YouTube** next to its own On/Off and channel choices. The player picks a video, it plays in the official YouTube player over the game, and the companion in the room knows what is on: the title, channel, playback position, current chapter, description, and what was said in the last half minute (from the video's captions, when it has any). The companion can talk about it when the player speaks or types. The video ducks while anyone talks.

## Player flow

1. Settings > Interface > **YouTube on V's TV** (off by default). The description tells the player to use Windowed Borderless or Windowed mode.
2. In Megabuilding H10 or one of the four apartments V can buy, look at the TV. Its choices gain **YouTube** under the game's own. While a video is open they also gain **YouTube: pause or play** and **YouTube: stop**.
3. Standing, the TV's choices show when V looks at it from a spot where the couch's own "Sit" prompt is not showing (the Sit prompt takes the focus near the couch). **On the couch**, the game shows the TV's rows as the scene's own dialogue choices, which scripts cannot extend (see "The couch"), so the same thing is on a key: CET bindings > Cyberpunk Convai: **YouTube on the TV**. With nothing open it opens the picker; with a video open it pauses or plays. Outside V's homes it says where it works.
4. The picker window opens over the middle of the game and takes the keyboard. The player can:
   - paste a link or a video id;
   - search on YouTube's own results page (a picked result plays on the TV);
   - choose from the last 8 videos.
   Escape or Close ends it.
5. The video then fills the largest 16:9 area in the top 78% of the game window, so subtitles stay visible below it. The window gives the keyboard back to the game: the player clicks back into the game and keeps the TV choices (also on the couch) for pause and stop.
6. The window hides while a game menu, the pause menu or another program is in front, and while the game is minimised. The session ends when V leaves home, a save loads, the setting is turned off, or the player stops it.

## Research

### How the game's TVs work

Sources: decompiled game scripts from [CDPR-Modding-Documentation/Cyberpunk-Scripts](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts). The files used:
- `scripts/cyberpunk/devices/homeAppliances/mediaDevices/tvs/tv.script` and `tvController.script`;
- the media device controller and actions next to them;
- `scripts/cyberpunk/devices/core/baseDeviceActions.script`, `deviceBase.script`, `interactiveDevice.script`, `scriptableDeviceBasePS.script`;
- `scripts/core/systems/preventionSystem.script`.

Also used: [NativeDB `TVControllerPS`](https://nativedb.red4ext.com/TVControllerPS), the [.bk2 video format page](https://wiki.redmodding.org/cyberpunk-2077-modding/for-mod-creators-theory/files-and-what-they-do/file-formats/videos-.bk2), and the script of [TV Mute Control (Nexus 14149)](https://github.com/rfuzzo/cyberpunk-nexus-script-dump/tree/HEAD/mods/14149) as a working example of a custom TV action.

- **Classes.** `TV extends InteractiveDevice`, `TVController extends MediaDeviceController`, and `TVControllerPS extends MediaDeviceControllerPS extends ScriptableDeviceComponentPS`.
- **Choices.** The PS builds the choices in `GetActions(out actions, context)`: ToggleON, PreviousStation and NextStation, each behind its `IsDefaultConditionMet`.
- **Running an action.** The game queues it, the PS handler `On<Action>(evt)` runs, and then the entity's `cb func` runs.
- **Custom actions.** A mod can add an `ActionBool` subclass. TV Mute Control does this, and it is the pattern used here.
- **Captions.** A choice's caption can be set directly through `InteractionChoiceCaption.AddTextPart`. That way it needs no TweakDB record of its own: the record `Next` is reused only for the icon and the record name, so there is no TweakXL dependency.
- **Channels are pre-rendered video.** Each channel is a `.bk2` Bink file played by an `inkVideo` widget (`main_display` in `TvInkGameController`), plus GlobalTV ink widgets. No script API feeds arbitrary frames or a URL into that widget or into a texture. Mods that change TV content replace the `.bk2` files offline ([DSOGaming on a TV-show overhaul](https://www.dsogaming.com/mods/cyberpunk-2077-gets-a-13gb-mod-overhauling-all-the-tv-shows), [Nexus forum: custom TV video player](https://forums.nexusmods.com/topic/13523488-custom-tv-video-player/)).
- **V's homes.** The game has a district record for each flat: `LittleChina_VApartment` (Megabuilding H10), `Northside_Apartment`, `JapanTown_Apartment`, `Glen_Apartment` and `CorpoPlaza_Apartment` (`gamedataDistrict`, `final.redscripts` 2.3). Apartment list: [eip.gg apartments guide](https://eip.gg/cyberpunk-2077/guides/apartments-guide/), [vulkk.com on the 1.5 apartments](https://vulkk.com/2022/02/16/how-to-access-vs-new-apartments-in-cyberpunk-2077-update-1-5/).
  - **What went wrong (seen live 2026-10-15, Corpo Plaza flat).** The first version asked `PreventionSystem.GetCurrentDistrict()`, and in the flat it answered `Downtown`, so the TV had no YouTube choice and `probe.log` said `open refused: not in V's home (Downtown)`.
  - **Why.** `DistrictManager` (`districtManager.script`) keeps the districts V is inside as a **stack**. A district trigger volume sends `DistrictEnteredEvent`; `PushDistrict` pushes on enter, `PopDistrict` removes on leave, and `GetCurrentDistrict()` returns only the top. The stack is not saved. A read-only observer on `PreventionSystem.OnDistrictAreaEntered` logged: walking out of the flat's door and back gave `entered=false CorpoPlaza_Apartment` then `entered=true CorpoPlaza_Apartment`, and the district then read `CorpoPlaza_Apartment` (parents `CorpoPlaza`, `CityCenter`). After a quick save and load inside the flat the game pushed `CorpoPlaza_Apartment`, then `CityCenter`, then `Downtown` in one frame, so the street district ended on top.
  - **The rule now.** V is at home when ANY district in the stack is one of the five. `YouTubeTv.reds` adds `DistrictManager.ConvaiHomeDistrict()` (walks `m_stack`) and `PreventionSystem.ConvaiHomeDistrict()`, which return the home district's name or an empty string. The TV choices call it when they are built; Lua calls the same method (`env.home`, `M.atHome()`) when a video opens and once a second while one is open. Both read on demand only; nothing runs per frame. CET cannot read the private stack (`m_districtManager` reads as nil from Lua), which is why the read is in redscript.
  - **Fallback.** Until the redscript is compiled in (the call fails), Lua uses the top district alone, as before.
  - **The row's text (fixed on `youtube-home-2`).** The choice borrows the TV's own `Next` interaction record for its input and layout, and the UI prints the record's caption. A first version added a text part and the hub data read `LocKey#252 YouTube`, but the button drew only `Next`. The row's label is now set after the UI has drawn it: a `@wrapMethod(interactionItemLogicController) SetData` replaces the label of a row that carries our action with the translated caption Lua gave it. No TweakDB record of our own and no TweakXL file are needed.
  - **Known limit.** An entry can only be removed by its leave event. If a teleport out of a flat sends no leave event, a TV elsewhere could still offer YouTube until the stack is rebuilt by a load. Not seen; listed in the live checks.
- **The couch (seen live 2026-10-15, Corpo Plaza flat, with read-only probes and window captures).** Sitting on V's couch runs a scene (scene tier 3, noted in `mod/seated-look.lua`). The UI then shows two **dialogue hubs**: a "TV" hub with `[Turn off]`, `[Switch to next channel]` and `[Switch to previous channel]`, and a COUCH hub with `[Stand]`, none with an input action. The TV's own device hub (the one `YouTubeTv.reds` adds to, which has our row) is inactive while V sits. Scripts only draw dialogue hubs (`dialogWidgetGameController` renders blackboard data); scrolling and applying are native and stop at the scene's own rows, so a fourth row could be drawn but never selected, and one of the game's rows must not be taken over. A real extra row would mean editing the scene file in an archive, which is fragile and touches story content, so it is not done. **The way in from the couch is the key binding** `cyberpunk_convai_youtube_tv`, which keeps its id so a key the player already set stays. Standing near the couch, the "Sit" dialogue hub is the active one and hides the TV hub; YouTube shows from where that prompt is gone.

### How to show the video, and the FPS cost of each way

The game has no script path from a web video into a texture, so every workable option is a separate window composited above the game by Windows (DWM). Each option's cost on the game:

| Option | How | Cost on the game | Verdict |
|---|---|---|---|
| (a) Transparent window over the TV's rectangle in the world | Project the TV's corners to the screen and move a window to match | The rectangle has to be re-projected every frame as the camera moves, which is per-frame main-thread work (about 0.1 to 0.3 ms a frame from CET, so 1 to 2 FPS at 100 FPS) or the picture lags and swims. A transparent window needs `WS_EX_LAYERED`, which makes Chromium windows go black or tear on many drivers, and anything drawn over the player breaks YouTube's rules (see Terms). | Rejected: breaks the FPS rule and the terms. |
| (b) Into a game texture | Decode outside the game and copy each frame into a game texture | Not possible from redscript or CET: it needs a native D3D12 hook that uploads every frame (about 8 MB a frame at 1080p) on the render thread, and per-frame render work. Also a stability and anti-cheat risk. | Rejected: impossible from script, and per-frame work. |
| (c) A fixed "watching TV" window (built) | One fixed area over the game, in the official player, no tracking | **Idle: zero.** Nothing exists until the player opens it; the game side checks the setting every 2 s with one comparison. **Playing:** (1) Windows composes the game with another window, because the game loses independent flip while a window overlaps it. That is usually 0 to 2% of frame rate and up to one frame of extra display latency, while the window is open only. (2) The video is decoded by the GPU's separate video engine (VP9/AV1/H.264 hardware decode) and composited by Chromium at 30 or 60 fps, a small slice of GPU time. (3) Chromium runs in its own processes; the window helper runs in its own PowerShell process with one check every 250 ms. Nothing runs on the game's main thread per frame. **Estimate: 0 to 2 FPS** at 60 FPS on a GPU-bound laptop, while a video plays and V sits watching. It must be measured (live check 7). | Built. |

If the live A/B shows a loss above the rule, the remedies are, in order: a smaller player area (for example 60% of the window), or full-screen mode with the game behind fully covered. The latter is the cheapest case for DWM, since a game window that is covered entirely can be throttled.

### Terms: YouTube's rules and what they allow

Sources:
- [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) and the [policies guide](https://developers.google.com/youtube/terms/developer-policies-guide)
- [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference) and [player parameters](https://developers.google.com/youtube/player_parameters)
- [YouTube Terms of Service](https://www.youtube.com/t/terms)
- Data API: [getting started](https://developers.google.com/youtube/v3/getting-started), [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost), [search.list](https://developers.google.com/youtube/v3/docs/search/list), [captions.list](https://developers.google.com/youtube/v3/docs/captions/list), [captions.download](https://developers.google.com/youtube/v3/docs/captions/download)
- Chrome's [autoplay policy](https://developer.chrome.com/blog/autoplay), and [Simon Willison on embed error 153](https://til.simonwillison.net/youtube/fixing-153-embed)

- **Playback.** The video plays only in the official embedded player (IFrame Player API, `enablejsapi=1` with the page's `origin`). It is never downloaded, ripped, or opened through a direct media URL; a test asserts the page holds none.
  - The player is never smaller than 200x200; the area used is always far above the 480x270 YouTube suggests.
  - Nothing is drawn over the player: the stage element holds the player and nothing else (also tested).
  - YouTube's own controls, logo and links stay.
  - Ducking uses the player's own `setVolume`.
- **Referrer.** The page is served from `http://127.0.0.1:<port>` with `Referrer-Policy: strict-origin-when-cross-origin` and a matching `<meta name="referrer">`. Without a referrer, embeds fail with error 153 (client identity).
- **Search.** Search uses YouTube's own results page in the same window, with no API. A picked result's watch URL is caught and played in the embedded player on the TV page. The old `listType=search` embed is gone.
- **Data API: not used.** `search.list` costs 100 units of the default 10,000 a day, and a key shipped inside an open-source mod would be a shared key. The first version had an optional box for the player's own key. The user removed it on 2026-10-15: the box, its 8 sentences in all 15 languages and the code are gone, and a key a player saved with the first version (`runtime/youtube-data-api.json`) is deleted when the bridge starts.
- **Title and channel.** oEmbed (`https://www.youtube.com/oembed?format=json&url=…`, no key) gives them. It is a public endpoint YouTube documents for embedding; its terms beyond the general Terms of Service are not spelled out.
- **Captions, description and chapters: read from the player's page (grey zone, accepted by the user on 2026-10-15).**
  - The official ways do not work here. `captions.download` needs OAuth and edit rights on the video, so it only works for the uploader's own videos. Fetching `timedtext` or the watch page ourselves would be scraping.
  - **What is built instead: no fetch of our own.** Measured with headless Edge on 2026-10-15, the embedded player itself fetches two things for the video on the TV page:
    - its player answer (`youtubei/v1/player`, about 45 KB), which carries the description and the list of caption tracks;
    - often, without being asked, the caption track itself (`api/timedtext`, json3 format; 66 KB, 466 cues for a 22-minute talk).
  - The bridge reads those two responses from the TV window's own traffic (Playwright's response event). It does this once per video and track, at most 4 MB each.
  - If the player fetched no track by itself 4 s after the video starts, the page asks it to load one through the player's own captions module (`loadModule('captions')`, `setOption('captions', 'track', …)`). Once the track has been read, the captions are hidden again so the picture stays clean.
  - Everything stays in memory for the playing video only and is never written to disk or memory. The history still keeps only id, title, channel and time, for 30 days at most and 8 videos.
  - **Rules this touches:** nothing is downloaded beyond what the player loads anyway, and nothing is drawn over the player. Reading the player's own responses is not named in any rule, which makes it a grey zone, but it is closer to "reading player internals" than to a documented API, so it may break when YouTube changes its player. Without captions the companion falls back to the title, channel, chapter and description.
- **Frames for companion vision.** Capturing what the player shows (`captureFrame`, a 640-px JPEG through the browser's screenshot call) is also a grey zone, because it copies a picture of the content. The user asked for it on 2026-10-15: while a video plays, the companion gets about one frame a second through Convai's dynamic vision context (`visionSource()`, `docs/COMPANION_VISION.md` "The TV as the source"). It runs only while "Companions can see" is on with Convai, a video is playing and someone is near. Frames stay in memory.
- **Autoplay.** Autoplay with sound uses the browser flag `--autoplay-policy=no-user-gesture-required` in this private window. If the player still blocks it, YouTube's own play button shows (one click in the window starts it), and the bridge logs `autoplay blocked`.

### Context for the companion

The companion gets a block in its turn context, built by `watchingContext` in `bridge/youtube-tv.mjs` and capped at 1300 characters. Over the cap, sentences drop from the end: the description first, then the captions, never the first sentence. Here is a real example from the headless smoke test (seeked to 1:15):

> Watching together (from the game, right now): You and V are watching a YouTube video together on the TV in V's apartment in Megabuilding H10: "YouTube Developers Live: Embedded Web Player Customization" from the channel Google for Developers. It is playing at 1:18 of 22:24. The part on screen now is the chapter "Intro". Just before this moment the video said (from its captions): "…about do have some effect with mobile browser playback, but not all of them do. And we're going to just focus today on how these options affect desktop playback. Another thing … it's just a little bit outside the scope of what we wanted to talk about." Its description says: On this episode of YouTube Developer Live, Jeff Posnick covers what you need to know about using player parameters to customize the YouTube iframe-embedded player. You only know what is written here and what V says; never invent what is on screen or anything said in it beyond this. React in your own way when it fits, keep it short so V can keep watching, and do not recite this.

- **Position.** The page reports it every 2 s while playing and with every state change. The bridge extrapolates from the last report, so the time is right at the moment of the turn.
- **Captions.** The block takes the cues overlapping the last 30 s up to the position (1.5 s of slack, never further ahead), drops repeated lines (automatic captions roll), and keeps at most 420 characters, newest words first. A binary search finds the window, so turn cost does not grow with video length.
  - **Track choice:** written captions over automatic ones, the video's own over a machine translation, then the game's interface language, then English.
  - **Automatic captions** are labelled as such ("which can mishear words").
- **Chapters** follow YouTube's own rule: the first is at 0:00, there are at least three, and they ascend.
- **Description excerpt.** At most 360 characters (200 when captions are present), without links, timestamps or hashtags.
- **Who gets it.** Ordinary companion turns only. Not ambient chatter, battle or other reactions, phone chat, holocalls, or add-on voice turns.
- **No chatter of its own.** The companion speaks when the player does; the mod adds no timed remarks. That would be a later choice, because each turn costs Convai interactions and latency.

## Design

### Redscript (`r6/scripts/CyberpunkConvai/YouTubeTv.reds`, game restart)

- **The choices.** `@wrapMethod(MediaDeviceControllerPS) GetActions` first runs the game's own method and keeps its result and actions. It adds ours only when all of these hold:
  - the game's own method returned true;
  - the device is a `TVControllerPS`;
  - the request is a direct interaction;
  - the setting is on (mode set from Lua);
  - the game's own `ToggleON` is offered;
  - V is in one of the five homes.

  No game action is removed or replaced; a test asserts there is no `ArrayErase`, `ArrayClear` or `@replaceMethod`.
- **The action.** `ConvaiYouTubeTvAction extends ActionBool` carries the choice (open, toggle, stop) and a translated caption from Lua.
  - `TVControllerPS.OnConvaiYouTubeTvAction` turns the game's channel off on "open", so the TV's own sound stops, then calls the empty hook `PlayerPuppet.ConvaiYouTubeTvChoice(choice)`.
  - `TV.OnConvaiYouTubeTvAction` turns the screen off to match.
- **Game characters untouched.** Only TV devices in V's homes are touched; no NPC, story scene or quest state is.

### Lua (`mod/youtube-tv.lua`, global `convaiYouTubeTv`)

- **Event-driven.** It observes the hook (`ObserveAfter`) and writes one small command file, `runtime/youtube-tv-command.json` (version, id, issuedAt in ms, action and fields).
- **Cost.** Nothing runs per frame:
  - idle, `update` returns at its first comparison, and `sync` pushes the mode to the player at most every 2 s, only when it changed;
  - with a video open, a menu check runs four times a second and the state file and V's place are read once a second.
- **The key binding** `cyberpunk_convai_youtube_tv` (init.lua) calls `M.hotkey()`: it opens the picker, or pauses and plays while a video is open. The home rule is the stack read, so it works seated, where the top district is the street.
- **Notices.** One catalogued id, `youtube-tv` (Player class, `docs/NOTIFICATIONS.md`): could not open (with the hint about the display mode), turned off in the settings, and works only in V's apartments.
- **Translation.** Every text goes through `ui.t('…')`; the page's 11 sentences are sent with the open command in the player's language.

### Bridge (`bridge/youtube-tv*.mjs`, `bridge/youtube-tv-window.ps1`, bridge restart)

- **`youtube-tv.mjs`** holds the pure parts: link parsing (`watch?v=`, `youtu.be`, shorts, live, embed, the nocookie, music and mobile hosts, `t=` and `start=`), chapters, the command check (30 s maximum age, known actions only), the context block, oEmbed, the player answer (`parsePlayerResponse`), caption tracks in json3, XML and WebVTT (`parseTimedText`, `timedTextTrack`, `trackRank`) and the caption window (`captionWindow`).
- **`youtube-tv-host.mjs` (`YouTubeTv`)** runs one session at a time.
  - **Open.** A per-session http server on `127.0.0.1:0` serves the page under `/tv/<nonce>`, with a Host check. Edge (dev install) or the packaged Chrome for Testing (`CYBERPUNK_CONVAI_BROWSER`) starts through Playwright in app mode, off-screen, with its own profile in `runtime/youtube-tv-browser`.
  - **The page binding** `__convaiTv` accepts calls only from the session's own origin.
  - **The window helper** starts first, so its 1.2 s C# compile overlaps the browser start.
  - **States** go to `runtime/youtube-tv-state.json`: picking, playing, paused, closed or error.
  - **Ducking** checks every 200 ms whether a reply is playing, the microphone is held, or speech is active, sets the volume to 30%, and restores it 1.2 s after it goes quiet.
  - **Unplayable videos** (errors 2, 5, 100, 101, 150, 152, 153) return to the picker with a message.
  - **Captions** (`fromNetwork`, `requestCaptions`). Every response of the TV window costs one URL prefix comparison. Only the player answer and caption tracks for the playing video, while the TV page is shown, have their body read. Log lines: `player answer video=… description=… chapters=… tracks=…`, `captions video=… lang=… cues=…`, `no captions video=…`.
- **`youtube-tv-window.ps1`** is a Win32 helper in its own process. It finds the window by its unique title and makes it topmost and toolwindow; in player mode it is also non-activating, so it never takes the keyboard from the game.
  - It cuts Chromium's frame away with a window region measured from the page's render widget, so only the page shows, and hands focus back to the game.
  - It is DPI aware.
  - It moves the window only when its target changes, and hides it when the game is not in front or is minimised.
  - It needs the game in Windowed Borderless or Windowed mode: exclusive full screen would minimise the game when another window shows.
- **`convai-bridge.mjs`** gained about 15 lines: the import, the context block, the setting (`settings.youtubeTv`), the command watcher plus a 500 ms fallback poll, and shutdown.

### Latency

- **Open: about 1.1 s** from the command to the picker in the headless smoke test (Edge start plus page load), with the helper's 1.2 s compile running in parallel. Visible-window timing is a live check.
- **Pick to play.** The player API is already loaded on the page, so play starts as soon as YouTube buffers.
- **Context.** The block is built from memory at turn time and adds nothing measurable; the caption window is a binary search. The oEmbed lookup and the reading of the player's answer and caption track happen once per video, in the background, after play has started. In the smoke test both had arrived by the time the video was 2 s in.

## What works now and what is stubbed

**Works (unit-tested, headless smoke-tested):**
- the setting;
- the TV choices and the key;
- the picker: paste, YouTube search, recent list;
- the official player with origin and referrer;
- unplayable videos returning to the picker;
- pause, play and stop from the TV choices and the key;
- hide under menus and alt-tab;
- stop when V leaves home, on a load, or when the setting is turned off;
- ducking during conversation;
- the companion's context block with title, channel, position, chapter, description and the last half minute of captions;
- description, chapters and captions read from the player's own requests, with no key and no fetch of our own;
- 30-day, 8-entry history;
- translations in all 15 languages.

**Stubbed or not built:**
- companion remarks without the player speaking (not built);
- a volume control in the game (YouTube's own control in the window works);
- exclusive full-screen mode (unsupported; the notice says so).

## Decisions (user, 2026-10-15)

1. **Captions from the player's page: yes** (grey zone accepted). Built as above, as cheaply as possible: no per-frame work and no fetch of our own. Falls back to title, channel, chapter and description.
2. **Own Data API key box: removed**, with its strings in all locales. The description and chapters now come from the player's own answer instead, so they did not disappear with the key.
3. **The couch key binding: kept** (user, 2026-10-15, later). A first version of the fix removed it on the belief that the couch shows the TV's device choices; the probes showed the seated rows are scene dialogue choices, which cannot be extended, so the key stays and works from the couch with the stack home rule.
4. **The setting stays off by default** until the FPS check passes.
5. **Frames to companion vision: yes** (2026-10-15, later the same day): about one frame a second while a video plays, through Convai's dynamic vision context under "Companions can see" (`docs/COMPANION_VISION.md`).
6. **Downloads:** none. The dev install uses the installed Microsoft Edge, and packages use the Chrome for Testing they already bundle.

## Live checks

Install: the Lua (`mod/youtube-tv.lua`, `init.lua`, `manager.lua`, `mcm.lua`, `notices.lua`, `mod/locales/*.lua`), the redscript `r6/scripts/CyberpunkConvai/YouTubeTv.reds` (game restart), and the bridge files (bridge restart). The game must be in Windowed Borderless.

1. **Setting.** Settings > Interface > YouTube on V's TV is off. Look at the H10 TV: only the game's own choices. Turn it on and Apply; within 2 s the TV shows **YouTube** under them.
2. **Open.** Choose YouTube. The game channel goes off, and a picker opens in the middle of the game window, with no browser frame, address bar or info bar. Time from the choice to the picker; about 1 to 2 s is expected.
3. **Pick.** Paste a link and press Play. The video fills the top of the screen at 16:9, subtitles stay visible below it, and sound plays. Click back into the game: V moves and the window stays on top. Also search on YouTube and click a result: it plays on the TV page, not on youtube.com.
4. **Controls.** At the TV, YouTube: pause or play, then YouTube: stop. On the couch, the key binding opens, then pauses or plays. Away from home the key says "works in V's apartments".
5. **Hiding.** Esc menu, map, inventory, alt-tab, minimise: the window hides each time and comes back after. Leaving the apartment stops it. Loading a save stops it.
6. **Companion.** With a companion in the room, type or say "what do you think of this?". The answer knows the title, channel and roughly where in the video it is, and the video ducks while either of you speaks. `probe.log` `Turn context:` shows the "Watching together" block.
6b. **Captions.** Play a talk or tutorial with captions. Within a few seconds the bridge log shows `[YouTubeTv] player answer ...` and `[YouTubeTv] captions ... cues=N`. Ask "what did they just say?": the answer matches the last half minute. Check whether captions flash on the video for a moment; that happens when the player had to be asked for a track, which the smoke test video did not need. That request path has not been seen live yet. A music video without captions gives `no captions` or no `captions` line, and the companion still knows the title, chapter and description.
7. **FPS A/B (pass or fail).** Same save, V seated, 120 s of `perf-probe.json` with no video, then 120 s with a 1080p video playing, twice each. Pass: within 2 FPS and no more frames over 25 ms. If it fails, keep the setting off and try the smaller area.
8. **Other homes.** Northside, Japantown, the Glen and Corpo Plaza: the choice appears on each apartment's TV. A TV outside V's homes, such as a bar, never shows it. After a save load inside a flat, and after walking in from the street, the choice must appear in both cases (the first was the bug). Also fast-travel out of a flat, then look at a TV in the street or a bar: it must not offer YouTube.
8b. **Couch.** Sit on the couch facing the TV and press the key (F2 for this user): the picker opens; with a video open the key pauses and plays. 8c. **Row text.** Stand about 2 m in front of the TV, away from the couch's Sit prompt: the TV buttons show the game's own three and a fourth that reads **YouTube** (the first version read the borrowed record's caption, "Next"); with a video open also **YouTube: pause or play** and **YouTube: stop**.
9. **Exclusive full screen.** The open fails with the notice about Windowed Borderless, and the game is not minimised.
10. **Packaged build** (later): the Chrome for Testing window shows no "for testing" bar inside the cut region, and the video plays.

## Files

- `r6/scripts/CyberpunkConvai/YouTubeTv.reds`
- `mod/youtube-tv.lua`; edits in `mod/init.lua`, `mod/manager.lua`, `mod/mcm.lua`, `mod/notices.lua`, `mod/locales/*.lua`
- `bridge/youtube-tv.mjs`, `bridge/youtube-tv-page.mjs`, `bridge/youtube-tv-host.mjs`, `bridge/youtube-tv-window.ps1`; edits in `bridge/convai-bridge.mjs`
- `bridge/youtube-tv.test.mjs` (25 tests: pure parts including caption parsing and the caption window, sessions with a fake browser, helper and player traffic, the Lua under fengari, and source contracts)
- Manifests: `scripts/development-files.json`, `packaging/release-plan.json`, `packaging/runtime-layout.mjs`, `scripts/Extract-UiCatalog.mjs`, `localization/en.json`, `docs/NOTIFICATIONS.md`
