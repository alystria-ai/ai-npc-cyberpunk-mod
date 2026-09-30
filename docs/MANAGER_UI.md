# Companion Manager in MCM

The manager uses **Mod Configuration Menu 0.10.3 / API v2**, inside the game's
native settings host. The user rejected the earlier HUD popup and suggested
MCM. Its source remains for compatibility, but F5 and the manager diagnostic
no longer open it.

## Player flow

- **Manager shortcut (currently F4 locally):** requests the real pause menu's MCM entry and selects **Companion
  Manager**. **Esc → MCM → Companion Manager** is also available.
- **Characters:** searchable researched profiles, including Johnny Silverhand
  and Adam Smasher, with Invite / Add copy actions for available models.
  This catalogue is independent of phone contacts and quest unlocks.
- **Current party:** each actual or invited copy has its own state, conversation
  profile action and dismissal. Invitations can be cancelled before spawning;
  pending dismissals can be undone if their places have not been reused.
- **Model browser:** discovers installed Character records in batches of 48,
  shows at most 18 model results per page and searches the full discovered
  catalogue by name or record. Use MCM's **Search settings** field. Models without
  a researched identity can be assigned one through Current party.
- **Settings:** voice playback, native dialogue subtitles, OmniVoice 16/32
  generation steps (32 by default), service readiness and per-character
  conversation participation. MCM owns Apply, Revert, defaults and draft guards.

Invitations and dismissals are queued while the page pauses gameplay. Their
pending state appears immediately. They run once after the player returns to
gameplay; paused spawn timers do not advance. Closing Companion Manager now
returns to gameplay. The adapter waits for native Settings to accept the close
and detach, then activates the real pause-menu Resume item once. MCM retains
its unsaved-settings prompt; cancelling that prompt stays in Settings. Other
providers and native settings retain their own exit behavior.

## Ownership

- `mod/mcm.lua`: provider `cyberpunk-convai`, mod `manager`, registered through
  `GetMod('ModConfigurationMenuAPI').providers.registerProvider`. Produces the
  native schema and extends content search to the model catalogue. MCM files
  and preferences are never edited.
- `mod/mcm-entry.lua`: F5 entry state machine. Activates the real
  `OnSwitchToMCM` item after the pause host is established, then invokes the
  actual sidebar action observed for Companion Manager. No simulated keys.
  Pause/input ownership stays with MCM and vanilla. A bounded timeout leaves
  the player in a working menu.
- `mod/manager-party.lua`: in-memory queue with distinct copy IDs and capacity
  reservations. The companion system rechecks capacity at execution. Deletions
  precede spawns. Accepted requests are tracked through attachment; ready/failure
  notices appear once in gameplay and remain in the manager feedback row.
  Failures are reported and never retried every frame.
  Player/save changes and CET shutdown discard pending requests.
- `mod/manager.lua`: shared catalogue, settings storage, discovery and native
  playback flags. Settings are validated and saved as one transaction before
  their values are exposed; a failed save leaves playback unchanged.
- `mod/companions.lua`: owns actual entities, copy serials, formation slots and
  connection membership. Manager operations never adopt quest/ambient actors.

MCM updates run outside the game-time poll so the page stays interactive when
simulation delta is zero. World changes and follower updates wait for unpaused
gameplay. Schema refresh waits while MCM has unsaved drafts. Discovery is lazy,
and file-backed readiness checks are throttled.

The native MCM action banner is scoped to this provider's page: invitation and
dismissal actions describe their queued work instead of the stock "Completed"
text. Other providers and failure messages retain MCM's ordinary rendering.
No MCM source or saved preferences are modified.

## Uniform settings labels — September 30

Companion Manager uses one left edge and MCM's default red label colour
(`MainColors.Red`) across section names, actions, read-only rows, toggles and selectors.
Section names remain in the schema for organization and searching; their native
category template and separators are retained. Controls, selected/disabled values, hover
feedback and unsaved-change markers keep their native behaviour.

The differing indentation came from the installed renderer: managed controls
reserve a marker gutter and start their text at 48 units, actions start at 20,
and read-only rows add a list-label inset inside a surface at 20. The adapter
normalizes only its own rendered rows to 20 units, preserves the label's right
edge, and keeps draft markers in the outer gutter. Scaled category labels are
aligned using their cumulative parent scale. Resting labels bind to the native
red token; cyan option controls and MCM's global theme are not modified.

