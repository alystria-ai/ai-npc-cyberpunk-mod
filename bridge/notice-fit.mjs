// How wide a notice is on the game's warning line (WarningMessageGameController): Rajdhani Semi-Bold at 35 pt, UPPER CASE, wrapped at
// 800 px. The numbers are measured from the game's own files (warning_message.inkwidget, raj-semibold.fnt), as the header of
// bridge/daily-notice-fit.test.mjs explains. ADVANCES are the upper-case advances at 35 px for the letters the notice texts use. The
// font has no Cyrillic or CJK glyphs (the game falls back to another font there), so those are estimated: 20 px for a Cyrillic capital,
// 35 px for a full-width character. An estimate: it cannot see the game, it keeps a notice to two lines with room for a word that wraps early.
// Used by the tests of the daily-limit notice and of the setup check's notices (mod/setup-check.lua).
export const WRAP = 800;   // wrappingAtPosition of the text box

const GLYPHS = "0123456789 !\"%&'(),-./:;>?ABCDEFGHIJKLMNOPQRSTUVWXYZ~ÁÉÍÓÖÜČŚŠŮŻ–—’";
const ADVANCES = [
  18, 11, 17, 18, 19, 17, 18, 14, 19, 18, 8, 8, 12, 26, 21, 7, 10, 10, 7, 11, 7, 14, 7, 7, 19, 16, 19, 19, 19, 19, 17,
  16, 19, 20, 9, 18, 19, 16, 25, 20, 19, 18, 20, 19, 19, 15, 20, 18, 28, 18, 18, 18, 19, 19, 17, 9, 19, 19, 20, 19, 19,
  19, 20, 18, 14, 21, 6
];
const CAPITAL = 18.7;      // the average capital, for a letter not in the table
const CYRILLIC = 20, FULL_WIDTH = 35;

function advance(char) {
  const code = char.codePointAt(0);
  if (code === 0xa0 || code === 0x202f) return 8;      // a no-break space (thousands separator) is as wide as a space
  if (code >= 0x0400 && code <= 0x04ff) return CYRILLIC;
  if (code >= 0x2e80) return FULL_WIDTH;
  const at = GLYPHS.indexOf(char);
  return at >= 0 ? ADVANCES[at] : CAPITAL;
}
export const widthOf = text => [...text].reduce((sum, char) => sum + advance(char), 0);

/** Width of each line the text takes in the frame: words wrap at spaces, a full-width character can end a line anywhere. */
export function linesOf(text) {
  const tokens = text.toUpperCase().match(/[⺀-￿]|[^ \t⺀-￿]+|[ \t]+/gu) ?? [];
  const widths = [];
  let used = 0;
  for (const token of tokens) {
    if (/^[ \t]+$/u.test(token)) { if (used > 0) used += widthOf(' '); continue; }
    const width = widthOf(token);
    if (used > 0 && used + width > WRAP) { widths.push(used); used = 0; }
    used += width;
  }
  widths.push(used);
  return widths;
}

// A player's notice is at most two lines: 1,460 px of upper-case text in all for English (about 95 letters), 1,560 px for a translation,
// which leaves room for the word that wraps early (docs/NOTIFICATIONS.md).
export const NOTICE_MAX_ENGLISH = 1460, NOTICE_MAX_TRANSLATION = 1560;

/** What is wrong with a one-paragraph notice: more than two lines, or more upper-case text than the budget. [] when it fits. */
export function noticeProblems(text, {english = false} = {}) {
  const found = [], max = english ? NOTICE_MAX_ENGLISH : NOTICE_MAX_TRANSLATION;
  const lines = linesOf(text), px = Math.round(widthOf(text.toUpperCase()));
  if (/\n/.test(text)) found.push(`has a line break: ${JSON.stringify(text)}`);
  if (lines.length > 2) found.push(`takes ${lines.length} lines: ${text}`);
  if (px > max) found.push(`is ${px} px of upper-case text, more than ${max}: ${text}`);
  return found;
}
