# Native phone Chat

## Player flow

Use the game's phone control (normally hold **T**) to open the phone. **Chat** is the third tab, beside Messages and
Contacts. Use the phone's left/right tab controls to select it, choose a person,
and press the normal confirm action. The
conversation opens directly; there is no quest-message thread selector.
On the Chat list, on a keyboard (2026-10-28, branch `feat/favorites-2`): **T** opens the chat (the envelope on the row and the bottom bar's Chat
hint), **H** calls (the phone icon and the bottom bar's Call hint; a holocall with the selected person, see [HOLOCALL.md](HOLOCALL.md)) and **F** turns the
selected person's favorite on or off (a star: gold for a favorite, with an F key box on the row and in the bottom bar's left hint; see
"Favorites on the Chat list" below). Enter, a click and R still open the chat; F no longer does. On a pad Cross opens the chat and Triangle calls, as before,
and there is no favorite key. An open conversation shows no Call hint (removed
2026-10-15: it spoiled the composer layout); V still calls from there. The game's own Contacts Call is unchanged.
Pointer callbacks are provided for the tabs and contact rows where a pointer is
available; the game's ordinary phone navigation remains the primary input.

The composer is docked to the bottom of the conversation frame, outside the
scrolling history. **Enter** starts typing and sends the message. **Escape** ends
typing, after which the normal back action returns to the Chat contact list.
Typed case, clipboard operations and caret movement are preserved. Quest replies
remain in the game's Messages and Contacts flows.

**Focus on open (2026-10-27, branch `fix/chat-focus`; `PhoneChat.reds`, GAME RESTART; not yet seen in the game).** Owner: "when someone goes
inside a chat page for a character it should auto go inside the textbox so that he doesnt have to press enter". Opening a character's
chat page now puts the keyboard focus in the message box by itself, the same focus the Enter key gives (`ConvaiChatAutoFocus`). It runs
from the first paint Lua asks for after the page has the focus (`ConvaiChatPresent`), so nothing runs per frame and no timer is added.
Conditions: the page itself has the focus (`m_isFocused`: never on the Chat list, which is the game's phone and has no box, so J, L and
V on the rows are not touched), the chat can be written to (not disabled, not a character the player made while Convai answers), the
game allows texting, and the player last used keyboard and mouse (on a pad nothing can leave a box that swallows every action, so a pad
keeps the Enter-to-write behaviour). One attempt per opening. The Enter that opened the chat may still be down or repeating, so no Enter
counts as a send for 0.5 s after the automatic focus (an engine-time stamp read on a key press). Keys on the chat page:

| State | Enter | Esc | C, V (call), F, J, L, other keys |
|---|---|---|---|
| Typing (the state on opening) | sends the text | stops typing, back to the idle page | typed as letters; the game's actions are swallowed, as before |
| Idle page (after Esc, or when the box could not be focused) | starts typing | closes the chat, back to the list | C closes, V calls (inside a conversation the call key stays V), as before |

So a chat now takes two Escapes to close from a fresh opening (the first stops typing), and V (call) inside an open chat needs the first
Esc. The call key on the Chat list rows is H on a keyboard since 2026-10-28 (Triangle on a pad).

**Opening a chat: F twice (2026-10-27, branch `fix/chat-focus-2`; `PhoneChat.reds` and `PhoneChatTabs.reds`, GAME RESTART; cause not proven offline).**
Live (game 2.5, after focus-on-open): "if it is a new character i have to press F twice to get inside chat for it"; a chat with a history opens
on the first press. The probe log of that session shows each chat reaching the typing state once (alex, adam-smasher, anders-hellman, ...), so the
box focus itself works; what is lost is the first press, or the page's arrival, for a row with no journal contact (no history, no journal entry,
`hash` 0). Reading the game's scripts and ours found no difference in the code path that depends on history, so two defences and a trace went in:
- A press (F or R; since 2026-10-28 T or R, F being the favorite key) on a Chat row when the tab's state says Off puts the state back to the list and opens (the state is reset by anything that
  sets the game's screen type; only a Chat row under the cursor proves the Chat list is up, since only it shows one). Before, that press fell to the
  game's own Contacts action (for F: a call attempt) and was lost.
- A key press a full second after an opening whose page never reported ready starts the opening again (a new generation; the older attempt's
  events are dropped). Before, the second press of a lost first one was ignored for as long as the state said "opening". A click's release and a
  quick second press are not retries (a double popup would follow).
