import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, basename, dirname} from 'node:path';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {KnowledgeService} from './knowledge-service.mjs';

const P = 'judy-alvarez', Q = 'panam-palmer';
const factSource = readFileSync(new URL('../mod/fact-identity.lua', import.meta.url), 'utf8');
const pack = {version: 1, id: 'coordinator-fixture', revision: 1, gameVersions: ['2.31'],
  profileKeys: [P, Q, 'johnny-silverhand', 'resident-male', 'resident-female'],
  sources: [{id: 'native-source', kind: 'native', locator: 'fixture/branch.quest'},
    {id: 'story-source', kind: 'official', url: 'https://example.org/fixture'}],
  evidence: [{id: 'native-branch', kind: 'native', sourceId: 'native-source', locator: 'fixture branch 1', gameVersions: ['2.31']}],
  factAllowlist: {choice: {evidenceRefs: ['native-branch']}}, journalAllowlist: {},
  rules: [1, 2].map(value => ({id: `choice-${value}`, revision: 1, questKey: 'fixture-choice', topic: `choice.${value}`, outcome: String(value),
    status: 'source-verified', reviewed: true, gameVersions: ['2.31'], category: 'decision', priority: 1,
    stable: true, statement: `V selected fixture route ${value}.`, sourceIds: ['story-source'], evidenceRefs: ['native-branch'],
    audience: {speakers: 'all', perspective: 'shared-journal', channels: ['private', 'phone', 'group'], recipients: 'all'},
    condition: {type: 'fact', key: 'choice', op: 'eq', value}}))};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-knowledge-service-'));
  const path = join(root, 'ledger.json');
  let now = Date.parse('2026-09-30T12:00:00Z'), service;
  const calls = [], files = new Map();
  const native = {status: 'inspected', ready: true, saving: false, faulted: false, restored: false, resolved: false,
    schema: 0, generation: 1, revision: 0, activationId: '', branchEpoch: 0, ledgerSequence: 0};
  const state = () => ({version: 1, status: native.ready ? 'ready' : 'unavailable', publishedAt: now,
    worldGeneration: native.generation, inspection: structuredClone(native), ack: structuredClone(lastAck),
    identity: native.ready && native.resolved ? {...structuredClone(native), version: 1, status: 'available',
      authoritative: true, confidence: 'native-live'} : {status: 'unavailable'}});
  let lastAck, freezeHeartbeat = false, dropCommands = false, intercept;
  const io = {
    async read(file) {
      if (basename(file) === 'knowledge-state.json' && !freezeHeartbeat) files.set(file, JSON.stringify(state()));
      return files.get(file) ?? null;
    },
    async write(file, raw) {
      files.set(file, raw);
      if (basename(file) !== 'knowledge-command.json') return;
      const c = JSON.parse(raw); calls.push(c);
      if (intercept) await intercept(c);
      if (dropCommands) return;
      if (c.expected.generation !== native.generation || c.expected.revision !== native.revision
          || c.expected.activationId !== native.activationId || !native.ready || native.saving) {
        lastAck = {id: c.id, ok: false}; return;
      }
      if (c.kind === 'claim') { native.activationId = c.activationId; native.resolved = false; }
      else if (c.kind === 'seed' && native.schema === 0) {
        Object.assign(native, {schema: 1, campaignId: c.campaignId, branchId: c.branchId,
          branchEpoch: 1, ledgerSequence: 0, resolved: true});
      } else if (c.kind === 'fork' && c.branchId !== native.branchId && c.branchEpoch > native.branchEpoch) {
        Object.assign(native, {branchId: c.branchId, branchEpoch: c.branchEpoch, ledgerSequence: 0, resolved: true});
      } else if (c.kind === 'resume' && native.schema === 1 && !native.resolved) native.resolved = true;
      else if (c.kind === 'advance' && native.resolved && c.ledgerSequence === native.ledgerSequence + 1) native.ledgerSequence++;
      else { lastAck = {id: c.id, ok: false}; return; }
      native.revision++; lastAck = {id: c.id, ok: true};
    },
    async wait(ms) { now += ms; },
  };
  async function open() {
    service = await KnowledgeService.open({runtimeDir: root, ledgerPath: path, pack, io, now: () => now,
      commandTimeoutMs: 150, ...options}); return service;
  }
  function capture(value = 1, channel = 'private', audience = [P]) {
    return {version: 1, status: 'ready', gameVersion: '2.31', generation: native.generation,
      worldToken: `${native.generation}:${native.activationId}:${native.branchId}`, capturedAt: new Date(now).toISOString(),
      identity: {status: 'unknown'}, audience: {channel, profileKeys: audience}, activeQuestKeys: ['fixture-choice'],
      facts: {choice: {status: 'known', value, present: true, sourceId: 'native-capture', evidenceRefs: ['capture:choice']}},
      journal: {}};
  }
  const project = (value = 1, fields = {}) => service.project({profileKey: P, generation: native.generation,
    snapshot: capture(value, fields.channel, fields.audience), ...fields});
  function restore(saved) {
    const generation = native.generation + 1;
    for (const key of Object.keys(native)) delete native[key];
    Object.assign(native, structuredClone(saved), {generation, revision: 0, activationId: '', resolved: false,
      ready: true, saving: false, restored: true});
    native.restoredProof = {kind: 'native-on-restored', branchId: native.branchId,
      ledgerSequence: native.ledgerSequence, checkpointId: `${native.branchId}:1:${native.ledgerSequence}`};
  }
  t.after(async () => { await service?.close(); await rm(root, {recursive: true, force: true}); });
  await open();
  return {get service() { return service; }, native, calls, files, capture, project, restore, open, path, root,
    advance: ms => { now += ms; }, freeze: () => { files.set(join(root, 'knowledge-state.json'), JSON.stringify(state())); freezeHeartbeat = true; },
    drop: value => { dropCommands = value; }, intercept: fn => { intercept = fn; }};
}

