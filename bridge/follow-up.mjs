// "Follow-up questions" (Settings > Conversations, off by default).
//
// Conversations should not feel one-sided, as if only the player is interested in talking. With the setting on, the
// character sometimes shows real interest in the player and pulls the conversation along: it asks about something
// specific the player just said or did, follows up on something from earlier, or shares a small thought that invites
// an answer. Like Natural speech, the FREQUENCY is decided by the bridge (a model told to "sometimes" does it every
// time or never); the model decides whether and how a pull fits the moment and the character.
//
// Hard rules, all in this file:
//   - It only SHAPES the reply Convai is already generating for this turn. It adds a paragraph to that turn's dynamic
//     context and nothing else: no request, no timer, no delayed or second line (bridge/follow-up.test.mjs).
//   - Off, nothing changes: contextFor returns '' and no state is kept, so the context is byte-identical to before.
//   - Never offered on: automatic reactions and barks, battle turns, group rounds, a player who is saying goodbye,
//     a player who gives an order or request, or right after the character's own reply ended in a question; never on
//     two turns in a row; a warm or neutral character is offered one at least once in any PITY_TURNS turns.
// Pure functions plus one small state holder: no I/O, so it can be tested without the bridge.
import {traitFor} from './emotion-analysis.mjs';

export {traitFor};

// The share of eligible turns on which the block is offered, by how expressive the character is (traitFor). The turn
// after an offered one never offers, so the real share of offered turns is lower than these numbers.
export const OFFER_RATE = Object.freeze({warm: .45, neutral: .35, dry: .20, cold: .15});
// A warm or neutral character is offered a pull at least once in any PITY_TURNS conversation turns (when one is allowed).
export const PITY_TURNS = 5;
const PITY_TRAITS = Object.freeze(['warm', 'neutral']);

// The block. It is a pull inside THIS reply: the answer comes first, and the pull flows out of it (a question about
// what the player just said, a follow-up on something earlier, a small thought or story that invites a reply), in the
// character's own manner. The reply length is not constrained (the user: longer replies are fine).
export const FOLLOW_UP_TEXT = [
  'For this reply only, the note above about not asking questions to keep the conversation going does not apply: show that you are interested in the player as well, the way people keep a conversation going between them.',
  'Answer what they said first, then turn it back toward them in the same breath, or end with one short line that draws them in: ask the one thing you actually want to know about what they just said or did, pick up something from earlier in your conversation, or offer a small thought, opinion or story of your own that invites a reply.',
  'Say it plainly, in your own voice and manner (a guarded or blunt person does it bluntly, a warm one warmly): one question at most, never a choice between two alternatives for them to pick from, never a therapist\'s question, and never a detail they did not give you.',
  'This is part of this one reply, not an extra message: it grows out of your answer and never feels tacked on, and nothing in it needs a second message from you.',
  'Never interrogate, and never ask something generic such as "what about you?" or "anything else?"; if they asked you something, give your own answer and ask about their actual situation, not the same question handed back.',
  'A pull does not have to be a question.',
  'Ask nothing if the moment calls for just listening or the player seems to be wrapping up.',
].join(' ');

// ---- What the player's text and the character's last reply look like ------------------------------------------

// A word boundary that also works for any script (\b only knows ASCII letters).
const L = String.raw`(?<![\p{L}\p{N}'’])`, R = String.raw`(?![\p{L}\p{N}'’])`;
const words = list => new RegExp(`${L}(?:${list.join('|')})${R}`, 'iu');

