# Settings review, 2026-10-07

Every Companion Manager page and setting as the code builds it today, with the default
of each setting verified at the line where it is set, followed by flags and open
questions. Everything here was read from code (`mod/mcm.lua`, `mod/manager.lua`,
`mod/voice-preview.lua`, `mod/ui-locale.lua`, `bridge/voice-selection.mjs`,
`bridge/voice-config-paths.mjs`, `bridge/relationship-routing.mjs`,
`r6/scripts/CyberpunkConvai/Manager.reds`); no doc was trusted. Product code was not
changed. Labels are the English source strings (nine other locales translate them).

## How the pages are built

- One MCM page, **Companion Manager** (`mod/mcm.lua`, `schema()` at line 537). The view
  is switched in Lua (`navigate`), so every "page" below is a view of that one page.
  Back is the bottom-bar button (a row only if the bar button cannot be placed).
- Every setting waits for Apply (`AUTO_APPLY_WINDOW`, mcm.lua:25; applyBatch,
  mcm.lua:923). The top row of Settings, Character conversations and Relationships is the
  status line "Changes wait until you choose Apply." (mcm.lua:46, 857-864).
- All saved settings live in one file, `runtime/settings.json` (version 2), loaded and
  defaulted in `loadSettings()` (manager.lua:305-372) and written by `saveSettings()`
  (manager.lua:368). No file existed in this checkout, so every default below is the
  code's default for a fresh install. The bridge re-reads the same file every poll
  (`pollSettings`, bridge/convai-bridge.mjs:1264-1290) for the voice and relationship
  keys; every other key is Lua-only.
- The MCM "Defaults" button restores each row's `defaultValue` (the 5th argument of
  `setting(...)`). All of those match the saved-file defaults below (checked row by row);
  none differ.

## Home page (title "Companion Manager")

Four action rows, each value "Open" (mcm.lua:550-556). Not a setting page, listed
because the player sees it first.

| Label | Type | Opens | Description shown |
|---|---|---|---|
| Characters | action | Characters page | "Browse characters. {search query}" |
| Current party | action | Current party page | "Browse current party. {query}" |
| Model browser | action | Model browser page | "Browse model browser. {query}" |
| Settings | action | Settings page | "Browse settings. {query}" |

## Settings page

Back to Companion Manager (action, bottom bar). Status line row first (read-only):
"Changes wait until you choose Apply." / "Change pending. Choose Apply to use it, or
Revert to discard it."

### Interface

| Label | Type | Default (where set) | Options (labels shown) | Description shown | Stored as |
|---|---|---|---|---|---|
| Interface language | select | Automatic. manager.lua:312-313 (`'auto'`); mcm.lua:763 default index 1 | Automatic (game interface language); English; 简体中文; 繁體中文; Español; Português (Brasil); Français; Deutsch; Русский; 日本語; 한국어 (ui-locale.lua:99-110, languages list at :11-22) | "Choose the mod interface language independently of character voices and conversation language." | `uiLanguage` = `auto`, `en`, `zh-cn`, `zh-tw`, `es`, `pt-br`, `fr`, `de`, `ru`, `ja`, `ko` |

### Conversations

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| Character conversations | action ("Manage") | n/a | opens the Character conversations page | "Enable or disable each character's participation in AI conversations." | n/a |
| Memory | action ("Manage") | n/a | opens the Memory page | "Choose a character, review memory status and manage memories from your conversations." | n/a |
| Relationships | action ("Manage") | n/a | opens the Relationships page | "Choose ordinary or romantic conversations for supported characters." | n/a |
| Auto-connect nearby characters | toggle | **Off**. manager.lua:338 (`false`); mcm.lua:777 | On / Off | "Prepare the conversation with a character you look at or walk up to, so they answer without a wait. Off by default: the connection is made when you start talking. It uses a little memory and bandwidth, and pauses during combat and scenes." | `autoConnectNearby` |

### Companion behavior

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| Eye contact height | select | **Default** (0 cm). manager.lua:339-341 (`0`); mcm.lua:785 index 3 | 10 cm lower; 5 cm lower; Default; 5 cm higher; 10 cm higher (values -0.10, -0.05, 0, 0.05, 0.10; manager.lua:25) | "Raise or lower the point companions look at on V. Default uses V's usual eye contact target." | `eyeContactHeight` (metres) |
| Head tracking strength | select | **Gentle (default)** (1.0). manager.lua:342-344 (`1`); mcm.lua:788 index 3 | Eyes only (0); Less (0.5); Gentle (default) (1.0); More (1.5) (manager.lua:26) | "Choose how much companions turn their heads during eye contact. Eyes only relies on eye movement." | `headFollowStrength` |
| Body gestures | toggle | **Off** when reviewed; **On since 2026-10-11** (see the note at the end). manager.lua:337 (`false`); mcm.lua:791 | On / Off | "Companions gesture with their body while they speak longer replies and nod while you talk to them, using the game's own animations in their usual stance. They stop at once when anyone moves or a fight starts." | `bodyGestures` |

