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
  assert.match(method, /if found == 0 \{[^}]*while up < 6 && IsDefined\(top\) && IsDefined\(top\.GetParentWidget\(\)\)[^}]*\};\s*found = ConvaiHintBinding\.CloseToEsc\(top, 9\);/s);
  assert.match(method, /if this\.m_convaiCloseEsc \{\s*ConvaiHintBinding\.EscToClose\(this\.m_convaiCloseRoot, 9\);\s*this\.m_convaiCloseEsc = false;/);
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
