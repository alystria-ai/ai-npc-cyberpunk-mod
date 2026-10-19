# Character editor

Players change a character's bio, speaking style, speaking rules and memories for the Mistral and Local AI conversation options. Settings > **Edit characters** opens a page in the player's browser. It does not apply to Convai: the page says so, and so does the settings row. The same page also makes **new characters** for people who have no profile in the mod (see "Your own characters").

Status: built and unit-tested on branch `character-editor`; headless-browser tested; NOT yet seen in the game.

Your own characters (the section of that name below, branch `player-characters`): built; unit-, Lua- and headless-browser tested; NOT yet seen in the game.

## Why a web page and not an in-game editor

- **Text entry.** The mod's menu (MCM, drawn in CET) has no multi-line text box, no scrolling text area, no list editing and no paste. A bio is up to 9,000 characters. Editing it with CET's `ImGui.InputTextMultiline` would need a per-frame draw callback and would grab the keyboard from the game.
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
- Exact `Host` check, `Origin` check, JSON-only bodies up to 128 KiB. The one exception is a voice clip for a character the player made: a WAV body of at most 16 MiB, on the same token, checked as a recording before anything is kept.
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
- `mod/character-editor.lua`, `mod/mcm.lua`: the settings row.
- Changed: `bridge/mistral-prompt.mjs`, `bridge/memory-store.mjs`, `bridge/convai-bridge.mjs`.
- Tests: `bridge/character-overrides.test.mjs`, `bridge/character-editor.test.mjs`, `bridge/character-editor-browser.test.mjs` (real Edge or Chrome, skipped when none is found; `EDITOR_SHOTS_DIR` saves screenshots), plus additions to `memory-store.test.mjs` and `support-help-ui.test.mjs`. Run `npm run test:editor`.

## Your own characters (2026-10-19, branch `player-characters`)

A player asked for a way to give a character that has no profile in the mod (Rebecca from Edgerunners, spawned as a Night City Allies follower from a character mod) a profile, a bio and a personality. Until now such a character talked as an ordinary person (an archetype or a resident chosen from its faction and gender), and the editor only changed characters that already had a profile. The editor now has a **New character** button that makes one.

### How a player makes one

1. Settings > **Edit characters > Open**. If V is facing the character when the button is pressed, the game passes who it is (see "Facing"). Choose **New character**.
2. Fill in the form: a name, a gender, how the game finds the character (see "Matching"), a bio (40 to 9,000 characters), a speaking style, a few example lines and, if wanted, memories the character always knows. Save.
3. Optional: a **voice clip** and the words said in it (see "Voice"). The character can be edited, given a clip or deleted at any time; deleting also removes its clip and what it remembered of V.

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

In the service's data folder (`%LOCALAPPDATA%\AiNpcCyberpunkMod\data`; player data, never shipped, never touched by an update): `custom-characters.json` (every character, `version: 1`, written atomically with `atomicFile`; a damaged or partly usable file is kept as `custom-characters.json.corrupt` before the first write over it, as `character-overrides.mjs` does) and `custom-voices/<key>.wav`. `bridge/custom-characters.mjs` is the store; its rows are frozen, a failed save changes neither the file nor what the prompt reads, and writes happen one at a time.

### Providers