### Voices

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| Voice playback | toggle | **On**. manager.lua:316 (`true`); mcm.lua:799; native copy `m_convaiManagerVoice = true` (Manager.reds:793); bridge `playbackEnabled = true` (voice-selection.mjs:62) | On / Off | "Play voiced replies from your companions." | `voice` |
| Companion voices | select | **Pocket TTS · recommended** (index 1). manager.lua:21 (`'pocket'`) and :345-346; mcm.lua:800; bridge voice-selection.mjs:59, 69 (`'pocket'`) | 1 Pocket TTS · recommended; 2 OmniVoice 16 steps · short reference; 3 OmniVoice 16 steps · long reference; 4 OmniVoice 32 steps · short reference; 5 OmniVoice 32 steps · long reference; 6 Convai cloud voice (voice-preview.lua:12-19, labels from manager.lua:27-32 and mcm.lua:322-333). While the OmniVoice pack is missing, entries 2-5 read "... · Requires the optional OmniVoice pack (GPU)" and Apply refuses them (mcm.lua:952-954). The list stops at both ends (no wrap, mcm.lua:1068-1081) | Long text, see Flags: "Pocket TTS runs on your CPU. It is light and fast (first audio in about 0.15 s) and is the recommended default. OmniVoice runs on a capable GPU and sounds closest to the characters: by ear about 15-20% better than Pocket TTS at 16 steps and 20-25% better at 32 steps ... A change waits until you choose Apply, and no voice model is prepared before then." (919 characters, mcm.lua:801) | `voiceProvider` (`pocket`/`omni`/`convai`) plus `omniSteps` (16/32) and `omniReference` (`short`/`long`; only written for Omni choices) |
| Keep prepared voices | toggle | **On**. manager.lua:353 (`true`); mcm.lua:803; bridge `options.keepPreparedVoices !== false` (voice-selection.mjs:58) | On / Off | "Remember each companion's prepared voice so summoning them again is quicker. Pocket TTS saves one small file per character (about 5 to 15 MB) in the mod's runtime folder; OmniVoice does a short hidden warm-up at your chosen quality while a companion joins. Turn this off to save nothing on disk. The change applies without a restart." | `keepPreparedVoices` |
| OmniVoice pack | read-only | n/a | Installed / Not installed / Waiting for voice service | "OmniVoice is an optional add-on for computers with a capable GPU. Pocket TTS needs nothing extra." | not stored (bridge report, `localVoiceState.omniPack`) |
| Voice service | read-only | n/a | Ready; Loading; Preparing voices; Preparing a reply; Unavailable; Waiting for voice service; Not configured; Stopped; Releasing local voice memory; Convai voices · Local model unloaded; also "Pending: {voice}", "{status} · Using {voice}, {requested} unavailable", "Ready · Unsaved selection" (mcm.lua:285-312, 335-345) | "Changes wait until you choose Apply; Revert discards them. No game restart is needed." | not stored |

The category itself carries the description "Changes wait until you choose Apply."

### Subtitles

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| Subtitles | toggle | **On**. manager.lua:317 (`true`); mcm.lua:811; native `m_convaiManagerSubtitles = true` (Manager.reds:794) | On / Off | "Show companion replies using the selected subtitle display." | `subtitles` |
| Subtitle display | select | **Dialogue HUD** (index 2). manager.lua:318-320 (`'dialogue'`); mcm.lua:812 | 1 Above speaker (`overhead`); 2 Dialogue HUD (`dialogue`) | "Use the regular dialogue HUD by default, or place subtitles above the speaking companion. The Subtitles switch controls both." | `subtitleStyle` |

### Automatic reactions

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| React to battles | toggle | **On**. manager.lua:335 (`true`); mcm.lua:817 | On / Off | "A nearby companion can make one short comment as combat starts and another afterward. Ten-minute cooldown after a fight; conversations and story scenes take priority. Loading a save resets the cooldown." | `battleReactions` |
| React to collected loot | toggle | **On**. manager.lua:336 (`true`); mcm.lua:819 | On / Off | "Companions can comment after you finish collecting world loot. Storage transfers stay silent. A ten-minute cooldown spaces ordinary comments; newly acquired Legendary equipment has a separate two-minute cooldown. After a fight, pickups collected by then are folded into one end-of-fight comment; later pickups get their own comment." | `lootReactions` |

The ten-minute battle cooldown matches `cooldown = now + 600` (battle-reactions.lua:65).

### Development

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| Developer mode | toggle | **Off**. manager.lua:334 (`false`); mcm.lua:823 | On / Off | "Show routine companion popups: the joining step, dismissal confirmations, and driving instructions such as boarding and exit. Preparation progress, joined notices, failures and replies to Stop trip remain visible when off." | `developerMode` |

### Help

