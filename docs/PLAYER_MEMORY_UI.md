# Player memory in Companion Manager

**Companion Manager → Settings → Memory → Manage** opens its own page through the
native MCM API v2 provider. Invited characters are prepared immediately with the
player identity and current world context. Natural memories are created when the
player actually talks to them and are retained across saves. One player identity
is shared across all saves and stays the same after either Forget action. Its raw
ID is never included in the page.

## Player controls

Settings groups controls under **Conversations**, **Voices**, **Subtitles**,
**Automatic reactions**, and **Phone messages**. Conversations offers separate
**Manage** actions for Who can talk (formerly "Character conversations") and Memory. Voice playback,
provider, quality and service status appear together; the simple switches remain
on the Settings page.

Memory has its own picker (the page is titled "Whose memories"; it was "Character memories" until 2026-10-14), status, Forget controls and inline confirmation rows.
**Back to settings** returns from Memory or Who can talk to Settings.
Settings stays selected in the navigation while either page or the memory picker
is open.

- **Selected character** opens a searchable catalogue picker, with at most 18
  character results per page. A character can be selected without inviting them,
  spawning a copy, unlocking a phone contact, or changing a conversation setting.
  Choosing a character or using **Back to memory** returns to the Memory page.
  Backing out without choosing keeps the current selection and shows "Character
  picker closed. Your selection is unchanged. Closing it deleted nothing." as the
  action result and in **Memory result**. Only the action result is shown while an
  earlier clear's own status is on the page, so a pending or failed result is
  never hidden.
- **Forget selected character** clears the selected character's memories about
  conversations with this player. The character does not have to be spawned.
  When the bridge supplies its talked-to registry, characters without an actual
  conversation remain selectable but have no enabled clear action.
- **Forget all memories** uses the bridge's count of characters this player has
  talked to. Catalogue size, phone contacts and party size do not determine it.
  The confirmation names that count; if it changes before Confirm, the request
  must be reviewed again.
- **Confirm** and **Cancel** appear inline after choosing a Forget action. The
  first activation sends nothing. Confirm publishes one command, removes its
  confirmation, and shows pending feedback. Cancel publishes no command and shows
  "Memory clear cancelled. Nothing was deleted." until the next action; choosing
  Forget again clears that note.
- **Memory result** shows pending, confirmed or failed feedback for the exact
  submitted request. New clears stay disabled while an outcome is pending.

MCM's ordinary draft guard applies: changed conversation settings must be saved
or discarded before running actions. Selecting a memory character uses an action,
so it creates no settings draft and writes no player identity or character choice
into `settings.json`.

Phone Chat history and drafts persist across game launches. A successful
**Forget selected character** clears that character's corresponding Chat messages
and draft; a successful **Forget all memories** clears all saved Chat messages
and drafts. Cancel and failed or uncertain clears retain them. The Disappearing
messages setting has been removed.

## Invitation preparation

Inviting a character reserves a place in the party (which has no size limit) and starts preparation
while the menu is open. The companion count includes those reservations.
The manager banner shows no progress text while an invitation prepares; a failed
preparation does appear there. **Current party** lists each pending copy as a single row with **Cancel
invitation**; it shows no per-copy status text. A failed preparation puts its
error in that row's description and a line beneath it.

**Ready to join** means preparation is complete. The copy enters the world after
gameplay resumes and reports that it joined only after the actor is usable. Accepting an invitation
does not count as a conversation or create natural memories about the player.

MCM receives the optional readiness object as the fifth argument to
`configure(domain, companions, queueFactory, entryFactory, readiness)`. Its public
`party()` returns the same reservation queue used by native actions and phone
invitations. Only the gameplay call to that queue's `flush()` creates actors.

## Bridge contract

Lua publishes `runtime/memory-command.json` only after explicit confirmation:

```json
{
  "version": 1,
  "id": "c837d15a-257d-467a-b124-68f5c6981ff2:1",
  "action": "clear",
  "scope": "character",
  "profileKey": "judy-alvarez",
  "issuedAt": 1800000000000
}
```

The ID contains the UI session UUID and a command counter. The counter is
continued from a retained command after a Lua reload. `profileKey` is an exact
roster key. All-scope commands use `"scope": "all"` and omit `profileKey`.
Commands have no user-ID or identity-rotation field.

The bridge publishes `runtime/memory-status.json`:

