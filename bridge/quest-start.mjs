// Fair starts for the story packs (docs/REAL_QUESTS.md section 7, docs/STORY_PACKS_INACTIVE.md). Pure: no state, no file, nothing per frame.
//
// The owner's live test of 31 Oct 2026 (Judy, "The Claws Come Calling"): the pack started while V typed to Judy in person, with Judy in V's party. Its first stage is a call-in,
// which only rings at a calm moment, so it never rang while V talked, and a clock ended the pack with a bond penalty of 15 for a quest V never saw. The owner then decided
// (1 Nov 2026) that these quests have no time limit at all, so the clock is gone and what is left of the fair start rules is where a pack may start:
//
//   startAllowed(pack, who)     a pack that opens with a call starts only when she is apart from V (a phone chat or a holocall, not beside V, not in V's party).
//   WITHDRAWN_DAYS              a pack V abandoned is not offered again for this many game days.
/** A pack V abandoned is not offered again for this many game days. */
export const WITHDRAWN_DAYS = 1;

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const doList = stage => (Array.isArray(stage?.do) ? stage.do.filter(plain) : []);

/** Whether a stage has a call that rings V (a call-in): it is shown by the game, when the game is calm, and not by the turn that brought it on. */
export const hasCallIn = stage => doList(stage).some(spec => spec.p === 'call-in');
/** Whether the pack opens with a call. */
export const opensWithCall = pack => hasCallIn(pack?.stages?.[0]);
/** Whether the first stage casts the pack's character at a place (she is made to stand there; a party member is never moved for it, see mod/quest-prims.lua). */
export const castsHerAtStart = pack => doList(pack?.stages?.[0]).some(spec => spec.p === 'cast' && (!spec.who || spec.who === 'self' || spec.who === pack?.character));

/**
 * May this pack start on this turn? `who`: {channel ('own' | 'phone' | 'holocall'), near (she is within a few metres of V), party (she is one of V's party)}.
 * A pack that opens with a call starts only on the phone or a holocall with her apart from V: in person nobody could ring, and beside V or in V's party the call and the
 * place it sends V to make no sense (she would be told to stay away from the person next to her). Returns {ok: true} or {ok: false, why}.
 */
export function startAllowed(pack, {channel, near = false, party = false} = {}) {
  if (opensWithCall(pack)) {
    if (channel === 'own') return {ok: false, why: 'it opens with a call and V is talking to her in person, so it waits for a phone chat or a holocall with her apart'};
    if (near) return {ok: false, why: 'it opens with a call and she is beside V, so it waits until they are apart'};
    if (party) return {ok: false, why: 'it opens with a call and she is in V\'s party, so it waits until they are apart'};
  }
  return {ok: true};
}
