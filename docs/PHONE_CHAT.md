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

## Search on the Chat list (2026-10-31, branch `feat/phone-chat-search`, redone on `fix/chat-search-esc`: a row in the list, and the Esc that opened the pause menu fixed. Redscript, GAME RESTART. Not yet seen in the game)

With 700 or more people on the Chat list (the side characters included) the arrow keys, Page Down and the wheel are no way to reach "Panam Palmer". On a keyboard the Chat list has a search.

**The row.** The first row of the Chat list is the search: a dark bar the width of the rows, the thin line the field has, the hint "Type a name to search" (dim, gone with the first letter, back when the row is empty again) and the O key. It is there whenever the Chat list is shown on a keyboard and the Codeware text input is installed, and it is gone on the other tabs, on a pad, and without the text input (a field nobody could type in is not drawn). The tab strip is not touched. The row stays at the top while the list below it scrolls. The list is moved down by the height of the row (100, the height of a Chat row in the phone's 4K layout) and a gap of 12 below it while the row shows, and is put back exactly when it goes (`PhoneChatSearch.reds`, `ConvaiSearchShift`). Only the margin of the scroll area and of its scroll bar is changed, never a size.

**Keys.** **O** (or **/**) or a click on the row puts the keyboard in the row. The hint dims, the O key goes, the box takes the row's place and the first match is selected as you type. The bottom bar shows the key as "O Search" next to the favorite hint, as before.

| In the row | Does |
|---|---|
| a letter or a digit | filters the list (T, H, F, J, L, R, V, A and D are letters here, not the list's keys) |
| Up, Down | moves the selection through the matches (the list wraps) |
| Enter | leaves the row for the list: the selection goes to the first match and the usual list keys work (T chat, H call, F favorite, Up and Down). No chat opens. The search stays in force (the text stays in the row, not focused) until Esc or C, or ends by itself when the row holds no text. With no match Enter does nothing |
| Esc | clears the text, leaves the row, and the whole list is back around the selected person. The Esc does not also close the phone: a second Esc is the game's as before |
| click on a match | opens that chat (the wheel scrolls the matches) |

After Enter, or after a chat is closed again, the search is still there (the row holds the text, not focused): T, H, F, Enter and a click work on the matches as on any list, **O** puts the keyboard back in the row, and Esc (or C) clears the search first. The game's own Enter (its confirm, which would open the chat of the selected row) is the search's until the Enter that left the row has come up, as the Esc is: the list's key callback watches the Enter release too. Changing tab, closing the phone or loading a save also ends it. A search with no text that nobody has the keyboard in ends by itself after about 0.3 s. On a pad there is no row, no key and no hint, as for T, H and F.

**Matching** (`mod/phone-chat.lua` `searchIds`, the same rule as the Companion Manager's name search plus word starts): case and accents are ignored on both sides (an accented Latin letter counts as its plain letter, `ß` as `ss`), a name is split into words at spaces, hyphens and punctuation, and every typed word has to be the start of some word of the name. "pan" and "palm" both find Panam Palmer, "palm pan" does too, "amer" finds nobody. The names searched are the profile names (the roster, the player's own characters, content packs) plus the names the game's journal gives its own contacts (the list sends those along, so "fred" finds Coach Fred). Favorites stay first among the matches, then by name, because the list's own sort is used.

**How it runs.** The resting row is plain ink widgets (a rectangle, a line, a text, a key picture) and costs nothing. Codeware's text input runs an animation tick of its own every frame, so it is made only when the search starts (`ConvaiSearchBoxMake`) and taken away, its tick stopped, when the search ends (`ConvaiSearchBoxDrop`, `ConvaiPhoneSearchInput.Stop`). A change of the text makes the list ask Lua (`PlayerPuppet.ConvaiPhoneChatSearchAsk`, a number that only grows). Lua answers on its 10 Hz tick while the phone is open, with the matching ids (`takeSearch`, `ConvaiPhoneChatSearchResult`), so a filter shows within about a tenth of a second. An answer for older text is dropped, and Enter pressed before the answer leaves the row for the first match of it. The words of the names are made once when the contacts are registered. The list is filled again from the rows it already built (`PhoneChatSearch.reds` keeps them), so a keystroke does not read the journal. An empty text is the whole list at once, with no question. Nothing else runs: no frame hook, no delay.

**Typing is shut off from the game, and cannot outlive the box.** While the box has the keyboard, `PlayerPuppet.ConvaiPhoneChatTyping` is true. `mod/phone-input.lua` then keeps the game's menu keys (Esc, J) shut as it does for the conversation box, the list's key callbacks (T, H, F, J, L, O) stand down, and the phone's own actions that open or call (F, R, V, A and D for the tabs) are swallowed. The wheel and key releases other than those pass. The flag is read live every time Lua asks (`ConvaiSearchTyping`) and is true only while all of this holds: a search is going on, the Chat list is the state, the box has the focus, the phone is open, and every widget from the row up to the top of the phone's window is shown (the game hides the phone's window while a pause, map, journal or inventory menu is open, and the dialer hides itself when the list closes). The Esc that left the box counts too, from its press until it has come up again (the list's key callback sees the release) and two Lua ticks more, never for more than six ticks or a second and a half. On top of that Lua's 10 Hz tick (`ConvaiPhoneChatTick`, which keeps coming while a menu has stopped game time) calls `ConvaiSearchTick`: a search whose phone, list or box is no longer on the screen is let go of whole (focus, box, row, list position), a search nobody uses ends, and the Esc flag ends by itself.

**The dead pause menu (live test, 31 Oct, found and fixed).** With the box focused the owner pressed Esc. The pause menu opened over the phone and then took no input at all (Resume, Save, Load, Settings and Quit all dead, Alt+F4 was the only way out). Cause, read from the code: Esc in the box ended the search, and ending it made the player forget the list (`ConvaiPhoneChatSearchView(null)`), so `ConvaiPhoneChatTyping` fell to false at the very moment of the Esc. The press of the game's pause action had been swallowed while typing, but its release came up after the flag was false, passed `phone-input.lua`, and opened the pause menu over the open phone (the phone holds a modal context, a time dilation and a background blur), a release with no press. The game's own phone avoids this: its list input does `DontSendReleaseEvent` on the pause action's press. Fixed three ways. (1) The press of the pause action that the search swallows now also gets `DontSendReleaseEvent` (`ConvaiSearchHoldsPause`), so no release exists to open anything. (2) The list is remembered by the player until the phone's controller is taken down, not forgotten when a search ends, and the Esc that left the box keeps the flag true until it has come up. (3) The flag and the box are checked against the live widgets and let go of on Lua's tick, as above, so nothing global outlives the box whatever closed the phone.

**Closing and reopening the phone (live test, 31 Oct, found and fixed).** After the phone was closed and opened again the Chat tab showed the search row and nothing below it, no rows and no Call or Chat hints. Cause: the first version also shrank the scroll area to make room for the row, from a size read when the row is shown. The phone makes a new list every time it opens, and when it opens straight on the Chat tab that happens before the list has been laid out, so the size read was empty and the list was left with no room for a row. The size is no longer read or set, only the margin moves. Besides, closing the search for good (a new list is spawned with a screen type set, which closes it) now forgets all the search state of the phone's controller (`ConvaiSearchReset`: open, filter, the question number, the kept rows and ids, the Esc flag, the box), a filter is applied only while its box exists, and closing the phone with a search going (no text, text, or a chat open) lets go of it before the list is removed. A reopened phone shows the whole list with the first row selected.

**Text.** Two texts: **Search**, the bottom bar's hint, and **Type a name to search**, the hint in the empty row. Both are made in English by `PhoneChatSearch.reds` and put in the interface language by `mod/phone-chat-style.lua`, which looks for `convaiSearchHintLabel` and `convaiSearchPlaceholder`. Both are in the catalogue and in the 15 other interface languages (`localization/en.json`, `mod/locales/*.lua`). With no match the game's own empty-list line shows.

**Why O.** The phone keeps the game's gameplay keys alive: movement keys, I, K, M and P (menus) and J are live while it is open, and the Chat list already uses T, H, F, J, L, R and C. O has no binding in the game's input mappings outside debug contexts, and `/` has none at all.

**Where the row sits.** Read from `new_phone.inkwidget` (`contact_list`, read only, 2.5): the list is a virtual list in a scroll area (1100 by 1200, aligned right, 30 from the right) inside a panel whose first child is a gradient mask. The row is a sibling of the scroll area in front of that mask, aligned as the scroll area is, 1000 wide like the Chat rows (`chat_contact` is 1000 by 100). If the live check shows it a little off sideways or the scroll bar not matching, those are the numbers to change (`ConvaiSearchRowMake`, `ConvaiSearchShift`).

Live check (to do, one game restart for the redscript): see TODO.md captain's log, 2026-10-31.


### Search keys and a V who walks (31 Oct Discord report, branch `fix/discord-1101`. Redscript plus Lua, GAME RESTART. Not yet seen in the game)

Many players use a mod that lets V move while the phone is open (texting from the back of a car, or walking). The first search keys were live on the whole Chat state and the search box could take the keyboard while a movement key was down. What changed:

* **O and / are live only on the Chat list itself and with V not moving on foot** (`ConvaiSearchKeysLive`: the Chat list is the phone's state, it is on the screen with no menu over it, and `ConvaiPhoneChatIsFootMoving()` is false). Anywhere else the key does nothing here and stays the game's or another mod's. These key callbacks only watch: they never consume a key, and the one swallowing that exists (`ConvaiSearchSwallows`, `ConvaiChatSwallowsAction`) is only while a box has the keyboard, names no movement action, and lets every release other than the phone's own click actions through.
* **A click on the search bar always works.** The row opens at once. If V is moving on foot at that moment the box takes the keyboard a moment later, on the first 10 Hz tick where V is not moving (`m_convaiSearchWantFocus`, given in `ConvaiSearchTick`, which also keeps a waiting search from counting as idle). Nothing is refused.
* **A box never takes the keyboard while a movement key may be down.** This is the stuck walk of the Talk box (the game's box takes the keyboard, a movement key released meanwhile is never seen, V walks on), kept from the phone. The chat page does the same: its automatic focus keeps its ask while V moves and is given by the same tick (`ConvaiChatAdvanceGuard`), and the opening Enter does nothing while V moves.
* **Where "moving on foot" comes from.** Lua, on the phone tick it already has (`mod/phone-chat.lua` `pushFootMoving`, 10 Hz, only while the phone is open, sent only when the answer changes, false when the phone closes). The reading is the Talk gate's own (`mod/init.lua` `phoneChat.footMoving`, `talkBusy`): a movement axis held with V actually moving, or V still moving from one, and never while V is mounted in a vehicle. A held axis with V standing still (a stale reading) does not count, so nothing can wait for ever. The redscript adds no game call of its own for this and no per-frame work.

With Developer mode on, `probe.log` shows `search: the box waits for the movement keys` when a click had to wait. The Talk timeline lines of the Talk box are unchanged.

Live check (owner), with a phone-moves-with-V mod on and without it: (1) walk with W held, open the phone, press O: nothing happens and V keeps walking. Stop: O opens the search. (2) Walk, click the search bar: the bar goes active, type nothing yet. Let go of W: the cursor is in the box and typing works, V does not walk on. (3) In a car (not driving), O opens the search. (4) Open a chat while walking: the box waits, then takes the keyboard after V stops. After Esc or Enter no movement key sticks (read `probe.log`).

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

**Close hint reads Esc (2026-10-30, branch `fix/esc-close-label`; `PhoneChat.reds`, `PhoneChatTabs.reds`, GAME RESTART).** Live, twice: the close hint read "C CLOSE" in the Chat list's bottom bar and in an AI chat, and Esc is the key that closes. Both hints are the game's key hints bound to its `cancel` action (C). On a keyboard they are now rebound to `OpenPauseMenu`, whose key is Esc: under the Chat list (then under the whole phone window if the list has none) when a Chat row is shown, and under the chat page at set-up and at every focus change. A pad keeps the game's key, and the Chat list puts `cancel` back as soon as another tab shows. C still closes too (the game's own action is untouched); only the hint changed. Not seen working in the game yet: if the glyph does not read Esc, `probe.log` has `Chat list close hint: rebound N cancel hint(s)` (0 means none was found, followed by the panel's hints) and `close hint: no cancel hint found on the chat page`. Compiled against 2.5 and 2.31.