| Label | Type | Default | Options | Description shown |
|---|---|---|---|---|
| Help and support | action ("Open") | n/a | opens the Help page (row hidden if `support-report.lua` fails to load, mcm.lua:826) | "Find the log files and create a report to send to the developer if something goes wrong." |

## Character conversations page

Reached from Settings, Conversations. Category title "Character conversations". Status
line first. One toggle per profile in `conversation-characters.json`
(= `characters/roster.json`, 79 profiles in this checkout; release-plan.json:399-402),
sorted by name (manager.lua:527).

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| {character name} (79 rows, for example 8ug8ear, Aaron, Adam Smasher ...) | toggle | **On** for every character. manager.lua:362-363 (`true`); mcm.lua:703 | On / Off | "Allow {name} in private and group conversations. Existing copies can still follow you when this is off." | `enabledByKey[<profile key>]` (applyBatch id `enabled:<key>`). Also mirrored into a legacy six-entry `enabled` array for redscript (manager.lua:370-371) |
| Back to settings | action | n/a | bottom bar | "Return to conversation settings." | n/a |

## Memory page

Category "Memory": "Characters build memories through your conversations and keep them
across saves." No stored setting here: the memory service owns the data (player memory
file and bridge), the page only issues clear commands.

| Label | Type | Value shown | Description shown |
|---|---|---|---|
| Back to settings | action | Back | "Return to conversation settings." |
| Player memory | read-only | Shared across your saves | "Invited characters are prepared immediately. Natural memories are created when you actually talk to them. One player identity is shared across all saves and stays the same after forgetting. Current game context describes the world you have loaded." |
| Memory service | read-only | Ready / Unavailable | "Memories can be managed here." / "Reopen this page after the memory service reconnects. A pending clear keeps waiting for its own result." |
| Characters you have talked to | read-only | count, or "{count} · Last reported", or Unavailable | "Forget all memories applies to these characters. Visiting the catalogue or inviting a companion does not add anyone to this count." |
| Selected character | action | selected name or "Choose a character" | "Choose any character from the catalogue. They do not need to be in your current party." (opens the picker below) |
| Memory result | read-only (only when there is feedback) | feedback text | same text |
| Forget selected character | action | Forget | "Clear {name}'s memories about conversations with you. Review an inline confirmation first." or "Choose a character before clearing their memories about you." |
| Forget all memories | action | "Forget ({count} characters)" or Forget | "Clear memories about you for every character you have talked to. Your player identity is retained. Review an inline confirmation first." |
| Confirm memory clear / Confirm / Cancel | read-only + 2 actions (replace the two Forget rows while a request is open) | Confirm: "Forget memories"; Cancel: "Keep memories" | "Clear memories about you for all {count} characters you have talked to?" or "Clear {name}'s memories about conversations with you?" + "Your player identity stays the same. Matching Phone Chat messages and drafts are also cleared." |
| Phone Chat messages | read-only | Kept until forgotten | "Chat history stays available across game launches. Forgetting a character also clears their saved Chat messages and drafts. Forgetting all memories clears all saved chats." |

### Memory character picker (sub-page of Memory, title "Character memories")

