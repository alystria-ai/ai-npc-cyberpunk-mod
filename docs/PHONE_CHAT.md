# Native phone conversations

## Controls

Open the phone, select a supported contact, and open their Messages conversation.
Press **Enter** to focus the integrated composer, type, and press **Enter** to send.
**Escape** ends typing; the usual phone navigation then works again. Typed case,
clipboard operations and native caret movement are preserved. Existing scripted
reply choices remain available when the composer is unfocused.

The character does not have to be spawned or nearby. Phone replies are written
messages in the game's normal sent/received bubbles. F6–F9 keep their existing
in-person conversation behavior.

## Ownership

- `PhoneChat.reds` owns the composer and native message presentation. Custom rows
  are `IScriptable` display data, never journal entries. It wraps the game's SMS
  update after the original messages are built; it does not call quest reply actions.
- `phone-chat.lua` owns drafts, the last 40 messages per supported contact, one
  outstanding request, acknowledgement and save/unload lifecycle. It runs on menu
  frames even when simulation delta is zero. Contact identity is captured on send.
- `phone-chat.mjs` resolves contact IDs through the project catalog and sends
  text-only requests through the existing Convai client. It uses no world entity,
  microphone, TTS, local GPU model, companion movement or speech playback slot.
- Each game attachment has a fresh request scope. Fifteen-second heartbeat expiry
  cancels service work after a game exit; a 45-second UI timeout preserves the draft.
  Late replies cannot enter a new game attachment. Repeated file polls do not resend.

Drafts and displayed history live in the installed mod's
`runtime/phone-history.json`. They are local mod history shared across saves, not
quest history stored in a Cyberpunk save. Phone session IDs are stored privately
in the project's ignored `runtime/phone-sessions.json`, independently of F6/F8
sessions. No API key or session ID goes into game widgets or test output.

Unsupported contacts get an unavailable message. Manager-disabled conversations
cannot send. An API failure keeps a draft and inline status. No recipient is
silently substituted. A supported contact already unlocked in the game can open
the composer even without an authored SMS thread; the temporary list row does
not unlock contacts or change quest state.

## Verification — September 29

- Full native isolated compilation passed, including both existing phone controls
  and the new composer. Changed Lua and bridge JavaScript pass syntax checks.
- Full project suite: 158 passing checks, zero failures, one existing installed-MCM
  check skipped (159 total).
- Nine executable tests cover protocol bounds, duplicate heartbeat delivery,
  contact-specific sessions, unload/stale replies, service errors, paused-frame
  polling, switching contacts, timeout recovery, disabled profiles and preserving
  a newer unsent draft during an earlier request's failure.
- A real text-only Judy request returned 26 characters in 4.866 seconds. This is
  service-path evidence, not a measurement of on-screen send-to-display latency.
- Installed with SHA-256 copy verification after the user closed the game. Restarted
  the bridge, launched Cyberpunk PID 11260, and confirmed actual startup compilation
  completed at 13:19:02 IST. Only `PhoneChat.reds` differed from the installed native
  files before this install; existing native scripts were unchanged.
- Visual layout and real typing are **pending**. Confirm mixed-case
  text containing J/L/F/C does not trigger Journal, invite, call or close; verify
  Escape, a reply in the panel, draft retention and the normal scripted choices.
- Check a supported contact without an existing SMS thread as a separate native
  navigation case. No controller text-entry support is claimed by this prototype.