// The player is saying goodbye or wrapping the conversation up. Simple and multilingual; unclear text is not an ending
// (a pull on a turn that was only almost one is harmless, the wording itself tells the model to hold back).
const ENDING = words([
  // English
  'goodbye', 'good-bye', 'bye', 'bye-bye', 'good ?night', 'night night', 'nighty', 'farewell', 'cya', 'ttyl', 'laters',
  'see (?:you|ya)(?: (?:later|soon|tomorrow|around|then|in the morning))?', 'talk (?:to you )?(?:later|tomorrow|soon)',
  'catch (?:you|ya) later', 'take care', 'until next time', 'gotta (?:go|run|head out|bounce)', 'got to (?:go|run|head out)',
  'have to (?:go|run|head out)', 'need to (?:go|run|head out)', "i(?:'m| am) (?:leaving|heading out|off|out of here|going to bed|going to sleep)",
  'time for bed', "that(?:'s| is) all(?: for now)?", "we(?:'re| are) done(?: here| talking)?", 'end of (?:the )?conversation',
  // Spanish, Portuguese, French, German, Italian
  'adi[óo]s', 'hasta (?:luego|ma[ñn]ana|pronto|la vista)', 'nos vemos', 'chao', 'buenas noches', 'me voy', 'tengo que irme',
  'tchau', 'at[ée] (?:logo|amanh[ãa]|mais)', 'boa noite', 'tenho que ir', 'vou (?:indo|embora|dormir)',
  'au revoir', '[àa] (?:bient[ôo]t|demain|plus tard|la prochaine)', 'bonne nuit', 'je dois y aller', 'je m\'en vais',
  'tsch[üu]ss?', 'auf wiedersehen', 'bis (?:bald|sp[äa]ter|morgen|dann)', 'gute nacht', 'ich muss los', 'mach\'s gut',
  'ciao', 'arrivederci', 'a (?:dopo|domani|presto)', 'buonanotte', 'buona notte', 'devo andare',
  // Japanese, Korean, Chinese, Russian, Ukrainian, others
  'さようなら', 'さよなら', 'またね', 'じゃあね', 'じゃあ、?また', 'おやすみ', '行ってくる', 'もう行く', '안녕히 (?:가세요|계세요)', '잘 ?가', '잘 ?자', '다음에 봐', '이만 가',
  '再见', '再見', '拜拜', '晚安', '我走了', '回头见', '明天见', '下次见',
  'до свидания', 'пока', 'до встречи', 'до завтра', 'спокойной ночи', 'мне пора', 'на добраніч', 'до побачення',
  'tạm biệt', 'hej då', 'tot ziens', 'do widzenia', 'pa pa',
]);

// The player gives an order or makes a request of the companion (follow, wait, go home, take me somewhere). The
// companion-action detection itself is the model's, per turn (bridge/companion-actions.mjs offers the actions); there is
// no pre-turn detector, so this is a short list of command shapes. A question such as "can you explain ..." is not one.
const ACTION_VERBS = [
  'follow (?:me|us)', 'wait(?: here| there| for (?:me|us)| up| a (?:sec|second|minute|moment|bit))?', 'stay (?:here|there|put|close|behind|back|out|with (?:me|us))',
  'come (?:with|here|along|over|to|back|on in|and)', 'go (?:home|away|back|there|first|ahead of|wait|check|see|get|find|and|to)', 'drive', 'take (?:me|us)', 'get (?:in|out|down|behind|over|back|lost|away|up)',
  'meet (?:me|us)', 'cover (?:me|us)', 'watch (?:my|our) back', 'hold (?:on|here|up|position|this|the line)', 'stop (?:here|right there|the car|following)',
  'leave (?:me|us|now|the|this place)', 'bring (?:me|us|it|him|her|them)', 'pick (?:me|us|it|him|her|them)', 'open', 'shoot', 'attack', 'fight', 'run (?:away|home|for)',
  'hurry', 'move (?:it|out|over|aside|along)', 'back off', 'stand (?:here|there|guard|down)', 'sit (?:down|here)', 'head (?:home|out|back|there|to)',
  'let (?:me|us) (?:in|out|go|through)', 'help (?:me|us)', 'give (?:me|us)', 'hand (?:me|it|over)', 'drop (?:it|that|me|us)'].join('|');
