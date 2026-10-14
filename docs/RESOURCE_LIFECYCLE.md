# Resource lifecycle: what is loaded, when, and when it goes

The rule (user, 2026-10-14): **if something is not being used it should be de-loaded.** FPS and reply latency come first, and the laptop is
often in Silent mode, so a model that sits in RAM or VRAM, or a process that wakes up every minute, for a feature the settings do not use
is a cost with no benefit. This page is the inventory (audit of 2026-10-14, branch `unload-unused`): every loader in `bridge/`, what starts
it, what must end it, and how that is checked. `mod/` starts nothing of its own (it only reads and writes files); every process below is
the bridge's.

Release is always one of three kinds. **At once** when a setting turns the feature off or another choice replaces it. **After a grace
period** where the setting is toggled often or the reload is slow (a short Off must not cost a 45 s reload). **After an idle time** where
the thing is used in bursts and reloading is cheap. Nothing here runs per frame: every check is due-checked on the bridge's existing 500 ms
settings poll (a few property reads) or is a single timer. The cloud-voice rule still holds: **Voxtral or Inworld chosen means no Pocket,
no OmniVoice, no worker of any kind**, not even as a backup (`bridge/voice-selection.mjs`, `targetBackend`).

## The table

"Test" names the file under `bridge/`; "Live" is the check to make with Task Manager or `runtime/bridge.stderr.log` (see the end).

