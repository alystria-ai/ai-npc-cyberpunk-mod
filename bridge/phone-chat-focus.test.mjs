import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Opening a character's chat page puts the keyboard focus in the message box (docs/PHONE_CHAT.md, "Focus on open"). The game is not
// available offline, so these are static checks of PhoneChat.reds; the live check is in the TODO.md captain's log.
const code = readFileSync(new URL('../r6/scripts/CyberpunkConvai/PhoneChat.reds', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const body = name => new RegExp('func ' + name + String.raw`\([^)]*\) -> \w+ \{([^]*?)\n\}`).exec(code)?.[1];

test('the box is focused by the chat page\'s own paint, once per opening, and never from the Chat list', () => {
  const focus = [...code.matchAll(/@if\(ModuleExists\("Codeware\.UI\.TextInput"\)\)\n@addMethod\(PhoneMessagePopupGameController\)\nprivate final func ConvaiChatAutoFocus\(\) -> Void \{([^]*?)\n\}/g)][0]?.[1];
  assert.ok(focus, 'ConvaiChatAutoFocus exists');
  // Only the chat page itself (the list is NewHudPhoneGameController and has no box), a chat that can be written to, and the armed opening.
  assert.match(focus, /^\s*if !this\.m_convaiChatAutoFocus \{ return; \};/);
  assert.match(focus, /!this\.m_data\.convaiChat \|\| !this\.m_isFocused \|\| !this\.m_convaiChatEnabled \|\| !IsDefined\(this\.m_convaiChatInput\) \{ return; \};/);
  // One attempt per opening, spent before anything can fail.
  assert.match(focus, /this\.m_convaiChatAutoFocus = false;\s*if /);
  // Texting must be allowed, and the player must be on keyboard and mouse: a pad has no Esc to leave a box that swallows every action.
  assert.match(focus, /!this\.m_phoneSystem\.IsTextingEnabled\(\) \|\| !this\.m_player\.PlayerLastUsedKBM\(\)/);
  assert.match(focus, /this\.m_convaiChatInput\.GuardEnter\(0\.5\);\s*this\.RequestSetFocus\(this\.m_convaiChatInput\.GetRootWidget\(\)\);/);
  // Called from the paint Lua asks for, after the lines are set: nothing per frame, nothing on a timer.
  assert.match(body('ConvaiChatPresent'), /ConvaiChatSetLines\(lines\);\s*this\.ConvaiChatAutoFocus\(\);\s*$/);
  assert.equal([...code.matchAll(/this\.ConvaiChatAutoFocus\(\)/g)].length, 1, 'no other caller');
  assert.doesNotMatch(code, /ConvaiChatAutoFocus[^]*?(?:DelayCallback|DelaySystem|OnUpdate|OnTick)/);
});

test('the arming follows the page\'s focus: armed on gaining it, gone on losing it', () => {
  const setFocus = /private func SetFocus\(isFocused: Bool\) -> Void \{([^]*?)\n\}/.exec(code)[1];
  assert.match(setFocus, /this\.m_convaiChatAutoFocus = isFocused && this\.m_data\.convaiChat;/);
  // The chat is opened through OnGotFocus -> SetFocus(true); the setup path calls SetFocus(false) first.
  assert.match(code, /protected cb func OnGotFocus\(evt: ref<FocusSmsMessagerEvent>\) -> Bool \{\s*if this\.m_data\.convaiChat \{\s*this\.SetFocus\(true\);/);
  assert.match(code, /private func SetupData\(\) -> Void \{[^]*?this\.SetFocus\(false\);/);
});

test('the keys keep their meaning: Esc stops typing and the second Esc closes, Enter sends, nothing the list uses reaches the box', () => {
  // Typing still swallows the game's actions and Esc still blurs the box without closing the chat.
  assert.match(code, /public final func ConvaiChatEscape\(\) -> Void \{\s*this\.m_convaiChatEscape = true;\s*this\.m_convaiChatEscapeFrames = 0;\s*this\.ConvaiChatBlur\(\);/);
  assert.match(code, /if this\.ConvaiChatTyping\(\) \{\s*if this\.ConvaiChatSwallowsAction\(action\)/);
  assert.match(code, /if Equals\(ListenerAction\.GetType\(action\), gameinputActionType\.BUTTON_PRESSED\) \{ this\.RequestUnfocus\(\); \};/);
  // The manual Enter path is unchanged (it still holds the Enter that opened the box).
  assert.match(code, /this\.m_convaiChatInput\.HoldEnter\(\);\s*this\.RequestSetFocus\(this\.m_convaiChatInput\.GetRootWidget\(\)\);/);
  // The Chat list code never touches the box, so J, L and V on a row are not eaten by it.
  const tabs = readFileSync(new URL('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds', import.meta.url), 'utf8');
  assert.doesNotMatch(tabs, /m_convaiChatInput|ConvaiChatAutoFocus|RequestSetFocus/);
});

test('the Enter that opened the chat cannot send: no Enter counts as a send for half a second after the automatic focus, and a focus loss clears it', () => {
  assert.match(code, /IACT_Press\) && !this\.m_enterHeld\s*&& \(this\.m_enterGuardUntil <= 0\.0 \|\| this\.m_owner\.ConvaiChatNow\(\) >= this\.m_enterGuardUntil\) \{ this\.m_submit = true; \};/);
  assert.match(code, /public final func GuardEnter\(seconds: Float\) -> Void \{ this\.m_enterGuardUntil = this\.m_owner\.ConvaiChatNow\(\) \+ seconds; \}/);
  assert.match(code, /protected cb func OnFocusLost\(evt: ref<inkEvent>\) \{[^]*?this\.m_enterGuardUntil = 0\.0;/);
  assert.match(code, /public final func ConvaiChatNow\(\) -> Float \{\s*return EngineTime\.ToFloat\(GameInstance\.GetEngineTime\(this\.m_player\.GetGame\(\)\)\);/);
  // Without Codeware the stand-in has the method too, so the scripts compile either way.
  assert.match(code, /@if\(!ModuleExists\("Codeware\.UI\.TextInput"\)\)\npublic class ConvaiPhoneChatInput[^]*?public final func GuardEnter\(seconds: Float\) -> Void \{\}/);
  assert.match(code, /@if\(!ModuleExists\("Codeware\.UI\.TextInput"\)\)\n@addMethod\(PhoneMessagePopupGameController\)\nprivate final func ConvaiChatAutoFocus\(\) -> Void \{\n\}/);
});