// Cross-language fixture executes the actual fact adapter. Only scalar native
// accessors and lifecycle callbacks are injected, not the coordinator protocol.
function factRuntime() {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const literal = value => value === null || value === undefined ? 'nil'
    : typeof value === 'string' ? JSON.stringify(value) : typeof value !== 'object' ? String(value)
      : '{' + Object.entries(value).map(([key, item]) => '[' + (Array.isArray(value) ? Number(key) + 1 : JSON.stringify(key)) + ']=' + literal(item)).join(',') + '}';
  function pull(index) {
    index = lua.lua_absindex(L, index);
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TNIL) return null;
    if (type === lua.LUA_TBOOLEAN) return !!lua.lua_toboolean(L, index);
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
    assert.equal(type, lua.LUA_TTABLE);
    const result = {}; lua.lua_pushnil(L);
    while (lua.lua_next(L, index)) { result[pull(-2)] = pull(-1); lua.lua_pop(L, 1); }
    const keys = Object.keys(result);
    return keys.length && keys.every((key, i) => Number(key) === i + 1) ? keys.map(key => result[key]) : result;
  }
  function run(code) {
    const status = lauxlib.luaL_dostring(L, to_luastring(code));
    if (status !== lua.LUA_OK) { const message = to_jsstring(lua.lua_tostring(L, -1)); lua.lua_settop(L, 0); throw new Error(message); }
    const value = lua.lua_gettop(L) ? pull(-1) : null; lua.lua_settop(L, 0); return value;
  }
  run('Identity=(function()' + factSource + '\nend)()\n' + [
    'e={values={},writes=0,world=true,runtimeCounter=0}',
    'e.facts={GetFactStr=function(_,name)return e.values[name] or 0 end,',
    ' SetFactStr=function(_,name,value)',
    ' e.writes=e.writes+1',
    " if e.failBefore==e.writes then e.failBefore=nil;error('interrupted-before-write')end",
    ' e.values[name]=value',
    " if e.failAfter==e.writes then e.failAfter=nil;error('interrupted-after-write')end",
    ' end}',
    'function e.replace(restoreQualified)',
    ' e.runtimeCounter=e.runtimeCounter+1',
    " local runtimeId=string.format('%032x',e.runtimeCounter)",
    ' e.runtime=Identity.new({runtimeId=runtimeId,getFacts=function()return e.facts end,isWorldAvailable=function()return e.world end,',
    ' writeQualified=true,restoreQualified=restoreQualified~=false,collisionAudit={version=1,storage=Identity.storage,',
    " collisionCount=0,completeWithinScope=true,knownFactCount=1,factNames=Identity.factNames,corpusDigest=string.rep('a',64)}})",
    ' e.runtime.attachCurrentWorld()',
    'end', 'e.replace()',
    'function e.inspect()return e.runtime.identityFactory({}).inspect()end',
    'function e.capture()local n=e.inspect();return e.runtime.identityFactory({activationId=n.activationId}).capture()end',
    'function e.apply(c)return e.runtime.identityFactory({activationId=c.activationId}).apply(c)end',
  ].join('\n'));
  return {run, literal, inspect: () => run('return e.inspect()'), capture: () => run('return e.capture()'),
    apply: command => run('return e.apply(' + literal(command) + ')'), snapshot: () => run('return e.values'),
    restore: snapshot => run('e.runtime.invalidate(); e.values=' + literal(snapshot) + '; return e.runtime.onRestored()'),
    reload: qualified => run('e.replace(' + (qualified === false ? 'false' : 'true') + ')'),
    close: () => lua.lua_close(L)};
}
async function factFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyberpunk-fact-coordinator-')), path = join(root, 'ledger.json');
  const native = factRuntime(), calls = []; let service, now = Date.parse('2026-09-30T12:00:00Z'), ack, intercept, drop = false;
  const io = {
    async read(file) {
      if (basename(file) === 'knowledge-state.json') {
        const inspection = native.inspect();
        return JSON.stringify({version: 1, status: inspection.status === 'inspected' ? 'ready' : 'unavailable',
          publishedAt: now, worldGeneration: inspection.generation, inspection, identity: native.capture(), ack});
      }
      try { return await readFile(file, 'utf8'); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    },
    async write(file, raw) {
      await mkdir(dirname(file), {recursive: true}); await writeFile(file, raw);
      if (basename(file) !== 'knowledge-command.json') return;
      const c = JSON.parse(raw); calls.push(c); if (intercept) await intercept(c);
      if (!drop) { const result = native.apply(c); ack = {id: c.id, ok: result.ok, reason: result.reason}; }
    },
    async wait(ms) { now += ms; },
  };
  async function open() {
    service = await KnowledgeService.open({runtimeDir: root, ledgerPath: path, pack, io, now: () => now,
      commandTimeoutMs: 150, factIdentityEnabled: true, ...options}); return service;
  }
  function capture(value = 1) {
    const n = native.inspect();
    return {version: 1, status: 'ready', gameVersion: '2.31', generation: n.generation,
      worldToken: [n.generation, n.runtimeId, n.activationId, n.branchId].join(':'), capturedAt: new Date(now).toISOString(),
      identity: {status: 'unknown'}, audience: {channel: 'private', profileKeys: [P]}, activeQuestKeys: ['fixture-choice'],
      facts: {choice: {status: 'known', value, present: true, sourceId: 'native-capture', evidenceRefs: ['capture:choice']}}, journal: {}};
  }
  const project = value => service.project({profileKey: P, generation: native.inspect().generation, snapshot: capture(value)});
  t.after(async () => { await service?.close(); native.close(); await rm(root, {recursive: true, force: true}); });
  await open(); return {get service() {return service;}, native, calls, io, root, path, capture, project, open,
    intercept: fn => {intercept = fn;}, drop: value => {drop = value;}};
}

test('fact backend is opt-in and disabled projection remains dynamic without writes', async t => {
  const f = await factFixture(t, {factIdentityEnabled: false});
  const result = await f.project(1);
  assert.equal(f.service.status().reason, 'FACT_IDENTITY_DISABLED');
  assert.match(result.knowledgeContext, /fixture route 1/); assert.equal(result.eventsRecorded.length, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.native.run('return e.writes'), 0);
});

test('fact seed and append execute the actual Lua adapter only after durable registry and ledger writes', async t => {
  const f = await factFixture(t);
  f.intercept(async c => {
    if (!c.preparedRecord) return;
    const entry = JSON.parse(await readFile(join(f.root, 'knowledge-fact-commits', c.preparedRecord.commitGeneration + '.json'), 'utf8'));
    assert.deepEqual(entry.record, c.preparedRecord);
    assert.equal(entry.expectedHead, c.expected.factHead);
    const stored = JSON.parse(await readFile(f.path, 'utf8'));
    if (c.kind === 'advance') assert.equal(Object.keys(stored.data.events).length, c.ledgerSequence);
  });
  const identity = await f.service.refresh();
  assert.equal(identity.status, 'verified', JSON.stringify(f.service.status()));
  assert.equal(identity.storage, 'quest-facts-v1'); assert.equal(identity.factHead, 2);
  assert.ok(identity.worldToken.includes(identity.runtimeId));
  const guard = f.service.guard(), result = await f.project(1);
  assert.equal(result.recordError, undefined, JSON.stringify(result)); assert.equal(result.eventsRecorded.length, 1);
  assert.equal(f.native.inspect().ledgerSequence, 1); assert.equal(f.service.saveIdentity.factHead, 5);
  assert.deepEqual(f.service.guard(), guard, 'legitimate cursor/head advance must not invalidate its owning request');
  const binding = JSON.parse(await readFile(join(f.root, 'knowledge-binding.json'), 'utf8'));
  assert.equal(binding.identity.factHead, 5);
});

test('fact bridge restart resumes exact activation; CET replacement carries local prefix without sealing it', async t => {
  const f = await factFixture(t); await f.service.refresh(); await f.project(1);
  const before = f.service.saveIdentity, calls = f.calls.length;
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.saveIdentity.branchId, before.branchId); assert.equal(f.calls.length, calls);
  const guard = f.service.guard();
  f.native.reload(); await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.notEqual(f.service.saveIdentity.branchId, before.branchId); assert.notEqual(f.service.saveIdentity.runtimeId, before.runtimeId);
  assert.equal(f.service.isCurrent(guard), false);
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 1);
  assert.equal(f.service.saveIdentity.restoredProof, null); assert.deepEqual(f.service.ledger.pending(), []);
});

test('actual fact restore forks only the proven older prefix and never reuses commit generations', async t => {
  const f = await factFixture(t); await f.service.refresh(); await f.project(1);
  const saved = f.native.snapshot(), branch = f.native.inspect().branchId;
  await f.project(2); const high = f.native.inspect().commitGeneration;
  f.native.restore(saved); await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.notEqual(f.native.inspect().branchId, branch);
  assert.ok(f.native.inspect().commitGeneration > high);
  assert.equal(f.service.saveIdentity.restoredProof.kind, 'native-facts-restored');
  const episodes = f.service.ledger.contextFor({characterKey: P}).episodes;
  assert.equal(episodes.length, 1); assert.match(episodes[0].text, /route 1/);
  assert.ok(f.service.ledger.pending().length > 0); assert.deepEqual(f.service.pendingCloud(), []);
});

