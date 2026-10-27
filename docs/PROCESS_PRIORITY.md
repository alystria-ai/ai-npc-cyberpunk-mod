# Process priority

Owner decision, 27 Oct 2026: **everything on the path from V's words to the first sound of the reply runs at High Windows priority** (`HIGH_PRIORITY_CLASS`, never Realtime), so a game that keeps every core busy cannot make a reply wait. Latency comes first. Work nobody waits for stays at normal or below.

The code is `bridge/process-priority.mjs` (one rule, one place for the level), used by each process below.

## Why

A process at normal or below-normal priority gets what the game leaves over, and the game's foreground threads also get longer time slices. Earlier reports showed the effect (a Pocket reply 5 to 7 s before the first sound, a Local AI model that loaded for minutes at below normal, an OmniVoice worker on an AMD card that was lowered on purpose and so was slow). A voice worker, the model server, the speech recogniser and the audio browser do real work only while a turn is running, so High costs the game nothing while idle; the price is paid only in the seconds a reply is being made.

## If the game stutters (the player's way back)

Create `priority.txt` in the mod's data folder (the folder that holds `omni-python.txt`: `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`) with one line:

```
priority = normal
```

Restart the game. `normal` restores the earlier rule: workers are raised to normal while they work, the OmniVoice worker and the bridge keep the priority they start with, nothing is set to High. `priority = below` is the same as `normal` for every process except the OmniVoice worker, which it lowers below normal. `priority = high` states the default. A line starting with `#` is a comment. For a developer, the environment variable `CYBERPUNK_CONVAI_PRIORITY` (`high`, `normal`, `below`) overrides the file.

The OmniVoice worker alone can also be set in `omni-python.txt` (`priority = high | normal | below` on its own line after the python.exe line, docs/OMNIVOICE_AMD.md). That line wins over `priority.txt` for the OmniVoice worker.

The bridge log (`bridge.stderr.log`) says what was applied: `[Priority] conversation service: high`, `hidden browser priority: high for N processes`, `[LocalVoice] [priority] high` (the OmniVoice worker setting itself; `could not be set to high (Windows error N)` if Windows refused), `[PocketStart] ... worker started (pid N, priority high)`, `[LocalAI] [local] llama-server (pid N) process priority high while it loads and while a turn waits`, and the supervisor's `The bridge runs at high priority.` (`bridge-service.log`). The speech recognition worker's stderr is not logged. Live on 27 Oct the OmniVoice worker printed `could not be set to high`: its `SetPriorityClass` call passed `GetCurrentProcess()` (the pseudo-handle -1) through ctypes' default 32-bit int, so Windows saw 0xFFFFFFFF and answered ERROR_INVALID_HANDLE (6). The handle is now declared pointer-sized (`c_void_p`) in `resident-voice-worker.py` and `local-stt-worker.py` (whose own calls had failed silently the same way; the bridge's by-pid call had worked); the Pocket worker already did.

## How it is set

Always both ways, best effort (a refusal is logged and never fails a start):

1. the parent sets the child it spawned (`os.setPriority`, Node's `PRIORITY_HIGH`; never `PRIORITY_HIGHEST`, which Windows maps to Realtime);
2. the worker sets itself when its environment says so (`CYBERPUNK_CONVAI_WORKER_PRIORITY=high`), because a venv's `python.exe` is a launcher whose child is the real interpreter, so the parent's pid is not the worker's.

A child does not inherit High from a High parent (Windows gives a new process normal priority unless the parent is below normal), so every process is set explicitly.

## The processes

| Process | On the turn path? | Priority | Where |
|---|---|---|---|
| Conversation service (the bridge `node.exe`: routing, text providers, Mistral and Voxtral clients, Convai client glue, the facial-model worker thread) | yes | **High**, for good. Set by the supervisor right after it spawns the bridge, and by the bridge on itself at its start. | `bridge/bridge-supervisor.mjs` `prioritize`, `bridge/convai-bridge.mjs` |
| Hidden browser (Chromium: plays every reply, runs the Convai connection, hears the microphone) | yes | **High** for the whole tree (browser, GPU and audio service, one renderer per page), set after the start and again after each page opens (joined, at most one PowerShell call per 4 s, off the turn path). Chromium's own backgrounding is already off. | `bridge/realtime-host.mjs` `keepBrowserPriority`, `BrowserPriority` |
| OmniVoice worker | yes | **High** from its start and for good, on NVIDIA and AMD alike. | `bridge/resident-voice.mjs` (`priority`), `bridge/resident-voice-worker.py` `apply_own_priority`, docs/OMNIVOICE_AMD.md |
| Local AI model server (llama.cpp; also the Mature model: the same server, every start path goes through `LocalLlmServer.#startOnce`) | yes | **High** while it loads (a cold start is a reply waiting) and while a turn waits on it (`raise()`, held 5 s after the last request); below normal when ready and idle, as before. A persona warm-up and memory work (`begin({background: true})`) never raise it. | `bridge/local-llm-server.mjs` (`raiseLevel`) |
| Pocket voice worker | yes (when Pocket is the voice) | **High** from its spawn and while a reply, or a voice a reply waits for, is being made; a voice prepared ahead of time runs below normal. Back to below normal 3 s after the last request. | `bridge/pocket-voice.mjs`, `bridge/pocket-voice-worker.py` `PriorityGate` |
| Local speech recognition worker (English Moonshine and the language packs) | yes | **High** from its spawn and for good (idle it costs nothing). | `bridge/local-stt.mjs` (`priority: 'high'`), `bridge/local-stt-worker.py` |
| Microphone capture | yes | Runs in the hidden browser (above). | `bridge/mic-tap.mjs`, `bridge/local-stt-capture.mjs` |

Not on the path, left as they were (normal or below):

| Process | Priority | Why |
|---|---|---|
| Embedder (a small llama-server on the CPU) | below normal; raised to normal only for a query | embeddings and memory retrieval are mostly background work; a query is a few milliseconds |
| Memory extraction and persona warm-ups (they run in the model server, with `background: true`) | never raise the model server | nobody waits |
| Phone-analysis worker (`resident-phone-analysis.mjs`) | normal | lip-sync data, not the audio path |
| Screen-capture helper (`CyberpunkConvaiVision.exe`) | below normal (set by the helper itself) | a rolling buffer; a capture must never compete with the game |
| Voice-pack/setup probes (own-Python self-test, graphics-memory and VRAM-fit probes, the audio-output probe, the PowerShell child registry) | normal or below | one-off checks |
| Error-report upload, model and pack downloads, the voice-client build | normal | not on the path |
| The supervisor and the RED4ext launcher | normal | watchdog and start-up only |
| The game's native plug-in file-IO thread | below normal (inside the game process) | not a process of ours to change |

## Tests

`bridge/process-priority.test.mjs` (the levels, `priority.txt`, High is never Realtime, the browser tree script and its joined requests), `bridge/resident-voice.test.mjs`, `bridge/voice-selection.test.mjs` and `bridge/omni-own-python.test.mjs` (OmniVoice on both routes, the file line wins), `bridge/pocket-voice.test.mjs`, `scripts/test_pocket_voice_runtime.py`, `bridge/local-stt.test.mjs`, `bridge/local-stt-worker.check.py`, `scripts/test_resident_voice_paths.py`, `bridge/local-turn-diagnostics.test.mjs` and `bridge/local-llm-server.test.mjs` (the model server at High on the first start, a restart, a step-down and a switch), `bridge/bridge-supervisor.test.mjs`, `bridge/realtime-host-sandbox.test.mjs`. Not verified in the game: whether High changes the frame rate of a game that already uses every core.
