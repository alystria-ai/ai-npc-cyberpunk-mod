# Native phone Chat

## Player flow

Hold **T** to open the phone. **Chat** is the third tab, beside Messages and
Contacts. Use the phone's left/right tab controls to select it, choose a person,
and press the normal confirm action (**F** on the current keyboard map). The
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
game's sent/received message bubbles. F6–F9 remain in-person conversations.

## History and memory

**Companion Manager → Settings → Disappearing messages** defaults **Off**.

- Off: history and per-contact drafts persist across game launches.
- On: clear that displayed history and drafts on the next game launch.
- Loading a save, restarting the bridge, or reloading CET does not clear the
  current launch's transcript. Enabling the option takes effect at the next launch.
- Convai phone sessions remain in their separate store. Clearing local history
  never deletes a Convai session or submits a memory-reset request.

History and drafts are in the installed mod's `runtime/phone-history.json`.
They are shared across saves, independent of Cyberpunk's quest journal. All valid
stored turns are retained; the prototype's silent 40-message cutoff is removed.
Phone sessions are in the project's ignored `runtime/phone-sessions.json`, separate
from F6/F8 sessions. No API keys or session IDs enter game widgets or test output.

The bridge identifies the actual game process by PID and creation time, once per
adapter attachment, and acknowledges that identity for the current adapter world.
A stale identity cannot clear history. When disappearing messages is enabled,
Chat waits for this acknowledgement before displaying old messages or accepting
input. This avoids briefly showing messages that should disappear if the bridge
is unavailable. Local history is cleared only after acknowledgement.

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
- `phone-chat.lua`: local transcript, drafts, launch retention and one outstanding
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
- `game-launch.mjs`: hidden, read-only process identification and scoped retries.

An API failure preserves the draft and shows inline status. A newer unsent draft
is not replaced by an earlier request's failure. Fifteen-second heartbeat expiry
cancels service work after exit; a 45-second UI timeout preserves the draft. Late
replies cannot enter a new attachment, and repeated polls do not resend a request.

## Verification — September 29

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
- Focused lifecycle checks cover launch-only clearing, CET/save/bridge survival,
  delayed or stale identity acknowledgement, default persistence, migration,
  complete history retention, and reuse of the saved Convai session after restart.
- MCM checks cover default Off, atomic save, invalid values and failed-save rollback.
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

### Combined live check

1. Open Phone → Chat, choose a person, and confirm: one direct conversation screen.
2. Inspect header, bottom composer, scrollbar, and empty/history states. Send a
   mixed-case message containing J/L/F/C; confirm one reply to that contact.
3. Escape typing, return to the list, choose someone else, and return. Drafts and
   history must stay with their contact. Check normal Messages/Contacts afterward.
4. Toggle Disappearing messages On. CET/save reload must retain the current history.
   At a later normal game relaunch, check empty display history and retained Convai
   context. Batch this with the next needed restart; do not restart solely to repeat
   an already accepted check.

Controller text entry is not implemented; keyboard typing is the current path.