test('native fact restoration receipt remains registry-confirmed after both physical banks rotate', async t => {
  const f = await factFixture(t); await f.service.refresh(); await f.project(1);
  const saved = f.native.snapshot(), loadedRecord = f.native.inspect();
  f.native.restore(saved); await f.service.refresh();
  const guard = f.service.guard();
  for (let i = 0; i < 2; i++) {
    const receipt = await f.service.recordActivity({requestId: 'after-restore-' + i, profileKey: P,
      channel: 'private', audience: [P], kind: 'submitted-input', guard});
    assert.equal(receipt.status, 'recorded', JSON.stringify(receipt));
  }
  const inspection = f.native.inspect();
  assert.ok(inspection.banks.every(bank => bank.record.commitGeneration !== loadedRecord.commitGeneration));
  assert.equal(inspection.restoredProof.kind, 'native-facts-restored');
  assert.equal(inspection.restoredProof.commitGeneration, loadedRecord.commitGeneration);
  assert.equal(inspection.restoredProof.ledgerSequence, loadedRecord.ledgerSequence);
  const confirmed = f.calls.at(-1).confirmedRecords;
  assert.ok(confirmed.some(record => record.commitGeneration === loadedRecord.commitGeneration));
  assert.ok(confirmed.length <= 5);
});

test('unqualified actual restore remains an unverified local carry with no export', async t => {
  const f = await factFixture(t); await f.service.refresh(); await f.project(1);
  const saved = f.native.snapshot(); f.native.reload(false); f.native.restore(saved);
  await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.equal(f.service.saveIdentity.restoredProof, null);
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 1);
  assert.deepEqual(f.service.ledger.pending(), []);
});

test('stale runtime/head command cannot mutate a replacement fact activation', async t => {
  const f = await factFixture(t); await f.service.refresh();
  f.intercept(c => {if (c.kind === 'advance') {f.native.reload(); f.intercept(null);}});
  const result = await f.project(1);
  assert.equal(result.recordError, 'NATIVE_ACTIVATION_CHANGED'); assert.equal(result.knowledgeContext, '');
  assert.equal(f.native.inspect().ledgerSequence, 0);
  await f.service.refresh(); assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
});

test('unknown fact registry or changed tuple never authorizes writes', async t => {
  const f = await factFixture(t); await f.service.refresh(); const calls = f.calls.length;
  const path = join(f.root, 'knowledge-fact-commits', '1.json');
  const entry = JSON.parse(await readFile(path, 'utf8')); entry.record.branchId = 'e'.repeat(32);
  await writeFile(path, JSON.stringify(entry)); await f.service.refresh();
  assert.equal(f.service.status().reason, 'FACT_REGISTRY_MISMATCH'); assert.equal(f.calls.length, calls);
  assert.equal(f.service.saveIdentity.status, 'unavailable');
});

test('fact append crash before command publication recovers the exact durable operation', async t => {
  const f = await factFixture(t); await f.service.refresh(); f.drop(true);
  const result = await f.project(1); assert.equal(result.recordError, 'NATIVE_COMMAND_TIMEOUT');
  assert.equal(f.native.inspect().ledgerSequence, 0);
  await f.service.close(); f.drop(false); await f.open(); await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.equal(f.native.inspect().ledgerSequence, 1); assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 1);
});

test('fact head flip with lost native acknowledgement resumes only its same-runtime durable append', async t => {
  const f = await factFixture(t); await f.service.refresh();
  f.intercept(c => {
    if (c.kind === 'advance') {
      f.native.run("e.failAfter=e.writes+23"); f.intercept(null);
    }
  });
  const result = await f.project(1);
  assert.equal(result.recordError, 'NATIVE_CAS_REJECTED', JSON.stringify(result));
  assert.equal(f.native.inspect().ledgerSequence, 1); assert.equal(f.native.inspect().resolved, false);
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.equal(f.native.inspect().ledgerSequence, 1); assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 1);
});

test('fact partial inactive-bank append can resume and finish only the same prepared commit', async t => {
  const f = await factFixture(t); await f.service.refresh();
  f.intercept(c => {if (c.kind === 'advance') {f.native.run('e.failAfter=e.writes+5'); f.intercept(null);}});
  const result = await f.project(1); assert.equal(result.recordError, 'NATIVE_CAS_REJECTED');
  assert.equal(f.native.inspect().ledgerSequence, 0);
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.equal(f.native.inspect().commitGeneration, 2); assert.equal(f.native.inspect().ledgerSequence, 1);
});

test('REST pool needs explicit first setup; old cloud flag and normal open never allocate IDs', async t => {
  const f = await fixture(t, {cloudQualified: true});
  await f.service.refresh();
  assert.equal(f.service.sessionIdentity(P).restEndUserId, null); assert.equal(f.service.configFor(P), null);
  await assert.rejects(f.service.initializeRestPool({allowNewAllocation: true}), {code: 'REST_MEMORY_DISABLED'});
  assert.equal([...f.files.keys()].some(path => path.includes('knowledge-provider-users')), false);
  const enabled = await fixture(t, {cloudQualified: true, restMemoryEnabled: true});
  await enabled.service.refresh();
  await assert.rejects(enabled.service.initializeRestPool(), {code: 'REST_POOL_NEW_ALLOCATION_NOT_AUTHORIZED'});
  assert.equal(enabled.service.restPoolStatus().allocated, 0);
});

test('one explicit REST user survives repeated saves, older restores, new branches, groups, copies and both restarts', async t => {
  const f = await factFixture(t, {cloudQualified: true, restMemoryEnabled: true});
  await f.service.refresh();
  const pool = await f.service.initializeRestPool({allowNewAllocation: true});
  assert.equal(pool.allocated, 1); assert.equal(pool.limit, 3);
  const restId = f.service.sessionIdentity(P).restEndUserId;
  assert.match(restId, /^[a-f0-9-]{36}$/); assert.equal(f.service.configFor(P), null);
  await f.project(1); const saved = f.native.snapshot();
  await f.project(2);
  for (let i = 0; i < 3; i++) {
    f.native.restore(saved); await f.service.refresh();
    assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
    assert.equal(f.service.sessionIdentity(P).restEndUserId, restId);
    assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 1);
    for (const [profile, channel, audience] of [[P, 'private', [P]], [P, 'phone', [P]],
      [Q, 'private', [Q]], [P, 'group', [Q, P]], [P, 'group', [P, 'johnny-silverhand']]]) {
      assert.equal(f.service.sessionIdentity(profile, channel, audience).restEndUserId, restId);
      assert.equal(f.service.configFor(profile, channel, audience), null);
    }
    const pending = f.service.pendingCloud();
    assert.ok(pending.length > 0);
    assert.ok(pending.every(row => row.restEndUserId === restId && row.endUserId !== restId
      && row.providerPolicy === 'explicit-rest-anonymous-live-v1'));
    await f.project(2); // Branch again after the rollback.
  }
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.sessionIdentity(P).restEndUserId, restId);
  f.native.reload(); await f.service.refresh();
  assert.equal(f.service.sessionIdentity(P).restEndUserId, restId);
  const oldCampaign = f.service.saveIdentity.campaignId;
  f.native.restore({}); await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.notEqual(f.service.saveIdentity.campaignId, oldCampaign);
  assert.equal(f.service.sessionIdentity(P).restEndUserId, restId);
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
  assert.equal((await f.service.initializeRestPool()).allocated, 1);
  const registry = JSON.parse(await readFile(join(f.root, 'knowledge-provider-users.json'), 'utf8'));
  assert.deepEqual(registry.slots, [restId]); assert.equal(f.service.configFor(P), null);
});

