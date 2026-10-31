# Conversation runtime

The CET adapter exchanges requests and receipts through the installed mod's `runtime` directory. A hidden Node bridge uses the project's ignored Convai key, account mappings, and persistent player-memory state. The source repository still needs a prepared development environment; see the [main README](../README.md) and [packaging plan](../docs/PACKAGING.md).

Microphone capture starts only through an explicit **talk by voice** or **group voice chat** action. CET bindings are assigned by the player; the runtime reads current bindings for hints and does not impose function keys. Live microphone acceptance remains deferred. See [group voice](../docs/GROUP_VOICE.md).

## Invitations, connections, and turns

- Selecting Invite starts verification of memory configuration, selected voice preparation, and connection warm-up before actor creation. A fresh readiness receipt and resumed gameplay authorize the spawn. Preparation creates no synthetic dialogue or saved memory.
- Duplicate copies share their profile's prepared private connection. Dismissal, failed spawning, death, and world loss retire identities that no longer belong to the party. A heartbeat keeps the bridge informed.
- Each present identity keeps a private connection. Up to three additional connections prepare the exact group audience; an eight-copy party needs at most eleven pages in the hidden browser. Setup is staggered, with retry cooldowns and silent keepalive checks.
- Private, phone, and exact group audiences have separate transient sessions while retaining one persistent player identity. Separate sessions do not promise separate provider memories for the same player/character.
- Group mode schedules the addressed character first, followed by at most two different nearby identities. Only the addressed name appears in the composer heading. A duplicate copy cannot become an extra speaker.
- Connections for later speakers can warm during current playback. Production player-identified sessions do not generate speculative replies that could leave cancelled dialogue in provider memory. Existing prepared output requires an exact matching request, audience, identity, and delivered history.
- Changed audiences, superseding requests, cancelled rounds, lost actors, failed playback, and lost world heartbeats retire obsolete preparation. A late result cannot publish into a replacement turn.

See [invitation ownership](../docs/COMPANION_INVITATIONS.md), [player memory](../docs/PLAYER_MEMORY.md), and [Chat reset ownership](../docs/CHAT_MEMORY_RESET.md).

## Two audio producers

| Provider | Generation and delivery | Playback clock |
|---|---|---|
| **Convai** | One request produces original reliable PCM16 and facial packets. A continuous AudioWorklet ring can start after a small audio buffer, reply text, and game admission. No Omni text splitting or complete-WAV wait. | Device-correlated consumed source samples |
| **OmniVoice** | Convai produces text; one shared resident model synthesizes phrases at the captured 16/32-step setting. The first complete phrase can play while later phrases generate, each fed as PCM to the same continuous renderer. | The continuous renderer's heard-audio clock, like Convai (the native Audioware cursor before 2026-10-22) |

Convai packet boundaries do not become separate playback starts. The continuous path keeps one utterance owner, preserves source-rate PCM, and uses game-provided Master/Dialogue volume, distance gain, and camera-relative pan. Its Windows browser audio session is separate from the game's own audio, so native occlusion and reverb are not claimed. A game session whose Lua adapter does not advertise continuous playback shows replies as text only (the complete-WAV route is gone, 2026-10-22).

Omni does not stream samples from an unfinished individual inference. Each completed phrase is fed as Float32 24 kHz PCM packets to the continuous renderer (the same lease, pan, distance gain, dialogue makeup and Voice volume as Pocket and Voxtral; its face comes from the streaming face model). One worker owns GPU generation. Local references condition one FP16 CUDA/PyTorch model, with lazy reference preparation and a bounded cache. Selecting OmniVoice begins warm-up from the Settings draft; selecting Convai retires the model after owned work finishes. See [voice preparation](../docs/VOICE_PREPARATION.md) and [source-qualified references](../docs/VOICE_SOURCE_ACTIVATION.md).

Neither producer adds EQ, denoising, silence trimming, or pitch effects. The continuous browser path still uses the operating system's normal output-device mixing. Every voice, the local ones included, plays in that browser chain (Omni no longer has a native positional emitter).

## Captions, faces, and completion

The actual playback clock drives native subtitle progression and facial sampling. Convai's supplied articulation is retargeted into supported Cyberpunk mouth controls; local speech uses timed phonetic cues with the shared native pose improvements. A pause or buffering gap does not advance captions or facial time. Completion waits for the audio tail and matching delivery receipt before a group advances to the next speaker.

Dialogue HUD is the new-user default, with native overhead captions optional. A caption binds the exact speaking copy. Dismissal, cancellation, death, and unload retire that owner. Standard light expressions share the facial writer with speech, while native gaze and blinking remain separate.

See [continuous Convai transport](../docs/CONVAI_AUDIO_STREAMING.md), [local phrase playback](../docs/SPEECH_STREAMING.md), [facial refinement](../docs/LIPSYNC_REFINEMENT.md), and [native subtitles](../docs/OVERHEAD_SUBTITLES.md). Service-only timings or source tests do not establish audible playback or visual acceptance.