const VERB = String.raw`(?:${ACTION_VERBS})(?![\p{L}])`;
const ORDER_START = new RegExp(String.raw`^\s*(?:(?:hey|ok|okay|alright|all right|please|now|and|so|right|listen|look)[,.!]?\s+)*(?:please\s+)?${VERB}`, 'iu');
const ORDER_POLITE = new RegExp([String.raw`(?:can|could|would|will) you(?: please)?\s+${VERB}`,
  String.raw`(?:i need|i want|i'd like|i would like) you to\s+${VERB}`,
  String.raw`you (?:need|have|ought|should|must) to\s+${VERB}`,
  String.raw`you can go${R}|you(?:'re| are) (?:free|dismissed)|let(?:'|’)s (?:go|get out|get moving|move|head|leave|roll|bounce)${R}|get lost${R}|we(?:'|’)re done here`].join('|'), 'iu');
const ORDER_OTHER = words([
  // Spanish, Portuguese, French, German, Italian
  's[íi]gueme', 'esp[ée]ra(?:me)?', 'qu[ée]date', 'v[áa]monos', 'ven conmigo', 'vete', 've a casa', 'ven(?: aqu[íi])?', 'sube', 'llévame', 'll[ée]vame',
  'me segue', 'siga-?me', 'fica(?: aqui)?', 'vamos embora', 'vai (?:para|pra) casa', 'vem comigo', 'espere',
  'suis-?moi', 'attends(?:-moi)?', 'reste(?: ici)?', 'viens(?: avec moi)?', 'rentre chez toi', 'allons-y', 'on y va',
  'folge mir', 'warte(?: hier)?', 'bleib(?: hier)?', 'komm(?: mit)?', 'geh(?: nach hause)?', 'lass uns gehen', 'los geht',
  'seguimi', 'aspetta(?:mi)?', 'resta(?: qui)?', 'vieni(?: con me)?', 'vai a casa', 'andiamo',
  // Japanese, Korean, Chinese, Russian
  'ついてきて', '待って', '来て', '帰って', 'ここで待', '行こう', '따라와', '기다려', '이리 와', '집에 가', '가자',
  '跟我来', '跟我走', '等一下', '等等', '等我', '回家', '过来', '走吧', '留在这',
  'иди за мной', 'подожди', 'стой', 'жди', 'иди домой', 'пойдем', 'пойдём', 'за мной', 'оставайся',
]);

/** Does the player's text say goodbye? */
export const playerIsEnding = text => typeof text === 'string' && ENDING.test(text);
/** Does the player's text give an order or make a request of the companion? */
export const playerGivesOrder = text => typeof text === 'string'
  && (ORDER_START.test(text) || ORDER_POLITE.test(text) || ORDER_OTHER.test(text));