test('missing pool publication recovers exact durable allocation receipt without minting again', async t => {
  const f = await fixture(t, {restMemoryEnabled: true}); await f.service.refresh();
  await f.service.initializeRestPool({allowNewAllocation: true});
  const id = f.service.sessionIdentity(P).restEndUserId;
  const path = join(f.root, 'knowledge-provider-users.json');
  f.files.delete(path);
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.sessionIdentity(P).restEndUserId, id);
  assert.deepEqual(JSON.parse(f.files.get(path)).slots, [id]);
  assert.equal((await f.service.initializeRestPool()).allocated, 1);
});

test('REST allocation interrupted before publication reuses the durable receipt UUID', async t => {
  const f = await fixture(t, {restMemoryEnabled: true}); await f.service.refresh();
  const write = f.service.io.write;
  f.service.io.write = async (path, raw) => {
    if (basename(path) === 'knowledge-provider-users.json') throw Object.assign(new Error('publication interrupted'), {code: 'ENOSPC'});
    return write(path, raw);
  };
  await assert.rejects(f.service.initializeRestPool({allowNewAllocation: true}), {code: 'ENOSPC'});
  const receipt = JSON.parse(f.files.get(join(f.root, 'knowledge-provider-users-allocation.json')));
  assert.equal(receipt.slots.length, 1);
  f.service.io.write = write;
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.sessionIdentity(P).restEndUserId, receipt.slots[0]);
  assert.equal((await f.service.initializeRestPool()).allocated, 1);
});

test('pool corruption, mismatch or more than three slots fails closed without replacement', async t => {
  for (const mutate of [
    pool => {pool.slots = [...pool.slots, '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];},
    pool => {pool.localUserId = '11111111-1111-4111-8111-111111111111';},
    pool => {pool.slots[0] = '11111111-1111-4111-8111-111111111111';},
  ]) {
    const f = await fixture(t, {restMemoryEnabled: true}); await f.service.refresh();
    await f.service.initializeRestPool({allowNewAllocation: true});
    const path = join(f.root, 'knowledge-provider-users.json'), originalReceipt = f.files.get(join(f.root, 'knowledge-provider-users-allocation.json'));
    const altered = JSON.parse(f.files.get(path)); mutate(altered); f.files.set(path, JSON.stringify(altered));
    await f.service.close(); await f.open(); await f.service.refresh();
    assert.equal(f.service.sessionIdentity(P).restEndUserId, null);
    await assert.rejects(f.service.initializeRestPool({allowNewAllocation: true}));
    assert.equal(f.files.get(join(f.root, 'knowledge-provider-users-allocation.json')), originalReceipt);
  }
});

test('complete pool loss cannot silently replace a known user and a clean restart still requires explicit setup', async t => {
  const f = await fixture(t, {restMemoryEnabled: true}); await f.service.refresh();
  await f.service.initializeRestPool({allowNewAllocation: true});
  f.files.delete(join(f.root, 'knowledge-provider-users.json'));
  f.files.delete(join(f.root, 'knowledge-provider-users-allocation.json'));
  await assert.rejects(f.service.initializeRestPool({allowNewAllocation: true}), {code: 'REST_POOL_LOST_RESTORE_REQUIRED'});
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.sessionIdentity(P).restEndUserId, null);
  await assert.rejects(f.service.initializeRestPool(), {code: 'REST_POOL_NEW_ALLOCATION_NOT_AUTHORIZED'});
  assert.equal([...f.files.keys()].some(path => path.includes('knowledge-provider-users')), false);
});

test('uncertain REST attempts keep their original destination and are never remapped to another slot', async t => {
  const f = await fixture(t, {restMemoryEnabled: true, cloudQualified: true});
  await f.service.refresh(); await f.service.initializeRestPool({allowNewAllocation: true}); await f.project(1);
  const saved = structuredClone(f.native); f.restore(saved); await f.service.refresh();
  const realPending = f.service.ledger.pending.bind(f.service.ledger), rows = realPending();
  assert.ok(rows.length);
  f.service.ledger.pending = () => rows.map(row => ({...row, restEndUserId: '11111111-1111-4111-8111-111111111111'}));
  assert.deepEqual(f.service.pendingCloud(), []);
  f.service.ledger.pending = realPending;
  assert.ok(f.service.pendingCloud().length);
});

test('first identity is cryptographic, durable before native seed, and only exposed after readback', async t => {
  const f = await fixture(t);
  assert.equal(f.service.saveIdentity.status, 'unavailable');
  f.intercept(async command => {
    if (command.kind === 'seed') {
      const saved = JSON.parse(await readFile(f.path, 'utf8'));
      assert.equal(Object.values(saved.data.branches)[0].branchId, command.branchId);
      assert.equal(f.service.configFor(P), null);
    }
  });
  const id = await f.service.refresh();
  assert.equal(id.status, 'verified'); assert.match(id.campaignId, /^[a-f0-9]{32}$/);
  assert.notEqual(id.campaignId, id.branchId); assert.deepEqual(f.calls.map(c => c.kind), ['claim', 'seed']);
  assert.equal(f.service.configFor(P), null); assert.ok(f.service.sessionIdentity(P).localScopeId);
  const binding = JSON.parse(f.files.get(join(f.root, 'knowledge-binding.json')));
  assert.equal(binding.identity.userId, id.userId);
});

test('native cursor advances only after durable event, and current facts remain usable without identity', async t => {
  const f = await fixture(t);
  f.native.ready = false;
  const dynamic = await f.project();
  assert.match(dynamic.knowledgeContext, /fixture route 1/); assert.equal(dynamic.eventsRecorded.length, 0);
  assert.equal(dynamic.remoteConfig, null);
  f.native.ready = true; await f.service.refresh();
  f.intercept(async command => {
    if (command.kind === 'advance') {
      const saved = JSON.parse(await readFile(f.path, 'utf8'));
      assert.equal(Object.keys(saved.data.events).length, command.ledgerSequence);
    }
  });
  const result = await f.project();
  assert.equal(result.recordError, undefined); assert.equal(result.eventsRecorded.length, 1);
  assert.equal(f.native.ledgerSequence, 1); assert.equal(result.remoteConfig, null); assert.equal(f.service.pendingCloud().length, 0);
  const duplicate = await f.project(); assert.equal(duplicate.eventsRecorded[0].duplicate, true);
  assert.equal(f.calls.filter(c => c.kind === 'advance').length, 1);
});

test('two independent campaigns never reuse namespace or local event history', async t => {
  const f = await fixture(t); await f.service.refresh(); await f.project();
  const first = f.service.saveIdentity, namespace = f.service.sessionIdentity(P).localScopeId;
  Object.assign(f.native, {schema: 0, generation: 2, revision: 0, activationId: '', resolved: false,
    campaignId: undefined, branchId: undefined, branchEpoch: 0, ledgerSequence: 0, restoredProof: undefined});
  const second = await f.service.refresh();
  assert.notEqual(second.campaignId, first.campaignId); assert.equal(second.userId, first.userId);
  assert.notEqual(f.service.sessionIdentity(P).localScopeId, namespace); assert.equal(f.service.configFor(P), null);
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
});

test('loading an older saved prefix always forks before routes and inherits no later event', async t => {
  const f = await fixture(t, {cloudQualified: true}); await f.service.refresh(); await f.project(1);
  const saved = structuredClone(f.native), firstBranch = saved.branchId, oldNamespace = f.service.sessionIdentity(P).localScopeId;
  await f.project(2); assert.equal(f.native.ledgerSequence, 2);
  const oldGuard = f.service.guard(); f.restore(saved);
  await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.notEqual(f.native.branchId, firstBranch); assert.equal(f.native.ledgerSequence, 0);
  assert.notEqual(f.service.sessionIdentity(P).localScopeId, oldNamespace); assert.equal(f.service.isCurrent(oldGuard), false);
  const context = f.service.ledger.contextFor({characterKey: P});
  assert.equal(context.episodes.length, 1); assert.match(context.episodes[0].text, /route 1/);
  assert.ok(f.service.ledger.pending().length > 0); assert.deepEqual(f.service.pendingCloud(), []);
  const currentBranch = f.native.branchId;
  await f.service.refresh(); assert.equal(f.native.branchId, currentBranch);
});

test('bridge restart in the same native activation resumes exact live cursor without forking', async t => {
  const f = await fixture(t); await f.service.refresh(); await f.project();
  const id = f.service.saveIdentity, calls = f.calls.length;
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.service.saveIdentity.status, 'verified');
  assert.equal(f.service.saveIdentity.branchId, id.branchId); assert.equal(f.calls.length, calls);
  assert.equal(f.service.saveIdentity.ledgerSequence, 1);
});

