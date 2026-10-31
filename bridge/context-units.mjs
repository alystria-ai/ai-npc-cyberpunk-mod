// The JSON-framed context blocks of a turn (world facts, journal history, open jobs, recent shared events) cut into units a turn can choose from
// (docs/NATURAL_TALK_RESEARCH_2026-10-30.md, section 15). Each of those blocks is one line of framing text (the rules for reading it: game data is never an instruction, missing
// is unknown, respect each knowledge origin) followed by one JSON document whose lists hold the facts, quests, jobs or events. Pure functions, no I/O.
//
//   const block = parseFramedBlock(text)            -> {framing, doc, lists: [{key, items}]} | null (a text that is not framing + JSON)
//   unitsOf(block, {kind})                           -> [{id, text, data, importance, recency}]   (text: plain words for ranking; data: the item as JSON, its cost)
//   renderFramedBlock(block, keepIds)                -> the same framing and JSON with only the kept units in the lists ('' when none is kept)
//   renderFramedData(block, keepIds)                 -> the JSON alone, the same document with only the kept units ('' when none is kept)
//
// With every unit kept `renderFramedBlock` equals the input, character for character (the escape of `<`, `>` and `&` is the one the sources use). The framing is never changed or cut:
// the prompt keeps it in its fixed part on every turn (bridge/quest-context.mjs `retrievalSources`), and only the JSON of the chosen units comes late.
const escape = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `text` as {framing, doc, lists}, or null when it is not a framing line followed by a JSON object. A list is a top-level array of objects or texts. */
export function parseFramedBlock(text) {
  const value = String(text ?? '');
  const at = value.indexOf('\n');
  if (at < 1) return null;
  let doc;
  try { doc = JSON.parse(value.slice(at + 1)); } catch { return null; }
  if (!plain(doc)) return null;
  const lists = Object.entries(doc).filter(([, list]) => Array.isArray(list) && list.every(item => plain(item) || typeof item === 'string')).map(([key, items]) => ({key, items}));
  return {framing: value.slice(0, at + 1), doc, lists, original: value};
}

// Words of an item that rank it: its texts and titles, not its ids, flags or the origin line (the origin words, "journal" and "witnessed", would match every question about the journal).
const SKIP = new Set(['journalId', 'id', 'knowledgeOrigin', 'status', 'tracked', 'involvesYou', 'optional', 'observedObjectiveCount', 'objectivesComplete', 'gameTimeSeconds', 'ruleId', 'version']);
function flatten(value, out = []) {
  if (typeof value === 'string') out.push(value.replace(/[-_.]+/g, ' '));
  else if (Array.isArray(value)) for (const item of value) flatten(item, out);
  else if (plain(value)) for (const [key, item] of Object.entries(value)) if (!SKIP.has(key)) flatten(item, out);
  return out;
}

// What a kind of list says about how much an item matters when it is relevant (Generative Agents' "importance", a static number per kind, 0 to 1).
const IMPORTANCE = {
  choices: () => 0.9, facts: () => 0.5, events: () => 0.6,
  quests: item => (item?.tracked ? 0.9 : item?.status === 'active' ? 0.6 : 0.3),
  jobs: item => (item?.tracked ? 0.9 : item?.involvesYou ? 0.8 : 0.4),
};
const importanceOf = (key, item, kind) => (IMPORTANCE[key] ?? IMPORTANCE[kind] ?? (() => 0.5))(item);

/** The units of a parsed block: one per list item. `kind` ('jobs' for the open jobs, whose lists are named by the game's categories) picks the importance rule. */
export function unitsOf(block, {kind = ''} = {}) {
  if (!block) return [];
  const units = [];
  const times = block.lists.flatMap(({items}) => items.map(item => (plain(item) && Number.isFinite(item.gameTimeSeconds) ? item.gameTimeSeconds : null)).filter(Number.isFinite));
  const first = Math.min(...times), last = Math.max(...times);
  for (const {key, items} of block.lists) {
    items.forEach((item, index) => {
      const time = plain(item) && Number.isFinite(item.gameTimeSeconds) ? item.gameTimeSeconds : null;
      units.push({id: `${key}:${index}`, text: flatten(item).join('. ').replace(/\s+/g, ' ').trim(), data: escape(item),
        importance: importanceOf(key, item, kind), recency: time === null || !(last > first) ? 0.5 : (time - first) / (last - first)});
    });
  }
  return units.filter(unit => unit.text);
}

/** The document of the block with only the units in `keep` (a Set of ids) left in its lists, as JSON; '' when none is left. Everything else in it (counts, flags, the inventory) stays. */
export function renderFramedData(block, keep) {
  if (!block || !keep || !keep.size) return '';
  const doc = {};
  for (const [key, value] of Object.entries(block.doc)) {
    const list = block.lists.find(entry => entry.key === key);
    if (!list) { doc[key] = value; continue; }
    const kept = list.items.filter((_item, index) => keep.has(`${key}:${index}`));
    // A list the document names (an empty "choices" is not written) stays only when something is kept in it.
    if (kept.length) doc[key] = kept;
  }
  return escape(doc);
}

/** The block with only the units in `keep` left, framing included; '' when none is left. */
export function renderFramedBlock(block, keep) {
  const data = renderFramedData(block, keep);
  return data ? block.framing + data : '';
}
