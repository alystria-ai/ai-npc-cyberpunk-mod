# Companions can see

Status 2026-10-29: **one setting, off by default, for every provider.** "Companions can see" (Settings > Conversations) now covers Convai, Mistral, Local AI and Custom. Convai was always on from 2026-10-16 to 2026-10-29 and is now off by default too, by the owner's decision, so a player who had pictures with Convai starts with them off. Section 2 is the work of 2026-10-29 (branch `feat/vision-all-providers`): unit-tested, the Mistral request and the helper's encode time measured, **not yet run live with a Local AI projector** (none is installed). The Convai part below was live-checked on 2026-10-23: a test picture (a red car and the word PINEAPPLE) had Judy describe it, and without a picture she said she could not see. The server needs the picture on the session about 3 s before the line (see "What the turn waits for"). Built on branch `companion-vision`, merged with main, unit-tested, capture cost measured against the running game.

With the setting on, every conversation turn (typed or talk key) carries one recent picture of V's surroundings: V's view from a few seconds before the turn, never older than 15 s (see "Freshness" in section 3). Before a conversation it is taken from a few seconds **before** it started, so it shows the place rather than the companion's face. During one a new picture is taken as each turn starts, and the companion may be in it. With the setting off nothing is captured, the helper process is not started and no frame is held in memory.

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