test('heartbeat expiry unbinds routes and invalidates previously returned guards', async t => {
  const f = await fixture(t); await f.service.refresh(); const guard = f.service.guard();
  f.freeze(); f.advance(6000);
  assert.equal(f.service.configFor(P), null); assert.equal(f.service.isCurrent(guard), false);
  await f.service.refresh(); assert.equal(f.service.status().reason, 'HEARTBEAT_EXPIRED');
  assert.equal(f.service.ledger.identity, null);
});

test('durable append failure cannot advance native cursor or expose a memory route', async t => {
  const f = await fixture(t); await f.service.refresh();
  const persist = f.service.ledger._persist.bind(f.service.ledger);
  f.service.ledger._persist = async () => { throw Object.assign(new Error('disk full'), {code: 'ENOSPC'}); };
  const result = await f.project();
  assert.equal(result.recordError, 'ENOSPC'); assert.match(result.knowledgeContext, /fixture route 1/);
  assert.equal(f.native.ledgerSequence, 0); assert.equal(f.calls.filter(c => c.kind === 'advance').length, 0);
  assert.equal(result.remoteConfig, null);
  f.service.ledger._persist = persist;
});

test('crash after durable append but before CAS recovers only the exact write-ahead event', async t => {
  const f = await fixture(t); await f.service.refresh(); f.drop(true);
  const result = await f.project(); assert.equal(result.recordError, 'NATIVE_COMMAND_TIMEOUT');
  assert.equal(f.native.ledgerSequence, 0);
  await f.service.close(); f.drop(false); await f.open(); await f.service.refresh();
  assert.equal(f.native.ledgerSequence, 1); assert.equal(f.service.saveIdentity.status, 'verified');
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 1);
});

test('a stale advance racing a load never increments the newly restored timeline', async t => {
  const f = await fixture(t); await f.service.refresh(); const saved = structuredClone(f.native);
  f.intercept(async command => { if (command.kind === 'advance') { f.restore(saved); f.intercept(null); } });
  const result = await f.project();
  assert.equal(result.remoteConfig, null); assert.equal(result.knowledgeContext, '');
  assert.equal(f.native.ledgerSequence, 0);
  await f.service.refresh(); assert.equal(f.service.saveIdentity.status, 'verified', JSON.stringify(f.service.status()));
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
});

test('missing capture token is dynamic-only; old same-generation token cannot acquire new identity', async t => {
  const f = await fixture(t); await f.service.refresh();
  const missing = f.capture(); delete missing.worldToken;
  const result = await f.project(1, {snapshot: missing});
  assert.match(result.knowledgeContext, /fixture route 1/); assert.equal(result.eventsRecorded.length, 0);
  assert.equal(result.remoteConfig, null);
  const stale = f.capture(); stale.worldToken = `1:${'a'.repeat(32)}:${'b'.repeat(32)}`;
  const invalid = await f.project(1, {snapshot: stale});
  assert.doesNotMatch(invalid.knowledgeContext, /fixture route 1/); assert.equal(invalid.remoteConfig, null);
});

test('local group scopes retain exact audiences without allocating any provider users', async t => {
  const f = await fixture(t); await f.service.refresh();
  const privateId = f.service.sessionIdentity(P).localScopeId;
  const ab = await f.project(1, {channel: 'group', audience: [P, Q]});
  const ac = await f.project(1, {channel: 'group', audience: [P, 'johnny-silverhand']});
  assert.equal(ab.recordError, undefined, JSON.stringify(ab)); assert.equal(ac.recordError, undefined, JSON.stringify(ac));
  const abScope = f.service.sessionIdentity(P, 'group', [P, Q]).localScopeId;
  assert.notEqual(abScope, f.service.sessionIdentity(P, 'group', [P, 'johnny-silverhand']).localScopeId);
  assert.notEqual(privateId, abScope);
  assert.equal(abScope, f.service.sessionIdentity(P, 'group', [Q, P]).localScopeId);
  assert.equal(ab.remoteConfig, null); assert.equal(ac.remoteConfig, null);
});

test('AfterSave serialization receipt alone never creates eligible cloud writes', async t => {
  const f = await fixture(t, {cloudQualified: true}); await f.service.refresh(); await f.project();
  f.native.checkpoint = {id: `${f.native.branchId}:1:1`, proof: 'serialization-finished', ledgerSequence: 1};
  f.native.revision++; await f.service.refresh();
  assert.deepEqual(f.service.pendingCloud(), []);
});

test('shared ambient templates get dynamic facts without persistent observations or cloud identities', async t => {
  const f = await fixture(t); await f.service.refresh();
  const result = await f.project(1, {profileKey: 'resident-male', audience: ['resident-male']});
  assert.match(result.knowledgeContext, /fixture route 1/); assert.equal(result.eventsRecorded.length, 0);
  assert.equal(result.memoryReason, 'ambient-identity-unavailable'); assert.equal(result.remoteConfig, null);
  assert.equal(f.service.configFor('resident-female'), null);
  const mixed = await f.project(1, {channel: 'group', audience: [P, 'resident-female']});
  assert.equal(mixed.eventsRecorded.length, 0); assert.equal(mixed.remoteConfig, null);
  assert.equal(f.native.ledgerSequence, 0); assert.ok(f.service.sessionIdentity(P));
});

test('cancellation during a native acknowledgment wait cannot release captured context or old config', async t => {
  const f = await fixture(t); await f.service.refresh();
  let cancellation;
  f.intercept(async command => { if (command.kind === 'advance') cancellation = f.service.cancel('load-cancelled'); });
  const result = await f.project(); await cancellation;
  assert.equal(result.recordError, 'CANCELLED'); assert.equal(result.knowledgeContext, '');
  assert.equal(result.remoteConfig, null); assert.equal(f.service.configFor(P), null);
});

test('native unavailability while appending invalidates the in-flight world context', async t => {
  const f = await fixture(t); await f.service.refresh();
  f.intercept(async command => { if (command.kind === 'advance') f.native.ready = false; });
  const result = await f.project();
  assert.equal(result.recordError, 'NATIVE_UNAVAILABLE'); assert.equal(result.knowledgeContext, '');
  assert.equal(result.remoteConfig, null); assert.equal(f.native.ledgerSequence, 0);
});

test('an unjournalled durable suffix cannot be silently resumed or moved into native state', async t => {
  const f = await fixture(t); await f.service.refresh();
  const nativeBranch = f.native.branchId;
  await f.service.ledger.recordActivity({activityId: 'external-unacknowledged-activity', requestId: 'turn-1', characterKey: P,
    kind: 'submitted-input', identity: f.service.saveIdentity});
  await f.service.refresh();
  assert.equal(f.service.status().reason, 'ORPHAN_LEDGER_TAIL'); assert.equal(f.service.configFor(P), null);
  assert.equal(f.native.branchId, nativeBranch); assert.equal(f.native.ledgerSequence, 0);
});

