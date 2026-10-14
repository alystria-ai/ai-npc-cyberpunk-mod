# Companions can see

Status 2026-10-14: built on branch `companion-vision`, unit-tested, capture cost measured against the running game. **Not seen working with Convai yet:** no live Convai turn was made. Whether Convai accepts the picture for our characters is the open question (see "Live check").

When V asks about something visible ("what do you see?", "look at that", "how do I look?"), the companion gets one still picture of the game window with that line. Setting: Settings > Conversation provider > **Companions can see**. It is off by default and works with Convai only.

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
- Frames are scaled server-side to `max_resolution`. We send 768 px wide JPEGs of about 40 KB.
- No per-image price and no vision rate limit are published; `rate_limited` exists as an outcome.
- An attached frame costs image tokens on that model turn. `ImageTokensEstimate` is called "attribution only, not billing".
- On our plan a turn is one interaction (100k a month), with or without a picture, as far as the docs say.

**No-code chat rooms** turn an uploaded image into a text description (png, jpg, jpeg, 25 MB). That feature is unrelated to our realtime path.

## 2. Mistral and Local AI (report only; not built)

- **Mistral** ([vision docs](https://docs.mistral.ai/capabilities/vision), [models](https://docs.mistral.ai/getting-started/models/models_overview/)):
  - Ministral 3 (3B, 8B, 14B, 2512) accepts images on the same chat-completions endpoint we already call: a content array with `{"type": "image_url", "image_url": "data:image/jpeg;base64,…"}`, up to 20 MB.
  - Cost is about one token per 28×28 px patch, so a 768×432 frame is about 420 tokens (an estimate). Expect +0.2–0.5 s latency.
  - The mod asks for `ministral-8b-latest`; whether that alias points at the vision-capable 2512 build is unverified.
  - Building it is small: about 20 lines in `bridge/mistral-client.mjs` plus routing `imagesForTurn` there.
- **Local AI**:
  - llama.cpp (b11560, Vulkan) supports images through `--mmproj` ([multimodal](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)). Gemma 4 E4B needs its projector (946 MiB F16, or about 560 MB Q8): about 1.0–1.3 GB more video memory and an estimated 0.3–1 s per image on a GPU the game is using.
  - That needs a download and a VRAM rule. It is a separate project.

`CompanionVision.active` is false while Mistral or Local AI answers, so they get no picture today.

## 3. Design

### Capture options compared

| Option | Game thread cost | Captures | Minimised | Verdict |
|---|---|---|---|---|
| **Windows Graphics Capture of the game's HWND, out of process** | none (the compositor already has the frame) | the game window only, even when covered | reports `minimised` | **chosen** |
| Desktop Duplication (DXGI) | none | the whole monitor, including overlays and other windows | black or desktop | privacy fails |
| `PrintWindow` / GDI `BitBlt` | none | black for a D3D12 swap chain | black | does not work |
| Game screenshot (`TakeScreenshot`, photo mode, CET) | a frame on the game thread, file written to disk | game only | n/a | breaks the FPS and nothing-saved rules |
| Present hook / swap-chain readback (RED4ext) | a GPU copy and sync on the render thread | game only | n/a | crash and FPS risk |
| Continuous video stream to Convai (per frame) | none in game, constant CPU and network | game only | — | per-frame work, constant image tokens |

### Chosen approach: why it is the cheapest robust option

`native/vision/CyberpunkConvaiVision.exe` is a small C++/WinRT helper that the bridge starts when the setting is turned on. It idles at below-normal priority and holds no capture session between requests, so while idle it costs nothing.

Each capture:
1. Finds the window owned by `Cyberpunk2077.exe`: visible, unowned, not cloaked, the largest.
2. Opens a WGC session with no cursor and no yellow border, and waits up to 600 ms for one frame.
3. Closes the session.
4. Crops to the client area (no title bar) and scales with WIC Fant to at most 768 px wide.
5. Encodes a JPEG (quality 80) in memory and returns it as base64 on stdout.

Nothing touches the game process or the disk.

**On demand only, gated by intent.** Image tokens and publish time are not free, so the picture goes only with lines that ask about something visible. English patterns live in `LOOK_PATTERNS` in `bridge/companion-vision.mjs`; a miss just means no picture.
- **Typed line:** the words are known when the turn is admitted. The capture starts at once and overlaps preparation and page acquisition, and the turn waits for it at most 400 ms.
- **Talk key:** the bridge already reads what Convai hears while V talks. The first look-like words start the capture and publish the picture on the voice page while V is still talking, so releasing the key adds nothing. If only the last words ask, the finish captures then (also bounded at 400 ms).

**On the Convai side** (`bridge/convai-vision.mjs`):
- With the setting on, pages connect with video enabled but publish nothing: `startWithVideoOn: false`.
- The config is `sampleIntervalSecs 0.25, framesPerTurn 1, bufferFrames 2, stalenessSeconds 6, maxResolution 768, replacePreviousVisionContext true`.
- For a turn with a picture, the page draws it on a canvas, publishes it as a 5 fps canvas track, polls `visionStatus` (every 300 ms, at most 900 ms) until a frame is retained, then sends the context update and the text, and unpublishes after the reply.
- 1 to 4 pictures are composed into one 768 px canvas: one fills it, two sit side by side, three or four form a 2×2 grid. So exactly one frame goes per turn.
- The context update gains one sentence: an image of what V sees is attached and may include the HUD, map, subtitles or menus; describe the scene, never the interface.
- A `vision_not_enabled` answer stops further attempts on that page.

**What a failure does.** A failed, slow or refused picture never fails the turn; the line goes without it.

**HUD and subtitles.** The picture is what the player sees, HUD included. The context sentence tells the model to ignore the interface. Hiding the HUD for a capture would mean touching the game, which this design does not do.

**Minimised window.** WGC cannot capture an iconic window. The helper returns `minimised`, and the turn goes without a picture.

**Privacy.**
- Only the game window, only for that line.
- Nothing is written to disk.
- Exception: a developer sets `CYBERPUNK_CONVAI_VISION_DEBUG_DIR` (an absolute folder) to keep one copy per picture.

**Turning it off** stops the helper, clears queued pictures and reconnects the pages audio-only, once.

### Four views around V (front, back, left, right): not built

The question: could about four pictures in different directions be captured once when V starts talking, with only a one-off hitch?

- **Camera or photo mode.** Turning V's camera or opening photo mode is visible to the player and moves the view they are playing in.
- **Extra render-to-texture cameras.** The game has `RenderToTextureCamera` (the holocall uses `holocall_camera.ent`, `docs/HOLOCALL.md`), but script has no CPU readback of a render texture. A native readback would mean reverse-engineering the render thread's texture ownership: crash risk.
  - Each extra camera is a full extra scene render. That is an estimated several ms of GPU per view per frame while it exists, on a laptop already at about 50 fps (20 ms a frame).
  - Spawning camera entities and streaming the opposite direction tends to hitch.
  - A texture can only reach a screen capture by being shown in the HUD, which the player would see.
  - **Estimate:** at least 4 extra scene renders, so tens of ms of GPU, plus possible streaming hitches of 100 ms or more. Spreading the work over frames still costs one render per frame per active view. Holding the talk key does not hide any of it.
- **Verdict:** this does not meet the FPS rule, so the "Look around: 1 view / 4 views" option was not built.
- **Stand-in:** one picture of what V sees, plus the text world facts every turn already carries (`mod/turn-context.lua`: clock, district, weather, party, vehicle and the rest). If a native readback ever exists, `attachToNextTurn` (below) already composes up to four pictures into one frame.

## 4. Measured cost (2026-10-14, game windowed 1366×768, Balanced power, no game input)

`scripts/Measure-VisionCapture.mjs` drives the helper against the running game and reads the mod's own `runtime/perf-probe.json` (2 s windows).

| Per capture (output 768×432 JPEG, about 40 KB) | Median | p95 / max |
|---|---|---|
| Total in the helper | 135 ms | 167 / 186 ms |
| Of which: wait for the first frame | 115 ms | — |
| Copy | 5 ms | — |
| JPEG encode | 14 ms | — |
| Round trip including the pipe to the bridge | 138 ms | 169 ms |
| Helper CPU time | 15.6 ms | 47 ms |

The helper starts once in about 400 ms, prewarmed when the setting is turned on.

**Game FPS A/B.** 10 alternating blocks of 12 s, with a capture every 2 s while on: far more often than real use.

| | FPS median | Worst frame, median per window | Frames over 25 ms per window |
|---|---|---|---|
| Without captures | 50.32 | 26 ms | 1.8 |
| With captures | 50.65 | 25 ms | 1.52 |

No measurable FPS loss or hitch at the probe's 1 ms resolution. The frame wait is the compositor delivering its next frame, not work in the game.

**Added turn latency.**
- **Typed line:** the capture (about 140 ms) runs in parallel with preparation and page acquisition, capped at 400 ms. Then come the canvas publish and Convai's admission of the frame, capped at 900 ms (estimated 400–700 ms, not measured without live calls).
- **Talk key:** about 0 when the look-like words come before the last word, because the picture is staged while V talks.
- Lines that do not ask about something visible: 0.

## 5. Use from other features: `attachToNextTurn`

For features that already have images to show, such as YouTube on V's TVs, the bridge exposes one call on the `companionVision` object in `bridge/convai-bridge.mjs`:

```js
companionVision.attachToNextTurn(images, {characterId, ttlMs})
// images: up to 4 of {mime: 'image/jpeg' | 'image/png' | 'image/webp', base64}; each at most 4 MB decoded
// characterId: optional Convai character id; only a turn with that character takes them
// ttlMs: dropped if no turn comes in time (default 20000, 1000 to 120000)
// returns {queued: n} or {queued: 0, reason: 'off' | 'provider' | 'invalid'}
```

- Queued pictures go with the next turn, typed or talk key, whether or not that line asks to look. The game view, if the line asks, comes first.
- At most 4 pictures in all; the oldest queued are dropped first. They are composed into the one frame described above.
- Nothing is sent while the setting is off or another provider answers.
- A retried turn sends the same picture again.
- The function is synchronous and never throws. Pictures stay in memory only.

## 6. Settings and developer keys

- `companionVision` (bool, default false): the setting. Written by `mod/manager.lua` and read by the bridge on its settings poll.
- `visionTransport` in `runtime/settings.json` (developer only, not in the menu): `"video"` (default, dynamic vision context) or `"upload"` (`uploadFile` of the JPEG, for the live comparison).
- `CYBERPUNK_CONVAI_VISION_HELPER`: absolute path to a helper build. Default search: `<app>/vision/`, then `dist/vision/`.
- `CYBERPUNK_CONVAI_VISION_DEBUG_DIR`: absolute folder; keeps one JPEG per picture (development only).
- Bridge log lines begin `[Vision]`. `runtime/bridge-diagnostics.json` (written on a `diagnostics` command) carries `vision` (counters) and each page's `vision` (`lastOutcome`, `lastReadyMs`, `lastImageTokens`, `notEnabled`).
- Build: `powershell -File scripts/Build-VisionCapture.ps1` (MSVC with C++/WinRT; output `dist/vision/CyberpunkConvaiVision.exe`). `packaging/build-release.mjs` builds and ships it as `vision/CyberpunkConvaiVision.exe` in the Runtime package (`--no-vision` skips it; `--vision PATH` uses a given build). A missing helper only means no picture.

## 7. Files

- `native/vision/CyberpunkConvaiVision.cpp`: the helper.
- `scripts/Build-VisionCapture.ps1`: builds the helper.
- `scripts/Measure-VisionCapture.mjs`: measures the helper against the game.
- `bridge/vision-capture.mjs`: helper client.
- `bridge/companion-vision.mjs`: policy, `attachToNextTurn` and the turn hooks.
- `bridge/convai-vision.mjs`: page side (connect options, compose, publish or upload, acknowledgements); bundled into `runtime/realtime-client.js`.
- `bridge/realtime-client.mjs`, `bridge/realtime-host.mjs` and `bridge/convai-bridge.mjs`: wiring.
- `mod/manager.lua` and `mod/mcm.lua`: the setting.
- `mod/locales/*.lua`: 2 strings in 15 languages.
- Packaging: `packaging/runtime-layout.mjs`, `packaging/release-plan.json` and `packaging/build-release.mjs`.
- Tests:
  - `bridge/convai-vision.test.mjs` (12; the wire shape is checked against the SDK's own serialiser and the documented ranges)
  - `bridge/companion-vision.test.mjs` (17)
  - 2 new cases in `bridge/realtime-client.test.mjs`
  - the provider-section row list in `bridge/manager.test.mjs`

## 8. Live check (needs the user's approval: real Convai turns)

Each turn is one Convai interaction (about 1 of the 100k a month). No separate image charge is documented. A first check needs about 3 to 6 turns.

1. Build the helper with `scripts/Build-VisionCapture.ps1` in the checkout the bridge runs from. The development bridge finds `dist/vision/CyberpunkConvaiVision.exe` there.
2. Install `mod/manager.lua`, `mod/mcm.lua` and the 15 `mod/locales/*.lua`, then reload CET. The bridge files need a bridge restart.
3. Settings > Conversation provider: Convai, **Companions can see** on, Apply. The bridge log shows `[Vision] setting is now on (video)`.
4. Next to Judy, type "what do you see?".
   - Log: `[Vision] picture (typed) 768x432 … in N ms` and `turn …: 1 image(s)`.
   - The reply describes the scene and not the HUD.
   - `bridge-diagnostics.json` shows the page's `vision.lastOutcome`. **`vision_not_enabled` means the account or model does not qualify:** try one character on a Gemini or GPT model, then report.
5. The same with the talk key: "hey, look at that sign". Is the reply any slower than a normal line?
6. Set `"visionTransport": "upload"` in `runtime/settings.json` and repeat step 4. Does the reply see the picture?
7. Minimise the game during a typed turn (if possible): the log shows `no picture (typed): minimised` and the reply still comes.
8. Watch `perf-probe.json` around the turns: no FPS change.
