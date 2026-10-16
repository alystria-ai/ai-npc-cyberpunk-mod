# Companion Manager in MCM

The manager uses **Mod Configuration Menu 0.10.3 / API v2**, inside the game's
native settings host. The user rejected the earlier HUD popup and suggested
MCM. Its source remains for compatibility, but the manager shortcut and diagnostic
no longer open it.

## Player flow

- **Manager shortcut (currently F4 locally):** requests the real pause menu's MCM entry and selects **Companion
  Manager**. **Esc → MCM → Companion Manager** is also available.
- **Home:** four destination actions open Characters to invite, Current party, Model browser
  and Settings. The destination list appears only on this home page.
- **Characters to invite** (named "Characters" until 2026-10-14; the pages that sounded alike are now
  Characters to invite and, under Memory, Whose memories; the "Who can talk" page was removed later, see Settings): searchable researched profiles, including Johnny Silverhand
  and Adam Smasher, with Invite / Add copy actions for available models.
  This catalogue is independent of phone contacts and quest unlocks.
- **Current party:** one row per actual or invited copy, "Name #number" with
  **Dismiss** (or **Cancel invitation**) on the right. It is the same native action
  row as Back, so the name uses the same font role and size. The page shows no
  status text, party count, per-copy conversation entry or last-action line.
  A dismissed copy leaves the list at once, even while the game is paused; the
  world deletion is queued and runs after gameplay resumes. If the game refuses
  it, the row returns with the reason beside it. The party has no size limit and
  nothing on the page shows or enforces one (see Party size below).
- **Model browser:** discovers installed Character records in batches of 48,
  shows at most 18 model results per page and searches the full discovered
  catalogue by name or record. Use MCM's **Search settings** field. It is visible to
  every player: it lets you invite any game character model, including characters
  without conversation support, which join as followers and do not talk.
