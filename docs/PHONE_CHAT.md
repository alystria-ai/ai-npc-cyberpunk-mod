# Native phone Chat

## Player flow

Use the game's phone control (normally hold **T**) to open the phone. **Chat** is the third tab, beside Messages and
Contacts. Use the phone's left/right tab controls to select it, choose a person,
and press the normal confirm action. The
conversation opens directly; there is no quest-message thread selector.
The existing secondary message action also opens the selected Chat conversation.
Pointer callbacks are provided for the tabs and contact rows where a pointer is
available; the game's ordinary phone navigation remains the primary input.

The composer is docked to the bottom of the conversation frame, outside the
scrolling history. **Enter** starts typing and sends the message. **Escape** ends
typing, after which the normal back action returns to the Chat contact list.
Typed case, clipboard operations and caret movement are preserved. Quest replies
remain in the game's Messages and Contacts flows.

The character does not have to be spawned or nearby. Chat lists active, known
contacts supported by the conversation catalog, including contacts with no quest
SMS. Newly unlocked contacts are picked up when opening the tab. Replies use the
game's sent/received message bubbles. Private/group text and microphone actions
remain separate in-person conversations, using the player's assigned CET bindings.

## History and memory

History and per-contact drafts persist across game launches, save loads, bridge
restarts and CET reloads. **There is no disappearing-message setting or automatic
launch cleanup.** Older settings containing that field are migrated away.

**Companion Manager → Settings → Memory** owns explicit reset controls:

- **Forget selected character** clears the contacted ordinary/relationship
  provider variants belonging to that displayed character. Matching local Chat
  messages and drafts are removed only after the aggregate reset succeeds.
- **Forget all memories** clears contacted provider pairs and, after the full
  reset succeeds, all local Chat histories and drafts, including archived data.
- Failed, cancelled or uncertain resets preserve Chat data. Pending or blocked
  resets retire affected requests so delayed replies cannot restore old messages.
- A configured character with no contacted provider pair can receive local Chat
  cleanup without contacting an unused provider. The player identity is retained.

See [CHAT_MEMORY_RESET.md](CHAT_MEMORY_RESET.md) for aggregate confirmation,
alias/archive handling, reset receipts, and failures during local persistence.

History and drafts are in the installed mod's `runtime/phone-history.json`.
They are shared across saves, independent of Cyberpunk's quest journal. All valid
stored turns are retained; the prototype's silent 40-message cutoff is removed.
Phone sessions are in the project's ignored `runtime/phone-sessions.json`, separate
from in-person sessions. All channels use the same persistent player identity;
ordinary and relationship provider profiles keep their own remote memories.
The local Chat history remains associated with the displayed character.

Lua applies successful reset receipts to history and drafts in one replacement
with an action tombstone. Repeated receipts do not erase conversations started
after Forget. A missed success can be reconciled locally after restart without
repeating cloud deletion. Current-world and memory guards still reject stale
replies. No API keys or session IDs enter game widgets or test output.

## State and ownership

- `PhoneChatTabs.reds`: third-tab navigation and explicit Off → List → Opening →
  Conversation states. Native UI readiness completes the transition; generation
  checks reject a cancelled opening. Returning goes directly to the Chat list.
- `PhoneChat.reds`: composer, draft handoff and native bubble presentation. Chat
  data is display-only. AI mode bypasses the native SMS setup that activates or
  visits journal entries, detaches quest-message callbacks, and restores normal
  mode when the native panel is reused for Messages.
- The composer belongs to the native Conversation canvas. The scroll viewport
  and scrollbar reserve 156 native layout units at the bottom; normal SMS mode
  restores their original margins. It does not follow the message-list height.
- `phone-chat.lua`: persistent local transcript, drafts, confirmed reset receipts and one outstanding
  text request. It runs on menu frames with zero simulation delta. Contact identity
  is captured on send; changing the view cannot redirect a reply.
- `phone-chat-style.lua`: matches Chat to the native tab grid and resolved palette,
  hides the reused quest-reply section only in Chat, and restores its previous
  visibility for Messages. An activation guard also rejects stale quest-reply
  events in Chat. The composer uses readable cyan text and an inline Enter/Esc
  placeholder; its separate hint row is used only for service/error status.
  Widget state belongs to the current native tree; no native handles are retained
  across a phone close or save load. The module can be applied live without restarting.
- `phone-chat.mjs`: catalog-authorized text-only Convai calls and persistent phone
  sessions. No NPC, microphone, local TTS, movement or speech playback is needed.
- `chat-memory-resets.mjs`: reconciles explicit memory-reset intents and results
  into the journal consumed by Lua. It does not write the history file itself.

An API failure preserves the draft and shows inline status. A newer unsent draft
is not replaced by an earlier request's failure. Fifteen-second heartbeat expiry
cancels service work after exit; a 45-second UI timeout preserves the draft. Late
replies cannot enter a new attachment, and repeated polls do not resend a request.

## Historical verification — September 29