- **Probe lines** (`Phone chat: ...` in the CET log, 120 a session at most, a few per opening): `open: contact=<id> journal=yes|no path=spawn|refresh`,
  `open: state was off with a Chat row selected, put back to the list ...`, `open: pressed again, the page never reported ready, started again ...`,
  `open ignored: the page is already open ...`, `open ignored: not a registered contact ...`, `page ready but not wanted: generation=<n> current=<m>
  state=<s>` (the page arrived for an opening that is no longer wanted: states 0 off, 1 list, 2 opening, 3 conversation), `page focused contact=<id>`,
  `autofocus asked ...` / `autofocus skipped ... (already typing | pad | texting off)`, `page closed, back on the list`. A chat that needed two
  presses shows which of them it was.

The character does not have to be spawned or nearby. Chat lists every character
the mod has a profile for. The shipped phone contacts (`characters/phone-contacts.json`)
appear once the journal has them as active, known contacts, including contacts with no
quest SMS. Every other named profile (Rita Wheeler and the rest) is listed always, with
the game's unknown-caller picture, because the game's journal has no contact for them;
their contact id is their profile key and the list is sorted by name with the others
(about 125 rows, in the phone's own scrolling list). The two ambient residents are not
listed. The characters the player made in the character editor are (2026-10-27, docs/CHARACTER_EDITOR.md "Invite and phone"): each is a contact under its own name, answered through the text provider (Mistral, Local AI or Custom); with Convai answering its Chat is listed but closed, with "This character needs Mistral, Local AI or Custom to answer.". Such a contact can be texted and called (2026-10-27, branch `feat/custom-calls`: a voice call whose window shows her name and the unknown-caller picture, docs/HOLOCALL.md "A Chat row with no journal contact"; with Convai answering the call is refused with the same line as her Chat). Content packs that rename a character show the new name. Newly unlocked contacts are picked up when opening the tab, because each open
reads the journal's active contacts again. The Contacts J/L mapping needs no such
refresh: `companions.registerPhoneContacts` registers every contact in
`characters/phone-contacts.json` once per session, whether or not the game has
unlocked it, so a contact unlocked mid-session is already mapped
(`bridge/phone-contact-mapping.test.mjs`). Replies use the
game's sent/received message bubbles. Private/group text and microphone actions
remain separate in-person conversations, using the player's assigned CET bindings.

## Favorites on the Chat list (2026-10-28, branch `feat/favorites-2`; not yet seen in the game)

Keys on a keyboard (`PhoneChatTabs.reds`): **T** chat, **H** call, **F** favorite. The game has no action for them in the phone's input context (T and H
are not bound there, and F is its confirm, `click`/`proceed`), so they are Codeware key callbacks (`OnConvaiChatListKey`), registered with the list's
inputs (`EnableContactsInput`, like the J and L keys of `PhoneContacts.reds`), acted on only while the Chat list is up (state List: in a conversation they are
letters), once per press (a held key repeats its press). No per-frame work: events only.