Back to memory; "Choose a character" (read-only, "Page n / m", description "Search by
character name using Search settings. ... The character can be outside your current
party."); Previous characters / More characters (paging, 18 per page); one action row per
profile, label = name, value "Choose" or "Selected", description "Select {name} for
memory controls. This does not invite them or change their conversation settings."
Selection is held in memory only (`memorySelected`), not in settings.json.

## Relationships page

Category "Relationships": "Choose ordinary or romantic conversations for supported
characters." Status line first, then Back to settings.

| Label | Type | Default | Options | Description shown | Stored as |
|---|---|---|---|---|---|
| Judy Alvarez, Panam Palmer, River Ward, Kerry Eurodyne | select | **Auto**. manager.lua:329-330 (`'auto'`); mcm.lua:693-694 index 1; bridge `?? 'auto'` (relationship-routing.mjs:100, 179) | Auto; On; Off | "Auto follows the relationship in this save. On uses the romantic profile; Off uses the ordinary profile. This changes conversations without changing game choices." | `relationshipModes[<key>]` = `auto`/`on`/`off` |
| Meredith Stout | select | **Auto** (same sources) | Auto; On; Off | "Auto follows the completed encounter in this save. On uses the intimate profile; Off uses the ordinary profile. This does not imply an ongoing relationship." | `relationshipModes['meredith-stout']` |

The five keys are the fixed list at manager.lua:27-33.

## Current party page

No stored settings. Category "Current party" (and "Your group" while a driver trip is
active).

| Label | Type | Value | Description shown |
|---|---|---|---|
| Companion driver (only during a trip) | read-only | trip phase (Preparing to drive, Driver boarding, Waiting for you to board, Waiting for party to board, Starting trip, Driving, Stopping, Waiting for you to step out, Driver leaving the car, Stop requested) | "Ask a companion to drive to your selected map waypoint, then get into the passenger seat when they are ready." |
| Companion driver (only during a trip) | action | Stop trip | "Stop the trip after returning to gameplay. Wait for the car to stop, then step out before dismissing the driver." |
| {Name} #{n} (one row per copy) | action | Dismiss / Cancel invitation (for a not-yet-spawned copy: "{name} · invited copy") | "Remove only this copy from your group." plus any failure reason |
| Your party is empty (only when empty) | read-only | blank | "Invite someone from Characters or Model browser." |
| Back to Companion Manager | action | Back | "Return to Companion Manager." |

## Characters page

Category "Characters": "Search a character by name. Each invitation reserves a place and
starts preparation immediately." No stored settings.

| Label | Type | Value | Description shown |
|---|---|---|---|
| {character name} (79 rows) | action | Invite; "Add copy ({count})" when a copy is already in the party; "Profile only" (greyed) when no model record is known | "{profile summary}", then "Voice: {voice}", "Conversation: On/Off", then "Invitations create separate companion copies, including characters outside your phone contacts. Memory and connection preparation starts immediately; the copy joins when ready after you return to gameplay." The Voice line names the voice actually routed (Pocket TTS or an OmniVoice entry) or the Convai voice name (mcm.lua:267-283) |
| Back to Companion Manager | action | Back | "Return to Companion Manager." |

## Model browser page (on the Home page, not in your list)

Category "Installed character models". No stored settings.

| Label | Type | Value | Description shown |
|---|---|---|---|
| "{n} matching models" or "Reading installed models..." | read-only | "Page n / m" | "Search by character name or model record using Search settings." + scan error if any |
| Previous models / More models | action | Previous / Next | the search query (raw) |
| {model name} or "Unnamed model {n}" (18 per page) | action | Invite | "{game record id}", then "Conversation: {profile}" or "No conversation profile. This model joins as a follower without AI conversations.", then "Some game models have special rigs or roles and may not behave as ordinary companions." |
| Back to Companion Manager | action | Back | "Return to Companion Manager." |

## Help page

Back to settings (action). Three categories plus the log list. No stored settings.

| Category | Label | Type | Value | Description shown |
|---|---|---|---|---|
| If something goes wrong | What to do | read-only | Create a report | "If a character stops answering, voices stop or an error appears: open this page, choose Generate report, then send the file it names to the developer ..." (238 chars) |
| If something goes wrong | Conversation service | read-only | service state | "The conversation service runs beside the game. If it is not running, restart the game. Its logs are listed below." |
| Report for the developer | Generate report | action | Create (greyed while working) | "Save a report file you can send to the developer. API keys, tokens, IDs, microphone audio and conversation text are left out. ..." |
| Report for the developer | Last report | read-only | file name or "None yet" | "Saved at {path}" or "Choose Generate report. The file name and its folder appear here and in the banner above." |
| Report for the developer | Copy report path | action | Copy | "Copy the report path to the clipboard so you can paste it into a message." |
| Where the logs are | Mod logs; Conversation service logs; Launcher log; Cyber Engine Tweaks logs; Redscript log; RED4ext logs; Saved reports | read-only | file names (probe.log, mcm.log; bridge.stderr.log; launcher.log; cyber_engine_tweaks.log; redscript_rCURRENT.log; red4ext-*.log; convai-report-*.zip) | "... are in {path}" |

## Settings outside the Companion Manager page

- **CET hotkeys** (mod/init.lua:1541-1546), bound by the player in CET's own Bindings
  window, no default key: "Cyberpunk Convai: talk by text", "group text chat", "talk by
  voice", "group voice chat", "capture NPC diagnostic", "companion manager".
- **Interface language auto-detect** reads the game's on-screen language
  (ui-locale.lua:46-68); no row beyond the Settings select.

## Recent additions (state in the working tree)

| Addition | Where | Default | Commit / status |
|---|---|---|---|
| Six-entry companion voice menu (Pocket default; Omni 16/32 short/long; Convai) | Settings, Voices | Pocket TTS | f256d2b |
| Keep prepared voices | Settings, Voices | On | 9868a0a |
| Omni pack detection row and greyed-out Omni entries | Settings, Voices | n/a | f256d2b (entries are labelled, not disabled: Apply refuses them) |
| Auto-connect nearby characters | Settings, Conversations | Off | a655725 |
| Body gestures | Settings, Companion behavior | Off (On since 2026-10-11) | built, "Off by default until it is qualified in game" (docs/COMPANION_GESTURES.md:6) |
| Eye contact height; Head tracking strength | Settings, Companion behavior | Default; Gentle | committed |
| Subtitles; Subtitle display | Settings, Subtitles | On; Dialogue HUD | committed |
| React to battles; React to collected loot | Settings, Automatic reactions | On; On | committed |
| Developer mode | Settings, Development | Off | committed |
| Interface language | Settings, Interface | Automatic | committed |
| Natural speech (in progress) | not present | planned Off | **Not visible in the working tree at the time of this review.** `git status` shows only `mod/diagnostics.lua` modified and untracked lip-sync and input-test scripts; `grep` finds no `naturalSpeech` key, row or bridge reader. TODO.md (lines 23 and 92) says it is paused and "Not implemented"; the design is a dynamic-context block, off by default. Re-check before relying on this row. |

## Flags

Severity: **High** = a first-time player is likely to be confused or misled, **Med** =
worth fixing before release, **Low** = tidy-up. Text widths in MCM were not measured here
(no game run); truncation calls are based on character counts and should be confirmed
with `runtime/Invoke-McmStyleProbe.ps1` or in game.

### Labels and wording

1. **High. Companion voices menu is jargon.** "OmniVoice 16 steps · short reference"
   (36 characters) means nothing to a player: "steps" and "reference" are model-training
   terms, and four of the six entries differ only by those. With the pack missing each
   OmniVoice entry becomes e.g. "OmniVoice 16 steps · short reference · Requires the
   optional OmniVoice pack (GPU)" (about 80 characters; the translated locales are
   longer) and will very likely truncate in the selector. Fix: show three plain choices
   (Pocket TTS · recommended; OmniVoice · best quality (GPU); Convai cloud voice) and put
   the steps/reference variants behind Developer mode, or rename them by what the player
   hears ("OmniVoice · fast start" / "OmniVoice · closest match" and so on). Move the
   "requires the pack" text out of every entry into the OmniVoice pack row, or shorten it
   to " · needs pack".