| Resource | Loads when | Released when | Idle timeout? | Verified |
|---|---|---|---|---|
| **Pocket TTS worker** (Python, CPU; `pocket-voice.mjs`) | The committed (or settings-draft) voice is Pocket; with playback On | Another voice is chosen (exit confirmed through EOF, then the process tree is killed if it stays; the next worker waits for it); a cloud voice is chosen; **voice playback Off for 2 min (new)**; bridge shutdown | Only the playback grace (`MUTED_RELEASE_MS`, 120 s). Not an idle timer: a voice that is on is used in every conversation. Reload takes seconds | `voice-selection.test.mjs` (retire on every switch), `resource-lifecycle.test.mjs` (muted) |
| **OmniVoice worker** (Python, GPU; `resident-voice.mjs`) | The committed (or draft) voice is OmniVoice and the pack is installed; playback On | Another voice or reference is chosen; a cloud voice is chosen; **playback Off for 2 min (new)**; shutdown. A background retry worker is dropped for another reference, another voice or playback Off (new) | Playback grace only. A reload takes about 45 s, so no shorter timer fits | `voice-selection.test.mjs`, `resource-lifecycle.test.mjs` |
| **V's helper Pocket worker** (Python, CPU; `v-helper-voice.mjs`) | OmniVoice is committed and loaded, V's voice is On, the V clips exist and playback is On; after Omni is ready, never beside its load | **At once**: V's voice Off or no clips; the voice is not OmniVoice (Pocket, any cloud voice, Convai); playback Off; before any other Pocket worker starts (one work-folder lock, exit confirmed); a failure; shutdown | None needed: immediate on every condition | `v-helper-voice.test.mjs` (nine cases, including V off and a muted playback) |
| **V's voice engine** (`v-voice.mjs`) | It is logic only (no process, no model); it uses the voice the player chose | n/a. **V's line is silent while playback is Off (new)**, so no worker and no cloud request is made for it | n/a | `resource-lifecycle.test.mjs` (bridge wiring) |
| **V's line renderer page** (a second page in the hidden browser) | The composer opens with V's voice On and a usable voice | **V's voice Off or no clips; playback Off (new)**; never while it owns a line | None | `resource-lifecycle.test.mjs` (`releaseRendererPages`) |
| **Local AI** (`llama-server`, GPU; `local-llm-server.mjs`) | Local AI is chosen (loaded ahead on choosing it), or an add-on remark needs it | The provider leaves Local AI (at the idle boundary); the choice is withdrawn before it was applied; **10 idle minutes**; shutdown (stop waits for exit, kills if needed) | Yes, 10 min (already). A longer wait is a reload with a shader warm-up, so it stays | `local-llm-server.test.mjs`, `mistral-key.test.mjs` (provider switch), `resource-lifecycle.test.mjs` |
| **Memory embedder** (`llama-server`, CPU, 1 thread; `local-embed.mjs`) | The first memory search or write of a text provider | 5 idle minutes; **at once when the provider goes back to Convai and no add-on is installed (new)**; shutdown | Yes, 5 min (already) | `local-embed.test.mjs`, `mistral-key.test.mjs` |
| **Local speech recogniser** (Python, CPU; `local-stt.mjs`) | A recording starts (nothing warms it) | 90 s after the last recording; shutdown now **waits for the exit and kills the process tree** (new: it only fired a kill timer before) | Yes, 90 s (already) | `local-stt.test.mjs`, `resource-lifecycle.test.mjs` |
| **Microphone capture page** (`local-stt-capture.mjs`) | The first recording through the recogniser | **With the recogniser's idle exit (new)**; with the browser; shutdown (it stayed open for the life of the browser before) | Same 90 s | `resource-lifecycle.test.mjs` |
| **Hidden browser (Edge)** and its pages (`realtime-host.mjs`) | First use: a Convai turn or warm-up, the local voice's warm-up, a recording | A provider switch, a key switch or a world reset closes it (already; the local voice reopens it at once). **Idle 5 min (new)**: no Convai page in the pool, no recording, no renderer turn, nothing used it; a text provider with playback On keeps the renderer warm instead. The renderer pages close as above | Yes, 5 min (`BROWSER_IDLE_MS`). A start costs about 0.8 s plus about 1 s for the page, and a composer warm-up pays it before the first reply | `resource-lifecycle.test.mjs`, `realtime-rewarm.test.mjs` |
| **Facial model** (worker thread, 3.6 MB weights plus the text model; `jali-face.mjs`) | Bridge start (the files exist) | **Playback Off for 2 min (new)**: the thread is terminated; it loads again at the first poll after playback is On (a fraction of a second). Never cut off an analysis in flight; shutdown | Playback grace only | `resource-lifecycle.test.mjs` (real worker) |
| **Phone-analysis worker** (Python, CPU; `resident-phone-analysis.mjs`) | Only without the facial model, with Pocket speaking and playback On | `setWanted(false)` retires it as soon as Pocket stops speaking or playback is Off (already) | None needed | `resident-phone-analysis.test.mjs` |
| **Rhubarb** (`phonetic-lipsync.mjs`) | One short process per analysed phrase | Exits with the phrase | n/a | `phonetic-lipsync.test.mjs` |
| **Mature safety check** (`mature-guard.mjs`) | Not a model: regular expressions compiled on first use (about 1 s, warmed when Mature turns on) | Nothing to unload (a few KB). The uncensored chat models are Local AI's `llama-server` above | n/a | `mature-guard.test.mjs` |
| **Add-on voices** (`addons.mjs`, `addon-voice.mjs`) | An add-on speaker has no worker of its own: it speaks through the player's chosen voice, and its text comes from Mistral or the local AI | The voice and model rows above apply. The add-on poll and the stock timer exist only while an add-on is installed and wants stock | n/a | `addons.test.mjs`, `addon-stock.test.mjs` |
| **Inworld and Voxtral clients** (`inworld-voice.mjs`, `voxtral-voice.mjs`) | Stateless HTTPS requests per reply; no process, no model, no open socket between replies. A per-character reference clip is cached in memory | Nothing is held | n/a | `inworld-voice.test.mjs`, `voxtral-voice.test.mjs`, `v-helper-voice.test.mjs` (no local worker beside them) |
| **Convai connections** (pages in the hidden browser) | Convai is the provider and a character is warmed or speaking | A provider switch closes every page (already); with Mistral or Local AI no connection is opened at all (`attachTextProvider` answers warm-ups itself) | No: the party's pages are the feature in use | `text-provider-host.test.mjs`, `realtime-rewarm.test.mjs` |
| **Audio-output probe** (hidden PowerShell, wakes every 60 s; `audio-delay.mjs`) | The first turn, while the lip-sync delay is Automatic | **A hand-set delay, or playback Off (new)**; shutdown | None needed | `audio-delay.test.mjs`, `resource-lifecycle.test.mjs` |