F turns the selected contact's favorite on or off. The press sets it in the game's own list at once (`PlayerPuppet.ConvaiPhoneChatSetFavorite`), builds the
Chat list again with the new order and mark, keeping the selection on her (`ConvaiShowChatContacts(id)`, `ConvaiSelectChatContact`), plays a small sound, and queues
a request ("1" or "0" and the contact id) that `mod/phone-chat.lua` `takeFavoriteRequests` takes on its 10 Hz tick and keeps with `convaiFavorites.set('characters', key, on)`
(mod/favorites.lua: the same data as the Companion Manager's stars); the next `pushFavorites` sends the whole list back, which also corrects the game's copy when the change
could not be kept (a full list). F is also the game's confirm, so while F is down and for 0.35 s after it comes up a `click` on the Chat list opens no chat
(`ConvaiPhoneChatFavoriteKeyActive`; it relies on the key callback arriving before the game's action of the same press: to confirm live).

Hints: the keys are drawn from the game's own keyboard art (`base\gameplay\gui\common\input\icons_keyboard.inkatlas`, parts `kb_t`, `kb_h`, `kb_f`) on the game's own
hint widgets (the controller keeps its action, the key box image is replaced; `ConvaiHintBinding.Glyph`, put back by `Redraw`). The row has a third hint (F and a
star) in the hint holder before the chat hint; the bottom bar's left hint (the game's Show all, unused on this tab) is the favorite hint, labelled "Favorite", with a star between the
key and the label. The star is the game's own favorite star of the Ripperdoc (`base\gameplay\gui\fullscreen\ripperdoc\assets\cw_bars_assets.inkatlas`, part `fav_star`, also
`fav_star_small` and `fav_heart`): gold (the phone's own quest gold) for a favorite and the hints' blue for the others. On a pad (last used device) none of this changes: Cross, Triangle, the
game's key boxes, no favorite hint. The V key no longer calls on a keyboard in the Chat list (the `call` action is read only on a pad); inside an open conversation V still calls.

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

## Meetings and texts she sends herself (Immersive invitations)

With Settings > Gameplay > Immersive invitations On, a typed message to a contact the mod can invite carries a **meet offer** (`meetOffer` in the
request: one-use token, where V is, the map waypoint when V set one, the delay and wait in minutes, or only a reason when she cannot come). The bridge
(`bridge/meet-requests.mjs`) answers a clear request with an `action` (`meet-here`, `meet-waypoint`, `cancel-meet`) in `phone-chat-output.json` and the reply text without its
tag; the game accepts it only for the offer it sent. A text a character sends on her own (arrived, stood up, called off) is a phone turn with an `event` and no typed line
(`M.sendEvent`, `bridge/appointment-events.mjs`); it is appended as a received message, announced with a notice, and falls back to a plain localized line when the bridge
cannot write it. Full design: [IMMERSIVE_INVITATIONS.md](IMMERSIVE_INVITATIONS.md).

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
- `phone-chat-style.lua`: matches Chat to the native tab grid and the game's own tab colours,
  hides the reused quest-reply section only in Chat, and restores its previous
  visibility for Messages. An activation guard also rejects stale quest-reply
  events in Chat. The composer uses readable cyan text and an inline Enter/Esc
  placeholder; its separate hint row is used only for service/error status.
  Widget state belongs to the current native tree; no native handles are retained
  across a phone close or save load. The module can be applied live without restarting.
- Tab colours (branch `holocall-face`, 2026-10-15): Chat binds the same style properties as the game's
  Messages and Contacts tabs (`new_phone.inkwidget`, style `hub_menu_style.inkstyle` on the tab panel): icon and
  label `MenuLabel.MainColor` and `MenuLabel.MainOpacity`, the 7-unit underline `MainColors.PanelRed`. The tab's state
  (`Default`, or `Selected` while Chat is shown; set in `PhoneChatTabs.reds` `UpdateHightlight` and by the styler) picks
  red or the active blue, as the game's `UpdateLabelsStates` does for its tabs; the moving active-blue line marks the
  selected tab. No tint is copied. The earlier tint copy walked the icon's children, but the icon is an image with no
  children, so the error stopped it before the underline was coloured, which left it white.
  The bindings are made once, when the styler builds the tab, and a state-dependent binding is only resolved on a state
  change (branch `chat-label`): the new tab is already `Default`, so the icon and label stayed white when the phone first
  opened and turned red only after Chat had been selected once. The build now passes the tab through the other state
  once and then sets the real one.
- `phone-chat.mjs`: catalog-authorized text-only Convai calls and persistent phone
  sessions. No NPC, microphone, local TTS, movement or speech playback is needed.
- `chat-memory-resets.mjs`: reconciles explicit memory-reset intents and results
  into the journal consumed by Lua. It does not write the history file itself.

### First-message latency

The first message to a contact used to pay everything after Enter (measured offline 2026-10-11, one throwaway end user): the character's memory check (`/character/list` 1.6-3.3 s plus `/character/get` 1.5 s, once per character per bridge run), the phone host's browser (0.6 s) and page (0.6 s), the realtime connection (4.9-6.3 s) and then the reply (1.2 s). A later message on the same page is the reply alone (1.2 s). The text reply is never voiced (`ttsEnabled: false`, no audio wait), so none of the wait is speech. While a contact's Chat is open, `phone-chat.lua` publishes it as `chatContact` in `phone-chat-input.json` (written at once when the Chat opens or changes, then with the 3 s heartbeat), and `bridge/phone-warm.mjs` uses a 0.6 s dwell to prepare that contact on the bridge: `PlayerMemory.prepareCharacter` (the same check, no write unless memory has to be enabled) and the text connection through the same route and transport identity the message uses, so the message reuses the page. Nothing is sent: no dialogue, no session, no memory write. It is skipped on a single-session plan (own key), during a talk turn, a recording or a reset, and a failure just leaves the old on-demand behaviour. One unused warm page is kept (an earlier one is released), at most four opens per visit, a keep-alive every 15 s for up to 5 minutes.

An API failure preserves the draft and shows inline status. A newer unsent draft
is not replaced by an earlier request's failure. Fifteen-second heartbeat expiry
cancels service work after exit; a 45-second UI timeout preserves the draft. Late
replies cannot enter a new attachment, and repeated polls do not resend a request.

### Why a message failed (2026-10-19)

The phone's "Message could not be delivered. Please try again." is the catch-all of the whole send, so it never said why (Nexus report, Mei1429).
`bridge/phone-failure.mjs` now names the step (`route`, `binding`, `provider`, `reply`, `publish`) and a reason code for every message that ends in it, and the
bridge does three things with it: one log line (`Phone chat message failed: reason=... stage=... contact=... provider=...`, never the message or the reply),
`runtime/phone-failure-state.json` (last reason, step, provider, and a count per reason; carried by the support report as
`bridge.status["phone-failure-state.json"]`), and the automatic error report for a fault (not for a load or a newer message ending the send).
Reasons: `route-*` (the world or memory route was not ready: `world-unavailable`, `request-not-prepared`, `memory-route-changed`, `world-changed`, `request-expired`),
`contact-unsupported`, `invalid-reply` (empty, over 6,000 characters, or a malformed session id), `world-changed`, `memory-route-changed`, `connection-busy`,
`daily-limit`, `convai-signin` (the shared Convai account could not be signed in to), `convai-busy` (the plan's concurrency limit), `convai-quota`, `convai-speaker-limit`, `convai-memory-needed`, `convai-key-rejected`,
`mistral-*`, `local-*`, `custom-*` (the kind the provider named), `local-unavailable`, `session-rejected`, `timeout`, `browser`, `network`, `cancelled`, `unknown`.

The UI wait for a reply is 45 s for Convai and Mistral, 95 s for Local AI (its turn budget is 80 s, a cold model load included) and 125 s for a custom endpoint (up to 120 s),
read once per sent message through `phoneChat.replyWait` (`mod/init.lua`), so the bridge's own explanation arrives before the draft is given back. Convai's own limits have
their own status lines on the phone, in the words of the game's notices: `quota-shared`, `quota-own`, `key-rejected`, `key-memory-needed` (the daily limit already had one).

A text provider (Mistral, Local AI, the custom endpoint) has no conversation session: its reply carries the id it was given, and the first message of a thread
was given `-1`. The send used to call that reply invalid, so on those providers every phone message ended in the generic text. A reply with no session is now delivered
and no session is remembered; a malformed session id is still refused.

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
  adds “Press Enter to write / Esc to close” inside it (Esc outside the box closes the conversation like the game's C, Esc inside only stops typing; Enter outside the box only focuses it), with an Enter-to-send
  cue while focused. Codeware's 15% placeholder opacity is raised to 75% only here.
- 18 focused phone checks pass, including three new checks for opaque native names,
  stale quest renderers/activation, native visibility restoration and composer hints.
  The user confirmed the updated tabs, cyan input/hint and Enter/Esc typing check
  are all good. This is user visual acceptance; no new screenshot was supplied.
  Normal Messages restoration has automated coverage, not a separate live check.
  No game input was injected and no restart was required for the correction.
- Follow-up: inherited Codeware focus callbacks also reached F6/F8 inputs.
  Placeholder and text-style changes now require a `convaiPhoneComposer` ancestor.
  The world composer keeps mixed-case typing (its box has had no placeholder
  text, and its message line “Type your message to the character.” is hidden
  and takes no layout room, since 2026-10-15; only the title stays); changing the hint never changes a draft. The regression reproduced
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

## Moving in by text (2026-10-25, docs/HOUSEMATES.md)

A phone message to a contact who may be invited can carry a housing offer next to the meeting offer: V's flats (from the quest facts of the purchases), the flat V is in,
the flat she lives in, and Move out. The character answers with a tag at the start of her text (`[stay:corpo]`, `[move-out]`; `bridge/home-requests.mjs`), the game checks it
against the one-use token it sent (`mod/housemates.lua phoneAction`) and moves her in. A message that is only a meeting request still goes to the meeting offer.

## J and L on the Chat tab (2026-10-26)

The J (Invite) and L (Dismiss) marks and keys are on every Chat row (`PhoneContacts.reds`). Since 2026-10-28 (branch `feat/favorites-2`, the owner: they are already on the Chat page) they are on the Chat tab only: the game's own Contacts tab has neither the marks nor the keys (`ConvaiLayoutActions` shows the marks and `ConvaiRequestCompanion` accepts a request only for a Chat row). A row with no journal contact carries her profile key as
id, which `companions.phoneContactKey` resolves to that profile's copy (the same request path as Contacts). While a conversation is open or opening the keys are ignored, so a typed J or L stays a letter.
