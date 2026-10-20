# Resource lifecycle: what is loaded, when, and when it goes

The rule (user, 2026-10-14): **if something is not being used it should be de-loaded.** FPS and reply latency come first, and the laptop is
often in Silent mode, so a model that sits in RAM or VRAM, or a process that wakes up every minute, for a feature the settings do not use
is a cost with no benefit. This page is the inventory (audit of 2026-10-14, branch `unload-unused`): every loader in `bridge/`, what starts
it, what must end it, and how that is checked. `mod/` starts nothing of its own (it only reads and writes files); every process below is
the bridge's.

Release is one of two kinds. **At once** when a setting turns the feature off or another choice replaces it (user decision, 2026-10-14,
for voice playback: "if they turn it off it should not be loaded"; there is no grace period). **After an idle time** where the thing is
used in bursts and reloading is cheap.

**Voice playback Off silences the companions, not V.** With playback Off the companions' voice worker (Pocket or OmniVoice) is released
on the poll that reads the setting. V's typed line is spoken whenever V's voice setting is On ("if the setting for V voice is on he should
speak"), so exactly what V's own engine needs stays loaded and nothing more (2026-10-17: V has an engine of its own, Settings > Voices >
V's voice engine, Pocket by default or Voxtral, whatever voice the companions use). Engine Pocket: with a Pocket companion voice, that
Pocket worker; with any other companion voice (OmniVoice, a cloud voice, the Convai voice) V's own Pocket worker (CPU) alone, and OmniVoice
itself is released. Engine Voxtral: nothing local (V's line is one HTTPS request to the Voxtral voice, spoken as V's cloned reference,
exactly as with playback On). V's line renderer page stays; the companions' page, the facial model and the audio probe go. With V's voice
also Off, nothing voice-related stays loaded.

Nothing here runs per frame: every check is due-checked on the bridge's existing 500 ms
settings poll (a few property reads) or is a single timer. The cloud-voice rule still holds: **Voxtral chosen for the companions
means no Pocket, no OmniVoice, no worker of any kind for them**, not even as a backup (`bridge/voice-selection.mjs`, `targetBackend`). The one
Pocket worker that can exist beside them is the one the player asked for by choosing Pocket as V's voice engine: it is V's alone, never
speaks for a companion, and with V's engine on Voxtral (or V's voice Off) no Pocket worker loads at all.

## The table

"Test" names the file under `bridge/`; "Live" is the check to make with Task Manager or `runtime/bridge.stderr.log` (see the end).