2. **High. The Companion voices description is 919 characters** (mcm.lua:801) and holds
   benchmark claims ("by ear about 15-20% better ... 20-25% better ... within about
   5%", "first audio in about 0.15 s / 1.3 s / 1.45 s / 2.1 s / 2.5 s"). It will not fit
   the description pane without scrolling, the numbers are a personal listening result
   presented as fact, and they will go stale as the references and models change.
   Fix: cut to about three sentences (what each voice is, GPU needed for OmniVoice,
   fallback, Apply needed) and move the numbers to docs.
3. **Med. Voice-related labels collide.** "Voice playback" (on/off), "Companion voices"
   (which voice), "Keep prepared voices", "OmniVoice pack", "Voice service" read as one
   family. "Voice service" is a read-only status, and Help has "Conversation service" for
   a different process. Fix: rename "Voice service" to "Voice status" and "Voice playback"
   to "Spoken replies".
4. **Med. Head tracking labels are inconsistent.** "Less / Gentle (default) / More":
   "Gentle" is not the soft end, yet it sits between "Less" and "More", and the "(default)"
   is typed into the label while Eye contact height uses a plain "Default". Fix:
   Eyes only / Subtle / Normal / Strong, no "(default)" in the text (MCM's Defaults
   button and a marker already cover that), or use "(default)" on both selects.
5. **Med. Eye contact height description says "the point companions look at on V".**
   Reads as if V is a surface. Fix: "Raise or lower where companions look when they make
   eye contact with you."
6. **Med. Relationships use On / Off for a romance profile.** "On uses the romantic
   profile; Off uses the ordinary profile" needs the whole description to decode; "Off"
   sounds like "no conversation". Meredith Stout's rows say "intimate profile" instead of
   "romantic" (different wording for the same control). Fix: options Auto / Romantic /
   Ordinary (Meredith: Auto / Casual / Ordinary), and say what Auto looks at once.
7. **Med. Three near-identical page names.** "Characters" (invite), "Character
   conversations" (who may talk), "Character memories" (memory picker), plus the "Character
   conversations" row sits in a category called "Conversations". Fix: rename the toggle
   page "Who can talk" (or "Allowed to talk") and keep "Characters" for inviting.
8. **Med. "Dialogue HUD" is jargon, and the default is the second option.** Options read
   "Above speaker / Dialogue HUD" with the default second. Fix: "Game dialogue box" first
   (default), "Above the speaker" second.
9. **Low. "Auto-connect nearby characters"**: the player does not know what is being
   connected to. Fix: "Get nearby characters ready to talk" with the current description.
10. **Low. Category "Subtitles" contains a row "Subtitles"**; "Voices" repeats "Changes
    wait until you choose Apply" that already heads the page and sits in the Voice
    service row. Remove the duplicates.
11. **Low. Description phrases that mean little to a player**: "in their usual stance"
    (Body gestures), "Loading a save resets the cooldown" (React to battles), "Memory and
    connection preparation starts immediately" (every Characters row), "hidden warm-up"
    and "Turn this off to save nothing on disk" (Keep prepared voices; "small file" is
    5 to 15 MB each).

### Defaults that look wrong or deserve a decision for a first-time player

12. **Med. Body gestures is Off and is a shipped, visible setting for an unqualified
    feature.** The doc says "Off by default until it is qualified in game." If it is
    not good enough to turn on, label it "(experimental)" or hide it until it is; if it
    is, a feature that sets the mod apart is invisible to most players.
13. **Med. Auto-connect nearby characters is Off.** The cost is a visible wait the first
    time a player talks to each character (the wait notice mentions the setting only
    twice per session, auto-connect.lua `hintLimit`). Reasonable for resource safety;
    flag as a trade-off, not a bug (question 2).
14. **Med. Keep prepared voices is On and writes about 5 to 15 MB per summoned character
    to `runtime/`.** With 79 characters that can approach a gigabyte over time, and
    nothing in the UI shows or clears the total. Fix: add a total or a "Clear prepared
    voices" action, or default Off for a first release.
15. **Low. React to battles and React to collected loot are On.** Sensible for a
    companion mod; no change proposed, but loot comments are the likelier annoyance.
16. **Low. Pocket TTS "recommended" default depends on the Pocket model shipping in the
    package.** Confirm the release plan includes it, otherwise a fresh install silently
    falls to Convai (question 4).

### Dead, vestigial and duplicate options

17. **Med. `followUpQuestions` is a dead setting.** It has no row, defaults to false
    (manager.lua:333), is accepted by `applyBatch` (mcm.lua:933) and `applySettings`
    (manager.lua:995), is included in the snapshot (manager.lua:946) and is sent to the
    bridge on every request (init.lua:247, 937; phone-chat.lua:463). The project decision
    is "Follow-ups are free (no forced questions)". It can never be turned on by a
    player. Fix: remove the key end to end, or restore a row (question 5).
18. **Low. Legacy six-entry `enabled` array** in `settings.json` (manager.lua:370-371)
    and per-index `ConvaiManagerSetEnabled` calls (manager.lua:1054-1056) exist only for
    the old redscript manager, which knows six characters. Everything now keys on
    `enabledByKey`. Keep only if redscript still reads it.
19. **Low. The retired HUD manager's "settings" tab** still builds Voice playback and
    Subtitles entries (manager.lua:735-743). docs/MANAGER_UI.md says that HUD no longer
    opens. Dead code with a second copy of two labels.
20. **Low. The pack-missing OmniVoice entries are selectable but cannot be applied.** A
    select cannot grey an option, so the player picks one and gets an error on Apply
    ("Requires the optional OmniVoice pack (GPU)"). Acceptable, but it is a dead-end
    choice; hiding the entries while the pack is missing (the service has reported fresh
    status) would be cleaner.
21. **Low. `bridge/pocket-voice.mjs:53` constructor default `keepPreparedVoices = false`**
    differs from the product default On. No effect today (`VoiceSelection` always passes
    its own value, voice-selection.mjs:58, 316) but a direct construction would silently
    behave as Off. The Lua and bridge defaults otherwise agree everywhere I checked:
    provider `pocket`, steps 16, reference `long`, keep-prepared true, playback true,
    relationships `auto`.

### Dependencies not reflected in the UI

22. **Med. "Subtitle display" stays active when Subtitles is Off,** and "Keep prepared
    voices" stays active when the voice is Convai or Voice playback is Off. MCM has no
    greyed state for a select, so say it in the description (the Subtitle display
    description already says the Subtitles switch controls both) or hide the dependent
    row.
23. **Low. Auto-connect, Body gestures and the reactions silently depend on a companion
    being present / speaking**; nothing says so. No fix needed beyond wording.

### Text length and truncation risk (not measured)

24. Long descriptions: Companion voices 919; Keep prepared voices 333; React to
    collected loot 332; Auto-connect 238; Help "What to do" 238; Developer mode 222;
    Body gestures 208; Player memory 247; Characters rows about 205 plus a profile summary
    that can be several hundred (profile summaries are multi-paragraph in roster.json, so
    the Characters description pane is the one most likely to overflow).
25. Long values: "Ready · Using Pocket TTS, OmniVoice 16 steps · long reference unavailable"
    (about 70 characters) is the Voice service value and the status line while a fallback
    is active; "Forget (79 characters)" is fine. Translated strings in de, ru and fr run
    longer. Check the Voice service value and the pack-missing select entries first.

### Settings a normal player should not see (suggest Developer mode only)

26. **High. "Model browser" on the Home page.** It lists every game character record
    ("Unnamed model 17"), invites them without AI conversations, and warns "Some game
    models have special rigs or roles and may not behave as ordinary companions." Move
    behind Developer mode, or rename "Advanced: all game models".
27. **Med. The four OmniVoice 16/32 steps and short/long reference entries** (see flag
    1).
28. **Med. The CET hotkey "Cyberpunk Convai: capture NPC diagnostic"** appears in every
    player's CET Bindings window. Hotkeys register at load, so it cannot be hidden, but
    it could do nothing (or show a note) unless Developer mode is on, and be renamed
    "(developer) capture NPC diagnostic".
29. **Low. Help, "Where the logs are"** (seven read-only rows of log paths). Useful for
    support, but a normal player needs only Generate report and Copy report path. Fine to
    keep as is; consider collapsing it.
30. **Low. Developer mode does more than its description says.** It also turns on the
    movement trace file (`runtime/movement-trace.ndjson`, init.lua:1816), gesture logging
    (init.lua:478-481), gameplay-action result popups (gameplay-actions.lua:119) and the
    "report ready" popup (support-report.lua:359). A player turning it on to see popups
    also starts writing a growing trace file. Fix: say so in the description, or split
    "Routine popups" from "Diagnostic logging".

### Stale documentation (found while verifying)

31. **Med. README.md lines 46 and 199, docs/MANAGER_UI.md:31-33 and docs/LOCAL_VOICES.md
    lines 138 and 267** still describe four voice choices with "OmniVoice 16 steps
    (default)". The code now has six choices and Pocket TTS is the default
    (manager.lua:21; voice-preview.lua:12-19). docs/MANAGER_UI.md also omits Keep prepared
    voices, Body gestures and Eye contact/Head tracking. Not changed here (read-only
    task).

## Questions for you

1. **Voice menu.** Collapse the four OmniVoice entries into one "OmniVoice · best quality
   (GPU)" for normal players (steps and reference choosable in Developer mode), or keep
   all six visible with friendlier names? And which default quality does the single
   OmniVoice entry map to (16 steps, long reference is the current migration default)?
2. **Auto-connect nearby characters.** Keep Off by default (no wait-hiding, less
   memory), or turn On so the first conversation is quick?
3. **Body gestures.** Hide it, label it experimental, or ship it On/Off as is until
   qualified in game?
4. **Is the Pocket TTS model and its references in the release package?** If not, the
   "recommended" default will fall back to Convai on a fresh install.
5. **Follow-up questions.** Remove the dead `followUpQuestions` plumbing, or bring back
   a player-facing row (default Off)?
6. **Model browser.** Move behind Developer mode, or keep as a visible "advanced" page?
7. **Keep prepared voices.** Keep default On with a disk total and a clear action, or
   default Off?
8. **Relationships wording.** Rename On/Off to Romantic/Ordinary (and Casual for Meredith)?
9. **Developer mode split.** Split "Routine popups" and "Diagnostic logging", or keep one
   switch and just describe it fully?
10. **Natural speech (in progress).** Not in the tree yet. When it lands, should it sit
    under Voices, and should it hide when the voice is Pocket (where, per your listening
    verdict, fillers do not work)?

## Decisions applied (2026-10-07)

The user answered the questions above and the Companion Manager now follows them. Internal
saved values did not change (`voiceProvider`, `omniSteps`, `omniReference`,
`relationshipModes`, `headFollowStrength`), so existing `runtime/settings.json` files load
as before. The tables above describe the code before this change.

- **Voice menu (flags 1, 3 and 27, question 1):** six entries, fastest to best: "Pocket ·
  Performance" (the default, no "recommended" tag), "OmniVoice · Balanced" (16 steps, short reference),
  "OmniVoice · Quality" (16, long), "OmniVoice · High Quality" (32, short), "OmniVoice ·
  Ultra Quality" (32, long), "Convai · Cloud voice". Without the Omni pack the four OmniVoice
  entries end in "· needs Omni pack" (longest entry 43 characters; the old text was about 80);
  Apply still refuses them with the full message. Status lines, fallback notices and the
  Characters "Voice:" line use the same names.
- **Voice description (flag 2):** three sentences. Pocket is light and fast on the CPU and
  starts in about 0.2 s (no "recommended" wording); OmniVoice sounds better, especially on harder voices, needs a capable
  GPU and the optional pack, and the higher tiers take longer to start (about 1 to 2.5 s);
  Convai uses the cloud and a choice that cannot run falls to a simpler voice with one notice.
  No listening percentages (they remain in `docs/LOCAL_VOICES.md`).
- **Model browser (flag 26, question 6):** still visible to everyone. Its Home row and page
  now say it lists every game character model and that characters without conversation
  support join as followers and do not talk.
- **Body gestures (flag 12, question 3):** labelled "Body gestures (experimental)", still Off.
- **Auto-connect (question 2, reversed later the same day):** now On by default and silent. A
  missing key defaults On and an explicit saved value is kept (an existing file that holds
  `autoConnectNearby: false`, written by the old default, stays Off). No connecting or ready
  notice for a warm-up and no hint about the setting; with the setting Off the short "Preparing
  connection to {name}…" wait notice remains, without the hint. **Keep prepared voices
  (question 7):** unchanged (On). Question 4 (Pocket model in the release package) was not part of this change and is still to
  be confirmed.
- **Relationships (flag 6, question 8):** the select reads Auto / Romantic / Ordinary;
  Meredith Stout reads Auto / Casual / Ordinary (her routing kind is `casual-intimacy` in
  `bridge/relationship-routing.mjs`). Descriptions say the same words; values stay
  `auto`/`on`/`off`.
- **`followUpQuestions` (flag 17, question 5):** removed end to end. Before removal, nothing
  read it for behaviour: it only travelled in requests and request identities, and
  `followUpContext` never used it. An old key in the settings file is dropped on load; the
  bridge ignores the field if an older adapter still sends it.
- **Developer mode (flag 30, question 9):** one switch; the description lists routine popups,
  the movement trace file, gesture logging and the setting appearing in support reports.
- **Head tracking (flag 4):** Eyes only / Subtle / Gentle (default) / Strong (values 0, 0.5,
  1, 1.5).
- **Page names (flag 7):** left as they were in the first round; the second round renames
  "Character conversations" to "Who can talk". Characters and Character memories keep their names.
- **Not changed in the first round (several were done in the second round below):** flags 3 (the
  Voice playback rename), 9, 10, 11, 14, 18 to 25 and 29 (duplicates, jargon in smaller
  descriptions, prepared-voice disk total, legacy `enabled` array, HUD manager copy,
  dependency hints, log rows).
- **Docs:** README.md, docs/MANAGER_UI.md, docs/LOCAL_VOICES.md and docs/POCKET_TTS_RUNTIME.md
  describe the six-entry menu with Pocket as the default (flag 31).

### Second round (same day)

- **Wording and names:** Eye contact height reads "Raise or lower where companions look when they
  make eye contact with you." (flag 5). "Voice service" is now "Voice status" (flag 3, only that
  rename). Subtitle display options are "Cinematic subtitles" (stored `dialogue`, default, first)
  and "Above the speaker" (stored `overhead`, second); the select index is mapped from the saved
  string in both directions (flag 8). The "Character conversations" row and page are "Who can talk"
  (flag 7), description unchanged in meaning.
