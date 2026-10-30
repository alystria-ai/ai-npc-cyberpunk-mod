// Stages that need the character in person (docs/QUEST_PRIMITIVES.md section 11, docs/RELATIONSHIPS_AND_QUESTS.md 7.3).
//
// A pack may begin on a Phone Chat message or a holocall, and V may answer a stage over the phone, but many stages are played by her own copy beside V: her scripted lines
// are `own` lines, a talk gap opens after them, a ride or a hangout seats her next to V. When she is only a voice on the phone those lines have nobody to say them. This file
// works out, from the pack data alone, which stages those are and what to do about it. Pure: no state, no file, nothing per frame.
//
//   inPerson(pack, stage)       {needs, placed, gapId, place, party, why}: whether the stage needs her beside V when it begins, whether the stage already makes her appear
//                               by itself (a cast of her at a place), the talk gap its opening lines lead to (the question she has to ask first), the meeting place, and
//                               whether a party copy is needed (a ride, a seat).
//   rendezvousSpecs(pack, stage) the `do` entries the bridge adds to the play file so she can be got to V: a pin and a cast of her at the meeting place, both only while she
//                               has no copy of V's, and a party join for a ride or a seat.
//   travelGrace(pack, stage)    game seconds added to the stage's timeout when it was entered by words over the phone (V needs time to travel).
//
// The meeting place of a stage is `meetAt` (an optional place id of the pack), else the place its pin marks, else the first place V is sent to.
export const TRAVEL_GRACE_HOURS = 6;
/** Primitives that are played by her copy beside V (a ride needs her in the car, a seat beside V, a hangout activity with V). */
const NEEDS_COPY = new Set(['ride', 'seat', 'together', 'party']);
/** Primitives that need the copy to be one of V's party (the line of sight is not enough). */
const NEEDS_PARTY = new Set(['ride', 'seat']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Whether a script row's line is one she says in person (channel own, the default) and is not a bark. */
function ownLine(pack, row) {
  const line = pack.lines?.[row.say];
  if (!line) return false;
  return (line.channel ?? 'own') === 'own' && row.bark !== true && line.bark !== true && line.kind !== 'bark';
}

/**
 * The events a stage's opening reaches without V doing anything: `stage:enter`, then `line:<id>:done` of the lines its rows say at those events. Each is marked with whether an
 * in-person line of hers stands in the chain (a text row is delivered to the phone and needs nobody beside V).
 */
function openingChain(pack, stage) {
  const reach = new Map([['stage:enter', false]]);
  const rows = Array.isArray(stage.script) ? stage.script : [];
  for (let pass = 0; pass < rows.length + 1; pass++) {
    let grew = false;
    for (const row of rows) {
      if (!plain(row) || typeof row.when !== 'string' || !reach.has(row.when)) continue;
      const person = reach.get(row.when);
      const next = typeof row.say === 'string' && row.bark !== true ? [`line:${row.say}:done`, person || ownLine(pack, row)]
        : typeof row.text === 'string' ? [`line:${row.text}:done`, person] : null;
      if (next && !reach.has(next[0])) { reach.set(next[0], next[1]); grew = true; }
    }
    if (!grew) break;
  }
  return reach;
}

export function inPerson(pack, stage) {
  const out = {needs: false, placed: false, gapId: null, place: null, party: false, why: []};
  if (!plain(pack) || !plain(stage) || plain(stage.meet)) return out;
  if (!stage.do && !stage.script) return out;
  const doList = Array.isArray(stage.do) ? stage.do.filter(plain) : [];
  // The stage makes her appear by itself (a cast of her at a place): V walks there and she is there. It still needs her in person (the note, the clock), but the
  // pack has its own means of getting her there, so none is added, and her question is asked in person when she is.
  out.placed = doList.some(spec => spec.p === 'cast' && (spec.who === 'self' || spec.who === pack.character));
  const reach = openingChain(pack, stage);
  const rows = Array.isArray(stage.script) ? stage.script : [];
  const lines = rows.filter(row => plain(row) && typeof row.say === 'string' && typeof row.when === 'string' && reach.has(row.when) && ownLine(pack, row));
  if (lines.length) out.why.push('own-lines');
  const gapRow = rows.find(row => plain(row) && typeof row.gap === 'string' && typeof row.when === 'string' && reach.get(row.when) === true && pack.gaps?.[row.gap]);
  if (gapRow) { out.gapId = gapRow.gap; out.why.push('gap'); }
  if (doList.some(spec => NEEDS_COPY.has(spec.p))) out.why.push('primitives');
  out.needs = out.why.length > 0;
  if (!out.needs) return out;
  out.party = doList.some(spec => NEEDS_PARTY.has(spec.p));
  const pin = doList.find(spec => spec.p === 'pin' && typeof spec.at === 'string'), place = doList.find(spec => spec.p === 'place' && typeof spec.at === 'string');
  const id = [stage.meetAt, pin?.at, place?.at].find(item => typeof item === 'string' && pack.places?.[item]);
  out.place = id ?? null;
  return out;
}

/** The entries the bridge adds to a stage's `do` list in the play file (after the pack's own), none for a stage that does not need her in person. */
export function rendezvousSpecs(pack, stage) {
  const found = inPerson(pack, stage);
  if (!found.needs) return [];
  const doList = Array.isArray(stage.do) ? stage.do.filter(plain) : [];
  const specs = [];
  if (found.place && !found.placed) {
    if (!doList.some(spec => spec.p === 'pin' && spec.at === found.place)) specs.push({p: 'pin', at: found.place, ifAbsent: true});
    specs.push({p: 'cast', id: 'rendezvous', who: 'self', at: found.place, ifAbsent: true, carry: true});
  }
  if (found.party && !doList.some(spec => spec.p === 'party')) specs.push({p: 'party'});
  return specs;
}

/** Game seconds a stage's timeout is stretched by when V answered it over the phone: travel time V could never meet. */
export function travelGrace(pack, stage) {
  return inPerson(pack, stage).needs ? TRAVEL_GRACE_HOURS * 3600 : 0;
}
