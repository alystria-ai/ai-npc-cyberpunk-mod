# Character editor

Players change a character's bio, speaking style, speaking rules and memories for every conversation option. Google Gemini, Local AI and Custom carry the edits in the character's prompt. Convai gets them as a context block with each turn (see "Character edits on Convai"), because its characters live in the owner's Convai account and cannot be updated. Settings > **Edit characters** opens a page in the player's browser. The page and the settings row say how Convai gets the edits. The same page also makes **new characters** for people who have no profile in the mod (see "Your own characters").

Players: [CHARACTER_EDITOR_GUIDE.md](CHARACTER_EDITOR_GUIDE.md) is the short guide (how to open it, what each tab does, when an edit counts, how to make a character know a new fact). This page is the technical description.

Status: built and unit-tested on branch `character-editor`; headless-browser tested; NOT yet seen in the game.

Prompting (the section of that name below, branch `feat/editor-prompting`, 2026-10-22): the same page edits the prompt wording of each conversation option (Mistral, Local AI Lite and Standard, Mature on, and the player's Custom models). Built; unit- and headless-browser tested; NOT yet seen in the game. The editor opens from Settings > Edit characters and from the **Character editor** destination of the manager's Home page (both send the same command).

Your own characters (the section of that name below, branch `player-characters`): built; unit-, Lua- and headless-browser tested; NOT yet seen in the game.

Voice clips (the section of that name below, branch `player-characters`, 2026-10-19): a reference clip for a story character or one of the player's own characters, cloned by Pocket, OmniVoice and Voxtral. Built and tested (unit, worker and headless browser); NOT yet heard in the game.

Live apply ("Changing a clip while the service runs" below, branch `feat/editor-live-apply`, 2026-10-19): every editor change, a voice clip included, counts without restarting the game or the service. Built and tested (unit tests, scripted workers, the Python worker tests); NOT yet seen in the game.

Look and moves (the section of that name below, branch `feat/editor-outfits`, 2026-10-28): a tab per character for its outfit, talking gestures, nods, idle moves, seating, comments on fights and loot, and reply length. Most of it works with every conversation option, Convai included. Built; unit-, Lua- and headless-browser tested; NOT yet seen in the game.

## The page: layout and look (2026-10-30, branch `feat/editor-redesign`)

A face lift and a new character picker. Every feature, API call, check and limit below is as it was. The server, its token, Host and Origin checks, the 128 KiB body cap and the Content Security Policy are unchanged, and the page still fetches nothing from outside (no font, no image, no icon file, no library).

- **Top bar** (sticky). The mark and the name of the editor, the **character button** (the open character's initials badge and name with a chevron, or "Choose a character"), and on the right **New character** (the one filled button), **World rules**, **Prompting** and **Close editor**. The World rules and Prompting buttons are marked as the current page while open. Below 980 px the buttons keep only their icons (their names stay for screen readers and as tooltips), below 640 px the title does too.
- **No sidebar.** The hundreds of characters live in a **picker**, a command palette style panel under the top bar. It opens from the character button, from the keyboard (`/` or Ctrl+K anywhere outside a text box) and stays open on the page, with a short heading, while no character is chosen yet. Escape, a click outside or tabbing out closes it and returns focus to the character button. In the picker:
  - **Search as you type** (the names only, accents ignored), with a clear button and a count ("12 of 212"). Enter opens the first result, Down moves into the list, the arrow keys move through it (Up and Down by row, Left and Right by neighbour), Up from the first row returns to the search box.
  - **Filter chips**, each with its count and shown only when something is under it: **All**, **Romances** (Judy, Kerry, Panam, River), **Companions** (the 26 tier-1 characters of `mod/auto-connect.lua` `M.TIER1`, romances excepted), **Story** (the other named characters), **Side characters** (everyday people and archetypes), **Your characters** and **Edited**. The role of a shipped character comes from the service (`role` on every row of `GET /api/state`, `ROMANCE_KEYS` and `COMPANION_KEYS` in `bridge/character-editor.mjs`, pinned by a test to `bridge/relationship-routing.mjs` and the Lua list); the page falls back to `group` when a row has none.
  - **Two short sections on top** while there is no search and the chip is All: **In front of you** (the character V was facing when the editor opened, found by its display name from `GET /api/facing`, when the roster has it) and **Recently edited** (up to six: the characters saved in this page first, newest first, then the ones with stored edits). Edit times are not stored, so older edits are listed by name.
  - **The list** is grouped by role in a compact grid of small badges: a round-cornered badge with the initials on a muted tone (one of six, from the key, so a character keeps its colour), the name, and small markers on the right: a pencil for stored edits and a microphone for a voice clip of its own. Group headings carry their counts.
- **Selected character header.** A large badge, the name, a role badge (Romance, Companion, Story character, Side character, V's voice), a "Custom voice" badge when it has a clip, the **As shipped** or **Edited** status chip, and **Reset everything**. The player's own characters show "Your character".
- **Tabs** (Bio, Speaking style, Speaking rules, Memories, Voice, Look and moves; the last two only where the character has them): an icon and a label each, sticky under the top bar, scrolling sideways when narrow, with arrow, Home and End keys and the tab pattern's roles. A tab with unsaved changes shows a dot.
- **Forms.** Each field is a card with a label, help text and a character counter (red over the limit). The Save bar is sticky at the bottom of the window and floats over the form: **Save** and **Reset to default** (or the page's own buttons), with **Unsaved changes** beside them while anything on the open page differs from what is saved. Delete, move and add buttons carry icons. Empty lists say "Nothing yet." in a dashed box.
- **Feedback.** A toast at the top right (a check or a warning icon, the message, a close button): five seconds for good news, nine for a problem, always dismissable. The Convai warning is a banner with an icon under the top bar, and it is left off the Look and moves tab and the World rules page, as before.
- **Look.** One refined dark theme (a light one for light systems), a single accent (a muted yellow), a 4 px spacing scale, one type scale, soft elevation only on floating parts (the picker, the Save bar, the toast), a visible focus ring on everything, quick transitions (none with "reduce motion"). Text and the accent meet WCAG AA contrast in both themes. No inline style is used anywhere (the policy allows only the one style element).
- **Icons.** Lucide (ISC, with Feather's MIT portions), as the few inline SVG shapes the page uses, parsed once with `DOMParser` and never written as markup. The licence text is in `THIRD_PARTY_NOTICES.md` (shipped as `app/licenses/THIRD_PARTY_NOTICES.md`). Nothing is fetched.
- **Strings.** The new sentences (the roles, the chips, the sections, "Unsaved changes", "Choose a character to start editing." and the rest) go through the same `T()` path and are in `mod/character-editor.lua` and all 15 dictionaries. "Choose a character on the left.", "Story characters" and "Everyday people" are gone with the sidebar.
- **Tests.** `bridge/character-editor-browser.test.mjs` drives the real page in Edge or Chrome (picker, chips, search, keyboard, recent and facing sections, phone width, 300+ characters, light theme); `EDITOR_SHOTS_DIR` saves screenshots.

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
- `WHAT YOU KNOW AND REMEMBER`, after the example lines: the hand-written memories. The heading tells the model to answer from them when V asks about one and to mention one otherwise only when it fits (2026-10-31: it used to say "never recite it", which a model can read as "do not say it when asked").

With no override the prompt is byte-identical to before (tested for every roster character), so prompt caching and the existing tests are unaffected.

## Limits (keeps the prompt tight for the 8b model)

| Field | Limit |
|---|---|
| Bio | 40 to 9,000 characters |
| Speaking style | 1,800 characters |
| Speaking rules | 10 lines of up to 160 |
| Example lines | 20 lines of up to 240, 3,000 in all |
| Memories | 12 of up to 200 |
| Whole persona | 12,500 characters (`EDIT_LIMITS.total`) |

The longest shipped profile is 11,295 characters (bio 8,266), so every default fits. Over-limit saves are refused with a 422 and a stable error code; the page shows the counters before that happens.

## When a text is cut, and the chat before a save (2026-10-31, branch `fix/editor-knowledge`)

Player report (Discord, 31 Oct): "sometimes I do modifications and it works, sometimes when I ask something about the modification they seem not knowing." The causes found by tracing every field to the request, and what was done about each (`bridge/character-edit-reach.test.mjs` goes through the real editor, persona book and text host for every provider and model profile):

| Field | Saved in | Counts from | Where it goes in the prompt (Gemini, Local AI, Custom) | Can be cut or missed |
| --- | --- | --- | --- | --- |
| Bio | `character-overrides/<key>.json`, `bio` | the next reply | `WHO YOU ARE`, in place of the shipped bio | Yes, from the end: over the profile's length cap (Local AI Lite 6,000 plus 2,000 for the rules, others 16,000), on a computer measured to read slowly (compact text) and on a server with a small context (persona levels). Fixed below |
| Speaking style | `style` | the next reply | `HOW YOU TALK` | The compact text and the small-context levels keep the start of it only |
| Speaking rules | `rules` | the next reply | `YOUR OWN RULES OF SPEECH`, never cut | No |
| Example lines | `examples` | the next reply | `EXAMPLES OF YOUR VOICE`, in place of the shipped lines | Yes: the first thing dropped over the cap (the Lite model already drops them for 5 of the 701 named characters unedited, Johnny among them), two kept by the compact text, none by the small-context levels. The player's own lines now go last |
| Things they always know | `memories` | the next reply | `WHAT YOU KNOW AND REMEMBER`, never cut | No |
| Picked up in your talks | the memory store (`local-memory/<player>/<key>.json`) | the next reply for a changed record (it is pinned) | the `things` block before V's words | Was found by meaning only and missed 10 of 15 natural questions with the shipped granite model. Now up to three changed records are always in (below) |
| Short summary of earlier talks | the memory store | the next reply | `WHAT YOU REMEMBER OF V FROM EARLIER TALKS` | A later fold of older talks can rewrite it |

At the time of that report Convai took none of them (its profile lives in the owner's Convai account), which was the most likely reason for "sometimes": the provider falls back to Convai when the chosen one cannot be used (Google Gemini with no key, Custom without a setup) and the page said so only at the top, once, when it was opened. Since the work in "Character edits on Convai" below, Convai gets the edits as a context block, so the fallback no longer loses them.

What changed:

- **A cut spares the player's words** (`bridge/player-text.mjs`). `applyOverride` gives the persona `bioEdits` (the bio paragraphs that are not paragraphs of the shipped bio) and `samplesMine` (the example lines that are not shipped ones). Over the length cap `systemHead` drops the shipped example lines, then the shipped bio paragraphs from the end (the last one needed only in part), and the player's own example lines only when that does not make the room. The compact text (`bridge/compact-persona.mjs`) takes the player's paragraphs as blocks of their own (kind `player`, 1,500 characters each) right after the opening paragraph. The small-context levels (`bridge/prompt-budget.mjs`) cut the shipped paragraphs first. Before this, a paragraph added to Judy's or Alt's bio on the Lite model was cut away with the shipped end: Judy had room for 54 more characters and Alt for 20, and Jackie, Panam and Johnny for 577 to 674. Without an edit the prompt is byte for byte as before.
- **The chat before a save steps aside.** `CharacterOverrides.editedAt(key)` is the moment of the last save or reset that changed something (a file's `updated` after a restart), the persona carries it as `editedAt`, and `buildMessages` leaves out the history exchanges recorded before it (`turn.at`). The memory keeps them and they still reach the summary. A model repeats its own earlier answer over the profile above it (the same finding as `bridge/fresh-facts.mjs`), so "I have no pets" from before the edit outvoted the new fact. A player's own characters carry their row's `updated` the same way.
- **Changed picked-up records are always in** (`MemoryStore.retrieve`): up to three pinned records, newest first, 600 characters, ahead of the ones found by meaning, in private and phone talk, not in a group and not for a bare greeting, and without waiting for the embedding model. Measured offline with the real `MemoryStore`, 150 records, three edited facts and five natural phrasings each: granite found 5 of 15, EmbeddingGemma 13 of 15, now 15 of 15.
- **The Convai note is beside the text fields** (it says a long edit is shortened for Convai), on the Bio, Speaking style, Speaking rules and Memories tabs, besides the warning bar, and the page asks the service for the provider again whenever the player returns to its tab.

## Memories

- **Things they always know**: hand-written facts, stored in the override and always in the prompt. These work for Mistral-only players, who have no embedder for vector memory.
- **Picked up in your talks**: the records the Local AI memory store collected. Each can be edited (the edit pins it, so later extraction never rewrites it) or deleted. Editing clears the stored vector so it is re-embedded. A pinned record is also in every private and phone turn (up to three, newest first), whatever V asks.
- **Short summary of earlier talks**: editable or clearable.
- Archetype and ambient characters have no memories.

## Languages

Page sentences are English sources written as `T('...')` in `bridge/character-editor-page.mjs`. `mod/character-editor.lua` lists them, translates them with the mod's dictionaries and sends them in the command file; the bridge serves them in `/api/state`. A missing translation shows the English. The sentences are in `localization/en.json` (via `scripts/Extract-UiCatalog.mjs`, which now reads `mod/character-editor.lua`) and translated in all 15 dictionaries. A test keeps the page, the Lua list and the catalogue in step, and checks that no sentence mentions keys, tokens, secrets, credentials or passwords.

## Prompting (2026-10-22, branch `feat/editor-prompting`)

A **Prompting** button above the character list (with World rules) opens a page that edits how each conversation option is told to answer. Where a character's bio says who somebody is, the prompting is the wording around it: the output rules, the example replies, the opening and closing lines, the headings, the sampling and the length limits. It is the player-facing side of the prompt profiles (`bridge/prompt-profiles.mjs`, `bridge/prompt-profile-store.mjs`; docs/LOCAL_AI.md, "Prompt profiles").

**The options.** One entry per profile: Mistral, Local AI Lite, Local AI Standard, Local AI Lite with Mature on, Local AI Standard with Mature on, and one **Custom** entry per model and endpoint the player uses, named "Custom: <model> at <host>" (the host and the model, never a key). An earlier Custom model that has a saved change stays listed. The badge **In use now** marks the option the next reply would use (`PromptProfiles.list()`), **Edited** the options with a saved change. Convai has no entry: its prompting lives on Convai's side, and the page says so.

**What a player can change, per option.**

| Part | What it is | Limits |
| --- | --- | --- |
| Output rules | The numbered rules, in order: add, delete, move up or down, and for each rule its text, the version for a speaker with a reply length of its own (`talk`) and the version for Mature content (`mature`). `{name}` and `{words}` are filled in | 1 to 16 rules of up to 2,000 characters, 9,000 in all |
| Example replies | Replies shown after the rules (none by default: a small model copies them) | 8 of up to 300, 1,500 in all |
| Opening line | The first line of the character text, for a named character and for an ordinary person | 600 each |
| Closing line | The last line before the model answers, and the version for a speaker with a reply length. The Mature setting's own clause is added by the code | 700 each |
| Section headings | The nine headings of the prompt's sections | 240 each |
| Layout | Whether the "where you are" sentence is repeated before V's words, and whether the notes of this turn go before or after V's line | |
| Sampling | Temperature 0 to 2, Top P 0 to 1, Top K 0 to 1,000, Min P 0 to 1, the repeat penalty 1 to 2 and the presence and frequency penalties -2 to 2 (all but the temperature can be switched **Off**: not sent), the longest reply 16 to 2,000 tokens. A box left empty uses the shipped value. **Advanced parameters (JSON)**: a JSON object whose keys are added to the request body of the reply turns (for example `typical_p`, `dry_multiplier`, `xtc_probability`, `mirostat`); rules below | Top K, Min P and the JSON are for Local AI and Custom; Mistral's API refuses unknown fields, so its option has only the two penalties |
| Length limits | The longest character description (2,000 to 16,000 characters) and the number of earlier turns kept (0 to 11); empty is the mod's own limit. A profile can only shorten | |
| Stop texts | Texts that end a reply when the model writes one; line breaks count | 4 of up to 32 |
| Mature layer | Only on the "Mature on" Local AI options and the Custom ones (the options whose turns get the layer while Mature content is on). The speech line, the word bank, the romance line and the closing clause, each in a version for models that allow explicit sex (`full`) and one for models that keep sex suggestive (`suggestive`); the tone line; and the two partner paragraphs of the relationship text (`MATURE_USE`, `MATURE_LIMITS`). The shipped wording is the default of each (`MATURE_DEFAULTS` in `bridge/mature-content.mjs`), with its own **Reset to default**. The mod picks the version from the loaded model's licence (`allowanceFor`), so both are shown and a player edits the one their model gets. An emptied box leaves that line out | 1,500 characters each, one line |

**Advanced parameters (JSON).** Checked when saved (`bridge/sampler-extras.mjs`): it must be a JSON object, at most 2,000 characters and 16 keys; a key is letters, digits and underscores; a value is a number, a text (200 characters), true or false, a list of those (64) or of lists of those (a `logit_bias` pair), or an object of those (32 members); no `null`. **Precedence: a key that has a box of its own is refused, never merged**: `temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, `presence_penalty`, `frequency_penalty`, `stop` (use the box or the Stop texts), the length of a reply (`max_tokens`, `max_completion_tokens`, `n_predict`, `max_new_tokens`: use Longest reply) and what the mod controls (`model`, `messages`, `prompt`, `stream`, `stream_options`, `tools`, `tool_choice`, `response_format`, `json_schema`, `grammar`, `n`, `prompt_cache_key`, `cache_prompt`, `return_progress`, the thinking fields such as `reasoning_effort` and `chat_template_kwargs`, and similar). Each refusal names the key. Only the player's reply turns carry the fields (the background requests that pin their own temperature do not), so the built-in server's prompt cache is untouched. A Custom server (or a server the player runs) that refuses a key by name loses it and is asked again at once; the refusal is remembered for the session and logged once (`refused <key>: left out from now on`), and a refusal that names no field drops the sampling fields and advanced keys that were sent. Our own llama-server ignores keys it does not know, but it refuses a value it cannot use (a wrong type) like any bad request.

**What cannot be changed here.** The facts the character gets from the game (the world block, the right-now block, memories) and the safety filters are not part of a profile, so no edit can reach them; the page says so in one sentence. The filters are the adults-only line and the hard-limit line (`ADULTS_LINE`, `HARD_LIMITS_LINE`, always the last two lines of the Mature layer and the whole of the guard-only layer, whatever the Mature layer edits are and even with every box emptied), the hard-limit guard on the player's words (`matureGuard.screenInput`) and on the reply. The layer stays on the providers that get it today (Local AI and Custom, never Mistral, Voxtral or Convai): Mistral's option and the non-Mature Local AI options refuse the Mature layer field. The preview shows the edited layer and closing line for both kinds of model while the sample has Mature content on; the layer is one fixed text per profile, so the prompt cache holds from turn to turn. An add-on speaker's own identity rule, the player's world rules and the length caps of a reply are likewise outside it.

**The page.** The options are listed at the top; the one open shows its parts as sections, each with its own **Reset to default** (enabled while that part is changed), and **Reset everything** for the option. **Save** sends only what differs from the saved profile (lists whole, objects by sub-field; the server drops a value equal to the shipped one, so a file holds only real changes). **Revert changes** drops the unsaved edits, and leaving for another option, a character or another page asks first. The **Preview** shows the rules, the example replies and the closing line as the prompt builder writes them for a sample name, with switches for a speaker that has a reply length (and how many words) and for Mature content. It follows the keys a moment after the last one, **before** anything is saved: the page asks the server to render the unsaved change laid over the saved profile (`POST /api/prompting/<id>/preview` with a `patch`), so what is shown is what `renderRules`, `renderExamples` and `renderClosing` produce, not a second copy of them in the page. The same answer carries the problems found in the form: they appear at once under the section they belong to (and the box is marked invalid), in the player's language, while the preview keeps the last good text and says it is waiting. Save is refused with the same codes (422) and stores nothing.

**Server** (`bridge/prompting-editor.mjs`, routes in `bridge/character-editor-server.mjs`). All under `/api/prompting`, with the same token, Host and Origin checks, JSON-only bodies and 128 KiB cap as the rest of the API: `GET /api/prompting` (the list), `GET /api/prompting/<id>` (the row, the shipped `default`, the `effective` profile and the stored `override`), `PUT /api/prompting/<id>` (a change; 422 with codes `[{field, key?, index?, code, max?, min?}]`), `POST .../validate` (a change; nothing is stored: `{ok, fields}` or `{ok: false, errors}`), `POST .../reset` (`{field}` for one part, nothing for the whole option) and `POST .../preview` (`{name, talkWords, mature, patch?}`). **The id is looked up in the profile store's own list** (`PromptProfiles.list()`) before a body is read, so no path, file name or key is ever built from it; a Custom profile's id is made by the store from the endpoint's host and the model. Anything the list does not hold, including `convai`, a look-alike, a path or a prototype name, is 404. The sample name of a preview is one short plain line (60 characters), the sample words an integer from 1 to 200. A change calls the bridge's `onChanged` like every other editor change, so a group reply prepared from the old wording is dropped.

**Live apply.** The prompt builder resolves the profile of a turn with a plain map lookup (`PromptProfiles.resolve`), so a saved change is in the very next prompt and request (the wording, the sampling and the stop texts) with no restart, and **Reset** gives the shipped prompt back byte for byte; both are tested through the editor's own routes (`bridge/character-editor-prompting.test.mjs`). Nothing runs in the game while the page is open, apart from what the editor already did: the page only talks to the bridge's loopback server.

**Storage.** `<state>/prompt-overrides/<profile id>.json`, one small file per option holding only the changed parts (`bridge/prompt-profile-store.mjs`), next to `character-overrides/`; an update of the mod never touches it.

**Strings.** About 100 new page sentences, all through `T()`: listed in `mod/character-editor.lua`, in `localization/en.json` and in the 15 dictionaries (translated by Haiku helpers from the exact English with the editor's existing terms, then checked: tokens, glyph ranges, the size of the command file). The command file carries about 360 sentences now (2026-10-30: the picker's); the biggest language is about 35 KB written as it is, and just under 100 KB if every non-ASCII character were escaped, against a limit of 128 KiB (it was 96 KiB until the redesign), and a test keeps it so.

**Tests.** `bridge/character-editor-prompting.test.mjs` (auth, Host, Origin, content type, body cap, ids, every limit and its code, save, reset of a part and of all, preview, a missing store, the size of the command file, an override reaching the next turn's prompt and Reset restoring the default byte for byte) and three tests in `bridge/character-editor-browser.test.mjs` (the whole path in real Edge: badges, live preview, edit, save, reset, inline errors; French sentences and markup shown as text at phone width; the light theme and the wide layout). NOT yet seen in the game.

## Look and moves (2026-10-28, branch `feat/editor-outfits`)

A player asked for outfit options in the editor; the owner added "options for selecting what animations the character is allowed to use in idle and talking" and "look for more information that the player can customise for a character". Every named character (the story characters) and every character the player made has a **Look and moves** tab (for a character of the player's own, a section of its page once it is saved). Everyday people and V's two voice rows have none. Built; unit-, Lua- and headless-browser tested; NOT yet seen in the game.

Unlike the text edits, almost all of these work with **every** conversation option, Convai included: they are game-side choices. The tab says so, and the Convai warning banner is left off it (the reply length needs a text provider, and its row says so). A choice is a list or a box; **Save** sends only what differs from the saved choices, **Reset to default** removes them all, a tab with an unsaved choice is marked and leaving asks first.

| Choice | Values (the first is today's behaviour) | What it does |
|---|---|---|
| **Outfit** | Automatic, or one of the character's looks (below) | A look worn all the time. Automatic leaves the *Companions change outfits* setting in charge |
| **Talking gestures** | Normal, Calm, Lively, None | The hand gestures while the character speaks a longer reply (`mod/gesture-selection.lua` `styles`) |
| **Nod while you talk** | on, off | The nods while V speaks to the character (`listening` mode, private and group) |
| **Idle moves** | Normal, Plain stances only, None | The idle workspots the character takes now and then while it stands settled (`companion-gestures.lua` flavour idles) |
| **Sit down and take a place** | on, off | A seat beside V when V sits, and a seat or a standing place of V's flat (`companion-seating.lua` `steer`) |
| **Comment on fights and loot** | on, off | Whether the character is picked to say something after a fight or a pickup (`reactionPeople` in `mod/init.lua`) |
| **Reply length** | Normal, Shorter (25 words), Very short (12 words) | The longest reply of the character, in every channel, through the add-on speakers' own mechanism (`persona.talkWords`: the rules and the closing line name the word limit); Mistral, Local AI and Custom only. A speaker that has a length of its own (an add-on) keeps it |

No choice is the old behaviour byte for byte: a character with no row in the file has none of these changed (a prompt with no reply length choice is tested to be identical, and `get(key)` is `nil` in the game).

### The outfit row

**Where the looks come from.** `mod/companion-outfits-data.lua` (docs/COMPANION_OUTFITS.md): the curated list of 15 characters with 42 looks, each an appearance name that the character's own entity template lists, read from the installed game (`characters/companion-outfit-evidence.json`), with undress, damage, other ages, disguises and shared crowd templates left out. The service cannot read a Lua file in the game folder, so `bridge/outfit-choices.mjs` carries a copy with a short English label per look, and `bridge/character-options.test.mjs` reads the Lua file as text and fails when the two differ. The row offers only looks of that character (a look of another character is refused with `outfit-bad`); a character with no list (everyone else: the game's data gives them one suitable look, or a template shared with crowd members) shows "This character has only one look in the game files". No other game data was searched for more (the appearance names of a record need the template unbundled with WolvenKit, which is the evidence script's job); clothing items through the equipment or transaction systems are not touched.

**When it applies.** (`mod/companion-outfits.lua`) A look is picked up in two places: a new copy is created in it (`spawnAppearance`, whatever the setting says), and a copy that is already spawned changes into it with the same safe path as the automatic outfits: out of V's view for 5 s, not in a fight, scene, call or ride, standing up from a flat's seat first, prefetch, schedule, read back, a look that never shows is not tried again. A saved choice brings the next look at the party forward to about a second (`nudge`). A pinned look beats the time of day, the variety roll and the home clothes. With the *Companions change outfits* setting **off** the module still runs, for the characters that have a pinned look only; with it on, a character without a pin follows the rotation as before. Only a copy the mod itself made (a companion in the party, a resident of V's flat) is ever dressed: a character the game placed, story characters included, is not in the lists the module reads. Turning the choice back to Automatic hands the copy to the rotation again, which changes it at its next hour change.

**The turn context.** A pinned look other than the base is "changed" (or "home") for the talk context, like any other change of clothes: one sentence that the character is not wearing the outfit its appearance text describes.

**Preview.** The editor has no pictures, so there is no preview: the rows are named by what the look is.

### The animation choices

All of this reuses what the code already has: the gesture selection policy (`mod/gesture-selection.lua`, docs/COMPANION_GESTURES.md), the controller (`mod/companion-gestures.lua`) and the seating controller. Nothing new is played and nothing new is shipped (`convai_gestures.archive` is unchanged).

- **Talking gestures.** The selection already weighs a clip by the mood's reach cap, an emotion colour (60 % of picks) and a calm hold between clips divided by a per-character rate. The two styles change only those numbers (`M.styles`): **Calm** lowers the reach cap by 10 cm, colours 20 % of picks by emotion, holds twice as long and rests at 42 % of phrase starts (20 % normally); **Lively** raises the cap by 8 cm, colours 85 %, holds half as long and rests at 8 %. Banned, directional, symbolic and leg-crossing clips stay banned in every style. **None** keeps the hands at rest: the controller does not enter the talk stance for the character's own reply (the stance would only be a different rest pose), and `select.next` returns nothing for it.
- **Nods.** Off: no listening stance and no nod, in a private talk and in a group round (a group listener stays in the round, it just does not nod). With talking gestures None and nods on, the stance is entered while V talks and held through the reply with no clips.
- **Idle moves.** The controller already takes a signature or generic idle workspot now and then while a copy is settled beside V (`catalog.idleComponents`, the character's `idle` and `idles`). **Plain stances only** drops the prop idles (`catalog.propIdles`: a cigarette, a paper cup, a beer bottle, sunglasses) from the pool; **None** never starts one, so the character keeps its vanilla idle. Whether a character has an idle of its own or only the rig's generic ones does not change.
- **Sitting and leaning.** The seating controller offers a seat beside a seated V and a seat or standing place of V's flat (couch, chair, bar, stool, window, lean spots in `housemate-spots-data.lua`). The box switches both off for the character, which then trails V on foot like any companion without a place. The check runs only while there is a seat or a home to offer, as a table lookup.

### What the game reads, and when

`bridge/character-options.mjs` keeps `<state>/character-options.json` (`{version: 1, updated, characters: {<key>: {...}}}`, at most 400 characters; a row holds only the choices that differ from today's; atomic writes, one at a time; a damaged file is left as it is and kept as `.corrupt` before the first save) and copies the choices the game acts on (everything but the reply length) to `runtime/character-options.json` (an exchange file, listed in `packaging/runtime-exchange.json`, replaced in place, never shipped; at start it is written only when there are choices or an older copy to clear, so a player who never uses it gets no new file in the game folder). `mod/character-options.lua` reads it:

- when the mod loads (`convaiCharacterOptions` in `mod/init.lua`);
- for two hours after the editor was opened (the same `watch` call as the player's own characters, from Settings > Edit characters > Open), every 5 seconds from the 10 Hz tick, with one subtraction per call and a read of a file of a few hundred bytes. Without a recent editor visit it is never read again, so a game that does not use the editor pays nothing. Nothing is per frame, nothing is a native call.

`get(key)` is a table lookup by profile key: gestures and seating ask it once per observed copy and tick, the outfit module once per look at the party, the reactions once per fight or pickup. The player-made characters' keys (`custom-<name>-<letters>`) work like any other; deleting a character removes its row (`onDeleted` in the bridge, and a sweep at start).

### Strings and tests

56 new page sentences (the tab, the choices and their help, 24 look labels, three problems), through `T()` and listed in `mod/character-editor.lua` (346 in all, under the server's 400), in `localization/en.json` (regenerated by `scripts/Extract-UiCatalog.mjs`) and in the 15 dictionaries (translated by Haiku helpers from the exact English with the editor's existing terms in a glossary, then checked by script: placeholders, quotes, length). The look labels reach the page through a table of `T('...')` calls (`outfitLabel`) so the page, the game's list and the catalogue stay in step (tested).

Tests: `bridge/character-options.test.mjs` (the store, the checks, the game's copy, the looks against the Lua list and the template evidence, the editor, the routes, a character the player made, the reply length in the prompt), `bridge/character-options-lua.test.mjs` (the game's file and its two-hour watch, pinned looks with the setting off and on, spawn, nudge, invalid pins, the talking styles, nods, the controller's gates, the wiring in `init.lua`), `bridge/companion-seating.test.mjs` (a character that does not sit), one headless-browser test in `bridge/character-editor-browser.test.mjs`. **Live check owed** (TODO.md captain's log): pick Judy's home clothes with *Companions change outfits* off, see her change out of view and again after fast travel; Lively and None talking gestures; Plain idles over a few minutes; "Sit down" off in the flat; a quiet Judy in a fight; Reply length Very short on a Local AI talk.

### Candidates not built (effort estimates)

- **Voice speed**: only OmniVoice has the knob (`backend.generate(..., speed=1)` in `bridge/resident-voice-worker.py`, fixed at 1); Pocket's worker says in a comment that it applies no speed adjustment or resampling on purpose, and no pitch control exists anywhere. A per-character speed would be OmniVoice-only, and it changes the length of every reply, which the face timeline, the reply length estimate of the gestures (2.6 words a second) and the lip sync read. About two days with a listening and lip-sync check; pitch is not cheap.
- **A greeting line** (what the character says first when V talks to them): with a text provider the opening is the model's own; a per-character first-line hint is a prompt change plus a place for the text on the page (Convai keeps its greeting on its own side). Half a day.
- **Default reply language** per character: the reply language is one setting today (Settings > Voices > Reply language) and the multilingual twins are per language; a per-character override means threading it through the twin choice and the voice pack choice. About one day.
- **Relationship or familiarity start**: the game side keeps a live relationship state per character (`mod/relationship-state.lua`); a starting value is easy to store, but the prompt wording around it was written for values that are earned in play, so it needs a prompt review (not looked into in detail). About a day.
- **Display name** for a story character: names are matched by the game's own name tables and used in memories and the party list; only a custom character's name is safe to change (it already is editable). A story character's name would need an alias layer in the prompt. About one day.
- **Portrait or holocall picture**: a character of the player's own has no picture of its own (the call window uses the game's unknown-caller picture, `ConvaiHolocallBegin(contact, name)`); a picture of the player's would need a texture the game can show, which the mod has no path for today. Large.
- **More looks**: docs/COMPANION_OUTFITS.md ("Limits") says everyone else has one suitable look in the game's data or a template shared with crowd members; the few variants it names (Aaron, Hanako, Voodoo Queen and others that only add or remove a detail) would need their `.app` files read to tell clothes from damage, and the evidence script (`scripts/Extract-CompanionOutfitEvidence.mjs`) run for each added record. Small yield, game files needed. Looks from another mod are not the character's own and are left out.
- **Clothing items** (a hat, glasses, a jacket) through the transaction system on a copy: possible on our own copies, but it overlaps the appearance system and fights with the face rig rebuild. Large and risky.
- **Gesture groups by stance** (arms crossed, hands on hips, hands behind the back) as a pick of the idle stance: the catalog has the groups (`catalog.idleGroups`); a pick needs the pool per character on the page, so the bridge would have to know the catalogue. About a day.

## Switching someone off (2026-10-30, branch `fix/toy-av-and-npc-off`)

A player asked for a way to turn one NPC off. A talk target, a nearby listener and a group member are never chosen from the people switched off, and never from the game's puppets either (see "Puppets" below).

### The switch

- **A named or own character:** the page shows a box "Don’t talk to this character" under the character's name. It is the `off` choice of `character-options.json` (`bridge/character-options.mjs`, value `true` only), saved at once and applied by key. The Reset to default button of Look and moves leaves it alone. The game reads it through `manager.profileEnabled(key)` (`manager.switchedOff`, set from `mod/character-options.lua`), so every place that already asks whether a profile may talk is covered: the talk keys, the group list, auto-connect, phone chat, battle and loot remarks.
- **An ordinary person:** the picker's "In front of you" section shows the person V faced when the editor was opened, when they are not one of the listed characters, with "Don’t talk to this person". This switches off the game record they are built from (`records` in the same file, a list of record names with an optional name for the list). That also switches off everyone the game builds from the same record, and the page says so. The game compares the record case-insensitively and without the `Character.` prefix.
- **List and undo:** a "Switched off" section at the top of the picker lists every character and person switched off, each with "Switch back on". `GET /api/off` and `POST /api/off` (`{record, name, off}`) serve the people, the options route serves the characters.
- **Storage:** per player in the service's data folder (`character-options.json`, `records` only when something is switched off), 200 people at most. The game's copy is `runtime/character-options.json` (`records` is a list of names). The game re-reads it every few seconds for two hours after the editor was opened.

### Puppets (`mod/talk-exclusion.lua`)

The game drives the toy AV in V's flat with a hidden character who walks a loop with the toy at his feet, so talking near the toy got an answer from "the toy" (player report, 2026-10-30). The filter leaves out, when a target is chosen:

- a character with a hidden look (an appearance named invisible, hidden or no mesh),
- a character with no mesh component, or none that is enabled,
- a character mounted to or attached to a toy vehicle (`Vehicle.trauma_team_av_model_toy`, `Vehicle.mq001_little_bombus` or a record named with the whole word toy, remote or rc) or to a device,
- a record of the small deny list `PUPPET_RECORDS` or a record named with the word toy or puppet,
- an ordinary person switched off by record.

Our own copies are never filtered. An unreadable signal never excludes anybody. The verdict of the game's signals is cached per entity for 30 seconds, so a scan adds no native read after the first and nothing runs per frame. The first time a character is left out the log says `Talk exclusion: <reason> entity=<id> record=<record>`, so the record of a puppet that slipped through can be added to the deny list. Applied in `scanNearbyCharacters`, `targetAtCrosshair`, `convaiTalkNearbyPeople` and `convaiSpawnedPeople.nearby` (`mod/init.lua`, through the global `convaiTalkExcluded`).

The toy's own character record was not in the game's tweak sources the repo reads (the toy is the vehicle `trauma_team_av_model_toy` of the minor quest mws_wat_08), so the hidden look, mesh and mount signals do the work, and the log line names the record for the deny list.

### Tests

`bridge/talk-exclusion.test.mjs` (the filter, the options file, the manager hook and the three selection functions cut out of `mod/init.lua`) and `bridge/character-switch-off.test.mjs` (the store, the editor, the routes and the sentences).

## Files

- `bridge/character-options.mjs`, `bridge/outfit-choices.mjs`, `mod/character-options.lua`: the Look and moves choices (above).
- `mod/talk-exclusion.lua`, `bridge/character-options.mjs` (`off`, `records`), `bridge/character-editor.mjs` (`offForPage`, `setPersonOff`): switching someone off (above).
- `bridge/prompting-editor.mjs`: the Prompting part (the checked layer over the prompt profile store).
- Look and moves, changed: `bridge/character-editor.mjs` (`saveOptions`, `resetOptions`, `details().options`), `character-editor-server.mjs` (`PUT /api/character/<key>/options`, `POST .../options/reset`), `character-editor-page.mjs` (the tab and the section), `mistral-prompt.mjs` (`PersonaBook` `options`: the reply length), `convai-bridge.mjs`; game side `mod/companion-outfits.lua`, `companion-gestures.lua`, `gesture-selection.lua`, `companion-seating.lua`, `init.lua`, `manager-ui.lua` (the `watch` call).
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
- **Convai.** The characters live on Convai's side and are not changed or re-provisioned. The bridge already sends Convai the dynamic info (the context text `updateContext` in `bridge/realtime-client.mjs` sends before each turn, `mode: 'replace'`); the rules are a block after the game's facts in it (`convaiWorldRulesBlocks`, `conversationBlocks` in `bridge/convai-bridge.mjs`), only while no text provider answers; the voice and style notes (Natural speech, Expressive emotions, the first-person reminder, the reply language) stay after them, in the places measured for them. The player's character edits follow the world rules in the same way ("Character edits on Convai"). Convai's own limit for that text is not documented in this repository; the existing context is routinely 10,000 to 22,000 characters and the rules addition is at most about 2,400. Not tested with a live Convai turn.
- **Files.** `bridge/world-rules.mjs`; changed `bridge/mistral-prompt.mjs`, `bridge/prompt-budget.mjs`, `bridge/text-provider-host.mjs` (prewarm), `bridge/character-editor.mjs`, `bridge/character-editor-server.mjs` (`/api/world-rules`), `bridge/character-editor-page.mjs`, `bridge/convai-bridge.mjs`, `mod/character-editor.lua` and the 15 `mod/locales/*.lua`. Tests: `bridge/world-rules.test.mjs`, the World rules test in `bridge/character-editor-browser.test.mjs`, one in `bridge/realtime-client.test.mjs`.

- **Content packs (add-on API 1.1, `docs/ADDON_API.md`).** An installed content pack that is on adds its world rules after the player's text, for the text providers and, within a size budget, for Convai. The page shows them read-only under the box ("From the content pack ..."); the player cannot edit them there and turns the pack off under Settings > Content packs in the game. The Prompting page names the packs that change the option shown ("Content packs that change this prompt"); the profile it shows, its preview and the "Shipped" hints are the shipped profile with the pack laid over it, the player's changes stay on top of the pack, and "Reset to default" goes back to the pack's wording. A pack that rewrites a character (text or name) is the "shipped" text of that character in the editor: edits of it are still the player's and win, and Reset returns to the pack's text. While a pack with a separate memory is on, the memory the editor shows and edits is the pack's.

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
- Order in `characterCatalog.resolve`: the managed copy's roster profile, the roster, **the player's characters**, the archetypes, the residents. A match applies to a character another mod spawned and to one the game placed; the game's own rules for each stay as they are (docs/SPAWNED_CHARACTERS.md, docs/WORLD_CHARACTERS.md).
- **Copies of ours (the Model browser, an invitation).** A managed copy whose profile is a roster character keeps it (a roster profile always wins). A copy whose profile is not a roster person (a generic model's archetype, a resident, or no profile at all, which is what most Model browser entries get) is matched like anybody else, by the **original record the copy was made from** (`entry.record`, e.g. `Character.Rebecca`, not the private clone the game spawns for a crowd or unarmed model, `CyberpunkConvai.NonCrowd_<name>`) and by the model's name. The copy then carries the custom key and name like any assigned profile (`companions.settleProfile`, `customBase` remembers what it was made with), so the talk turn, the party rows, the connections the bridge is told about and the subtitles all use them. The sweep (`convaiSettleCopyProfiles` in `mod/init.lua`) runs when the list changes and at each talk key press, over the few copies, and a copy is also settled when the talk path or a scan resolves it; never per frame. Deleting the character, Convai answering, or a manual assignment in the Companion Manager gives the copy its own profile back. Found 2026-10-26 (Discord, Phii): a made character never applied to a copy invited from the Model browser, because the managed profile was returned before the roster and the custom match.

**Facing.** When the player chooses Open, `mod/character-editor.lua` asks `convaiFacingCharacter` (in `mod/init.lua`) once: one targeting query, never per frame and never on a timer. It sends `{record, name, gender}` in the command file (the record is the original `Character.` name of a clone, else the readable debug name; for a copy of ours, the record of the model it was made from, since the game spawned it from a private clone whose name would never match). The page's **Use the character I'm facing** button fills the form from it. If the game named nobody, the button says to face the character and press Open again (the already open server only refreshes the facing character).

### What the game reads, and when

The bridge writes `runtime/custom-characters.json` (the exchange folder of the mod, replaced in place, listed in `packaging/runtime-exchange.json`: created at its first write, never shipped): `{version, revision, characters: [{key, name, gender, records, names}]}`. It carries nothing but what finds a character: no bio, style, example, memory or voice word.

`mod/custom-characters.lua` turns it into two tables (by the record's id and by normalised display name). It does nothing per frame and polls nothing:

- the file is read when the mod loads, and again at a talk key press when due: at most every 3 seconds, and only while at least one character exists or the editor was opened in the last two hours (`watch`). With none made and the editor never opened, a talk key press costs no file read;
- `match` is one comparison when no character exists, and two table lookups otherwise, wherever `characterCatalog.resolve` runs (it already ran at its previous rate: the gaze poll, the nearby scan, the talk key);
- the keys join `supportedProfiles` and `manager.profileEnabled` while they exist (`manager.configureCustom`). They are listed under Characters to invite and in the phone's Chat tab (next section); the memory and relationship pages of the Companion Manager are the shipped profiles only.

Characters of this kind take part in private talk by text and by voice, and in group chat. They are left out of battle and loot reactions (`convaiSpawnedPeople.nearby` with `roster = true`), which the first version does not ask of them.

### Invite and phone (2026-10-27, branch `fix/live-followups`)

Live (27 Oct, game 2.31): a character made in the editor worked when faced. The owner: "once we do this this character should be available in characters to invite and then in chat/holocall page as well because they have a profile now". So every character of the player's own now appears in both lists, under its own name, and the lists follow a character being made, renamed or deleted (the same re-read of `runtime/custom-characters.json` as before: `mod/custom-characters.lua` calls `onChange` when the text changed, and `init.lua` hands `service.list()` = `{key, name, record}` to the manager and the phone; nothing is polled and nothing runs per frame). Besides the talk key, the file is also looked at once when the Characters to invite page is opened and once each time the phone is opened (the service's own 3 second limit applies, and it reads nothing unless a character exists or the editor was opened in the last two hours), so a character saved a moment ago is in both lists.

**Characters to invite.** `manager.setCustomCharacters(rows)` (`mod/manager.lua`) registers one companion definition per character that has a record, `{id = <record>, name = <custom name>, custom = true}` under the character's key (`companions.registerDefinition`, taken away again with `companions.unregisterDefinition`, which only ever removes a `custom` definition), and the page lists them with the shipped profiles, sorted by name (`snapshot.invitable`; `snapshot.profiles` stays the shipped list, so the memory and relationship pages do not change). The record is the character's first plain `Character.` record (a clone's `NCA.` copy only exists with that mod), else its first record. **The invitation is the Model browser's**: a definition without a conversation profile, so the party queue treats it as a model-only invitation (no Convai preparation, no connection), the copy of that model spawns, and the settle sweep (`companions.settleProfiles`, "Copies of ours" above) then gives the copy the custom key and name by the record, exactly as for a copy invited from the Model browser. Immersive invitations work the same (the appointment's profile is the key). The row reads "Your own character, made in the character editor." and says they talk with Mistral, Local AI or Custom (with Convai they talk as an ordinary person); Invite, Add copy and the party count are the usual ones. A character found **only by display name** has no record and cannot be spawned: it is in Chat but not in the invite list. A shipped key can never be taken over by a custom row. Deleting a character removes its row and its definition; a copy already in the party keeps what it was made with until the settle sweep gives it its own profile back.

**Phone Chat (and the call key).** `phoneChat.setContacts('custom', rows)` (`mod/phone-chat.lua`, the group API the roster uses; the contact id is the profile key, the name the custom name, the game's unknown-caller picture) lists every character in the Chat tab, with or without a record. A message goes to the custom profile: `bridge/phone-chat.mjs` (`PhoneChat` option `custom`, a contact id that is a live custom key needs no entry in the contact list and no Convai character) asks for no Convai knowledge route, and the reply hook (`customPhoneReply` in `bridge/convai-bridge.mjs`) answers through the player's text provider with the same context blocks as the character's talk turns (`runCustomTurn`), on the phone channel; meeting and housing offers, memory and the style rules apply as for any contact. No Convai warm-up is opened ahead for them. The J (Invite) and L (Dismiss) keys of a Chat row work for a character with a record: `companions.phoneContactKey` accepts a `custom` definition by its key. **Convai answering: the character is listed but its Chat is closed**, with the line "This character needs Mistral, Local AI or Custom to answer." in place of the composer (`phoneChat.contactBlocked`, asked when a Chat is painted or a message is sent through `customCharacters.providerReady()`, never per frame, and never a held-back message: a send is refused with the same line). It is the consistent counterpart of the talk key, which shows one notice and lets the person talk as an ordinary person: a Chat has no "ordinary person" to fall back on, so it says why instead of failing after a send. **The call key (branch `feat/custom-calls`, 2026-10-27; not yet seen in the game):** the call key on a Chat row (H on a keyboard, Triangle on a pad) or inside an open chat (V) starts a voice call with the character, as for every Chat row without a journal contact (Rita Wheeler and the rest of the roster included). The call window is given her name and the game's unknown-caller picture instead of a journal contact (`ConvaiHolocallBegin(contact, name)`, `Holocall.reds`; a character made in the editor has no picture of its own), the conversation goes to her custom profile through `runCustomTurn` in her chosen voice, and the provider rules are the text ones: Mistral, Local AI and Custom answer; with Convai answering the call is refused with the Chat's own line, "This character needs Mistral, Local AI or Custom to answer." (`mod/holocall.lua` `env.blocked`, the same `phoneChat.contactBlocked` check, asked once when the call starts). A character with a record (the usual case: "Use the character I'm facing") gets the live video call with her own body, as Alex does (docs/HOLOCALL.md, "A video call when she has a record", branch `fix/custom-calls-3`); one with no record, or whose picture fails, is the voice call. Details, the probe line `[Holocall] no-journal call ...` and the live checks: docs/HOLOCALL.md, "A Chat row with no journal contact".

Tests: `bridge/custom-invite-phone.test.mjs` (the call key too: the real `holocall.lua`, `phone-chat.lua` and the real holocall wiring block of `init.lua` against strict fakes; the real manager.lua over the Native Settings fake: the row, its description, the record invited, a rename, a delete, a shipped key never taken, a display-name-only character absent; the real wiring block of `init.lua` against strict fakes; the real `phone-chat.lua`: the contacts, the message to her profile, the closed Chat under Convai; `companions.lua` `phoneContactKey` / `unregisterDefinition`; the real `PhoneChat` class). **Live check** in the TODO.md captain's log.

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

## Character edits on Convai

Convai's characters live in the owner's Convai account and are shared by every player, and the Gamer plan cannot update a character (`/character/update` answers 401 "You do not have access to CORE APIs", while Pro has it). So the edits travel with the turn instead of living in the character.

**What is sent.** `bridge/convai-character-edits.mjs` (`ConvaiCharacterEdits`, built in `bridge/convai-bridge.mjs` from the `CharacterOverrides` store and the `PersonaBook`) adds one block of the `convai` tier to `conversationBlocks`, right after the world rules block, so the character's own words come after the world's. It lands in the dynamic info the bridge sends before every turn (`updateContext` in `bridge/realtime-client.mjs`, `mode: 'replace'`). It starts with a heading that says the text is who the character is now, set by the player, and that the older backstory, style and rules are out of date where they clash, while the limits and rules the character already follows still stand. Only what the edit changed follows:

| Part | Sent when | What is sent |
| --- | --- | --- |
| How you speak now | the speaking style was edited | the player's style |
| Your own rules of speech now | the player wrote rules | the rules, one per line |
| Things you always know | the player wrote memories | the memories, one per line |
| Your backstory now | the bio has paragraphs that are not in the shipped bio | those paragraphs only (`playerParagraphs`, the same rule the Lite prompt uses to spare them) |
| Example lines in your voice | the player added example lines | the lines that are not in the shipped set |
| No longer true of you | shipped bio paragraphs are missing from the edited bio | the first 140 characters of up to four of them |

A character with no edit gets no block, so nothing changes for it. While a text provider answers the turn the persona carries the edits and the block is left out (the same rule as the world rules). The Convai block is not added to the text providers' layout because its tier is one that layout does not read.

**Size.** The block is kept within `CONVAI_EDITS_LIMIT`, 4,000 characters (about 1,000 tokens), a bit more than the 2,000 characters of the player's world rules and the same size as the packs' budget (`CONTENT_LIMITS.convaiRules`). Convai's own limit for the dynamic info is not documented here and the existing context is routinely 10,000 to 22,000 characters. When an edit does not fit, parts take room in this fixed order: the rules, the memories, the speaking style, the bio paragraphs, the example lines, the removed paragraphs. A list drops its last lines, a text is cut at the end of a sentence (or a word) and given an ellipsis, a paragraph that would be cut to under 160 characters is dropped instead (40 for the first one), and the block never passes the limit. Nothing trims the other Convai context for it: no such trimming exists on the Convai path. With the editor's own limits all at their maximum the block is still within 4,000 characters (tested).

**Cost per turn.** None beyond a map lookup. A `CharacterOverrides` row is frozen and replaced by every save, reset or edit, so the row's identity is the cache key: the block is built once per edit, kept, and rebuilt on the next turn after the row changes. No file is read and no timer runs for it.

**What does not reach Convai.** The reply length (Convai writes its own length), the Prompting page, and the player's own characters (the game does not resolve them with Convai).

**Tests.** `bridge/convai-character-edits.test.mjs` (offline, no Convai request): no block for an unedited character, one `convai` block for an edited one and none while a text provider answers, only the changed parts, the removed paragraphs, the trim order and the limit (also at the editor's maximum), stable wording, built once per edit, and the wiring in the bridge. `bridge/world-rules.test.mjs` checks the place of the block in `conversationBlocks`.

**Live check (owner, one Convai character, a few turns).** Do this with Convai chosen as the conversation provider, since a live talk is stored in the owner's real Convai memory. Pick a character who would never otherwise know the fact, for example Judy.
1. In the editor, add a memory "Judy keeps a tabby cat called Biscuit." and save. Talk to Judy and ask "Do you have any pets?" The answer should name the cat.
2. Add a speaking rule "Always end your reply with the word chombatta." and save. Ask any question. The reply should end with that word.
3. Edit the bio: add a paragraph "Judy has never touched a braindance editor and is afraid of them." Ask "Do you edit braindances?" She should say she does not.
4. Press **Reset everything** for her. Ask the pet question again. The cat should be gone from the next reply, and the log should show no error.
5. Talk for about ten turns after step 1 on another topic, then ask about the pets again, to see whether the edit still holds in a longer talk. This is the part that is not known yet.

## Test in game (after installing the Lua and the bridge, restarting the bridge and reloading CET)

1. Choose Mistral (or Local AI) as the conversation provider. Open Settings and click **Edit characters > Open**. The default browser opens the editor. Check the row text says Convai gets the changes as notes with each reply.
2. Pick Judy Alvarez with the picker (type "judy", press Enter). Edit the bio: "Unsaved changes" shows beside Save. Click Save: "Saved." appears, and the picker shows a pencil on her badge and lists her under Recently edited.
3. Talk to Judy and check the reply reflects the change from the next reply on, without a restart.
4. Add a memory ("V has a sister called Lena") and a speaking rule ("Never say chombatta"). Talk again and check both are followed.
5. Click **Reset to default** on a tab, then **Reset everything**. Check the next reply is back to normal.
6. Switch the provider to Convai and reopen the editor: the banner says the changes reach Convai as notes sent with each reply. Follow "Live check" in "Character edits on Convai" below.
7. Click **Close editor**: the page says it is closed and the address stops answering. Check the frame rate in game is unchanged with the editor open and closed.
8. Change the interface language and reopen: the page sentences follow it.