The first installed attempt was ineffective: the real renderer calls
`McmUiBegin` with a provisional title, creates the rows, then publishes
`McmUiSetContentTitle`. The live probe confirmed x=48 managed labels, x=24
read-only labels and purple saved nondefault labels after that attempt.
The final-title boundary now queues styling, with both exact title and active
provider ownership checked. Begin clears ownership, including on MCM's global
routes that retain the prior selected-mod key. Top-level `onUpdate` performs one
bounded content lookup and one direct-child map; no widget lookup or setter runs
inside a native observer. Hover-out queues another pass for the same controller;
current hover highlights and cyan value controls are retained.

The row-lifecycle harness covers the real provisional-title/rows/final-title/
update order, rejects widget access inside native observers, and rejects more
than one root lookup per pass. It also covers scaled headings, row shapes,
hover/restyling, draft markers, cyan values and leaving other providers alone.
This checks the adapter and scoping; visual acceptance still requires opening
the installed manager in game after CET reload.

The exit adapter also uses the final title and provider ownership. A close
request alone does not resume gameplay: the same settings controller must
actually detach. Reset, another Settings screen, a new world or a bounded
timeout cancels pending resume. Nine focused lifecycle checks cover these
paths; actual Escape and draft-modal behavior still need the in-game check.

### Native crash and correction

The first final-title implementation (`4fe8a9b`) crashed on F4 after CET reload.
It was reverted in `c6ef43b`, installed and relaunched; the user confirmed the
previous manager opens normally. The separate close-approach correction remains.

The September 30 13:37 crash dump shows a reflected value constructor writing
through a null destination (`Cyberpunk2077.exe+0x149340`, called from CET).
[CET's RTTI executor](https://raw.githubusercontent.com/maximegmd/CyberEngineTweaks/v1.37.1/src/reverse/RTTIHelper.cpp)
uses a 1 MiB scratch allocator shared by nested calls; its return construction
does not check for failed allocation. The
[allocator implementation](https://raw.githubusercontent.com/tiltedphoques/TiltedCore/v0.2.7/Code/core/src/ScratchAllocator.cpp)
returns null when full and frees its space only at Reset. Repeated per-row tree
walks inside the final-title observer fit that failure mechanism. The corrected
version defers all widget operations and removes the repeated walks. Thirty-seven
focused manager/exit checks, including installed MCM integration, pass; a live
menu check is still required because Lua fixtures cannot emulate CET's allocator.

The existing native voice/subtitle and legacy enabled flags remain compatible.
No new redscript is required: **CET Reload All Mods** activates the adapter with
the installed dependencies. The separate dry-emitter change remains staged.

## Verification — September 28

All **72 automated checks passed**, including the installed MCM 0.10.3 API's
real core/catalogue/draft/action modules executed in a local Lua harness.
The integration gate covers registration, dynamic schemas, queued actions,
rejection of actions with drafts, multi-setting apply and readback. It does
not modify MCM's installed data files.

Set `CYBERPUNK_MCM_API` to the installed `ModConfigurationMenuAPI` directory
before `npm test` to include that local gate. Without it, ordinary tests still
run and the installed-API check is explicitly skipped.

Lua and catalogues were installed and SHA-256 verified; the previous installed
Lua is in ignored `backups/mcm-lua-20260928-163622/`. The user reloaded CET and
confirmed the manager appears in MCM. Their screenshots show the native
Characters, empty Current party and Settings pages, including Invite controls
and the 32-step default. The controller-readiness and runtime CName lookup
fixes are installed. On September 29 the user confirmed **F4 opened the menu**
and Iris joined through Invite. Johnny's apparently absent model was traced to
his native phantom visibility controller; the user confirmed the live repair.
The initial floor concern and crash after V died prompted the work in
[COMPANION_BEHAVIOR.md](COMPANION_BEHAVIOR.md). The latest combined suite passes
90 checks. The user then reloaded CET and confirmed a fresh Johnny is visible
and the post-join confirmation appears. Save reload, model search, settings
apply/revert and repeated close/reopen still need acceptance.

The local manager binding remains F4. The distributed action name still mentions
F5 as its reference default; the game's QuickSave mapping was not altered.

The one-shot `mcm-state:<nonce>` diagnostic writes `runtime/mcm-state.json`
inside the installed mod. It reports the section, entry stage, party, feedback
and API availability without opening a menu or creating a companion.
