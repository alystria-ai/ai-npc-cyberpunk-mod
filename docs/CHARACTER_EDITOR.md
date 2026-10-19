# Character editor

Players change a character's bio, speaking style, speaking rules and memories for the Mistral and Local AI conversation options. Settings > **Edit characters** opens a page in the player's browser. It does not apply to Convai: the page says so, and so does the settings row. The same page also makes **new characters** for people who have no profile in the mod (see "Your own characters").

Status: built and unit-tested on branch `character-editor`; headless-browser tested; NOT yet seen in the game.

Your own characters (the section of that name below, branch `player-characters`): built; unit-, Lua- and headless-browser tested; NOT yet seen in the game.

Voice clips (the section of that name below, branch `player-characters`, 2026-10-19): a reference clip for a story character or one of the player's own characters, cloned by Pocket, OmniVoice and Voxtral. Built and tested (unit, worker and headless browser); NOT yet heard in the game.

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

- **With a clip:** see "Voice clips" below. The clip replaces the voice of the gender for Pocket, OmniVoice and Voxtral from the next start.
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
5. A new or removed clip counts **from the next time the game starts** (the service merges the voice configurations at start); until then the character keeps the voice it has now. The page says so.

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
- **Removing a clip** removes the file and its entry; the next start merges nothing for that key, so the shipped voice (or the voice of the gender) is back. Nothing is loaded for a character that is not talked to; what was loaded follows the usual lifecycle (docs/RESOURCE_LIFECYCLE.md: the workers' bounded caches, playback Off releases the worker).

### Privacy

The clip and its words stay on the player's computer: no request leaves it (Voxtral sends the clip to Mistral only when the player chose that voice, as it does for every character). Support reports carry only `voiceClips: {count, clips: [{character, seconds}]}` (a story character's key, or just `custom`), never the audio, the words, a path or a custom character's name (`readPlayerVoiceSummary`, tested in `support-report.test.mjs`). The store never logs the words.

### Editor routes

`PUT /api/voice/<key>` (the clip as the body; the words base64url-encoded in `X-Voice-Text`), `PUT /api/voice/<key>/text` (JSON `{text}`), `DELETE /api/voice/<key>`, `GET /api/voice/<key>/audio`. All need the session token and pass the Host and Origin checks; a key must be a story character or an existing character of the player's.

### Files

`bridge/player-voices.mjs` (store, index, extras, report summary, prepared slots), `bridge/custom-voice-clip.mjs` (type sniffing, ffmpeg conversion, checks, canonical copy), `bridge/addons.mjs` (the merge), `bridge/voice-profile-registry.mjs`, `bridge/pocket_voice_runtime.py`, `bridge/resident-voice-worker.py`, `bridge/voxtral-voice.mjs`, `bridge/inworld-voice.mjs`, `bridge/voice-routing-log.mjs`, `bridge/character-editor*.mjs`, `bridge/convai-bridge.mjs`, `bridge/support-report.mjs`, `mod/character-editor.lua` (the page's sentences). Tests: `bridge/player-voices.test.mjs`, `bridge/character-editor.test.mjs`, `bridge/character-editor-browser.test.mjs`, `bridge/support-report.test.mjs`, the engine tests and the Python worker tests.

### Test in game

1. Open the editor, choose Judy, open **Voice**. Add a 10 to 18 s clip of clean speech (try an MP3), check the length and the preview, type the words, Save clip. Try a 3 s clip and a silent one: each is refused with a sentence.
2. Restart the game. Talk to Judy with Pocket chosen: she speaks in the clip's voice. Switch to OmniVoice (short and long) and to Voxtral and check each. Check no other character's voice changed.
3. Remove the clip, restart: Judy's shipped voice is back.
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
