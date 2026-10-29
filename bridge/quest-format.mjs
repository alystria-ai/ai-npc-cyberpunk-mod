// Format 2 of a story pack (docs/QUEST_PRIMITIVES.md section 2): the places, lines, gaps and images of a pack, and the `do` and `script` of its stages. The checks
// the validator in bridge/bond-packs.mjs calls. Pure. Every problem is a short English sentence that says where it is.
import {checkPrimitive, raisable, isCoreEvent, isEventName, isId, PRIMITIVES} from './quest-primitives.mjs';
import {CHOICE_KINDS} from './bond-packs.mjs';

export const QUEST_LIMITS = Object.freeze({places: 24, lines: 80, gaps: 8, images: 8, script: 24, doEntries: 12, gapNote: 600, history: 200, ask: 240, lineText: 300,
  placeName: 80, resumeMin: 10, resumeMax: 7200});
export const LINE_CHANNELS = Object.freeze(['own', 'holocall', 'head', 'remote']);
export const EMOTIONS = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'fear', 'surprise', 'shrug', 'emphatic', 'nod', 'disgust', 'joy', 'calm']);
export const AUDIO_FILE = /^audio\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.wav$/;
const LINE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const IMAGE_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const DISTRICT = /^[A-Za-z][A-Za-z0-9_ ]{1,40}$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(value);
const finite = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** True when the pack uses anything of format 2 (a format 1 pack may not). */
export function usesFormat2(pack) {
  if (!plain(pack)) return false;
  if (pack.places !== undefined || pack.lines !== undefined || pack.gaps !== undefined || pack.images !== undefined) return true;
  if ((pack.stages ?? []).some(stage => plain(stage) && (stage.do !== undefined || stage.script !== undefined))) return true;
  return Object.values(plain(pack.endings) ? pack.endings : {}).some(ending => plain(ending) && (ending.script !== undefined || ending.history !== undefined));
}

/** The place ids a `do` entry refers to (for the play file: only the places a stage uses are sent). */
export function placesOf(entries) {
  const found = new Set();
  const add = value => { if (typeof value === 'string') found.add(value); };
  for (const spec of Array.isArray(entries) ? entries : []) {
    if (!plain(spec)) continue;
    for (const key of ['at', 'to', 'deadZone']) add(spec[key]);
    for (const key of ['checkpoints', 'route']) if (Array.isArray(spec[key])) spec[key].forEach(add);
  }
  return [...found];
}

/** The line ids and image keys a list of script rows refers to. */
export function referencesOf(rows) {
  const lines = new Set(), images = new Set(), gaps = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!plain(row)) continue;
    if (typeof row.say === 'string') lines.add(row.say);
    if (typeof row.text === 'string') lines.add(row.text);
    if (typeof row.image === 'string') images.add(row.image);
    if (typeof row.gap === 'string') gaps.add(row.gap);
  }
  return {lines, images, gaps};
}

/**
 * The top-level fields. Returns the context the stage checks use: {places: Set, lines: Map, gaps: Map, images: Map}.
 */
