# YouTube on V's TV

Status (2026-10-14): first working version on branch `youtube-tv`. It is unit-tested, the redscript compiles, and a headless smoke test played a real video through the official player. It is behind a setting that is off by default. It has not been seen in the game yet; the live checks are at the end.

In V's apartments the TV offers **YouTube** next to its own On/Off and channel choices. The player picks a video, it plays in the official YouTube player over the game, and the companion in the room knows what is on: the title, channel, playback position, current chapter and description. The companion can talk about it when the player speaks or types. The video ducks while anyone talks.

## Player flow

1. Settings > Interface > **YouTube on V's TV** (off by default). The description tells the player to use Windowed Borderless or Windowed mode.
2. In Megabuilding H10 or one of the four apartments V can buy, look at the TV. Its choices gain **YouTube** under the game's own. While a video is open they also gain **YouTube: pause or play** and **YouTube: stop**.
3. On the couch, the game shows the apartment's scene choices instead of the TV's device choices, and those cannot safely be extended (see Design). The same thing is on a key there: CET bindings > Cyberpunk Convai: **YouTube on the TV**. With nothing open it opens the picker; with a video open it pauses or plays. Outside V's homes it says where it works.
4. The picker window opens over the middle of the game and takes the keyboard. The player can:
   - paste a link or a video id;
   - search on YouTube's own results page (a picked result plays on the TV);
   - choose from the last 8 videos.
   Escape or Close ends it.
