// The game's requests for a story pack's music and sound effects (docs/BOND_QUESTS.md 19.2 and 19.3): their strict parsing, and the resolution of the file a request names to a
// file inside the pack. Pure apart from `exists`. The playing is bridge/media-host.mjs, the reading of the request file is bridge/media-link.mjs.
//
// THE REQUEST. A stage's `music` and `sfx` items with a `file:music/<name>.ogg` or `file:sfx/<name>.ogg` source are played by the bridge; `radio:` and `game:` sources are played
// by the game itself and never reach the bridge. The game asks with one small file, runtime/media-command.json, which it rewrites in place:
//
//   {"version": 1, "session": "k3j2h1g0", "seq": 12, "commands": [ <command>, ... up to 8 ]}
//
// a command is the reaction object of kind 'media' (the shape of bridge/quest-lines.mjs parseScriptedReaction, one op per object):
//
//   {"kind":"media","op":"play","pack":"panam-sunset-coffee","id":"bed1","file":"music/sunset.ogg","loop":true,"volume":0.6,"fadeIn":2,"fadeOut":2,"duck":true,"at":"bed","pan":0}
//   {"kind":"media","op":"load","pack":"...","file":"sfx/door.ogg"}                         decode and hand it to the page now (no sound), so a later play starts at once
//   {"kind":"media","op":"stop","pack":"...","id":"bed1","fadeOut":2}                       one sound; without `id` everything the pack started
//   {"kind":"media","op":"fade","pack":"...","id":"bed1","volume":0.2,"pan":-0.5,"seconds":3}   a new level and/or pan (a positional loop is steered with this, 4 times a second at most)
//   {"kind":"media","op":"duck","pack":"...","on":true}                                       the pack asks for the music to be lowered (a voice the bridge does not play: Convai's own
//                                                                                              cloud voice, a game line); held until `on:false` or the pack stops
//
// Fields: pack (the pack id), id (the game's name for the sound, 1 to 64 of letters digits . _ : -), file (as the pack names it: music/<name>.ogg or sfx/<name>.ogg, .wav and .opus
// too), loop (default false), volume 0 to 1 (default 1), fadeIn and fadeOut 0 to 10 seconds (default 0, and 0.3 for a stop), duck (default true for music, false for sfx), at
// 'bed' | 'v' | 'copy' | 'place:<id>' (default 'bed'; 'copy' uses `pan`, the same -1 to 1 the speech lease carries, flat when absent), seconds 0 to 10 (default 1).
// A command with an unknown field, a wrong type or a value out of range is dropped whole (fail closed). The PATH of a sound is never in a request: `file` must be one the active
// pack's own stages name as a `file:` source, and the bridge builds the path from the pack folder (resolveMediaFile).
import {resolve, sep} from 'node:path';
import {existsSync} from 'node:fs';
import {MEDIA_FILE} from './quest-format.mjs';
import {SCRIPTED_LINE, SCRIPTED_PACK} from './quest-lines.mjs';

export const MEDIA_OPS = Object.freeze(['play', 'load', 'stop', 'fade', 'duck']);
export const MEDIA_ID = SCRIPTED_LINE;
export const MEDIA_AT = /^(?:v|copy|bed|place:[a-z][a-z0-9-]{0,31})$/;
export const MEDIA_SESSION = /^[A-Za-z0-9_-]{1,40}$/;
export const MEDIA_COMMANDS_MOST = 8;
const FIELDS = Object.freeze({
  play: ['kind', 'op', 'pack', 'id', 'file', 'loop', 'volume', 'fadeIn', 'fadeOut', 'duck', 'at', 'pan'],
  load: ['kind', 'op', 'pack', 'file'],
  stop: ['kind', 'op', 'pack', 'id', 'fadeOut'],
  fade: ['kind', 'op', 'pack', 'id', 'volume', 'pan', 'seconds'],
  duck: ['kind', 'op', 'pack', 'on'],
});

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/**
 * One command -> the normalised command {kind: 'media', op, pack, ...}, or null (fail closed). Defaults are filled in, so the host reads every field it needs.
 */
