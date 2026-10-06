# Companion Manager in MCM

The manager uses **Mod Configuration Menu 0.10.3 / API v2**, inside the game's
native settings host. The user rejected the earlier HUD popup and suggested
MCM. Its source remains for compatibility, but the manager shortcut and diagnostic
no longer open it.

## Player flow

- **Manager shortcut (currently F4 locally):** requests the real pause menu's MCM entry and selects **Companion
  Manager**. **Esc → MCM → Companion Manager** is also available.
- **Home:** four destination actions open Characters, Current party, Model browser
  and Settings. The destination list appears only on this home page.
- **Characters:** searchable researched profiles, including Johnny Silverhand
  and Adam Smasher, with Invite / Add copy actions for available models.
  This catalogue is independent of phone contacts and quest unlocks.
- **Current party:** one row per actual or invited copy, "Name #number" with
  **Dismiss** (or **Cancel invitation**) on the right. It is the same native action
  row as Back, so the name uses the same font role and size. The page shows no
  status text, party count, per-copy conversation entry or last-action line.
  A dismissed copy leaves the list at once, even while the game is paused; the
  world deletion is queued and runs after gameplay resumes. If the game refuses
  it, the row returns with the reason beside it. The party keeps a fixed number
  of formation places that is never displayed: a full party answers an
  invitation with a message instead.
- **Model browser:** discovers installed Character records in batches of 48,
  shows at most 18 model results per page and searches the full discovered
  catalogue by name or record. Use MCM's **Search settings** field. Models without
  a researched identity join as followers without AI conversations.
