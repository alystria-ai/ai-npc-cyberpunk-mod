// Romance with any character through the bond system (docs/SIDE_ROMANCE.md, Settings > Companions > Character bonds).
//
// V leads. A romance starts when V asks (or says they are in love) and the character's own trait allows it (bridge/romance-traits.mjs: open to romance, from
// which bond level, and why not). The bridge decides, the model only voices the decision in character: the same rule as the bond itself ("what the character says
// never moves the bond"). V ends it the same way, by saying so. Nothing starts from a timer and nothing flirts unprompted.
//
//   BEFORE the reply   a typed or transcribed line that proposes (or ends) puts one volatile note in the turn: say yes / not yet / no / take the break up, in your own
//                      way. A spoken turn has no words yet (the game sends a placeholder), so it gets the same decision as a conditional note ("if V now says ...").
//   AFTER the reply    the decision is applied once the reply is published: the state is kept here for the session and handed to the game through the bond status
//                      (bridge/bonds.mjs romanceChange), which writes it into the save (mod/romance-registry.lua).
//
// State: 'together' | 'ended' | none. The game is the truth: every private turn's `bonds` block carries the saved state of that character (mod/bonds.lua), so the
// state is per save and follows a load. A decision made here is kept as an overlay until the game's block says the same (the write can lag a turn).
import {traitOf, shippedTraits} from './romance-traits.mjs';
import {screenRomance, hasWords} from './romance-intent.mjs';
import {HURT_NOTE_FROM, bondable} from './bonds.mjs';

export const STATES = Object.freeze(['together', 'ended']);
export const romanceState = value => STATES.includes(value) ? value : null;
const TURN_LIMIT = 64;
/** A spoken turn carries the answer to a proposal only from this bond level (a stranger's words are not met with a standing answer). */
export const SPOKEN_FROM_LEVEL = 4;
/** A turn's id: a talk turn's request id, a Phone Chat message's id. */
const turnId = input => typeof input?.requestId === 'string' && input.requestId ? input.requestId : typeof input?.id === 'string' && input.id ? input.id : null;

const BODY = Object.freeze({
  accept: 'V is asking you to be together, or has told you they love you. You feel the same way and you know V well enough: say yes, in your own way and in your own voice '
    + '(warm, shy, blunt, amused, formal, whatever is true of you), and say what it means to you in a sentence or two. Not a speech, no plans, no promises you cannot keep, and nothing sexual unless V leads. {reason}',
  defer: 'V is asking you to be together, or has told you they love you. You care about V, but you do not know V well enough yet, and you are not ready: tell V so honestly and kindly, in your own way and in your own voice. '
    + 'It is too soon, not never: do not reject V, do not give a time or a condition, do not lecture. {reason}',
  sting: 'V is asking you to be together, or has told you they love you. V hurt or insulted you recently and it still stings, so this is not the moment: say so in your own way and in your own voice, without cruelty, and without ruling out the future.',
  refuse: 'V is asking you to be together, or has told you they love you. You would not, and never will: {reason} Say no in your own way and in your own voice, plainly and without a lecture, '
    + 'and keep the friendship as it stands. Do not give in, do not leave the door open, do not apologise for who you are, and do not make a speech.',
  // V asks again, or says they love you, while the two are together already (a game romance on Auto, or one that started here): the answer of a partner, never a first yes or a not yet.
  already: 'V is asking you to be together, or has told you they love you, and you two are together already. Answer the way V\'s partner would, in your own way and in your own voice, in a sentence or two '
    + '(warm, teasing, plain, whatever is true of you). Do not treat it as something new, and do not hold back or say it is too soon.',
  end: 'V is ending the relationship between you. It is over, and you accept that: react the way you truly would, in your own voice (hurt, angry, calm, sad, relieved, dignified), in a sentence or two. '
    + 'Do not beg, bargain, threaten or try to talk V out of it unless that is truly who you are, and do not make a speech.',
});
/** The words of a decision for the turn's note, with the character's own reason filled in. */
export function decisionNote(decision, trait) {
  const reason = trait?.reason ? (decision === 'refuse' ? `Your reason: ${trait.reason}` : `What you are like: ${trait.reason}`) : '';
  return (BODY[decision] ?? '').replace('{reason}', reason).replace(/\s+$/, '');
}
// The same decisions for a spoken turn (the words are not known yet): short, a condition, and a reminder never to start it.
const SPOKEN = Object.freeze({
  accept: 'If V says now that they love you or want to be together with you: you feel the same and know V well enough, so say yes in your own way, in a sentence or two. {reason}',
  defer: 'If V says now that they love you or want to be together with you: you care about V but it is too soon for you, so say so kindly in your own way, without rejecting V or lecturing. {reason}',
  sting: 'If V says now that they love you or want to be together with you: V hurt or insulted you recently and it still stings, so say not now, in your own way, without cruelty.',
  refuse: 'If V says now that they love you or want to be together with you: you would never, {reason} Say no in your own way, plainly, and keep the friendship as it stands.',
  end: 'If V says now that they are ending the relationship between you: it is over and you accept it, so react the way you truly would, in your own voice, in a sentence or two, without begging or threats.',
});
function spokenNote(decision, trait) {
  const reason = trait?.reason ? (decision === 'refuse' ? `because ${trait.reason.charAt(0).toLowerCase()}${trait.reason.slice(1)}` : `What you are like: ${trait.reason}`) : '';
  return `${(SPOKEN[decision] ?? '').replace('{reason}', reason).replace(/\s+$/, '')} Otherwise say nothing of it and never bring it up yourself.`;
}