export function parseMediaReaction(value) {
  if (!plain(value) || value.kind !== 'media' || !MEDIA_OPS.includes(value.op)) return null;
  if (Object.keys(value).some(key => !FIELDS[value.op].includes(key))) return null;
  if (typeof value.pack !== 'string' || !SCRIPTED_PACK.test(value.pack)) return null;
  const op = value.op, out = {kind: 'media', op, pack: value.pack};
  const id = () => typeof value.id === 'string' && MEDIA_ID.test(value.id);
  const file = () => typeof value.file === 'string' && MEDIA_FILE.test(value.file);
  const optional = (key, ok) => value[key] === undefined || ok(value[key]);
  if (op === 'play') {
    if (!id() || !file()) return null;
    if (!optional('loop', v => typeof v === 'boolean') || !optional('duck', v => typeof v === 'boolean')) return null;
    if (!optional('volume', v => number(v, 0, 1)) || !optional('fadeIn', v => number(v, 0, 10)) || !optional('fadeOut', v => number(v, 0, 10)) || !optional('pan', v => number(v, -1, 1))) return null;
    if (!optional('at', v => typeof v === 'string' && MEDIA_AT.test(v))) return null;
    return {...out, id: value.id, file: value.file, loop: value.loop === true, volume: value.volume ?? 1, fadeIn: value.fadeIn ?? 0, fadeOut: value.fadeOut ?? 0,
      duck: value.duck ?? value.file.startsWith('music/'), at: value.at ?? 'bed', pan: value.pan ?? 0};
  }
  if (op === 'load') return file() ? {...out, file: value.file} : null;
  if (op === 'stop') {
    if (value.id !== undefined && !id()) return null;
    if (!optional('fadeOut', v => number(v, 0, 10))) return null;
    return {...out, ...(value.id !== undefined ? {id: value.id} : {}), fadeOut: value.fadeOut ?? 0.3};
  }
  if (op === 'fade') {
    if (!id() || (value.volume === undefined && value.pan === undefined)) return null;
    if (!optional('volume', v => number(v, 0, 1)) || !optional('pan', v => number(v, -1, 1)) || !optional('seconds', v => number(v, 0, 10))) return null;
    return {...out, id: value.id, ...(value.volume !== undefined ? {volume: value.volume} : {}), ...(value.pan !== undefined ? {pan: value.pan} : {}), seconds: value.seconds ?? 1};
  }
  return typeof value.on === 'boolean' ? {...out, on: value.on} : null;
}

/**
 * The text of runtime/media-command.json -> {session, seq, commands, rejected}, or null when it is not a command file (a partial write, another version). A command that does not
 * parse is counted in `rejected` and left out; the others are kept in order.
 */
export function parseMediaCommandFile(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!plain(value) || value.version !== 1 || typeof value.session !== 'string' || !MEDIA_SESSION.test(value.session) || !Number.isSafeInteger(value.seq) || value.seq < 0) return null;
  if (!Array.isArray(value.commands) || value.commands.length > MEDIA_COMMANDS_MOST) return null;
  const commands = [];
  let rejected = 0;
  for (const item of value.commands) { const command = parseMediaReaction(item); if (command) commands.push(command); else rejected++; }
  return {session: value.session, seq: value.seq, commands, rejected};
}

/** Every `file:` sound a pack's stages name, as a Map of path -> 'music' | 'sfx'. A request may only name one of these. */
export function declaredMedia(pack) {
  const files = new Map();
  for (const stage of Array.isArray(pack?.stages) ? pack.stages : []) {
    for (const kind of ['music', 'sfx']) {
      for (const item of Array.isArray(stage?.[kind]) ? stage[kind] : []) {
        const source = item?.source;
        if (typeof source === 'string' && source.startsWith(`file:${kind}/`) && MEDIA_FILE.test(source.slice(5))) files.set(source.slice(5), kind);
      }
    }
  }
  return files;
}

/**
 * Is this pack one the bridge plays media for: known, and running or ended in the last minutes (the closing rows of bridge/bond-pack-runner.mjs, as lineFor)? Reads the
 * runner's own tables (packs, entries, closing): nothing is changed.
 */
export function packIsLive(bondPacks, packId) {
  if (!bondPacks?.packs?.get?.(packId)) return false;
  return bondPacks.entries?.get?.(packId)?.status === 'active' || (Array.isArray(bondPacks.closing) && bondPacks.closing.some(item => item.pack === packId));
}

/**
 * The file a request names -> {path, kind: 'music' | 'sfx', key} or null (the pack is not running, does not name that file, the file is not there, or the path would leave
 * the pack's own folder). `key` is the name the page keeps the decoded sound under.
 */
export function resolveMediaFile(bondPacks, packId, file, {exists = bondPacks?.exists ?? existsSync} = {}) {
  if (!packIsLive(bondPacks, packId) || typeof file !== 'string' || !MEDIA_FILE.test(file)) return null;
  const kind = declaredMedia(bondPacks.packs.get(packId)).get(file);
  if (!kind || typeof bondPacks.packFolder !== 'string') return null;
  const root = resolve(bondPacks.packFolder, packId), path = resolve(root, file);
  if (!path.startsWith(root + sep) || !exists(path)) return null;
  return {path, kind, key: `${packId}/${file}`};
}
