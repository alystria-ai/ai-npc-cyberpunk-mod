// 30 Oct live test (twice): the phone's close hint read "C CLOSE" in the Chat list's bottom bar and inside an AI chat, and Esc is the key that closes. The hint is bound to the game's
// `cancel` action (C). On a keyboard it is rebound to the pause-menu action, whose key is Esc: every key hint under the Chat list (then the whole phone window) and under the chat page
// that is bound to `cancel`. A pad keeps the game's own key. Put back when the list shows another tab. Compiled against 2.5 and 2.31 by scripts/Compile-Redscript.ps1.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('');
const chat = read('../r6/scripts/CyberpunkConvai/PhoneChat.reds');
const tabs = read('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds');

test('the helper rebinds cancel to the pause-menu action and back, on a depth-bounded walk', () => {
  assert.match(tabs, /public static func CloseToEsc\(root: ref<inkWidget>, depth: Int32\) -> Int32 \{\s*return ConvaiHintBinding\.SwapAction\(root, depth, n"cancel", n"OpenPauseMenu"\);/);
  assert.match(tabs, /public static func EscToClose\(root: ref<inkWidget>, depth: Int32\) -> Int32 \{\s*return ConvaiHintBinding\.SwapAction\(root, depth, n"OpenPauseMenu", n"cancel"\);/);
  assert.match(tabs, /if IsDefined\(display\) && Equals\(display\.GetInputAction\(\), from\) \{ display\.SetInputAction\(to\); count \+= 1; \};/);
  assert.match(tabs, /if depth <= 0 \|\| !IsDefined\(parent\) \{ return count; \};/);
});

test('the Chat list rebinds its close hint on a keyboard when a Chat row is shown, looks in the whole phone window if the list has none, and puts C back on other tabs', () => {
  const method = tabs.slice(tabs.indexOf('private func RefreshInputHints(contactData: wref<ContactData>)'));
  const chatBranch = method.indexOf('contactData.convaiChat'), rebind = method.indexOf('ConvaiHintBinding.CloseToEsc(top, 8)');
  assert.ok(chatBranch > 0 && rebind > chatBranch, 'inside the Chat branch');
  assert.match(method, /if IsDefined\(player\) && player\.PlayerLastUsedKBM\(\) \{\s*let top = this\.GetRootWidget\(\);/);
  // One level at a time, stopping at the first level that holds a cancel hint (never the whole screen's hints).
  assert.match(method, /if found == 0 \{[^}]*while found == 0 && up < 6 && IsDefined\(top\) && IsDefined\(top\.GetParentWidget\(\)\)[^}]*found = ConvaiHintBinding\.CloseToEsc\(top, 9\);\s*\};/s);
  // Found again as zero (already rebound) never forgets the record.
  assert.match(method, /if IsDefined\(top\) && found > 0 \{\s*this\.m_convaiCloseEsc = true;\s*this\.m_convaiCloseRoot = top;\s*\};/);
  assert.doesNotMatch(method, /this\.m_convaiCloseEsc = IsDefined\(top\) && found > 0;/);
  // Anything else on the list puts the hints back, through the one restore.
  assert.match(method, /\} else \{[^}]*this\.ConvaiHintsRestore\(\);/s);
  const restore = tabs.slice(tabs.indexOf('public final func ConvaiHintsRestore() -> Void'));
  const restoreBody = restore.slice(0, restore.indexOf('\n}\n'));
  assert.match(restoreBody, /if this\.m_convaiCloseEsc \{\s*if IsDefined\(this\.m_convaiCloseRoot\) \{ ConvaiHintBinding\.EscToClose\(this\.m_convaiCloseRoot, 9\); \};\s*this\.m_convaiCloseEsc = false;\s*this\.m_convaiCloseRoot = null;/);
  assert.match(restoreBody, /ConvaiHintBinding\.Rebind\(inkWidgetRef\.Get\(this\.m_action2ButtonWidget\), this\.m_convaiCallHintAction\);/);
  assert.match(restoreBody, /this\.ConvaiKeyGlyphsRestore\(\);/);
  assert.match(tabs, /private let m_convaiCloseEsc: Bool;/);
});

test('when nothing is bound to cancel the Chat list says so and writes the panel\'s hints to the log, once per session', () => {
  assert.match(tabs, /if !this\.m_convaiHintsTraced \{\s*this\.m_convaiHintsTraced = true;\s*player\.ConvaiPhoneChatTrace\("Chat list close hint: rebound "/);
  assert.match(tabs, /if found == 0 \{\s*let described = ConvaiHintBinding\.Describe\(inkWidgetRef\.Get\(this\.m_inputHintsPanel\), 6\);/);
});

test('an AI chat page keeps the native close hint visible and shows Esc on it at set-up and at every focus change; a normal message page is untouched', () => {
  assert.match(chat, /if !this\.m_data\.convaiChat \{\s*inkWidgetRef\.SetVisible\(this\.m_hintClose, true\);/);
  assert.match(chat, /inkWidgetRef\.SetVisible\(this\.m_hintClose, true\);\s*this\.ConvaiChatCloseKey\(\);\s*inkWidgetRef\.SetVisible\(this\.m_scrollReply, false\);/);
  assert.match(chat, /wrappedMethod\(isFocused\);\s*\/\/[^\n]*\n\s*if this\.m_data\.convaiChat \{ this\.ConvaiChatCloseKey\(\); \};/);
  assert.match(chat, /private final func ConvaiChatCloseKey\(\) -> Void \{\s*let player = this\.m_player as PlayerPuppet;\s*if !IsDefined\(player\) \|\| !player\.PlayerLastUsedKBM\(\) \{ return; \};/, 'keyboard only');
  assert.match(chat, /ConvaiHintBinding\.CloseToEsc\(this\.GetRootWidget\(\), 8\)/);
  assert.match(chat, /close hint: no cancel hint found on the chat page/);
});

test('the lines the player reads name Esc, never C, and nothing is per frame', () => {
  assert.match(chat, /"ENTER  Write message   \/   ESC  Close"/);
  assert.match(chat, /"ENTER  Write \/ Send   \/   ESC  Stop typing"/);
  assert.doesNotMatch(chat.replace(/^\s*\/\/.*$/gm, ''), /"[^"\n]*\bC\s+CLOSE[^"\n]*"/i);
  assert.doesNotMatch(tabs, /OnUpdate|\bUpdate\(/, 'no per-frame hook in the tabs file');
});

// 1 Nov 2026 (owner, game 2.5): H for a holocall opened the game's menu. The rebinds and the keys of the Chat list belong to the Chat list only and go when it goes.
test('the Chat list puts every hint it rebound back when the phone\'s list closes or is taken down, not only when another contact is shown, and not while a conversation has the focus', () => {
  const closed = tabs.slice(tabs.indexOf('protected cb func OnContactListClosed() -> Bool {'));
  const closedBody = closed.slice(0, closed.indexOf('\n}\n'));
  assert.match(closedBody, /this\.m_contactListLogicController\.ConvaiHintsRestore\(\); \};\s*return wrappedMethod\(\);/);
  const uninit = tabs.slice(tabs.indexOf('protected cb func OnUninitialize() -> Bool {'));
  const uninitBody = uninit.slice(0, uninit.indexOf('\n}\n'));
  assert.match(uninitBody, /this\.m_contactListLogicController\.ConvaiHintsRestore\(\); \};\s*this\.ConvaiChatListKeysStop\(\);/);
  assert.match(uninitBody, /return wrappedMethod\(\);/);
  // DisableContactsInput also runs while a conversation has the focus: the list's hints stay as they are for its return.
  const disable = tabs.slice(tabs.indexOf('public func DisableContactsInput() -> Void'));
  assert.doesNotMatch(disable.slice(0, disable.indexOf('\n}\n')), /ConvaiHintsRestore/);
});

test('T, H and F act only while the phone is open on the Contacts screen with no thread list or page over it, as J and L do: a callback that outlives the list does nothing', () => {
  const callback = tabs.slice(tabs.indexOf('private cb func OnConvaiChatListKey(evt: ref<KeyInputEvent>) -> Void'));
  const body = callback.slice(0, callback.indexOf('\n}\n'));
  const guard = /if !this\.m_player\.ConvaiPhoneIsOpen\(\) \|\| NotEquals\(this\.m_screenType, PhoneScreenType\.Contacts\) \|\| this\.m_threadsVisible \|\| this\.m_messagesPanelVisible \{ return; \};/;
  assert.match(body, guard);
  // The guard sits before the first thing the keys do, and the releases (which only end a hold) are handled before it.
  assert.ok(body.search(guard) > body.indexOf('if !pressed {'), 'releases first');
  assert.ok(body.search(guard) < body.indexOf('this.ConvaiSearchKey(key)'), 'before the search keys');
  assert.ok(body.search(guard) < body.indexOf('this.ConvaiChatListHolocall(selected)'), 'before the call');
  // J and L of PhoneContacts.reds use the same three conditions.
  const contacts = read('../r6/scripts/CyberpunkConvai/PhoneContacts.reds');
  assert.match(contacts, /NotEquals\(this\.m_screenType, PhoneScreenType\.Contacts\)\s*\|\| this\.m_threadsVisible \|\| this\.m_messagesPanelVisible/);
});

test('nothing in the mod maps H to anything but the Chat list call, and no hint is rebound to a game action outside the phone', () => {
  const sources = ['Composer', 'Engagement', 'Face', 'Holocall', 'KeyBinds', 'Manager', 'PhoneChat', 'PhoneChatSearch', 'PhoneChatTabs', 'PhoneContacts', 'QuestLog', 'Locomotion']
    .map(name => [name, read(`../r6/scripts/CyberpunkConvai/${name}.reds`)]);
  for (const [name, source] of sources) {
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    const targets = [...code.matchAll(/ConvaiKeyTarget\(EInputKey\.IK_H\b/g)].length;
    assert.equal(targets, name === 'PhoneChatTabs' ? 2 : 0, `${name}: key targets on H`);
    assert.doesNotMatch(code, /SetInputAction\(n"OpenPauseMenu"\)/, `${name} rebinds a hint outside ConvaiHintBinding`);
  }
  // Both targets (press, and the release a game 2.31 needs) are the Chat list's own callback.
  const tabs2 = sources.find(([name]) => name === 'PhoneChatTabs')[1];
  const start = tabs2.indexOf('private final func ConvaiChatListKeysStart() -> Void');
  const startBody = tabs2.slice(start, tabs2.indexOf('\n}\n', start));
  assert.equal([...startBody.matchAll(/IK_H\b/g)].length, 2);
  // The only users of the pause-menu rebind are the two helpers and the two pages that call them.
  const users = sources.flatMap(([name, source]) => [...source.replace(/^\s*\/\/.*$/gm, '').matchAll(/CloseToEsc\(/g)].map(() => name));
  assert.deepEqual([...new Set(users)].sort(), ['PhoneChat', 'PhoneChatTabs']);
});
