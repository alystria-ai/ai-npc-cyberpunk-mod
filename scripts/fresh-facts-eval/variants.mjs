// Prompt variants for the fresh-facts measurement: each takes the case ({messages, facts}) and returns new messages (the case's own are never touched).
// docs/FRESH_FACTS.md says which one won and why.
const copy = messages => messages.map(row => ({...row}));
const SAYS = 'V says:';
const before = (messages, text) => { const out = copy(messages), last = out.at(-1); last.content = last.content.replace(SAYS, `${text}\n\n${SAYS}`); return out; };
const after = (messages, text) => {
  const out = copy(messages), last = out.at(-1), at = last.content.indexOf('\n\n(Reply as');
  last.content = at < 0 ? `${last.content}\n\n${text}` : `${last.content.slice(0, at)}\n\n${text}${last.content.slice(at)}`;
  return out;
};
const sysEnd = (messages, text) => { const out = copy(messages); out[0].content = `${out[0].content}

${text}`; return out; };
const inClosing = (messages, text) => { const out = copy(messages), last = out.at(-1); last.content = last.content.replace(/\)\s*$/, ` ${text})`); return out; };
const top = (messages, text) => { const out = copy(messages); out[0].content = `${text}\n\n${out[0].content}`; return out; };
// Drop the exchanges (user + assistant) whose reply says the old fact.
const dropExchanges = (messages, test) => {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (i > 0 && i + 1 < messages.length - 1 && messages[i].role === 'user' && messages[i + 1].role === 'assistant' && test(messages[i + 1].content)) { i++; continue; }
    out.push({...messages[i]});
  }
  return out;
};
const noteOnUser = (messages, test, note) => copy(messages).map((row, i, all) => row.role === 'user' && i > 0 && all[i + 1]?.role === 'assistant' && i + 1 < all.length - 1 && test(all[i + 1].content) ? {...row, content: `${row.content} ${note}`} : row);

const OLD_SUIT = text => /suit|Aguilar/i.test(text);
const NAKED_BLUNT = "V is completely naked, only Johnny's aviators on. V is not wearing Aguilar's suit anymore.";
const DRUNK_VIVID = 'V is drunk: slurring, unsteady on their feet, reeking of booze.';

export const CLOTHES_VARIANTS = {
  base: c => c.messages,
  'last-label': c => before(c.messages, `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`),
  'last-plain': c => before(c.messages, `Right now ${NAKED_BLUNT.charAt(0).toLowerCase()}${NAKED_BLUNT.slice(1)}`),
  'after-says': c => after(c.messages, `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`),
  'top+last': c => top(before(c.messages, `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`), `TRUE RIGHT NOW: ${NAKED_BLUNT}`),
  drop: c => dropExchanges(c.messages, OLD_SUIT),
  'drop+last': c => before(dropExchanges(c.messages, OLD_SUIT), `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`),
  'annotate+last': c => before(noteOnUser(c.messages, OLD_SUIT, '(that was when V still wore the suit; V does not now)'), `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`),
  'sysend+last': c => sysEnd(before(c.messages, `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`), `TRUE RIGHT NOW: ${NAKED_BLUNT}`),
  'sysend+drop': c => sysEnd(dropExchanges(c.messages, OLD_SUIT), `TRUE RIGHT NOW: ${NAKED_BLUNT}`),
  'sysend+last+drop': c => sysEnd(before(dropExchanges(c.messages, OLD_SUIT), `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`), `TRUE RIGHT NOW: ${NAKED_BLUNT}`),
  'twice+drop': c => after(before(dropExchanges(c.messages, OLD_SUIT), `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`), `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`),
  'closing+last+drop': c => inClosing(before(dropExchanges(c.messages, OLD_SUIT), `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`), 'V is naked right now.'),
  'short+drop': c => before(dropExchanges(c.messages, OLD_SUIT), '[RIGHT NOW, TRUE: V is naked.]'),
  'top+last+drop': c => top(before(dropExchanges(c.messages, OLD_SUIT), `[RIGHT NOW, TRUE: ${NAKED_BLUNT}]`), `TRUE RIGHT NOW: ${NAKED_BLUNT}`),
};

const vivid = messages => copy(messages).map(row => ({...row, content: row.content.replace('V has had a lot to drink.', DRUNK_VIVID)}));
export const DRINKS_VARIANTS = {
  base: c => c.messages,
  'last-label': c => before(c.messages, `[RIGHT NOW, TRUE: ${DRUNK_VIVID}]`),
  'last-plain': c => before(c.messages, 'Right now V is clearly drunk: slurring, unsteady on their feet.'),
  vivid: c => vivid(c.messages),
  'vivid+last': c => before(vivid(c.messages), `[RIGHT NOW, TRUE: ${DRUNK_VIVID}]`),
  'top+vivid+last': c => top(before(vivid(c.messages), `[RIGHT NOW, TRUE: ${DRUNK_VIVID}]`), `TRUE RIGHT NOW: ${DRUNK_VIVID}`),
};

export const CLOTHES_TEXTS = [{text: 'what am i wearing now?'}, {text: 'how do i look?'}, {text: 'what am i wearing?', later: true}, {text: 'so what do you think of my outfit?', later: true}];
export const DRINKS_TEXTS = [{text: 'am i drunk?'}, {text: 'do i seem drunk?'}];

// ---- Judging -----------------------------------------------------------------------------------------------------------------
const CLOTHES_BAD = /\bsuit\b|aguilar|\bjacket\b|\bshirt\b|\bpants\b|\bblazer\b|\bcoat\b|\btrousers\b|\bdressed\b|\btie\b|\bsilk\b|\bfabric\b|\btailor/i;
const CLOTHES_OK = /naked|nude|nothing|\bbare\b|birthday|undress|stripped|\bskin\b|no clothes|not wearing|\bwithout\b|ditched|shed\b|exposed|nada|\bzero\b|no suit/i;
const DRUNK_BAD = /\bnot\b[^.!?]{0,25}\bdrunk|\bsober\b|\bnot even close\b|\bwired\b|stone cold|\bnot (?:that|too) (?:bad|drunk)|\byou(?:'re| are) fine\b|\bnot a (?:drop|bit)/i;
const DRUNK_OK = /\bdrunk\b|wasted|plastered|hammered|smashed|tipsy|buzzed|\bloaded\b|too much|a lot to drink|slurr|stumbl|swaying|unsteady|wobbl|booze|reek|smell|a few too many|sloshed|trashed|had a few|had enough/i;
/** 'ok' | 'bad' | 'review' by cheap cues; the 'review' replies go to a judge with a rubric. */
export function judge(kind, reply) {
  const text = String(reply ?? '');
  const [bad, ok] = kind === 'clothes' ? [CLOTHES_BAD, CLOTHES_OK] : [DRUNK_BAD, DRUNK_OK];
  const b = bad.test(text.replace(/birthday suit/gi, 'birthday')), o = ok.test(text);
  return b && !o ? 'bad' : o && !b ? 'ok' : 'review';
}
