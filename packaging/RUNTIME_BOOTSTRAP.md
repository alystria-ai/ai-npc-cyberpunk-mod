# Runtime service bootstrap

This is an implemented launcher and service owner for a **prepared** runtime
layout. It is not a built Runtime ZIP or a clean-machine qualification. The
release plan still needs portable executable distributions, the production
import closure, local voice relocation/reference preparation and notices.

## Files and paths

Stage these three modules in `CyberpunkConvai/app/bootstrap/`:

- `Runtime-Service.mjs`
- `runtime-layout.mjs`
- `runtime-bootstrap.mjs`

Stage `Start-Runtime.ps1` directly in `CyberpunkConvai/app/`. The app directory
also contains `bridge/`, `assets/`, `characters/`, `research/`, `node/`, `python/`
and `browser/`. The game root is discovered by the exact installed app path;
there is no fixed drive or Steam-library assumption. Portable executables are
declared in `runtime-manifest.json`, never found through PATH. The client assets
are the freshly built `realtime-client.js` and the three continuous PCM modules.

The manifest lists each application file, byte size and SHA-256 explicitly.
`Create-RuntimeManifest.mjs --app <fresh staged app> --recipe <recipe.json>`
generates it from a reviewed file path list. It refuses to overwrite a manifest
and does not scan or copy a directory tree. A recipe supplies `runtimeVersion`,
`scriptsVersion`, `executables` (`node`, `python`, `browser`, each with a `path`)
and `files`, a list of relative paths. The `localVoice` metadata declares the
pinned OmniVoice revision `c5fdb5ccb189668d56333f77ba2629f4cd7535f4`, VoiceStudio
adapter revision `08a1592e3cb9b4c36beef5fa3185ec2313bb1fea`, model directory
`models/omnivoice` and adapter directory `voice/voicestudio/backend`.
`tools.rhubarb` declares `tools/rhubarb/rhubarb.exe` and version `1.14.0`.
All 40 production bridge modules, the player launcher, catalog files,
executables and four browser assets must be included. The bridge module list in
`runtime-layout.mjs` is checked against the actual production import closure by
the source gate. Playwright and Playwright Core 1.58.2 are its only external Node
packages; the manifest requires their entry points, and the final builder must
still include the full reviewed distributions, runtime files and notices. This inventory step does
not grant redistribution permission or prove the chosen binaries work together.

Persistent bridge data goes in `CyberpunkConvai/data/`, outside `app/`.
Existing Lua settings, phone histories and game request/response files stay in
`CyberpunkConvai/runtime/`. Neither directory belongs in an upgrade archive.
The bootstrap does not reset, migrate or synthesize a player ID, memory, history,
bindings, voice configuration or account mapping. Package updates replace app
binaries and leave these two state directories intact. Stop the owned service
before replacing application binaries. Scripts/Runtime compatibility versions
are present in the manifest; a Lua-side compatibility handshake is still pending.
The manifest also rejects the private `characters.json`,
`relationship-profiles.json` and `local-voices.json` setup files under any app
subdirectory. The reviewed `bridge/player-memory.mjs` is application source;
similarly named player memory JSON or backup files are excluded.

The bootstrap passes these absolute path overrides to the production bridge:

| Override | Installed target |
|---|---|
| `CYBERPUNK_CONVAI_PYTHON` | Declared `app/python/` executable |
| `CYBERPUNK_CONVAI_BROWSER` | Declared `app/browser/` executable |
| `CYBERPUNK_CONVAI_CLIENT_ASSETS` | `app/assets/` |
| `CYBERPUNK_CONVAI_OMNI_MODEL` | `app/models/omnivoice/` |
| `CYBERPUNK_CONVAI_OMNI_ADAPTER` | `app/voice/voicestudio/backend/` |
| `CYBERPUNK_CONVAI_OMNI_REFERENCES` | `data/voice-references/` |
| `CYBERPUNK_CONVAI_OMNI_CACHE` | `data/voice-studio-data/` |
| `CYBERPUNK_CONVAI_RHUBARB` | `app/tools/rhubarb/rhubarb.exe` |
| `CYBERPUNK_CONVAI_LIPSYNC_WORK` | `data/lipsync-work/` |

The four OmniVoice overrides travel together. Persistent voice configuration
retains the existing logical `runtime/voice-references/` paths; the worker maps
that namespace to the installed data directory while preserving hashes and exact
transcripts. The reference extraction/first-run preparation path remains pending.

