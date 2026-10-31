// Fair starts for the story packs (docs/REAL_QUESTS.md section 7, docs/STORY_PACKS_INACTIVE.md). Pure: no state, no file, nothing per frame.
//
// The owner's live test of 31 Oct 2026 (Judy, "The Claws Come Calling"): the pack started while V typed to Judy in person, with Judy in V's party. Its first stage is a call-in,
// which only rings at a calm moment, so it never rang while V talked. Its clock (1 game hour, about 8 real minutes) ran from the start anyway and ended the pack with a
// bond penalty of 15 for a quest V never saw. The rules below make that impossible, for every pack:
//
//   startAllowed(pack, who)     a pack that opens with a call starts only when she is apart from V (a phone chat or a holocall, not beside V, not in V's party);
//   presentedAtStart(...)       whether the start turn itself already showed the stage to V (the bring-up was spoken or written in the reply) or the game still has to
//                               show it (a call that has to ring). The stage's timeout clock starts only once it was presented;
//   CALL_SHOWN                  the game events that mean a call was shown: it rang, was answered, was missed or was texted;
//   timeoutHours(pack, stage)   the pack's own hours are only a minimum: a first stage and a stage that sends V somewhere get at least START_FLOOR_HOURS;
//   penalty(pack, next)         whether a timeout that goes to this ending costs bond points (then it needs V to have accepted).
export const START_FLOOR_HOURS = 6;
/** A stage that waited for its call to be shown and never got it is withdrawn without a penalty after this many game hours. */
export const UNSEEN_WITHDRAW_HOURS = 24;
/** A pack withdrawn unseen or unaccepted is not offered again for this many game days. */
export const WITHDRAWN_DAYS = 1;
/** The events of a call-in that mean V was shown the call (call:<id>:ringing | answered | missed | texted), and the one that means V took it. */
export const CALL_SHOWN = /^call:([a-z][a-z0-9-]*):(ringing|answered|missed|texted)$/;
export const CALL_ANSWERED = /^call:([a-z][a-z0-9-]*):answered$/;

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

/**
 * Did the start turn itself show the first stage to V? A stage with no call is shown by the reply of the turn (spoken, or written in the Phone Chat), and so is a call
 * opening started in a holocall (she says it on the call). A call opening started in a phone chat or in person is shown only when the call rings.
 */
export function presentedAtStart(pack, stage, channel) {
  if (!hasCallIn(stage)) return true;
  return channel === 'holocall';
}

/** Whether a stage sends V somewhere or waits for a meeting (an arrival at a place, a meeting, a call that rings): V needs time to get there. */
export function travelStage(stage) {
  if (!plain(stage)) return false;
  if (plain(stage.meet)) return true;
  if (hasCallIn(stage)) return true;
  return (Array.isArray(stage.choices) ? stage.choices : []).some(choice => typeof choice?.on === 'string' && (/^event:place:[a-z][a-z0-9-]*:arrived$/.test(choice.on) || choice.on.startsWith('meet:')));
}

/** The game hours a stage's timeout really runs: the pack's own number is a minimum, raised for a first stage and for a stage V must travel to. 0 when the stage has no timeout. */
export function timeoutHours(pack, stage) {
  const own = stage?.timeout?.gameHours;
  if (!Number.isFinite(own) || own <= 0) return 0;
  const first = pack?.stages?.[0]?.id === stage.id;
  return first || travelStage(stage) ? Math.max(own, START_FLOOR_HOURS) : own;
}

/** Whether going to `next` (an ending id) costs bond points. A stage id costs nothing here. */
export function penalty(pack, next) {
  const ending = plain(pack?.endings) && typeof next === 'string' ? pack.endings[next] : null;
  return plain(ending) && Number.isFinite(ending.bond) && ending.bond < 0;
}
