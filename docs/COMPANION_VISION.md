# Companions can see

Status 2026-10-15: built on branch `companion-vision`, merged with main, unit-tested, capture cost measured against the running game. **Not seen working with Convai yet:** no live Convai turn was made. Whether Convai accepts the picture for our characters is the open question (see "Live check").

With Convai, every conversation turn (typed or talk key) carries one recent picture of V's surroundings: V's view from a few seconds before the turn, never older than 15 s (see "Freshness" in section 3). Before a conversation it is taken from a few seconds **before** it started, so it shows the place rather than the companion's face; during one a new picture is taken as each turn starts, and the companion may be in it. Setting: Settings > Conversation provider > **Companions can see**, on by default, Convai only.

## 1. What Convai offers (research, 2026-10-14)

Sources:
- Unity SDK, Vision: [how vision works](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/vision/how-vision-works), [dynamic vision context](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/vision/dynamic-vision-context), [publishing and policies](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/vision/publishing-and-policies), [troubleshooting](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unity-sdk/features/vision/troubleshooting-and-diagnostics.md).
- Unreal: [vision quick start](https://docs.convai.com/api-docs/plugins-and-integrations/convai-unreal-engine-plugin/features/vision/vision-quick-start).
- Web SDK: [overview](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk) and [auth tokens](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk/auth-tokens).
- Models: [Core AI settings API](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis/core-ai-settings-api).
- No-code chat rooms: [share an image](https://docs.convai.com/api-docs/no-code-experiences/chat-experiences/share-files-with-the-room/share-an-image.md) and [file limits](https://docs.convai.com/api-docs/no-code-experiences/chat-experiences/share-files-with-the-room/file-limits-reference.md).
- Blog posts: [Unity](https://convai.com/blog/unity-vision-ai-character-tutorial) and [Unreal](https://convai.com/blog/give-your-ai-characters-eyes-ears-in-unreal-engine-streaming-vision-hands-free-ai-voice-interaction).
- [Pricing](https://convai.com/pricing).
- The installed `@convai/web-sdk` 1.7.0, read from its type definitions, README and `dist/core` (`ConvaiClient.js`, `VideoManager.js`, `visionRequest.js`).

**Our API does take images.** The mod's realtime path (`@convai/web-sdk` 1.7.0 in headless Edge, `bridge/realtime-client.mjs`) has two ways in:

1. **Dynamic vision context.** This is the path Convai documents for streaming vision.
   - Connect with `enableVideo: true` (connection type "video"), a `visionInputConfig` (sent as `vision_input_config`) and `respondModes.vision`.
   - The page publishes a LiveKit video track (`videoControls.publishCanvas(canvas, …)`). The server samples frames into a buffer and attaches the newest frames to the next model turn.
   - Acknowledgements arrive as `serverResponse` events, and `visionStatus()` asks for one. Outcomes: `frames_available`, `buffer_empty`, `no_active_video`, `vision_not_enabled`, `rate_limited`, `attached`, `deduped_stub`, `stale_skipped`.
   - Documented fields and ranges:

     | Field | Default | Range |
     |---|---|---|
     | `sample_interval_secs` | 1 | 0.1–60 |
     | `frames_per_turn` | 5 | 1–20 |
     | `buffer_frames` | 0 | frames_per_turn–120 |
     | `staleness_seconds` | 10 | 0.1–120 |
     | `max_resolution` | 0 (provider default: Gemini 384 px, others 768 px) | 64–2048 when set |
     | `replace_previous_vision_context` | true | — |

2. **`uploadFile(File)`.** A LiveKit byte stream on topic `file-upload`, taking JPEG, PNG, GIF or WebP up to 10 MB. The SDK sends it; what the server does with it in a realtime session is not documented.

**Gating.**
- The docs call dynamic vision context "an account-gated backend feature".
- It "requires a vision-capable non-realtime model (Gemini or GPT class)". Vision is a session option, not a character switch, but the character's model must qualify.
- **Risk for us:** every mod character uses `fast-gemma-4-31b-it`. The Core AI settings table lists Gemma 4 31B Fast (beta) as `realtime-gemma-4-31b-it` under Realtime/Live models. If that counts as "realtime", the session answers `vision_not_enabled`, and characters would have to move to a Gemini or GPT model for pictures to work. Only a live call can settle this.

**Auth-token mode** (`bridge/convai-credential.mjs`) is unaffected. The token only opens the session; the video track and byte stream travel inside the LiveKit room it opens.

**Format, size, limits and cost.**
- Frames are scaled server-side to `max_resolution` (64 to 2048). We send 1024 px wide JPEGs of about 100 KB, quality 88 (768 px, quality 80 and about 45 KB until 2026-10-15; the user found the vision "wasn't great").
- No per-image price and no vision rate limit are published; `rate_limited` exists as an outcome.
- An attached frame costs image tokens on that model turn. `ImageTokensEstimate` is called "attribution only, not billing".
- On our plan a turn is one interaction (100k a month), with or without a picture, as far as the docs say.

**Publishing before the text is the documented mode.** The server samples a published track into its buffer and attaches the freshest frames to the next model turn, filtered by `staleness_seconds`; this is how the Unity and Unreal plugins stream a camera. So a frame published while V types or talks is in the buffer when the line arrives, and nothing says a frame must follow the text. Our canvas is repainted every 200 ms while it is published, so the buffered copy never goes stale while V types.

**No-code chat rooms** turn an uploaded image into a text description (png, jpg, jpeg, 25 MB). That feature is unrelated to our realtime path.

## 2. Mistral and Local AI (postponed)

- **Mistral** ([vision docs](https://docs.mistral.ai/capabilities/vision), [models](https://docs.mistral.ai/getting-started/models/models_overview/)):
  - Ministral 3 (3B, 8B, 14B, 2512) accepts images on the same chat-completions endpoint we already call: a content array with `{"type": "image_url", "image_url": "data:image/jpeg;base64,…"}`, up to 20 MB.
  - Cost is about one token per 28×28 px patch, so a 768×432 frame is about 420 tokens (an estimate). Expect +0.2–0.5 s latency.
  - The mod asks for `ministral-8b-latest`; whether that alias points at the vision-capable 2512 build is unverified.
  - Postponed by the user until the Convai design is settled.
- **Local AI**:
  - llama.cpp (b11560, Vulkan) supports images through `--mmproj` ([multimodal](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)). Gemma 4 E4B needs its projector (946 MiB F16, or about 560 MB Q8): about 1.0–1.3 GB more video memory and an estimated 0.3–1 s per image on a GPU the game is using.
  - That needs a download and a VRAM rule. It is a separate project.

`CompanionVision.active` is false while Mistral or Local AI answers: no picture, no helper process, no buffer.

## 3. Design

### The problem with a picture at talk time

When V talks to a companion, V is usually looking at her, so the game window at that moment is mostly her face. The user asked for the surroundings instead, with V and the companion small or absent.

### Options compared

| Option | FPS cost | What the picture shows | Verdict |
|---|---|---|---|
| **(a) Rolling buffer of game-window frames, out of process, sent from before the conversation** | none measured (section 4) | the view V had just before turning to talk: the street, the room, the bar | **built** |
| (b) Crop or mask the centre of a talk-time picture | none | a ring around her face: little of the place | weaker; not built |
| (c) A second camera (render-to-texture) looking away from V | one full scene render per frame per view, plus streaming hitches; no script readback | ideal, if it were free | fails the FPS rule (below) |
| Screenshot at talk time (the first build) | none | mostly the companion | replaced |

Capture methods (unchanged from the first build): Windows Graphics Capture of the game's own window, out of process, is the only one that costs the game nothing, captures only the game window (also when covered) and reports a minimised window. Desktop Duplication captures the whole monitor (privacy), GDI returns black for D3D12, a game screenshot or photo mode works on the game thread and writes a file, and a Present hook risks crashes and frame time.

### How it works

**The helper.** `native/vision/CyberpunkConvaiVision.exe` (C++/WinRT, below-normal priority, about 35 to 50 MiB). Each capture: find the window owned by `Cyberpunk2077.exe`; open a WGC session with no cursor and no yellow border; take one frame (up to 600 ms); close the session; crop to the client area; scale with WIC Fant to 1024 px wide (`CAPTURE_DEFAULTS`; the helper takes width and quality per request, so no rebuild); encode a JPEG (quality 88) in memory; return it on stdout. It holds no capture session between pictures and touches neither the game process nor the disk.

**The buffer** (`bridge/companion-vision.mjs`), driven by the bridge's existing 500 ms settings poll (a few property reads; nothing per frame, nothing in the game):
- It captures one picture every **3 s**, keeping the last **5** in memory (about 500 KB at 1024 px, none older than 15 s), only while **all** of these hold: the setting is on, Convai answers, someone V may talk to is near (a party member, a nearby character the game lists, or a recent conversation partner), and no conversation is running.
- "A conversation is running" means: the composer is open, a turn is being answered, the talk key is held or its recording is being answered, or a reply is playing (the game's speech state). After the last of these, nothing is captured for **12 s** more, because the view is probably still on the companion.
- A picture that finishes after a conversation began is dropped.
- A turn takes the newest frame taken at least **2.5 s before the conversation started** (V turning to face her) **if it is at most 6 s old**, else the newest frame. A frame older than **15 s** is never sent (see "Freshness" below); the turn then goes without a picture and the log says why.
- In first person V's body is mostly out of view; in a car's third-person view the car sits low in the middle and most of the frame is the road and the street. The context sentence says the picture may show V's vehicle or the companion and to describe the place.

**Getting it to Convai without waiting** (`bridge/realtime-host.mjs`, `bridge/realtime-client.mjs`, `bridge/convai-vision.mjs`):
- With vision on, pages connect with video enabled but publish nothing until there is a picture (`startWithVideoOn: false`; `sampleIntervalSecs 0.25, framesPerTurn 1, bufferFrames 2, stalenessSeconds 6, maxResolution 1024, replacePreviousVisionContext true`).
- **Typed line:** when the composer (or phone-free chat composer) opens, the bridge already opens or keeps the target's conversation page. At that moment the chosen frame is published on that page (each speaker's page for a group), retried every 250 ms for up to 6 s while a page is still connecting. Convai buffers it while V types. When the line is sent, the page sees the same picture already on the session, publishes nothing new, and waits for nothing. If V closes the composer without sending, the picture is withdrawn (and every page withdraws an unclaimed one after 60 s).
- **Talk key:** at the press, the frame is chosen and published on the voice page as soon as the recording runs (retried for up to 6 s while the microphone starts), so Convai buffers it while V talks. The finish sends nothing more.
- **Fallback:** if the picture was not staged ahead (a turn with no composer, such as a group's next speaker, or a page that connected late), it is published when the turn starts and the page waits for Convai's acknowledgement at most **350 ms** (`visionWaitMs`), polling every 100 ms beside the context update. Out of time, the line goes anyway and the picture stays published for the turn, so the server may still take it before the model answers.
- 1 to 4 pictures (the frame plus any queued by `attachToNextTurn`) are composed into one 1024 px canvas: one fills it, two sit side by side, three or four form a 2×2 grid. So exactly one frame goes per turn.
- The context update gains one sentence: an image of the surroundings from a few seconds before the conversation may be attached; it can show the HUD, V's vehicle or the companion; mention it when it fits or when asked, never describe the interface, and do not guess when there is no image.
- After the turn the track is unpublished, so a picture never rides into a later turn. A `vision_not_enabled` answer stops further attempts on that page.
- The phone's own chat and holocalls do not get pictures: the character is somewhere else.

**What a failure does.** A failed, slow or refused picture never fails the turn; the line goes without it.

**Minimised window.** WGC cannot capture an iconic window. The helper returns `minimised`, no frame is buffered, and turns go without a picture.

**Privacy.** Only the game window, kept in memory for at most 15 s (a picture is taken only while someone V may talk to is near, or when a conversation turn starts) and never written to disk. Exceptions, development only: `CYBERPUNK_CONVAI_VISION_DEBUG_DIR` (an absolute folder) keeps one copy per picture, and `CYBERPUNK_CONVAI_VISION_DEBUG_LAST=1` or `"visionDebugLastSent": true` in `runtime/settings.json` keeps the last picture handed to Convai in `runtime/vision-last-sent.jpg` with `vision-last-sent.json` (when it was taken and how it was sent), overwritten by each picture.

**The unload rule** (`docs/RESOURCE_LIFECYCLE.md`). The helper process exists only while it is capturing. It is stopped on the next poll when the setting is turned off, Mistral or Local AI becomes the provider, nobody is near, or a conversation starts. It is never stopped mid-capture. It starts again (about 0.2 to 0.4 s, off the turn's path) when capturing resumes, and for one frame at the start of a turn that has no young frame (see "Freshness"). Turning the setting off also drops the buffer and reconnects the pages audio-only, once.

### Freshness (2026-10-15, from a live test)

V and Alex had gone indoors and Alex said they were out in the street: the picture sent was 52 s old, taken outside. The old rules were the cause. The helper is released during a conversation, resumes 12 s after it, and the buffer preferred frames from before the conversation, so a long conversation sent whatever was left (up to 2 minutes old) or nothing.

- **Limit: `MAX_FRAME_AGE_MS` = 15 s** (was 120 s). V walks 4 to 7 m a second, so 15 s is a door, a corridor and a lift; the picture must show the place they are in. Frames past it are dropped from the buffer, and the buffer keeps 5.
- **A picture is taken when a turn starts** if no frame is younger than `FRESH_FRAME_AGE_MS` = 6 s (twice the buffer's 3 s cadence, so walking with the buffer running needs no extra capture): at the **composer opening** (typed line) or the **talk key** press, the bridge asks the helper for one frame (the helper starts if it was released, about 0.25 s, captures about 0.11 s, and is released again by the next 500 ms poll). It is staged on the page while V types or talks, so it adds no waiting. The companion may be in that picture; a picture of the right place with her in it is better than a clean one of the place they left. A frame from before the conversation is still preferred while it is at most 6 s old.
- **A turn with nothing staged** (a group's next speaker, a line sent within a moment of opening the composer) uses any frame within 15 s, else takes one capture and waits for it at most `TURN_CAPTURE_WAIT_MS` = 450 ms; after that it goes without a picture (the capture still lands in the buffer for the next turn).
- **Long typing or talking:** a frame staged more than 15 s before the line is sent is replaced by a new capture at the send (a typed line) or at the key release (the finish publishes the new picture).
- **The log says why there is no picture:** `[Vision] turn …: no fresh frame (newest 52 s old, limit 15 s)` or `no frame yet`; `image(s), frame N s old` with N at most 15 otherwise. Counters in `bridge-diagnostics.json`: `turnCaptures`, `turnsWithoutFrame`.
- **Why not a low-rate capture during the conversation?** It would keep the helper (35 to 50 MiB) and a capture every 5 to 8 s running for the whole conversation, and a frame cannot be told apart by "the companion is not the centre" without decoding it. One capture per turn is hidden behind typing or talking and costs less.

### Picture quality (2026-10-15)

- **Size:** 1024 px wide, JPEG quality 88 (was 768 px, quality 80). The first live frame was 17,743 bytes for 768×432, a flat dark scene; a normal interior is about 48 KB at the old setting and about 103 KB at the new one. Convai's `max_resolution` is 1024 too (`COMPOSED_WIDTH`).
- **Brightness:** interior frames can be dim. In the hidden browser, a single game picture whose average brightness is below 70 (of 255) is lifted with a gamma curve aimed at 95 (not below gamma 0.55, so noise is not blown up; a black or loading screen below 4 is left alone). A normal or bright picture, and a picture composed with queued ones, are untouched. `bridge-diagnostics.json` shows the page's `vision.lastMean` and `lastGamma` (null: not lifted). It is cheap (a few ms in the browser, nothing in the game).
- **The HUD** takes about 10 to 12 % of the frame (the minimap, the quest tracker and the status icons at the bottom left, measured on a 1366×768 window). It is left in: cropping it would cut scene content, and the context note tells the model to ignore the interface.
- **Cost, measured 2026-10-15 against the running game** (20 captures each, alternating): 768 px / q80: 109 ms median total in the helper, encode 8.8 ms, helper CPU 16 ms, 47.7 KB; 1024 px / q88: 112 ms, encode 11.9 ms, CPU 16 ms, 102.9 KB. The time is the compositor's next frame, not the scaling, so the larger picture costs about 3 ms more in the helper, nothing in the game (the process is separate and below normal priority), and about 70 KB more base64 to the page, which is off the turn's path because the picture is published while V types. Image tokens on the model grow with the picture (an estimate: about 1.8 times); `vision.lastImageTokens` in the diagnostics shows what Convai reports.
- **Where the pixels go:** the JPEG becomes a canvas published as a LiveKit video track; Convai samples it and scales it to `max_resolution`. The SDK's `publishCanvas` offers no bitrate or encoding option, so the track's own encoding is LiveKit's default.

### Indoors or outdoors: what the model is told

Two sources: the game's interior flag (`Game.IsEntityInInteriorArea`, `docs/DYNAMIC_CONTEXT_AUDIT.md`, "Where V is") in the turn-context block, and the picture. The context note that goes with a picture says: if the text above says whether you are indoors or outdoors, that is fact; if it does not, judge it from the image (walls, ceiling, windows, furniture, sky) and never from the name of the district; with no image or an unclear one, say so instead of guessing. The block itself says "You are indoors." / "You are outdoors ..." when the flag answers, and "Which street or building you are at is not given." when it does not. Nothing is said when the picture is not attached, so the wording for Mistral and Local AI (and the pinned prompt) is unchanged.

### A second camera looking around V: not built

- **Camera or photo mode.** Turning V's camera or opening photo mode is visible to the player and moves the view they are playing in.
- **Extra render-to-texture cameras.** The game has `RenderToTextureCamera` (the holocall uses `holocall_camera.ent`, `docs/HOLOCALL.md`), but script has no CPU readback of a render texture. A native readback would mean reverse-engineering the render thread's texture ownership: crash risk.
  - Each extra camera is a full extra scene render. That is an estimated several ms of GPU per view per frame while it exists, on a laptop at about 50 to 57 fps.
  - Spawning camera entities and streaming another direction tends to hitch.
  - A texture can only reach a screen capture by being shown in the HUD, which the player would see.
- **Verdict:** it does not meet the FPS rule. The buffer gives the same benefit (a view of the place, not of her) at no measurable cost. If a native readback ever exists, `attachToNextTurn` already composes up to four pictures into one frame.

## 4. Measured cost (game windowed 1366×768, Balanced power, no game input)

`scripts/Measure-VisionCapture.mjs` drives the helper against the running game and reads the mod's own `runtime/perf-probe.json` (2 s windows), alternating blocks without and with captures.

**Per capture** (output 768×432 JPEG, about 42 KB; the 1024 px / quality 88 numbers are under "Picture quality"):

| Run | Captures | Total in the helper, median / p95 | Round trip incl. pipe, median / p95 | Helper CPU, median / p95 |
|---|---|---|---|---|
| 2026-10-14, every 2 s | 40 | 135 / 167 ms | 138 / 169 ms | 15.6 / 47 ms |
| 2026-10-15, every 3 s (the buffer's cadence) | 42 | 104 / 126 ms | 106 / 127 ms | 15.6 / 31 ms |
| 2026-10-15, every 3 s, second run | 57 | about 105 ms | 107 / 133 ms | 15.6 / 31 ms |

Most of the time is the compositor delivering its next frame, not work. Helper start: 215 to 305 ms; a cold start plus the first capture: 338 ms. Memory: 35 MiB working set at start, 51 MiB after captures.

**Game FPS A/B:**

| Run | Without captures: FPS median, worst frame median, frames over 25 ms per 2 s window | With captures |
|---|---|---|
| 2026-10-14, every 2 s, 10 blocks of 12 s | 50.32, 26 ms, 1.8 | 50.65, 25 ms, 1.52 |
| 2026-10-15, every 3 s, 12 blocks of 20 s | 57.41, 21 ms, 0.15 | 57.41, 21 ms, 0.13 |
| 2026-10-15, every 3 s, 16 blocks of 20 s | 55.83 (mean 55.49), 22 ms, 0.16 | 56.50 (mean 55.47), 22 ms, 0.45 |

- No FPS loss in any run.
- In the second 3 s run, slow frames were a little more frequent in the "with" blocks. Split by window, though, windows that held a capture had 0.40 slow frames per window, and "with" windows that held **no** capture had 0.54. So the excess followed the scene, not the captures.
- Each 3 s run had one isolated long frame in a "with" block (217 ms and 227 ms). The second run's series shows the 227 ms frame fell in a 2 s window with **no** capture in it. Neither is attributed to capturing, but the in-game check below should watch for hitches.

**Turn latency added** (estimates; Convai's acceptance cannot be measured without live turns):
- **Talk key:** about 0. The frame is in memory at the press and is published while V talks; Convai buffers it long before the key is released.
- **Typed line with the composer open first** (the usual case): about 0. The frame is published when the composer opens and buffered while V types. At send, the page recognises the same picture (no new publish) and checks its acknowledgement (no network wait).
- **Typed turn without a composer** (a group's next speaker, a line sent within about half a second of opening the composer): at most 350 ms, overlapping the context update (estimate 0 to 350 ms).
- **Mistral, Local AI, or vision off:** 0.

## 5. Use from other features: `attachToNextTurn`

For features that already have images to show, the bridge exposes one call on the `companionVision` object in `bridge/convai-bridge.mjs`:

```js
companionVision.attachToNextTurn(images, {characterId, ttlMs})
// images: up to 4 of {mime: 'image/jpeg' | 'image/png' | 'image/webp', base64}; each at most 4 MB decoded
// characterId: optional Convai character id; only a turn with that character takes them
// ttlMs: dropped if no turn comes in time (default 20000, 1000 to 120000)
// returns {queued: n} or {queued: 0, reason: 'off' | 'provider' | 'invalid'}
```

- Queued pictures go with the next turn, typed or talk key, after the surroundings frame. They are not staged ahead (they may arrive while V types), so such a turn takes the fallback path above.
- At most 4 pictures in all; the oldest queued are dropped first. They are composed into the one frame described above.
- Nothing is sent while the setting is off or another provider answers.
- A retried turn sends the same picture again.
- The function is synchronous and never throws. Pictures stay in memory only.

## 6. Settings and developer keys

- `companionVision` (bool, default **true**): the setting in Settings > Conversation provider. Written by `mod/manager.lua`, read by the bridge on its settings poll. `false` turns everything off (no helper, no buffer, pages audio-only).
- `CYBERPUNK_CONVAI_VISION=off` (environment, development): turns vision off whatever the setting says.
- `visionTransport` in `runtime/settings.json` (developer only, not in the menu): `"video"` (default, dynamic vision context) or `"upload"` (`uploadFile` of the JPEG, for the live comparison).
- `visionWaitMs` in `runtime/settings.json` (developer only): the fallback wait cap, 0 to 900 ms (default 350). `0` sends the line at once and relies on the server sampling the published picture before the model answers.
- `CYBERPUNK_CONVAI_VISION_HELPER`: absolute path to a helper build. Default search: `<app>/vision/`, then `dist/vision/`.
- `CYBERPUNK_CONVAI_VISION_DEBUG_DIR`: absolute folder; keeps one JPEG per picture (development only).
- `CYBERPUNK_CONVAI_VISION_DEBUG_LAST=1`, or `"visionDebugLastSent": true` in `runtime/settings.json` (developer only): keeps the last picture handed to Convai in `runtime/vision-last-sent.jpg`, plus `runtime/vision-last-sent.json` (taken at, age, how it was sent, size). It is the bridge's copy, before the page lifts a dim picture.
- Bridge log lines begin `[Vision]`: the first picture and every 100th, helper releases with the reason, and one line per turn (`turn …: 1 image(s), frame N s old` or `no frame yet`). `runtime/bridge-diagnostics.json` (written on a `diagnostics` command) carries `vision` (frames buffered, newest frame age, helper running, counters including `prestaged`) and each page's `vision` (`lastOutcome`, `lastReadyMs`, `lastImageTokens`, `notEnabled`).
- Build: `powershell -File scripts/Build-VisionCapture.ps1` (MSVC with C++/WinRT; an estimated 20 to 40 s, not timed; output `dist/vision/CyberpunkConvaiVision.exe`). `packaging/build-release.mjs` builds and ships it as `vision/CyberpunkConvaiVision.exe` in the Runtime package (`--no-vision` skips it; `--vision PATH` uses a given build). A missing helper only means no picture.

## 7. Files

- `native/vision/CyberpunkConvaiVision.cpp`: the helper.
- `scripts/Build-VisionCapture.ps1`: builds the helper.
- `scripts/Measure-VisionCapture.mjs`: measures the helper against the game.
- `bridge/vision-capture.mjs`: helper client.
- `bridge/companion-vision.mjs`: the buffer, frame choice, ahead-of-time staging, the unload rule, and `attachToNextTurn`.
- `bridge/convai-vision.mjs`: page side (connect options, compose, publish or upload, reuse of a picture staged ahead, acknowledgements); bundled into `runtime/realtime-client.js`.
- `bridge/realtime-client.mjs`, `bridge/realtime-host.mjs` and `bridge/convai-bridge.mjs`: wiring.
- `mod/manager.lua` and `mod/mcm.lua`: the setting. `mod/locales/*.lua`: its 2 strings in 15 languages.
- Packaging: `packaging/runtime-layout.mjs`, `packaging/release-plan.json` and `packaging/build-release.mjs`.
- Tests: `bridge/companion-vision.test.mjs`, `bridge/convai-vision.test.mjs`, 2 cases in `bridge/realtime-client.test.mjs`, the provider-section row lists in `bridge/manager.test.mjs`.

## 8. Live check (needs the user's approval: real Convai turns)

Each turn is one Convai interaction (about 1 of the 100k a month). No separate image charge is documented. A first check needs about 5 to 10 turns.

1. Build the helper with `scripts/Build-VisionCapture.ps1` in the checkout the bridge runs from (the development bridge finds `dist/vision/CyberpunkConvaiVision.exe` there), and rebuild the page bundle with `npm run build:voice` (`runtime/realtime-client.js` carries `bridge/convai-vision.mjs`).
2. Install `mod/manager.lua`, `mod/mcm.lua` and the 15 `mod/locales/*.lua`, reload CET, restart the bridge. Settings > Conversation provider shows **Companions can see** on.
3. With Judy in the party, walk around for 15 s without talking: the log shows `[Vision] picture (buffer) 1024x576` and Task Manager shows `CyberpunkConvaiVision.exe`.
4. Turn to Judy, open the composer, type "what do you see around us?", send. The log shows `turn …: 1 image(s), frame N s old`. The reply describes the place, not her face and not the HUD. `bridge-diagnostics.json`: the page's `vision.lastOutcome` (watch for `vision_not_enabled`: then try one character on a Gemini or GPT model) and `prestaged` above 0.
5. Typed latency: compare `bridge-latency.json` for a few lines with `CYBERPUNK_CONVAI_VISION=off` against on.
6. The talk key: "what's around us?". The reply is no slower than with vision off.
7. While talking, `CyberpunkConvaiVision.exe` is gone from Task Manager except for about a second when a turn starts without a young frame (the picture taken for the turn); the buffer's regular captures come back about 12 s after the conversation ends. It is never there under Mistral or Local AI, with the setting off, or with nobody near.
8. `"visionTransport": "upload"` and `"visionWaitMs": 0` in `runtime/settings.json`: do these paths work instead?
9. Minimise the game for a while, then talk: the turn goes without a picture and the reply still comes.
10. FPS: `perf-probe.json` for 2 minutes walking with Judy near (captures running) against 2 minutes with the setting off; watch for hitches.
