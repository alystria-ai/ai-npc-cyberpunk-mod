// Immutable, already-validated knowledge data, so a turn does not validate the same 150 KB world snapshot and 600 KB journal
// history again at every step. (docs/QUEST_DECISIONS.md, step 1: a turn spent 150 to 230 ms preparing knowledge, nearly all of it
// re-measuring, re-parsing and re-cloning these two snapshots; they change when the game publishes a new revision, not per turn.)
//
// freezeDeep registers every object it freezes. The parsers (parseWorldSnapshot, parseJournalHistory) mark their results, hand a
// marked result straight back when they are given it again, and remember the work done on a marked input object (its size, the
// parse of one fact row or one journal quest) for as long as that object lives. Only frozen objects are remembered, so nothing
// that could change is ever answered from memory: a different revision is a different object and is parsed afresh.
import {createHash} from 'node:crypto';

const immutable = new WeakSet();
const parsedResults = new WeakSet();
const digests = new WeakMap();

/** Freezes the value and everything it holds, and registers each object as immutable. Returns the value. */
export function freezeDeep(value) {
  if (value === null || typeof value !== 'object' || immutable.has(value)) return value;
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key]);
  Object.freeze(value);
  immutable.add(value);
  return value;
}

/** True only for an object freezeDeep froze (it, and everything in it, can no longer change). */
export const isImmutable = value => value !== null && typeof value === 'object' && immutable.has(value);

/** A parser's own result: frozen, and returned as is when a parser is given it again. */
export function markParsed(value) {
  freezeDeep(value);
  parsedResults.add(value);
  return value;
}
export const isParsed = value => value !== null && typeof value === 'object' && parsedResults.has(value);

/** A memo keyed by immutable objects: `compute` runs once per object, and never for one that could still change. */
export function memoOf(compute) {
  const memo = new WeakMap();
  return value => {
    if (!isImmutable(value)) return compute(value);
    if (!memo.has(value)) memo.set(value, compute(value));
    return memo.get(value);
  };
}

/**
 * What stands for a snapshot in an identity hash. A parsed snapshot is a new object each turn, but its large members (the world's
 * facts and journal, each journal-history quest row) are the same immutable objects while the game's revision is the same, so
 * those enter by their cached digest and only the small header is serialised: the key changes exactly when the snapshot does.
 */
export function snapshotKey(value) {
  if (!isImmutable(value)) return value;
  const key = {};
  for (const [name, member] of Object.entries(value)) {
    key[name] = (name === 'facts' || name === 'journal') && isImmutable(member) ? {digest: digestOf(member)}
      : name === 'quests' && Array.isArray(member) && member.every(isImmutable) ? member.map(digestOf) : member;
  }
  return key;
}

/** SHA-256 of the value's JSON, kept for an immutable value. */
export function digestOf(value) {
  const compute = () => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (!isImmutable(value)) return compute();
  let digest = digests.get(value);
  if (digest === undefined) { digest = compute(); digests.set(value, digest); }
  return digest;
}