**What the turn waits for (live checks 2026-10-23, Judy, fresh Convai sessions, `@convai/web-sdk` 1.7.0).**
- The vision-status reply is `{event_type: 'vision-status', status: 'success', message: 'Vision status', extras: {vision_status_outcome, update_id, vision_buffer: {enabled, status, retained_frames, source_active, ...}}}`. `readAck` now reads those fields (before, it read neither `vision_status_outcome` nor `vision_buffer.status`, so a turn always waited the full 350 ms for an acknowledgement that never came).
- **The status is not a gate.** About 20 replies said `vision_not_enabled`, `enabled: false`, `source_active: false`, 0 retained frames, and the model still described the picture. So nothing waits for a status reply, nothing polls for one, and `vision_not_enabled` no longer switches vision off for the session. The values are kept in the diagnostics (`serverEnabled`, `serverSourceActive`, `serverRetained`, `lastOutcome`).
- **Lead time is what matters.** Asking "what do you see" with a new word on each picture, one fresh session per try: a picture published 3 s or more before the line was described 8 of 8 times (2.5 s: 2 of 3); one published 0.5 to 1.5 s before it 2 of 8; one published a moment before it about 1 in 3, whether the turn waited for the publish to finish (100 to 480 ms) or not. The failures answer "I can't see anything right now" (some with a stray `<channel>thought` line). So no short wait buys a picture; it only delays the line. The turn therefore waits for nothing, and the picture is published as early as possible (composer open, talk key down). `MIN_LEAD_MS` (3000) in `bridge/convai-vision.mjs` is that lead.
- **Cost with a picture on the session 3 s ahead** (10 ordinary questions with it, 10 without, alternating, text only): first reply text median 1319 ms against 1152 ms (p90 1394 against 1617), whole reply median 2098 ms against 1727 ms (p90 2162 against 1853). The line itself left 5 ms after the call in both. So the picture costs about 170 ms to the first text and about 370 ms to the end of the reply on the server side.
- Ordinary questions ("How's your day going?", "Want to grab some food later?") got ordinary answers: none of the 10 replies with a picture mentioned the picture.
- Not measured: time to first audio (the harness's non-live Convai audio path never completes, so each turn timed out).

## 2. The text providers: Mistral, Local AI and Custom (built 2026-10-29, branch `feat/vision-all-providers`)

One setting, **Companions can see** (Settings > Conversations, `companionVision` in `settings.json`, **off by default**), now covers every conversation provider, Convai included. Convai used to have it always on (since 2026-10-16), so a player who had pictures with Convai starts with them off after this change: that is the owner's decision. With the setting off nothing is captured, the helper is not started, no frame is held in memory, and Local AI loads no projector (the unload rule, `docs/RESOURCE_LIFECYCLE.md`).

What each provider does with a picture:

| Provider | What goes out | When it does not |
|---|---|---|
| Convai | The picture is published to the realtime session ahead of the line (sections 1 and 3, unchanged). 1024 px, JPEG quality 88. | Setting off. |
| Mistral | An `image_url` part in the last user message. All three models the route asks (`ministral-8b-latest`, `ministral-14b-latest`, `ministral-3b-latest`) have vision: `GET /v1/models` on 2026-10-29 lists `capabilities.vision: true` for all of them (the 2512 builds behind the `-latest` names). | A model that is not on `VISION_MODELS` (`bridge/mistral-client.mjs`), or one that refused a picture: that turn is text only. |
| Local AI | An `image_url` part, only when llama-server was started with the model's vision projector (`--mmproj`, section "Local AI" below). | The model has no projector, none fits beside it, the machine was measured to read prompts slowly or runs the model mostly on the processor, or the server is being restarted: text only, and the player is told once ('vision-local-no-model'). |
| Custom | An OpenAI-style `image_url` part. | The endpoint answered with a 400, 415 or 422 that names images or says the content must be a string: the same turn is written again at once without the picture, no picture goes to that address and model again this session, and the player is told once ('vision-custom-no-images'). |

**Where the picture is in the request.** In the last user message only, as `[image_url parts..., one text part]`. The text part is the note (`VISION_NOTE` in `bridge/vision-message.mjs`: what the picture is, mention it only when it fits, never describe the interface, say so when it is dark or unclear, indoors or outdoors comes from the text when the text says it) followed by exactly the text the message had without a picture. Every earlier message (persona, memory, earlier turns) is the same plain string as in a request without a picture: a test pins that the two requests are equal up to the last message. The last user message already differs on every turn (the live context, V's words), so nothing that a provider's prompt cache (llama-server's slot, Mistral's `prompt_cache_key`) could reuse sits after the picture, and the long-prompt reuse of `bridge/topic-words.mjs` and the stutter fix is not touched. Earlier turns are rebuilt from memory as text, so no old picture is ever replayed.

**Mistral: why no model swap.** The alternatives were to send a picture-carrying turn to the nearest vision-capable model, or to skip the picture when the chosen model cannot see. The route's models all see, so the question is only about a model that does not (none today, or one a refusal taught us about). Skipping the picture is the cleaner failure. A swap would change who answers mid-conversation (a different voice for the same character), would spend the allowance of a model the account may not have (on 11 Oct 2026 Small and Medium had a request allowance of 0 on a free account), and would send the turn away from the model whose `prompt_cache_key` prefix is warm. `route.imagesFor(modelId)` is the gate. The turn goes out with text and nothing else changes.

**Custom.** The refusal check is `isImageRefusal(status, text)` in `bridge/vision-message.mjs`. `streamChat` repeats the request without the picture, and calls `onImagesRejected` only after that repeat worked (so a 400 about something else never costs the player their pictures). The answer is kept in the endpoint's adaptation (`noImages`, per address and model, in memory), so a restart of the bridge asks again.

**Local AI.** `docs/LOCAL_AI.md`, "Pictures (Companions can see)", holds the supervisor's side. In short:
- A model has a projector when its manifest entry names one (`mmproj` on the `standard` and `lite` entries of the pack manifests, on an entry of `manifest.custom.json`, or on a Mature pack marker), or when its folder holds exactly one other `.gguf` that is a projector (GGUF architecture `clip`) and nothing else but that model. No pack ships a projector yet (section "Projectors that exist" below).
- It is loaded only while the setting is on: `--mmproj <file> --image-max-tokens 320`. Its memory is counted in the fit (`projectorNeedMiB`: the file plus 384 MiB for the image encoder, an estimate): a model that fits whole without it but not with it loads without it ('no-room'), and a projector never pushes a model onto the processor.
- Setting off: the server is restarted without the projector at the next idle moment, the old server's exit confirmed in the log. Setting on: restarted with it, if the model has one.
- `llama-server` could not start with the projector: the same model is started again without it, once, and not marked broken.
- The request carries its picture only when `lease.vision` is true (the loaded server has a projector). The prompt keeps `imageReserveTokens` (400 per picture) out of the budget, and a request that carried a picture does not teach the token ratio or the prompt-reading speed (the picture's tokens and the encoder's time are not the prompt's), so one picture cannot make the machine look slow.
- On a machine measured to read prompts slowly, or one that runs the model mostly on the processor, no picture is sent: a picture would add to a wait the player already feels. One log line says so.

**The picture's size.** Convai keeps 1024 px at quality 88 (its server scales to 1024). The text providers get 768 px at quality 80 (`TEXT_PICTURE`, about 27 KB for a plain scene and 45 to 50 KB for a normal interior), which means fewer image tokens and a smaller request. The helper takes the width and quality per request, so there is no rebuild. The buffer is emptied when the provider changes so a picture of the other size is never sent.

**What a turn waits for.** Nothing, as before. The frame is chosen from memory (the buffer, or the one taken when the composer opened or the talk key went down) when the turn is built. A turn with no young frame goes out without a picture and starts one capture for the next. The text providers have no pages, so nothing is published ahead and nothing is staged. `openComposer` and `beginVoice` only pick the frame, `stageForNext` does nothing. The picture is attached by `attachTextProvider` (`bridge/text-provider-host.mjs`) from the host's `turnImages` (memory only, never throws), for the in-person host only: the phone, reactions, add-on lines and the action decision never carry one.

**Measured (2026-10-29).**

| What | Result |
|---|---|
| Helper, encode (WIC scale plus JPEG) of a plain 1366-wide stand-in window by Windows Graphics Capture, 30 runs each, alternating, while the full test suite ran beside it (so the tails are noise) | 1024 px q88: median 29.3 ms, 47 KB. 768 px q80: median 19.6 ms, 27 KB. 640 px q75: median 21 ms, 19 KB. Helper CPU 15.6 ms median in all three. In the game the documented medians are 8.8 ms (768 q80) and 11.9 ms (1024 q88) for the encode, and 104 to 112 ms for the whole capture (the compositor's next frame), section 4. |
| Mistral, `ministral-8b-latest`, 557-token prompt against the same with a 768x369 picture and the note, 8 turns each, alternating, through `streamChat` | First word median 659 ms with the picture against 675 ms without (noise), whole reply 1776 against 2126 ms (noise). The server counted 1057 prompt tokens against 557: the picture is about 365 of the 500 more (one token per 28 by 28 pixel patch, the estimate of section 2 before), the note about 135. |
| Local AI, added prefill of a picture | **Not measured: no vision projector is on this machine, and none was downloaded.** The estimate, from the token counts above and the engine's measured prompt speed (2,300 to 2,500 tokens a second on the RTX 4080 Laptop, `docs/LOCAL_AI.md`): the note and up to 320 image tokens are about 0.2 s of prefill, plus the image encoder (an estimated 0.1 to 0.4 s on a card the game is using). So about 0.3 to 0.6 s on a turn with a picture, none on a turn without. `scripts/Measure-VisionPrefill.mjs` measures it as soon as a model and its projector are given. |

**Projectors that exist** (Hugging Face file lists read on 2026-10-29, nothing downloaded):
- Gemma 4 E4B (the standard pack model): `google/gemma-4-E4B-it-qat-q4_0-gguf` holds the exact model file the pack ships and `gemma-4-E4B-it-mmproj.gguf` (946 MiB, BF16) beside it. `ggml-org/gemma-4-E4B-it-GGUF` has `mmproj-gemma-4-E4B-it-Q8_0.gguf` (534 MiB).
- Bonsai 2 4B (the lite pack model): `prism-ml/Ternary-Bonsai-2-4B-gguf` has `Ternary-Bonsai-2-4B-mmproj-Q8_0.gguf` (350 MiB) and a BF16 one (644 MiB), beside the same `Q2_0` model file the pack ships.
- Mature lite (Qwen3.5-4B Uncensored HauhauCS): `mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf` (644 MiB) in its own repo.
- Mature good (Gemma4-E4B-MiniFantasy-V1): the fine-tune's repos carry no projector. The Gemma 4 E4B one is the likely match (a text fine-tune normally keeps the vision tower), unverified.
- A model the player adds can use any projector that matches it, from its repository, beside the model file.
Shipping one is a release decision (an extra download of 350 to 950 MiB per model on the Hugging Face page, and `mmproj` in the pack manifests).

## 2b. Audio: can a character know the song that is playing? (checked 2026-10-29)

Partly, and nothing needs building for it. `bridge/media-context.mjs` and `mod/media-song.lua` (Settings > Dynamic info > Music and TV, on by default) already tell an in-person companion, and Johnny in V's head, the song and the station of the car radio (while V is mounted) or of V's pocket radio, from the game's own song-change events: "You can hear the car radio: "<track>" on "<station>". If V asks what is on, answer from this." The text is the game's own title, quoted and capped, only for the forms of turn that hear what V hears, and it is sent when it changes (the first turn, a new song or station, after a long silence), not on every turn. The TV channel and the last line a TV said are told the same way.

What does not exist, and was not built (audio capture is out of scope), music that is not the radio (a club, a bar, a shop, ambient street music), and what a song sounds like. The picture cannot carry sound. A character cannot name a song from a bar's speakers because the game does not expose which track an ambient emitter plays. Only the vehicle radio and the pocket radio events carry a name.

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
- It captures one picture every **3 s**, keeping the last **5** in memory (about 500 KB at 1024 px, none older than 15 s), only while **all** of these hold: Convai answers, someone V may talk to is near (a party member, a nearby character the game lists, or a recent conversation partner), and no conversation is running.
- "A conversation is running" means: the composer is open, a turn is being answered, the talk key is held or its recording is being answered, or a reply is playing (the game's speech state). After the last of these, nothing is captured for **12 s** more, because the view is probably still on the companion.
- A picture that finishes after a conversation began is dropped.
- A turn takes the newest frame taken at least **2.5 s before the conversation started** (V turning to face her) **if it is at most 6 s old**, else the newest frame. A frame older than **15 s** is never sent (see "Freshness" below); the turn then goes without a picture and the log says why.
- In first person V's body is mostly out of view; in a car's third-person view the car sits low in the middle and most of the frame is the road and the street. The context sentence says the picture may show V's vehicle or the companion and to describe the place.

**Getting it to Convai without waiting** (`bridge/realtime-host.mjs`, `bridge/realtime-client.mjs`, `bridge/convai-vision.mjs`):
- With vision on, pages connect with video enabled but publish nothing until there is a picture (`startWithVideoOn: false`; `sampleIntervalSecs 0.25, framesPerTurn 1, bufferFrames 2, stalenessSeconds 6, maxResolution 1024, replacePreviousVisionContext true`).
- **Typed line:** when the composer (or phone-free chat composer) opens, the bridge already opens or keeps the target's conversation page. At that moment the chosen frame is published on that page (each speaker's page for a group), retried every 250 ms for up to 6 s while a page is still connecting. Convai buffers it while V types. When the line is sent, the page sees the same picture already on the session, publishes nothing new, and waits for nothing. If V closes the composer without sending, the picture is withdrawn (and every page withdraws an unclaimed one after 60 s).
- **Talk key:** at the press, the frame is chosen and published on the voice page as soon as the recording runs (retried for up to 6 s while the microphone starts), so Convai buffers it while V talks. The finish sends nothing more.
- **Fallback:** if the picture was not staged ahead (a page that connected late, a very short line; a group's next speaker is staged by "Early staging for turns with no composer" below), it is published when the turn starts and the line is sent **at once** (no wait, `visionWaitMs` default 0). The picture stays published for the turn, so the server may still take it before the model answers, but live it did so only about 1 time in 3 (see "What the turn waits for").
- 1 to 4 pictures (the frame plus any queued by `attachToNextTurn`) are composed into one 1024 px canvas: one fills it, two sit side by side, three or four form a 2×2 grid. So exactly one frame goes per turn.
- The context update gains one sentence: an image of the surroundings from a few seconds before the conversation may be attached; it can show the HUD, V's vehicle or the companion; mention it when it fits or when asked, never describe the interface, and do not guess when there is no image.
- After the turn the track is unpublished, so a picture never rides into a later turn. The server's vision-status replies are recorded in the diagnostics only; a `vision_not_enabled` reply stops nothing (see below).
- The phone's own chat and holocalls do not get pictures: the character is somewhere else.

**What a failure does.** A failed, slow or refused picture never fails the turn; the line goes without it.

**The yellow border (2026-10-23, Discord: "yellow bars around the screen, flashing every few seconds").** Windows draws a yellow border around a window that Windows Graphics Capture is capturing, for as long as the session lasts. The helper's earlier `IsBorderRequired(false)` did not remove it:
- On Windows 10 and any build before 20348 the property does not exist.
- On Windows 11 (20348 and later) Microsoft's documentation of `GraphicsCaptureSession.IsBorderRequired` says the system ignores `false` until the app has asked for and been granted borderless access (`GraphicsCaptureAccess.RequestAccessAsync(Borderless)`), which needs the `graphicsCaptureWithoutBorder` capability in an app package manifest. The helper is a plain unpackaged exe, so it cannot get it (it does not ask: a request would only prompt or fail). It still asks for it when a package identity exists, so a packaged build would be borderless with no code change.
- The buffer captured every 3 s while someone was near, so the border appeared on that timer: the report.

The fix, in two layers:
1. **No border where possible.** The helper (`capture <w> <q> auto`) takes the picture by **DXGI Desktop Duplication** of the monitor the game is on (on that monitor's own graphics adapter, so a hybrid laptop works), cropped to the game's client area. Desktop Duplication has no border and no consent prompt. It sees the whole monitor, so it is taken only while the game is the foreground window and no visible, clickable window covers any part of its client area (click-through overlays such as a frame counter do not count, the taskbar does not); otherwise the helper answers `covered` and there is no picture (a log line, counted apart from failures). It is not used for an HDR (floating point) or rotated desktop, or when the duplication cannot be made (`dxgi-unavailable`, remembered until the helper restarts): the helper then falls back to the Graphics Capture path, which shows the border. The device made for the duplication is kept between captures; measured on this laptop against a stand-in window: first picture about 230 ms (device creation), then 27 to 34 ms and about 15 ms of CPU each, less than the Graphics Capture path's 50 to 60 ms. The helper's `ready` line reports `{build, wgc, borderless}` and each picture reports `method` (`dxgi` or `wgc`) and `border`.
2. **When a picture did show the border** (`border: true`, `VisionCapture.borderShown`): the buffer does not run on its timer any more (`CompanionVision.capturing` is false). A picture is taken only when a turn needs one: the composer opening, the talk key, or a turn with no young frame, so the border shows for a moment around a reply and never on a loop. The player gets one notice with the next reply (`keyNotice: 'vision-border'`, once per bridge run, `docs/NOTIFICATIONS.md`): the yellow border is Windows showing a capture, and choosing Mistral or Local AI stops it. There is no player setting to switch vision off any more (the `companionVision` setting was removed on 2026-10-16), so the way to stop the pictures is to not use Convai; **owed:** the owner decides whether a switch comes back for this.

Counters in `bridge-diagnostics.json`: `borderCaptures`, `covered`, and `captureMethod`, `borderShown`, `helper` in the vision block. Rebuild the helper with `scripts/Build-VisionCapture.ps1` after changing `native/vision/CyberpunkConvaiVision.cpp`. `--exe name.exe` (development) makes the helper capture another program's window, to check a picture without the game.

**Minimised window.** WGC cannot capture an iconic window. The helper returns `minimised`, no frame is buffered, and turns go without a picture.

**Privacy.** Only the game window, kept in memory for at most 15 s (a picture is taken only while someone V may talk to is near, or when a conversation turn starts) and never written to disk. Exceptions, development only: `CYBERPUNK_CONVAI_VISION_DEBUG_DIR` (an absolute folder) keeps one copy per picture, and `CYBERPUNK_CONVAI_VISION_DEBUG_LAST=1` or `"visionDebugLastSent": true` in `runtime/settings.json` keeps the last picture handed to Convai in `runtime/vision-last-sent.jpg` with `vision-last-sent.json` (when it was taken and how it was sent), overwritten by each picture.

**The unload rule** (`docs/RESOURCE_LIFECYCLE.md`). The helper process exists only while it is capturing. It is stopped on the next poll when the setting goes off, the provider cannot see (a Local AI model with no projector, a Custom endpoint that refused a picture), nobody is near, or a conversation starts. It is never stopped mid-capture. It starts again (about 0.2 to 0.4 s, off the turn's path) when capturing resumes, and for one frame at the start of a turn that has no young frame (see "Freshness"). Leaving Convai also drops the buffer and reconnects the pages audio-only, once. Any change of provider drops the buffer, because its pictures were taken at the other provider's size.

### Freshness (2026-10-15, from a live test)

V and Alex had gone indoors and Alex said they were out in the street: the picture sent was 52 s old, taken outside. The old rules were the cause. The helper is released during a conversation, resumes 12 s after it, and the buffer preferred frames from before the conversation, so a long conversation sent whatever was left (up to 2 minutes old) or nothing.

- **Limit: `MAX_FRAME_AGE_MS` = 15 s** (was 120 s). V walks 4 to 7 m a second, so 15 s is a door, a corridor and a lift; the picture must show the place they are in. Frames past it are dropped from the buffer, and the buffer keeps 5.
- **A picture is taken when a turn starts** if no frame is younger than `FRESH_FRAME_AGE_MS` = 6 s (twice the buffer's 3 s cadence, so walking with the buffer running needs no extra capture): at the **composer opening** (typed line) or the **talk key** press, the bridge asks the helper for one frame (the helper starts if it was released, about 0.25 s, captures about 0.11 s, and is released again by the next 500 ms poll). It is staged on the page while V types or talks, so it adds no waiting. The companion may be in that picture; a picture of the right place with her in it is better than a clean one of the place they left. A frame from before the conversation is still preferred while it is at most 6 s old.
- **A turn with nothing staged** (a line sent within a moment of opening the composer, a page that was not open) uses any frame within 15 s, else goes out **at once without a picture** (changed 2026-10-23: it used to wait up to 450 ms for one capture; response latency counts as much as FPS, and a picture taken then had no lead and was taken about 1 time in 3). It starts one capture in the background, not awaited, so the next turn has a frame. A turn never waits for a picture anywhere: not for a capture, not at a talk key finish (a frame still being taken then is not waited for), not for the server.
- **Long typing or talking:** a frame staged more than 15 s before the line is sent is not sent: the typed line, or the key release, goes out at once with a younger frame from the buffer if there is one, else without a picture, and a capture starts in the background for the next turn.
- **The log says why there is no picture:** `[Vision] turn …: no fresh frame (newest 52 s old, limit 15 s)` or `no frame yet`; `image(s), frame N s old` with N at most 15 otherwise. Counters in `bridge-diagnostics.json`: `turnCaptures`, `turnsWithoutFrame`.
- **Why not a low-rate capture during the conversation?** It would keep the helper (35 to 50 MiB) and a capture every 5 to 8 s running for the whole conversation, and a frame cannot be told apart by "the companion is not the centre" without decoding it. One capture per turn is hidden behind typing or talking and costs less.

### Early staging for turns with no composer (2026-10-23, branch `fix/vision-early-stage`)

Convai takes a picture only if it was published about 3 s before the line (`MIN_LEAD_MS`), so every turn needs it staged early, and only the typed first turn and the talk key had a moment before the line. Which turns lacked a picture, and what stages them now:

| Turn | Lead before the line | Staged by |
|---|---|---|
| Typed line, one companion or the group's first speaker | the composer is open for seconds | `openComposer` (unchanged) |
| Talk key and Voice activation | the whole recording (both go through the same microphone start command) | `beginVoice` (unchanged). A picture that could not be staged on the recording (it was not running within 6 s) used to be dropped at the finish; now it goes with the finish like a typed line |
| **A group's next speaker** (look-ahead turn, held until the game submits it) | none: it started when the speaker before had its text, and published its picture at that moment | `stageForNext`, below |
| A typed line sent within about 3 s of opening the composer, a voice turn under about 3 s | too short | nothing can add lead; the picture is published and the line goes at once |
| A single-session plan's next speaker | its page is opened by its own turn | nothing: no page exists to stage on |

`CompanionVision.stageForNext(configs)` runs from `runInput` (`bridge/convai-bridge.mjs`) when a group speaker's turn begins, for the up to two speakers after them (their group pages, `nextSpeakerPages`). While that speaker is written and heard:
- The newest frame is used when it is at most `FRESH_FRAME_AGE_MS` (6 s) old: no capture, so a round costs at most one capture, and the speaker after (whose own turn stages the third) reuses it.
- Otherwise one capture by the helper (`captureForTurn('next speaker')`, off the turn's path; the helper starts if it was released). `covered` or `minimised` mean no picture and nothing staged.
- The frame is published on each page (`prestageVision`, retried every 250 ms for 6 s while a page connects) and remembered per page (`pageFrames`, by character id and scope). That page's turn then sends **the same frame** (`takePageFrame`), so the page sees its picture already on the session and publishes nothing new, even if a newer frame has been taken since. A frame older than `MAX_FRAME_AGE_MS` (15 s) at the send is never sent; the turn then takes a young buffered frame or goes without, as before.
- Nothing waits for any of it: `stageForNext` returns at once and is not awaited, a page that never answers holds nothing up, and the turn reads its images from memory.
- A cancelled round (`closeComposer`) withdraws the staged pictures; each page also drops one after 60 s.

Log lines: `[Vision] next speaker: frame N s old (reused|taken now), staged ahead on K page(s)` as the speaker begins, and at the next speaker's turn `turn ...: 1 image(s), frame N s old, on its page M s ahead` (M is the lead; 3 or more is what Convai needs). Counters in `bridge-diagnostics.json`: `nextStaged`, `nextCaptures`, `unstagedSent`.

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
- **Typed line with the composer open first** (the usual case): about 0. The frame is published when the composer opens and buffered while V types. At send, the page recognises the same picture (no new publish) and sends the line (no wait).
- **Typed turn without a composer** (a group's next speaker, a line sent within about half a second of opening the composer): 0 ms of waiting (was 350 ms), but the picture is mostly too late for that line (about 1 time in 3 it is used).
- **Mistral, Local AI, or vision off (developer switch):** 0.

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
- Nothing is sent while the developer switch is off or another provider answers.
- A retried turn sends the same picture again.
- The function is synchronous and never throws. Pictures stay in memory only.

## 6. Settings and developer keys

- One player setting, **Companions can see**, on the Conversations page (`mod/manager-ui.lua`), `companionVision` in `runtime/settings.json`, a boolean, **off by default** for every provider. `mod/manager.lua` writes `false` for a missing or wrongly typed value and keeps a saved `true`. The bridge reads it on the 500 ms settings poll (`CompanionVision.update`) and tells Local AI at the same moment (`LocalLlmServer.setVision`). History: it was a setting with Convai only until 2026-10-16, always on with Convai from then until 2026-10-29 (the old key was dropped on load), and is a setting again, for every provider and off by default, since 2026-10-29. A player who had pictures with Convai therefore has them off after the update: say so in the changelog.
- `CYBERPUNK_CONVAI_VISION=off` (environment, development): turns vision off whatever the setting says (no helper, no buffer, pages audio-only, no projector).
- `visionTransport` in `runtime/settings.json` (developer only, not in the menu): `"video"` (default, dynamic vision context) or `"upload"` (`uploadFile` of the JPEG, for the live comparison).
- `visionWaitMs` in `runtime/settings.json` (developer only): how long a turn may wait for its picture to finish publishing, 0 to 900 ms (default 0: the line is sent at once). It never waits for a server reply.
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
- `bridge/vision-message.mjs`: the picture in a chat request (`withImages`), the note, the refusal test, the size of a text provider's picture. `bridge/local-vision.mjs`: the numbers Local AI shares (image tokens, projector memory). `bridge/local-projector.mjs`, `bridge/local-llm-server.mjs`: the projector (`docs/LOCAL_AI.md`). `bridge/text-provider-host.mjs` (`attachTextProvider`, the routes' `imagesFor`) and `bridge/mistral-client.mjs` (`images`, `VISION_MODELS`): the request.
- `scripts/Measure-VisionPicture.mjs`: the helper's encode time per picture size against any program's window. `scripts/Measure-VisionPrefill.mjs`: what a picture adds to a Local AI turn, given a model and its projector.
- Packaging: `packaging/runtime-layout.mjs`, `packaging/release-plan.json` and `packaging/build-release.mjs`.
- Tests: `bridge/companion-vision.test.mjs`, `bridge/vision-message.test.mjs`, the vision cases of `bridge/text-provider-host.test.mjs`, `bridge/custom-provider.test.mjs` and `bridge/prompt-budget.test.mjs`, `bridge/local-projector.test.mjs` and the projector cases of `bridge/local-llm-server.test.mjs`, `bridge/convai-vision.test.mjs`, 2 cases in `bridge/realtime-client.test.mjs`, the provider-section row lists in `bridge/manager.test.mjs`.

## 8. Live check (needs the user's approval: real Convai turns)

Each turn is one Convai interaction (about 1 of the 100k a month). No separate image charge is documented. A first check needs about 5 to 10 turns.

1. Build the helper with `scripts/Build-VisionCapture.ps1` in the checkout the bridge runs from (the development bridge finds `dist/vision/CyberpunkConvaiVision.exe` there), and rebuild the page bundle with `npm run build:voice` (`runtime/realtime-client.js` carries `bridge/convai-vision.mjs`).
2. Restart the bridge (with the helper and bundle from step 1). Settings > Conversations > Companions can see is off by default: turn it on and Apply.
3. With Judy in the party, walk around for 15 s without talking: the log shows `[Vision] picture (buffer) 1024x576` and Task Manager shows `CyberpunkConvaiVision.exe`.
4. Turn to Judy, open the composer, type "what do you see around us?", send. The log shows `turn …: 1 image(s), frame N s old`. The reply describes the place, not her face and not the HUD. `bridge-diagnostics.json`: the page's `vision.lastOutcome` (watch for `vision_not_enabled`: then try one character on a Gemini or GPT model) and `prestaged` above 0.
5. Typed latency: compare `bridge-latency.json` for a few lines with `CYBERPUNK_CONVAI_VISION=off` against on.
6. The talk key: "what's around us?". The reply is no slower than with vision off.
7. While talking, `CyberpunkConvaiVision.exe` is gone from Task Manager except for about a second when a turn starts without a young frame (the picture taken for the turn); the buffer's regular captures come back about 12 s after the conversation ends. It is never there under Mistral or Local AI, with `CYBERPUNK_CONVAI_VISION=off`, or with nobody near.
8. `"visionTransport": "upload"` and `"visionWaitMs": 0` in `runtime/settings.json`: do these paths work instead?
9. Minimise the game for a while, then talk: the turn goes without a picture and the reply still comes.
10. FPS: `perf-probe.json` for 2 minutes walking with Judy near (captures running) against 2 minutes with `CYBERPUNK_CONVAI_VISION=off`; watch for hitches.

### 8b. Live checks for the setting and the text providers (2026-10-29, not yet run)

Do X, check Y. Mistral and Custom turns cost a few requests of the player's own key. Local AI needs a model and its projector (section 2, "Projectors that exist"), which are not installed.
1. Fresh settings, game running, Convai: walk with Judy for 30 s. Check there is no `CyberpunkConvaiVision.exe` in Task Manager and no `[Vision] picture` line. Turn on Settings > Conversations > Companions can see (Apply). Check the helper appears within a few seconds and a `[Vision] picture (buffer) 1024x...` line follows. Turn it off. Check the helper is gone on the next poll.
2. Setting on, Mistral: ask "what do you see around us?". Check the log line `turn ...: 1 image(s)` and a reply about the place. Ask a plain question and check the reply does not mention the picture. Check `[Vision] picture (buffer) 768x...` (not 1024).
3. Setting on, Custom, to an endpoint with a vision model (for example an OpenRouter vision model): the same question gets a description. Then a model with no vision: the reply still comes (one extra request), the notice "Your Custom endpoint does not accept pictures, so replies use only your words." appears once, and later turns carry no picture (no `1 image(s)` line).
4. Setting on, Local AI, Gemma 4 E4B with `gemma-4-E4B-it-mmproj.gguf` named as `mmproj` in the pack manifest (or beside the model alone in a folder): the log shows `pictures: ... is loaded with its vision projector`, `llama-server` runs with `--mmproj`, and a reply describes the place. Run `scripts/Measure-VisionPrefill.mjs` with the same files for the added prefill, and watch the card's memory in Task Manager.
5. Setting on, Local AI, a model with no projector: the notice "This Local AI model cannot see pictures, so replies use only your words." appears once with the next reply, no `CyberpunkConvaiVision.exe` runs, and replies are as before.
6. Setting on then off with Local AI and a projector: the log shows the restart, `the previous model server (pid N) exited: its graphics memory is back`, and the card's memory drops by about the projector's size plus the encoder buffer.
7. FPS and latency: 2 minutes walking with a companion near, setting on against off, `perf-probe.json` (method of section 4). For a Local AI turn with a picture compare `[LocalTurn]` first word and prompt tokens against a turn without.