export function checkPackExtras(pack, fail, warn) {
  const ctx = {places: new Set(), lines: new Map(), gaps: new Map(), images: new Map()};
  if (pack.places !== undefined) {
    if (!plain(pack.places) || Object.keys(pack.places).length > QUEST_LIMITS.places) fail(`places must be an object of up to ${QUEST_LIMITS.places} places`);
    else for (const [id, place] of Object.entries(pack.places)) {
      const where = `place ${id}`;
      if (!isId(id)) { fail(`${where}: the id must be lowercase letters, digits or hyphens`); continue; }
      ctx.places.add(id);
      if (!plain(place)) { fail(`${where} must be an object`); continue; }
      if (!text(place.name, QUEST_LIMITS.placeName)) fail(`${where}: name must be 1 to ${QUEST_LIMITS.placeName} characters`);
      if (place.radius !== undefined && !finite(place.radius, 3, 400)) fail(`${where}: radius must be from 3 to 400 metres`);
      if (place.district !== undefined && !(typeof place.district === 'string' && DISTRICT.test(place.district))) fail(`${where}: district is not a district name`);
      const hasXyz = place.x !== undefined || place.y !== undefined || place.z !== undefined;
      if (hasXyz && !(finite(place.x, -100000, 100000) && finite(place.y, -100000, 100000) && finite(place.z, -10000, 10000))) fail(`${where}: x, y and z must all be numbers`);
      if (!hasXyz) warn(`${where}: no position captured yet (the developer probe "quest capture:${id}" writes one): a stage that waits on it only ends by its timer`);
      else if (place.captured === false) warn(`${where}: the position is a guess and must be captured in the game`);
    }
  }
  if (pack.images !== undefined) {
    if (!plain(pack.images) || Object.keys(pack.images).length > QUEST_LIMITS.images) fail(`images must be an object of up to ${QUEST_LIMITS.images} pictures`);
    else for (const [key, image] of Object.entries(pack.images)) {
      if (!IMAGE_KEY.test(key)) { fail(`image ${key}: the key must be lowercase letters, digits or hyphens`); continue; }
      ctx.images.set(key, image);
      if (!plain(image) || typeof image.file !== 'string' || !/^images\/[a-z0-9][a-z0-9_\/-]{0,80}\.(?:png|jpe?g|webp)$/.test(image.file)
        || !Number.isInteger(image.width) || image.width < 1 || image.width > 4096 || !Number.isInteger(image.height) || image.height < 1 || image.height > 4096) {
        fail(`image ${key} needs file (images/<name>.png inside the pack), width and height in pixels`);
      }
    }
  }
  if (pack.lines !== undefined) {
    if (!plain(pack.lines) || Object.keys(pack.lines).length > QUEST_LIMITS.lines) fail(`lines must be an object of up to ${QUEST_LIMITS.lines} lines`);
    else for (const [id, line] of Object.entries(pack.lines)) {
      const where = `line ${id}`;
      if (!LINE_ID.test(id)) { fail(`${where}: the id is not a line id`); continue; }
      ctx.lines.set(id, line);
      if (!plain(line)) { fail(`${where} must be an object`); continue; }
      if (!text(line.text, QUEST_LIMITS.lineText)) fail(`${where}: text must be 1 to ${QUEST_LIMITS.lineText} characters (English)`);
      else if (line.text.includes(';')) fail(`${where}: text has a semicolon, use a comma or a full stop`);
      if (line.emotion !== undefined && !EMOTIONS.includes(line.emotion)) fail(`${where}: emotion must be one of ${EMOTIONS.join(', ')}`);
      if (line.gesture !== undefined && !(typeof line.gesture === 'string' && /^[a-z][a-z0-9_-]{1,31}$/.test(line.gesture))) fail(`${where}: gesture is not a gesture name`);
      if (line.channel !== undefined && !LINE_CHANNELS.includes(line.channel)) fail(`${where}: channel must be one of ${LINE_CHANNELS.join(', ')}`);
      if (line.audio !== undefined && !(typeof line.audio === 'string' && AUDIO_FILE.test(line.audio))) fail(`${where}: audio must be audio/<name>.wav inside the pack`);
      if (line.speaker !== undefined && !(typeof line.speaker === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(line.speaker))) fail(`${where}: speaker is not a profile key`);
      if (line.audio === undefined) warn(`${where}: no prepared audio yet, it is shown as a subtitle (spoken by the live voice only in Developer mode)`);
    }
  }
  if (pack.gaps !== undefined) {
    if (!plain(pack.gaps) || Object.keys(pack.gaps).length > QUEST_LIMITS.gaps) fail(`gaps must be an object of up to ${QUEST_LIMITS.gaps} gaps`);
    else for (const [id, gap] of Object.entries(pack.gaps)) {
      const where = `gap ${id}`;
      if (!isId(id)) { fail(`${where}: the id must be lowercase letters, digits or hyphens`); continue; }
      ctx.gaps.set(id, gap);
      if (!plain(gap)) { fail(`${where} must be an object`); continue; }
      if (!text(gap.asks, QUEST_LIMITS.ask)) fail(`${where}: asks must be 1 to ${QUEST_LIMITS.ask} characters`);
      if (!text(gap.know, QUEST_LIMITS.gapNote)) fail(`${where}: know must be 1 to ${QUEST_LIMITS.gapNote} characters`);
      for (const key of ['secret', 'wants']) if (gap[key] !== undefined && !text(gap[key], QUEST_LIMITS.gapNote)) fail(`${where}: ${key} must be 1 to ${QUEST_LIMITS.gapNote} characters`);
      const total = (gap.asks?.length ?? 0) + (gap.know?.length ?? 0) + (gap.secret?.length ?? 0) + (gap.wants?.length ?? 0);
      if (total > QUEST_LIMITS.gapNote + QUEST_LIMITS.ask) fail(`${where}: asks, know, secret and wants together are too long for the note (${total} characters)`);
      if (gap.idle !== undefined && !(typeof gap.idle === 'string' && /^[a-z][a-z0-9_-]{1,31}$/.test(gap.idle))) fail(`${where}: idle is not a seat kind or gesture name`);
      if (gap.resumeAfterSeconds !== undefined && !finite(gap.resumeAfterSeconds, QUEST_LIMITS.resumeMin, QUEST_LIMITS.resumeMax)) fail(`${where}: resumeAfterSeconds must be from ${QUEST_LIMITS.resumeMin} to ${QUEST_LIMITS.resumeMax}`);
      if (gap.resumeOn !== undefined && (!Array.isArray(gap.resumeOn) || gap.resumeOn.length > 6 || gap.resumeOn.some(name => !isEventName(name)))) fail(`${where}: resumeOn must be a list of up to 6 event names`);
      if (gap.tags !== undefined) {
        if (!Array.isArray(gap.tags) || gap.tags.length === 0 || gap.tags.length > 4) fail(`${where}: tags must be a list of 1 to 4`);
        else {
          const ids = new Set(), kinds = new Set();
          for (const tag of gap.tags) {
            if (!plain(tag) || !isId(tag.id) || ids.has(tag.id) || tag.id === 'resume' || tag.id === 'open' || !CHOICE_KINDS.includes(tag.kind) || kinds.has(tag.kind)) { fail(`${where}: every tag needs its own id and its own kind (${CHOICE_KINDS.join(', ')})`); continue; }
            ids.add(tag.id); kinds.add(tag.kind);
          }
        }
      }
      if (gap.resumeAfterSeconds === undefined && gap.resumeOn === undefined && gap.tags === undefined) warn(`${where}: nothing ends it (no timer, event or tag)`);
    }
  }
  return ctx;
}

