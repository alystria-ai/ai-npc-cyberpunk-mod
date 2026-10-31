# Companion Manager in Mod Configuration Menu and Native Settings UI

The manager has two hosts that draw the same pages (`mod/manager-ui.lua`) and read and write the same saved settings:

- **Mod Configuration Menu** (MCM, the CET mod `ModConfigurationMenuAPI`, [Nexus Mods 31640](https://www.nexusmods.com/cyberpunk2077/mods/31640)),
  version **0.10.5 or newer**: the default. The manager is a mod of MCM named **AI Companions** (see "The MCM host").
- **Native Settings UI** (NSUI: the CET mod `nativeSettings`, [Nexus Mods 3518](https://www.nexusmods.com/cyberpunk2077/mods/3518),
  developed against 1.96): optional, for players who prefer it. The manager is one tab, **AI Companions**, on its Mods screen.
  Every control is one of NSUI's own widgets (switch, selector, slider, button); nothing is drawn with ImGui.

No file or saved preference of NSUI, MCM or any other mod is edited. The manager needs one of the two: Mod Configuration Menu 0.10.5 or
newer, or Native Settings UI. With both installed, MCM hosts it and the Native Settings UI tab does not exist (not registered, or taken down if MCM turned up late; see "Both installed"); both hosts still read and write the same saved settings. The player opens
it with the manager shortcut, with **Esc, Mods, AI Companions** (NSUI), or from MCM's own list.

The page below ("Page layout", "Player flow") is the same in both hosts. "How a change is applied" and "How lists page" describe the
NSUI host; the MCM host differs where it says so ("The MCM host").

Thanks to Antrix, the author of MCM, who exposed the calls this host needs through MCM's public API in 0.10.5 and wrote a reference
port of the manager to it. This host follows his port and the 0.10.5 source of the public API.

**2026-10-19: moved from MCM to Native Settings UI.** The manager used to be a Mod Configuration Menu provider (`mod/mcm.lua`). The
reasons were player reports that the manager did not show, that MCM takes over the Native Settings UI and Mod Settings screens, and
that sub-pages stuck. The page logic moved to `mod/manager-ui.lua`, the NSUI host is `mod/nsui.lua`, the shortcut is
`mod/nsui-entry.lua`. `mod/mcm.lua`, `mod/mcm-entry.lua` and `mod/mcm-fonts.lua` no longer exist. The log file keeps its old name,
`runtime/mcm.log`, so reports and tools keep working.

## Page layout

```
Mods screen (Esc > Mods)
 +-- tab "AI Companions"            id aiNpcCyberpunkMod; one tab for the whole manager
      +-- section "Companion Manager"      first section of every page, kept when the page changes
      |     Home:         Characters to invite, Parties, Model browser, Character editor,   (button "Open")
      |                   Key bindings, Settings
      |     other pages:  the Back row at the TOP                                         (button "Back")
      |     then, only when there is something to say: one feedback line
      +-- the sections of the page that is open (table below)
```

| Page | Back goes to | Sections |
| --- | --- | --- |
| Home | none | none: the six destinations are the page (the fourth, Character editor, opens the browser at once and has no page; Key bindings sits between it and Settings) |
| Key bindings | Home | one section for each of the seven actions (the key set here, the key set in Cyber Engine Tweaks, Set, Clear), Controller (`docs/KEY_BINDINGS.md`) |
| Characters to invite | Home | Characters to invite |
| Parties (was Current party until 2026-10-28) | Home | Your group (only while a companion drives), Current party, one Saved party section for each saved party |
| Model browser | Home | Installed character models |
| Settings (since 2026-10-30 a list of category pages) | Home | one **Open** row with a line of help for each category page, in this order: AI provider, Voice AI and microphone, Conversations, Companions, Night City, Interface, Content packs (only while an add-on has settings or the bridge lists a content pack), Privacy and help |
| AI provider | Settings | AI provider (the provider rows, see "Settings") |
| Voice AI and microphone | Settings | Voice AI and microphone |
| Conversations | Settings | Conversations |
| Companions | Settings | Companions |
| Night City | Settings | Night City |
| Interface | Settings | Interface |
| Content packs | Settings | one section per installed add-on that has settings, then Content packs (one switch per content pack) |
| Privacy and help | Settings | Privacy and help |
| Memory | Conversations | Memory, Whose memories |
| Dynamic info | Conversations | Dynamic info (twelve switches, `docs/DYNAMIC_INFO.md`) |
| Relationships | Conversations | Relationships (one selector per character that has the setting) |
| Help and support | Privacy and help | Setup check, If something goes wrong, Report for the developer, Where the logs are |
| Convai paid tier | AI provider | Convai paid tier, Plans |
| Custom endpoint | AI provider | Custom endpoint (the endpoint URL, API key and model ID rows and Test connection) |
| Custom voices | Voice AI and microphone | Custom voices (`docs/INWORLD.md`, Remote OmniVoice) |
| OmniVoice for AMD | Voice AI and microphone | OmniVoice for AMD (only when the service says this PC offers it) |
| Immersive invitations | Companions | Immersive invitations (six rows: the switch, how she arrives, when, how long she waits, the waypoint, her texts; `docs/IMMERSIVE_INVITATIONS.md`) |
| Housemates | Companions | Housemates (six rows and a button: the switch, Off by default, Housemates talk to each other, Move-in apartment, Pause between chats, Housemates in one chat, and Evict all housemates; `docs/HOUSEMATES.md`) |

The Back row reads "Back to Companion Manager" on the first four pages, Key bindings and Settings, and "Back to settings" on the others. Since 2026-10-30 each category page goes back to the Settings list, and a page that opens from a row of a category page goes back to that category page (its help names it, "Return to Conversations."): Memory, Relationships and Dynamic info to Conversations, Immersive invitations and Housemates to Companions, Custom voices and OmniVoice for AMD to Voice AI and microphone, Convai paid tier and Custom endpoint to AI provider, Help and support to Privacy and help. It is the first row of
the first section, so it is always the first row of the page. Memory (Manage), Dynamic info (Open, since 2026-10-22) and Romantic relationships (Open, renamed 2026-10-30 so it is not taken for the Relationships page of the home) are rows of Settings > Conversations, Help and support is
the first row of Settings > Privacy and help, and Convai paid tier is a row of Settings > AI provider under the Convai API key row, and Custom endpoint (Open, since 2026-10-20) a row of the same page right after the Mistral key row. The Help
entry is absent when `mod/support-report.lua` did not load, the paid tier entry when `mod/convai-paid-tier.lua` did not (both are loaded
behind `pcall`). Romantic relationships is absent when no character has a relationship setting.

A row of the page is one of four kinds, built by `setting(...)`, `action(...)` and `readonly(...)` in `mod/manager-ui.lua`:

| Kind | NSUI widget |
| --- | --- |
| `setting`, type `bool` | switch |
| `setting`, type `select` | string selector |
| `setting`, type `int` | integer slider |
| `action` | button (its text is the `value`) |
| `readonly` | a line of text with nothing to press. In NSUI it is a button whose frame is hidden (`hideFrames` in `mod/nsui.lua`): a short value is the button text, a long or missing value leaves the label alone, "Label: value". The Settings page has no read-only line any more (Voice status and Johnny's standing were removed 2026-10-20); the others are the Memory, Help, list and paging lines |

**The first page.** The manager always opens on Home: after the player leaves the tab for another one, after the Mods screen closes,
and on the shortcut. A hook on `SettingsMainGameController.OnInitialize` makes the tab ready on its first page before NSUI builds a
Mods screen that was opened by hand; it does nothing for the game's own Settings screen. A save load resets the page too.

## Player flow

- **Home:** six destinations: Characters to invite, Parties, Model browser, Character editor, Key bindings, Settings (2026-10-25: Key bindings between the
  Character editor and Settings). All but the Character editor move to a page of the manager.
  **Key bindings** (`docs/KEY_BINDINGS.md`) is where the player gives the mod's own actions a key or controller button (press its Key or button row, then the key; Clear). Set and Clear are
  actions, applied at once on both hosts (MCM refuses an action while drafts are pending, as for every button). Since 0.3.4 there is no Controller talk button: a controller button is given to Talk by voice here. **Character editor** (id `character-editor:home`, button "Open") has no page in the game: it is an `action` row, shown only
  when `mod/character-editor.lua` loaded, and pressing it opens the character editor in the player's browser through the very request of
  Settings > AI provider > **Edit characters** (`editor.request()`: one small `runtime/editor-command.json`, nothing polled and
  nothing per frame). The player stays on Home; the result is the line under the way back (NSUI) or the status line (MCM): "Opening the
  editor in your browser. Switch to your browser if it does not come to the front.", or, when the service is stopped, "The conversation
  service is not running, so the editor cannot open. Restart the game.", or "The editor could not be opened. Try again." when the file
  cannot be written. Its help says what it edits (bios, rules, memories and the prompting for each AI option), that it works with Mistral,
  Local AI and Custom, not Convai, and that changes apply from the next reply. The Settings row stays (same request, same refusals).
- **Characters to invite** (named "Characters" until 2026-10-14): the researched profiles, including Johnny Silverhand and Adam
  Smasher, one row each with **Invite**, **Add copy (n)** once a copy is in the party, or **Profile only** when the character has no
  model to spawn. The help of a row shows the character's summary, voice, conversation state, relationship mode, the shared settings in
  effect (speech, behavior, memory) and, for a character in the party, how many copies. This catalogue is independent of phone
  contacts and quest unlocks. In MCM the list has a **Search characters** section (see "Searching the character lists"); NSUI has no text
  box, so there the list keeps the page slider ("How lists page").
- **Parties** (its first section is **Current party**; saved parties are under it, see "Parties" below): one row per actual or invited copy, "Name #number", with one action per state: **Dismiss** once it has joined, **Cancel invitation** while it is
  still being prepared, **Remove** if its preparation failed. A copy that is dismissed leaves the list at once, even while the game is paused; the world deletion is queued and runs after
  gameplay resumes, and if the game refuses it the row returns with the reason on a line below it. A failed invitation is listed with its
  reason and **Remove** only while the menu is paused: when gameplay resumes the queue posts its one notice and drops it. An empty party shows "Your party is empty". While a companion drives (the chauffeur), the section **Your group**
  holds the trip state and **Stop trip**. The party has no size limit (see "Party size").
- **Model browser:** every Character record in the game, so any model can be invited, including characters without conversation
  support, which join as followers and do not talk. Each row's help names the record and the conversation profile, if any.
  A row is named by the roster profile when the record has one (Rita Wheeler, not the game's generic "Mox"), else by the game's own name for
  the record, else by a readable name made from the record id ("Character.lizzies_bouncer" becomes "Lizzies Bouncer"; a quest code in
  front and the build mark behind are dropped, a mark is kept as (M) or (F)). Those last names are listed after the real ones, and the raw
  record stays in the help and in the search (the game's own name too, so "mox" finds Rita Wheeler).
- **Settings** (since 2026-10-30): a short list of category pages, one **Open** row with a line of help for each, in the order of the page table above. A category page is built when it is opened, never per frame. Rows by page, in order:
  - AI provider (view `settings-provider`): Conversation provider, Local AI model, Allow Local AI to use RAM, Mature content, the Google Gemini key, Convai paid tier (opens its page), Custom endpoint (a button that
    opens the Custom page, below), Edit characters. These are the provider rows as they were, only moved.
  - Voice AI and microphone (`settings-voice`): Companion voices (the first entry is Off, the old Voice playback switch: it keeps the voice that was chosen), Voice language, Companion voice volume (%) (was Voice volume (%)),
    V's voice (one list, see below), V's voice engine, V's voice volume (%) (the two volume sliders go 50 to 300, default 150: the first for every voice but V's, the second for V's spoken lines), Natural speech (off by default),
    Microphone, Voice activation, Speak dialogue choices (moved here from Gameplay), Lip sync delay (Bluetooth), then the pages Custom voices and OmniVoice for AMD (shown as before). Subtitles moved to Interface.
  - Conversations (`settings-conversations`): Talk to story characters, Johnny in your head (one list: Off, On, Speaks up
    rarely, Speaks up normally, Speaks up often, default Off), Companions speak up (one list: Off, Speaks up rarely, Speaks up normally, Speaks up often, default Speaks up
    often since 0.3.4, rarely before, `docs/COMPANION_SPEAK_UP.md`), Companion vision (was Companions can see, `docs/COMPANION_VISION.md`), Dynamic info, Romantic relationships, Memory. (The Multilingual conversations row was removed on 2026-10-21: the language is detected per message.)
    Talk to ordinary NPCs has no row any more: it is always on, and a saved off reads as on.
  - Dynamic info (a page of its own, opened by the Dynamic info row of Conversations, view `dynamic-info`, back to Conversations): twelve switches, one per kind of live game info a turn's
    context can carry (Location, Time and weather, Company and vehicle, Health, heat and fights, V's money, V's gear and clothes, V's gender and lifepath, Quest and journal, Recent game
    dialogue, and since 2026-10-25 Time since last talk (`lastTalk`), Music and TV (`media`) and Other mods' state (`mods`)), all on by default except Other mods' state (`mods`). Row ids `dynamic:<kind>`, saved as `dynamicInfo.<kind>`, the rows apply through `M.apply` as one `dynamicInfo` table (`manager.applySettings`).
    Since 2026-10-31 the page has two headed groups of these twelve rows, **In person** (`dynamic:<kind>`, `dynamicInfo`) and **Phone calls and texts** (`dynamicPhone:<kind>`, `dynamicInfoPhone`, applied as a `dynamicInfoPhone` table); Restore defaults resets both (the phone group to its own defaults: only Time and weather, V's gender and lifepath, Quest and journal and Time since last talk are on, docs/DYNAMIC_INFO.md).
    What each switch removes, on the game side and in every provider's prompt, is in `docs/DYNAMIC_INFO.md`.
  - Romantic relationships (a page of its own, opened by the Romantic relationships row of Conversations, back to Conversations): one selector per character that has the setting (Auto, Romantic, Ordinary, Auto, Casual, Ordinary for Meredith
    Stout). The saved values stay `auto`, `on` and `off`. There is no "Who can talk" row: every character may talk by default, and
    one the player muted earlier stays muted, since nothing resets the saved value.
  - Companions (`settings-companions`): Immersive invitations (Open, since 2026-10-25) and Housemates (Open, since 2026-10-26), each a page of its own that goes back to Companions, Companions change outfits (off by default), Eddies with characters (off), Character bonds, and (only with the development switch, not in 0.4.0, `docs/STORY_PACKS_INACTIVE.md`) Story packs and Characters text first (each off, `docs/RELATIONSHIPS_AND_QUESTS.md`, the last two needing the one before), and
    Companions react (on by default, one switch, see below). Eye contact height and Head tracking strength have no row any more: they always use their defaults (0 and 1), whatever the file saved. Current party also lists a meeting that is still on its way (no body yet) with a Cancel button.
  - Night City (`settings-night-city`): Street reputation and NPCs react to threats and commands (both on by default since 2026-10-30, a saved choice is kept), and Revenge ambushes (off by default, `docs/AMBUSHES.md`).
  - Interface (`settings-interface`): Interface language and Subtitles (Off, Cinematic subtitles, Above the speaker: the old switch and Subtitle display in one list, moved here from Voices). The help of Interface language says the setting changes this mod's menus and notices only, that character voices and the language the
    player talks in are separate, and that the microphone uses this language as a hint for non-English speech (the bridge reads it, `bridge/speech-language.mjs`).
  - Content packs (`settings-content-packs`): one section per installed add-on that has settings
    (see [ADDON_API.md](ADDON_API.md), the add-on wrote its own labels), then one On/Off row per content pack. The page and its row on Settings exist only while an add-on has settings or the bridge lists a content pack.
  - Privacy and help (`settings-privacy`): Help and support (opens the Help page), Send error reports automatically, Developer mode.
  - **Companions react** (row id `companionReactions`, 2026-10-30) replaces React to battles and React to collected loot (both had been on by default since 2026-10-26): one switch, on by default, that writes both stored keys `battleReactions` and `lootReactions`. A file that has not been through the merge yet is merged once on load (marker `reactionsMergedGiven`): on if either was on, off only if both were off.
  - **V's voice** (row id `vVoice`, 2026-10-30) replaces V's voice for typed lines and V's voice for microphone lines: one list, Off, Typed lines (the default), Typed and spoken lines. It writes `vVoice` (typed) and `vVoiceMic` (spoken), the two keys the bridge still reads. **V's voice engine** (row id `vVoiceEngine`, stored `vVoiceEngine`, Pocket, Voxtral, OmniVoice) is a row of its own right under it: one engine for typed and spoken lines, and choosing an engine no longer turns V's voice on or off. A one-time migration (marker `vVoiceMergedGiven`) turns typed lines on for a file that had microphone lines on, so it reads Typed and spoken lines. `docs/V_VOICE.md`.

  Defaults and saved keys are in the README table. The Companion voices list, in order: **Pocket · Performance (the default),
  OmniVoice · Balanced, OmniVoice · Quality, OmniVoice · High Quality, OmniVoice · Ultra Quality, Voxtral · Mistral cloud and Convai
  · Cloud voice**, then **Inworld · Cloud voice** as the last entry once an Inworld key is saved (docs/INWORLD.md: the key, its connection test
  and a status line are the last section of Settings > Voice AI and microphone > Custom voices). Without the optional OmniVoice pack the
  entries stay listed, the row's name gains " (no Omni pack)", and choosing one is refused (the row goes back to the saved voice).
  The Voice status row was removed on 2026-10-20: the voice state shows through the fallback notices (when the chosen voice cannot run, one gameplay
  notice names the voice, e.g. "OmniVoice · Balanced is unavailable right now. Replies show as text until it is back.") and the Help page.
  A local voice that cannot run is never replaced by a cloud voice (2026-10-21).
- **Memory:** the memory controls (player memory, service state, how many characters the player has talked to, the selected character,
  Forget selected character, Forget all memories with an inline confirmation) and, in the second section, **Whose memories**, a paged
  list that selects the character (one at a time; the chosen row's button says Unselect, and pressing it again unchooses it; the choice is cleared when a character clear is confirmed). Selecting does not invite anyone or change conversation settings.
- **Convai paid tier** (`docs/CONVAI_PAID_TIER.md`): the player's plan, sign-in and key rows, one row per plan, Check my plan and
  Manage or cancel plan. The status of a purchase being followed is the feedback line for up to seven minutes.
- **Help and support:** see "Help and support report".

Invitations and dismissals are queued while the page pauses gameplay. Their pending state shows at once and they run once after the
player returns to gameplay; paused spawn timers do not advance. Closing the manager returns to gameplay (see "How the shortcut works").

### Settings notes

- **Settings reorganised into category pages (2026-10-30, branch `feat/settings-reorg`).** Settings used to be one long page of sections (Interface, Conversations, Conversation provider, Companion behavior, Gameplay, Voices, Development, Help, then add-on sections). It is now a short list of eight category pages, each one an Open row with a line of help (`settingsPages` in `mod/manager-ui.lua`): AI provider, Voice AI and microphone, Conversations, Companions, Night City, Interface, Content packs, Privacy and help. A page is built when it is opened, never per frame. Every category page has Back to settings, and a page that opens from a row goes back to its category page (see the Back paragraph above). Both hosts draw the same pages from the shared model, and the only host change is that they ask `core.hasDefaults()` before offering Restore defaults. Where each row went (stored keys are unchanged wherever a row only moved):
  - Conversation provider section to **AI provider**, unchanged. Voices section to **Voice AI and microphone**, except Subtitles, which is now on **Interface** next to Interface language. Voice volume (%) is now **Companion voice volume (%)** (key `voiceVolume`).
  - Gameplay section: Speak dialogue choices (`voiceChoices`) to **Voice AI and microphone**, Street reputation, NPCs react to threats and commands and Revenge ambushes to **Night City**, Companions change outfits, Immersive invitations and Housemates to **Companions**. Eddies with characters is on **Companions** as well, and so are the bond rows of the quests branch (Character bonds, Story packs, Characters text first, stored keys unchanged). The Relationships row of the home opens the bonds page (view `bonds`, back to Home): the characters V has talked to, each with the bond level. Companion behavior section: its rows are gone (below).
  - Conversations section: Talk to story characters, Johnny in your head, Companions speak up, Dynamic info, Romantic relationships and Memory stay on **Conversations**. Companions can see is renamed **Companion vision** (key `companionVision`, the player-facing sentences say vision, not picture).
  - Development and Help sections to **Privacy and help**, with Send error reports automatically (was in Privacy). The add-on sections to **Content packs**.
  - Merged: **Companions react** (replaces React to battles and React to collected loot, one switch, on by default, writes `battleReactions` and `lootReactions`, one-time marker `reactionsMergedGiven`: on if either was on, off only if both were off), and **V's voice** (replaces V's voice for typed lines and V's voice for microphone lines: Off, Typed lines (the default), Typed and spoken lines, writes `vVoice` and `vVoiceMic`, one-time marker `vVoiceMergedGiven`: microphone lines on gives Typed and spoken lines, with typed lines turned on). **V's voice engine** (`vVoiceEngine`) is a new row of its own under V's voice: the old rows carried the engine in their lists and the engine has to stay choosable. The bridge still reads `vVoice`, `vVoiceMic` and `vVoiceEngine`, so it did not change.
  - No row, fixed: **Talk to ordinary NPCs** is always on (a saved off becomes on at every load, `applySettings` ignores the key), **Eye contact height** and **Head tracking strength** always use their defaults (0 and 1, whatever the file saved, ignored by `applySettings`).
  - New defaults: **Street reputation** and **NPCs react to threats and commands** are on for a new player (no settings file, or no saved value). A saved value, on or off, is kept.
  - The migrations are in `loadSettings` (`mod/manager.lua`), `bridge/settings-pages.test.mjs` pins the pages, the Back targets, Restore defaults and the migrations.

- **Provider selector and migration.** Five entries: Convai free tier (default), Convai API key, Mistral (free plan), Local AI, Custom
  (OpenAI-compatible). "Convai API key" stores `conversationProvider = 'convai'` with `useOwnConvaiKey = true`; the other entries store
  `convai`, `mistral`, `local` or `custom`. A one-time migration on load (marker `convaiProviderChoice` in `settings.json`) maps the old
  switch: on with a key saved becomes "Convai API key", anything else "Convai free tier".
- **One key button per key.** The Convai key and the Mistral key (Settings > AI provider) each have one row. Its button reads "Paste" while no key is saved and "Remove" once one is. The
  status is in brackets in the row name: "Convai API key (...a1F9)" (the last four characters, the only part of a key ever shown),
  "(Added)", "(Checking...)" or "(Not added)" after a failed paste, when the failure message is the first paragraph of the row's help.
- **What the Mistral key's Remove says.** The help starts with the fixed sentence "Deletes the saved key." and then names what the key powers now:
  "Conversations go back to Convai free tier." (the provider is Mistral), "Voxtral stops speaking; companion replies show as text until a key is saved." (the companion voice
  is Voxtral), "V's voice switches from Voxtral to Pocket." (V's voice is on and its engine is Voxtral). With none of them: "Nothing you use now depends on
  it." The Convai key's Remove help stays "Deletes the saved key. Conversations go back to Convai free tier."
- **Battle and loot reactions are on by default** (owner, 2026-10-26), and since 2026-10-30 they are one row, Companions react (Settings > Companions), which writes both keys. A saved off the player never chose moves to on once (`battleReactionsChosen` / `lootReactionsChosen`).
  Restore defaults turns both on. See `docs/BATTLE_REACTIONS.md` and `docs/LOOT_REACTIONS.md` for what each costs on the Convai free tier.
- **Where the status went.** The Local AI model row's name gets a bracket while the model is not ready ("(Warming up)", "(Not enough
  memory)", "(Unavailable)") and its help starts with the loading sentence. The provider notes (Mistral limit reached, key not accepted
  or model unavailable; the Convai free tier's "x of y left today" or limit reached; your key's plan limit, rejected, no memory room;
  "Waiting for the conversation to end"; fallbacks such as "Convai: Local AI is not ready") are the first paragraph of the Conversation
  provider row's help.
- **Gone (2026-10-20, the behaviour stays and is always on, with no row):** Auto-connect nearby characters, Expressive emotions, Continue from game dialogue, Live holocall picture and Body gestures. **Gone completely:** Johnny's hologram and V talks on their own. A saved key of any of these is ignored and removed from `settings.json` once; an old file with one of the five set to off behaves as on.
- **Gone:** Prepared voices (always kept; a saved `keepPreparedVoices = false` is read as on and written back as on;
  `bridge/prepared-voices.mjs` stays only for `scripts/Clear-PreparedVoices.mjs`), the "Who can talk" page, the OmniVoice pack row,
  and Groq as a provider (a saved `groq` reads as `convai`; `player-groq-key.txt` is never read).
- **Add-ons** can hide **Most remarks per fight** with `remarkCap = false` in `handle:settings` (Delamain does; the default guard of
  30 stays). Add-on rows are sections of the Content packs page (before 2026-10-30, of the one Settings page), and the add-on API (`docs/ADDON_API.md`) did not change.

## How a change is applied

**In Native Settings UI** there is no Apply button, no draft and no Revert: NSUI has none, and a change is applied for real. (MCM has
drafts and Apply: see "The MCM host".) `mod/nsui.lua` records what the
widgets report (a callback only records; the work is done by the next frame's update) and applies it after a short wait:

| Widget | Wait after the last change |
| --- | --- |
| switch | 0.3 s |
| selector | 0.4 s |
| slider | 0.6 s |
| page slider, letter group (redraw only) | 0.25 s |

Each new change restarts the wait, but a batch is applied at most 2 s after its first change. Changes equal to the saved value are
dropped. A button pressed after a change applies the waiting changes first; leaving the tab or closing the screen applies them at once.

The batch goes through `manager-ui.lua` `M.apply` and then `manager.applySettings` as **one validated, atomic transaction**: unknown
keys and invalid values are rejected, `settings.json` is saved once (a temporary file and its swap), and a failed save changes nothing
("The settings could not be saved. Nothing was changed."). If a batch of several changes is refused, each change is tried by itself,
so the changes that can be made are made and the first refusal is the one told. Add-on settings are staged and committed only after
the main settings saved.

After every apply the page is drawn again. **What the rules did is shown on the rows in place**, with one line under Back:

- A change a rule **refuses** goes back to the saved value on its row, and the line says why ("Requires a Mistral key (add it in
  Settings > AI provider)", "Requires the optional OmniVoice pack (GPU)", "Needs Local AI or Custom."). The other changes of the same moment are kept.
- A rule that **moves other rows** corrects them in place, and the line names what moved:
  - **Mature content** works with Local AI and Custom only (owner decision 2026-10-20, after a live test) and never stands beside Convai (free tier or
    API key) or Mistral. Turning it on beside Convai or Mistral selects, in the same transaction, **Local AI** when its pack is installed (with the largest
    uncensored model that fits, when one is installed), else **Custom** when its endpoint is set up, never Mistral. With neither the switch goes back to off
    ("Needs Local AI or Custom."); if the same batch picks Convai or Mistral, the player's provider stays and the switch goes back to off. Beside Local AI it
    selects the uncensored model the same way; beside Custom it turns on and changes nothing else. **No Voxtral voice beside it**: a Voxtral companion voice
    and V's Voxtral engine move to Pocket in the same save, with any provider; the voice entries are greyed out while it is on (MCM `setChoiceStates` with the
    reason "Voxtral is not used with Mature content."; Native Settings UI shows the label "Voxtral · not with Mature" and refuses the click with the same
    sentence), and `M.apply` and `manager.applySettings` refuse choosing Voxtral while it stays on. What it changed is kept in `settings.json` (`matureRestore`:
    `{conversationProvider, localModel, voice, vVoiceEngine}`, each as `{before, set}`; an older record keeps loading), so turning it off puts back what it
    changed, except anything the player changed since (Voxtral only while the Mistral key is saved and the voice is still Pocket); choosing Convai or Mistral
    turns it off the same way; choosing Custom leaves it on. A saved file with Mature content and a Voxtral voice loads as Pocket. The line reads "Also changed: ..."
    and names the provider ("Local AI" or "Custom (OpenAI-compatible)"), the uncensored model and the voices ("Pocket · Performance", "V’s voice engine").
  - **Cloud voice and Natural speech** (`manager.applySettings`, `honourCloudVoice`; rule changed 2026-10-20): Natural speech and the
    Convai · Cloud voice exclude each other only where that voice is what speaks: the voice is Convai **and** the provider is Convai (free tier
    or own key). With Mistral, Local AI or Custom and the Convai voice selection the bridge plays Pocket, so Natural speech works there and
    stays. An Apply that makes the pairing (it chooses the voice, or chooses a Convai provider while the voice is Convai) keeps the choice and
    turns Natural speech off with "The Convai cloud voice cannot use Natural speech, so it was turned off." Turning Natural speech on beside an
    existing pairing moves the voice to Pocket · Performance with the "needs a local voice" notice. An older save with the pairing loads with
    Natural speech off. No voice is moved or refused for the language of a reply: Pocket keeps speaking English and shows another language as text with the
    one-time voice-language notice.
  - V's voice engine (since 2026-10-30 the engine is a row of its own, **V's voice engine**, right under **V's voice**, which is the Off / Typed lines / Typed and spoken lines list, the engine list has Pocket, Voxtral and OmniVoice only, so the entry numbers below are one lower than the four-entry list of 2026-10-20, OmniVoice is `disabledElements[3]`, and choosing an engine no longer turns V's voice on or off). The 2026-10-20 list was Off, Pocket, Voxtral, OmniVoice, and one row wrote both stored keys (`vVoice`, `vVoiceEngine`: `pocket`, `voxtral`, `omni`), Off kept the saved engine. Voxtral is greyed out
    until a Mistral key is saved (a chosen Voxtral without a key is refused with "Requires a Mistral key"), and a saved Voxtral without a key shows and
    speaks as Pocket until a key is saved. With Mature content on the Voxtral entry is greyed out and a saved Voxtral reads as Pocket (see Mature content above).
    The fourth entry, OmniVoice (added 2026-10-21; it renders V's line on the GPU voice the companions use, no extra model), is usable only when the OmniVoice pack is installed
    (`manager.omniPack().installed`) and the saved Companion voice is OmniVoice (`voiceProvider == 'omni'`); `manager.vOmniBlock(settings)` says which fails (the pack first). Its label is
    "OmniVoice · short wait" when usable, "OmniVoice · needs Omni voice" while the companions are not on OmniVoice, "OmniVoice · needs Omni pack" while the pack is missing.
    Unusable, the entry is greyed out in MCM (`disabledElements[4]` holds its own reason: "Requires the Companion voices to be an OmniVoice choice", or "Requires the optional
    OmniVoice pack (GPU)" for the pack, which wins); Native Settings UI has no greyed-out entries, so the label carries the reason and `M.apply` refuses the choice with the same sentence.
    A batch is judged by its final values: companions and V both set to OmniVoice in one batch is fine; a batch that moves the companions off OmniVoice and keeps V on it is refused.
    A saved `omni` that cannot be used now (companions not on OmniVoice, pack missing) loads untouched, shows Pocket in the row (position 2) and is read as Pocket by the engine
    (`manager.vVoiceEngine()`; the bridge reads `runtime/settings.json` itself and applies the same two conditions). Removing the pack needs nothing: it reads as Pocket while the
    pack is gone and is OmniVoice again when it returns. A batch that moves the companion voice off OmniVoice while V's engine is `omni` sets `vVoiceEngine` to `pocket` in the same
    save (`manager.applySettings`; no restore record) and the feedback line says "V’s voice switches from OmniVoice to Pocket." (only when V is on and was showing OmniVoice).
    The help text says plainly that V's line is always waited for and is given up only if it is stuck with no audio after about 30 s (2026-10-22; before that Pocket and Voxtral lines not ready in time were skipped while an OmniVoice line was waited for). An OmniVoice line adds about a second more than Pocket before V starts, then V's own speaking time, because V speaks first and the companion answers after. The row shows the saved engine, Voxtral without a Mistral key included (its entry reads "Voxtral · needs Mistral key").
  - Johnny is one list (2026-10-20, Normally added 2026-10-25): Off, On (he answers the talk keys, no unprompted remarks), Speaks up rarely (a target of about 2 an hour), Speaks up
    normally (about 4), Speaks up often (about 6). These are target rates of calm play, random around the rate, not caps; with the companions' list on too the two rates add up and
    they take turns, never closer than 2.5 minutes (except Johnny's follow-on to a companion's line, which is one exchange). The row writes both stored keys (`johnnyInHead`,
    `johnnyRemarks`): Off means no remarks, and an old file with `johnnyInHead` off reads as Off whatever `johnnyRemarks` held; on-saves map `true` + `off` to On, `rare` to Speaks up
    rarely, `medium` (new) to Speaks up normally, `normal` to Speaks up often. The read-only "Johnny's standing" line was removed.
  - Companions speak up (2026-10-25, one list right after Johnny's): Off, Speaks up rarely, Speaks up normally, Speaks up often (default since 0.3.4, before it Speaks up rarely); stored `companionSpeakUp` = `off` / `rare` /
    `medium` / `normal`; the help says "Rarely: about 2 an hour. Normally: about 4. Often: about 6." and that with Johnny speaking up too the rates add up and they take turns. The help also says that with two or more companions near a speak-up is often a short chat
    among up to three of them that stops when you talk. One scheduler
    (`mod/speak-up.lua`) paces both lists; see `docs/COMPANION_SPEAK_UP.md`.
- **Restore defaults** is NSUI's own button, registered for this tab (in MCM it is a footer button of the host, pressed twice). On Settings,
  every category page, the Romantic relationships page, the Dynamic info page, the Key bindings page, the Immersive invitations page and the Housemates page (the pages `M.hasDefaults` says yes to, which both hosts ask before they offer the button) it applies every saved row of all of those pages that is not at
  its default through the same path (the Local AI model goes to the model shown as the default, the largest that fits; the own key bindings are cleared in the same
  save as one change, `keyBindings:clear`), then says "Defaults restored."; a default a rule would refuse is not forced. On any other page it changes nothing and says
  "Open Settings to restore its defaults."

On the bridge side a changed value takes effect at a safe boundary, not mid-reply (README, "How a change applies").

## How lists page

A long list (characters, models, the party, the memory picker) is one **page of at most 12 rows** (`PAGE_SIZE`), so a page never puts
more than a screenful of widgets on the screen. Above the rows: a **Page** slider (only with more than one page), then a line "Page n / m"
with the names the page starts and ends with. Moving the slider changes the page after 0.25 s; **only the rows below the controls are
replaced**, the slider stays the same widget (the player is holding it), and the Back row and the other sections are untouched. Opening
another page starts its list on page 1. The Model browser first shows only "Reading installed models..." while the scan runs (a bounded
batch of 48 records a frame while the page is shown). Then it shows "N matching models" (and how many can talk), a **Starts with**
selector (All first, then the letters in use: a plain letter upper-cased, digits and symbols together as #, a letter of another script as
itself; left out when there are more than 40 groups) and the paged rows. The groups are built once per finished scan.

**Searching the Model browser (MCM only).** In MCM the box "Search settings" is the search: on the browser page the host sets the
navigation's `searchMode` to `provider` (MCM then does not filter the rows by the box, which would only ever see the twelve of the page),
and reads the box's text from `api.ui.getContext().search` on its 0.25 s tick (MCM settles the text for 12 frames after a key, so the
host sees whole words). `M.setSearch(text)` in `manager-ui.lua` keeps the lower-cased words (any run of spaces, at most 100 characters)
and the page is drawn again only when the words changed. A model answers when every word is somewhere in its name, its record or its
conversation profile (`model.search`, made by the scan), so "rita", "wheeler rita" and "RITA  wheel" all find Rita Wheeler. The matches
are taken from the list the scan already sorted, once per text (`searchedModels` holds the result), so nothing is read from the game
again and no keystroke rebuilds the list; the result pages like any list, every row keeps its Invite button, and while a text is
searched the letter group is out of the way. The text is part of `M.pageId()` (a new text scrolls to the top). MCM keeps the text of its
box from page to page and filters the other pages by it, so the host empties the box (`api.ui.setSearch`) on the way into and out of
the browser. If an MCM refuses the option the page is given without it, MCM keeps its own filter there, and the page does not mention a
search (one log line). The hint line on the page ("Type in the search box ...") is shown only when the host offers a search
(`M.offerSearch`, set by `mcm-host.lua` while it is registered). **Native Settings UI has no text field**, so its Model browser keeps
the letter group and the page slider.

**Searching the character lists (2026-10-31, branches `feat/manager-search` and `feat/manager-search-box`).** Main characters to invite and Side characters to invite are searched
two ways. MCM's own Search box works as for the Model browser (provider search mode, see above), but MCM draws it dim until it is clicked and its
public API has no text row and no way to focus it, and Native Settings UI has no text box at all. So the lists carry a section of their own above
everything else (category id `character-search`, heading "Search characters", built by `M.searchCategory`, in both hosts):
- **Search by name** (id `search:box`, button "Search"), always: it opens the mod's own native text box, the talk box's kind, titled "Search characters"
  (`Composer.reds` `ConvaiOpenSearchBox`, dressed by `composer-input.lua`: the same chat-bar look, the title and the hint "Type part of a name" in the interface
  language). Enter applies the typed words as the list filter, Esc leaves the list as it was, Enter on an empty box shows the whole list again. The box
  shares the talk box's token (so the talk key, the manager shortcut and every "a box is open" check treat it as open) but has fields of its own
  (`m_convaiComposerMode` "search", `m_convaiSearchState` "open", "confirm" or "cancel", `m_convaiSearchText`): its words never reach
  `m_convaiSubmittedText` or `m_convaiSubmissionReady`, so the talk path in `init.lua` never sees them, and no conversation state is touched. While a box
  opened by the button is open, the slow tick reads its state (`M.pollSearchBox`, one nil check otherwise) and applies a confirmed text (`M.applySearchText`,
  which also writes the text into MCM's box so the two ways agree and MCM's old text cannot bring an older search back). The menu stays open behind the box. A box
  that never came up (`composer-input.lua` marks `searchShownAt` when its dialog initialises) is forgotten after three seconds (`ConvaiForgetSearchBox`) and
  the status line says "The search box could not open." (with MCM, plus a pointer to its box). Whether the game's notification layer draws the box over the
  paused pause menu (Native Settings UI) or over MCM's screen was not tried; if it does not, the watchdog makes the button fail cleanly.
- MCM only, no search: a second row, "Use the Search box, top right" with **How to search** (id `search:help`). Pressing it puts "Click the Search box at the top
  right of this panel and type a name." on the status line under Back; the row's help says the same at length (the box is dim until it is clicked,
  every match on every page and letter is shown, case and accents do not matter, every typed word must start a word of the name).
- A search is on (typed in either box): the second row reads "search: pan · 2 found" with **Clear search** (id `search:clear`, `M.clearSearch`), and the title of the list says the
  same ("Main characters to invite · search: pan · 2 found · Page 1 / 1", from the `character-status` row; the query is cut after 18 width units).
  Clear search empties the host's box through the function the host gave `M.offerSearch(offered, clearBox)` (`mcm-host.lua`: `api.ui.setSearch(key, '')`)
  and the search itself; for one second the host ignores the old text still in MCM's context (`clearBoxUntil`), so the old words cannot bring the
  search back before MCM takes the empty text.
- The rule is the one of the phone's Chat search (`M.foldText`, `M.nameWords`, `profileMatches` in `manager-ui.lua`): case and accents ignored (accented
  Latin letters are their plain letters, `ß` is `ss`), a word is a run of anything but spaces and punctuation, and every typed word has to be the start
  of a word of the name or of the key. The words of a character are made once (a weak table), the typed words once per text, and the list is
  filtered once per text (`searchedModels`), never per frame or per page build. A search puts the list on page 1 and the letter group out of the way.

**Favorites (2026-10-28, branches `feat/favorites` and `feat/favorites-2`).** Characters to invite and the Model browser have **per-row
buttons only**. The first version had a page-wide Add to favorites button beside Back that acted on the row the player was last on; the
settings screens do not reliably tell which row is selected (Native Settings UI's hover event, MCM's private hovered row), so it was
removed with everything only it needed (the focus hook in `nsui.lua`, `M.offerFocus` / `M.focus`, the Search-box fallback, the footer button
of `mcm-host.lua`). The rows now (`manager-ui.lua` `entryRows`, `favoriteRows`, `setFavorite`):
- A character (model) that is **not in the party**: one row, **Invite** (id `invite:<key>`).
- **In the party and not a favorite**: the row's button is **Add to favorites** (id `favorite:add:<key>`), and a second row of the same name
  right under it is **Add copy (n)** (id `invite:<key>`, the old button).
- **A favorite**: no Add to favorites row. Her place in the list keeps its one Invite / Add copy row, and she is also in the **Favorites block**,
  a section of its own right under Back (category id `favorites`, heading "Favorites"): her Invite / Add copy row (id `invite:favorite:<key>`) and under
  it a row that names her, **Remove Panam Palmer from favorites** (id `favorite:remove:<key>`, button "Remove"; a name that makes the label too wide
  gets "Remove Panam Palmer", then a cut, so the row never reads as a character called "Remove from favorites"). The block is on **page 1 only** (a favorite on any page is in
  it; the Search text and the Model browser's letter group narrow it like the list), at most 30 favorites with a "{count} more favorites" line
  after them.
- The Model browser uses the same rows. A model counts as invited when it is in the party (its button then also reads Add copy (n), which it did
  not before). The two pages keep separate favorites.
- **Side characters to invite (2026-10-31)** has the same rows and the same Favorites block (category `favorites`, between the Search section and the list, page 1 only). It uses the **same set of favorites as Main characters to invite** (scope `characters`: a key is in one list only, and the phone's Chat tab stars the same keys, so a side character starred on the phone shows in the block). The Search text and the Starts with group narrow the block like the list. The block is worked out from the favorite keys (`convaiFavorites.keys`) and a key-to-position index held with the letter groups, so a page build reads the favorites (30 shown at most) and the twelve rows of the page, never the 557 side characters (`M.sideFavorites`).
Pressing a favorite row draws the page again, so the rows below an invited entry move down one (Native Settings UI replaces the rows from there;
the widget count never grows by more than the extra row). Favorites live in `runtime/favorites.json` (`{version, characters = {key = true},
models = {key = true}}`, at most 500 a page), a player-state file like `settings.json`: `bridge/game-state.mjs` copies it to
`%LOCALAPPDATA%\AiNpcCyberpunkMod\data\game-state\` and puts it back if it is missing, and `packaging/runtime-exchange.json` class `state` means
no package ships or replaces it, so an update never touches it (existing favorites carry over: the file did not change). The file is read once,
when a page first needs it, and written only when a button is pressed (a write that fails keeps the favorite for the session and the page says
so). Nothing sorts the lists any more: the list keeps its own order, the block is built from it when the page is built. Without `favorites.lua`
the pages have no favorite rows.

**Page buttons say where they go (2026-10-28).** `pageRows` gives the page slider row `previousHelp` / `nextHelp`, and `mcm-host.lua` uses them as
the description of the **Previous page** / **Next page** footer buttons, so the description panel says "Page 2 of 5: characters 13 to 24." and
"Press to go to page 3 of 5: characters 25 to 36." (or "This is the first page." / "This is the last page."); the noun is characters, models or
entries. The line under the slider (`list-range`, drawn again with every page) carries the same "Page 2 of 5: ..." line for Native Settings UI,
which has no page buttons; the slider's own text stays the same on every page because a row whose text changes is drawn again and the player
may be holding it. Not seen in the game: whether MCM shows a footer button's description in its panel on hover.

*The Chat tab of V's phone* (a character made favorite on Characters to invite): the favorites are listed first there too, with the same `* `
mark, then the others in the list's own order (by name). Read only: `mod/phone-chat.lua` `M.pushFavorites` compares `convaiFavorites.revision()`
(one number) on the phone's existing 10 Hz tick and, only when it changed (or the contacts were registered again), hands the game the favorite
contact ids (`ConvaiPhoneChatClearFavorites(mark)`, `ConvaiPhoneChatAddFavorite(id)`; the contact id maps to its profile key through the
catalog, so the shipped phone contacts such as `judy` follow `judy-alvarez`). The list is built in `PhoneChatTabs.reds`
`ConvaiShowChatContacts` when the tab opens: a favorite's row name is the mark plus the name (`ConvaiPhoneChatListName`). The order is explicit, not a side effect of the mark: each Chat row carries `ContactData.convaiFavorite` and `PhoneChatTabs.reds` wraps
`DialerContactDataView.SortItem` (the comparison of the phone's list) so a favorite goes before a non-favorite; two rows of the same kind fall
through to the game's own comparison (by name), so each group stays in name order. The wrap touches only Chat rows (`convaiChat`) and runs only
while the game sorts the list, which is when the tab opens. Nothing runs while the list is open
and no widget is touched per frame. The name without the mark is kept on the row (`ContactData.convaiPlainName`), so the chat page title and
the chat's name never show the mark. Scripts older than the Lua skip it (asked once, `M.favoritesMissing`).

*MCM's own Add to favorites* (the footer button of MCM 0.10.5 and later for the mod): already handled, nothing to add. With MCM 0.10.6 or newer
`mod/mcm-host.lua` sends `setActionVisibility(modKey, {favorite = 'hide'})` with the presentation (see "MCM 0.10.6" below), so only ours shows
on our pages. MCM 0.10.5 has no public option to hide it, so there it still sits beside ours (it favorites the mod in MCM, ours favorites a row);
that is known and not a bug.

**The tab and NSUI's list.** NSUI keeps a hole in its section list when a section in the middle is removed. The host therefore
removes sections only from the end (last first) and adds the new ones; a change inside a page replaces only the rows that differ.
A row's signature is everything about it except the value it holds (kind, id, label, description, button text, range, elements): a
row with the same signature only gets its value brought up to date through NSUI's own setter (its callback is switched off for the
call, so the host does not take it for the player), a row with another signature is removed and added again in its place.

### Rules the host keeps

- Nothing runs per frame while the Mods screen is closed (tested: no page built, nothing sent to NSUI, no page state read; the
  slow tick of the manager's queue and notices, a quarter second, runs as before). One draw when the tab is left puts Home back. The
  look for a copy of NSUI that loads after this mod is once a second.
- While the tab is shown the page is checked about once a second and drawn again only when what it shows has changed (its
  signature). An unchanged page is never drawn again (tested).
- NSUI callbacks never build, draw or call the game: they record. Native widget work (fonts) runs from update in bounded batches.
  CET's RTTI executor uses a 1 MiB scratch allocator shared by nested calls and does not check for failed allocation, so repeated
  per-row widget walks inside an observer exhausted it and crashed the earlier MCM page (2026-09-30 crash dump); no walk happens
  inside a native callback now.
- A native object has no equality in CET (each callback gets a fresh wrapper), so identities are compared with `CalcSeed`, and a
  missing identity fails closed.

## How the shortcut works

The manager shortcut is the CET hotkey `cyberpunk_convai_manager` ("AI NPC Cyberpunk Mod: companion manager"), bound by the player in
CET's Bindings (the mod never assigns keys; the development install binds F4 when the binding is missing,
`scripts/Set-DevelopmentBindings.ps1`). `mod/nsui-entry.lua` walks the real menus, as the player would, by activating real menu
items; it simulates no key and edits no other mod's files, menu or input handlers.

**With MCM 0.10.5 or newer hosting the page the shortcut does not walk any menu**: `mod/nsui.lua` `M.open` asks the MCM host, which
calls MCM's public `api.ui.open('cyberpunk-convai:manager')`; MCM's own update takes the request, opens its screen and selects the
manager (see "The MCM host"). This is the case whether or not Native Settings UI is installed. Only when MCM is absent, older than
0.10.5 or refuses the request does the walk below run (Native Settings UI), and without a host the shortcut shows its notice.

1. It refuses, and logs why, without Native Settings UI (see below), with no save loaded ("Load a save first."), while the text box is
   open, during a scene ("Finish the scene first."; a plain sit on a couch or chair is scene tier 3 but no scene: the shortcut opens
   there, `convaiPlainSitting` in `init.lua`, while a game line, a call, a fight or scene tier 4 still count) and with another menu open ("Close the current menu first, or choose Mods from the
   pause menu."). In gameplay it asks the game to open the pause menu (menu event `OnOpenPauseMenu`); with the pause menu already open
   it starts from there.
2. The host puts the manager on its first page and tells NSUI which tab to start on (`lastNativeSettingsCategoryIndex`).
3. In the pause menu it finds the item labelled "Mods" whose event is `OnSwitchToSettings` (the item NSUI adds beside Settings; the
   game's own Settings item has the localized word) and activates it with `OnMenuItemActivated`, so NSUI marks the screen as its own
   and builds its tabs. If NSUI still opens on another tab, the tab is selected once after 2 s. (With Mod Configuration Menu installed
   the item is MCM's own: see "Beside MCM".)
4. The walk is done when the tab is shown. It gives up after 8 s with "The shortcut timed out. Choose AI Companions from the
   pause menu under Mods." (logged) and activates nothing else. Pressing the shortcut again during the walk changes nothing.
5. **While the manager is open the shortcut closes it**, the way Esc does (`RequestClose`).
6. **Closing returns to the game, when the shortcut opened the pause menu.** Only a walk that started in gameplay (the shortcut itself opened the
   pause menu) hands the player back: when the Settings screen that the walk opened closes while this tab is on it (a `RequestClose`
   for that screen's engine identity, or, if the game closes the screen by another route, its detach with the tab shown), the adapter
   waits for the screen to detach, then activates the real **Resume** item (`OnClosePauseMenu`) once, so the game's own scenario
   unpauses and releases its input contexts. If the pause menu is still up two seconds later it activates Resume once more, never a
   third time. It waits at most 3 s for the item. A pause menu the player opened, a Mods screen the player opened by hand, the game's
   own Settings screen, another tab, a new Settings screen, a save reload and a reset never resume anything. The decisions are logged
   to `runtime/mcm.log` ("Manager exit: ...").

**At the main menu** `init.lua`'s update has no world, and it still runs `managerUi.update(nil, false)` there (the manager's slow
tick and a few comparisons), so a button of the page is answered with no save loaded: Settings, Help and Memory open. The pages that
need a save (Characters to invite, Current party, Model browser) show a read-only row, "Characters and party: Load a save first",
instead of working invite buttons; the same row is in NSUI. In MCM the heading says it ("Characters to invite · Load a save first · Page 1 / 11"): see "Status lines in the heading".

**Without any host** (no MCM 0.10.5 or newer, and no NSUI, or an NSUI that lacks one of the functions the host calls: `addTab`,
`addSubcategory`, `removeSubcategory`, `removeOption`, `addSwitch`, `addRangeInt`, `addSelectorString`, `addButton`, `setOption`,
`registerRestoreDefaultsCallback`) the shortcut shows the notice "The Companion Manager needs Mod Configuration Menu 0.10.5 or newer,
or Native Settings UI" (notice id `manager-needs-nsui`, player class, at most every 10 s) and starts no walk; when the only Mod
Configuration Menu is older than 0.10.5 the notice is "Update Mod Configuration Menu to 0.10.5 or newer, or install Native Settings UI".
The setup check names them too (see below). NSUI is found with `GetMod('nativeSettings')` (or
`'NativeSettings'`) at CET's `onInit`; a copy that loads after this mod is found by a once-a-second look, and the tab is registered then.

**While V sits (2026-10-20).** MCM's own gameplay entry (`SettingsEntry.canOpen` in its `mcm_settings_entry.lua`) declines every open request, the public `api.ui.open` included, while the scene tier is 3 or above (reason `scene`, logged only by MCM as "open request declined before transition"). A couch or chair is a scene sit at tier 3, so MCM never shows the page there and nothing public overrides it. The 2026-10-19 change let a plain sit through our own gate and MCM declined silently (F4 on a couch did nothing, with no log line at all). `mod/mcm-host.lua` now refuses the plain sit itself with the kind `seated`, never asks MCM, and `openManager` in `mod/init.lua` posts "Stand up to open the Companion Manager" (notice id `manager-seated`, at most every 5 s (a notice shows for five seconds), translated). A real scene keeps "Finish the scene first." (log only). Every press logs two lines: `Companion manager shortcut: press N (handler entered)` and its outcome (`opened`, `refused (kind=...)` or `failed`). The Native Settings UI path (`mod/nsui-entry.lua`) still lets a plain sit through.

### Beside MCM

**Since the MCM host (below), this section only applies to an MCM older than 0.10.5 beside NSUI**: from 0.10.5 the manager is
registered with MCM through its public API and the shortcut opens MCM on it directly, so the walk and its notice are the fallback.

Found by reading MCM 0.10.3 (`ModConfigurationMenu/mcm_ui/mcm_menu_bridge.lua` and `mcm_controller.lua`,
`ModConfigurationMenuAPI/bridges/native_settings/provider.lua`, `00_MCMNativeSettingsLifecycle/init.lua`), **not yet confirmed in game**;
MCM 0.10.4 (not read) changed its internals, and its author keeps only the public API stable, so the walk relies on as little of them
as it can. With MCM's setting "Redirect Framework Menu Entries" on (the default) MCM keeps NSUI's Mods item in the pause menu's list but hides its
widget (`SetVisible(false)`), adds its own item (data labelled "Mods" like NSUI's, event `OnSwitchToMCM`, shown as "MCM" or "Mods" by
MCM's own setting), turns an activation of NSUI's item into MCM's screen too, and imports NSUI's tabs through a snapshot, so the manager
is a row of MCM's list of mods (`AI Companions`, with the prefix `[CET]` when MCM shows provider prefixes). MCM's public API
cannot select a row of that list (`openMod` only sets the API's own active mod; the screen keeps its own selection), and the entry never
calls or hooks MCM's `McmUi*` functions, so the shortcut ends at the list: it reads the pause menu's list, takes NSUI's item unless MCM's item is there and NSUI's widget is hidden (or
the game does not say), in which case it activates MCM's item with `OnMenuItemActivated`, as the player would (an item still labelled
"Mods" and visible, not NSUI's, Resume or Mod Settings'/RCF's, is taken for it if a later MCM renames the event); when MCM's Settings
screen has opened the walk is done and the host posts the notice "Open AI Companions in the Mods list." (id `manager-in-mcm-list`,
15 translations; it is posted from the pause menu, where the game may hide the warning line, so whether the player sees it is a live
check). The 8 s guard, the logged timeout sentence and "pressing the shortcut again" are the same, and closing the MCM screen that the
shortcut opened returns to the game like the Mods screen does (matched by engine identity, Resume once after the detach; the shortcut
closes it while it is open). With MCM's redirect off NSUI's item stays visible and the walk is the plain one, and without MCM nothing
changed. Tests: a fake MCM item in `bridge/nsui-entry.test.mjs` (MCM at its default, redirect off, event renamed, no item, timeout, close
and resume) and the real host in `bridge/nsui-manager.test.mjs`.

## The MCM host

`mod/mcm-host.lua` registers one provider (id `cyberpunk-convai`, registration key `cyberpunk-convai.manager.v1`, API version 2, one
mod `manager`) with MCM and gives MCM the page that `manager-ui.lua` builds. `mod/init.lua` attaches it next to the NSUI host
(`managerUi.attach(dofile('mcm-host.lua'))`); `mod/nsui.lua` hands it the same `manager-ui.lua` instance and calls its `install`,
`update`, `resetSession` and `shutdown`, so the two hosts share one page state and one set of saved settings.

**Detection.** `GetMod('ModConfigurationMenuAPI')` is looked for at CET's `onInit` and then once a second (every 5 s after 30 tries).
The host registers only when the answer has `apiVersion` 2, a `providers.registerProvider`, a `version` of 0.10.5 or newer (compared
as numbers: 0.10.10 is newer than 0.10.5) and the public UI extension `ui` with `apiVersion` 1 and every call the host makes (`setApplyPolicy`,
`setPresentation`, `setNavigation`, `setFooterActions`, `setChoiceStates`, `setStatus`, `getContext`, `open`, `clear`, and `hasDrafts`,
`reloadMod`, `revert`, `refreshProvider`). Otherwise it logs one line to `runtime/mcm.log` and the console ("... Mod Configuration Menu cannot
host the page (MCM 0.10.3 is older than 0.10.5 ...)") and stays out. No MCM function is overridden or observed, no MCM widget or
internal table is read; `bridge/mcm-host.test.mjs` checks that the file contains no `Observe`, `Override`, `McmUi` or `require`. The calls
MCM 0.10.6 added (`close`, `setActionVisibility`, three presentation options) are not required: each is used only when this MCM has it
(see "MCM 0.10.6" below).

**The page.** Every category of the page is a category of MCM, each row a setting: `bool`, `select`, `int` rows are drafts
(capabilities read, write, draft; NO default: MCM draws a row purple only when it has a default and differs from it, and the same rows
look alike without it; MCM's own Defaults button and Modified counter go with the defaults, so the host has its own **Restore defaults**
footer button on Settings, its category pages, Romantic relationships, Dynamic info, Key bindings, Immersive invitations and Housemates (it asks `core.hasDefaults()` first), pressed twice because MCM's public API has no confirmation, applying `manager-ui.lua`
`M.defaults()` through `M.apply`), actions are MCM actions (with `disabled` rows not runnable), read-only rows are `string` settings
without write; the Settings page has no read-only line (Voice status and Johnny's standing were removed 2026-10-20, and with them the
status-button workaround that drew such lines at the size of the other rows), so the other pages' lines are plain MCM text rows. Two alignments remain that no public option
changes in MCM 0.10.5: a setting's label is in MCM's marker column (x 48, `MCMLayout.reds` `contentLabelX`) and an action's is flush left (x 20); MCM 0.10.6 moves the first with `labelIndent` (see "MCM 0.10.6" below).
Romantic relationships is a page of its own (view `relationships`, back to Conversations), opened by a Romantic relationships button in Conversations; Dynamic info is built the same way (view `dynamic-info`).
The Memory page's Forget all row reads "Forget all memories (N characters)" with the one-word button "Forget": the count is in the row's name, within `BUTTON_LABEL_UNITS` (29, the figure `mod/nsui.lua` cuts a button row's name to); a translation or a count that does not fit it is only the number ("Forget all memories (12)"), then the name alone. The line under the way back (the result of the last action) is MCM's
status line (`api.ui.setStatus`, kind info), sent only when it changes. The way back is the page's back action: `setNavigation` gives
it as `backActionId` (Escape goes back) and `setFooterActions` puts it in MCM's footer; the `pageId` is `view|page|group`, so MCM scrolls to
the top of a new page (on the Model browser, with the search text added). The OmniVoice entries of Companion voices are disabled choices (`setChoiceStates`, reason "Requires the optional
OmniVoice pack (GPU)") while its pack is missing. A long list is turned with buttons, because MCM has no setting that changes the page
without a draft: **Previous page**, **Next page** (disabled at the ends) and, in the model browser, **Starts with: B** (the next letter
group, the last one goes round to All).

**Status lines in the heading (2026-10-20).** MCM draws a read-only line (`McmUiAddReadonly`) as a surface at x 20 whose text is inset by 16
(`MCMLayout.ListRowTextLeftInset`; 4 with text-only list selection), while the label of an action row starts at x 20, and `labelIndent` reaches only
setting labels. A status line above a list of buttons therefore sat 16 px right of the names under it and looked like a stray heading. In MCM
`mod/mcm-host.lua` (`STATUS_ROWS`) takes those rows out of the list and the heading of the category says them, like the page number:
`Characters to invite · Load a save first · Page 1 / 11`, `Installed character models · 6000 matching models · Page 1 / 500`, and the state of
a companion driver (`Your group · Companion driver · Driving`). Their help text becomes the description of the mod (the schema's), which MCM's
description panel shows while no row is hovered (MCM's heading has no hover text). With no row under the status (no save and an empty party, models
still being read) MCM draws no heading for a category without rows, so the line stays a line. NSUI keeps every row, and the model in
`manager-ui.lua` is unchanged. Other read-only rows (Memory, Help, Convai plan) are label and value lines and keep MCM's inset.

**Draft and Apply.** The apply policy is `explicit` (MCM's own Auto Apply is not used): a change is a draft until the player presses
Apply (or Revert drops it). MCM hands the drafts to `applyBatch` as `{id, value}`, and the host runs
`manager-ui.lua` `M.apply`: ONE validated, saved transaction with the same rules as the NSUI host (Mature content beside Convai or Mistral turns on Local AI with its
uncensored model, else Custom, and moves a Voxtral voice to Pocket; a value the rules refuse is refused with the reason). `appliedIds` are the ids MCM
asked for, not the extra ones the rules saved. MCM loads the page again and the rows show what was saved. If the rules did not keep a
requested value (Mature content beside Convai or Mistral with no Local AI pack and no ready Custom endpoint), MCM would keep that draft as unapplied: the host reverts it from the next tick and
the status line gives the reason. MCM refuses a button while changes are pending ("Apply or revert pending changes ..."); that is MCM's
own rule.

**Staying equal to what is true.** While MCM shows the page, the host runs `manager-ui.lua`'s `tick` and, when `stale()` says something
the page shows changed (a new party member, a model scan that finished, the voice service state, a language change), loads the page
again with `api.reloadMod`, unless changes are pending (MCM refuses; the redraw waits for Apply or Revert), and backs off for 5 s after
a reload MCM refused. A language change gives MCM the new locale (`setPresentation`) and the new mod name (`refreshProvider`). The next visit
starts on Home (`closeMod` puts the page back).

**Cost.** Closed: one clock comparison per frame. Every 0.25 s: one read of `api.ui.getContext()`; while the manager is shown also the
page logic's own once-a-second look. The model browser's scan runs a bounded batch a frame only while the browser is shown.

**The shortcut.** `M.open` refuses like the NSUI walk ("Load a save first.", "Close the text box first.", "Finish the scene first.")
and otherwise calls `api.ui.open`. Pressing the shortcut again while the screen is open does nothing (Esc, MCM's own close and, with MCM
0.10.6, the Back button of Home work as usual).

**Both installed.** The rule: with MCM 0.10.5 or newer and Native Settings UI both installed, the page is MCM's alone and this mod has no
Native Settings UI tab. MCM imports Native Settings UI's tabs into its own list through its bridge (a second entry whose option handles go
stale when a tab changes; the player saw "Native Settings UI rebuilt this setting. Reopen the mod before applying it again."), so
`mod/nsui.lua` never registers the tab while the MCM host has registered the page, and the shortcut does not register it as a way around
a refusal of MCM (it says why). An MCM that is present at CET's `onInit` but cannot say yet whether it hosts the page (its public interface
is not there yet, and it is not older than 0.10.5) holds the tab back for 10 seconds, looked at once a second. An MCM that appears after the
tab was registered (it loaded late) takes the tab down at the next once-a-second look, as soon as the tab is not on screen: Native Settings UI
has no call to remove a tab, so the sections go through its `removeSubcategory` and the empty tab is dropped from its `data` registry. One
log line says it. Native Settings UI alone, or beside an MCM older than 0.10.5 (which cannot host the page), keeps the tab. Beside such an
old MCM the mirror still exists, so the tab keeps its option tables in place: a value change, and a change of text or section name while the
tab is not on screen, update the same tables (MCM finds an option again by index, type and path), and only a change of kind or id replaces a row.

**MCM 0.10.6 (2026-10-20, from a private preview that Antrix, MCM's author, sent; not public yet, and not seen in the game).** 0.10.5 stays the
minimum and behaves exactly as before. The version number of `api.ui` stays 1, so the additions are found by the call, not by
`api.ui.apiVersion` (`mcm-host.lua` `M.newUi(found)`): `close` is on when `api.ui.close` is a function, `actionVisibility` when
`api.ui.setActionVisibility` is, and `presentation` (the new options of `setPresentation`) when both are and `found.version` is 0.10.6 or
newer (or cannot be read). `setPresentation` checks every option and refuses the whole call for one it does not know, which is why the new
options are never sent to 0.10.5; if a 0.10.6 MCM refuses them anyway the base options are sent instead, with one log line, and the new
options are not tried again. What changes with 0.10.6:
- `setPresentation` also gets `labelIndent = 20` (a setting's label at the buttons' x, was 48), `highlightModifiedValues = false` (MCM's
  purple for a changed value off; defaults, resets and the Modified counter stay) and `rowFontSize = 22` (now applied to setting, action and
  read-only labels and values alike; descriptions keep `descriptionFontSize`).
- `setActionVisibility(modKey, {favorite = 'hide'})`: MCM's Add to favorites button is hidden on this page only (`defaults` and
  `modifiedFilter` also exist and are left to inherit; each call replaces the previous map; Apply and Revert stay MCM's). It is sent with the
  presentation, so it is given again after a language change.
- **Back on Home** (id `home:close`, label and button text "Back", description "Close this menu."): a footer button on the home page
  only, which calls `api.ui.close(modKey)`; MCM closes its screen on its next update with its usual question when changes are pending (Home
  has none), and `closeMod` puts the page back on Home. The page still names no `backActionId` and keeps `escapeBack`, so Escape is MCM's
  own close, as before. If MCM refuses the request the action answers with MCM's reason (shown by MCM) and one line is logged.
  The sub-pages keep their own Back; submenu navigation is unchanged.
- The defaults button is named **Restore defaults** (new string, 15 languages) instead of **Defaults**: MCM 0.10.6 wraps footer labels that
  do not fit instead of squeezing every label, and with Add to favorites hidden the row is one button shorter. The first press still
  shows **Confirm** and the two-press rule is unchanged.
- Not changed (follow-up, see TODO.md): the page still gives no row a default, so MCM's own Defaults button, Modified counter and filter
  stay unused and this host's Restore defaults remains. With `highlightModifiedValues = false` real defaults would no longer paint rows
  purple, but they would bring MCM's own Defaults button (whose semantics, confirmation and interaction with the rules of `M.apply` and
  with disabled voice entries cannot be checked without the game) beside ours.

Tests: `bridge/mcm-host.test.mjs` over `bridge/mcm-fake.mjs`, a fake MCM that keeps the rules of MCM's own modules for providers,
schemas, drafts, Apply (including the exact `appliedIds` check), actions and the public UI extension (given version 0.10.6 or newer it also has
`close`, `setActionVisibility` and the new presentation options, and its layout follows them; at 0.10.5 it refuses the new options like the
real one, so the tests prove that none is sent); the setup check in
`bridge/setup-check-lua.test.mjs`.

## Fonts and widths

The widgets are the game's own, with the game's geometry, so their widths are estimates in the units of `optionUnits()` (an average
lowercase letter is 1; space 0.5; `i l . , : ; ' | !` 0.45; `t f r I ( ) - / [ ]` 0.65; `m w` 1.45; `M W` 1.6; other capitals and
digits 1.15; a Chinese, Japanese or Korean character 2). `LAYOUT` in `mod/nsui.lua`:

| What | Limit |
| --- | --- |
| label of a row with no button text | 36 units |
| label of a row with a button text | 29 units |
| section name | 70 units |
| button text | 18 units (up to 9 units at text size 45, longer at 34) |
| description | 420 characters |
| select option | 26 units (`OPTION_BUDGET`) |

A label, button text or text line that does not fit is cut with an ellipsis, **and its whole text leads the description**, so nothing is
lost. A description over its limit keeps whole paragraphs while they fit, otherwise the first paragraph cut at the last full sentence
(or word) before the limit; the descriptions put what a player must read first (Mature content's rules, who answers right now).
`bridge/nsui-labels.test.mjs` builds every page with the real host in all 16 languages (English and the 15 translations) and holds it
to this: only text lines may be cut, a switch, selector, slider or button never is (a translation that does not fit must be
shortened). `bridge/description-fit.test.mjs` holds every description in every language to the 420 characters.

**Select labels.** A selector shows its value between two arrows in a box of fixed width (about 32 units) that the mod cannot change,
and a focused row draws a key box ("A", "D") over each arrow, covering the first and last letters; each box is taken as 3 units
(`KEY_HINT_UNITS`), which leaves 26 for the text. Neither NSUI nor the game scripts shipped with the mod carry the geometry, so this is
an estimate: if a focused label still runs under a key box in the game, raise `KEY_HINT_UNITS`. The built-in entries are short
(`Voxtral · Mistral cloud`, `Voxtral · needs Mistral key`, `Qwen3.5-4B · uncensored`,
`Gemma 4 E4B · uncensored`; the word "uncensored" stays because `bridge/local-model-choice.mjs` recognises models by it). A model the
player adds shows its own name, `(custom)` or `(custom · too large)`, and `fitOption()` cuts a label built at run time (keeping a
trailing `(...)` or ` · ...` part). `bridge/select-labels.test.mjs` checks every select text in all languages.

**Fonts.** The rows take the font of the game's language. A language of this mod that has a font family of its own (Russian,
Ukrainian, Chinese, Japanese, Korean; `mod/ui-fonts.lua`) needs that family when the game runs in another language, so the rows and the
description area get it, in bounded batches from update, after a draw and when the tab opens; the description area's font goes back
when the tab is left. Latin languages (Italian, Polish, Czech, Hungarian and Turkish included, which the game ships with its ordinary
Latin family) get nothing, and no widget is walked (tested).

## Parties (saved parties, 2026-10-28, branch `feat/saved-parties`)

The Home destination formerly called Current party is **Parties** (view id `party`, row id `tab:party`). Its first section is still **Current party**,
unchanged (one row per copy, the housemates, the driver group above it). New:

* **Save current party** (`party:save`), the last row of Current party and shown only while somebody is in the party. It stores the party as
  **Party 1**, **Party 2** and so on (the lowest number no saved party has; the word comes from the string "Party", so it follows the interface
  language at the moment of saving). It keeps, in order, each member's character key and name: a character in the party twice is two entries (a
  copy), and a character the player made in the character editor is an entry like any other (its key is the custom key). Nothing else is kept,
  because the invitation has no other per-member choice: the conversation profile of a copy is the character's own, and voice, outfit and behaviour
  are saved by character in the settings already. Members still being prepared count; a copy that is leaving and a failed invitation do not.
* One section per saved party under Current party, headed **Saved party: {name}**, with a read-only line of the members ("Judy, Panam (2)"; a
  character twice shows her count) and four buttons:
  * **Spawn party** invites the members. It ADDS to the party and dismisses nobody (the choice made: replacing would dismiss people the player did not
    ask to lose). A character already in the party (joined, being prepared, or an appointment of Immersive invitations still on her way) counts
    toward the saved members, so pressing it twice does not double the party, and a saved party that names a character twice gets her second copy.
    Each missing member goes through the same invitation as the Invite button: the same queue, preparation, notices board and "joined" notice. With
    Immersive invitations On the first invitation of a character is an appointment (the Invite button's behaviour), a copy beyond the first is a
    plain invitation. A member that cannot come (the character model is gone, for example a deleted custom character, or the invitation is refused) is
    left out and named with the reason in the feedback line, "Could not invite: Rita (that character model is unavailable).", and the others still come.
    There is no party size limit (see "Party size"), so none is checked. The bodies appear one per queue flush (a flush runs about four times a
    second): `queue.invite(key, {stagger = true})` marks the job and `mod/manager-party.lua` `flush` makes at most one marked body per flush, so a party
    of six does not create six bodies in one frame. A plain Invite is not staggered. Placement still spends the shared query budget as before.
  * **Update with current party** replaces the saved members with the current party (disabled while the party is empty, so a saved party is never
    wiped).
  * **Rename party** takes the new name from **Mod Configuration Menu's Search box**: type the name there, then press Rename. Native Settings UI has no
    text field (nor does anything else in the manager: the Model browser's search uses the same box), so there the row says so and the default name
    stays. On this page the box is not a filter: `mcm-host.lua` gives the page MCM's provider search mode (as for Characters to invite and the Model
    browser), `M.setSearch` keeps the typed text with its case in `modelFind.typed` and draws nothing for it, and the box is emptied on the way in and out like on
    those pages. A name is cleaned to one line of at most 32 characters without braces, and another saved party's name (case-insensitive) is refused.
  * **Delete** asks twice: the first press turns the button into "Press again" (and says so), the second deletes. Any other button or another page
    disarms it.
  Up to 12 saved parties, up to 16 members each (a longer party is cut and the feedback says so).
* Storage: `runtime/saved-parties.json`, `{version = 1, next = n, parties = [{id = "party-<n>", name, members = [{key, name}]}]}`, written by
  `mod/saved-parties.lua` only when a button changes something (a write that fails keeps the parties for the session and the feedback line says so),
  read once when the page first needs it. It is player state like `favorites.json`: listed in `GAME_STATE_FILES` (`bridge/game-state.mjs`) and in
  the `state` class of `packaging/runtime-exchange.json`, so the service keeps a copy outside the game folder, restores it if the file goes missing,
  and no package ever ships or replaces it (`packaging/vortex-no-rewrites.test.mjs`). It belongs to the player, not to a save. The module loads
  with `pcall(dofile, 'saved-parties.lua')` and is read through the global `convaiSavedParties`; without it the page is the old Current party page.
* Cost: nothing runs per frame. The page is built when it opens or changes (its signature carries the saved-parties revision), the file is read
  once, and a Spawn is one pass over at most 16 members.
* Characters the game placed (story characters too) are not part of this: a saved party only ever invites our companions and copies, as the Invite
  button does.

## Party size

The party has no size limit. The menu, the phone, the follow action ("come with me"), undoing a dismissal and the bridge never refuse a
companion because of how many are already travelling, and no text mentions a capacity. The old refusals and their strings
(`party-full`, "There is no room for another companion", "Party full: ...", "Party: {count} / 8") are gone. The technical bounds that
remain are resource guards that scale with the party instead of refusing it:

| Bound | Where | What happens in a larger party |
| --- | --- | --- |
| Formation places | `mod/companion-space.lua` | The eight authored places keep their geometry. Place 9 and later continue the formation in staggered rows of two, 1.2 m further back each row, generated on demand. Lanes, the stand-off distance and the "near group" radius follow. |
| Route planning and physics queries | `mod/companions.lua`, `mod/companion-clearance.lua` | Unchanged: 192 spatial queries per update and two new route plans per update, started round-robin. A larger party is planned over more updates; nobody is refused or starved. |
| Warm Convai connections | `bridge/party-connections.mjs` | At most 8 private connections stay warm (`WARM_PARTY_LIMIT`), inside the 11 browser pages (8 plus 3 for the talk target, group chat, partners and nearby). With more members, pending invitations come first, then the members V talked to most recently. Everyone else connects when V talks to them; the first reply to a member who was not warm waits for a connection. |
| Invitations preparing at once | `bridge/companion-invitations.mjs` | At most 8 characters have their memory and voice prepared at the same time (`PREPARATION_LIMIT`). More invitations wait in "Preparing" and start as earlier ones finish; one whose connection has no warm place yet stays in "Connecting" until an earlier one joins; it does not fail. |
| Spawning | `mod/manager-party.lua`, `mod/companion-placement.lua` | Placement spends the shared per-update query budget. When it is spent the invitation is retried on a later update. |
| Group chat | `mod/group-chat.lua` | Three speakers per round: a conversation size, not a party size; any members can be chosen. |
| Party cars | `mod/companion-vehicles.lua` | A runaway guard on cars the mod may create: at least 8 cars in all (V's and 7 more, seating 31), growing to 2 plus one car per 4 people travelling. |

## Help and support report

**Settings, Privacy and help, Help and support** opens the Help page (Back to settings at the top, it returns to Privacy and help). Its sections:

- **Setup check** (below): the **Conversation service** row first (Running, Starting, Not running, Needs a browser or Unknown), then one
  line per check. "Needs a browser" is shown when the service never started because no Chromium browser (Edge, Chrome, Brave, Opera and
  others) is installed (`bridge-service.json` code `browser-missing`); the row's help, the in-game notice, the Help page
  (whose service line reads "Needs a browser") and the first lines of the short report then say "The conversation service needs a
  Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, or put the path of yours in a browser.txt file in the red4ext/plugins/AiNpcCyberpunkMod folder of the game (no launcher.ini is needed), then restart the game." While the service is not
  running or starting and no model is listed, the Local AI model row reads "Service not running" or "Service starting" instead of "No
  model installed", which stays for a service whose state is unknown. A service that is down says why on that row (`mod/setup-check.lua`
  `serviceWhy`, 27 Oct): "Service not running (Runtime not loaded)" (no trace of the service in this session and this mod's native plugin is not
  loaded), "(Did not start)" (the plugin is loaded and nothing reported, or the service was started and never reported), "(Runtime incomplete)",
  "(Could not start)" (a start Windows refused, with the error number the launcher wrote, the service cannot see the game folder, or a crash), and
  "Needs a browser"; the row's help holds the sentence and what to do. The key for the page's redraw includes the reason.
- **If something goes wrong**: one line saying what to do.
- **Report for the developer**: **Generate report**, **Last report** (the file name as the value; the description holds the shortened
  path) and **Copy report path**. The copy button writes `runtime/clipboard-request.json`; the conversation service puts the full path
  on the Windows clipboard with `clip.exe` (only the path of a `convai-report-*` file, or the short report `convai-report-lua.txt`, is
  accepted). While no service answers the button cannot copy, and the help shows the whole path instead. The "Support report saved"
  popup appears only in Developer mode (once, when gameplay resumes).
- **Where the logs are**: absolute paths for the mod's `runtime\` logs (`probe.log`, `mcm.log`), the conversation service logs
  (`bridge.stderr.log`, `bridge.stdout.log`, `bridge-service.log`), `launcher.log` (`red4ext\plugins\AiNpcCyberpunkMod`), the CET logs
  (`cyber_engine_tweaks.log`, `scripting.log`), `r6\logs\redscript_rCURRENT.log`, `red4ext\logs` and the reports folder.

Where each log is written (verified in code): `mod/init.lua`, `mod/phone-layout.lua` and the setup check append to
`<mod>\runtime\probe.log`; `mod/nsui.lua`, `mod/manager-ui.lua` and `mod/init.lua` (notices) append to `<mod>\runtime\mcm.log` (the
manager's log, named for the old page, kept so reports and tools work); CET writes `<mod>\AiNpcCyberpunkMod.log` and its own logs; the
supervisor (`bridge/bridge-supervisor.mjs`) writes `bridge-service.log`, `bridge.stdout.log` and `bridge.stderr.log` (previous run:
`.previous`) to the **state folder** (development: the project's `runtime\`; packaged: `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`, in 0.2
`<mod>\data`); the RED4ext launcher writes `launcher.log` beside its DLL. Lua cannot see outside the mod folder, so the service publishes
the real absolute paths in `runtime\support-paths.json` at start; without it the page shows `the game folder\...` templates.

### Setup check (2026-10-19)

Most setup trouble players reported was never explained by the game: the Runtime missing or not loaded, a pack extracted one folder too
deep, no Chromium browser, Native Settings UI missing, only a Mature pack installed with Mature content off, a firewall prompt declined,
a Mod Organizer 2 or Vortex install. The first section of the Help page answers all of these without a report. The value is OK, Problem,
Note (worth knowing, never a problem) or Unknown (could not be asked yet); the line's help is the one-line fix, and the group's
description says "No problem found." or "Problems found: N." Lines: Scripts and Runtime (`versions`, only when the service has
answered), Mod files, Game version, Cyber Engine Tweaks, RED4ext, redscript, Codeware, **Native Settings UI**, then the
service's own lines Optional packs, Browser, Local AI, Internet, Graphics card and Mod manager. Product names are not translated; the
sentences are, in all 15 languages. **Mod Configuration Menu is not checked and never produces a problem line.** **Audioware and TweakXL are not checked either** (since 2026-10-22 the mod plays every voice through its own browser audio path and ships no tweak files): the check never probes them, has no line, notice or report row for them, and a player who has them installed sees nothing different.

| Line | Detected by | Problem when | Fix it names |
| --- | --- | --- | --- |
| Conversation service | Lua, `service-status.lua` (`reach()`, `unavailable()`, `failureCode()`) on `bridge-service.json` and the heartbeats | no trace of the service in this game session (`never`), or a failed start whose code says the Runtime's files are missing (`install-incomplete`, `bridge-missing`, `missing-character-ids`, `launcher-not-configured` (an older launcher with no `launcher.ini`: its own sentence names the file), `launcher-program-missing`, `launcher-directory-missing`), or any other failure with its code; a missing browser and a missing key keep their sentences | extract the Runtime zip straight into the game folder; download it again; restart and send a report |
| Mod files | Lua, opens the four JSON catalogs, counts `locales/*.lua` (15), reads `release.json` for the Scripts version | a catalog or locale is missing | extract the Scripts zip again and let it replace the files |
| Game version, Cyber Engine Tweaks | Lua, `GetGameVersion()` and `GetVersion()` | never: Note when the game is not 2.31 (the mod is tested on 2.31 only), Unknown when unreadable | none |
| RED4ext | Lua: the native plugin, Codeware or this mod's scripts answered | nothing answered | install RED4ext |
| redscript | Lua: `player:ConvaiRequirements()` (`Requirements.reds`), or for scripts of 0.2.1 and older the getter `ConvaiPhoneIsOpen`; Unknown without a player | the player has neither: the scripts did not compile (a compile error anywhere disables every redscript mod) or are not installed. When the service's `compiler` check (`bridge/setup-check.mjs`: is `engine/tools/scc.exe` there?) says the compiler is missing, there is no compile log to open and the line, the notice and the console say "redscript is missing" with the sentence of any missing requirement | open `r6/logs/redscript_rCURRENT.log`: a mod it names is the cause; missing or old Codeware or redscript, or a game other than 2.31, can also cause it. With the compiler missing: install redscript |
| Codeware | Lua: the words `ConvaiRequirements()` answers with (`codeware`, `codeware-ui`, `codeware-textinput`): the modules that existed when this mod's scripts compiled. The scripts compile without it (each file that needs it guards it with `@if(ModuleExists(...))` and carries stand-ins), so loaded scripts no longer prove it. Scripts of 0.2.1 and older still imported it, so for them loading is proof (the probe `Codeware.Version()` decides the version shown). Scripts that did not load say nothing: the line is OK only when the plugin's own probe finds it, otherwise Unknown, so a compile error is never blamed on a framework. A stale `audioware` word from older scripts is ignored | the word is missing; Codeware without `codeware-ui` and `codeware-textinput` is too old ("Codeware is too old. Update it from Nexus Mods, then restart the game."). The class alone, without a version, is `missing` | install or update it from Nexus Mods |
| Native Settings UI | Lua: `GetMod('nativeSettings')` (or `'NativeSettings'`) with its `data` table and the ten functions the host calls (`mod/setup-check.lua`) | missing, or present but too old | install 1.96 or newer from Nexus Mods |
| Scripts and Runtime | bridge: `release.json` of the mod folder and of the Runtime (`package.json` in a development checkout). A running service that gave no answer to the request, with none earlier this game session (the bridge writes one when it starts), is a Runtime from before the setup check existed (0.2.1 and older cannot say their version): Lua marks the service silent and the line says the Runtime is probably older. Not claimed for a service that is not running or has stopped since the request | the versions differ, or the service is silent | download both for the same version |
| Voice files | bridge: `bridge/runtime-python.mjs` reads the folders of the Runtime Python's `python3XX._pth` for the standard library files and site-packages the Pocket voice, V's voice and the local microphone recognition import (every run, no process), and a full run starts `python.exe -I` once to find every module and to read its start-up messages (a good answer is kept ten minutes). A row only when it is a problem | a file is missing (report 0b8367fd0ebd2f2f: `Lib/urllib`, Python started and the voice never could) | extract the Full download over the install again (the first-load notice says: reinstall the Full download from Nexus Mods) |
| Optional packs | bridge: Pocket, OmniVoice, Local AI standard and lite and the Mature models found; `findNestedPacks()` looks for `red4ext/plugins/AiNpcCyberpunkMod/app` under the game folder's child folders (and one level further), the mod folder and the plugin folder; `pack-placement.json` says what the launcher moved at this start | a pack is still one folder too deep, or the launcher could not move its files | restart the game (the launcher moves the pack at its start; the line says so), and if it is still there move the `red4ext` folder inside it into the game folder |
| Browser | bridge: `systemBrowserCandidates()` (looked up once per process) | none found | install Edge, Chrome, Brave or Opera |
| Local AI | bridge: the chosen provider against the pack, the free graphics memory and the server state (`not-used`, `ready`, `warming`, `not-installed`, `no-memory`, `mature-off`, `no-gpu`, `start-failed`, `crashed`) | Local AI is the provider and cannot run | download a pack, turn on Mature content, update the driver, or choose another provider |
| Internet | bridge: a TCP connection to port 443 of the host each chosen service needs (`api.convai.com`, `api.mistral.ai`), closed at once, nothing sent. Not asked for Local AI with a local voice | the connection fails (`no-dns`, `blocked`, `timeout`) | allow Node.js through the firewall or antivirus, check the internet |
| Disk space | bridge: `statfs` of the game folder and of the data folder (no process, part of the first light run too); the drive with less free space is named. A row only when it is a problem | under 2 GiB free (`code: low`, with `drive` and `freeGiB`). Full disks make the logs, the memories and the settings backups fail to save | free some space on that drive. Also the last first-load notice; no error report is made for it |
| Graphics card | bridge: `reg.exe query` of the display class key, once per process | never | none; the name and memory also go into the support report |
| Mod manager | bridge: `usvfs_x64.dll` among the loaded libraries means Mod Organizer 2; a `vortex.deployment*.json` in the game folder means Vortex | never | MO2: the Overwrite folder; Vortex: install the Runtime and packs by hand |

**When it runs.** Never per frame. The Lua checks run once, 12 s after the first world is ready (`FIRST_DELAY_S`) and once each time the
Help page opens (a few milliseconds: five small files and a few class lookups); `tick()` is called from the quarter-second slow update of
`mod/manager-ui.lua` and, with nothing due, does a few comparisons (a test counts file opens and game calls). The bridge answers through
two exchange files, shipped empty and only ever rewritten in place (Mod Organizer 2, `packaging/runtime-exchange.json`): the Help page
(and the first-load check) writes `runtime/setup-check-request.json` from the next update, never inside the menu callback;
`bridge/setup-check.mjs` polls it every 500 ms and replaces `runtime/setup-check.json`; the page follows the request for 15 s, one small
read a second, and redraws when the answer arrives. At the end of its start the bridge also writes a **light** answer (files and memory
only); a request is **full** (browser, graphics card and mod managers looked up once per process, the connection test made again each
time). Only an answer written this game session is shown (a 180 s window, as `service-status.lua`).

**The first-load notice.** When something critical is wrong the player gets one notice, once per game session, in gameplay: the first
problem in a fixed order (RED4ext, the build for the game (the Scripts, the Runtime and the running game are not for the same game version, docs/GAME_VERSIONS.md "Wrong build"), this mod's scripts, Codeware, Native Settings UI, mod files, a service that never
started, Scripts and Runtime, voice files, packs, Internet), one short text of at most two lines (`bridge/setup-notice-fit.test.mjs` holds all 15
languages to that), shown for 9 s once gameplay has been on screen for 8 s without a menu or a load (`SETTLE_S` in `mod/setup-check.lua`: the notice was lost when it fell due on the frame a save was restored, before the HUD existed). The order puts everything that keeps the mod from starting, and Native Settings UI, before the texts that say "See
Help in Settings", so a notice never sends the player to a page they cannot open. A service that failed has its own notice
(`service-down`), Local AI its own fallback notices, and a mod manager, the game version and the browser none; those are lines on the
page only. At the first load the Lua also asks the running service for its full answer and waits for it (at most 15 s), so a
firewall that blocks the service is found without opening Help.

**Without Native Settings UI** the manager, and so the Help page, cannot open. The notice says "The Companion Manager needs Native
Settings UI (Nexus Mods)", the CET console and `runtime/probe.log` get one English line ("AI NPC Cyberpunk Mod: Native Settings UI is
missing or too old, so the Companion Manager cannot open. Install Native Settings UI 1.96 or newer from Nexus Mods
(https://www.nexusmods.com/cyberpunk2077/mods/3518), then restart the game."), and the probe log lists every problem found. **Without
this mod's scripts** (`worldReady` never becomes true) the notice is written straight to the warning line (`notices.lua`
`M.screen.timed`) and shown when the game is no longer paused and no menu is open.

**A missing requirement, and scripts that did not compile (2026-10-19).** A redscript compile error disables every redscript mod, so
two players lost the whole game's scripts to this mod's files when Codeware or Audioware (a requirement then) was not installed. `r6/scripts/CyberpunkConvai/`
now always compiles: the code that needs Codeware sits behind `@if(ModuleExists(...))` and each method Lua calls has a
stand-in (see README, "A missing requirement never stops the compile"), and `Requirements.reds` adds `PlayerPuppet:ConvaiRequirements()`.
What the setup check does with it, and what still runs when a requirement is missing:

| Missing | Notice at the first load | What is left out |
| --- | --- | --- |
| Codeware | Codeware is missing | the speaking face (`Face.reds`), the save-bound knowledge state, the text box on the talk key (each press says so), the phone Chat tab (no contact is offered), the J and L keys and marks on the contact list, the holocall backdrop (the live picture is then not cut out either) |
| Codeware without UI modules | Codeware is too old | the text box, the Chat tab and the old Manager window |
| Native Settings UI | its own text | nothing in the scripts: they do not use it |
| scripts did not compile | "Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load." | everything that needs a script (text box, phone, face, speech playback); the Lua side still loads and shows the notice |

RED4ext and Codeware both missing are one notice naming both (the list is capped at four names in `MAX_NAMES`; Native Settings UI keeps
its own notice, its name being long). The CET console and `probe.log` get one English line per problem. Because a compile error also takes
away the scripts the old checks relied on, the order now puts "scripts did not load" first and alone, after RED4ext only, and the
Codeware line turns Unknown instead of Problem while it is true. RED4ext stays a Problem when nothing it loads
answers, this mod's native plugin included (which does not depend on the compile): Codeware's scripts then never reach the compile, so
RED4ext, not a mod the redscript log lists, is the cause to name. `onInit` (`mod/init.lua`) installs each hook set through `convaiGuarded`, so one hook that
cannot be placed (it names a method of the missing scripts) no longer stops the Native Settings UI registration after it. Other mods
that need Codeware fail the compile in a game without it, whatever this mod does, and the redscript popup then names them. Not covered by
`ModuleExists`: a requirement that is installed but too old to have a class or method: that still fails the compile and shows in
`redscript_rCURRENT.log`. `Manager.reds` stays: it
holds the voice and subtitle on/off switches that `speech.lua`, `subtitles.lua` and `init.lua` read and `manager.lua` sets, although
nothing opens its window.

**In the reports.** The short report the game writes has a `== setup check ==` section: one plain line per check
(`service: ok running`, `codeware: problem missing`, `service gpu: ok found name=... memoryMiB=...`). The full report's `summary.json`
gets `system.graphics` (name and memory of up to eight cards; this was missing before), the setup document among the status files, the
game-side rows under `request.setup` (at most 24 rows of four short tokens), and every Problem at the top as a `PROBLEM FOUND` line;
a missing browser is told once, by the service status. A setup document of another bridge process counts for ten minutes only.

Tests: `bridge/setup-check.test.mjs`, `bridge/setup-check-lua.test.mjs` (the Lua module over a fake game),
`bridge/support-help-ui.test.mjs`, `bridge/setup-notice-fit.test.mjs`, `bridge/support-report.test.mjs`.

### How a report is made

1. **Generate report** writes `runtime\report-request.json` (`{version, id, issuedAt, lua:{cetVersion,
   language, view, developerMode, party[]}}`) and waits. The service polls every 500 ms
   (`bridge/support-report.mjs`), writes `runtime\report-result.json` (`building`, then `ready` with `path`,
   `fileName`, `bytes`, or `failed` with a code) and builds
   `%LOCALAPPDATA%\AiNpcCyberpunkMod\reports\convai-report-YYYYMMDD-HHMMSS.zip` (the parent of the service's `data\` folder, so outside
   the game folder: a file created there would land in Mod Organizer 2's Overwrite folder; a service whose data folder is not named
   `data` outside the mod folder, as in development, keeps `<mod>\runtime\reports\`). The service publishes the folder in
   `runtime\support-paths.json`; before it has, the page names `%LOCALAPPDATA%\AiNpcCyberpunkMod\reports` and `...data`.
   Only the newest five reports are kept.
2. The zip holds `README.txt`, `summary.json` (mod fingerprint, CET/game/RED4ext versions, service status,
   settings, party, provider per companion, recent errors, the log index) and `logs/NN-<id>.txt`: the last
   2,000 lines or 1 MiB of each log.
3. If no service is answering the page writes a **short text report** itself at once, with no request and no wait:
   `bridge-service.json` missing, empty, unreadable or stale and no fresh heartbeat (`service-status.lua` `reach()`: `never` when
   nothing of this game session shows, `stopped` when it ran and went quiet), or a fresh status that says stopped or failed. A
   service that is up (a fresh heartbeat, or a fresh ready, starting or restarting status) is asked and given 6 s
   (30 s once it reports `building`) with the banner "Creating the report…"; no answer, or `failed`, ends in the short report.
   When the service never started, the second line of the short report is a `PROBLEM:` line with the likeliest causes (the Runtime
   is missing or did not load: `red4ext\plugins\AiNpcCyberpunkMod\`, the RED4ext log, antivirus; a Chromium browser). The short report holds what the game can read
   (service status, settings, party, `runtime\*.log`, `AiNpcCyberpunkMod.log`), says why it is short and names
   the logs it could not read. It is one fixed file, `runtime\convai-report-lua.txt` (shipped empty and rewritten in place, so a
   new report replaces the last one and no file is created, renamed or removed).

### Privacy

Only named files are ever opened, so credential files, audio, voice references, model files, chat history and conversation transcripts
cannot enter a report. Credential files (`convai-key.txt`, `kaggle-access-token.txt`, `huggingface-*.txt`) are read only to learn the
secret values to scrub. Every line passes a redactor: known secrets, `Authorization` and `key/token/secret/password/cookie` assignments,
`Bearer` tokens, `?token=` parameters, well-known key prefixes, hex runs of 32+ characters, 40+ character token-like runs, UUIDs and
provider IDs (hashed to 8 hex characters), and the Windows account name. Structured values are also redacted by key name.
`bridge/support-report.test.mjs`, `bridge/support-report-lua.test.mjs` and `bridge/support-help-ui.test.mjs` plant fake keys, IDs, a
Windows name and conversation text and require that none reaches either report.

## Invitation notices

An invitation is ready, and the companion spawns and is announced as joined, only once her Convai connection is open. On a player's own
Convai key (one connection at a time) the invitation opens her connection alone, one invitation at a time; the other members'
connections open when V talks to them, which is when the `Preparing connection to {name}...` notice can show.

While an invitation prepares for longer than 1.5 s, the loading notice (held on screen, `docs/NOTIFICATIONS.md`) shows **Preparing
{name}: waiting for ...** with the step that blocks her (the conversation service, the memory service, the voice model, her connection,
or the game placing her), kept until she has spawned or failed; the notice board then posts **{name} joined your group.** The line under
Back shows nothing for progress; a preparation failure shows there (**{name}: preparation failed. Cancel and invite again.**). It tracks
the latest requested pending copy, cancelling or spawning that copy or resetting the world clears it, and a memory, dismissal or trip
result replaces it. `manager-party.lua` exposes a read-only snapshot (`preparationFeedback`) that `manager-ui.lua` samples about once a
second; no widget work is involved. Manager invitations also post the game's blue neutral warning notification, through the same
`PlayerPuppet.ConvaiPhoneFeedback` method as phone invitations; the manager creates no HUD widget of its own.

**Which notices a player sees** (the same in every mode, Developer mode included): what a companion is still waiting for (one held line
each, after 1.5 s), that she **joined your group**, and every failure and error (including a driving failure and the reply to Stop trip).
No **Connecting**, **ready to join** or **is joining your party** text is posted; the Current party list shows each copy's stage as its row
state and the mod log keeps every stage. Developer mode only: the **dismissed** result (the feedback line still reports it, and a failed
dismissal is always shown), the routine driving instructions, companion tactic outcomes and the popup after a settings change that
switched the voice. The native phone script's own "{name}: invite queued." popup is no longer shown (2026-10-09). The full list, with
class and repeat window, is `docs/NOTIFICATIONS.md`; `mod/notices.lua` is the one gate.

### One merged notice for invitations made together

Manager and phone invitations share one **notice board** (`M.newBoard` in `mod/manager-party.lua`, `queue.board()`). Every invitation in
flight is an entry, and the board turns all of them into ONE compact notice that replaces the previous one:

- One invitation reads `Preparing Judy: waiting for the voice model to load...` and then `Judy joined your group.`; a quick one shows only
  the joined line. Several companions preparing together share the held notice, a line each.
- Several at once end in one notice: `Judy and Johnny joined your group.` Up to three names are listed; more are summarised (`Judy,
  Johnny and 3 others joined your group.`). A failure is mentioned beside the successes (`Judy could not join: ...`); more than two
  failures end with `N more companions also failed.`
- A posted notice stays up at least 3 s (`MIN_SHOW_MS`) and 5 s after a final outcome (`FINAL_SHOW_MS`); a change arriving sooner is held
  and whatever is true when the time is up is posted. Only a new failure is exempt. When one companion has joined and the others of the
  burst are still going, the joined line waits up to 4 s (`JOIN_HOLD_MS`) for them. The game's own notice length could not be read from
  the installed files, so the 3 s and 5 s are estimates. A stage never moves backwards within one attempt.
- Every posted notice is logged to `runtime/mcm.log` with each invitation's stage. An outcome that a menu hides is shown once more in
  gameplay; nothing is replayed after cancellation or a world change (`queue.bind` resets the board). `mod/manager-ui.lua` posts the
  board's note from its top-level update (committing it only after the native call succeeded); `mod/init.lua`
  (`updatePhoneInvitationFeedback`) asks the same board for phone invitations.

A preparation failure is never gated: each failed attempt posts exactly one gameplay notice in total, shared by the manager, the phone
and the queue's detailed notice, and stays failed until the player cancels or chooses the profile again. One first seen while the menu
is open shows on the feedback line, and the notice is posted once when gameplay resumes. Native calls run only from top-level update,
never inside a native callback. The popup tests cover deduplication, Developer mode on and off, immediate and asynchronous failures,
cancellation, phone ownership and already joined tickets; their visibility in the running game remains the live acceptance gate.

## Connecting nearby characters ahead of the talk

**Always on since 2026-10-20: the setting "Auto-connect nearby characters" was removed, so there is no row and nothing to switch.** The talk key already works on any NPC within 8 m
whose record or name resolves to a profile (`profileIdentity`, `characterCatalog.resolve`), so the game's own Judy met in the world can
talk. The connection used to open only when the chat did (`warmConversation`, `runtime/conversation-prewarm.json`), which costs a wait
on the first reply.

- **Notice:** starting a chat with a world character that is not connected yet shows `Preparing connection to Judy...`
  (a party copy that is still connecting included); with a voice chat the line is joined to `Connecting microphone - wait for
  Listening`. It shows at the start of the conversation only; looking at a character and her warm-up are silent. A character already
  connected shows nothing. Group chat shows no wait notice.
- **Warm-up** (`mod/auto-connect.lua`): a character with a profile that V looks at for 0.6 s, or stands within 5 m of (a 1 Hz `GetTargetParts`
  scan), is warmed: the Lua side publishes up to **two** profile keys to `runtime/nearby-connections.json` (rewritten on change and every
  2 s) and `bridge/nearby-warm.mjs` opens their private connection (`PartyConnections.setNearby`, role `nearby`, the lowest priority: it
  never evicts a party, invitation or composer connection) and prepares their local voice (`localVoice.prepareProfile`: one voice at a
  time, only while no turn, microphone or voice change is running; a failed voice is retried after 30 s).
- **Limits:** at most 2 warm at once; one new start every 3 s; none in combat, a scripted scene, a call, a dialogue or a vehicle, and not
  while a menu pauses the game; a looked-at character may replace the idlest unwanted one; a character is released 40 s after it stops
  being wanted, or after 10 minutes without a conversation, and waits 20 s (3 minutes after the age release) before it can be warmed
  again. Party members are never listed. **Ranking:** a looked-at character first, then nearby characters by prominence (tier-1 named,
  other named, generic residents and archetypes; `autoConnect.prominence`), then by distance.
- **Conversation partner:** a world character V talks to becomes a partner, a role of its own that does not use one of the two slots
  (`partners` in the same file; role `partner`, below the party, invitations and the current target, above nearby). The private
  connection is the one the conversation opened, so no second connection is made. It stays warm while V stays with it and is released
  when they part: more than 15 m away for 20 s, 3 minutes without an exchange, the character despawns, or a scene or game dialogue
  starts (`partnerRange`, `partnerAway`, `partnerIdle`). Talking to someone else gives the previous one 30 s (`partnerGrace`); at most 2 at
  once. Ambient residents keyed per entity cannot be warmed without their entity.
- **Release:** a world change and CET shutdown publish an empty list at once; the bridge also treats a list not
  refreshed for 8 s as empty. The composer hint (`conversation-prewarm.json`) is untouched and still wins for the character being talked
  to. It sends no message, creates no memory and records no contact.
- Tests: `bridge/auto-connect.test.mjs`, `bridge/nearby-warm.test.mjs`, `bridge/conversation-partner.test.mjs`,
  `bridge/world-lifecycle.test.mjs` and the nearby cases in `bridge/party-connections.test.mjs`.

## Ownership

- `mod/mcm-host.lua`: the MCM host (above). Registers the provider, converts the page to MCM's schema, answers MCM's calls (`loadMod`,
  `invokeAction`, `applyBatch`, `closeMod`), keeps the page current. Knows nothing about what a setting means.
- `mod/nsui.lua`: the NSUI host, and the one object `init.lua` talks to: it owns the page logic instance, fans `install`, `update`,
  `resetSession` and `shutdown` out to the attached hosts and chooses the host for the shortcut. Registers the tab (`addTab`, the restore-defaults callback), draws the page, keeps it equal to the
  state, debounces and applies changes, fits texts, applies fonts. Knows nothing about what a setting means.
- `mod/manager-ui.lua`: the pages, rows, actions and rules (`schema()`, `M.apply`, `stageMature`, paging, feedback line), with no
  knowledge of the screen that shows them.
- `mod/nsui-entry.lua`: the shortcut's walk through the pause menu and the return to gameplay on close (above). Pause and input
  ownership stay with the game and NSUI; a bounded timeout leaves the player in a working menu.
- `mod/support-report.lua`: Help support (paths, request/result flow, short Lua report, copy path). Loaded behind a `pcall`; without it
  the manager simply has no Help entry. `bridge/support-report.mjs`, `bridge/zip-writer.mjs`: the service side.
- `mod/setup-check.lua` and `bridge/setup-check.mjs`: the Setup check. Loaded behind a `pcall` and read through its global
  `convaiSetupCheck`; without it the Help page shows only the Conversation service row first.
- `mod/manager-party.lua`: in-memory queue with distinct copy IDs and reservations for places. Deletions precede spawns. Accepted
  requests are tracked through attachment; ready and failure notices appear once in gameplay and remain on the feedback line. Failures
  are reported and never retried every frame. A player or save change and CET shutdown discard pending requests.
- `mod/manager.lua`: shared catalogue, settings storage, discovery and native playback flags. Settings are validated and saved as one
  transaction before their values are exposed; a failed save leaves playback unchanged.
- `mod/companions.lua`: owns actual entities, copy serials, formation slots and connection membership. Manager operations never adopt
  quest or ambient actors.
- `r6/scripts/CyberpunkConvai/Manager.reds`: the older native screen is still in the tree, but nothing opens it. Its player methods
  still carry the voice, subtitle and legacy enabled flags that `mod/manager.lua` sets.

Updates run outside the game-time poll so the page stays interactive when the simulation delta is zero. World changes and follower
updates wait for unpaused gameplay. Discovery is lazy, and file-backed readiness checks are throttled. `mod/nsui.lua` `M.inspect()`
returns the view, the sections drawn, pending changes, the entry state and the last error.

## Adding a row

A row is one call in `mod/manager-ui.lua`, placed in the right `category(...)` of the page. Nothing in `mod/nsui.lua` changes.

1. `setting(id, label, 'bool' | 'select' | 'int', value, default, help, elements?, raw?)` for a saved setting (`raw`: `min`, `max`,
   `step` for a slider; `elements` is the list for a select), `action(id, label, buttonText, help, callback, enabled?)` for a button, or
   `readonly(id, label, value, help)` for a line of text.
2. A saved setting also needs its key in `M.apply`: add it to the pass-through list for plain values, or to an `elseif` branch that
   validates the value and refuses with a sentence (`refused('...')`). A new saved key also needs its default in `loadSettings` and its
   branch in `manager.applySettings` (`mod/manager.lua`), which refuses a key it does not know ("Unknown setting").
3. Run `node scripts/Extract-UiCatalog.mjs` (it rebuilds `localization/en.json` from the calls) and add the translations in
   `mod/locales/*.lua`.
4. Run `node --test bridge/ui-catalog.test.mjs bridge/nsui-labels.test.mjs bridge/description-fit.test.mjs`.

Keep the label within the units above, the button text short, the help under 420 characters with what matters first, and select
options within 26 units. A refusal goes back to the saved value on its own; a rule that moves other rows belongs in `M.apply` (see
`stageMature`), not in the page.

## What is not verified in game

The manager is tested over a fake NSUI (`bridge/nsui-fake.mjs`, which re-implements NSUI 1.96's public contract, its path rules and the
hole it leaves in its section list, and checks that the widgets on screen are what its data says) and a fake game, in
`bridge/nsui-manager.test.mjs`, `bridge/nsui-entry.test.mjs` and `bridge/nsui-labels.test.mjs`; the page rules are in
`bridge/manager.test.mjs`. The branch still needs its live test. In particular:

- The whole tab in the running game: the shortcut's walk through the real pause menu, the Resume on close, the first page on every
  opening, Restore defaults, and rows replaced in place under a held slider.
- Text fit: every width above, the 26-unit select budget with its assumed key boxes, and the 420 characters of a description are
  estimates; the size of NSUI's description area cannot be read from the files this repository may use.
- Fonts of the Russian, Ukrainian, Chinese, Japanese and Korean rows when the game runs in another language.
- How it behaves beside MCM older than 0.10.5 (see "Beside MCM").
- The MCM host in the running game with MCM 0.10.5: that the screen opens on the manager from the shortcut in gameplay and from the
  pause menu, that Apply, Revert and Defaults behave as the fake says, the status line, the footer back button and Escape-back, the
  disabled OmniVoice entries, the page buttons, how it looks (the fake knows no layout: the label width, font sizes and the description
  area are MCM's), and that no Native Settings UI tab is listed in MCM when both are installed.
- The debounce times (0.3, 0.4 and 0.6 s, at most 2 s) are chosen, not measured against real widget callbacks.
- Favorites: that the Favorites block and the pairs of rows read well in both hosts, that a row replaced by a press (Add to favorites) does not
  lose a gamepad focus, and that MCM shows the page buttons' descriptions in its panel (see "Favorites" above).
- The visibility and timing of the invitation notices (the 3 s and 5 s stays) in the running game.

## Housemates (2026-10-25, docs/HOUSEMATES.md)

Current party lists the characters who live at V's place under the party copies, one row each: "{name} · lives in {apartment} · at home / with you / out"
with a **Move out** button (MCM and Native Settings UI share the page). Move out ends the housemate arrangement only; she stays as she is otherwise. A
housemate's body is not a party copy: it is not listed as one and does not count in the party. The page reads the list when it is built. While
Settings > Companions > Housemates is Off (the default) there are no housemate rows. That setting has a page of its own with six rows and a button, **Housemates**
(Off, On), **Move-in apartment** (Ask me, then the apartments V owns), **Housemates talk to each other** (On, Off), **Pause between chats** (1, 2, 5, 10
minutes, 2), **Housemates in one chat** (2, 3, 4 people, 2) and **Evict all housemates** (a button, enabled while somebody lives there; one status line says how
many moved out), and is part of Restore defaults.
