# Character editor

Players change a character's bio, speaking style, speaking rules and memories for the Mistral and Local AI conversation options. Settings > **Edit characters** opens a page in the player's browser. It does not apply to Convai: the page says so, and so does the settings row. The same page also makes **new characters** for people who have no profile in the mod (see "Your own characters").

Status: built and unit-tested on branch `character-editor`; headless-browser tested; NOT yet seen in the game.

Your own characters (the section of that name below, branch `player-characters`): built; unit-, Lua- and headless-browser tested; NOT yet seen in the game.

Voice clips (the section of that name below, branch `player-characters`, 2026-10-19): a reference clip for a story character or one of the player's own characters, cloned by Pocket, OmniVoice and Voxtral. Built and tested (unit, worker and headless browser); NOT yet heard in the game.

Live apply ("Changing a clip while the service runs" below, branch `feat/editor-live-apply`, 2026-10-19): every editor change, a voice clip included, counts without restarting the game or the service. Built and tested (unit tests, scripted workers, the Python worker tests); NOT yet seen in the game.

## Why a web page and not an in-game editor

- **Text entry.** The mod's menu (Native Settings UI, drawn by the game) has no multi-line text box, no scrolling text area, no list editing and no paste. A bio is up to 9,000 characters. Editing it with CET's `ImGui.InputTextMultiline` would need a per-frame draw callback and would grab the keyboard from the game.
- **FPS is the top priority.** In game, the editor would run an ImGui draw callback every frame while open and own a hotkey. The web page costs the game nothing: the Lua side is one function that writes one small file when the player clicks the row. It has no update hook and no native call. When the editor is closed there is no server and no polling beyond the bridge's existing 500 ms file check (the bridge is a separate process).
- **The right tool.** Lists, search over 70+ characters, undo-by-reset, long text, a screen reader and a phone-sized layout all come for free in a browser.

## How it opens

1. The player clicks **Edit characters > Open** in Settings.
2. `mod/character-editor.lua` writes `runtime/editor-command.json`: a version, a fresh id, `action: "open"`, `issuedAt`, the interface language, and every page sentence translated with the mod's own dictionaries (`ui.t`). It refuses with a plain message when the conversation service is not running.
3. The bridge polls that file every 500 ms (`bridge/character-editor-control.mjs`). A command is valid for 30 s, a repeated id is ignored, and a command already in the file at start-up is never replayed.
4. The bridge starts the editor server on a random loopback port, opens the default browser on `http://127.0.0.1:<port>/editor?t=<token>` (`rundll32 url.dll,FileProtocolHandler`, no shell), and writes `runtime/editor-status.json` (`open` or `failed`).
5. The server stops on the **Close editor** button, after 30 minutes without a request, or when the bridge shuts down.

## Security

- Listens on `127.0.0.1` only, on a random port. No request leaves the computer; the page loads nothing external.
- A random token per session: in the URL for the page, then an `X-Editor-Token` header for every API call, compared in constant time. The idle timer only moves for authenticated requests.
- Exact `Host` check, `Origin` check, JSON-only bodies up to 128 KiB. The one exception is a voice clip (see "Voice clips"): a WAV, MP3, OGG or FLAC body of at most 16 MiB, on the same token, its type decided by its first bytes (never by its name or the type the page claims) and checked as a recording before anything is kept. The clip is played back only through an API call with the token (`GET /api/voice/<key>/audio`, turned into a `blob:` URL by the page); it is never on an address that works without the token, and the policy allows media from `blob:` only.
- Character keys must match `^[a-z0-9][a-z0-9-]{0,79}$` and be in the roster, or be the key of one of the player's own characters (`custom-<slug>-<letters>`, made by the service), so no path can be built from user input; a clip's file name is that key and nothing else.
- Content-Security-Policy with a per-response nonce (`default-src 'none'`, `connect-src 'self'`). The page builds all character text with `textContent`, never as markup.

## What is stored

Overrides are kept apart from the shipped data, in `<state>/character-overrides/<key>.json`:

```json
{"version": 1, "key": "judy-alvarez", "updated": 1760000000000,
 "bio": "...", "style": "...", "rules": ["..."], "examples": ["..."], "memories": ["..."]}
```

Only the fields the player changed are stored, so a later update to the shipped profile still reaches every field that was not edited. Writes are atomic and serialised; the in-memory copy changes only after the file is written. **Reset to default** removes a field (per tab) or the whole file (Reset everything). The defaults come from `PersonaBook.defaults()`, which is the shipped Convai-derived profile.