test('submitted activity is durably acknowledged before send and never enters context or cloud outbox', async t => {
  const f = await fixture(t, {cloudQualified: true}); await f.service.refresh();
  const guard = f.service.guard();
  const result = await f.service.recordActivity({requestId: 'turn-1', profileKey: P, kind: 'submitted-input',
    channel: 'private', audience: [P], guard});
  assert.equal(result.status, 'recorded'); assert.equal(result.sendAllowed, true);
  assert.equal(result.ledgerSequence, 1); assert.equal(result.cursor.ledgerSequence, 1);
  const liveBinding = JSON.parse(f.files.get(join(f.root, 'knowledge-binding.json')));
  assert.equal(liveBinding.status, 'ready'); assert.equal(liveBinding.identity.ledgerSequence, 1,
    'Lua receives the newly acknowledged cursor before this transaction returns');
  assert.equal(f.service.isCurrent(guard), true, 'legitimate cursor increments do not change the world guard');
  assert.deepEqual(result.guard, guard); assert.equal(result.remoteConfig, null);
  const disk = JSON.parse(await readFile(f.path, 'utf8'));
  const stored = Object.values(disk.data.events)[0];
  assert.equal(stored.kind, 'transport-activity'); assert.equal(stored.eligibleForMemory, false);
  assert.deepEqual(stored.audience, [P]); assert.equal(stored.provenance.requestId, 'turn-1');
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
  f.restore(structuredClone(f.native)); await f.service.refresh();
  assert.equal(f.service.pendingCloud().length, 0, 'even a restored activity is not a conversation memory');
});

test('generated is distinct from completed native delivery, with route and partial receipt validation', async t => {
  const f = await fixture(t); await f.service.refresh();
  const base = {requestId: 'world-turn', profileKey: P, channel: 'group', audience: [P, Q], guard: f.service.guard()};
  assert.equal((await f.service.recordActivity({...base, kind: 'delivered-reply',
    delivery: {source: 'native-playback', state: 'completed', requestId: base.requestId}})).reason, 'SUBMISSION_NOT_RECORDED');
  assert.equal((await f.service.recordActivity({...base, kind: 'submitted-input'})).status, 'recorded');
  assert.equal((await f.service.recordActivity({...base, kind: 'generated-reply', metadata: {providerTurnId: 'provider-1'}})).status, 'recorded');
  for (const delivery of [
    {source: 'native-playback', state: 'published', requestId: base.requestId},
    {source: 'native-playback', state: 'completed', requestId: 'another-turn'},
    {source: 'native-playback', state: 'completed', requestId: base.requestId, partial: true},
    {source: 'native-playback', state: 'completed', requestId: base.requestId, cancelled: true},
    {source: 'native-playback', state: 'completed', requestId: base.requestId, totalChunks: 3, completedChunks: 2},
    {source: 'phone-ui', state: 'accepted', requestId: base.requestId},
  ]) assert.equal((await f.service.recordActivity({...base, kind: 'delivered-reply', delivery})).reason, 'DELIVERY_NOT_CONFIRMED');
  assert.equal(f.native.ledgerSequence, 2);
  const delivered = await f.service.recordActivity({...base, kind: 'delivered-reply',
    delivery: {source: 'native-playback', state: 'completed', requestId: base.requestId, totalChunks: 3, completedChunks: 3}});
  assert.equal(delivered.status, 'recorded'); assert.equal(delivered.ledgerSequence, 3);
  assert.equal(delivered.sendAllowed, false);
  assert.equal(f.service.ledger.contextFor({characterKey: P, channel: 'group', audience: [P, Q]}).episodes.length, 0);
});

test('phone delivery requires UI acceptance for the same request and exact audience', async t => {
  const f = await fixture(t); await f.service.refresh();
  const base = {requestId: 'phone-turn', profileKey: P, channel: 'phone', audience: [P], guard: f.service.guard()};
  await f.service.recordActivity({...base, kind: 'submitted-input'});
  const wrong = await f.service.recordActivity({...base, profileKey: Q, audience: [Q], kind: 'delivered-reply',
    delivery: {source: 'phone-ui', state: 'accepted', requestId: base.requestId}});
  assert.equal(wrong.reason, 'SUBMISSION_NOT_RECORDED');
  const published = await f.service.recordActivity({...base, kind: 'delivered-reply',
    delivery: {source: 'phone-ui', state: 'published', requestId: base.requestId}});
  assert.equal(published.reason, 'DELIVERY_NOT_CONFIRMED');
  const accepted = await f.service.recordActivity({...base, kind: 'delivered-reply',
    delivery: {source: 'phone-ui', state: 'accepted', requestId: base.requestId}});
  assert.equal(accepted.status, 'recorded'); assert.equal(accepted.ledgerSequence, 2);
});

test('duplicate submission is idempotent and cannot grant a second identified send', async t => {
  const f = await fixture(t); await f.service.refresh();
  const input = {requestId: 'one-send', profileKey: P, kind: 'submitted-input', guard: f.service.guard()};
  const first = await f.service.recordActivity(input), repeated = await f.service.recordActivity(input);
  assert.equal(first.sendAllowed, true); assert.equal(repeated.receipt.duplicate, true); assert.equal(repeated.sendAllowed, false);
  assert.equal(f.native.ledgerSequence, 1);
  const changed = await f.service.recordActivity({...input, metadata: {code: 'different-payload'}});
  assert.equal(changed.reason, 'ACTIVITY_ID_CONFLICT'); assert.equal(f.native.ledgerSequence, 1);
});

test('cancelled turns reject late generated and delivered receipts without damaging another current route', async t => {
  const f = await fixture(t); await f.service.refresh();
  const base = {requestId: 'cancel-me', profileKey: P, guard: f.service.guard()};
  await f.service.recordActivity({...base, kind: 'submitted-input'});
  const cancelled = await f.service.recordActivity({...base, kind: 'cancelled-turn', metadata: {code: 'user-cancelled'}});
  assert.equal(cancelled.status, 'recorded'); assert.equal(cancelled.remoteConfig, null);
  const late = await f.service.recordActivity({...base, kind: 'delivered-reply',
    delivery: {source: 'native-playback', state: 'completed', requestId: base.requestId}});
  assert.equal(late.reason, 'TURN_ALREADY_CANCELLED'); assert.equal(f.native.ledgerSequence, 2);
  assert.ok(f.service.sessionIdentity(P));
});

test('stale, ambient and transcript-bearing activity inputs cannot become durable receipts', async t => {
  const f = await fixture(t); await f.service.refresh();
  const base = {requestId: 'stale-turn', profileKey: P, kind: 'submitted-input', guard: f.service.guard()};
  const ambient = await f.service.recordActivity({...base, profileKey: 'resident-male'});
  assert.equal(ambient.reason, 'ambient-identity-unavailable');
  assert.equal((await f.service.recordActivity({...base, metadata: {text: 'Do not duplicate transcripts here.'}})).reason, 'INVALID_ACTIVITY_METADATA');
  f.restore(structuredClone(f.native));
  const stale = await f.service.recordActivity(base);
  assert.equal(stale.reason, 'STALE_ACTIVITY'); assert.equal(f.native.ledgerSequence, 0);
});