## Local diagnostics

The installed adapter's runtime contains:

- `party-connections.json`: game-owned membership and heartbeat.
- `party-connection-state.json`: connection states, setup timing, and retries.
- `bridge-latency.json`: request admission, transport, publication, and observed playback timing.
- `local-voice-state.json`: provider selection, preparation, residency, and actual local device/precision.
- `speech-state.json`: observed native playback state and cursor.

The project-side runtime holds bridge logs, account mappings, player identity, and sessions. Review relevant errors locally and remove credentials, private conversation text, and remote identifiers before sharing a report. This development build has no packaged support-report exporter.

## Development

With the RED4ext launcher installed (`scripts/Install-BridgeAutostart.ps1`), the game starts `scripts/Supervise-ConversationBridge.mjs` hidden. The supervisor uses a bridge already serving the game instead of starting a second one, restarts a crashed bridge with backoff (at most five exits in ten minutes), leaves a bridge stopped by `Stop-ConversationBridge.ps1` stopped, and drains the bridge when the game exits; the game holds the only write end of the supervisor's stdin pipe, so even a game crash closes it. It relies on three bridge behaviors: the `Convai conversation bridge ready` line on stdout, the PID heartbeat in `local-voice-state.json`, and PID-addressed shutdown through `bridge-control.json`. It publishes `runtime/bridge-service.json` in the mod folder, which `mod/service-status.lua` reads to explain a starting, missing or failed service in game. Without the launcher, start through `scripts/Start-ConversationBridge.ps1` and stop through `scripts/Stop-ConversationBridge.ps1`. The launcher rebuilds the browser client, keeps helpers hidden, and refuses a duplicate bridge. Explicitly set `CYBERPUNK_CONVAI_GAME` when the game is outside the development default path. Preserve the runtime state across restarts.

### Executable and prebuilt asset overrides

Set these environment variables before starting the bridge. Explicit overrides
must be absolute filesystem paths; Windows paths must include a drive or UNC
server/share. Empty, relative or control-character values fail validation.

| Variable | Selects | Development default |
|---|---|---|
| `CYBERPUNK_CONVAI_PYTHON` | Python executable used for the owned resident voice worker | `vendor/reference-voicestudio/.venv/Scripts/python.exe` under the project |
| `CYBERPUNK_CONVAI_BROWSER` | Playwright-compatible browser executable; replaces the system browser lookup (a developer override; the Runtime package sets nothing) | Installed Microsoft Edge (`msedge` channel), else Google Chrome (`chrome` channel), else another installed Chromium browser (Brave, Vivaldi, Opera and others, by executable; the registry's App Paths too); then the registry's App Paths, the Windows default browser and the Start menu browser clients; see `system-browser.mjs`. The player's own override is `browser.txt` in `red4ext/plugins/AiNpcCyberpunkMod` in the game folder (no `launcher.ini` is needed, none is shipped; one line, the full path of a Chromium program or its folder), which the Runtime start script reads and passes on as this variable |
| `CYBERPUNK_CONVAI_CLIENT_ASSETS` | Directory containing the prebuilt browser client and continuous PCM modules | Project `runtime/realtime-client.js`, with PCM modules beside `realtime-host.mjs` |

The asset directory must contain these four required files:
`realtime-client.js`, `continuous-pcm-player.mjs`, `continuous-pcm-core.mjs` and
`continuous-pcm-worklet.mjs`. Other files may be present but are never served.
The loopback server retains its existing route allowlist and Host validation;
the browser remains headless with the same audio arguments and lease teardown.
Python still receives the same worker/config arguments over its owned pipe, and
the worker's pinned model, reference hashes and root guards are unchanged.

The choices are captured when each worker/host object is created; restart the
bridge after changing the environment. This is a partial portability step: it
does not create a relocatable Python environment, extract player references,
stage a browser or complete the release bootstrap. The development launcher
still rebuilds the project client, even when the host uses a separately staged
prebuilt asset directory.

Run the focused tests appropriate to a bridge change and `npm run build:voice` for browser-client changes; `npm test` is the combined source suite. Installed MCM/native-source checks need their documented environment. Tests should use isolated fixtures rather than live memory deletion, microphone capture, or production dialogue.

For Lua/catalog changes, `scripts/Install-DevelopmentMod.ps1 -LuaOnly` verifies copied files while the game is running. CET's **Reload All Mods** activates them; loading a save does not. Native script/archive/plugin changes require a game restart. A bridge-source change requires a bridge restart, which rebuilds the client. Game diagnostics use the mod's scoped request-file interface.

When changing a feature, update the [main README](../README.md) and its detailed document. Keep source/test evidence, installed evidence, and user acceptance distinct; unresolved gameplay behavior belongs in the known limitations.