```json
{
  "version": 1,
  "updated": 1800000001000,
  "state": "ready",
  "talkedToCount": 2,
  "characters": [
    {"profileKey": "judy-alvarez"},
    {"profileKey": "johnny-silverhand"}
  ],
  "command": {
    "id": "c837d15a-257d-467a-b124-68f5c6981ff2:1",
    "scope": "character",
    "profileKey": "judy-alvarez",
    "state": "succeeded"
  }
}
```

Top-level states are `ready` and `unavailable`. `talkedToCount` is a nonnegative
integer. Optional `characters` contains the talked-to registry, not the entire
catalogue. Command states are `pending`, `succeeded` and `failed`; `message` is
optional. The UI uses its own feedback text so provider errors and raw IDs do not
reach the page.

A ready status must be no more than 15 seconds old and no more than five seconds
in the future to enable another clear. Polling and schema refresh continue while
MCM pauses game time. Refresh waits while ordinary MCM drafts are pending.

Completion is accepted only when command ID, scope and optional exact profile key
all match, and `updated` is at least the request's `issuedAt`. A matching terminal
result remains evidence if the bridge later stops; new actions require a fresh
ready status. An unrelated or late result cannot complete a later request.

## Reset and recovery behavior

`mod/manager.lua` owns command publication and pending state. `mod/mcm.lua` owns
the native rows and catalogue picker. Save/manager resets cancel an unissued
confirmation and retain an already accepted clear. A full Lua reload reads the
retained command and waits for its matching result. It does not send that command
again or turn a timeout into success.

Publication writes a temporary file, closes it, preserves the previous target,
then renames the complete file into place. Failure restores the previous target.
Lua can recover `.previous` if publication was interrupted while the target was
absent. A corrupt retained request disables clear controls instead of submitting
replacement work. The bridge should retain the latest command file and its
matching durable outcome after processing it.

The UI does not perform remote deletion, retry uncertain provider work, or claim
an extraction flush guarantee. A confirmed result means the bridge reported its
clear operation as succeeded. Provider extraction can be asynchronous; the bridge
owns its observable readback and recovery policy. A failed result allows another
request only through a fresh, deliberate confirmation.

## Verification and live reload

On September 30, all **26 checks passed** in `bridge/manager.test.mjs`, including
the installed MCM API's real core/catalogue/draft/action modules executed in the
local Lua fixture. Those checks cover unspawned catalogue selection, contacted
counts, inline cancellation, double activation, exact result matching, late
status, service loss, save and Lua resets, failed publication and backup recovery.
They also cover Memory submenu navigation, picker and parent returns, selected
Settings navigation, retained confirmation, and Apply/Revert across the grouped
settings. The installed framework rejects submenu navigation while drafts remain.
Existing party, playback, model scanning and owned-companion checks also pass.
Invitation checks exercise the actual reservation queue with deferred readiness,
including preparing and connecting labels, reassignment, failure and cancellation,
paused readiness and actor attachment. The installed framework also accepts those
readiness rows and actions alongside the grouped settings and memory controls.
The fixture does not write the installed MCM data directory or call production
memory APIs.

To repeat the focused check in PowerShell:

```powershell
$env:CYBERPUNK_MCM_API = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\ModConfigurationMenuAPI'
node --test bridge/manager.test.mjs
```

The earlier memory-controls build was installed and hash verified on September 30,
and the bridge published a fresh ready Memory status with zero
contacted characters before the first actual message. Cyberpunk was closed and
then launched. The Memory submenu and Settings grouping described here have been
verified in the local framework fixture and installed in `9290ab3`, with file
hashes checked and Cyberpunk launched. The user subsequently confirmed that
Memory opens on its own page and Back to settings returns to the organized
settings page. Lua-only changes can use
**CET Reload All Mods**; this page adds no native script or save component.

In-game acceptance should open **Settings → Memory → Manage**, choose an unspawned
catalogue character, open and cancel a confirmation, and check the bridge count
and availability feedback. Verify **Back to memory** from the picker and
**Back to settings** from both Memory and Who can talk. Both the
picker back-out and a cancelled confirmation should say that nothing was deleted
(`bridge/manager.test.mjs` asserts the text, the absence of any command file and
that no file is removed). A real
destructive Forget check requires the user's explicit choice of target.
The broader clear-confirmation, picker and reload/save checks remain covered by
source/framework tests; the user has not performed a destructive Forget check.