async function stageConversation(f, {requestId = 'remembered-turn', profileKey = P, channel = 'private',
  audience = [profileKey], userText = 'I miss the old neighbourhood.', replyText = 'We can visit it together.'} = {}) {
  const base = {requestId, profileKey, channel, audience, guard: f.service.guard()};
  const submitted = await f.service.recordActivity({...base, kind: 'submitted-input', userText});
  assert.equal(submitted.status, 'recorded', JSON.stringify(submitted));
  const generated = await f.service.recordActivity({...base, kind: 'generated-reply', replyText});
  assert.equal(generated.status, 'recorded', JSON.stringify(generated));
  return {base, submitted, generated, delivery: {
    source: channel === 'phone' ? 'phone-ui' : 'native-playback', state: channel === 'phone' ? 'accepted' : 'completed',
    requestId, replyHash: generated.replyHash}};
}

test('one complete delivered exchange becomes one quoted episode after its durable native transaction', async t => {
  const f = await fixture(t, {cloudQualified: true}); await f.service.refresh();
  const staged = await stageConversation(f);
  assert.match(staged.generated.replyHash, /^[a-f0-9]{64}$/);
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
  assert.equal(f.service.pendingCloud().length, 0);
  f.intercept(async command => {
    if (command.kind !== 'advance' || command.ledgerSequence !== 3) return;
    const disk = JSON.parse(await readFile(f.path, 'utf8'));
    const episodes = Object.values(disk.data.events).filter(row => row.authority === 'delivered-conversation');
    assert.equal(episodes.length, 1, 'episode must be durable before cursor CAS');
    assert.equal(f.service.configFor(P), null, 'no route during an unacknowledged append');
  });
  const delivered = await f.service.recordActivity({...staged.base, kind: 'delivered-reply', delivery: staged.delivery});
  assert.equal(delivered.status, 'recorded'); assert.equal(delivered.conversationMemoryRecorded, true);
  assert.equal(delivered.ledgerSequence, 3, 'one final append represents delivery and its episode');
  assert.equal(f.calls.filter(c => c.kind === 'advance').length, 3);
  const [episode] = f.service.ledger.contextFor({characterKey: P}).episodes;
  assert.equal(episode.authority, 'delivered-conversation');
  assert.match(episode.text, /quoted statements, not verified game facts/);
  assert.match(episode.text, /V said "I miss the old neighbourhood\."/);
  assert.match(episode.text, /judy-alvarez replied "We can visit it together\."/);
  assert.equal(episode.provenance.speakerKey, P); assert.equal(episode.provenance.statementAuthority, 'quoted-conversation-only');
  assert.equal(f.service.pendingCloud().length, 0, 'delivery alone is not restored-prefix proof');
  const repeated = await f.service.recordActivity({...staged.base, kind: 'delivered-reply', delivery: staged.delivery});
  assert.equal(repeated.receipt.duplicate, true); assert.equal(f.native.ledgerSequence, 3);
});

test('a staged reply must match the exact fully delivered output hash', async t => {
  const f = await fixture(t); await f.service.refresh();
  const staged = await stageConversation(f);
  for (const delivery of [
    {...staged.delivery, replyHash: 'b'.repeat(64)},
    {...staged.delivery, replyHash: undefined},
  ]) {
    const result = await f.service.recordActivity({...staged.base, kind: 'delivered-reply', delivery});
    assert.equal(result.reason, 'DELIVERED_TEXT_MISMATCH');
  }
  const partial = await f.service.recordActivity({...staged.base, kind: 'delivered-reply',
    delivery: {...staged.delivery, totalChunks: 4, completedChunks: 3}});
  assert.equal(partial.reason, 'DELIVERY_NOT_CONFIRMED');
  assert.equal(f.native.ledgerSequence, 2); assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
  await f.service.recordActivity({...staged.base, kind: 'cancelled-turn'});
  const late = await f.service.recordActivity({...staged.base, kind: 'delivered-reply', delivery: staged.delivery});
  assert.equal(late.reason, 'TURN_ALREADY_CANCELLED');
  f.restore(structuredClone(f.native)); await f.service.refresh();
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0, 'staged or cancelled text does not survive as memory');
  assert.deepEqual(f.service.pendingCloud(), []);
});

test('staged originals are immutable, explicit, and bounded without truncating a memory', async t => {
  const f = await fixture(t); await f.service.refresh();
  const staged = await stageConversation(f);
  assert.equal((await f.service.recordActivity({...staged.base, kind: 'submitted-input', userText: 'Different original.'})).reason, 'ACTIVITY_ID_CONFLICT');
  assert.equal((await f.service.recordActivity({...staged.base, kind: 'generated-reply', replyText: 'Different output.'})).reason, 'ACTIVITY_ID_CONFLICT');
  assert.equal((await f.service.recordActivity({...staged.base, kind: 'generated-reply', userText: 'Wrong stage.'})).reason, 'INVALID_ACTIVITY_TEXT_STAGE');
  assert.equal((await f.service.recordActivity({...staged.base, requestId: 'huge', kind: 'submitted-input', userText: 'x'.repeat(16001)})).reason, 'INVALID_CONVERSATION_TEXT');
  assert.equal(f.native.ledgerSequence, 2);

  const long = await stageConversation(f, {requestId: 'long-original', userText: 'z'.repeat(1201)});
  assert.equal(long.submitted.memoryReason, 'conversation-text-too-long');
  const delivered = await f.service.recordActivity({...long.base, kind: 'delivered-reply', delivery: long.delivery});
  assert.equal(delivered.status, 'recorded'); assert.equal(delivered.conversationMemoryRecorded, false);
  assert.equal(delivered.memoryReason, 'conversation-text-too-long');
  assert.equal((await readFile(f.path, 'utf8')).includes('z'.repeat(1201)), false, 'no over-limit original or truncated substitute stored');
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 0);
});

test('bridge restart retains staged text but only an actual same-world delivery promotes it', async t => {
  const f = await fixture(t); await f.service.refresh();
  const staged = await stageConversation(f, {channel: 'phone'}), branch = f.native.branchId;
  await f.service.close(); await f.open(); await f.service.refresh();
  assert.equal(f.native.branchId, branch); assert.equal(f.service.isCurrent(staged.base.guard), true);
  assert.equal(f.service.ledger.contextFor({characterKey: P, channel: 'phone'}).episodes.length, 0);
  const accepted = await f.service.recordActivity({...staged.base, kind: 'delivered-reply', delivery: staged.delivery});
  assert.equal(accepted.conversationMemoryRecorded, true); assert.equal(f.native.ledgerSequence, 3);
  assert.equal(f.service.ledger.contextFor({characterKey: P, channel: 'phone'}).episodes.length, 1);
});

test('rollback restores completed dialogue only inside the proven local prefix and exposes no provider IDs', async t => {
  const f = await fixture(t, {cloudQualified: true}); await f.service.refresh();
  const earlier = await stageConversation(f, {channel: 'phone'});
  await f.service.recordActivity({...earlier.base, kind: 'delivered-reply', delivery: earlier.delivery});
  const saved = structuredClone(f.native), oldScope = f.service.sessionIdentity(P).localScopeId;
  const later = await stageConversation(f, {requestId: 'future-turn', userText: 'This happened after the save.', replyText: 'A future reply.'});
  await f.service.recordActivity({...later.base, kind: 'delivered-reply', delivery: later.delivery});
  assert.equal(f.service.ledger.contextFor({characterKey: P}).episodes.length, 2);
  f.restore(saved); await f.service.refresh();
  assert.notEqual(f.service.sessionIdentity(P).localScopeId, oldScope); assert.equal(f.native.ledgerSequence, 0);
  const episodes = f.service.ledger.contextFor({characterKey: P, channel: 'phone'}).episodes;
  assert.equal(episodes.length, 1); assert.match(episodes[0].text, /old neighbourhood/);
  assert.equal(episodes.some(row => /future/i.test(row.text)), false);
  const pending = f.service.ledger.pending();
  assert.equal(pending.length, 1); assert.match(pending[0].text, /old neighbourhood/);
  assert.equal(f.service.configFor(P), null); assert.deepEqual(f.service.pendingCloud(), []);
  const staleDelivery = await f.service.recordActivity({...later.base, kind: 'delivered-reply', delivery: later.delivery});
  assert.equal(staleDelivery.reason, 'STALE_ACTIVITY'); assert.equal(f.native.ledgerSequence, 0);
});