/** Events a stage can see: its primitives, the core ones, its gaps' tags, the lines (done) and the follow-on events its own rows raise. */
function stageRaisable(name, stage, ctx) {
  if (isCoreEvent(name) && !/^gap:/.test(name) && !/^line:/.test(name) && !/^ending:/.test(name)) return true;
  const entries = Array.isArray(stage.do) ? stage.do : [];
  if (raisable(name, entries)) return true;
  let match;
  if ((match = /^line:(.+):done$/.exec(name))) return ctx.lines.has(match[1]);
  if ((match = /^gap:([a-z][a-z0-9-]*):(.+)$/.exec(name))) {
    const gap = ctx.gaps.get(match[1]);
    if (!gap) return false;
    return match[2] === 'open' || match[2] === 'resume' || (Array.isArray(gap.tags) && gap.tags.some(tag => tag.id === match[2]));
  }
  if (name.startsWith('ending:')) return false;
  return (Array.isArray(stage.script) ? stage.script : []).some(row => plain(row) && row.event === name);
}

/** The reason an `event:<name>` choice or a `when` cannot happen in the stage, or null. */
export function eventProblem(name, stage, ctx) {
  if (!isEventName(name)) return 'is not an event name';
  return stageRaisable(name, stage, ctx) ? null : 'is not raised by anything in this stage';
}

