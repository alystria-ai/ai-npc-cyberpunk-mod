// Format 2 of a story pack (docs/QUEST_PRIMITIVES.md section 2): the places, lines, gaps and images of a pack, and the `do` and `script` of its stages. The checks
// the validator in bridge/bond-packs.mjs calls. Pure. Every problem is a short English sentence that says where it is.
import {checkPrimitive, raisable, isCoreEvent, isEventName, isId, PRIMITIVES, TRUSTED_ONLY} from './quest-primitives.mjs';
import {CHOICE_KINDS} from './bond-packs.mjs';

export const QUEST_LIMITS = Object.freeze({places: 24, lines: 80, gaps: 8, images: 8, script: 24, doEntries: 12, gapNote: 600, history: 200, ask: 240, lineText: 300,
  placeName: 80, resumeMin: 10, resumeMax: 7200, calls: 8, callSteps: 24, audioStages: 8, shares: 4});
export const LINE_CHANNELS = Object.freeze(['own', 'holocall', 'head', 'remote']);
export const EMOTIONS = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'fear', 'surprise', 'shrug', 'emphatic', 'nod', 'disgust', 'joy', 'calm']);
export const AUDIO_FILE = /^audio\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:wav|ogg|opus)$/;
export const MEDIA_FILE = /^(?:music|sfx)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:wav|ogg|opus)$/;
/** What a stage or a gap feels like: the idle and the gesture bias the game picks (docs/BOND_QUESTS.md 19.1). */
export const SITUATIONS = Object.freeze(['nervous', 'celebrating', 'grieving', 'angry', 'relaxed', 'working']);
const RADIO_SOURCE = /^radio:[A-Za-z0-9][A-Za-z0-9 _.-]{1,40}$/;
const GAME_SOUND = /^game:[A-Za-z0-9_]{3,80}$/;
const SFX_AT = /^(?:v|copy|bed|place:[a-z][a-z0-9-]{0,31})$/;
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
    for (const key of ['at', 'to', 'deadZone', 'from']) add(spec[key]);
    for (const key of ['checkpoints', 'route', 'reroute']) if (Array.isArray(spec[key])) spec[key].forEach(add);
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
      if (gap.situation !== undefined && !SITUATIONS.includes(gap.situation)) fail(`${where}: situation must be one of ${SITUATIONS.join(', ')}`);
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
  // Scripted holocalls (call-script, docs/BOND_QUESTS.md 14.3): a call is a list of steps, each one a line (channel holocall), a gap, an event or the hang-up.
  ctx.calls = new Map();
  if (pack.calls !== undefined) {
    if (!plain(pack.calls) || Object.keys(pack.calls).length > QUEST_LIMITS.calls) fail(`calls must be an object of up to ${QUEST_LIMITS.calls} calls`);
    else for (const [id, call] of Object.entries(pack.calls)) {
      const where = `call ${id}`;
      if (!isId(id)) { fail(`${where}: the id must be lowercase letters, digits or hyphens`); continue; }
      ctx.calls.set(id, call);
      if (!plain(call)) { fail(`${where} must be an object`); continue; }
      if (call.caller !== undefined && !['self', 'v'].includes(call.caller)) fail(`${where}: caller must be self or v`);
      if (call.picture !== undefined && !['live', 'voice'].includes(call.picture)) fail(`${where}: picture must be live or voice`);
      if (call.text !== undefined && !(typeof call.text === 'string' && ctx.lines.has(call.text))) fail(`${where}: text must be one of the pack's lines (the opening text of the fallback)`);
      if (call.onHangUp !== undefined && !isEventName(call.onHangUp)) fail(`${where}: onHangUp is not an event name`);
      if (!Array.isArray(call.steps) || call.steps.length === 0 || call.steps.length > QUEST_LIMITS.callSteps) { fail(`${where}: steps must be a list of 1 to ${QUEST_LIMITS.callSteps}`); continue; }
      call.steps.forEach((step, index) => {
        const here = `${where} step ${index + 1}`;
        const keys = plain(step) ? ['say', 'gap', 'event', 'hangup'].filter(key => step[key] !== undefined) : [];
        if (keys.length !== 1) { fail(`${here} needs exactly one of say, gap, event or hangup`); return; }
        if (step.say !== undefined) {
          if (!ctx.lines.has(step.say)) fail(`${here}: say ${JSON.stringify(step.say).slice(0, 40)} is not one of the pack's lines`);
          else if ((ctx.lines.get(step.say)?.channel ?? 'own') !== 'holocall') warn(`${here}: the line ${step.say} should have channel holocall`);
        }
        if (step.gap !== undefined && !ctx.gaps.has(step.gap)) fail(`${here}: gap ${JSON.stringify(step.gap).slice(0, 40)} is not one of the pack's gaps`);
        if (step.event !== undefined && !isEventName(step.event)) fail(`${here}: event is not an event name`);
        if (step.hangup !== undefined && step.hangup !== true) fail(`${here}: hangup must be true`);
      });
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
  if (Array.isArray(stage.do)) checkReferences(stage.do, ctx, where, fail);
  if (stage.script !== undefined) checkRows(stage.script, stage, ctx, where, fail);
  if (stage.situation !== undefined && !SITUATIONS.includes(stage.situation)) fail(`${where}: situation must be one of ${SITUATIONS.join(', ')}`);
  if (stage.music !== undefined) checkSounds(stage.music, 'music', stage, ctx, where, fail);
  if (stage.sfx !== undefined) checkSounds(stage.sfx, 'sfx', stage, ctx, where, fail);
}

const PROFILE_KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const OBJECT_REFS = [['bout', 'a', ['cast', 'self']], ['bout', 'b', ['cast', 'self']], ['npc-react', 'cast', ['cast']], ['pay', 'to', ['cast']], ['workspot', 'who', ['cast', 'self']],
  ['hold-until', 'squad', ['squad']], ['hold-until', 'witness', ['escortee', 'hostage']], ['unseen', 'squad', ['squad']]];

/** The cross references of a stage's primitives: the ids they name must be made by another primitive of the same stage, and the community may not use a trusted-only one. */
function checkReferences(entries, ctx, where, fail) {
  const made = new Map();
  const add = (kind, id) => { if (!made.has(kind)) made.set(kind, new Set()); made.get(kind).add(id); };
  for (const spec of entries) if (plain(spec) && typeof spec.id === 'string') add(spec.p, spec.id);
  for (const spec of entries) {
    if (!plain(spec) || !PRIMITIVES[spec.p]) continue;
    if (ctx.community === true && TRUSTED_ONLY.has(spec.p)) fail(`${where}: ${spec.p} is only for the packs shipped with the mod`);
    for (const [name, field, kinds] of OBJECT_REFS) {
      const value = spec.p === name ? spec[field] : undefined;
      if (value === undefined) continue;
      if (value === 'self' && kinds.includes('self')) continue;
      const made_ = kinds.filter(kind => kind !== 'self');
      if (!made_.some(kind => made.get(kind)?.has(value))) fail(`${where}: ${name}.${field} ${JSON.stringify(String(value)).slice(0, 40)} is not made by a ${made_.join(' or ')} of this stage`);
    }
    if ((spec.p === 'call-in' || spec.p === 'call-script') && spec.call !== undefined && !ctx.calls?.has(spec.call)) fail(`${where}: ${spec.p}.call ${JSON.stringify(String(spec.call)).slice(0, 40)} is not one of the pack's calls`);
    if (spec.p === 'memory-share' && !(typeof spec.to === 'string' && PROFILE_KEY.test(spec.to))) fail(`${where}: memory-share.to must be a profile key`);
    if (spec.p === 'gift' && spec.dir === 'receive' && spec.tier === undefined && spec.item === undefined) fail(`${where}: a gift the character gives needs a tier or an item`);
    if (spec.p === 'gift') {
      // A shipped pack may name any Items.* record; a community pack only the allowlist (characters/gift-tables.json).
      for (const field of ['item', 'second']) {
        if (spec[field] === undefined) continue;
        if (!/^Items\.[A-Za-z0-9_]{2,80}$/.test(String(spec[field]))) fail(`${where}: gift.${field} must be an Items.* record`);
        else if (ctx.community === true && !(typeof ctx.giftAllowed === 'function' && ctx.giftAllowed(spec[field]))) fail(`${where}: gift.${field} ${JSON.stringify(String(spec[field])).slice(0, 50)} is not on the gift allowlist`);
      }
    }
    if (spec.p === 'pay' && spec.min !== undefined && spec.min > spec.amount) fail(`${where}: pay.min is above the amount`);
    if (spec.p === 'apart' && spec.inner !== undefined && spec.outer !== undefined && spec.inner >= spec.outer) fail(`${where}: apart.inner must be below apart.outer`);
    if (spec.p === 'bout' && spec.a === spec.b) fail(`${where}: a bout needs two different fighters`);
  }
}

/** A stage's music or sound effects: a game station or sound event, or a file of the pack (music/ or sfx/), started and stopped by events the stage raises. */
function checkSounds(list, kind, stage, ctx, where, fail) {
  const most = kind === 'music' ? 3 : 6;
  if (!Array.isArray(list) || list.length === 0 || list.length > most) { fail(`${where}: ${kind} must be a list of 1 to ${most}`); return; }
  list.forEach((item, index) => {
    const here = `${where} ${kind} ${index + 1}`;
    if (!plain(item)) { fail(`${here} must be an object`); return; }
    const allowed = ['source', 'start', 'stop', 'fadeIn', 'fadeOut', 'volume', ...(kind === 'music' ? ['duck'] : ['at', 'loop'])];
    for (const key of Object.keys(item)) if (!allowed.includes(key)) fail(`${here}: unknown field ${JSON.stringify(key).slice(0, 30)}`);
    const source = item.source;
    const sourceOk = typeof source === 'string' && ((kind === 'music' && RADIO_SOURCE.test(source)) || GAME_SOUND.test(source)
      || (source.startsWith(`file:${kind}/`) && MEDIA_FILE.test(source.slice(5))));
    if (!sourceOk) fail(`${here}: source must be ${kind === 'music' ? 'radio:<station>, ' : ''}game:<event> or file:${kind}/<name>.ogg inside the pack`);
    for (const key of ['start', 'stop']) {
      if (item[key] === undefined) continue;
      const problem = eventProblem(item[key], stage, ctx);
      if (problem) fail(`${here}: ${key} ${JSON.stringify(String(item[key])).slice(0, 40)} ${problem}`);
    }
    for (const key of ['fadeIn', 'fadeOut']) if (item[key] !== undefined && !finite(item[key], 0, 10)) fail(`${here}: ${key} must be from 0 to 10 seconds`);
    if (item.volume !== undefined && !finite(item.volume, 0, 1)) fail(`${here}: volume must be from 0 to 1`);
    if (item.duck !== undefined && typeof item.duck !== 'boolean') fail(`${here}: duck must be true or false`);
    if (item.loop !== undefined && typeof item.loop !== 'boolean') fail(`${here}: loop must be true or false`);
    if (item.at !== undefined) {
      if (typeof item.at !== 'string' || !SFX_AT.test(item.at)) fail(`${here}: at must be v, copy, bed or place:<id>`);
      else if (item.at.startsWith('place:') && !ctx.places.has(item.at.slice(6))) fail(`${here}: at names a place the pack does not have`);
    }
  });
}

/** An ending's `history` and `script`. */
export function checkEndingPlay(ending, id, ctx, where, fail) {
  if (!plain(ending)) return;
  if (ending.history !== undefined && !text(ending.history, QUEST_LIMITS.history)) fail(`${where}: history must be 1 to ${QUEST_LIMITS.history} characters`);
  if (typeof ending.history === 'string' && ending.history.includes(';')) fail(`${where}: history has a semicolon`);
  if (ending.script !== undefined) checkRows(ending.script, {}, ctx, where, fail, {ending: id});
  if (ending.share !== undefined) {
    if (!Array.isArray(ending.share) || ending.share.length === 0 || ending.share.length > QUEST_LIMITS.shares) fail(`${where}: share must be a list of 1 to ${QUEST_LIMITS.shares}`);
    else for (const item of ending.share) {
      if (!plain(item) || !(typeof item.to === 'string' && PROFILE_KEY.test(item.to)) || (item.note !== undefined && !text(item.note, 300))) fail(`${where}: a share needs to (a profile key) and an optional note of up to 300 characters`);
      else if (typeof item.note === 'string' && item.note.includes(';')) fail(`${where}: a share note has a semicolon`);
    }
  }
  if (ending.situation !== undefined && !SITUATIONS.includes(ending.situation)) fail(`${where}: situation must be one of ${SITUATIONS.join(', ')}`);
}