/** What a character does when V asks: 'accept' | 'defer' | 'sting' | 'refuse' | null (already together, or V did not ask). */
export function decideProposal({trait, level, hurt = 0, state}) {
  if (state === 'together') return null;
  if (!trait.open) return 'refuse';
  if (!(level >= trait.from)) return 'defer';
  return hurt > HURT_NOTE_FROM ? 'sting' : 'accept';
}

export class RomanceBond {
  /**
   * traits   the table (bridge/romance-traits.mjs)     bonds   the Bonds object (romanceChange) or null     log   (line) => void
   */
  constructor({traits = shippedTraits(), bonds = null, log = () => {}} = {}) {
    Object.assign(this, {traits, bonds, log});
    this.cache = new Map();     // profile key -> {state, worldToken, generation}: the state of the last block of a turn (a reaction has none)
    this.overlay = new Map();   // profile key -> {state, worldToken, generation}: a decision the game has not written yet
    this.turns = new Map();     // request id -> the turn's decision
  }

  #same(row, boundary) { return !!row && !!boundary && row.worldToken === boundary.worldToken && row.generation === boundary.generation; }

  /** A turn carried a `bonds` block: its `romance` is the saved state of this character (null: none). A decision still waiting for the game's write stays until the game agrees. */
  noteBlock(profileKey, state, boundary) {
    if (!bondable(profileKey) || !boundary) return;
    const saved = romanceState(state);
    this.cache.set(profileKey, {state: saved, worldToken: boundary.worldToken, generation: boundary.generation});
    const waiting = this.overlay.get(profileKey);
    if (waiting && (!this.#same(waiting, boundary) || waiting.state === saved)) this.overlay.delete(profileKey);
    while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
  }

  /** The state of a character in this world now: a waiting decision, else the last saved state seen on a turn (a reaction has no block), else null. */
  stateFor(profileKey, boundary) {
    const waiting = this.overlay.get(profileKey);
    if (this.#same(waiting, boundary)) return waiting.state;
    const seen = this.cache.get(profileKey);
    return this.#same(seen, boundary) ? seen.state : null;
  }

  /**
   * The decision of a private turn, once per request id: {decision, spoken, note} or null. `input.text` is V's line (empty or the recording placeholder for a spoken turn);
   * `facts`: {together (the relationship block says partner), ended, level, hurt}.
   */
  forTurn(input, {together = false, ended = false, level = 1, hurt = 0} = {}) {
    const id = turnId(input);
    if (id && this.turns.has(id)) return this.turns.get(id).turn;
    let turn = null;
    if (input?.bonds?.on && !input.group && !input.reaction && !input.head && bondable(input.profileKey)) {
      const trait = traitOf(input.profileKey, this.traits), state = together ? 'together' : ended ? 'ended' : null;
      const spoken = !hasWords(input.text);
      const kind = spoken ? null : screenRomance(input.text);
      // The decision a proposal would get now (a spoken turn: the one it would get if V proposes), and the break up (only while together).
      const propose = decideProposal({trait, level, hurt, state});
      if (!spoken) {
        const decision = kind === 'end' ? (together ? 'end' : null) : kind === 'propose' ? (together ? 'already' : propose) : null;
        if (decision) turn = {decision, spoken: false, kind, note: decisionNote(decision, trait)};
      } else if (together || (propose && level >= SPOKEN_FROM_LEVEL)) {
        // Both a proposal and a break up may be spoken; only the one that can happen now gets a note.
        const decision = together ? 'end' : propose;
        turn = {decision, spoken: true, kind: together ? 'end' : 'propose', note: spokenNote(decision, trait)};
      }
      if (turn) turn.together = together;
    }
    if (id) {
      this.turns.set(id, {turn});
      while (this.turns.size > TURN_LIMIT) this.turns.delete(this.turns.keys().next().value);
    }
    return turn;
  }

  /** The note a turn's context carries ('' for none). */
  noteFor(input, facts) { return this.forTurn(input, facts)?.note ?? ''; }

  /**
   * The reply was published: carry out the decision. A spoken turn is read now, from the transcript (`userText`): only a line that really proposes (or ends it) counts.
   * Returns the change {profileKey, state} or null. Never throws.
   */
  afterTurn(input, userText, boundary) {
    try {
      const id = turnId(input);
      const turn = id ? this.turns.get(id)?.turn : null;
      if (!turn || !boundary) return null;
      let decision = turn.decision;
      if (turn.spoken) {
        const kind = screenRomance(userText);
        if (kind !== turn.kind) return null;
      }
      let state = null;
      if (decision === 'accept') state = 'together';
      else if (decision === 'end') state = 'ended';
      if (!state) return null;
      this.overlay.set(input.profileKey, {state, worldToken: boundary.worldToken, generation: boundary.generation});
      this.cache.set(input.profileKey, {state, worldToken: boundary.worldToken, generation: boundary.generation});
      const name = typeof input.name === 'string' ? input.name.slice(0, 80) : '';
      const change = this.bonds?.romanceChange?.(input.profileKey, name, state) ?? {profileKey: input.profileKey, state};
      this.log(`profile=${input.profileKey} romance=${state}${turn.spoken ? ' (spoken)' : ''}`);
      this.turns.delete(id);
      return change;
    } catch (error) {
      this.log(`romance failed: ${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  /** Forget (the memory reset) does not touch a romance: it is the save's. A new world drops what was seen of the old one. */
  reset() { this.cache.clear(); this.overlay.clear(); this.turns.clear(); }
}