test('group dialogue uses only verified witnesses and never spills into a different audience', async t => {
  const f = await fixture(t); await f.service.refresh();
  const staged = await stageConversation(f, {channel: 'group', audience: [Q, P]});
  const wrong = await f.service.recordActivity({...staged.base, kind: 'delivered-reply',
    delivery: {...staged.delivery, witnessedBy: [P, 'johnny-silverhand']}});
  assert.equal(wrong.reason, 'INVALID_DELIVERY_AUDIENCE'); assert.equal(f.native.ledgerSequence, 2);
  await f.service.recordActivity({...staged.base, kind: 'delivered-reply', delivery: staged.delivery});
  assert.equal(f.service.ledger.contextFor({characterKey: Q}).episodes.length, 0, 'no inferred witness from audience membership alone');
  assert.equal(f.service.ledger.contextFor({characterKey: P, channel: 'group', audience: [P, Q]}).episodes.length, 1);
  assert.equal(f.service.ledger.contextFor({characterKey: P, channel: 'group', audience: [P, 'johnny-silverhand']}).episodes.length, 0);

  const witnessed = await stageConversation(f, {requestId: 'heard-by-both', channel: 'group', audience: [P, Q]});
  await f.service.recordActivity({...witnessed.base, kind: 'delivered-reply',
    delivery: {...witnessed.delivery, witnessedBy: [Q, P]}});
  const [episode] = f.service.ledger.contextFor({characterKey: Q, channel: 'group', audience: [P, Q]}).episodes;
  assert.equal(episode.witnessed, true); assert.deepEqual(episode.provenance.audience, [P, Q]);
});

test('crash after durable conversation delivery recovers one exact episode and cursor', async t => {
  const f = await fixture(t); await f.service.refresh();
  const staged = await stageConversation(f); f.drop(true);
  const interrupted = await f.service.recordActivity({...staged.base, kind: 'delivered-reply', delivery: staged.delivery});
  assert.equal(interrupted.reason, 'NATIVE_COMMAND_TIMEOUT'); assert.equal(f.native.ledgerSequence, 2);
  await f.service.close(); f.drop(false); await f.open(); await f.service.refresh();
  assert.equal(f.native.ledgerSequence, 3); assert.equal(f.service.saveIdentity.status, 'verified');
  const episodes = f.service.ledger.contextFor({characterKey: P}).episodes;
  assert.equal(episodes.length, 1); assert.equal(episodes[0].authority, 'delivered-conversation');
});

function finishSaveAfter(f, milliseconds = 100) {
  const wait = f.service.io.wait; let waited = 0;
  f.service.io.wait = async ms => {
    await wait(ms); waited += ms;
    if (waited >= milliseconds) {
      f.native.saving = false; f.native.revision++;
      f.service.io.wait = wait;
    }
  };
}

test('a brief same-world autosave waits without rebinding or invalidating the original guard', async t => {
  const f = await fixture(t); await f.service.refresh();
  const guard = f.service.guard(), branch = f.native.branchId, remote = f.service.configFor(P), calls = f.calls.length;
  f.native.saving = true; f.native.revision++; finishSaveAfter(f, 200);
  assert.equal(await f.service.current(guard), true);
  assert.equal(f.native.branchId, branch); assert.deepEqual(f.service.guard(), guard);
  assert.deepEqual(f.service.configFor(P), remote); assert.equal(f.calls.length, calls);
});

test('an ongoing save withholds new routes but retains the lease until its exact world returns', async t => {
  const f = await fixture(t); await f.service.refresh();
  const guard = f.service.guard(), calls = f.calls.length;
  f.native.saving = true; f.native.revision++;
  assert.equal(await f.service.current(guard), false);
  assert.equal(f.service.saveIdentity.reason, 'save-in-progress'); assert.equal(f.service.configFor(P), null);
  assert.ok(f.service.ledger.identity, 'an observed save pause alone is not a new campaign or activation');
  assert.equal(f.calls.length, calls);
  f.native.saving = false; f.native.revision++;
  assert.equal(await f.service.current(guard), true); assert.deepEqual(f.service.guard(), guard);
});

test('a load during the save wait cannot renew an old request guard', async t => {
  const f = await fixture(t); await f.service.refresh();
  const guard = f.service.guard(), saved = structuredClone(f.native), wait = f.service.io.wait;
  f.native.saving = true; f.native.revision++;
  f.service.io.wait = async ms => { await wait(ms); f.restore(saved); f.service.io.wait = wait; };
  assert.equal(await f.service.current(guard), false); assert.equal(f.service.configFor(P), null);
  await f.service.refresh();
  assert.notEqual(f.native.branchId, saved.branchId); assert.equal(f.service.isCurrent(guard), false);
});

test('native cursor mutation waits if saving starts after the durable event write', async t => {
  const f = await fixture(t); await f.service.refresh();
  const observe = f.service.ledger.observe.bind(f.service.ledger);
  f.service.ledger.observe = async event => {
    const result = await observe(event); f.native.saving = true; f.native.revision++;
    finishSaveAfter(f); return result;
  };
  f.intercept(async command => { if (command.kind === 'advance') assert.equal(f.native.saving, false); });
  const guard = f.service.guard();
  const recorded = await f.service.recordActivity({requestId: 'autosave-intent', profileKey: P, kind: 'submitted-input', guard});
  assert.equal(recorded.status, 'recorded', JSON.stringify(recorded)); assert.equal(recorded.sendAllowed, true);
  assert.equal(f.native.ledgerSequence, 1); assert.equal(f.service.isCurrent(guard), true);
});

test('a save racing command publication can retry one rejected CAS with the unchanged original authority', async t => {
  const f = await fixture(t); await f.service.refresh(); const guard = f.service.guard();
  f.intercept(async command => {
    if (command.kind !== 'advance') return;
    f.intercept(null); f.native.saving = true; f.native.revision++; finishSaveAfter(f);
  });
  const recorded = await f.service.recordActivity({requestId: 'autosave-race', profileKey: P, kind: 'submitted-input', guard});
  assert.equal(recorded.status, 'recorded', JSON.stringify(recorded)); assert.equal(recorded.sendAllowed, true);
  assert.equal(f.native.ledgerSequence, 1); assert.equal(f.calls.filter(c => c.kind === 'advance').length, 2);
  assert.equal(f.service.isCurrent(guard), true);
});

test('a successful cursor CAS immediately followed by a save is recognized from final readback', async t => {
  const f = await fixture(t); await f.service.refresh(); const guard = f.service.guard(), read = f.service.io.read;
  let savingStarted = false;
  f.service.io.read = async file => {
    if (basename(file) === 'knowledge-state.json' && f.native.ledgerSequence === 1 && !savingStarted) {
      savingStarted = true; f.native.saving = true; f.native.revision++; finishSaveAfter(f);
    }
    return read(file);
  };
  const recorded = await f.service.recordActivity({requestId: 'autosave-after-cas', profileKey: P, kind: 'submitted-input', guard});
  assert.equal(recorded.status, 'recorded', JSON.stringify(recorded)); assert.equal(recorded.sendAllowed, true);
  assert.equal(f.native.ledgerSequence, 1); assert.equal(f.calls.filter(c => c.kind === 'advance').length, 1);
  assert.equal(f.service.isCurrent(guard), true);
});
