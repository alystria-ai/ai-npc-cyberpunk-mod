import {readFile, open} from 'node:fs/promises';
import {atomicFile} from './guarded-file.mjs';

const MAX_ACTIONS = 4096, MAX_BYTES = 2 * 1024 * 1024;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const ACTION = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => a.id === b.id && a.scope === b.scope && a.profileKey === b.profileKey;
const identity = action => ({id: action.id, scope: action.scope,
  ...(action.scope === 'character' ? {profileKey: action.profileKey} : {})});
function memoryEpochsFor(value) {
  if (value===undefined) return undefined;
  if (!plain(value)||value.version!==1||!Number.isSafeInteger(value.globalEpoch)||value.globalEpoch<0
      ||!plain(value.characterEpochs)||Object.keys(value.characterEpochs).length>2048
      ||Object.entries(value.characterEpochs).some(([key,epoch])=>!PROFILE.test(key)||!Number.isSafeInteger(epoch)||epoch<0)) {
    throw Error('Invalid phone memory epochs');
  }
  return {version:1,globalEpoch:value.globalEpoch,characterEpochs:{...value.characterEpochs}};
}
function familiesFor(value = {}) {
  if (!plain(value) || Object.keys(value).length > 1024
      || Object.entries(value).some(([key, family]) => !PROFILE.test(key) || !PROFILE.test(family))) throw Error('Invalid Chat reset families');
  if (Object.values(value).some(family=>Object.hasOwn(value,family)&&value[family]!==family)) throw Error('Invalid Chat reset families');
  return {...value};
}
function validIdentity(value) {
  return plain(value) && ACTION.test(value.id ?? '') && ['character', 'all'].includes(value.scope)
    && (value.scope === 'character' ? PROFILE.test(value.profileKey ?? '') : value.profileKey == null);
}
function actionsFor(status) {
  const actions = status?.actions ?? [];
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS || actions.some(action => !validIdentity(action)
      || !['pending', 'failed', 'succeeded'].includes(action.state))
      || new Set(actions.map(action => action.id)).size !== actions.length) throw Error('Invalid memory reset actions');
  return actions;
}
function parse(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw Error('Invalid Chat reset journal');
  let value; try { value = JSON.parse(raw); } catch { throw Error('Invalid Chat reset journal'); }
  if (!plain(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isFinite(value.updated) || typeof value.blockAll !== 'boolean'
      || !Array.isArray(value.blockedProfiles) || value.blockedProfiles.length > 1024
      || value.blockedProfiles.some(key => !PROFILE.test(key))
      || new Set(value.blockedProfiles).size !== value.blockedProfiles.length) throw Error('Invalid Chat reset journal');
  for (const key of ['baseline', 'tracked', 'receipts', 'pending']) {
    if (!Array.isArray(value[key]) || value[key].length > MAX_ACTIONS
        || value[key].some(row => !validIdentity(row))
        || new Set(value[key].map(row => row.id)).size !== value[key].length) throw Error('Invalid Chat reset journal');
  }
  const known = new Map([...value.baseline, ...value.tracked].map(row => [row.id, row]));
  if (known.size !== value.baseline.length + value.tracked.length || known.size > MAX_ACTIONS
      || value.pending.some(row => !known.has(row.id) || !same(row, known.get(row.id)))
      || value.receipts.some(row => !value.tracked.some(target => same(row, target)))) throw Error('Invalid Chat reset ownership');
  value.profileFamilies = familiesFor(value.profileFamilies);
  if(value.memoryEpochs!==undefined)value.memoryEpochs=memoryEpochsFor(value.memoryEpochs);
  return value;
}
const durableWrite = (path, raw) => atomicFile(path, raw, {files:{open:async (...args) => {
  const handle=await open(...args);
  return {writeFile:async value=>{await handle.writeFile(value);await handle.sync();},close:()=>handle.close()};
}}});

/** A durable deletion receipt, not a second writer of the player's transcript.
 * Lua applies receipts and its tombstones in the same phone-history replacement.
 * First installation baselines old actions: an old Forget must not erase a newer
 * conversation. Once established, a missed successful result is replayed locally
 * after bridge/game restarts. Failed or uncertain clears never delete Chat data.
 * Keys identify displayed characters; a character's provider variants (its profile
 * and its Multilingual twin) must supply one aggregate result after every contacted variant is confirmed empty.
 */
export class ChatMemoryResets {
  static async open({path, status, profileFamilies, resetEpochFor, read = path => readFile(path, 'utf8'), write = durableWrite, now = Date.now}) {
    const resets = new ChatMemoryResets({path, read, write, now,resetEpochFor});
    const families = familiesFor(profileFamilies);
    let raw;
    try { raw = await read(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (raw !== undefined) resets.state = parse(raw);
    else {
      resets.state = {version: 1, revision: 0, updated: now(), baseline: actionsFor(status).map(identity),
        tracked: [], receipts: [], pending: [], blockedProfiles: [], blockAll: false, profileFamilies:families};
      await resets.persist(resets.state);
    }
    await resets.mutate(next => {
      for (const [key, family] of Object.entries(families)) {
        if (Object.hasOwn(next.profileFamilies,key) && next.profileFamilies[key] !== family) throw Error('Chat reset family ownership changed');
        next.profileFamilies[key] = family;
      }
      familiesFor(next.profileFamilies);
      // A legacy provider-only clear is not proof that every member of its new
      // logical family was cleared. Baseline those old intents rather than
      // widening an unapplied receipt; only a new aggregate action can delete
      // the shared Chat. Already-applied tombstones migrate locally without
      // replaying the old deletion against conversations written afterward.
      const subsets = new Set(next.tracked.filter(row => row.scope === 'character'
        && Object.hasOwn(next.profileFamilies,row.profileKey) && next.profileFamilies[row.profileKey] !== row.profileKey)
        .map(row=>row.id));
      for (const field of ['baseline','tracked','receipts','pending']) for (const row of next[field]) {
        if (row.scope === 'character' && Object.hasOwn(next.profileFamilies,row.profileKey)) row.profileKey = next.profileFamilies[row.profileKey];
      }
      next.blockedProfiles = [...new Set(next.blockedProfiles.map(key=>Object.hasOwn(next.profileFamilies,key) ? next.profileFamilies[key] : key))].sort();
      next.baseline.push(...next.tracked.filter(row=>subsets.has(row.id)));
      next.tracked = next.tracked.filter(row=>!subsets.has(row.id));
      next.receipts = next.receipts.filter(row=>!subsets.has(row.id));
    });
    await resets.sync(status, {recoverStartup: true});
    return resets;
  }
  constructor({path, read, write, now,resetEpochFor}) {
    if (typeof path !== 'string' || typeof read !== 'function' || typeof write !== 'function' || typeof now !== 'function') {
      throw Error('Invalid Chat reset journal configuration');
    }
    if(resetEpochFor!==undefined&&typeof resetEpochFor!=='function')throw Error('Invalid phone memory epoch source');
    Object.assign(this, {path, read, write, now,resetEpochFor}); this.tail = Promise.resolve();
  }
  phoneState(profileKey) {
    if (!PROFILE.test(profileKey)) throw Error('Invalid phone memory profile');
    if (this.phoneRevision !== this.state.revision) {
      this.phoneRevision=this.state.revision;this.phoneGlobalEpoch=0;this.phoneEpochs=new Map();
      // Baseline controls deletion replay, never request admission. Old known
      // intents still retire their earlier phone owners after a restart or
      // family migration; moving a record to baseline cannot regress epochs.
      for (const row of [...this.state.baseline,...this.state.tracked]) {
        if (row.scope==='all') this.phoneGlobalEpoch++;
        else this.phoneEpochs.set(row.profileKey,(this.phoneEpochs.get(row.profileKey)||0)+1);
      }
    }
    const memory=this.resetEpochFor?.(profileKey) ?? (this.state.memoryEpochs
      ? {globalEpoch:this.state.memoryEpochs.globalEpoch,characterEpoch:Object.hasOwn(this.state.memoryEpochs.characterEpochs,profileKey)
        ? this.state.memoryEpochs.characterEpochs[profileKey] : 0} : undefined);
    if(memory && (!Number.isSafeInteger(memory.globalEpoch)||memory.globalEpoch<0
      ||!Number.isSafeInteger(memory.characterEpoch)||memory.characterEpoch<0))throw Error('Invalid phone memory epochs');
    return Object.freeze({version:1,globalEpoch:this.phoneGlobalEpoch,characterEpoch:this.phoneEpochs.get(profileKey)||0,
      ...(memory?{globalMemoryEpoch:memory.globalEpoch,characterMemoryEpoch:memory.characterEpoch}:{}),
      blocked:this.state.blockAll || this.state.blockedProfiles.includes(profileKey)});
  }
  async persist(value) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_BYTES) throw Error('Chat reset journal is full');
    if (await this.write(this.path, raw) === false) throw Error('Chat reset journal could not be saved');
  }
  mutate(callback) {
    const task = this.tail.catch(() => {}).then(async () => {
      const next = structuredClone(this.state); callback(next);
      if (JSON.stringify({...next, updated: 0}) === JSON.stringify({...this.state, updated: 0})) return;
      if (this.state.revision === Number.MAX_SAFE_INTEGER) throw Error('Chat reset revision exhausted');
      next.revision = this.state.revision + 1; next.updated = this.now();
      await this.persist(next); this.state = next;
    });
    this.tail = task; return task;
  }
  start(command) {
    if (!validIdentity(command)) return Promise.reject(Error('Invalid Chat reset command'));
    return this.mutate(next => {
      const row = identity(command), known = [...next.baseline, ...next.tracked].find(value => value.id === row.id);
      if (known && !same(row, known)) throw Error('Chat reset command ownership changed');
      if (!known) {
        if (next.baseline.length + next.tracked.length >= MAX_ACTIONS) throw Error('Chat reset journal is full');
        next.tracked.push(row);
      }
      if (!next.pending.some(value => value.id === row.id)) next.pending.push(row);
      if (row.scope === 'all') next.blockAll = true;
      else if (!next.blockedProfiles.includes(row.profileKey)) next.blockedProfiles.push(row.profileKey);
    });
  }
  sync(status, {recoverStartup = false, finished} = {}) {
    return this.mutate(next => {
      const actions = actionsFor(status), known = new Map([...next.baseline, ...next.tracked].map(row => [row.id, row]));
      if(status?.phoneMemoryEpochs!==undefined)next.memoryEpochs=memoryEpochsFor(status.phoneMemoryEpochs);
      for (const action of actions) {
        const row = identity(action), prior = known.get(row.id);
        if (prior && !same(row, prior)) throw Error('Chat reset command ownership changed');
        if (!prior) { next.tracked.push(row); known.set(row.id, row); }
        if (next.tracked.some(value => same(value, row)) && action.state === 'succeeded'
            && action.uncertain !== true && !next.receipts.some(value => value.id === row.id)) next.receipts.push(row);
      }
      if (known.size > MAX_ACTIONS) throw Error('Chat reset journal is full');
      // start() is persisted before dispatch. A heartbeat can observe the
      // memory registry before its first action write; that is not cancellation.
      const active = actions.filter(action => action.state === 'pending').map(identity);
      if (!recoverStartup) for (const row of next.pending) {
        if (!actions.some(action => action.id === row.id) && row.id !== finished?.id) active.push(row);
      }
      next.pending = active;
      next.blockAll = next.pending.some(row => row.scope === 'all');
      const blocked = new Set(next.pending.filter(row => row.scope === 'character').map(row => row.profileKey));
      for (const row of status?.characters ?? []) if (row.blocked === true && PROFILE.test(row.profileKey ?? '')) blocked.add(row.profileKey);
      next.blockedProfiles = [...blocked].sort();
    });
  }
}