// Closing marks and the tags the bridge removes from display text, which may still follow the last question mark.
const TRAILING = /[\s"'”’»)\]}*_~]+$/u;
const TAGS_AT_END = /(?:\s*(?:\[[a-z]+(?:-[a-z]+)*\]|\{[a-z]+(?::(?:strong|subtle))?\}))+\s*$/iu;
/** Did a reply end with a question? (? ？ ؟, optionally followed by quotes, brackets or voice/emotion tags.) */
export function endsWithQuestion(text) {
  if (typeof text !== 'string') return false;
  let value = text.replace(TAGS_AT_END, '').replace(TRAILING, '');
  // "?!", "?..." and "?!?" still end in a question.
  value = value.replace(/([?？؟])[!.…?？؟]+$/u, '$1');
  return /[?？؟]$/u.test(value);
}

// ---- The setting and its per-conversation state ----------------------------------------------------------------

/**
 * The setting plus a little per-conversation memory, keyed by the conversation (the bridge passes its route session key,
 * which exists from the first turn). `enabled` follows runtime/settings.json (a missing or unreadable file leaves it as
 * it was). Off, no state is kept and `contextFor` returns '' without reading anything.
 */
export class FollowUp {
  constructor() { this.enabled = false; this.state = new Map(); this.decisions = new Map(); }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.followUpInterest === true, changed = next !== this.enabled;
    this.enabled = next;
    if (!next) { this.state.clear(); this.decisions.clear(); }
    return changed;
  }
  /**
   * The context block for one turn: FOLLOW_UP_TEXT on an offered turn, '' otherwise (and always while off). The
   * decision is made once per `turn` (the request id), so a rebuilt context agrees with the one already sent.
   * The other fields describe the turn: the player's words and what kind of turn it is.
   */
  contextFor({sessionId, turn, trait = 'neutral', text, reaction = false, battle, group = false, random = Math.random} = {}) {
    if (!this.enabled) return '';
    return this.offers({sessionId, turn, trait, text, reaction, battle, group, random}).offered ? FOLLOW_UP_TEXT : '';
  }
  /**
   * Whether this turn is one where a pull is offered, as {offered, reason}. Reasons when not offered: 'reaction'
   * (an automatic reaction or bark), 'battle', 'group', 'ending', 'order', 'after-offer' (never two in a row),
   * 'after-question' (her previous reply already ended in a question) and 'rate' (the dice). When offered: 'pity'
   * or 'rate'. Reactions and barks are not conversation turns: they change no state.
   */
  offers({sessionId, turn, trait = 'neutral', text, reaction = false, battle, group = false, random = Math.random} = {}) {
    if (turn !== undefined && this.decisions.has(turn)) return this.decisions.get(turn);
    const key = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
    const state = (key && this.state.get(key)) || {offeredLast: false, endedWithQuestion: false, since: 0};
    let decision, counts = true;
    if (reaction) { decision = {offered: false, reason: 'reaction'}; counts = false; }
    else if (battle?.status === 'fighting') decision = {offered: false, reason: 'battle'};
    else if (group) decision = {offered: false, reason: 'group'};
    else if (playerIsEnding(text)) decision = {offered: false, reason: 'ending'};
    else if (playerGivesOrder(text)) decision = {offered: false, reason: 'order'};
    else if (state.offeredLast) decision = {offered: false, reason: 'after-offer'};
    else if (state.endedWithQuestion) decision = {offered: false, reason: 'after-question'};
    else if (PITY_TRAITS.includes(trait) && state.since >= PITY_TURNS - 1) decision = {offered: true, reason: 'pity'};
    else decision = random() < (OFFER_RATE[trait] ?? OFFER_RATE.neutral) ? {offered: true, reason: 'rate'} : {offered: false, reason: 'rate'};
    // Only a decision tied to a turn id changes state: a context rebuilt without one must not count as a second turn.
    if (turn !== undefined) {
      if (key && counts) {
        this.state.delete(key);
        this.state.set(key, {...state, offeredLast: decision.offered, since: decision.offered ? 0 : state.since + 1});
        while (this.state.size > 64) this.state.delete(this.state.keys().next().value);
      }
      this.decisions.set(turn, decision);
      while (this.decisions.size > 64) this.decisions.delete(this.decisions.keys().next().value);
    }
    return decision;
  }
  /** The reason of a turn already decided, or undefined (the setting was off, or the turn never built a context). */
  reasonFor(turn) { return turn === undefined ? undefined : this.decisions.get(turn)?.reason; }
  /** Whether a turn already decided was offered. */
  offeredFor(turn) { return turn === undefined ? false : this.decisions.get(turn)?.offered === true; }
  /**
   * Remembers whether a finished reply ended in a question, for its conversation; returns that answer (for the log
   * line). The next turn is not offered a pull right after a question. No state is kept while the setting is off.
   */
  record(sessionId, reply) {
    const asked = endsWithQuestion(reply);
    if (!this.enabled || typeof sessionId !== 'string' || !sessionId) return asked;
    const state = this.state.get(sessionId) ?? {offeredLast: false, endedWithQuestion: false, since: 0};
    this.state.delete(sessionId);
    this.state.set(sessionId, {...state, endedWithQuestion: asked});
    while (this.state.size > 64) this.state.delete(this.state.keys().next().value);
    return asked;
  }
}
