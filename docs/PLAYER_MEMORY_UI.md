# Player memory in Companion Manager

**Companion Manager → Settings → Memory** uses the existing native MCM API v2
provider. It explains that characters build memories through actual conversations
with the player and retain those memories across saves. The player identity stays
the same after either Forget action. Its raw ID is never included in the page.

## Player controls

- **Selected character** opens a searchable catalogue picker, with at most 18
  character results per page. A character can be selected without inviting them,
  spawning a copy, unlocking a phone contact, or changing a conversation setting.
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
  confirmation, and shows pending feedback. Cancel publishes no command.
- **Memory result** shows pending, confirmed or failed feedback for the exact
  submitted request. New clears stay disabled while an outcome is pending.

MCM's ordinary draft guard applies: changed conversation settings must be applied
or reverted before running actions. Selecting a memory character uses an action,
so it creates no settings draft and writes no player identity or character choice
into `settings.json`.

**Phone Chat messages** are a separate control. **Disappearing messages** clears
the local Chat history and drafts at the next game launch. Forget actions clear
character memories about the player; saved Chat messages remain available.

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

On September 30, all **24 checks passed** in `bridge/manager.test.mjs`, including
the installed MCM API's real core/catalogue/draft/action modules executed in the
local Lua fixture. Those checks cover unspawned catalogue selection, contacted
counts, inline cancellation, double activation, exact result matching, late
status, service loss, save and Lua resets, failed publication and backup recovery.
Existing party, playback, model scanning and owned-companion checks also pass.
The fixture does not write the installed MCM data directory or call production
memory APIs.

To repeat the focused check in PowerShell:

```powershell
$env:CYBERPUNK_MCM_API = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\ModConfigurationMenuAPI'
node --test bridge/manager.test.mjs
```

The updated Lua files and catalogues were installed and hash verified on
September 30, and the bridge published a fresh ready Memory status with zero
contacted characters before the first actual message. Cyberpunk was closed and
then launched, so this launch requires no CET reload. Future Lua-only changes
can use **CET Reload All Mods**; this page adds no native script or save component.

In-game acceptance should inspect **Settings → Memory**, choose an unspawned
catalogue character, open and cancel a confirmation, and check the bridge count
and availability feedback. A real destructive Forget check requires the user's
explicit choice of target. Reload/save behavior and the rendered native page have
not been accepted in game by these source/framework checks.