- **CET hotkey (flag 28):** "Cyberpunk Convai: capture NPC diagnostic" is no longer registered.
  The `runtime/diagnostic-request.txt` poll in `mod/init.lua` is independent of the hotkey and
  still runs the capture and writes `runtime/diagnostic-response.txt`. `mod/diagnostics.lua` was
  not touched. A saved CET binding for the old hotkey simply disappears.
- **Notice audit:** see the table in the report of that session and the Captain's log entry in
  TODO.md. Changes: auto-connect notices removed; the phone dismissal confirmation is
  Developer-only. Already gated and left alone: the support-report "saved" popup (Developer mode
  only), routine party and driving popups, gameplay-action acknowledgements.

### Third round (2026-10-14)

- **Page names (flag 7, finished):** "Character conversations" was already "Who can talk". The two remaining names that
  sounded alike are now **Characters to invite** (the invite list, formerly "Characters"; the home button and the page
  title) and **Whose memories** (the memory character picker, formerly "Character memories"). The Companion Manager panel
  in the game's own UI (`Manager.reds`, the CHARACTERS tab) keeps its name. New strings are in all 15 locales.
- **Prepared voices (flag 14, question 7):** Settings > Voices now has **Prepared voices on disk** (total size and number of
  saved files, asked of the bridge once when Settings opens) and **Clear prepared voices** (opens its own page: Confirm or
  Cancel). Keep prepared voices stays On. See `docs/LOCAL_VOICES.md`.

