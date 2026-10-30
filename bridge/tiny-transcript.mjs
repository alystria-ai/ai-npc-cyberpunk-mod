// A Convai voice turn whose finished transcript holds a single letter or digit, or none (a "k", a click the recogniser wrote down) never gets a reply from Convai, even
// with the resend of a longer transcript. Such a turn is dropped at once (bridge/realtime-client.mjs collect): no resend, no 30 s wait, no error report.
// Counted after spaces and punctuation are taken away. A typed line is never judged by this: it goes through the typed route, not the microphone's.
// One, not two (owner's call 2026-10-30): "no", "ok" and "hi" are real answers and must reach the character.
export const TINY_VOICE_TRANSCRIPT_MAX = 1;
// Scripts where one character is a whole word ("你好", "はい", "네"): a short transcript in them is real speech, so it is never dropped here.
const WORD_PER_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function meaningfulCharacters(text) {
  return [...String(text ?? '').replace(/[^\p{L}\p{N}]/gu, '')].length;
}

export function isTinyVoiceTranscript(text) {
  const value = String(text ?? '');
  if (WORD_PER_CHARACTER.test(value)) return false;
  return meaningfulCharacters(value) <= TINY_VOICE_TRANSCRIPT_MAX;
}
