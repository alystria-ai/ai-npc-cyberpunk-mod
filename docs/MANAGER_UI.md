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
gameplay; paused spawn timers do not advance. Closing this menu returns to the
normal pause menu, whose Resume/Escape action returns to gameplay.

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
90 checks. Fresh Johnny invitation, save reload, model search, settings apply/revert and repeated
close/reopen still need acceptance.

The local manager binding remains F4. The distributed action name still mentions
F5 as its reference default; the game's QuickSave mapping was not altered.

The one-shot `mcm-state:<nonce>` diagnostic writes `runtime/mcm-state.json`
inside the installed mod. It reports the section, entry stage, party, feedback
and API availability without opening a menu or creating a companion.