## How the prompt uses it

`PersonaBook.persona()` merges the override into the shipped persona on every turn (a map lookup, no I/O). Two sections are new:

- `YOUR OWN RULES OF SPEECH (always follow these; they outrank the style above)`, after the speaking style.
- `WHAT YOU KNOW AND REMEMBER`, after the example lines: the hand-written memories.

With no override the prompt is byte-identical to before (tested for every roster character), so prompt caching and the existing tests are unaffected.

## Limits (keeps the prompt tight for the 8b model)

| Field | Limit |
|---|---|
| Bio | 40 to 9,000 characters |
| Speaking style | 1,800 characters |
| Speaking rules | 10 lines of up to 160 |
| Example lines | 20 lines of up to 240, 3,000 in all |
| Memories | 12 of up to 200 |
| Whole persona | 14,000 characters |

The longest shipped profile is 11,295 characters (bio 8,266), so every default fits. Over-limit saves are refused with a 422 and a stable error code; the page shows the counters before that happens.

## Memories

- **Things they always know**: hand-written facts, stored in the override and always in the prompt. These work for Mistral-only players, who have no embedder for vector memory.
- **Picked up in your talks**: the records the Local AI memory store collected. Each can be edited (the edit pins it, so later extraction never rewrites it) or deleted. Editing clears the stored vector so it is re-embedded.
- **Short summary of earlier talks**: editable or clearable.
- Archetype and ambient characters have no memories.

## Languages

Page sentences are English sources written as `T('...')` in `bridge/character-editor-page.mjs`. `mod/character-editor.lua` lists them, translates them with the mod's dictionaries and sends them in the command file; the bridge serves them in `/api/state`. A missing translation shows the English. The sentences are in `localization/en.json` (via `scripts/Extract-UiCatalog.mjs`, which now reads `mod/character-editor.lua`) and translated in all 15 dictionaries. A test keeps the page, the Lua list and the catalogue in step, and checks that no sentence mentions keys, tokens, secrets, credentials or passwords.

## Files

- `bridge/character-overrides.mjs`: limits, validation, storage, merge.
- `bridge/character-editor.mjs`: the editor logic (catalogue, state, save, reset, memory edits).
- `bridge/character-editor-server.mjs`: the loopback server and routes.
- `bridge/character-editor-page.mjs`: the page (HTML, CSS and client script).
- `bridge/character-editor-control.mjs`: the command file, the browser launch, the status file.
- `mod/character-editor.lua`, `mod/manager-ui.lua`: the settings row.
- Changed: `bridge/mistral-prompt.mjs`, `bridge/memory-store.mjs`, `bridge/convai-bridge.mjs`.
- Tests: `bridge/character-overrides.test.mjs`, `bridge/character-editor.test.mjs`, `bridge/character-editor-browser.test.mjs` (real Edge or Chrome, skipped when none is found; `EDITOR_SHOTS_DIR` saves screenshots), plus additions to `memory-store.test.mjs` and `support-help-ui.test.mjs`. Run `npm run test:editor`.

## World rules (2026-10-20, branch `feat/world-rules`)