| Resource | Loads when | Released when | Idle timeout? | Verified |
|---|---|---|---|---|
| **Pocket TTS worker** (Python, CPU; `pocket-voice.mjs`) | The committed (or settings-draft) voice is Pocket; with playback On, or with playback Off while V's voice is On with the Pocket engine (V's line uses it) | Another voice is chosen (exit confirmed through EOF, then the process tree is killed if it stays; the next worker waits for it); a cloud voice is chosen; **voice playback Off, at once, unless V's voice is On (new)**; V's voice turned Off while playback is Off; bridge shutdown | None. Not an idle timer: a voice that is on is used in every conversation. Reload takes seconds | `voice-selection.test.mjs` (retire on every switch), `resource-lifecycle.test.mjs` (playback Off, with and without V) |
| **OmniVoice worker** (Python, GPU; `resident-voice.mjs`) | The committed (or draft) voice is OmniVoice and the pack is installed; playback On | Another voice or reference is chosen; a cloud voice is chosen; **playback Off, at once (new; V's helper below takes over V's line)**; shutdown. A background retry worker is dropped for another reference, another voice or playback Off (new) | None. A reload takes about 45 s, which is the price of turning playback back On (user decision) | `voice-selection.test.mjs`, `resource-lifecycle.test.mjs` |
| **V's own Pocket worker** (Python, CPU; `v-helper-voice.mjs`) | V's voice is On, V's engine is **Pocket**, the V clips exist and the companions' voice is **not** the Pocket worker itself: OmniVoice, a cloud voice (Voxtral) or the Convai voice (2026-10-17: a cloud or Convai companion voice now loads it too, when the player picked Pocket for V). With OmniVoice and playback On it starts after Omni is ready (never beside its load) and a running one is kept while Omni loads again; **in every other case, and with playback Off, it starts at once and may be the only voice worker loaded** | **At once**: V's voice Off or no clips; **V's engine changed to Voxtral**; the companions switch to the Pocket voice (their worker speaks V then); a settings preview that warms the Pocket voice (V's worker leaves first, comes back after the previewed one has exited); before any other Pocket worker starts (one work-folder lock, exit confirmed); a failure; shutdown. **Not** released by playback Off | None needed: immediate on every condition | `v-helper-voice.test.mjs` (every combination: OmniVoice, Convai voice, cloud voice, playback Off, a preview, the switch to Pocket) |
| **V's voice engine** (`v-voice.mjs`) | It is logic only (no process, no model); V's engine is its own setting (Pocket or Voxtral) | n/a. **V's line is spoken with playback Off whenever V's voice is On**: engine Pocket: the companions' Pocket worker when they use Pocket, otherwise V's own Pocket worker; engine Voxtral: one HTTPS request to the Voxtral voice, no local model | n/a | `resource-lifecycle.test.mjs` (bridge wiring), `v-helper-voice.test.mjs`, `v-voice.test.mjs` |
| **V's line renderer page** (a second page in the hidden browser) | The composer opens with V's voice On and a usable voice | **V's voice Off or no clips (new)**; never while it owns a line. Playback Off no longer closes it | None | `resource-lifecycle.test.mjs` (`releaseRendererPages`) |
| **Local AI** (`llama-server`, GPU; `local-llm-server.mjs`) | Local AI is chosen (loaded ahead on choosing it), or an add-on remark needs it | The provider leaves Local AI (at the idle boundary); the choice is withdrawn before it was applied; **10 idle minutes**; shutdown (stop waits for exit, kills if needed) | Yes, 10 min (already). A longer wait is a reload with a shader warm-up, so it stays | `local-llm-server.test.mjs`, `mistral-key.test.mjs` (provider switch), `resource-lifecycle.test.mjs` |
| **Memory embedder** (`llama-server`, CPU, 1 thread; `local-embed.mjs`) | The first memory search or write of a text provider | 5 idle minutes; **at once when the provider goes back to Convai and no add-on is installed (new)**; shutdown | Yes, 5 min (already) | `local-embed.test.mjs`, `mistral-key.test.mjs` |
| **Local speech recogniser** (Python, CPU; `local-stt.mjs`) | A recording starts (nothing warms it) | 90 s after the last recording; shutdown now **waits for the exit and kills the process tree** (new: it only fired a kill timer before) | Yes, 90 s (already) | `local-stt.test.mjs`, `resource-lifecycle.test.mjs` |
| **Microphone capture page** (`local-stt-capture.mjs`) | The first recording through the recogniser | **With the recogniser's idle exit (new)**; with the browser; shutdown (it stayed open for the life of the browser before) | Same 90 s | `resource-lifecycle.test.mjs` |
| **Hidden browser (Edge)** and its pages (`realtime-host.mjs`) | First use: a Convai turn or warm-up, the local voice's warm-up, a recording | A provider switch, a key switch or a world reset closes it (already; the local voice reopens it at once). **Idle 5 min (new)**: no Convai page in the pool, no recording, no renderer turn, nothing used it; a text provider with playback On keeps the renderer warm instead. The renderer pages close as above | Yes, 5 min (`BROWSER_IDLE_MS`). A start costs about 0.8 s plus about 1 s for the page, and a composer warm-up pays it before the first reply | `resource-lifecycle.test.mjs`, `realtime-rewarm.test.mjs` |
| **Facial model** (worker thread, 3.6 MB weights plus the text model; `jali-face.mjs`) | Bridge start (the files exist) | **Playback Off, at once (new)**: the thread is terminated (V's line has no face); it loads again at the first poll after playback is On (a fraction of a second). Never cut off an analysis in flight; shutdown | None | `resource-lifecycle.test.mjs` (real worker) |
| **Phone-analysis worker** (Python, CPU; `resident-phone-analysis.mjs`) | Only without the facial model, with Pocket speaking and playback On | `setWanted(false)` retires it as soon as Pocket stops speaking or playback is Off (already) | None needed | `resident-phone-analysis.test.mjs` |
| **Rhubarb** (`phonetic-lipsync.mjs`) | One short process per analysed phrase | Exits with the phrase | n/a | `phonetic-lipsync.test.mjs` |
| **Mature safety check** (`mature-guard.mjs`) | Not a model: regular expressions compiled on first use (about 1 s, warmed when Mature turns on) | Nothing to unload (a few KB). The uncensored chat models are Local AI's `llama-server` above | n/a | `mature-guard.test.mjs` |
| **Add-on voices** (`addons.mjs`, `addon-voice.mjs`) | An add-on speaker has no worker of its own: it speaks through the player's chosen voice, and its text comes from Mistral or the local AI | The voice and model rows above apply. The add-on poll and the stock timer exist only while an add-on is installed and wants stock | n/a | `addons.test.mjs`, `addon-stock.test.mjs` |
| **Voxtral client** (`voxtral-voice.mjs`) | Stateless HTTPS requests per reply; no process, no model, no open socket between replies. A per-character reference clip is cached in memory | Nothing is held | n/a | `voxtral-voice.test.mjs`, `v-helper-voice.test.mjs` (no local worker beside it) |
| **Convai connections** (pages in the hidden browser) | Convai is the provider and a character is warmed or speaking | A provider switch closes every page (already); with Mistral or Local AI no connection is opened at all (`attachTextProvider` answers warm-ups itself) | No: the party's pages are the feature in use | `text-provider-host.test.mjs`, `realtime-rewarm.test.mjs` |
| **Vision helper** (`CyberpunkConvaiVision.exe`, native, CPU, below-normal priority, about 35 to 50 MiB; `vision-capture.mjs`, `companion-vision.mjs`; `docs/COMPANION_VISION.md`) and its **frame buffer** (at most 4 JPEGs of about 40 KB, in memory only) | Only while it captures: Convai answers (always on with Convai, no setting) **and** a party member or a character V may talk to is near **and** no conversation is running (nor for 12 s after one). Then one picture every 3 s | **At once** (next 500 ms poll) when any of those stops: Mistral or Local AI, nobody near, a conversation starts. Never mid-capture. The buffer is dropped with the provider; frames older than 2 min are never sent. Shutdown: `quit` on stdin, killed after 1 s | Not needed: it never idles. A start costs about 0.2 to 0.4 s, off the turn's path | `companion-vision.test.mjs` (unload rule: provider, nobody near, conversation and its tail) |
| **Audio-output probe** (hidden PowerShell, wakes every 60 s; `audio-delay.mjs`) | The first turn, while the lip-sync delay is Automatic | **A hand-set delay, or playback Off (new)**; shutdown | None needed | `audio-delay.test.mjs`, `resource-lifecycle.test.mjs` |

## Nearby characters: no GPU work for a character nobody has spoken to (audit of 2026-10-19, branch `fix/idle-gpu`)

Report (Mei1429, 0.2.1, OmniVoice Ultra): "about 3x GPU usage even with no companions and nothing in use". Measured with the game closed
(Windows `GPU Engine` counters per process, 2 s samples, 75 s idle windows, other GPU users on the machine excluded by process id):

| Idle, loaded the way the product loads it | GPU engine use |
|---|---|
| OmniVoice worker (model, CUDA graph, 3 voices warm, two renders made first), about 2.5 GB resident | 0.000 % (38 samples) |
| Hidden Edge with the local renderer page open (the text-provider "kept warm" state) | 0.000 % (40 samples) |
| Pocket worker (CPU; `CUDA_VISIBLE_DEVICES=-1`), V's own Pocket worker is the same class | 0.000 % (20 samples) |
| Local AI `llama-server` (Gemma 4 E4B, Vulkan, warmed) plus the CPU embedder (`--device none`) | 0.000 % (35 samples) |
| Facial model (a JavaScript worker thread, no onnxruntime), phone-analysis worker (CPU), local recogniser (CPU, sherpa-onnx) | not on the GPU by construction |

So nothing idles on the GPU. What does use it with nobody speaking is **ahead-of-time work for characters that are only near V** (the game
lists up to two it is looking at or standing near, `runtime/nearby-connections.json`, "Auto-connect nearby characters", on by default,
and every ordinary NPC archetype has a voice): `NearbyWarm` prepared each one's voice. On OmniVoice a preparation is one hidden render:
about 1.2 to 1.4 s of the card at 16 steps (measured, 10 characters one after another: 13.2 s of work, and the 8-profile prompt cache
means a rotation of more than eight characters pays it again), about twice that at Ultra's 32 steps. On the local AI, `host.warm` loaded
each nearby character's persona into the prompt cache (a 1-token request on a 1 300-token head, 0.4 to 0.7 s each, measured). Walking
through a crowd made both run again and again, with no companion and no reply.

Now: with OmniVoice speaking and playback on (`VoiceSelection.preparesOnGpu`), `NearbyWarm` skips the characters that are only near
(partners, V's spawned followers and the party keep their ahead-of-time preparation: V is with them), and the local AI's `warm` skips
a connection whose role is `nearby` (`party-connections.mjs` passes the entry's role). The same work is done **when V starts to talk**:
the composer hint, the talk key and the start of a turn call `warmTalkTargets` (`convai-bridge.mjs`: voice preparation and, except at
the turn start, the persona prefill), which overlaps typing or speaking, so the first reply waits for nothing it did not wait for before
(typing takes seconds; the preparation is 1 to 3 s and runs behind the model's own first tokens). A turn that has begun never queues a
persona prefill in front of its own request (the local server has one slot). Pocket (CPU) and cloud voices keep warming nearby
characters as before, because that costs the card nothing.

Not measurable without the game, and left as it is: with Convai answering, the vision helper (`CyberpunkConvaiVision.exe`, Windows
Graphics Capture of the game window, about 105 ms per picture) takes one picture every 3 s while a party member or any nearby talkable
character exists and no conversation runs (`companion-vision.mjs`). It does run with no companions (a nearby character is enough); it
is documented as costing no FPS (`docs/COMPANION_VISION.md`, 57.4 FPS with and without), and cutting it would take away the picture
the companion sees at the start of a turn, so it was not changed. Live check: with Convai answering and Developer mode on, stand near an
ordinary NPC for a minute with `Measure-VisionCapture.mjs` reading `perf-probe.json`, then with `CYBERPUNK_CONVAI_VISION=off`.

## Timers and watchers that stay (audited, not changed)

- The bridge's eleven interval timers (50 ms request, 150 ms microphone, prefetch and phone, 60 ms look-ahead, 500 ms settings, knowledge,
  memory, support and editor) are single file reads that wake the features that are on by default. The look-ahead poll returns at once
  unless Convai is the provider. They hold no model, no process and no memory, and a missed wake would delay a turn; they were left alone.
- `TokenSource` (sign-in backend) renews a Convai token about every hour with one small request. It is unused while a text provider is
  chosen, but pausing it would make the first Convai turn after a switch wait for a token; left as is.
- The file watcher on `runtime/` (`file-wake.mjs`) is a non-persistent OS watcher; the add-on watchers exist only with add-ons.

## Trade-offs the user can change

- Voice playback Off releases at once (decided 2026-10-14; the 2-minute grace, `MUTED_RELEASE_MS`, is gone). The price: turning playback
  back On reloads OmniVoice (about 45 s) or Pocket (seconds). A game that **starts** with playback Off never loads a companion worker.
- `BROWSER_IDLE_MS` (`bridge/convai-bridge.mjs`, 300 000, decided 2026-10-14 to stay at 5 min): the idle time before the hidden browser
  closes. V's line page and a speaking turn keep it open.
- Local AI keeps its 10-minute idle unload and the embedder its 5-minute one (unchanged).

## Exit and lock discipline

Every worker's release is awaited: Pocket and the V helper retire through confirmed EOF/exit (`taskkill /T` on Windows, because the venv's
`python.exe` is a launcher); a new Pocket worker starts only after the old one, and the V helper before it, have exited (the work folder has
one lock). OmniVoice, the phone-analysis worker and the facial thread are closed by the voice service's `close()`, which the bridge's
`shutdown()` awaits together with the recogniser (now awaited too), both model servers and the browser. The model servers also have a
synchronous kill on process exit (`killSync`).

## Live checks (Task Manager, Details tab, or the bridge log)

1. **V's own Pocket worker**: with V's engine on Pocket (the default) and the companions on OmniVoice, a cloud voice or the Convai voice, one
   extra `python.exe` (about 400 MiB, CPU) appears (`[VHelper] ... is ready`; beside OmniVoice only after OmniVoice is ready). Switch V's
   voice engine to Voxtral, or turn V's voice Off, in Settings: the extra process is gone within about a second
   (`runtime/bridge.stderr.log` has no new line; the process count is the evidence). Switch back and it returns. With Voxtral companions
   and V on Voxtral no Pocket `python.exe` exists at all.
2. **Playback Off, V's voice Off**: with Pocket or OmniVoice loaded, turn Voice playback Off: within about a second the voice's
   `python.exe` exits, GPU memory drops (OmniVoice), `runtime/local-voice-state.json` says `"state": "stopped"` and `"resident": false`.
   Turn it On: the worker loads again (a Pocket `python.exe` within seconds; OmniVoice about 45 s) and the status goes back to Ready.
   **Playback Off, V's voice On**: with OmniVoice, only V's helper `python.exe` (about 400 MiB, CPU) is left and V's typed line is still
   spoken; with a Pocket voice, the one Pocket `python.exe` stays and V speaks; with Voxtral companions and V on Pocket one Pocket
   `python.exe` (V's) stays, and with V on Voxtral no local process exists at all and V's line still sounds (a request to Voxtral). Then
   turn V's voice Off: the last `python.exe` exits too.
3. **Browser**: with a text provider and playback Off (or Convai with nobody in the party), after 5 idle minutes the hidden `msedge.exe`
   tree is gone; the next composer opening starts it again.
4. **Recogniser**: record once with Mistral or Local AI; 90 s later its `python.exe` is gone, and with it the microphone page.
5. **Provider back to Convai**: the CPU `llama-server` (embedder) and the Local AI `llama-server` are gone at once (no add-on installed).
6. Task Manager after quitting the game: no `python.exe`, `llama-server.exe`, `msedge.exe` or `powershell.exe` of the bridge is left.