function checkRows(rows, stage, ctx, where, fail, {ending = null} = {}) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > QUEST_LIMITS.script) { fail(`${where}: script must be a list of 1 to ${QUEST_LIMITS.script} rows`); return; }
  rows.forEach((row, index) => {
    const here = `${where} row ${index + 1}`;
    if (!plain(row)) { fail(`${here} must be an object`); return; }
    const actions = ['say', 'text', 'gap', 'event'].filter(key => row[key] !== undefined);
    if (actions.length !== 1) { fail(`${here} needs exactly one of say, text, gap or event`); return; }
    if (typeof row.when !== 'string') fail(`${here}: when must be an event name`);
    else if (ending) { if (row.when !== `ending:${ending}`) fail(`${here}: an ending's rows run on "ending:${ending}"`); }
    else {
      const problem = eventProblem(row.when, stage, ctx);
      if (problem) fail(`${here}: when ${JSON.stringify(row.when).slice(0, 60)} ${problem}`);
    }
    if (row.say !== undefined && !ctx.lines.has(row.say)) fail(`${here}: say ${JSON.stringify(row.say).slice(0, 40)} is not one of the pack's lines`);
    if (row.text !== undefined && !ctx.lines.has(row.text)) fail(`${here}: text ${JSON.stringify(row.text).slice(0, 40)} is not one of the pack's lines`);
    if (row.image !== undefined && (row.text === undefined || !ctx.images.has(row.image))) fail(`${here}: image needs a text row and a picture of the pack's images`);
    if (row.gap !== undefined && !ctx.gaps.has(row.gap)) fail(`${here}: gap ${JSON.stringify(row.gap).slice(0, 40)} is not one of the pack's gaps`);
    if (row.event !== undefined && !isEventName(row.event)) fail(`${here}: event is not an event name`);
    if (row.bark !== undefined && typeof row.bark !== 'boolean') fail(`${here}: bark must be true or false`);
    for (const key of Object.keys(row)) if (!['when', 'say', 'text', 'gap', 'event', 'image', 'bark'].includes(key)) fail(`${here}: unknown field ${JSON.stringify(key).slice(0, 30)}`);
  });
}

/** A stage's `do` and `script`. */
export function checkStagePlay(stage, ctx, where, fail, warn) {
  if (stage.do !== undefined) {
    if (stage.type !== 'play') fail(`${where}: do needs type "play"`);
    else if (!Array.isArray(stage.do) || stage.do.length === 0 || stage.do.length > QUEST_LIMITS.doEntries) fail(`${where}: do must be a list of 1 to ${QUEST_LIMITS.doEntries} primitives`);
    else {
      const ids = new Set();
      stage.do.forEach((spec, index) => {
        const result = checkPrimitive(spec, ctx.places, `${where} do ${index + 1}`);
        result.errors.forEach(fail); result.warnings.forEach(warn);
        if (plain(spec) && spec.id !== undefined && PRIMITIVES[spec.p]) {
          const key = `${spec.p}:${spec.id}`;
          if (ids.has(key)) fail(`${where}: two ${spec.p} primitives have the id ${spec.id}`);
          ids.add(key);
        }
      });
    }
  } else if (stage.type === 'play') warn(`${where}: a play stage with no do only runs its script`);
  if (stage.script !== undefined) checkRows(stage.script, stage, ctx, where, fail);
}

/** An ending's `history` and `script`. */
export function checkEndingPlay(ending, id, ctx, where, fail) {
  if (!plain(ending)) return;
  if (ending.history !== undefined && !text(ending.history, QUEST_LIMITS.history)) fail(`${where}: history must be 1 to ${QUEST_LIMITS.history} characters`);
  if (typeof ending.history === 'string' && ending.history.includes(';')) fail(`${where}: history has a semicolon`);
  if (ending.script !== undefined) checkRows(ending.script, {}, ctx, where, fail, {ending: id});
}