## Note, 2026-10-11: launch defaults

Three settings that this review lists as Off by default are On by default for launch: **Expressive emotions**
(`expressiveEmotions`), **Follow-up questions** (`followUpInterest`; the retired `followUpQuestions` key is still dropped) and
**Body gestures (experimental)** (`bodyGestures`). A default applies only when the key is missing from
`runtime/settings.json`; a player's saved choice is kept.

- `loadSettings` (`mod/manager.lua`) sets the three defaults to On. The one exception: a missing `expressiveEmotions` key
  beside an explicitly saved Convai cloud voice defaults to Off, so a default never moves a voice the player chose. A new
  install (no file) therefore ends on Pocket with all three On, with no voice switch, notice or feedback on first load.
- With Multilingual conversations on, the existing rule is unchanged: with the cloud voice the tag settings are dropped
  (Expressive emotions off); with an OmniVoice choice Expressive emotions stays on.
- Superseded later on 2026-10-11: choosing the Convai cloud voice in Settings now keeps the voice and turns Expressive emotions
  (and Natural speech) off, with one notice only if the player had set one of them (docs/MANAGER_UI.md, "Cloud voice and the tag
  settings"). Turning Expressive emotions on beside a saved cloud voice still moves the voice to Pocket TTS with the notice
  ("Expressive emotions need a local voice..."). A missing key beside a saved cloud voice still defaults to Off.
- The bridge (`bridge/expressive-emotions.mjs`, `bridge/follow-up.mjs`) treats a missing key as On (only a saved `false`
  turns it off), so it agrees with Lua before the Lua side has rewritten the file.
- The settings page (`mod/mcm.lua`) marks the three as default On (reset to default turns them On). The descriptions of Expressive
  emotions and Follow-up questions end "On by default." (15 locales updated: the last sentence of each translation, and the
  string key). Natural speech, Multilingual conversations and the other Off-by-default settings are unchanged.
- Packaging ships no settings file, so nothing there carries these keys.