- **Settings:** conversation participation, Memory and Relationships submenus,
  **Auto-connect nearby characters** (off by default, see below), voice playback, subtitles, automatic reactions, interface language and
  Developer mode. The global voice choices are **OmniVoice 16 steps (default),
  OmniVoice 32 steps, Pocket TTS and Convai cloud voice**, in that order, with
  service readiness alongside. If the chosen voice cannot run, the status line
  names the voice in use (for example "Ready · Using Pocket TTS, OmniVoice 16
  steps unavailable") and one gameplay notice says so once.
  MCM owns setting drafts, saving, discarding, defaults and draft guards.
  **Every setting waits for Apply, even under MCM's Auto Apply.** The installed MCM had
  `"autoApply": true` in its own `config.json` (a global player preference we never change):
  the banner read "Applied 1 change(s)" and there was no Apply bar. MCM's Auto Apply is
  only the UI calling `api.setDraft` and then `api.apply` back to back. The provider
  subscribes to `drafts.changed` and records the time; an `applyBatch` that arrives within
  0.25 s of a draft change is the automatic apply and is refused ("Change pending. Choose
  Apply to use it, or Revert to discard it."), so MCM keeps its own pending drafts. That
  gives, natively and for every setting type: the changed-row marker, **Revert** and **Apply**
  buttons, **Defaults** (staged, then Apply), a confirmation modal when leaving the mod or
  closing Settings with pending drafts ("Unsaved changes ... has unapplied changes. Apply
  them before leaving?" with Apply, Discard and Cancel; Cancel stays on the page), and a
  close guard on Esc. Our own action rows (the Back rows) are refused while drafts are
  pending ("Apply or revert pending changes before running this action"). A person's Apply
  arrives later and commits everything in one atomic `applyBatch`. Nothing is saved, written
  for the service, or prepared before that: no `settings.json` write and no voice-preview
  lease. While a different voice is pending, the voice status row reads "Pending: <voice>".
  **Leaving with pending changes.** MCM's own dialog is tied to its `cancel` key handler, which
  the live Esc did not reach (the page closed without asking). The provider therefore overrides
  `SettingsMainGameController.RequestClose`, the one call that Esc, the pause menu's back and F4
  all end in: with drafts pending it calls MCM's `McmUiEmitClosing`, so MCM shows its "Unsaved
  changes" dialog and resumes the close itself after Apply or Discard (Cancel stays). With
  nothing pending the close passes through untouched, other mods' pages are never held, and
  the guard lets a close through after repeated requests or if the dialog cannot open, so the
  player is never trapped. Each held close is logged in `runtime/mcm.log`.
  Limits: MCM's status line shows our refusal text for each change, and the confirmation
  popup wording and layout are MCM's own (not the game's "Settings" popup).
  (`bridge/voice-preview.mjs`, `mod/voice-preview.lua` and `previewSettleMs` remain but are
  unused by this page.)

Every inner page starts with one **Back** action. Characters, Current party,
Model browser and Settings return to the manager home; Relationships, Memory
and Character conversations return to Settings. The memory character picker
returns to Memory, and the removed per-copy conversation page no longer exists. Navigation clears the previous page's search.
The parent Back action remains visible when a search has no matching results.
**Your group** (the Back action and the companion driver's trip status) appears only
on Current party. Invitation actions still show their immediate native action
banner on the catalogue page.

Invitations and dismissals are queued while the page pauses gameplay. Their
pending state appears immediately. They run once after the player returns to
gameplay; paused spawn timers do not advance. Closing Companion Manager now
returns to gameplay. The adapter waits for native Settings to accept the close
and detach, then activates the real pause-menu Resume item once. MCM retains
its unsaved-settings prompt; cancelling that prompt stays in Settings. Other
providers and native settings retain their own exit behavior.

## Help and support report

**Settings → Help → Help and support** (last category of Settings) opens a Help page. Its Back
returns to Settings, like Relationships and Memory. The page has three groups:

- **If something goes wrong**: what to do, and whether the conversation service is Running,
  Starting, Not running or Unknown.
- **Report for the developer**: **Generate report**, the **Last report** row (file name as the
  value; the description and the banner show a shortened path, `…
untime
eports\` then the
  file name on its own line, so a long path never overflows) and **Copy report path**, a
  button that is always offered. It writes `runtime/clipboard-request.json`; the conversation
  service puts the full path on the Windows clipboard with `clip.exe` (only the path of a
  `convai-report-*` file is accepted). The game's own `ImGui.SetClipboardText` is tried too,
  from the next top-level update rather than inside the menu callback. The "Support report
  saved" popup appears only in Developer mode (once, when gameplay resumes).
- **Where the logs are**: absolute paths for the mod's `runtime\` logs (`probe.log`, `mcm.log`),
  the conversation service logs (`bridge.stderr.log`, `bridge.stdout.log`, `bridge-service.log`),
  `launcher.log` (`red4ext\plugins\CyberpunkConvaiLauncher`), the CET logs (`cyber_engine_tweaks.log`,
  `scripting.log`), `r6\logs\redscript_rCURRENT.log`, `red4ext\logs`, and the reports folder.

Where each log is written (verified in code): `mod/init.lua` and `mod/phone-layout.lua` append to
`<mod>\runtime\probe.log`; `mod/mcm.lua` to `<mod>\runtime\mcm.log`; CET writes
`<mod>\CyberpunkConvai.log`, `bin\x64\plugins\cyber_engine_tweaks\cyber_engine_tweaks.log` and
`scripting.log`; the supervisor (`bridge/bridge-supervisor.mjs`) writes `bridge-service.log`,
`bridge.stdout.log` and `bridge.stderr.log` (previous run: `.previous`) to the **state folder**
(development: the project's `runtime\`; packaged: `<mod>\data`, with the bootstrap using `data\logs\`);
the RED4ext launcher writes `launcher.log` beside its DLL; redscript and RED4ext write to `r6\logs` and
`red4ext\logs`. Lua cannot see outside the mod folder, so the service publishes the real absolute paths in
`runtime\support-paths.json` at start (the supervisor also adds `gameRoot` and `stateDirectory` to
`bridge-service.json`). With neither, the page shows `the game folder\...` templates.

### How a report is made

1. **Generate report** writes `runtime\report-request.json` (`{version, id, issuedAt, lua:{cetVersion,
   language, view, developerMode, party[]}}`) and waits. The service polls every 500 ms
   (`bridge/support-report.mjs`), writes `runtime\report-result.json` (`building`, then `ready` with `path`,
   `fileName`, `bytes`, or `failed` with a code) and builds
   `<mod>\runtime\reports\convai-report-YYYYMMDD-HHMMSS.zip`. Only the newest five reports are kept.
2. The zip holds `README.txt`, `summary.json` (mod fingerprint, CET/game/RED4ext versions, service status,
   settings, party, provider per companion, recent errors, the log index) and `logs/NN-<id>.txt`: the last
   2,000 lines or 1 MiB of each log.
3. If the service is stopped (fresh status says so) the page writes a **short text report** itself at once;
   if the service is not known to be stopped but does not answer within 6 s (30 s once it reports
   `building`), or answers `failed`, it does the same. The short report holds what the game can read
   (service status, settings, party, `runtime\*.log`, `CyberpunkConvai.log`), says why it is short and names
   the logs it could not read. It goes to `runtime\reports\` when that folder exists (the service creates it),
   otherwise to `runtime\`; the same five-newest rule applies.

### Privacy

Only named files are ever opened, so credential files, audio, voice references, model files, chat history
and conversation transcripts cannot enter a report (log names that suggest conversation content are
skipped). Credential files (`convai-key.txt`, `kaggle-access-token.txt`, `huggingface-*.txt`) are read only to
learn the secret values to scrub. Every line passes a redactor: known secrets, `Authorization` and
`key/token/secret/password/cookie` assignments, `Bearer` tokens, `?token=` parameters, well-known key
prefixes, hex runs of 32+ characters, 40+ character token-like runs, UUIDs and provider IDs (hashed to 8 hex
characters), and the Windows account name in `C:\Users\<name>`. Structured values are also redacted by key
name (`apiKey`, `token`, `endUserId`, `sessionId`, ...). `bridge/support-report.test.mjs`,
`bridge/support-report-lua.test.mjs` and `bridge/support-help-ui.test.mjs` plant fake keys, IDs, a Windows
name and conversation text in logs, settings and status files and require that none reaches either report.

## Ownership

- `mod/support-report.lua`: Help support (paths, request/result flow, short Lua report, copy path). Loaded
  by `mod/mcm.lua` behind a `pcall`; without it the manager simply has no Help entry.
- `bridge/support-report.mjs`, `bridge/zip-writer.mjs`: the service side (also in `BRIDGE_MODULES`).
- `mod/mcm.lua`: provider `cyberpunk-convai`, mod `manager`, registered through
  `GetMod('ModConfigurationMenuAPI').providers.registerProvider`. Produces the
  native schema and extends content search to the model catalogue. MCM files
  and preferences are never edited.
- `mod/mcm-entry.lua`: manager shortcut entry state machine. Activates the real
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

While an invitation prepares with the manager open, that same status banner
updates through **Preparing {name}…**, **Connecting {name}…**, **ready to join** or a
preparation failure. It tracks the latest requested pending copy and revision;
cancelling that copy, spawning it or resetting the world clears its progress.
It does not restore an older copy's banner after cancellation. Navigation keeps
progress visible, while memory, dismissal and trip results keep priority over
invitation progress. **Your group** remains exclusive to Current party.

`manager-party.lua` exposes this as a read-only preparation snapshot, separate
from notices delivered after gameplay resumes. MCM samples it from top-level
update, then changes only its own existing `status` text inside `MCMRenderRoot`.
The render observer records Lua arguments and provider ownership, including
MCM's provisional title; it never traverses or edits native widgets. Duplicate
states do not repaint, and an open settings draft does not cause a page reload.
The regression harness covers those paused transitions, rebuilds, cancellation,
native errors, memory results, foreign pages and detached controllers. Live
notification visibility still needs the installed game check.

Manager invitations can also post the game's blue neutral warning notifications,
using the same `PlayerPuppet.ConvaiPhoneFeedback` method as phone invitations.
That native method calls `SetWarningMessage(message, SimpleMessageType.Neutral)`;
the manager does not create a new HUD widget. These popups track the latest
manager-requested copy independently of the footer and other manager actions.
Direct phone invitations use the same rules.

**Which notices need Developer mode** (Settings → Development → Developer mode,
default Off). The player must see that a slow preparation is progressing, so
these are always shown, for manager and phone invitations alike:

- **Preparing {name}…** (the memory check, voice conditioning and connection start) and
  **Connecting {name}…**, once an invitation has been in flight for a second: a quick summon shows
  no progress, only its joined notice;
- **ready to join when you return to the game** (manager) and **ready, close the
  phone to join** (phone), because each tells the player to do something;
- **joined your group**;
- every failure and error, including a driving failure and the reply to Stop trip.

These are Developer mode only:

- **is joining your party**, which asks nothing of the player;
- the phone's acknowledgement **Preparing {name}…**, which
  repeats the native **invite queued** notice and the progress line that follows
  at once (an invitation that is already ready still gets its ready message);
- the **dismissed** result (the in-menu feedback line still reports it, and a
  failed dismissal is always shown);
- the routine driving instructions (preparing, boarding, driving, exit).

The manager banner and the Current party list always show every stage, because
they are not popups. Turning Developer mode on mid-invitation shows the current
joining step once, never a backlog. The phone's own "invite queued" notice
comes from the native phone script and is unchanged, as is its "will leave when
you return to the game" reply to a dismissal request.

### One merged notice for invitations made together

Manager and phone invitations share one **notice board** (`M.newBoard` in
`mod/manager-party.lua`, reached as `queue.board()`). Every invitation in flight is an entry;
the board turns all of them into ONE compact notice that replaces the previous one instead of
a stream of per-character popups:

- One invitation reads `Preparing Judy…`, `Connecting Judy…`, `Judy joined your group.`. Preparing
  and connecting appear only after the invitation is one second old (`SHOW_DELAY_MS`), per
  invitation: a quick summon goes straight to `Judy joined your group.`, and a merged notice names
  only the invitations already shown (two made together, one quick and one slow, shows only the
  slow one's progress and still ends in one merged joined notice). Failures and the ready lines,
  which tell the player to act, are never delayed.
- Several at once: `Preparing Judy and Johnny…`, then `Connecting Judy and Johnny…`, then (paused)
  `Judy and Johnny are ready to join when you return to the game.`, then `Judy and Johnny joined
  your group.`. The shared verb follows the slowest copy, so one character finishing first does
  not change the text. Up to three names are listed; more are summarised (`Judy, Johnny and 3 others
  joined your group.`). Phone-only batches say `Close the phone to join.` instead.
- A failure is mentioned beside the successes in the same notice (`Johnny joined your group.` /
  `Judy could not join: ...`); more than two failures end with `N more companions also failed.`
- While more than one outcome is in flight, a change waits until 400 ms after the last notice
  (`WINDOW_MS`), so near-simultaneous stages merge into one update. The paused-menu rules below still apply: a stage hidden by the menu is shown once more in
  gameplay, and nothing is replayed after cancellation or a world change (`queue.bind` resets the board).
- The visibility rules are unchanged: preparing, connecting, ready and joined always show; the
  joining step and the phone acknowledgement stay Developer-only; every failure always shows.
- `mod/mcm.lua` posts the board's note from its top-level update (and commits it only after the
  native call succeeded); `mod/init.lua` (`updatePhoneInvitationFeedback`) asks the same board for
  phone invitations, so whichever runs first posts and the other finds nothing new.

Each ticket, profile revision and preparation stage is posted once while paused.
Because the menu may hide native notifications, the first gameplay frame samples
the current state again and presents it once there. It retains no stage backlog.

A preparation failure is the exception and is never gated: each failed attempt
posts exactly one gameplay notice in total, shared by the manager, the phone and
the queue's detailed notice, and stays failed until the player cancels or chooses
the profile again. The paused menu, the open phone and the manager banner never
consume that notice: a failure first seen while paused is only shown in the
banner, and the notice is posted once when gameplay resumes. An immediate
failure posts its detailed notice at the same moment, and the phone no longer
posts a second copy while it is open.
A ticket already spawning reports **joining** (Developer mode only), and
completed attachment uses the existing **joined your group** notice (always shown). Cancelled,
removed and reset tickets cannot replay preparation messages. Native calls run
only from top-level update, never inside a native callback; same-frame
failure/progress notices for one ticket are combined without duplicates.
The popup tests cover menu return within the same clock second, copy/revision
deduplication, Developer mode on and off (including the dismissed and joining steps), immediate and asynchronous failure
notices (including one first seen while paused), cancellation, phone ownership
and already joined tickets. A world spawn deferred by the shared query budget
keeps the same joining notification when admission later succeeds.
Their visibility in the running game remains the live acceptance gate.

## Auto-connect nearby characters

**Settings → Conversations → Auto-connect nearby characters** (default **Off**). The talk key already
works on any NPC within 8 m whose record or name resolves to a profile (`profileIdentity` →
`characterCatalog.resolve`), so the game's own Judy met in the world can talk. The connection used to
open only when the chat did (`warmConversation` → `runtime/conversation-prewarm.json`), which costs a wait on
the first reply.

- **Off:** connect on talk, as before. Starting a text or voice chat with a world character that is not
  connected yet shows `Preparing connection to Judy… (turn on Auto-connect to skip this wait)`. The hint in
  brackets appears the first **two** times per game session only; later waits show `Preparing connection to
  Judy…`. A character already connected (a copy in the party, or one the bridge reports ready in
  `runtime/party-connection-state.json`) shows nothing. Group chat shows no wait notice. With a voice chat
  the line is joined to `Connecting microphone - wait for Listening`.
- **On** (`mod/auto-connect.lua`): a character with a profile that V looks at for 0.6 s (the existing gaze
  sample in `updateGaze`), or stands within 5 m of (a 1 Hz `GetTargetParts` scan, the idiom of
  `companion-marking.lua`), is warmed: the Lua side publishes up to **two** profile keys to
  `runtime/nearby-connections.json` (`{updated, profiles}`, rewritten on change and every 2 s) and
  `bridge/nearby-warm.mjs` opens their private connection (`PartyConnections.setNearby`, role `nearby`, the
  lowest priority: it takes optional group slots and never evicts a party, invitation or composer connection)
  and prepares their local voice with `localVoice.prepareProfile` (one voice at a time, only while no turn,
  microphone or voice change is running; a failed voice is retried after 30 s).
- **Limits:** at most 2 warm at once; one new start every 3 s; no new start in combat, a scripted scene, a
  call, a dialogue or a vehicle (the same `battleSample` gate as automatic reactions) and not while a menu
  pauses the game; a looked-at character may replace the idlest unwanted one; a character is released 40 s after
  it stops being wanted, or after 10 minutes without a conversation, and then waits 20 s (3 minutes after the age
  release) before it can be warmed again. A conversation in progress keeps its connection. Party members are
  never listed here.
- **Release:** the setting turned off, a world change and CET shutdown publish an empty list at once; the bridge
  also treats a list not refreshed for 8 s as empty (a paused, crashed or closed game), which closes the
  connections. The composer hint (`conversation-prewarm.json`) is untouched and still wins for the character
  being talked to.
- **Not done by it:** it sends no message, creates no memory and records no contact; it is a connection and
  voice warm-up, like the composer hint.
- Tests: `bridge/auto-connect.test.mjs` (policy), `bridge/nearby-warm.test.mjs` and the nearby cases in
  `bridge/party-connections.test.mjs` (bridge), `bridge/world-lifecycle.test.mjs` (the talk notice and the real
  adapter's gaze warm-up) and the setting in `bridge/manager.test.mjs`.

## Native section and option styling — October 2

Companion Manager uses one left edge. Section names bind to the native white
heading token (`MainColors.White`) above the category template's cyan rule.
Actions, read-only rows, toggles and selectors keep MCM's default red option label
token (`MainColors.Red`). Controls, selected/disabled values, hover feedback and
unsaved-change markers keep their native behaviour.

The differing indentation came from the installed renderer: managed controls
reserve a marker gutter and start their text at 48 units, actions start at 20,
and read-only rows add a list-label inset inside a surface at 20. The adapter
normalizes only its own rendered rows to 20 units, preserves the label's right
edge, and keeps draft markers in the outer gutter. Scaled category labels are
aligned using their cumulative parent scale. Resting option labels bind to the
native red token; section rules, cyan option controls and MCM's global theme are
not modified.

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
The navigation harness traverses all parent links, rejects stale page actions,
checks that only Current party exposes party status, and confirms Back from
profile selection leaves the invitation unchanged. The installed MCM API gate
exercises the same navigation with its actual draft guard and the installed
renderer filter checks Back visibility on searched catalogues. This checks the
adapter and scoping; visual acceptance of the October 2 hierarchy and white
headings still requires opening the installed manager in game after CET reload.

The exit adapter also uses the final title and provider ownership. A close
request alone does not resume gameplay: the same settings controller must
actually detach. Reset, another Settings screen, a new world or a bounded
timeout cancels pending resume. Nine focused lifecycle checks cover these
paths; actual Escape and draft-modal behavior still need the in-game check.

The first live exit check still returned to Pause. CET creates a fresh Lua
`WeakReference` wrapper for each native callback and does not implement equality
between wrappers of the same native object. Comparing captured wrappers missed
both accepted close and detach. The adapter now correlates the engine's
`CalcSeed` identity, as the installed MCM menu integration does. Styling hover
and detach use that same identity rule; a missing identity fails closed.
The fixtures now send different wrappers for render, hover, close and detach,
reject other controllers, and verify queued styling never touches a detached
menu. Exit counters expose which lifecycle boundary was reached without retaining
extra native objects. Gameplay validation and Resume activation still run in
top-level update. All 40 focused manager/exit checks pass, including the installed
MCM API integration. After CET reload of `9d4320d`, the user confirmed Esc
returns directly to gameplay. The read-only probe agrees: one matched close,
one matched detach, one native Resume, zero identity failures, and no retained
settings or presentation controller. The private receipt is
`runtime/mcm-escape-accepted.json`. The draft-dialog flow has fixture coverage;
the live acceptance was an ordinary settings close with no pending drafts.

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
version (`2e2a07a`) defers all widget operations and removes the repeated walks.
The dump's sole used matching scratch allocator has 12 bytes remaining out of
1,048,576; the faulting reflected type requires 16 bytes aligned to 8. This
confirms exhaustion rather than an ordinary Lua exception.

Thirty-seven focused manager/exit checks, including installed MCM integration,
pass. After CET reload the user confirmed the manager opens normally and both
colour and indentation are correct. The live widget readback agrees: all
displayed labels, including scaled section headings, sit at x=20 (floating-point
rounding on headings) with the native red RGBA values. It reports 17 styled rows,
no pending style work or error, and the previously saved On preference retained.
The private receipt is `runtime/mcm-style-after-deferred.json`. Esc and close-face
behavior are separate live checks and are not implied by this UI acceptance.

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

The manager setup default is F4. `Set-DevelopmentBindings.ps1` fills only missing
bindings and preserves existing F4 or custom choices. The game's QuickSave mapping
is not altered. F6/F7 select private text/voice and F8/F9 select group text/voice;
phone invitation controls use J/L.

The one-shot `mcm-state:<nonce>` diagnostic writes `runtime/mcm-state.json`
inside the installed mod. It reports the section, entry stage, party, feedback
and API availability without opening a menu or creating a companion.