- **Settings:** Memory and Relationships submenus (there is no "Who can talk" row or page; every character may talk by default, and one the
  player muted earlier stays muted, since nothing resets the saved value),
  **Auto-connect nearby characters** (on by default and silent, see below), eye contact height, head tracking strength
  (Eyes only / Subtle / Gentle (default) / Strong), **Body gestures (experimental)** (on by default since 2026-10-11), voice playback,
  **V's voice for typed lines** (on by default; speaks what you type in V's cloned voice before the companion answers; does nothing beside the Convai cloud voice, which cannot clone, and the row says so; see `docs/V_VOICE.md`),
  **Keep prepared voices** (on by default), subtitles, automatic reactions, interface language and
  Developer mode (routine popups, a movement trace file, gesture logs and the setting in support reports; leave it off
  for normal play). The global voice choices are **Pocket · Performance (the default), OmniVoice · Balanced,
  OmniVoice · Quality, OmniVoice · High Quality, OmniVoice · Ultra Quality, Voxtral · Mistral cloud and Convai · Cloud voice**, in that
  order, plus the Inworld cloud voice as the last entry in Developer mode only, with service readiness alongside. Without the optional
  OmniVoice pack the four OmniVoice entries are greyed out (no pack row any more), the row name gains " (no Omni pack)" and Apply refuses
  them; see "Greyed-out entries" below.
  **Cloud voice and the tag settings** (`manager.applySettings`, `honourCloudVoice`; 2026-10-11): choosing Convai · Cloud voice
  always keeps it. Natural speech and Expressive emotions would make it read their tags aloud, so both are turned off. A
  notice ("The Convai cloud voice cannot use Natural speech or Expressive emotions, so they were turned off.") is shown only
  when a setting the player had set was turned off: Natural speech on, or Expressive emotions that an Apply ever carried
  (`expressiveEmotionsChosen` in `runtime/settings.json`). If only the Expressive emotions default was on, nothing is said, and
  `applySettings` returns a fourth value so the open page reloads and the toggle shows Off. Turning a tag setting on while the
  cloud voice is already saved still moves the voice to Pocket · Performance with the "needs a local voice" notice. One Apply that
  changes the voice to the cloud voice and turns a tag setting on: the voice wins (tag off, notice). A saved cloud voice with a
  tag setting on (older save) loads with the tag settings off and the voice kept, silently. Multilingual conversations follows the same
  rule (the voice is kept, never moved, when the player chooses it). If the chosen voice cannot run, the status line
  names the voice in use (for example "Ready · Using Pocket · Performance, OmniVoice · Balanced
  unavailable") and one gameplay notice says so once. Relationship choices read Auto / Romantic / Ordinary
  (Auto / Casual / Ordinary for Meredith Stout); the saved values stay `auto`, `on` and `off`.
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
  lease. While a different voice is pending, the voice status row reads "Pending: <voice>". With a voice that loads no local model the bridge reports state `remote`; the row names the voice from `cloudVoice` ("Voxtral cloud voice · Local model unloaded", "Inworld cloud voice · Local model unloaded", otherwise "Convai voices · Local model unloaded"). Before 2026-10-16 every cloud voice read "Convai voices".
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

**Back** is an MCM-styled button in the bottom action row, with Revert, Apply, Defaults and
Modified. MCM has no provider API for that row, so after each render (top-level update, from the
widgets the styling pass already found) the provider adds one native bottom action with
`McmUiAddBottomActionAt` at the rightmost place (`actionRightX`, the bar line `bottomActionY`)
and shifts the other 46-unit-high buttons left by its width plus the 20-unit gap. With no other
buttons, Back takes the place where the last button would be. It is added again after every
render, so it follows drafts appearing or clearing and page changes, and it exists on every
non-root page, including the one MCM restores on reopen. Its click arrives through
`McmUiEmitAction`; it returns to the parent page. **With pending changes it behaves exactly like Esc:** it
opens the same "Unsaved changes" dialog through `McmUiEmitClosing` (the shared `holdForDrafts` in
`mod/mcm.lua`: at most once in 2 s, never while the dialog is open, never more than five times in a row so
the player is not trapped) instead of doing nothing. If the
button cannot be added, Back is the last row of the page (`inspect().backMode == 'list'`).
Settings and Relationships start with a status line, the row
"Changes wait until you choose Apply.", which changes in place to "Change pending. Choose Apply to
use it, or Revert to discard it." while changes are pending.

**MCM's status line** (the green or red text at the bottom left) is moved to the top left, under
the header subtitle, while the page is open (its margin is changed, and restored when another
page is shown). Routine "Completed: <page>" navigation messages are dropped; an action's own
result, preparation progress and errors still show. If the top line can be updated in place, the
refusal text is also kept out of that line.

Esc probes: `runtime/mcm.log` records "Probe:" lines for the close key events and candidate close
handlers while the page is open (at most 60 per session), and for a close with unapplied changes.
Live result: with no changes Esc fires `OnButtonRelease` (`UI_Cancel`, `cancel`, `back`), then
`SettingsMainGameController.OnBack`, then `RequestClose`; the key guard asks before that.

Every inner page ends with one **Back** action. Characters to invite, Current party,
Model browser and Settings return to the manager home; Relationships, Memory
and Prepared voices return to Settings. The memory character picker
(Whose memories) returns to Memory, and the removed per-copy conversation page no longer exists. Navigation clears the previous page's search.
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

## Party size

The party has no size limit. The menu, the phone, the follow action ("come with me"), undoing a
dismissal and the bridge never refuse a companion because of how many are already travelling, and
no text mentions a capacity. The old refusals and their strings (`party-full`, "There is no room for
another companion", "Cancel an invitation first; the party is full.", "Party full: ...",
"Party: {count} / 8") are gone. The technical bounds that remain are resource guards that scale with
the party instead of refusing it:

| Bound | Where | What happens in a larger party |
| --- | --- | --- |
| Formation places | `mod/companion-space.lua` | The eight authored places keep their geometry. Place 9 and later continue the formation in staggered rows of two, 1.2 m further back each row, generated on demand. Lanes, the stand-off distance and the "near group" radius follow. |
| Route planning and physics queries | `mod/companions.lua`, `mod/companion-clearance.lua` | Unchanged: 192 spatial queries per update and two new route plans per update, started round-robin. A larger party is planned over more updates; nobody is refused or starved. |
| Warm Convai connections | `bridge/party-connections.mjs` | At most 8 private connections stay warm (`WARM_PARTY_LIMIT`), inside the 11 browser pages (8 plus 3 for the talk target, group chat, partners and nearby). With more members, pending invitations come first (a copy cannot appear before its connection is ready), then the members V talked to most recently. Everyone else connects when V talks to them: the request target takes one of the optional pages and the longest-idle warm member gives theirs up. The first reply to a member who was not warm waits for a connection. |
| Invitations preparing at once | `bridge/companion-invitations.mjs` | At most 8 characters have their memory and voice prepared at the same time (`PREPARATION_LIMIT`). More invitations wait in "Preparing" and start as earlier ones finish. An invitation whose connection has no warm place yet stays in "Connecting" until an earlier one joins; it does not fail. |
| Spawning | `mod/manager-party.lua`, `mod/companion-placement.lua` | Placement spends the shared per-update query budget. When it is spent the invitation is retried on a later update. |
| Group chat | `mod/group-chat.lua` | Three speakers per round. This is a conversation size (three group connections), not a party size; any members can be chosen. |
| Party cars | `mod/companion-vehicles.lua` | A runaway guard on cars the mod may create: at least 8 cars in all (V's and 7 more, seating 31), growing to 2 plus one car per 4 people travelling, so a larger party still gets the cars it needs. |

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

An invitation is ready, and the companion spawns and is announced as joined, only once her Convai connection is open. On a player's own Convai key (one connection at a time) the invitation opens her connection alone, one invitation at a time; the other party members' connections open when V talks to them, which is when the `Preparing connection to {name}…` notice can show. The notice never shows from looking at a character.

While an invitation prepares for longer than 1.5 s, the loading notice (held on screen, docs/NOTIFICATIONS.md) shows **Preparing {name}: waiting for …** with the step that blocks her (the conversation service, the memory service, the voice model, her connection, or the game placing her), updated as the step changes and kept until she has spawned or failed; the notice board posts **{name} joined your group.** when she has joined; the lines below describe what the in-menu banner shows. While an invitation prepares with the manager open, the status banner shows nothing for it: the progress lines (**Preparing**, **Connecting**, **ready to join**) are removed in every mode. A preparation failure still shows there (**{name}: preparation failed. Cancel and invite again.**). The banner tracks the latest requested pending copy and revision; cancelling that copy, spawning it or resetting the world clears it, and it does not restore an older copy's banner after cancellation. Memory, dismissal and trip results keep priority over the banner.

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

**Which notices a player sees** (the same in every mode, Developer mode included). A player is told what a companion is still waiting for (**Preparing {name}: waiting for the voice model to load…** and its siblings, one held line per companion, shown after 1.5 s and kept until she has spawned), that she joined, and about failures (with what failed and what to do). Companion invitations post no other progress lines, for manager and phone invitations alike: no **Connecting**, **ready to join** or **is joining your party** text. The Current party list shows each copy's stage (preparing, connecting, ready, joining) as its row state, and the mod log keeps every stage.

- **joined your group**, for every companion that arrives, quick or slow (developers see it too);
- every failure and error, including a driving failure and the reply to Stop trip.

These are Developer mode only:

- the **dismissed** result (the in-menu feedback line still reports it, and a
  failed dismissal is always shown);
- the routine driving instructions (boarding, driving, exit);
- companion tactic outcomes ("could not engage the target") and the
  popup after a Settings Apply that switched the voice (the Settings status line says it).

Turning Developer mode on changes nothing for invitations. The native phone script's own "{name}: invite
queued." / "dismiss queued." popup is no longer shown at all (2026-10-09): it only
surfaced after the phone closed and repeated the row's "INVITE QUEUED - CLOSE PHONE";
its "will leave when you return to the game" reply to a dismissal request is Developer
mode only. The complete list of every notice, with its class and repeat window, is
`docs/NOTIFICATIONS.md`; `mod/notices.lua` is the one gate.

### One merged notice for invitations made together

Manager and phone invitations share one **notice board** (`M.newBoard` in
`mod/manager-party.lua`, reached as `queue.board()`). Every invitation in flight is an entry;
the board turns all of them into ONE compact notice that replaces the previous one instead of
a stream of per-character popups:

- One invitation that waits longer than 1.5 s reads `Preparing Judy: waiting for the voice model to load…` (the step that blocks her, held and updated in place until she has spawned) and then `Judy joined your group.`; a quick one shows only the joined line. Several companions preparing together share the held notice with a line each.
- Several at once end in one notice: `Judy and Johnny joined your group.`. Up to three names are listed;
  more are summarised (`Judy, Johnny and 3 others joined your group.`).
- A failure is mentioned beside the successes in the same notice (`Johnny joined your group.` /
  `Judy could not join: ...`); more than two failures end with `N more companions also failed.`
- A posted notice stays up for at least 3 s (`MIN_SHOW_MS`), and 5 s after a final outcome
  (`FINAL_SHOW_MS`, so a joined notice is never cut short): a change arriving sooner is held, and
  whatever is true when the time is up is posted instead. Only a new failure is exempt.
- When one companion has joined and the others of the same burst are still going, the joined line
  waits up to 4 s (`JOIN_HOLD_MS`) for them, so the usual result is one merged `Judy and Johnny joined
  your group.`; if the others are still going after that, `Judy joined your group.` shows, and the burst
  ends with a merged line once the rest have arrived. The game's own notice length (`SetWarningMessage`)
  could not be read from the installed files, so the 3 s and 5 s are estimates of how long the default
  notice stays up (unverified). A stage never moves backwards within one attempt (a stale or missing
  receipt reads as `memory` for a moment; the board ignores it and logs it). Every posted notice
  is logged to `runtime/mcm.log` with each invitation's stage. A joined or failed outcome that the
  paused menu hides is shown once more in gameplay, and nothing is replayed after cancellation or a
  world change (`queue.bind` resets the board).
- Visibility: the preparing line (once per join), joined and every failure show in every mode; no other progress is posted in any mode.
- `mod/mcm.lua` posts the board's note from its top-level update (and commits it only after the
  native call succeeded); `mod/init.lua` (`updatePhoneInvitationFeedback`) asks the same board for
  phone invitations, so whichever runs first posts and the other finds nothing new.

Each joined notice and failure is posted once while paused. Because the menu may hide native
notifications, the first gameplay frame samples the current state again and presents it once there. It
retains no backlog.

A preparation failure is the exception and is never gated: each failed attempt
posts exactly one gameplay notice in total, shared by the manager, the phone and
the queue's detailed notice, and stays failed until the player cancels or chooses
the profile again. The paused menu, the open phone and the manager banner never
consume that notice: a failure first seen while paused is only shown in the
banner, and the notice is posted once when gameplay resumes. An immediate
failure posts its detailed notice at the same moment, and the phone no longer
posts a second copy while it is open.
A ticket already spawning reports no text (the party list shows its stage), and completed attachment
uses the existing **joined your group** notice (shown to every player when the companion arrives, quick or
slow). Cancelled, removed and reset tickets cannot replay preparation messages. Native calls run only from
top-level update, never inside a native callback; same-frame failure notices for one ticket are combined
without duplicates.
The popup tests cover menu return within the same clock second, copy/revision deduplication, Developer mode
on and off (no progress in either), immediate and asynchronous failure notices (including one first seen
while paused), cancellation, phone ownership and already joined tickets. A world spawn deferred by the shared
query budget keeps the same joined notification when admission later succeeds.
Their visibility in the running game remains the live acceptance gate.

## Auto-connect nearby characters

**Settings → Conversations → Auto-connect nearby characters** (default **On**, silent). The talk key already
works on any NPC within 8 m whose record or name resolves to a profile (`profileIdentity` →
`characterCatalog.resolve`), so the game's own Judy met in the world can talk. The connection used to
open only when the chat did (`warmConversation` → `runtime/conversation-prewarm.json`), which costs a wait on
the first reply.

- **Off:** connect on talk, as before. Starting a text or voice chat with a world character that is not
  connected yet shows `Preparing connection to Judy…`, a party copy that is still connecting included (there is no hint about the setting any more). With the
  setting **On** the same notice shows at the start of the conversation only: looking at a character and her warm-up are silent, and no connecting or ready notice announces a warm-up. A character already connected (a copy in the party, or one the bridge reports ready in
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
  release) before it can be warmed again. Party members are never listed here.
- **Ranking:** a looked-at character first (looking is intent), then nearby characters by prominence (tier-1
  named, other named, generic residents and archetypes; `autoConnect.prominence`, from the catalogue `kind` and the
  tier-1 list, or a profile's own `tier`/`prominence` field), then by distance.
- **Conversation partner:** a world character V talks to (not a party member) becomes a partner, a role of its own
  that does not use one of the two slots (published as `partners` in the same file; `PartyConnections.setPartners`,
  role `partner`, below the party, invitations and the current target, above nearby). The private connection is the
  one the conversation opened (same profile and scope), so no second connection is made. It stays warm (connection
  and voice) while V stays with it and is released when they part: more than 15 m away for 20 s, 3 minutes without
  an exchange, the character despawns, or a scene or game dialogue starts (config `partnerRange`, `partnerAway`,
  `partnerIdle`). Talking to someone else makes them the partner and gives the previous one 30 s (`partnerGrace`); at
  most 2 at once (a group chat). Promotion to the party: `convaiAutoConnect.promote(key)` (or the character being in
  the party) ends the role. Ambient residents keyed per entity cannot be warmed without their entity, so they are not
  kept as partners.
- **Release:** the setting turned off, a world change and CET shutdown publish an empty list at once; the bridge
  also treats a list not refreshed for 8 s as empty (a paused, crashed or closed game), which closes the
  connections. The composer hint (`conversation-prewarm.json`) is untouched and still wins for the character
  being talked to.
- **Not done by it:** it sends no message, creates no memory and records no contact; it is a connection and
  voice warm-up, like the composer hint.
- Tests: `bridge/auto-connect.test.mjs` (policy, prominence, partners), `bridge/nearby-warm.test.mjs`,
  `bridge/conversation-partner.test.mjs` and the nearby cases in `bridge/party-connections.test.mjs` (bridge), `bridge/world-lifecycle.test.mjs` (the talk notice and the real
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
version (`2e2a07a`) defers widget operations and removes the repeated walks. (2026-10-13: the draw hooks
described under "Changing a value does not flash the page" do a small, bounded amount of widget work, about
50 native calls per hook at most, never a walk; a hook that would exceed it fails and the page falls back to
the deferred pass.)
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
Characters (now Characters to invite), empty Current party and Settings pages, including Invite controls
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

## Changing a value does not flash the page (2026-10-13)

Every change of a slider, option or toggle makes MCM draw the whole Settings screen again (`drafts.changed` queues a render, and
`handleStep` / `handleNumber` in MCM's own surface queue one too; there is no in-place update). MCM draws from its own `onUpdate`, which
runs after this mod's in the same frame, so the new rows showed in MCM's default look (cyan, unaligned) for at least one frame before
this module could style them, then were hidden by the page veil, then shown: a flash on every tick of a slider.

The content is now created hidden, in the same call that creates it. `mod/mcm.lua` overrides `McmUiBeginContent` for the manager's own page
and passes `contentReady = false` (MCM then hides the scroll wrapper itself; no widget is touched in the hook). When the page is styled
the veil lifts and the wrapper is shown again in the same update that places the Back button. A hold that was never released (the style job
never started, the page stopped being ours) is released by `M.update` after 1.5 s, and if the wrapper cannot be found the hold is switched
off for the session and the page is drawn again without it, so the page can never stay empty. Only the manager's own page is held; another
mod's page, and a page for which MCM itself asks for hidden content, are passed through unchanged. Cost: one comparison per frame while
nothing is held; nothing is walked in the observer.

That first fix (`81ecce03`) still showed a blank page for one to three frames, and the status line and the bottom buttons, placed after the
styling, jumped into place.

### The page is given its final look while MCM draws it (early style)

Root cause: MCM draws from its own update, after this module's in the frame, so anything done from `M.update` is at least one frame late.
The fix moves the styling into the draw itself, with no per-row walk (`mod/mcm.lua`, block "Early style"):

- `McmUiCreateText` is overridden (arguments only) while one of the three row builders (`McmUiAddManagedLabel`, `McmUiAddActionSetting`,
  `McmUiAddReadonly`, also overridden to say which row is being built) runs: the label, marker and read-only label are created with the geometry,
  font size and red label colour the styling pass would give them (`earlyRowText` is the same rule as `styleRow`).
- The section headings are styled right after they are created (`SettingsCategoryController.McmUiSetup` + `McmUiAddCategory`, observers; a few
  native calls each, a budget error otherwise).
- `McmUiAddBottomActionAt` is overridden: the buttons on the bar line are held back and created together at the end of the draw, shifted left,
  with Back at the right end, so the bar never jumps. Whatever happens every held button is created (the end of the draw, a failure, or
  `M.update` half a second after a draw that never ended).
- At the end of the draw (`McmUiSetContentTitle`) the status line is moved under the mod list (about 15 native calls), and the content, created
  hidden by the first fix, is shown in that same call.

The content is shown there only if every step is known to have worked in this very draw: the hooks fired and agree with MCM's own count (one
`McmUiSetManagedLabelState` per managed row), nothing failed, the first label has margin 20, the status line, the scroll wrapper, the render root and
the mod list were seen, and no font has to be applied (a Russian, Ukrainian, Chinese, Japanese or Korean interface, or a language chosen but not yet
applied, keeps the font pass). Otherwise the page stays hidden and the older pass (`veilPage` / `styleCompletedPage`, idempotent over what the early
style left) styles and shows it exactly as before. So a hook that is missing or does nothing on some game version costs only the old behaviour;
three draws in a row that could not complete switch the early style off for the session. While idle there is no cost: the overrides act only
between `McmUiBegin` and `McmUiSetContentTitle` of the manager's own page, and `M.update` adds a nil check.

`runtime/mcm.log`: `Probe: early style shown: rows=N categories=N bar=N back=true` per draw (twelve at most) or `Probe: early style held: <reason>`;
`Early style hook not installed: <method>` if an override could not be registered (then the early style is off).

Other mods' pages are not touched: the overrides check that the page being drawn is the manager's.

### The scroll position survives a redraw

MCM captures the content scroll position before it draws and passes it to `McmUiBeginContent`, which sets it on a scroll area that is still empty
(and, with the hold, hidden). A redraw nevertheless came back at the top. The provider now (a) reads the old page's position once in `McmUiBegin`
(`McmUiGetContentScrollPosition`, only when the page being drawn is the one drawn last: same view, search and model page), (b) uses it when MCM's
own argument is zero, and (c) sets the position again on the scroll wrapper's controller (`GetScrollPosition`, then `SetScrollPosition` only when it
differs) in the call that shows the content: at the end of the early draw, or when the older pass or the stale-hold release shows the page. A page
that is opened afresh starts at the top (below). `Probe: scroll position restored A -> B` in `runtime/mcm.log` says when it was needed (twelve at
most). Not avoidable from a provider: MCM draws the whole screen again on every change (`drafts.changed` queues a render, and
`handleStep` / `handleNumber` queue one too).

#### A page opened afresh starts at the top

MCM keeps ONE content scroll position for the whole mod, not one per page of the manager: before every draw it reads the page on screen (same mod, so
the same scroll context), and it keeps the last position when the screen closes or another mod is shown. So a sub-page opened from a scrolled page, a page
reached again with Back, the screen opened again, and the mod picked again after another mod all opened scrolled where the previous page had been. A draw of a
page that is not the one drawn last (`lastDrawKey` differs from the page key: another view, search or model page, nothing drawn since the screen opened or
another mod was shown) sets `drawFresh` in `McmUiBegin`; `McmUiBeginContent` then passes 0 instead of MCM's position, once. A redraw of the open page
(Apply, a value change, a refresh) is not fresh and keeps its position as above. No native call is added and nothing runs per frame. MCM's own stored position
is left alone: it is read again from the page before the next draw.

### Mature content stages its companions as pending changes

The Local AI provider, the Local AI model and Mature content sit in one group on Settings > Conversation provider (provider, Mature content, model, in that
order). Turning **Mature content on** also stages, as pending changes before Apply (`api.setDraft`, from `M.update` after a `drafts.changed`
event, never in a hook): the provider = Local AI (only when the Local AI pack is present; without it nothing else is touched and the notice and the
help say Local AI is needed), the model = the largest uncensored model that fits (only when one is installed; otherwise the model is left alone), and, when the companion voice is a cloud voice (Voxtral, Inworld or Convai), Pocket TTS (a voice that is
already local, Pocket or any OmniVoice choice, is never changed; with Multilingual conversations on, where Pocket is refused, OmniVoice Balanced is
used instead, and nothing is staged when its pack is not installed). One line names what was staged and replaces MCM's "Pending: ..." status for eight seconds. Turning it **off** puts the provider,
model and voice back, except any the player changed since. What was staged is kept in memory while the drafts are pending and, on Apply, in
`settings.json` (`matureRestore`: `{conversationProvider = {before, set}, localModel = {before, set}, voice = {before, set}}`, validated on load and
on Apply, dropped when Mature content is off; an older record whose model `set` is `auto` still restores). The Local AI model row has no Auto
entry: it lists the installed models from the smallest file to the largest and shows the default (the largest that fits the free graphics memory)
as selected until a model is chosen; Apply then saves that model's id (docs/LOCAL_AI.md, "Choosing the model"). Revert or Apply forgets the in-memory staging.

**Mature content and cloud providers exclude each other.** While the provider is any cloud one (Convai free tier, Convai API key, Mistral), Mature
content is off, and load and Apply force it off. Choosing a cloud provider while Mature content is on turns Mature content off in the drafts
and puts back what turning it on had changed, from the same restore record (its provider id can now be `convai-key`, Convai with the player's
own key). Turning Mature content on still selects Local AI, the uncensored model and a local voice. Mature content without the Local AI pack
bounces back to off. Its help ends "Choosing a cloud provider turns it off."

### Select labels and the description panel (2026-10-14)

**Select labels.** A select row (`settingsSelectorStringList`) shows its value between two arrows in a box of fixed width that the mod cannot change.
A longer text runs over the arrows. `mod/mcm.lua` therefore keeps every option within `OPTION_BUDGET` = 26 "average lowercase letters"
(32 before the focused-row key boxes, see below; `optionUnits`: space 0.5; `i l . , : ; ' | !` 0.45; `t f r I ( ) - / [ ]` 0.65; `m w` 1.45; `M W` 1.6; other capitals and digits 1.15; a Chinese,
Japanese or Korean character 2). Seen running over the arrows: Inworld (about 33), Voxtral (about 40) and the Mature pack's model name (about 41);
the longest entry reported to fit was an OmniVoice one (about 36 by this estimate), so 32 sat below all of them. The built-in entries are now:
`Voxtral · Mistral cloud`, `Voxtral · needs Mistral key`, `Inworld · Cloud voice`, `Inworld · needs key`, and the OmniVoice names without a
" · needs pack" suffix (the missing pack is shown by greying them out, see below; a voice name that appears in sentences and notices keeps its full name), and the Mature pack models `Qwen3.5-4B · uncensored` and
`Gemma 4 E4B · uncensored` (the word stays: `bridge/local-model-choice.mjs` recognises uncensored models by it). A model the player adds shows its
own name, `(custom)` or `(custom · too large)`, and `fitOption()` is the last resort: a label still over the budget keeps its trailing
`(...)` or ` · ...` part and ends its name with an ellipsis. The 15 translations are held to the same budget. `bridge/select-labels.test.mjs`
checks every select text in English and in each language, the built-in model names and the estimate; `bridge/manager.test.mjs` checks the
live menus in the worst case and the truncation.

**Focused rows and the key boxes (2026-10-14).** The game draws an "A" and a "D" key box at the left and right arrows of a focused selector, over
the option text. Their width could not be measured, so each is assumed to take 3 units (`KEY_HINT_UNITS`) of the 32 (`OPTION_BOX_UNITS`);
`OPTION_BUDGET` is what is left, 32 - 2 * 3 = 26. Every option text of every select (English and the 15 translations) and the built-in model names
must fit 26, which `bridge/select-labels.test.mjs` enforces; some labels were shortened in several languages for it ("Local (needs Local AI pack)",
"No model installed" and others). The Mature model names (21.6 and 23.0 units) and the Inworld names already fit and are unchanged. The 3-unit
width is an assumption: if a focused label still runs under a key box in the game, raise `KEY_HINT_UNITS`.

**Greyed-out entries (not yet verified in the game).** While the OmniVoice pack is missing, the four OmniVoice entries of Companion voices are
greyed out. The MCM settings library has no per-option disabled flag, so this mod dims the shown value text, the arrow or stepper skips those
entries and stops at the ends of the list, and Apply still refuses choosing one.

**Description panel.** The text on the right of the page is MCM's `description_text` (an `inkRichTextBox`, 382 wide, in a viewport that cannot
scroll), so what does not fit is cut off at the bottom. `mod/mcm-fonts.lua` draws our descriptions at size 22 (`DESCRIPTION_FONT_SIZE`; the game
uses 20) and restores the original size for text that is not ours. The descriptions were rewritten to say only what a player could not guess
(trade-offs, requirements, what a setting selects or turns off, the engineering reason behind a default), in short blocks separated by a blank line.
`bridge/description-fit.test.mjs` estimates the height (32 letters a line, at most 26 lines at size 22) for every description, English and the 15
translations, including the longest composites (Mature content and Local AI model with every optional paragraph present). It estimates; the
live check is to open each page and look for cut-off text.

### Settings sections after the 2026-10-14 restructure

Order on the Settings tab: Interface, Conversations, **Conversation provider**, Companion behavior, Voices, Subtitles, Automatic reactions,
add-on sections, Development, Help.

- **Conversation provider** (new): the provider selector (four entries: Convai free tier (default), Convai API key, Mistral (free plan), Local (needs
  Local AI pack)), Mature content, Local AI model, the **Mistral free API key** row (above the Convai one), the Convai key row (always listed, also with Mistral or Local chosen), the Convai paid tier entry, Edit characters.
  Everything that decides who answers is here. The old rows "Use my own Convai API key", "Conversations use" and the Local AI status row are gone
  (see "One key button per key" and "Where the status went" below).
- **Voices**: Voice playback, Companion voices, **Voice status** (moved up to sit right under Companion voices), Lip sync delay, Natural speech,
  Expressive emotions, Follow-up questions, V's voice. The OmniVoice pack row and the Inworld key rows are gone from here.
- **Development** holds Developer mode and, in Developer mode only, the Inworld key row right after it.

**Provider selector and migration.** "Convai API key" stores `conversationProvider = 'convai'` with `useOwnConvaiKey = true`; the other entries store
`convai`, `mistral` or `local` as before. A one-time migration on load (marker `convaiProviderChoice` in `settings.json`) maps the old switch: on
with a key saved becomes "Convai API key", anything else "Convai free tier"; a saved Mistral or Local choice is untouched.

**One key button per key.** The Convai key and the Mistral key (Settings > Conversation provider) and the Inworld key (Settings > Development,
Developer mode only) each have one row. Its button reads "Paste" while no key is saved and "Remove" once one is. The status is in brackets in the
row name: "Convai API key (...a1F9)" (the last four characters), "(Added)" when a key is saved but no tail is known, "(Checking...)" while it is checked
and "(Not added)" after a failed paste, when the failure message is the first paragraph of the row's help. Only the last four characters of a key
are ever shown. The old separate paste, remove and status rows for all three keys, "Your own key" and "Conversations use" no longer exist.

**Where the status went.** The Local AI model row's name gets a bracket while the model is not ready ("(Warming up)", "(Not enough memory)",
"(Unavailable)") and its help starts with the loading sentence. The provider notes (Mistral limit reached, key not accepted or model unavailable; the
Convai free tier's "x of y left today" or limit reached; your key's plan limit, rejected, no memory room or running without memory; "Waiting for the
conversation to end"; fallbacks such as "Convai: Local AI is not ready") are the last paragraph of the Conversation provider row's help. Ready and
not-installed states need no words.

**Inworld is a developer-mode voice.** Companion voices lists it, as the last (eighth) entry, only while Developer mode is on (seven entries
otherwise), as "Inworld · Cloud voice" or "Inworld · needs key". A saved Inworld voice reads as Pocket while Developer mode is off. The Inworld
sentences in the helps of Companion voices, Natural speech, Expressive emotions and Multilingual conversations, and the Works-with sentence, show
only in Developer mode. The refusal text is "Requires an Inworld key (add it in Settings > Development)".
- **Prepared voices** have no switch, no disk row, no Clear action and no page: they are always kept, and a saved `keepPreparedVoices = false`
  is read as on and written back as on. `bridge/prepared-voices.mjs` stays only for `scripts/Clear-PreparedVoices.mjs`.
- **Groq** is no longer a provider. A saved `groq` is read as `convai` (the default), in the bridge and in the Lua settings alike; `player-groq-key.txt` is never read.
- **Add-ons** can hide **Most remarks per fight** with `remarkCap = false` in `handle:settings` (Delamain does; the default guard of 30 stays).
- **Body gestures** is shown without "(experimental)".