5. The video then fills the largest 16:9 area in the top 78% of the game window, so subtitles stay visible below it. The window gives the keyboard back to the game: the player clicks back into the game and keeps the TV choices or the key for pause and stop.
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
- **V's homes.** The game reports a district for each apartment: `LittleChina_VApartment` (Megabuilding H10), `Northside_Apartment`, `JapanTown_Apartment`, `Glen_Apartment` and `CorpoPlaza_Apartment`. They are read through `PreventionSystem.GetCurrentDistrict().GetDistrictID()` and `TweakDBInterface.GetDistrictRecord(id).EnumName()`, the same reading `mod/init.lua`'s `currentDistrict()` already does. Apartment list: [eip.gg apartments guide](https://eip.gg/cyberpunk-2077/guides/apartments-guide/), [vulkk.com on the 1.5 apartments](https://vulkk.com/2022/02/16/how-to-access-vs-new-apartments-in-cyberpunk-2077-update-1-5/).
- **The couch.** Sitting on V's couch runs a scene (the tier 3 sit noted in `mod/seated-look.lua`), and the TV choices shown there are scene hub choices, not device choices. Adding one would mean editing scene graphs (`.scene` files), which is fragile and touches game story content. So the couch gets the key binding instead.

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
- **Data API.** `search.list` costs 100 units of the default 10,000 a day, and a key shipped inside an open-source mod would be a shared key. Neither is used.
- **Optional own key for descriptions and chapters.** The picker accepts the player's own YouTube Data API key (`AIza…`, checked by pattern), saved in `runtime/youtube-data-api.json` and never logged. With it, one `videos.list` call (`part=snippet,contentDetails`, 1 unit) per video adds the description, the chapters from it, and the duration. Data is kept in memory for the session; the history keeps only id, title, channel and time, for 30 days at most and 8 videos.
- **Without a key.** oEmbed (`https://www.youtube.com/oembed?format=json&url=…`, no key) gives the title and channel. It is a public endpoint YouTube documents for embedding; its terms beyond the general Terms of Service are not spelled out (noted for the user).
- **Captions: none for now.**
  - `captions.download` needs OAuth and edit rights on the video, so it only works for the uploader's own videos.
  - Reading `timedtext` or `ytInitialPlayerResponse` is scraping, which the Terms of Service forbid.
  - Reading the caption text the player shows in its own page (the DOM) is a grey zone: no rule names it, but it reads player internals. It is not built; it is a user decision below.
- **Frames for companion vision.** Capturing what the player shows (`captureFrame`, a 640-px JPEG through the browser's screenshot call) is also a grey zone, because it copies a picture of the content. The user asked for it on 2026-10-15: while a video plays, the companion gets about one frame a second through Convai's dynamic vision context (`visionSource()`, `docs/COMPANION_VISION.md` "The TV as the source"). It runs only while "Companions can see" is on with Convai, a video is playing and someone is near. Frames stay in memory.
- **Autoplay.** Autoplay with sound uses the browser flag `--autoplay-policy=no-user-gesture-required` in this private window. If the player still blocks it, YouTube's own play button shows (one click in the window starts it), and the bridge logs `autoplay blocked`.

### Context for the companion

The companion gets a block in its turn context, built by `watchingContext` in `bridge/youtube-tv.mjs` and capped at 900 characters (sentences drop from the end). Here is an example:

> Watching together (from the game, right now): You and V are watching a YouTube video together on the TV in V's apartment in the Glen: "Building a cyberdeck" from the channel Deck Lab. It is playing at 1:40 of 16:00. The part on screen now is the chapter "Soldering". Its description says: … You only know what is written here and what V says; never invent what is on screen or what someone in it said. React in your own way when it fits, keep it short so V can keep watching, and do not recite this.

- **Position.** The page reports it every 2 s while playing and with every state change. The bridge extrapolates from the last report, so the time is right at the moment of the turn.
- **Chapters** follow YouTube's own rule: the first is at 0:00, there are at least three, and they ascend.
- **Description excerpt.** At most 360 characters, without links, timestamps or hashtags.
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
- **The key binding** `cyberpunk_convai_youtube_tv` (init.lua) calls `M.hotkey()`.
- **Notices.** One catalogued id, `youtube-tv` (Player class, `docs/NOTIFICATIONS.md`): could not open (with the hint about the display mode), turned off in the settings, and works only in V's apartments.
- **Translation.** Every text goes through `ui.t('…')`; the page's 19 sentences are sent with the open command in the player's language.

### Bridge (`bridge/youtube-tv*.mjs`, `bridge/youtube-tv-window.ps1`, bridge restart)

- **`youtube-tv.mjs`** holds the pure parts: link parsing (`watch?v=`, `youtu.be`, shorts, live, embed, the nocookie, music and mobile hosts, `t=` and `start=`), chapters, the command check (30 s maximum age, known actions only), the context block, oEmbed and the Data API.
- **`youtube-tv-host.mjs` (`YouTubeTv`)** runs one session at a time.
  - **Open.** A per-session http server on `127.0.0.1:0` serves the page under `/tv/<nonce>`, with a Host check. Edge (dev install) or the packaged Chrome for Testing (`CYBERPUNK_CONVAI_BROWSER`) starts through Playwright in app mode, off-screen, with its own profile in `runtime/youtube-tv-browser`.
  - **The page binding** `__convaiTv` accepts calls only from the session's own origin.
  - **The window helper** starts first, so its 1.2 s C# compile overlaps the browser start.
  - **States** go to `runtime/youtube-tv-state.json`: picking, playing, paused, closed or error.
  - **Ducking** checks every 200 ms whether a reply is playing, the microphone is held, or speech is active, sets the volume to 30%, and restores it 1.2 s after it goes quiet.
  - **Unplayable videos** (errors 2, 5, 100, 101, 150, 152, 153) return to the picker with a message.
- **`youtube-tv-window.ps1`** is a Win32 helper in its own process. It finds the window by its unique title and makes it topmost and toolwindow; in player mode it is also non-activating, so it never takes the keyboard from the game.
  - It cuts Chromium's frame away with a window region measured from the page's render widget, so only the page shows, and hands focus back to the game.
  - It is DPI aware.
  - It moves the window only when its target changes, and hides it when the game is not in front or is minimised.
  - It needs the game in Windowed Borderless or Windowed mode: exclusive full screen would minimise the game when another window shows.
- **`convai-bridge.mjs`** gained about 15 lines: the import, the context block, the setting (`settings.youtubeTv`), the command watcher plus a 500 ms fallback poll, and shutdown.

### Latency

- **Open: about 1.1 s** from the command to the picker in the headless smoke test (Edge start plus page load), with the helper's 1.2 s compile running in parallel. Visible-window timing is a live check.
- **Pick to play.** The player API is already loaded on the page, so play starts as soon as YouTube buffers.
- **Context.** The block is built from memory at turn time and adds nothing measurable. The oEmbed or Data API lookup runs once per video, in the background, after play has started.

## What works now and what is stubbed

**Works (unit-tested, headless smoke-tested):**
- the setting;
- the TV choices and the key;
- the picker: paste, YouTube search, recent list, own-key save and forget;
- the official player with origin and referrer;
- unplayable videos returning to the picker;
- pause, play and stop from the TV choices and the key;
- hide under menus and alt-tab;
- stop when V leaves home, on a load, or when the setting is turned off;
- ducking during conversation;
- the companion's context block with title, channel, position, chapter and description;
- 30-day, 8-entry history;
- translations in all 15 languages.

**Stubbed or not built:**
- captions (none);
- companion remarks without the player speaking (not built);
- a couch scene choice (the key instead);
- a volume control in the game (YouTube's own control in the window works);
- exclusive full-screen mode (unsupported; the notice says so).

## Decisions for the user

1. **Own Data API key** for descriptions and chapters: built as an optional field in the picker; no shared key ships. Keep or remove?
2. **Captions from the player's page** (grey zone, see Terms): build or leave out?
3. **Frames to companion vision** (grey zone): decided 2026-10-15, wired (about one frame a second while a video plays, under "Companions can see").
4. **The couch:** keep the key binding, or research a scene hub choice later (scene file edits)?
5. **The setting stays off by default** until the FPS A/B passes.
6. **Downloads:** none were needed. The dev install uses the installed Microsoft Edge, and packages use the Chrome for Testing they already bundle.

## Live checks

Install: the Lua (`mod/youtube-tv.lua`, `init.lua`, `manager.lua`, `mcm.lua`, `notices.lua`, `mod/locales/*.lua`), the redscript `r6/scripts/CyberpunkConvai/YouTubeTv.reds` (game restart), and the bridge files (bridge restart). The game must be in Windowed Borderless.

1. **Setting.** Settings > Interface > YouTube on V's TV is off. Look at the H10 TV: only the game's own choices. Turn it on and Apply; within 2 s the TV shows **YouTube** under them.
2. **Open.** Choose YouTube. The game channel goes off, and a picker opens in the middle of the game window, with no browser frame, address bar or info bar. Time from the choice to the picker; about 1 to 2 s is expected.
3. **Pick.** Paste a link and press Play. The video fills the top of the screen at 16:9, subtitles stay visible below it, and sound plays. Click back into the game: V moves and the window stays on top. Also search on YouTube and click a result: it plays on the TV page, not on youtube.com.
4. **Controls.** At the TV, YouTube: pause or play, then YouTube: stop. On the couch, the key binding opens, then pauses or plays. Away from home the key says "works in V's apartments".
5. **Hiding.** Esc menu, map, inventory, alt-tab, minimise: the window hides each time and comes back after. Leaving the apartment stops it. Loading a save stops it.
6. **Companion.** With a companion in the room, type or say "what do you think of this?". The answer knows the title, channel and roughly where in the video it is, and the video ducks while either of you speaks. `probe.log` `Turn context:` shows the "Watching together" block.
7. **FPS A/B (pass or fail).** Same save, V seated, 120 s of `perf-probe.json` with no video, then 120 s with a 1080p video playing, twice each. Pass: within 2 FPS and no more frames over 25 ms. If it fails, keep the setting off and try the smaller area.
8. **Other homes.** Northside, Japantown, the Glen and Corpo Plaza: the choice appears on each apartment's TV. A TV outside V's homes, such as a bar, never shows it.
9. **Exclusive full screen.** The open fails with the notice about Windowed Borderless, and the game is not minimised.
10. **Packaged build** (later): the Chrome for Testing window shows no "for testing" bar inside the cut region, and the video plays.

## Files

- `r6/scripts/CyberpunkConvai/YouTubeTv.reds`
- `mod/youtube-tv.lua`; edits in `mod/init.lua`, `mod/manager.lua`, `mod/mcm.lua`, `mod/notices.lua`, `mod/locales/*.lua`
- `bridge/youtube-tv.mjs`, `bridge/youtube-tv-page.mjs`, `bridge/youtube-tv-host.mjs`, `bridge/youtube-tv-window.ps1`; edits in `bridge/convai-bridge.mjs`
- `bridge/youtube-tv.test.mjs` (20 tests: pure parts, a session with a fake browser and helper, the Lua under fengari, and source contracts)
- Manifests: `scripts/development-files.json`, `packaging/release-plan.json`, `packaging/runtime-layout.mjs`, `scripts/Extract-UiCatalog.mjs`, `localization/en.json`, `docs/NOTIFICATIONS.md`