| Conversation provider | What a custom character does |
|---|---|
| Mistral, Local AI | Full support. The profile is the prompt (`PersonaBook.persona` reads the store: a plain map lookup per turn), with the same output rules, cleaning, memory and streaming as a roster character. The turn runs through the main text host (`runCustomTurn` in `bridge/convai-bridge.mjs`), never the Convai path. |
| Convai, shared or own key | No Convai character exists for a profile like this, so **the game does not resolve it**: the person talks as an ordinary person (the archetype or resident the game would have chosen), and the talk key shows one notice per character and session: "{name} is one of your own characters. They need Mistral or Local AI, so with Convai they talk as an ordinary person." (`custom-needs-provider`, docs/NOTIFICATIONS.md). The gate is `manager.textProviderActive()` (the bridge's applied provider, at most one file read every 1.5 s), asked when the list is read and at each talk key press while a character exists, and never while the player merely looks at somebody (`customCharacters.checkProvider`; `match` uses the last answer). A Local AI that fell back to Convai is Convai here too. A turn that still reaches the bridge while Convai answers (the provider changed in between) is refused with one plain sentence. |

Why not Convai with a made-up character: it would need a Convai character created per profile on the player's account, which the mod never does for anybody else's key.

### Voice

The optional clip is checked like the shipped references (`bridge/custom-voice-clip.mjs`): a real WAV (PCM, 16, 24 or 32 bit or 32-bit float, mono or stereo, 16 to 96 kHz), 5 to 20 seconds (20 s is the OmniVoice worker's own limit; 10 to 18 s earns no note, shorter or longer saves with a gentle one), at most 16 MB sent and 8 MB kept, not clipped (under 0.5 % of the samples at full scale), loud enough (the speaking parts above -45 dB) and not mostly silence (at least 40 % speaking). What is kept is a canonical copy: mono, 16-bit, the clip's own rate, a plain 44-byte header (both workers read it without a special case; Pocket demands an exact RIFF size), with its SHA-256 as the voice identity. Nothing is resampled, equalised, normalised or denoised. The words said in the clip are required with it: OmniVoice needs them to copy the voice.

- **Pocket, OmniVoice (both reference lengths) and Voxtral:** at bridge start `customCharacters.voiceExtras()` joins V's voices in `AddonHost.voiceConfigPaths` (`extra`): the clip is copied to `voice-references/addons/<key>.wav`, written into the `addons.<name>` copies of the Pocket and OmniVoice configurations and prepared on demand like every other voice, with the same preparation path, cache and checks (hash, transcript, length). The cloud voice reads the clip from the long OmniVoice configuration. **A clip given while the service runs is used from the next start** (the page says so); until then, and for a character with no clip, the next row applies.
- **No clip:** the character speaks with the resident voice of its gender (`resident-female` or `resident-male`), through `VoiceSelection` `aliases`: a key that has no voice of its own is routed, prepared, and synthesised as its alias. The variant (`-v2`, `-v3`) is chosen from the character's own key, not from the body that speaks, so one character keeps one voice across spawns and sessions.
- **Convai cloud voice chosen:** there is no Convai voice for the character, so its replies show as subtitles only.
- **Released when unused:** nothing is loaded for a character that is not talked to. A voice worker is only asked for a character's voice when that character speaks (or the composer opens on it: `warmCustom` prepares the voice and warms the text route), and every worker follows the usual voice lifecycle (docs/RESOURCE_LIFECYCLE.md). Deleting a character, or removing its clip, also removes what the clip left outside the data folder: the copies under `voice-references/addons/` and the prepared setups Pocket saved for it (`releaseVoiceFiles`, which names exactly the files it may remove and touches no voice of the shipped cast, no add-on's and no folder); the service sweeps the same files of characters that no longer exist at start.

### Memory

Per custom key, in the same memory store as the roster (`MemoryStore`): the exchanges, the short summary, the facts picked up in talks (Local AI memory) and the hand-written memories, all editable on the character's page. Deleting a character forgets its memory.

### Files (this feature)

- `bridge/custom-characters.mjs` (store, validation, keys, game list, voice extras, `releaseVoiceFiles`), `bridge/custom-voice-clip.mjs` (the clip checks and the canonical copy).
- Changed: `bridge/character-editor.mjs`, `character-editor-server.mjs` (routes `/api/custom`, `/api/custom/<key>`, `/api/custom/<key>/voice` as a WAV body, `/api/facing`), `character-editor-page.mjs` (the form), `character-editor-control.mjs` (the facing character), `mistral-prompt.mjs` (`PersonaBook` `custom`), `voice-selection.mjs` (`aliases`), `convai-bridge.mjs`.
- Game side (Scripts package): `mod/custom-characters.lua`, `mod/character-catalog.lua` (`resolve`, `isCustomKey`), `mod/init.lua`, `mod/manager.lua` (`textProviderActive`, `configureCustom`), `mod/character-editor.lua`, `mod/mcm.lua`, `mod/notices.lua`.
- Tests: `bridge/custom-characters.test.mjs`, `bridge/custom-characters-lua.test.mjs`, additions to `character-editor.test.mjs`, `character-editor-browser.test.mjs` and `voice-selection.test.mjs`.

### Test in game (Mistral or Local AI chosen; install the Lua and the bridge, restart the bridge, reload CET)

1. Spawn a character that has no profile (for example a Night City Allies follower from a character mod; Rebecca is the example). Talk to her with the talk key. Check she answers as an ordinary person (an archetype or resident), not as herself.
2. Face her, open Settings > **Edit characters > Open**. In the page choose **New character** and press **Use the character I'm facing**: the name, a record name and a display name fill in. Give a gender, write a bio, a style and one example line, and Save.
3. Face her and press the talk key again (at most a few seconds after saving). Check she introduces herself by the new name and the reply follows the bio, with a voice (the resident voice of the gender) and moving lips.
4. Add a memory ("V once lent me a gun") on her page and Save; talk again and check she knows it from the next reply.
5. Give her a voice clip (10 to 18 s of clean speech, with the words typed). Check a clip that is too short or too quiet is refused with a sentence. Restart the game: she now speaks in the clip's voice with Pocket; switch to OmniVoice and Voxtral and check both.
6. Switch the provider to Convai, face her and press the talk key: she answers as an ordinary person and one notice names her. Switch back to Mistral: she is herself again.
7. Delete her in the page and talk again: ordinary person. Check her clip and `custom-characters.json` entry are gone.
8. Check the frame rate in game is unchanged with the editor open and closed, and with several characters made.

## Test in game (after installing the Lua and the bridge, restarting the bridge and reloading CET)

1. Choose Mistral (or Local AI) as the conversation provider. Open Settings and click **Edit characters > Open**. The default browser opens the editor. Check the row text says it does not apply to Convai.
2. Pick Judy Alvarez. Edit the bio, click Save: "Saved." appears and the list shows an Edited dot.
3. Talk to Judy and check the reply reflects the change from the next reply on, without a restart.
4. Add a memory ("V has a sister called Lena") and a speaking rule ("Never say chombatta"). Talk again and check both are followed.
5. Click **Reset to default** on a tab, then **Reset everything**. Check the next reply is back to normal.
6. Switch the provider to Convai and reopen the editor: the banner says the changes have no effect yet.
7. Click **Close editor**: the page says it is closed and the address stops answering. Check the frame rate in game is unchanged with the editor open and closed.
8. Change the interface language and reopen: the page sentences follow it.