The initial Chat implementation still included the now-retired disappearing-message
option. Its launch-clearing tests below describe that version, not current behavior.
Current retention and Forget behavior follow the contract above; later offline
coverage is recorded in [CHAT_MEMORY_RESET.md](CHAT_MEMORY_RESET.md).

### Confirmed previous prototype

- User screenshots show an 8ug8ear message (`hi`) and a written reply in native
  bubbles. They also expose the rejected mixed quest/AI history, indirect thread
  flow, and composer attached to the scrolling content.
- A read-only probe of the user's open panel confirmed the actual native widget
  tree and the original composer's parent. No game input was injected.

### New Chat implementation

- Native isolated compilation passed at 13:53 IST. Lua and bridge syntax checks pass.
- Full project suite: 167 passing checks, zero failures, one existing installed-MCM
  check skipped (168 total). Focused phone/launch/manager run: 32 pass, one skip.
- The initial lifecycle checks covered launch-only clearing, CET/save/bridge survival,
  delayed or stale identity acknowledgement, default persistence, migration,
  complete history retention, and reuse of the saved Convai session after restart.
- The initial MCM checks covered the retired option's default Off, atomic save,
  invalid values and failed-save rollback.
- The real running game process was identified twice with the same launch token;
  the token was not printed or committed.
- Installed after the user closed Cyberpunk, with SHA-256 verification of every
  copied file. Previous phone native files were backed up under the ignored
  runtime/install-backups directory. Restarted the hidden conversation bridge
  (PID 24424), launched Cyberpunk (PID 24200), and verified actual startup
  compilation completed at **13:58:42 IST**. The bridge reports ready.
- The user's new screenshots confirm the direct Chat list/conversation and native
  bubbles. They exposed a detached, differently styled header, stale gold quest
  reply widgets, and the unwanted separate Enter/Esc hint row.
- Follow-up live correction: Chat now measures 200 × 94 native units, with native
  Regular 50 typography, the game's resolved selected/inactive tints, no external
  tab margin, and a matching 7-unit underline. The quest-reply container is hidden
  with its layout space removed. The idle composer measures 72 units high after
  removing the help row. The user's further request changes the input to cyan and
  adds “Press Enter to write / Esc to stop typing” inside it, with an Enter-to-send
  cue while focused. Codeware's 15% placeholder opacity is raised to 75% only here.
- 18 focused phone checks pass, including three new checks for opaque native names,
  stale quest renderers/activation, native visibility restoration and composer hints.
  The user confirmed the updated tabs, cyan input/hint and Enter/Esc typing check
  are all good. This is user visual acceptance; no new screenshot was supplied.
  Normal Messages restoration has automated coverage, not a separate live check.
  No game input was injected and no restart was required for the correction.
- Follow-up: inherited Codeware focus callbacks also reached F6/F8 inputs.
  Placeholder and text-style changes now require a `convaiPhoneComposer` ancestor.
  The world composer keeps “Type your message to the character.” and mixed-case
  typing; changing the hint never changes a draft. The regression reproduced
  the leaked hint before the fix and passes afterward, including detached inputs
  and manager search. All 20 focused phone checks pass. Applied live without a
  reload; the user confirmed the original in-world prompt is restored.

### Conversation isolation repair

- The next live report exposed a separate data-refresh defect: Coach Fred's
  saved transcript was empty, but his native message list still contained two
  AI rows from another contact. The selected contact agreed between native UI
  and Lua; the saved histories were separate.
- Native `Clear()` defers replacement. Chat now uses `Clear(true)` for its
  message and choice lists, including empty histories. Queued journal-update
  and typing events are ignored in Chat and forwarded in native Messages.
  The matching Lua compatibility hooks are scoped to the actual Chat tree;
  stored transcripts and Convai sessions are not edited.
- Twenty-two focused phone checks pass, including empty/populated conversation
  replacement and native Messages isolation. Full changed-Lua syntax checks
  pass; the native file matches the successful isolated compilation.
- Installed with file-hash verification while the game was closed on September
  29. The normal game startup compiled successfully at 23:22:28 IST and the
  hidden reply bridge is ready. The user confirmed histories are separate after
  the requested populated/unused-contact check. A live read of Babs's panel
  also matched her two saved lines exactly, with two AI renderers and zero
  native quest choices. No style/domain error was reported. Native Messages
  restoration still has automated coverage, without a new visual acceptance.

## Current manual check

1. Open Phone → Chat, choose a person, and confirm: one direct conversation screen.
2. Inspect header, bottom composer, scrollbar, and empty/history states. Send a
   mixed-case message containing J/L/F/C; confirm one reply to that contact.
3. Escape typing, return to the list, choose someone else, and return. Drafts and
   history must stay with their contact. Check normal Messages/Contacts afterward.
4. At a later normal game relaunch, check that history and drafts are retained.
   Batch this with the next needed restart; do not restart solely to repeat an
   already accepted check. Test Forget with isolated fixtures rather than clearing
   a player's real conversations during routine verification.

Controller text entry is not implemented; keyboard typing is the current path.
