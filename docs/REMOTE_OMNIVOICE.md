# Remote OmniVoice

2026-10-27, branch `feat/remote-omnivoice`. Settings > Voices > Custom voices.

OmniVoice (the GPU voice) can be rendered by a small **server** on another PC, or on a second graphics card of the same PC, instead of on the card the game is
using. The trigger was a player who runs his language model on a separate AI server: OmniVoice was slow on his gaming PC, and the game lost frames while it
generated on the same card. With Remote OmniVoice on, **nothing of OmniVoice loads on the game PC** (no model, no Python worker, no graphics memory), and the
server does the rendering.

Owner decisions (2026-10-27): no access key (the server is for the player's own network), one address field and a Test button in the mod, GPU choice and listen
address as start options of the server, the reply is **text** when the server cannot be reached (never a cloud voice, never another local voice).

## Steps a player follows

### On the PC that will render the voices (the server PC)

1. Get the **OmniVoice-Server** folder (a release download, or built from an installed mod with `packaging/build-omni-server.mjs`, see "The server folder").
   Put it anywhere, for example `D:\OmniVoice-Server`. The PC needs Windows and an NVIDIA graphics card. No game and no mod are needed on it.
2. Open `Start OmniVoice server.cmd` in Notepad. The four options are explained in plain words at the top:
   - `LISTEN`: `127.0.0.1` (this PC only, the default) or `0.0.0.0` (every PC on the home network). **If the game is on another PC, choose `0.0.0.0`.**
   - `PORT`: `8765`, change it only if another program uses it.
   - `GPU`: `0` for the first graphics card, `1` for the second. `Show graphics cards.cmd` lists the cards with their numbers.
   - `QUALITY`: `16` (fast) or `32` (best), used when the game does not say; the game sends its own Quality setting with every phrase.
3. Save and double-click `Start OmniVoice server.cmd`. A window opens, loads the voice (a minute or more the first time) and prints the address to use
   (`In the game, Settings > Voices > Custom voices > Server address: 192.168.1.20:8765`). Leave the window open. If Windows asks about the firewall, allow it on
   private networks.

### On the game PC

1. Settings > Voices > **Custom voices**. Turn **Remote OmniVoice** on and press Apply.
2. Copy the address from the server window, press **Paste address**. (The mod reads the clipboard once; the address is saved on the game PC only.)
3. Press **Test**: it shows OK with the answer time in milliseconds, the card and the version, or says in words why not (nothing answers, a firewall, it is still
   loading, another version).
4. Nothing else to choose (2026-10-28). With Remote OmniVoice on and an address saved, **every Pocket or OmniVoice choice** under Companion voices is rendered by the server, at the quality of the OmniVoice entry that is saved (Quality, the default, unless you picked another; picking an OmniVoice entry changes it). A cloud voice (Voxtral, the Convai voice) is not replaced. The pack is not needed on this PC. Without the pack the voice lists are written at the next game start once an address is saved, so restart the game once after pasting the address.

The status line on the Custom voices page says whether the server is in use and which voice it speaks with (`Connected. The server speaks with OmniVoice · Quality.`, `Not connected`, `On, but no server address is saved`, or that a cloud voice is chosen, so the server is not used). The Custom voices row is on the Voices page under Companion voices, whatever voice is chosen.

### Same PC, second graphics card

Set `LISTEN=127.0.0.1`, `GPU=1`, and `MOD_FOLDER=` to the installed mod's folder (the one that holds `app`) in a copy of `Start OmniVoice server.cmd`
(`build-omni-server.mjs --launcher-only` makes the three small files). In the game use the address `127.0.0.1:8765`.

## What happens when something goes wrong

| Situation | What the player sees | What the mod does |
| --- | --- | --- |
| Server not started, wrong address, firewall, PC off | the reply is **written text**, one notice "The OmniVoice server cannot be reached. Replies show as text until it answers." | no voice speaks; the mod asks the server again 3 s, 8 s, 20 s, then every 60 s for as long as OmniVoice is wanted; the voice returns by itself at the next idle moment |
| Server still loading its voice | the same (the first replies after a server start are written) | the same retry |
| Server drops in the middle of a reply | that phrase and the rest of the reply are written | the client is marked failed, then the same retry |
| Server's worker crashes | nothing (the server starts it again after 2 s, 5 s, 15 s, then every 30 s, puts the last voices back, the client goes on) | the client sees the new server instance and sends its voices again |
| Server PC has no NVIDIA card that works | Test says the server could not load its voice; the server window says why | not retried by the server (the same on every start) |
| Remote OmniVoice on, no address saved | OmniVoice chosen: OmniVoice cannot speak, replies are written. Pocket chosen: Pocket keeps speaking until an address is saved | nothing starts, no Pocket in place of a chosen OmniVoice |

Never in any of these cases: a cloud voice, Pocket, or a local OmniVoice. No error report is filed (the player's own network is not a bug of the mod).

## Architecture

```
game PC                                                   server PC
CET Lua (mod/remote-omni.lua, manager)                    "Start OmniVoice server.cmd"
   |  runtime/remote-omni-command.json  / -state.json        |
bridge/remote-omni-control.mjs  (address file, Paste, Test)   bridge/omni-server-main.mjs   (options, layout, restart)
bridge/voice-selection.mjs  --remoteOmni-->  bridge/remote-voice.mjs   ==HTTP==>   bridge/omni-server.mjs
   (same routing, text when it fails)           RemoteVoice (surface of ResidentVoice)           |
                                                                                   bridge/resident-voice.mjs  ResidentVoice (unchanged)
                                                                                           |  JSON lines on stdin/stdout
                                                                                   bridge/resident-voice-worker.py  (unchanged) + the OmniVoice pack
```

No voice logic is forked. The server wraps the **same `ResidentVoice`** the game's own route uses and the **same Python worker**; `RemoteVoice` has the surface of
`ResidentVoice` (`start`, `synthesize`, `prepareProfile`, `prepareLanguage`, `setVoices`, `close`, `loaded`, `failure`, `prepared`, `available`), so
`VoiceSelection` and everything above it (phrase cutting, the PCM path `bridge/omni-pcm.mjs`, the face, V's typed lines, the group look-ahead) treat it as the local worker.

### The protocol (`bridge/omni-remote.mjs`, version 1)

HTTP/1.1, keep-alive connections, no key. A phrase is rendered whole by the worker, so (as on the local route, docs/OMNIVOICE_PCM.md) the "chunk" the client
receives is one phrase, as a WAV; the PCM packets are cut on the game PC exactly as for the local worker.

| Request | Body | Answer |
| --- | --- | --- |
| `GET /v1/health` | | `{ok, service, protocol, version, instance, state ready/loading/error, device, gpu, quality, voices, prepared, waiting, restarts, uptimeMs}` |
| `POST /v1/voices` | `{voices: {key: {reference, sha256, transcript} or {status}}, reload?: [key]}` | `{ok, voices, prepared, missing: [{key, sha256}]}` |
| `PUT /v1/clips/<key>?sha256=<hash>` | raw WAV (at most 32 MB) | `{ok}` |
| `POST /v1/prepare` | `{profile, steps?, languageReference?}` | `{ok, ready, prepared, languageReference?, ms}` |
| `POST /v1/synthesize` | `{profile, text, steps?, language?, languageReference?}` | `audio/wav` body; `X-Omni-Timing` header (the worker's timing and the prepared list); `X-Omni-Instance` |

- **Cancel** is closing the connection: a job that has not started never starts (the server's `ResidentVoice` honours the abort signal), one that has finishes in the
  worker, exactly as on the local route. The client serialises its own requests like `ResidentVoice` does (one phrase at a time, the next one queued behind it).
- **Voices.** The game sends its voice table (the same descriptors the local worker is sent). The server's worker checks every clip against its hash. Clips the
  server does not have come back as `missing`: the player's own clips and V's voice (waited for) and, when the server folder has no `voices` folder, the shipped
  clips (sent in the background; a character is spoken once its clip is there). The game sends each with `PUT /v1/clips/<key>`, then asks again with `reload`.
  The server keeps them in `server-data/player-voices/<key>.wav`, and a voice whose clip was sent is read from there whatever folder its descriptor names.
- **Languages.** `languageReference` clips (the multilingual packs) must be in the server's `voices` folder (copy `voices/multilingual`); otherwise the worker answers
  `fallback` and speaks from the English reference, as it does locally for a pack that is missing.
- **Reconnects.** A kept-open connection the server closed meanwhile is replaced once without a failure. Any other connection failure, a timeout (60 s for a phrase,
  3 s to open a connection) or a 503 (loading, restarting) fails the client; the voice service routes to text and starts a new client in the background after the
  waits above (`REMOTE_RETRY_DELAYS_MS`). A server that started again has another `instance`; the client notices it on the next answer and sends its voices again.
- **Test** (`probeOmniServer`): `GET /v1/health` three times (the first opens the connection, the median of the others is the round trip), nothing else; no speech is sent.

### Security (no key by owner decision)

- Listens on **127.0.0.1** unless the player sets `LISTEN` (0.0.0.0 or one IP). The start file says so, and that there is no password.
- Size limits: JSON 256 KB, voice table 8 MB, clip 32 MB (the worker's own limit), text 12,000 characters, at most 16 requests waiting, 2,048 stored clips; an announced
  size over the limit is refused before anything is read.
- Nothing from the game names a file path the server opens. Voices, profiles and clips are **logical keys** (`[a-z0-9-]{1,80}`) and `runtime/...wav` names validated by
  the same registry the local worker uses; a clip is stored only as `<key>.wav` in the server's own player folder after its hash matched; the worker checks the hash again.
- A browser page cannot drive the server: a request with an `Origin` header is refused (403), and POST needs `application/json`.
- The server never logs what was said, and the game never logs the server address (`player-remote-omnivoice.txt` is a state file; the page reads it from `runtime/remote-omni-state.json`).

## The game side

- Setting `remoteOmni` (bool, off by default; `mod/manager.lua`). On: `VoiceSelection.omniFactory` builds a `RemoteVoice` instead of a `ResidentVoice`.
  Nothing local loads for OmniVoice: the pack check, the graphics-card checks (NVIDIA, AMD route, small card, memory), the player's own Python and the local retry delays do not apply.
  A change of the switch or of the address replaces the worker at the next idle moment, like a change of the voice reference.
- OmniVoice entries can be chosen without the pack while the switch is on (saved, or in the same Apply).
- Failure notice: fallback reason `omni-remote` (`VoiceSelection.fallback`, one sentence in `mod/manager.lua`). Local AI's memory planning counts no OmniVoice memory while the switch is on.
- Address file: `player-remote-omnivoice.txt` in the data folder (`address=192.168.1.20:8765`), also fine to write by hand. Commands `paste-address`, `clear-address`, `test` through
  `runtime/remote-omni-command.json`, answers in `runtime/remote-omni-state.json` (`bridge/remote-omni-control.mjs`, `mod/remote-omni.lua`), the same pattern as the Custom provider's page.
- Nothing runs per frame. The state file is read at most every 1.5 s while the Custom voices page is open; no request is made to the server unless the switch is on and OmniVoice is
  the chosen voice, or Test is pressed.

## The server folder

```
OmniVoice-Server/
  Start OmniVoice server.cmd     the options in plain words, then starts the server
  Show graphics cards.cmd        nvidia-smi -L
  README.txt                     the steps above, short
  app/node/node.exe              the Runtime's Node
  app/bridge/                    omni-server-main.mjs, omni-server.mjs and the files they import, resident-voice-worker.py, voice-cuda-graph.py
  app/defaults/local-voices.autobest-long.json
  app/omni/                      the OmniVoice pack whole (Python + PyTorch CUDA, the model, the adapter, notices)
  app/release.json
  voices/picked, voices/archetypes   the shipped reference clips (optional; without them the game sends them)
  server-data/                   created at the first start: voice cache, clips the game sent, server.log
```

`node packaging/build-omni-server.mjs --from "<game>/red4ext/plugins/AiNpcCyberpunkMod" --to "D:/OmniVoice-Server" [--no-voices] [--launcher-only]` assembles it from an installed mod
(everything it copies is what the Runtime and the OmniVoice pack already contain). The server files ship in the Runtime (`packaging/runtime-layout.mjs`), so a mod installed on the
server PC works as a server root too (`MOD_FOLDER`). Zipping and hosting the folder is a release step (suggested place on Hugging Face: `server/`); it was not built or uploaded in this change.

Because the server is layout-compatible with the mod's install, the worker's path rules hold unchanged: model and adapter inside `app`, the voice clips and the cache outside it and apart
from each other, no links inside `app`.

Start options of `bridge/omni-server-main.mjs`: `--listen`, `--port`, `--gpu`, `--quality`, `--root`, `--data`, `--list-gpus`. The graphics card is chosen with
`CUDA_DEVICE_ORDER=PCI_BUS_ID` and `CUDA_VISIBLE_DEVICES` (plus `HIP_VISIBLE_DEVICES` / `ROCR_VISIBLE_DEVICES` for the ROCm route); the AMD route of docs/OMNIVOICE_AMD.md works for the
server too: write the Python in `server-data/omni-python.txt` (same file, same self-test).

## Measured

On the owner's laptop (RTX 4080 Laptop, 2026-10-27, the real worker, 16 steps, server and client on 127.0.0.1, the game closed):

| | local `ResidentVoice` | through the server |
| --- | --- | --- |
| warm phrase, median of 6 (3, 11 and 21 words) | 1,206 ms total, 1,177 ms generation, 30 ms overhead | 1,272 ms total, 1,239 ms generation, 34 ms overhead |
| client start (316 voices, 1 player clip sent) | | 267 ms |
| Test | | 2 ms |

The generation figures differ by run-to-run noise of the card; the transport costs about 4 ms more than the worker pipe on the same PC. Over a LAN add the round trip (about 1 ms on a wire,
a few ms on Wi-Fi) and the transfer of the phrase (a 1.8 s phrase is 85 KB, a 7.4 s one 355 KB: 3 ms on gigabit, 30 ms on a 100 Mbit link). The first sound of a reply is the first
phrase, as on the local route; nothing is buffered on the way.

## Limits

- The worker renders one phrase at a time (no streaming inside a phrase), as locally.
- No key: anyone on the same network can use a server that listens on 0.0.0.0. Home networks only.
- Multilingual voice packs speak from the English reference unless `voices/multilingual` is in the server folder.
- Not tried: a real second PC, a second graphics card, an AMD server (the transport is the same; the owner's PC has one NVIDIA card). The firewall prompt of the first start on a LAN is Windows'.

## Tests

`bridge/omni-server.test.mjs` (the real `ResidentVoice` over a fake worker: start, clips, phrase, Test, unreachable, mid-reply loss, stale connection, cancel, restart, no CUDA, safety limits, options),
`bridge/voice-selection-remote.test.mjs` (routing: no pack, no local checks, text and retry, address changes), `bridge/remote-omni-control.test.mjs`, `bridge/remote-omni-lua.test.mjs` (the page, the setting, the pack rule, the notice),
`packaging/build-omni-server.test.mjs` (closure, files, start file). Live check on the real worker: see "Measured".