One free-text box for the whole world, not per character: the **World rules** button above the character list opens it (Save, Revert changes, Clear; up to 2,000 characters; the page's counter and the server both enforce the limit). Examples: "Nobody in Night City knows V's name unless V tells them", "Everyone speaks casually".

- **Storage.** `<state>/world-rules.json` (`%LOCALAPPDATA%\AiNpcCyberpunkMod\data\world-rules.json`), next to `character-overrides/`, so it survives reinstalls and updates; never in the game folder. `{version: 1, updated, text}`, atomic writes; a damaged file is left as it is, gives no rules and is kept as `world-rules.json.corrupt` before the next save. `bridge/world-rules.mjs` reads it once at start; `get()` is a property read, so nothing touches the disk per turn. A save works from the next reply (the editor's live-apply path; prepared group replies are dropped).
- **Text providers (Local AI, Mistral, Custom).** `PersonaBook.persona()` adds `worldRules` to every persona (story, everyday, Johnny, player-made, add-on speakers), and `systemPrompt` writes a `WORLD RULES (...)` block right after the persona and the output rules (and the Mature or guard layer), before the format notes, the world block, the summary and the right-now block. It changes only when the player saves, so the prefix cache is unaffected between turns; the prewarmed head is still a prefix. The heading frames the words as facts and style of the setting that come after the output rules and every limit and never change or unlock them. With no rules nothing is added (the prompt is byte for byte the old one). The prompt budget (`bridge/prompt-budget.mjs`) counts the block but never cuts it, not even when the persona is shortened for a small context.
- **Convai.** The characters live on Convai's side and are not changed or re-provisioned. The bridge already sends Convai the dynamic info (the context text `updateContext` in `bridge/realtime-client.mjs` sends before each turn, `mode: 'replace'`); the rules are a block after the game's facts in it (`convaiWorldRulesBlocks`, `conversationBlocks` in `bridge/convai-bridge.mjs`), only while no text provider answers; the voice and style notes (follow-up, Natural speech, Expressive emotions, the first-person reminder, the reply language) stay after them, in the places measured for them. Convai's own limit for that text is not documented in this repository; the existing context is routinely 10,000 to 22,000 characters and the addition is at most about 2,400. Not tested with a live Convai turn.
- **Files.** `bridge/world-rules.mjs`; changed `bridge/mistral-prompt.mjs`, `bridge/prompt-budget.mjs`, `bridge/text-provider-host.mjs` (prewarm), `bridge/character-editor.mjs`, `bridge/character-editor-server.mjs` (`/api/world-rules`), `bridge/character-editor-page.mjs`, `bridge/convai-bridge.mjs`, `mod/character-editor.lua` and the 15 `mod/locales/*.lua`. Tests: `bridge/world-rules.test.mjs`, the World rules test in `bridge/character-editor-browser.test.mjs`, one in `bridge/realtime-client.test.mjs`.

## Your own characters (2026-10-19, branch `player-characters`)

A player asked for a way to give a character that has no profile in the mod (Rebecca from Edgerunners, spawned as a Night City Allies follower from a character mod) a profile, a bio and a personality. Until now such a character talked as an ordinary person (an archetype or a resident chosen from its faction and gender), and the editor only changed characters that already had a profile. The editor now has a **New character** button that makes one.

### How a player makes one

1. Settings > **Edit characters > Open**. If V is facing the character when the button is pressed, the game passes who it is (see "Facing"). Choose **New character**.
2. Fill in the form: a name, a gender, how the game finds the character (see "Matching"), a bio (40 to 9,000 characters), a speaking style, a few example lines and, if wanted, memories the character always knows. Save.
3. Optional: a **voice clip** and the words said in it (see "Voice clips"). The character can be edited, given a clip or deleted at any time; deleting also removes its clip and what it remembered of V.

The limits are the character editor's own (bio 9,000, style 1,800, 20 example lines of 240 and 3,000 in all, 12 memories of 200, 14,000 for the whole persona) so the prompt of the 8b model stays about as long as the longest shipped profile. At most 40 characters. There are no "speaking rules" for a new character: the style covers them.

### Matching (how the game finds the character)

A character is found by a **record name**, a **display name**, or both, at most six of each.

- A record name is the character's record in the game files: `Character.Rebecca`, or a clone's `NCA.Character.Rebecca` or `NCA.1234567`. A `Character.` record also matches under every clone prefix (`NCA.`), the same rule the roster uses (`CLONE_PREFIXES` in `mod/character-catalog.lua`; a test keeps the bridge's copy in step), so the player does not have to list the clone. The game compares the record's id hash, as it does for the roster.
- A display name is the name the game shows for the person. It is compared without regard to ASCII case or extra spaces (the Lua `normalized` of `mod/character-catalog.lua`; the bridge uses the same rule to find clashes).
- **A roster profile always wins.** The editor refuses a record or name that belongs to a character of the mod (including its aliases and clone records), and the game checks the roster first. Nobody else of the player's may take the same record or name.
- Order in `characterCatalog.resolve`: the managed copy's profile, the roster, **the player's characters**, the archetypes, the residents. A match applies to a character another mod spawned and to one the game placed; the game's own rules for each stay as they are (docs/SPAWNED_CHARACTERS.md, docs/WORLD_CHARACTERS.md).

**Facing.** When the player chooses Open, `mod/character-editor.lua` asks `convaiFacingCharacter` (in `mod/init.lua`) once: one targeting query, never per frame and never on a timer. It sends `{record, name, gender}` in the command file (the record is the original `Character.` name of a clone, else the readable debug name). The page's **Use the character I'm facing** button fills the form from it. If the game named nobody, the button says to face the character and press Open again (the already open server only refreshes the facing character).

### What the game reads, and when

The bridge writes `runtime/custom-characters.json` (the exchange folder of the mod, replaced in place, listed in `packaging/runtime-exchange.json` so it ships as an empty placeholder under Mod Organizer 2): `{version, revision, characters: [{key, name, gender, records, names}]}`. It carries nothing but what finds a character: no bio, style, example, memory or voice word.

`mod/custom-characters.lua` turns it into two tables (by the record's id and by normalised display name). It does nothing per frame and polls nothing:

- the file is read when the mod loads, and again at a talk key press when due: at most every 3 seconds, and only while at least one character exists or the editor was opened in the last two hours (`watch`). With none made and the editor never opened, a talk key press costs no file read;
- `match` is one comparison when no character exists, and two table lookups otherwise, wherever `characterCatalog.resolve` runs (it already ran at its previous rate: the gaze poll, the nearby scan, the talk key);
- the keys join `supportedProfiles` and `manager.profileEnabled` while they exist (`manager.configureCustom`). They are never listed in the Companion Manager and cannot be invited: another mod owns the body.

Characters of this kind take part in private talk by text and by voice, and in group chat. They are left out of battle and loot reactions (`convaiSpawnedPeople.nearby` with `roster = true`), which the first version does not ask of them.

### Key

`custom-<slug>-<4 letters>`, for example `custom-rebecca-k3j9`. The prefix is reserved (a test checks that no roster key uses it). It is a hyphen and not a colon (`custom:`) because every profile key in the bridge and in both voice workers is checked against `[a-z0-9-]` before it names a memory file, a voice or a route (about forty places), and a key those checks refuse would not work anywhere.

### Storage

In the service's data folder (`%LOCALAPPDATA%\AiNpcCyberpunkMod\data`; player data, never shipped, never touched by an update): `custom-characters.json` (every character, `version: 1`, written atomically with `atomicFile`; a damaged or partly usable file is kept as `custom-characters.json.corrupt` before the first write over it, as `character-overrides.mjs` does). A character's voice clip is kept with the other player clips (see "Voice clips"). `bridge/custom-characters.mjs` is the store; its rows are frozen, a failed save changes neither the file nor what the prompt reads, and writes happen one at a time.

### Providers

| Conversation provider | What a custom character does |
|---|---|
| Mistral, Local AI | Full support. The profile is the prompt (`PersonaBook.persona` reads the store: a plain map lookup per turn), with the same output rules, cleaning, memory and streaming as a roster character. The turn runs through the main text host (`runCustomTurn` in `bridge/convai-bridge.mjs`), never the Convai path. |
| Convai, shared or own key | No Convai character exists for a profile like this, so **the game does not resolve it**: the person talks as an ordinary person (the archetype or resident the game would have chosen), and the talk key shows one notice per character and session: "{name} is one of your own characters. They need Mistral or Local AI, so with Convai they talk as an ordinary person." (`custom-needs-provider`, docs/NOTIFICATIONS.md). The gate is `manager.textProviderActive()` (the bridge's applied provider, at most one file read every 1.5 s), asked when the list is read and at each talk key press while a character exists, and never while the player merely looks at somebody (`customCharacters.checkProvider`; `match` uses the last answer). A Local AI that fell back to Convai is Convai here too. A turn that still reaches the bridge while Convai answers (the provider changed in between) is refused with one plain sentence. |

Why not Convai with a made-up character: it would need a Convai character created per profile on the player's account, which the mod never does for anybody else's key.

### Voice

- **With a clip:** see "Voice clips" below. The clip replaces the voice of the gender for Pocket, OmniVoice and Voxtral from the character's next line.
- **No clip:** the character speaks with the resident voice of its gender (`resident-female` or `resident-male`), through `VoiceSelection` `aliases`: a key that has no voice of its own is routed, prepared, and synthesised as its alias. The variant (`-v2`, `-v3`) is chosen from the character's own key, not from the body that speaks, so one character keeps one voice across spawns and sessions.
- **Convai cloud voice chosen:** there is no Convai voice for the character, so its replies show as subtitles only.
- **Released when unused:** nothing is loaded for a character that is not talked to. A voice worker is only asked for a character's voice when that character speaks (or the composer opens on it: `warmCustom` prepares the voice and warms the text route), and every worker follows the usual voice lifecycle (docs/RESOURCE_LIFECYCLE.md). Deleting a character removes its clip and the prepared setups Pocket saved for it (`releaseVoiceFiles`, which names exactly the files it may remove and touches no voice of the shipped cast, no add-on's and no folder); the service sweeps the same files of characters that no longer exist at start.

### Memory

Per custom key, in the same memory store as the roster (`MemoryStore`): the exchanges, the short summary, the facts picked up in talks (Local AI memory) and the hand-written memories, all editable on the character's page. Deleting a character forgets its memory.

### Files (this feature)

- `bridge/custom-characters.mjs` (store, validation, keys, game list, `releaseVoiceFiles`). Clips: see "Voice clips".
- Changed: `bridge/character-editor.mjs`, `character-editor-server.mjs` (routes `/api/custom`, `/api/custom/<key>`, `/api/facing`), `character-editor-page.mjs` (the form), `character-editor-control.mjs` (the facing character), `mistral-prompt.mjs` (`PersonaBook` `custom`), `voice-selection.mjs` (`aliases`), `convai-bridge.mjs`.
- Game side (Scripts package): `mod/custom-characters.lua`, `mod/character-catalog.lua` (`resolve`, `isCustomKey`), `mod/init.lua`, `mod/manager.lua` (`textProviderActive`, `configureCustom`), `mod/character-editor.lua`, `mod/manager-ui.lua` (the Companion Manager page that opens the editor, shown through Mod Configuration Menu or Native Settings UI), `mod/notices.lua`.
- Tests: `bridge/custom-characters.test.mjs`, `bridge/custom-characters-lua.test.mjs`, additions to `character-editor.test.mjs`, `character-editor-browser.test.mjs` and `voice-selection.test.mjs`.

### Test in game (Mistral or Local AI chosen; install the Lua and the bridge, restart the bridge, reload CET)

1. Spawn a character that has no profile (for example a Night City Allies follower from a character mod; Rebecca is the example). Talk to her with the talk key. Check she answers as an ordinary person (an archetype or resident), not as herself.
2. Face her, open Settings > **Edit characters > Open**. In the page choose **New character** and press **Use the character I'm facing**: the name, a record name and a display name fill in. Give a gender, write a bio, a style and one example line, and Save.
3. Face her and press the talk key again (at most a few seconds after saving). Check she introduces herself by the new name and the reply follows the bio, with a voice (the resident voice of the gender) and moving lips.
4. Add a memory ("V once lent me a gun") on her page and Save; talk again and check she knows it from the next reply.
5. Give her a voice clip on her page (see "Voice clips", test steps there).
6. Switch the provider to Convai, face her and press the talk key: she answers as an ordinary person and one notice names her. Switch back to Mistral: she is herself again.
7. Delete her in the page and talk again: ordinary person. Check her clip and `custom-characters.json` entry are gone.
8. Check the frame rate in game is unchanged with the editor open and closed, and with several characters made.

## Voice clips (2026-10-19, branch `player-characters`)

A player can give a character a reference clip of their own, and the local voices clone it: a **story character** (any roster row of kind `named`; the clip then replaces the shipped reference for that character) or **one of their own characters** (it then replaces the voice of the gender). Everyday people (archetypes, residents) have no voice section: one voice speaks for many people there. Without a clip nothing changes.

### How a player adds one

1. Settings > **Edit characters > Open**, choose the character. A story character has a **Voice** tab; a character of the player's own has the same section on its page once it is saved.
2. **Add voice clip**: a WAV, MP3, OGG or FLAC file of 5 to 20 seconds of one person speaking clearly (10 to 18 s copies best), at most 16 MiB. The page decodes it in the browser (Web Audio `OfflineAudioContext.decodeAudioData` at 24 kHz, mixed to mono), shows its length, refuses one that is too short or too long at once, and plays the converted clip so the player hears what will be kept. A file the browser cannot decode is sent as it is and checked when saved.
3. Type the words said in the clip (8 to 600 characters): OmniVoice needs them, and a clip over 20 s would make its adapter pick and transcribe another passage, which is why 20 s is the limit.
4. **Save clip**. The page says when a clip is a little short or long. **Play saved clip** plays what is kept; **Remove clip** goes back to the shipped voice (or the voice of the gender). The words can be changed later without sending the clip again.
5. A new or removed clip counts **from that character's next line**, once the reply being spoken is over: no restart of the game or the service ("Changing a clip while the service runs" below). The page says so.

### Checks (`bridge/custom-voice-clip.mjs`)

- The type comes from the first bytes: `RIFF....WAVE`, `fLaC`, `OggS`, an ID3 tag or an MPEG layer I to III frame (AAC in ADTS is refused). Anything else: "That file is not a recording the voices can read."
- A WAV is read in plain JavaScript (PCM 16, 24 or 32 bit, 32-bit float, extensible headers, a streamed file that claims no size). An MP3, OGG or FLAC that reached the server is converted with ffmpeg when the computer has it (`CYBERPUNK_CONVAI_FFMPEG` or `ffmpeg` on PATH; the Runtime does not ship it): through pipes, only the wav, flac, ogg and mp3 demuxers allowed (`-format_whitelist`), the first audio stream, at most 21 s decoded, 24 kHz mono 16-bit out, a 20 s time-out. Without ffmpeg it is refused with "This computer cannot convert that file. Save it as a WAV and try again." (code `clip-needs-wav`). The page's own conversion makes that case rare.
- Then the shipped references' rules: 16 to 96 kHz, 5 to 20 s, under 0.5 % of samples at full scale, the speaking parts above -45 dB, at least 40 % speaking. 10 to 18 s earns no note.
- What is kept is a canonical copy: mono 16-bit PCM, a plain 44-byte header with an exact RIFF size (Pocket demands it), the SHA-256 as its identity. Nothing is equalised, normalised or denoised.
- At most 160 clips (`PLAYER_VOICE_LIMITS`).

### Where clips are stored (`bridge/player-voices.mjs`)

In the data folder, never the game folder and never a folder the editor serves: `<state>/player-voices/<key>.wav` (the folder holds clips and nothing else) and the index `<state>/player-voices.json` beside it (`version: 1`; per key the SHA-256, seconds, rate, the words and the original format). Writes are atomic and one at a time; a failed save puts the previous clip back; a damaged index is kept as `.corrupt` before the first write over it; a clip file the index does not name is removed at start. In an install `<state>` is `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`.

### How a clip reaches each voice

At service start `playerVoices.extras()` (each clip whose file still matches its hash, for a story character or an existing character of the player's) joins V's voices in `AddonHost.voiceConfigPaths` with `player: true`. Unlike add-on and V voices, a player clip is **never copied**: its descriptor is `runtime/player-voices/<key>.wav`, a second fixed reference namespace that every engine resolves only inside the player folder, and it **replaces** the shipped voice of that key in each merged configuration (`addons.<name>`) and is taken out of `preparation.startupProfiles`.

- **Pocket** (`bridge/pocket_voice_runtime.py`): `runtime.playerVoiceDirectory` in the merged configuration. Same containment, link, hash and WAV checks as the shipped references; a missing clip makes only that profile unavailable. Prepared on demand when the character first speaks, saved as `<key>-<24 hex>.safetensors` (the name follows the clip's hash, so a new clip is prepared again and the shipped one's setup stays valid).
- **OmniVoice** (`bridge/resident-voice-worker.py`): top-level `playerVoiceDirectory` in the merged short and long configurations; the same checks, including the 20 s limit. Prepared on demand into the worker's bounded cache.
- **Voxtral** (`bridge/voxtral-voice.mjs` `playerRoot`): reads the clip from the player folder when the character first speaks, and its smaller prepared slot (`bridge/voxtral-reference.mjs`) is kept in `<state>/player-voices-prepared`, not in the game's references folder. A removed clip's slot goes with it (`releasePreparedSlots`).
- **Removing a clip** removes the file and its entry; the shipped voice (or the voice of the gender) is back from the character's next line. Nothing is loaded for a character that is not talked to; what was loaded follows the usual lifecycle (docs/RESOURCE_LIFECYCLE.md: the workers' bounded caches, playback Off releases the worker).

### Changing a clip while the service runs (2026-10-19, branch `feat/editor-live-apply`)

Saving a clip, changing its words or removing it takes effect with **no restart of the game or the service**, from that character's next line, after the reply being spoken is over (`bridge/live-voices.mjs`, `VoiceSelection.setVoices`). Nothing runs on a timer or per turn: it all happens on the save.

1. `PlayerVoices` calls `onChanged(key)` once the change is on disk (a failing hook never fails the save).
2. `LiveVoices.refresh(key)` (one change at a time, in the order they were made) edits that one key in the three tables the workers started with: Pocket's, and OmniVoice's short and long ones (each configuration's `voices`). With a clip (its file checked against the index hash) the key becomes `{reference: runtime/player-voices/<key>.wav, sha256, transcript}`; with none it goes back to the descriptor of the shipped configuration (read from the original, unmerged file), or leaves the table when there is none (a character the player made, which then speaks with the voice of its gender again). A table an engine does not have is left alone.
3. `VoiceSelection.setVoices(update)` holds the change while a reply is in flight (`busy` from the settings poll that already runs: one null check when nothing waits) and applies it at the first idle moment, together: the routing registries, the cloud voices' references, and every running worker. It returns true when it applied, and the bridge then drops its prefetched replies. A character that had something prepared is prepared again at once in the background, so its next line does not pay for it.
4. **Pocket and OmniVoice workers are not reloaded.** Each client (`PocketVoice.setVoices`, `ResidentVoice.setVoices`) sends its worker only the difference as a `voices` command (`set`, `remove`, and the player folder the first time), at most 20 keys at a time, in line behind the job the worker is doing, so a reply in flight finishes with the voice it started with. The worker checks the whole change first (a refused change leaves everything as it was), resolves each descriptor with the same resolver as at start (file, hash, length; a file that is gone or changed withdraws only that voice), and drops only the changed characters from its prepared state: Pocket's in-memory prepared state and the saved setup of a replaced clip (`pocket_voice_runtime.apply_voices`), OmniVoice's prepared list and the prompt in the adapter's cache, and its cache identity table (`resident-voice-worker.apply_voice_change`). It answers with the voices it now holds and the client checks both hashes. A worker that starts again (a crash, a stall restart, a background OmniVoice load) reads the start-up configuration and is sent the changes once it is ready, before its start is done.
5. **Voxtral** reads the clip through the same registries: `replaceReferences(registries, [key])` forgets only that character's cached reference; the prepared slot in `<state>/player-voices-prepared` of that key is released. Other characters keep their cached references.

Not changed: a worker of the first OmniVoice protocol (`version: 1`, the three original voices) cannot take a live change, so nothing is sent to it; the next start merges the clip as before.

### V's own clip (branch `feat/v-voice-mods`)

V's typed lines are spoken with two voice keys, `v-male` and `v-female` (`bridge/v-voice.mjs` `V_VOICE_KEYS`), and a player clip stored under a key replaces that key in every merged configuration. The editor therefore lists two voice-only rows in a group of their own, **V's voice**, between the player's own characters and the story characters: **V (male voice)** and **V (female voice)** (`catalog()` items `{key, name, group: 'v', edited: false, voiceOnly: true, voice}`; they exist only when the clip store does).

- A row has the Voice section and nothing else: no tabs, no bio, style, rules or memories, no reset, no delete, no gender. `details('v-male')` is `{key, name, group: 'v', voiceOnly: true, voice: {clip, transcript, fallback: 'v'}}`; saving text, memories or a summary for those keys is 404. The clip routes (`PUT`/`DELETE /api/voice/v-male`, `/text`, `/audio`) work through the same `checkVoiceKey`, which allows exactly those two keys besides story and own characters.
- The page says: "Used for V's typed lines: Pocket, OmniVoice and the Voxtral cloud voice copy it." With no clip it says "V speaks with the voice of your installed V voice mod, or the shipped V voice.", and the remove confirmation says V goes back to that.
- Applying live: `LiveVoices` has an optional `fallback(key)` (sync; `{reference, sha256, transcript}` or null). V is merged as an extra, so the shipped configuration files have no descriptor for its keys; when a V clip is removed and the shipped file has none, the key takes the fallback descriptor (the mod-built or shipped V reference, supplied by the bridge) instead of leaving the tables, so V keeps speaking at once. Without a fallback, or when it gives null, a key the shipped files lack still leaves the tables (a character the player made).
- The bridge must also let the two keys through `playerVoiceAllowed` so the clips are merged at start and `LiveVoices.descriptor` accepts them.

### One place for the clips

The clip file, the index (`player-voices.json`) and the folder every engine reads are all derived from the one `dir` the store is opened with, the service's state folder (`CYBERPUNK_CONVAI_STATE`): `%LOCALAPPDATA%\AiNpcCyberpunkMod\data` in an install, `runtime/` in a source checkout. Nothing else builds those paths (a test reads the bridge's source for it), and the start-up log line `[PlayerVoices] voice clips and their list are kept in ...` names both.

What split them in the first live test was two conversation services, not one: the installed service (data folder in `%LOCALAPPDATA%`) and a development service (`runtime/`) were both running against the same game folder, and the editor's Open click travels through `runtime/editor-command.json` **in the game folder**, which every service for that game reads. Whichever service answered a click served the page, and saved into its own data folder. A player has one service, so they always have one place. To make that impossible to repeat, `EditorControl` now records which service took a click (`home`, a short hash of the data folder, in `editor-status.json`) before it starts anything, and a service with another data folder leaves a click that a service already claimed in the last 30 seconds.

### What applies when (every editor save)

| Change | Applies | How |
|---|---|---|
| Bio, speaking style, speaking rules, example lines, hand-written memories, reset | the next turn | `PersonaBook.persona()` reads `CharacterOverrides` with a plain lookup every turn; the save also drops a group reply prepared before it (`onChanged`) |
| Memories picked up in talks, the summary | the next turn | the in-process `MemoryStore` |
| A character made, renamed (name, match rule) or deleted | the next turn in the bridge; in the game at the next talk key press (at most 3 s) | the roster rows and the add-ons' name lookup are rebuilt on the change; `mod/custom-characters.lua` re-reads `runtime/custom-characters.json` on the talk key press while there are characters or the editor was opened in the last two hours (pressing **Open** again renews that), so no CET reload |
| A voice clip | the character's next line | above |

### Privacy

The clip and its words stay on the player's computer: no request leaves it (Voxtral sends the clip to Mistral only when the player chose that voice, as it does for every character). Support reports carry only `voiceClips: {count, clips: [{character, seconds}]}` (a story character's key, or just `custom`), never the audio, the words, a path or a custom character's name (`readPlayerVoiceSummary`, tested in `support-report.test.mjs`). The store never logs the words.

### Editor routes

`PUT /api/voice/<key>` (the clip as the body; the words base64url-encoded in `X-Voice-Text`), `PUT /api/voice/<key>/text` (JSON `{text}`), `DELETE /api/voice/<key>`, `GET /api/voice/<key>/audio`. All need the session token and pass the Host and Origin checks; a key must be a story character or an existing character of the player's.

### Files

`bridge/player-voices.mjs` (store, index, extras, report summary, prepared slots), `bridge/live-voices.mjs` (the live change), `bridge/voice-selection.mjs` (`setVoices`), `bridge/pocket-voice.mjs`, `bridge/resident-voice.mjs` (`setVoices`), `bridge/custom-voice-clip.mjs` (type sniffing, ffmpeg conversion, checks, canonical copy), `bridge/addons.mjs` (the merge), `bridge/voice-profile-registry.mjs`, `bridge/pocket_voice_runtime.py`, `bridge/resident-voice-worker.py`, `bridge/voxtral-voice.mjs`, `bridge/voice-routing-log.mjs`, `bridge/character-editor*.mjs`, `bridge/convai-bridge.mjs`, `bridge/support-report.mjs`, `mod/character-editor.lua` (the page's sentences). Tests: `bridge/player-voices.test.mjs`, `bridge/live-voices.test.mjs` (the live change on every engine, storage, the click claim), `bridge/character-editor.test.mjs`, `bridge/character-editor-browser.test.mjs`, `bridge/support-report.test.mjs`, the engine tests and the Python worker tests (`scripts/test_pocket_voice_runtime.py`, `scripts/test_resident_voice_paths.py`).

### Test in game

1. Open the editor, choose Judy, open **Voice**. Add a 10 to 18 s clip of clean speech (try an MP3), check the length and the preview, type the words, Save clip. Try a 3 s clip and a silent one: each is refused with a sentence.
2. Do not restart anything. Talk to Judy with Pocket chosen: she speaks in the clip's voice from her next line (not in the middle of a reply that is being spoken). Switch to OmniVoice (short and long) and to Voxtral and check each. Check no other character's voice changed.
3. Remove the clip, still without restarting: Judy's shipped voice is back from her next line.
4. Give one of your own characters a clip and check the same; delete the character and check `player-voices/` no longer has its clip.
5. Make a support report and check it lists only how many clips there are and how long each is.
6. Check the frame rate is unchanged, and that `%LOCALAPPDATA%\AiNpcCyberpunkMod\data\player-voices` holds the clips while the game's `voices` folder has none of them.

## Test in game (after installing the Lua and the bridge, restarting the bridge and reloading CET)

1. Choose Mistral (or Local AI) as the conversation provider. Open Settings and click **Edit characters > Open**. The default browser opens the editor. Check the row text says it does not apply to Convai.
2. Pick Judy Alvarez. Edit the bio, click Save: "Saved." appears and the list shows an Edited dot.
3. Talk to Judy and check the reply reflects the change from the next reply on, without a restart.
4. Add a memory ("V has a sister called Lena") and a speaking rule ("Never say chombatta"). Talk again and check both are followed.
5. Click **Reset to default** on a tab, then **Reset everything**. Check the next reply is back to normal.
6. Switch the provider to Convai and reopen the editor: the banner says the changes have no effect yet.
7. Click **Close editor**: the page says it is closed and the address stops answering. Check the frame rate in game is unchanged with the editor open and closed.
8. Change the interface language and reopen: the page sentences follow it.