## Timers and watchers that stay (audited, not changed)

- The bridge's eleven interval timers (50 ms request, 150 ms microphone, prefetch and phone, 60 ms look-ahead, 500 ms settings, knowledge,
  memory, support and editor) are single file reads that wake the features that are on by default. The look-ahead poll returns at once
  unless Convai is the provider. They hold no model, no process and no memory, and a missed wake would delay a turn; they were left alone.
- `TokenSource` (sign-in backend) renews a Convai token about every hour with one small request. It is unused while a text provider is
  chosen, but pausing it would make the first Convai turn after a switch wait for a token; left as is.
- The file watcher on `runtime/` (`file-wake.mjs`) is a non-persistent OS watcher; the add-on watchers exist only with add-ons.

## Trade-offs the user can change

- `MUTED_RELEASE_MS` (`bridge/voice-selection.mjs`, 120 000): how long playback must stay Off before the voice workers and the facial
  model go. At 0 the release is at the click; OmniVoice then costs about 45 s to load after every unmute. A game that **starts** with
  playback Off never loads a worker.
- `BROWSER_IDLE_MS` (`bridge/convai-bridge.mjs`, 300 000): the idle time before the hidden browser closes.
- Local AI keeps its 10-minute idle unload and the embedder its 5-minute one (unchanged).

## Exit and lock discipline

Every worker's release is awaited: Pocket and the V helper retire through confirmed EOF/exit (`taskkill /T` on Windows, because the venv's
`python.exe` is a launcher); a new Pocket worker starts only after the old one, and the V helper before it, have exited (the work folder has
one lock). OmniVoice, the phone-analysis worker and the facial thread are closed by the voice service's `close()`, which the bridge's
`shutdown()` awaits together with the recogniser (now awaited too), both model servers and the browser. The model servers also have a
synchronous kill on process exit (`killSync`).

## Live checks (Task Manager, Details tab, or the bridge log)

1. **V's helper**: with an OmniVoice voice and V's voice On, one extra `python.exe` (about 400 MiB, CPU) appears after OmniVoice is ready
   (`[VHelper] ... is ready`). Turn V's voice Off in Settings: the extra process is gone within about a second
   (`runtime/bridge.stderr.log` has no new line; the process count is the evidence). Turn it On again and it returns.
2. **Playback Off**: with Pocket or OmniVoice loaded, turn Voice playback Off and wait 2 minutes: the voice's `python.exe` exits, GPU
   memory drops (OmniVoice), `runtime/local-voice-state.json` says `"state": "stopped"` and `"resident": false`. Turn it On: the worker
   loads again (a Pocket `python.exe` within seconds; OmniVoice about 45 s) and the status goes back to Ready. Turn Off then On inside
   2 minutes: nothing is released.
3. **Browser**: with a text provider and playback Off (or Convai with nobody in the party), after 5 idle minutes the hidden `msedge.exe`
   tree is gone; the next composer opening starts it again.
4. **Recogniser**: record once with Mistral or Local AI; 90 s later its `python.exe` is gone, and with it the microphone page.
5. **Provider back to Convai**: the CPU `llama-server` (embedder) and the Local AI `llama-server` are gone at once (no add-on installed).
6. Task Manager after quitting the game: no `python.exe`, `llama-server.exe`, `msedge.exe` or `powershell.exe` of the bridge is left.