## Setup and launch

The first run checks for the user's `data/convai-key.txt`, containing
`api-key=...`, and `data/characters.json`, containing an approved profile-key to
Convai character-ID mapping. These are local setup files, never bundled developer
credentials or automatic character provisioning. Missing setup produces
`setup-required` with the missing field names in `data/service-status.json`.
The full first-run settings UI and service autostart from the mod are still
pending; the current launcher is explicit and does not install a service or a
scheduled task.

Start the prepared service while Cyberpunk is running:

```powershell
.\Start-Runtime.ps1
.\Start-Runtime.ps1 -Action status
.\Start-Runtime.ps1 -Action stop
```

PowerShell launches its packaged Node supervisor hidden. The supervisor launches
only its bridge child with `windowsHide`, `shell: false`, explicit paths and
private append-only logs. It clears inherited Node import/Python path overrides.
The production bridge keeps owning its browser and resident voice worker through
their existing lifecycle; the bootstrap starts no extra model process.

The supervisor reports Ready only after the new bridge prints its readiness
marker. It follows the game PID **and creation time**. Closing the game or
starting a different game process sends the existing bridge's PID-addressed
shutdown command, which drains local speech and releases workers. A stop during
Checking cancels streamed file verification/setup before creating any bridge,
browser or model worker. A stop during imports is repeated until the bridge sees
it. A long render keeps the same owner
and Stopping status while shutdown finishes; there is no forced GPU-process kill.

One exclusive owner record prevents concurrent launchers sharing the same data
directory. A recent live bridge heartbeat also rejects an independently started
bridge already using the game. A crashed supervisor with a live bridge is
reported as Orphaned; no PID is guessed or killed. After both recorded processes
have exited, `-Action recover` can remove only the stale ownership record. It
never clears player state or resumes an old worker. Malformed/ambiguous owner
records require explicit inspection rather than automatic deletion.

## Development fallback

Source checkout use is explicit:

```powershell
.\packaging\Start-Runtime.ps1 -DevelopmentProjectDirectory $PWD `
  -GameDirectory 'D:\Games\Cyberpunk 2077' -StateDirectory 'D:\Convai dev state'
```

Only this mode permits global Node and the existing development Python/Edge
fallbacks. It does not rebuild the browser bundle; use the established build
helper first. Packaged mode never falls back to a developer environment when a
file is missing. `Runtime-Service.mjs check` verifies files/setup without
starting a bridge, browser, model or game process.

## Current qualification and limits

The isolated tests exercise relocated paths with spaces/non-ASCII characters,
Windows paths ending in a separator, hash failure, traversal/private-state rejection, startup races, exact-child
graceful stop, game identity changes, stale owner recovery and preservation of
private data. Their fixture speech service is CPU-only and creates no provider
traffic. Executable-path selection is tested with a prepared fixture manifest;
this does not establish that a portable Python/CUDA/browser distribution works
on a clean Windows installation.

The worker accepts the declared app/data separation without changing model
precision, steps, conditioning audio or transcript hashes. Portable Python must
contain a regular `python/Lib/site-packages/omnivoice` package, including
`models/omnivoice.py` and its required source/data closure. An editable `.pth`
pointing into the developer checkout is not supported; portable mode rejects
missing/outside-app Omni imports before CUDA admission. The manifest requires
the package entry/model source and `bridge/voice-cuda-graph.py`; the final builder
must still list the complete Python/adapter dependency closure and notices.

This source integration is not a portable Python/CUDA/browser build. References
must still be prepared from each user's installed game, and the first-run setup,
mod autostart, Lua compatibility handshake and clean-machine acceptance remain.

Run `npm run test:runtime` for the combined bootstrap, resident worker, reference
registry and phonetic relocation gate. The Python reference/path fixtures are
also run through the worker suite without importing CUDA. The current bridge
import closure is explicit in `release-plan.json`; no broad bridge/vendor/runtime
directory copy is a release recipe. The adapter's normal OmniVoice load path
also requires `services/model_manager.py`, `core/config.py` and
`utils/containment.py`, with further routing, preferences and failure helpers.
Packaging only `services/tts_backend.py` would be incomplete. The minimal Python
source/wheel/DLL closure and corresponding notices still need a fresh portable
build and acceptance test.
