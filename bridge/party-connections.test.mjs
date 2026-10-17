import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PartyConnections, parsePartyConnections, connectionKey, CONNECTION_LIMIT, SPAWNED_LIMIT, spawnedWarmLimit} from './party-connections.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {NearbyWarm} from './nearby-warm.mjs';

const flush = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
const profiles = ['alex', 'judy', 'panam', 'kerry', 'viktor', 'misty', 'river', 'jackie'];
// Characters beyond the eight warm private connections (the party has no size limit).
const extraProfiles = ['evelyn', 'claire', 'wakako', 'rogue', 'takemura', 'saul', 'goro', 'hanako'];
const everyone = [...profiles, ...extraProfiles];
function fixture({canWarm = () => true, deferWarm, spawnedLimit, warmDeferred} = {}) {
  let time = 100000;
  const live = new Map(), calls = [], reports = [], pending = [], refreshes = [];
  const host = {fail: false, defer: false,
    async retain(configs, options) {
      assert.equal(options.protect, true); assert.ok(configs.length <= CONNECTION_LIMIT);
      const wanted = new Set(configs.map(config => connectionKey(config.characterId, config.scope)));
      for (const identity of live.keys()) if (!wanted.has(identity)) live.delete(identity);
      host.wanted = wanted;
    },
    async warm(config, {signal}) {
      calls.push({profile: config.characterId, scope: config.scope, at: time, signal});
      if (host.defer) { const wait = deferred(); pending.push(wait); await wait.promise; }
      if (signal.aborted) throw Error('cancelled');
      if (host.fail) throw Error('service unavailable');
      const identity = connectionKey(config.characterId, config.scope);
      if (!live.has(identity)) live.set(identity, {});
      return {connectionMs: 123};
    },
    async readiness(config, {keepAlive}) {
      assert.equal(keepAlive, true);
      const page = live.get(connectionKey(config.characterId, config.scope));
      return {present: !!page, ready: !!page && page.ready !== false, busy: page?.busy === true};
    },
    async refreshIdle(config) {
      const identity = connectionKey(config.characterId, config.scope);
      refreshes.push(identity);
      if (live.get(identity)?.busy) return false;
      live.delete(identity); return true;
    },
  };
  const connections = new PartyConnections({host, now: () => time, canWarm, ...(deferWarm ? {deferWarm} : {}), ...(spawnedLimit ? {spawnedLimit} : {}), ...(warmDeferred ? {warmDeferred} : {}),
    isKnown: profile => [...everyone, 'nearby'].includes(profile),
    configFor: (profile, scope) => ({key: 'secret-key', characterId: profile, scope, sessionId: 'secret-session'}),
    onState: state => reports.push(state),
  });
  const heartbeat = members => connections.ingest({updated: time, profiles: members});
  const step = async (ms = 500) => { time += ms; await connections.maintain(); await flush(); };
  return {connections, host, live, calls, reports, pending, refreshes, heartbeat, step, now: () => time};
}

test('party protocol preserves slot order, deduplicates profiles, has no size limit and rejects future snapshots', () => {
  assert.deepEqual(parsePartyConnections({updated: 100, profiles: ['panam', 'alex', 'panam']}, 100), {updated: 100, profiles: ['panam', 'alex']});
  for (const bad of [{}, {updated: 6000, profiles: []},
    {updated: 100, profiles: ['bad/key']}, {updated: '100', profiles: []}]) assert.equal(parsePartyConnections(bad, 100), null);
  // A party past the eight formation places is a valid snapshot, not a rejected one.
  const large = Array.from({length: 40}, (_, index) => 'member-' + index);
  assert.deepEqual(parsePartyConnections({updated: 100, profiles: large}, 100), {updated: 100, profiles: large});
});

test('spawn warms without a composer, duplicate copies reuse identity, dismissal of last copy closes its page', async () => {
  const f = fixture(); f.heartbeat(['alex', 'alex']); await f.step(0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].scope, 'private');
  const page = f.live.get(connectionKey('alex', 'private'));
  f.heartbeat(['alex']); await f.step();
  assert.equal(f.calls.length, 1); assert.equal(f.live.get(connectionKey('alex', 'private')), page);
  const removed = f.heartbeat([]); await f.step();
  assert.deepEqual(removed.removed, ['alex']); assert.equal(f.live.size, 0);
});

test('changing the voice route renews only affected connections and rejects stale warm completion', async () => {
  const f = fixture(); f.heartbeat(['alex', 'judy']);
  await f.step(0); await f.step(500);
  const alex = f.connections.entries.get(connectionKey('alex', 'private'));
  const before = f.connections.entries.get(connectionKey('judy', 'private'));
  assert.equal(before.state, 'ready');
  await f.connections.reconfigure(['judy']);
  const after = f.connections.entries.get(connectionKey('judy', 'private'));
  assert.notEqual(before, after); assert.equal(after.state, 'waiting');
  assert.equal(f.connections.entries.get(connectionKey('alex', 'private')), alex);
  f.host.defer = true; await f.step(500);
  const pending = f.connections.entries.get(connectionKey('judy', 'private'));
  await f.connections.reconfigure(['judy']); f.pending[0].resolve(); await flush();
  assert(pending.controller.signal.aborted);
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).state, 'waiting');
  await f.connections.clear();
});

test('scope refresh replaces only the requested metadata entry and leaves the current plan intact', async () => {
  const f = fixture(); f.heartbeat(['alex', 'judy']);
  for (let i = 0; i < 4; i++) await f.step(i ? 500 : 0);
  const scope = 'group:alex,judy', key = connectionKey('judy', 'private');
  const before = new Map(f.connections.entries), old = before.get(key), plan = f.connections.plan();
  assert.equal(old.state, 'ready');
  const refreshing = f.connections.refreshScope('judy', 'private');
  assert.ok(f.connections.entries.has(key), 'refresh never leaves a metadata hole while reconciliation awaits');
  assert.notEqual(f.connections.entries.get(key), old);
  assert.equal(await refreshing, true);
  const renewed = f.connections.entries.get(key);
  assert.notEqual(renewed, old); assert.equal(renewed.state, 'waiting'); assert.equal(renewed.nextCheck, 0);
  for (const [identity, entry] of before) if (identity !== key) assert.equal(f.connections.entries.get(identity), entry);
  assert.equal(f.connections.entries.get(connectionKey('judy', scope)), before.get(connectionKey('judy', scope)));
  assert.deepEqual(f.connections.plan(), plan);
  assert.equal(await f.connections.refreshScope('judy', 'phone'), false);
  await f.step(); assert.equal(renewed.state, 'ready');
  assert.equal(f.calls.at(-1).profile, 'judy'); assert.equal(f.calls.at(-1).scope, 'private');
  await f.connections.clear();
});

test('an old warm completion cannot mark a refreshed scope ready or alter another scope', async () => {
  const f = fixture(); f.heartbeat(['alex', 'judy']); f.host.defer = true;
  await f.step(0);
  const key = connectionKey('alex', 'private'), old = f.connections.entries.get(key);
  const group = f.connections.entries.get(connectionKey('alex', 'group:alex,judy'));
  assert.equal(old.state, 'connecting');
  assert.equal(await f.connections.refreshScope('alex', 'private'), true);
  const renewed = f.connections.entries.get(key);
  assert.equal(old.controller.signal.aborted, true); assert.notEqual(renewed, old);
  f.pending[0].resolve(); await old.pending; await flush();
  assert.equal(renewed.state, 'waiting'); assert.equal(renewed.attempts, 0);
  assert.equal(f.connections.entries.get(connectionKey('alex', 'group:alex,judy')), group);
  f.host.defer = false; await f.step(); assert.equal(renewed.state, 'ready');
  await f.connections.clear();
});

test('all eight private connections coexist with three group pages and survive composer changes', async () => {
  const f = fixture(); f.heartbeat(profiles);
  for (let i = 0; i < 11; i++) { f.heartbeat(profiles); await f.step(); }
  assert.equal(f.live.size, 11);
  const privatePages = profiles.map(profile => f.live.get(connectionKey(profile, 'private')));
  await f.connections.setComposer({scope: 'group:jackie,kerry,misty', audience: ['jackie', 'kerry', 'misty']});
  for (let i = 0; i < 3; i++) { f.heartbeat(profiles); await f.step(); }
  for (let i = 0; i < profiles.length; i++) assert.equal(f.live.get(connectionKey(profiles[i], 'private')), privatePages[i]);
  assert.equal(f.live.size, 11);
  await f.connections.setComposer(null); await f.step();
  for (let i = 0; i < profiles.length; i++) assert.equal(f.live.get(connectionKey(profiles[i], 'private')), privatePages[i]);
  const report = JSON.stringify(f.connections.diagnostic());
  assert.ok(!report.includes('secret-key') && !report.includes('secret-session'));
});

test('a nearby private target uses the optional group allocation without evicting eight party connections', async () => {
  const f = fixture(); f.heartbeat(profiles);
  await f.connections.setComposer({scope: 'private', audience: ['nearby']});
  const plan = f.connections.plan();
  assert.equal(plan.length, 11); assert.equal(plan.filter(row => row.scope === 'private').length, 9);
  assert.equal(plan.filter(row => row.role === 'group').length, 2);
});

test('setup is staggered and capped at two pending attempts; removed startup cannot return', async () => {
  const f = fixture(); f.host.defer = true; f.heartbeat(['alex', 'judy', 'panam']);
  await f.step(0); await f.step(499); assert.equal(f.calls.length, 1);
  await f.step(1); await f.step(500); assert.equal(f.calls.length, 2);
  assert.equal(f.connections.diagnostic().connecting, 2);
  f.heartbeat(['judy', 'panam']); await f.step();
  assert.equal(f.calls[0].signal.aborted, true);
  f.pending[0].resolve(); await flush();
  assert.equal(f.live.has(connectionKey('alex', 'private')), false);
  await f.connections.clear(); for (const wait of f.pending) wait.resolve(); await flush();
});

test('persistent failure backs off to five minutes and recovers automatically while the party remains present', async () => {
  const f = fixture(); f.host.fail = true; f.heartbeat(['alex']); await f.step(0);
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 14; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 1);
  f.heartbeat(['alex']); await f.step(2000);
  assert.equal(f.calls.length, 2);
  for (let i = 0; i < 30; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 3); assert.equal(f.connections.diagnostic().connections[0].state, 'cooldown');
  assert.equal(f.connections.diagnostic().connections[0].retryAt, f.now() + 300000);
  for (let i = 0; i < 20; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 3);
  f.host.fail = false;
  for (let i = 0; i < 130; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 4); assert.equal(f.connections.diagnostic().connections[0].state, 'ready');
});

test('stale heartbeat clears party and group resources; an empty fresh party clears the last spawn', async () => {
  const f = fixture(); f.heartbeat(['alex', 'judy']); await f.step(0); await f.step(500);
  assert.equal(f.live.size, 2);
  await f.step(6501); assert.equal(f.connections.stale, true); assert.equal(f.live.size, 0);
  f.heartbeat(['alex']); await f.step(); assert.equal(f.live.size, 1);
  f.heartbeat([]); await f.step(); assert.equal(f.live.size, 0);
});

test('voice session cleanup only closes its own lease and leaves party browser ownership intact', async () => {
  const host = new RealtimeHost(); let closed = 0, grants = 0, discarded;
  const page = {url: () => 'http://127.0.0.1:1', context: () => ({grantPermissions: async () => { grants++; }, clearPermissions: async () => {}}),
    evaluate: async fn => String(fn).includes('beginVoice') ? {device: 'fake'} : {text: 'reply'}};
  host.start = async () => {}; host.close = async () => { closed++; };
  host.pool = {acquire: async () => ({value: page, release: async options => { discarded = options.discard; }})};
  const channel = host.voiceChannel();
  assert.equal(grants, 0);
  await channel.beginVoice({characterId: 'alex', scope: 'private'});
  await channel.finishVoice(); await channel.close();
  assert.equal(grants, 1); assert.equal(discarded, false); assert.equal(closed, 0);
});

test('invitation retention hands the same private page to party membership and releases only the last owner', async () => {
  const f = fixture();
  await f.connections.setInvitations(['judy', 'judy']);
  assert.deepEqual(f.connections.invitations, ['judy']);
  assert.equal((await f.connections.warmInvitation('judy')).ready, true);
  const page = f.live.get(connectionKey('judy', 'private'));
  f.heartbeat(['judy']); await f.connections.setInvitations([]);
  assert.equal(f.live.get(connectionKey('judy', 'private')), page);
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).role, 'party');
  await f.step(); assert.equal(f.calls.length, 1);
  f.heartbeat([]); await f.step(); assert.equal(f.live.size, 0);
});

test('eight party and invitation identities fit the protected allocation and a ninth reservation is accepted without exceeding it', async () => {
  const f = fixture(); f.heartbeat(profiles.slice(0, 5));
  await f.connections.setInvitations(profiles.slice(5));
  assert.equal(f.connections.plan().length, CONNECTION_LIMIT);
  assert.equal(f.connections.plan().filter(row => row.scope === 'private').length, 8);
  // There is no party limit: the ninth reservation is accepted. A pending invitation outranks the member
  // who was talked to least recently, so the warm private places stay at eight.
  await f.connections.setInvitations([...profiles.slice(5), 'nearby']);
  assert.deepEqual(f.connections.invitations, [...profiles.slice(5), 'nearby']);
  const specs = f.connections.plan(), privateSpecs = specs.filter(row => row.scope === 'private');
  assert.equal(privateSpecs.length, 8); assert(specs.length <= CONNECTION_LIMIT);
  assert(privateSpecs.some(spec => spec.profile === 'nearby' && spec.role === 'invitation'));
  assert(!privateSpecs.some(spec => spec.profile === 'viktor'), 'the last party member in list order connects lazily');
  await f.connections.clear();
});

test('a party past the warm limit keeps eight private connections, opens the others on talk and keeps the most recently talked-to warm', async () => {
  const f = fixture(); const party = everyone.slice(0, 12);
  f.heartbeat(party);
  let specs = f.connections.plan(), warm = specs.filter(spec => spec.scope === 'private');
  assert.deepEqual(warm.map(spec => spec.profile), profiles); assert(warm.every(spec => spec.role === 'party'));
  assert(specs.length <= CONNECTION_LIMIT);
  // V talks to a member who is not warm: the request takes an optional place, never one of the protected eight.
  await f.connections.setRequest({profileKey: 'wakako'});
  specs = f.connections.plan(); warm = specs.filter(spec => spec.scope === 'private');
  assert.equal(warm.length, 9); assert.equal(warm.at(-1).profile, 'wakako'); assert.equal(warm.at(-1).role, 'party');
  assert(profiles.every(profile => warm.some(spec => spec.profile === profile)));
  assert(specs.length <= CONNECTION_LIMIT);
  f.connections.used({profileKey: 'wakako'}, {connectionMs: 5});
  await f.connections.setRequest(null);
  // The conversation partner is now the most recently used: it keeps a warm place and the idlest member gives
  // theirs up, still eight private connections in all.
  warm = f.connections.plan().filter(spec => spec.scope === 'private');
  assert.equal(warm.length, 8); assert(warm.some(spec => spec.profile === 'wakako' && spec.role === 'party'));
  assert(!warm.some(spec => spec.profile === 'jackie'));
  // A member who leaves is forgotten.
  f.heartbeat(party.filter(profile => profile !== 'wakako'));
  assert(!f.connections.lastUsed.has('wakako'));
  await f.connections.clear();
});

test('an invitation past the warm places waits for a place instead of failing, and takes it as soon as an earlier one joins', async () => {
  const f = fixture(); f.heartbeat([]);
  const wanted = everyone.slice(0, 9);
  await f.connections.setInvitations(wanted);
  assert.equal(f.connections.plan().filter(spec => spec.scope === 'private').length, 8);
  const waiting = await f.connections.warmInvitation(wanted[8]);
  assert.equal(waiting.gated, true); assert.equal(waiting.ready, false);
  assert.equal((await f.connections.invitationReadiness(wanted[8])).ready, false);
  // The first invitation joins the party and stops being an invitation: the ninth takes a place, and the
  // new member (the only one who is not pending) connects lazily from then on.
  f.heartbeat([wanted[0]]); await f.connections.setInvitations(wanted.slice(1));
  const warm = f.connections.plan().filter(spec => spec.scope === 'private').map(spec => spec.profile);
  assert.deepEqual(warm, wanted.slice(1));
  assert.equal((await f.connections.warmInvitation(wanted[8])).ready, true);
  await f.connections.clear();
});

test('foreground dispatch gating preserves ready pages and explicit warm shares the maintenance attempt', async () => {
  let allowed = false;
  const f = fixture({canWarm: () => allowed});
  await f.connections.setInvitations(['judy']);
  assert.equal((await f.connections.warmInvitation('judy')).gated, true);
  await f.step(0); assert.equal(f.calls.length, 0);
  allowed = true; f.host.defer = true; await f.step(0);
  const first = f.connections.warmInvitation('judy');
  await flush(); assert.equal(f.calls.length, 1);
  f.pending[0].resolve(); await first;
  const page = f.live.get(connectionKey('judy', 'private'));
  allowed = false;
  assert.equal((await f.connections.warmInvitation('judy')).ready, true);
  await f.step(); assert.equal(f.live.get(connectionKey('judy', 'private')), page);
  assert.equal(f.calls.length, 1); await f.connections.clear();
});

test('explicit invitations honor the two-start cap and stagger without blocking behind the foreground gate', async () => {
  const f = fixture(); f.host.defer = true;
  await f.connections.setInvitations(['alex', 'judy', 'panam']);
  const alex = f.connections.warmInvitation('alex'); await flush();
  assert.equal((await f.connections.warmInvitation('judy')).gated, true);
  await f.step(500);
  const judy = f.connections.warmInvitation('judy'); await flush();
  assert.equal((await f.connections.warmInvitation('panam')).gated, true);
  assert.equal(f.calls.length, 2);
  f.pending[0].resolve(); f.pending[1].resolve(); await Promise.all([alex, judy]);
  await f.connections.clear();
});

test('scoped memory retirement discards only the target private and group pages', async () => {
  const f = fixture(); f.heartbeat(['alex', 'judy']);
  for (let i = 0; i < 4; i++) await f.step(i ? 500 : 0);
  const other = new Map([...f.live].filter(([key]) => JSON.parse(key)[0] === 'judy'));
  const old = f.connections.entries.get(connectionKey('alex', 'private'));
  await f.connections.retireInvitation('alex');
  assert.deepEqual(f.refreshes, [connectionKey('alex', 'private'), connectionKey('alex', 'group:alex,judy')]);
  assert.equal(f.connections.entries.get(connectionKey('alex', 'private')).state, 'waiting');
  assert.notEqual(f.connections.entries.get(connectionKey('alex', 'private')), old);
  for (const [key, page] of other) assert.equal(f.live.get(key), page);
  await f.connections.clear();
});

test('scoped retirement fences a pending warm before disposal and blocks new target dispatch', async () => {
  const f = fixture(); f.host.defer = true; f.heartbeat(['alex', 'judy']);
  await f.step(0);
  const key = connectionKey('alex', 'private'), old = f.connections.entries.get(key);
  const retiring = f.connections.retireInvitation('alex');
  await flush(); assert.equal(old.controller.signal.aborted, true);
  const renewed = f.connections.entries.get(key);
  assert.notEqual(renewed, old);
  assert.equal((await f.connections.warmInvitation('alex')).gated, true);
  assert.equal(f.calls.length, 1);
  f.pending[0].resolve(); await retiring;
  assert.equal(renewed.state, 'waiting'); assert.equal(f.live.has(key), false);
  assert.equal(f.refreshes.includes(connectionKey('judy', 'private')), false);
  await f.connections.clear();
});

test('a busy target lease rejects retirement without closing that lease or another profile page', async () => {
  const f = fixture(); f.heartbeat(['alex', 'judy']);
  await f.step(0); await f.step(500);
  const key = connectionKey('alex', 'private'), page = f.live.get(key), other = f.live.get(connectionKey('judy', 'private'));
  page.busy = true;
  await assert.rejects(f.connections.retireInvitation('alex'), /busy/);
  assert.equal(f.live.get(key), page); assert.equal(f.live.get(connectionKey('judy', 'private')), other);
  assert.equal(f.connections.retiring.size, 0);
  await f.connections.clear();
});

test('busy retirement remains required until disposal succeeds and cannot make an old SDK page ready', async () => {
  let allowed = true;
  const f = fixture({canWarm: () => allowed}); f.heartbeat(['alex', 'judy']);
  await f.step(0); await f.step(500);
  const key = connectionKey('alex', 'private'), page = f.live.get(key), other = f.live.get(connectionKey('judy', 'private'));
  page.busy = true;
  await assert.rejects(f.connections.retireInvitation('alex'), /busy/);
  assert.equal(f.connections.needsRetirement('alex'), true);
  assert.equal((await f.connections.invitationReadiness('alex')).ready, false);
  f.connections.used({profileKey: 'alex'}, {});
  assert.equal(f.connections.entries.get(key).state, 'waiting', 'an old submitted turn cannot remove disposal debt');
  page.busy = false; allowed = false; await f.step(500);
  assert.equal((await f.connections.warmInvitation('alex')).gated, true);
  assert.equal(f.live.get(key), page); assert.equal(f.calls.length, 2);
  allowed = true;
  assert.equal((await f.connections.warmInvitation('alex')).ready, true);
  assert.equal(f.connections.needsRetirement('alex'), false);
  assert.notEqual(f.live.get(key), page); assert.equal(f.live.get(connectionKey('judy', 'private')), other);
  await f.connections.clear();
});

test('cancelled retirement retains its exact pending disposal until a later owner finishes it', async () => {
  const f = fixture(); f.host.defer = true; f.heartbeat(['alex']); await f.step(0);
  const controller = new AbortController(), retiring = f.connections.retireInvitation('alex', {signal: controller.signal});
  controller.abort(); await assert.rejects(retiring, {name: 'AbortError'});
  assert.equal(f.connections.needsRetirement('alex'), true);
  f.pending[0].resolve(); await flush();
  assert.equal((await f.connections.invitationReadiness('alex')).ready, false);
  await f.connections.retireInvitation('alex');
  assert.equal(f.connections.needsRetirement('alex'), false);
  assert.deepEqual(f.refreshes, [connectionKey('alex', 'private')]);
  await f.connections.clear();
});

test('nearby characters get a private connection at the lowest priority and never evict a protected one', async () => {
  const f = fixture(); f.heartbeat(['alex']);
  await f.connections.setNearby(['judy', 'panam', 'kerry']);
  // Only two are kept; the party member is still first.
  assert.deepEqual(f.connections.plan().map(spec => [spec.profile, spec.scope, spec.role]),
    [['alex', 'private', 'party'], ['judy', 'private', 'nearby'], ['panam', 'private', 'nearby']]);
  await f.step(0); await f.step(500); await f.step(500);
  assert.deepEqual(f.calls.map(call => call.profile), ['alex', 'judy', 'panam']);
  assert(f.live.has(connectionKey('judy', 'private')) && f.live.has(connectionKey('panam', 'private')));
  assert(!f.live.has(connectionKey('kerry', 'private')));
  // The same list again is a no-op, not a reconnect.
  const revision = f.connections.revision;
  await f.connections.setNearby(['judy', 'panam']); assert.equal(f.connections.revision, revision);
  // A change closes the dropped page only.
  await f.connections.setNearby(['panam']);
  assert(!f.live.has(connectionKey('judy', 'private')) && f.live.has(connectionKey('panam', 'private')));
  await f.connections.setNearby([]);
  assert(!f.live.has(connectionKey('panam', 'private')) && f.live.has(connectionKey('alex', 'private')));
});

test('a full party keeps all eight private connections when nearby characters are listed', async () => {
  const f = fixture(); f.heartbeat(profiles);
  await f.connections.setNearby(['nearby']);
  const specs = f.connections.plan();
  for (const profile of profiles) assert(specs.some(spec => spec.profile === profile && spec.role === 'party'));
  assert(specs.length <= CONNECTION_LIMIT);
  assert(specs.some(spec => spec.profile === 'nearby' && spec.role === 'nearby'));
});

test('a nearby character that is also the composer target or a party member keeps its stronger role, and unknown or invalid names are refused', async () => {
  const f = fixture(); f.heartbeat(['alex']);
  await f.connections.setNearby(['alex', 'judy']);
  assert.deepEqual(f.connections.plan().map(spec => [spec.profile, spec.role]), [['alex', 'party'], ['judy', 'nearby']]);
  await f.connections.setComposer({scope: 'private', audience: ['judy']});
  assert.deepEqual(f.connections.plan().map(spec => [spec.profile, spec.role]), [['alex', 'party'], ['judy', 'target']]);
  await f.connections.setNearby(['stranger']);   // unknown to this host: planned out
  assert(!f.connections.plan().some(spec => spec.profile === 'stranger'));
  assert.throws(() => f.connections.setNearby(['bad/key']), /Invalid nearby profiles/);
  assert.throws(() => f.connections.setNearby('judy'), /Invalid nearby profiles/);
});

test('nearby characters are dropped when the party heartbeat goes stale or the connections are cleared', async () => {
  const f = fixture(); f.heartbeat(['alex']);
  await f.connections.setNearby(['judy']);
  assert(f.connections.plan().some(spec => spec.profile === 'judy'));
  await f.step(7000); await f.step(0);   // the heartbeat is older than the staleness limit
  assert.equal(f.connections.plan().length, 0);
  f.heartbeat(['alex']);
  assert.deepEqual(f.connections.nearby, [], 'a stale party kept the nearby list');
  await f.connections.setNearby(['judy']); await f.connections.clear();
  assert.deepEqual(f.connections.nearby, []);
});

// An ambient resident's exact route: its scope is unique to one physical NPC (bridge/player-knowledge.mjs).
const residentRoute = body => ({key: 'secret-key', characterId: 'resident-provider', endUserId: 'player', scope: 'private:world:' + body});

test('the composer hint opens an ambient NPC\'s own route while V types, and the submitted turn reuses that page', async () => {
  const f = fixture();
  f.heartbeat(['judy']); await f.step();
  await f.connections.setComposer({scope: 'private', audience: ['resident-male'], config: residentRoute('a')});
  for (let index = 0; index < 4; index++) await f.step();
  const opened = f.calls.filter(call => call.profile === 'resident-provider');
  assert.equal(opened.length, 1, 'the resident connection starts at the talk key, before any submission');
  assert.equal(f.connections.warmState({profileKey: 'resident-male'}, residentRoute('a')).state, 'ready');
  assert.equal(f.connections.warmState({profileKey: 'resident-male'}, residentRoute('a')).samePage, true);
  // The submitted turn carries the same route (plus a session learned later): the warm page is kept, not reopened.
  await f.connections.setRequest({profileKey: 'resident-male'}, {...residentRoute('a'), sessionId: 'later', context: 'x'});
  for (let index = 0; index < 4; index++) await f.step();
  assert.equal(f.calls.filter(call => call.profile === 'resident-provider').length, 1, 'no second connection for the same NPC');
  assert.ok(f.host.wanted.has(connectionKey('resident-provider', 'private:world:a')));
  assert.equal(JSON.stringify(f.reports.at(-1)).includes('secret'), false, 'diagnostics carry no key, user or session');
  // Another resident (same profile key, another body) replaces it.
  await f.connections.setComposer({scope: 'private', audience: ['resident-male'], config: residentRoute('b')});
  for (let index = 0; index < 4; index++) await f.step();
  assert.deepEqual(f.calls.filter(call => call.profile === 'resident-provider').map(call => call.scope), ['private:world:a', 'private:world:b']);
  assert.equal(f.host.wanted.has(connectionKey('resident-provider', 'private:world:a')), false);
  // Without a route an ambient composer target still opens nothing (it has no route without its body).
  await f.connections.setComposer({scope: 'private', audience: ['resident-male']});
  assert.equal([...f.connections.entries.values()].some(entry => entry.profile === 'resident-male'), false);
});

test('ambient nearby characters and partners warm through their entity route within the nearby and partner caps', async () => {
  const f = fixture();
  f.heartbeat(profiles); await f.step();
  await f.connections.setNearby(['resident-male', 'npc-ganger-male', 'resident-female'],
    {'resident-male': residentRoute('a'), 'npc-ganger-male': {...residentRoute('g'), characterId: 'ganger-provider'}});
  const nearby = [...f.connections.entries.values()].filter(entry => entry.role === 'nearby');
  assert.deepEqual(nearby.map(entry => entry.profile), ['resident-male', 'npc-ganger-male'], 'NEARBY_LIMIT applies, unrouted ambient names are skipped');
  assert.ok(f.connections.plan().length <= CONNECTION_LIMIT);
  // An unchanged list with the same routes is a no-op; a new body for the same key replaces the route.
  const revision = f.connections.revision;
  await f.connections.setNearby(['resident-male', 'npc-ganger-male'],
    {'resident-male': {...residentRoute('a'), sessionId: 'learned'}, 'npc-ganger-male': {...residentRoute('g'), characterId: 'ganger-provider'}});
  assert.equal(f.connections.revision, revision);
  await f.connections.setNearby(['resident-male'], {'resident-male': residentRoute('c')});
  assert.equal(f.connections.entries.get(connectionKey('resident-male', 'private')).config.scope, 'private:world:c');
  // A partner keeps its route; V addressing another body of the same key wins over the partner's.
  await f.connections.setNearby([]);
  await f.connections.setPartners(['resident-male'], {'resident-male': residentRoute('p')});
  assert.equal(f.connections.entries.get(connectionKey('resident-male', 'private')).role, 'partner');
  await f.connections.setRequest({profileKey: 'resident-male'}, residentRoute('q'));
  const entry = f.connections.entries.get(connectionKey('resident-male', 'private'));
  assert.equal(entry.role, 'target'); assert.equal(entry.config.scope, 'private:world:q');
  assert.throws(() => f.connections.setNearby(['resident-male'], {'resident-male': {key: 'k'}}), /Invalid submitted connection route/);
});

test('with a single-session plan background maintenance pre-opens nothing', async () => {
  let single = true;
  const f = fixture({deferWarm: () => single});
  f.heartbeat(['alex', 'judy']); await f.step(0); await f.step(500); await f.step(500);
  assert.equal(f.calls.length, 0, 'nothing is pre-opened for the party');
  assert.deepEqual(await f.connections.invitationReadiness('alex'), {present: true, ready: true, busy: false, deferred: true});
  assert.deepEqual(await f.connections.invitationReadiness('nobody'), {present: false, ready: false, busy: false}, 'an unknown companion is still not ready');
  single = false; await f.step(500);
  assert.ok(f.calls.length >= 1, 'connections are pre-opened again on the shared key');
  assert.notEqual((await f.connections.invitationReadiness('alex')).deferred, true);
  await f.connections.clear();
});

test('with a single-session plan a holocall caller (a composer hint marked call) is opened at once, and only her', async () => {
  let canWarm = true;
  const f = fixture({deferWarm: () => true, canWarm: () => canWarm});
  f.heartbeat(['alex']);
  // An ordinary composer hint opens nothing on this plan (the page opens when V talks).
  await f.connections.setComposer({scope: 'private', audience: ['panam']}); await flush(); await f.step(500);
  assert.equal(f.calls.length, 0, 'an ordinary composer hint pre-opens nothing');
  // The call's hint: her page opens now, and nobody else's (not the party member).
  await f.connections.setComposer({scope: 'private', audience: ['judy'], call: true}); await flush(); await flush();
  assert.deepEqual(f.calls.map(call => call.profile), ['judy']);
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).state, 'ready');
  assert.ok(f.connections.diagnostic().connections.some(row => row.profile === 'judy' && row.scope === 'private' && row.state === 'ready'),
    'the state the game reads says she is ready');
  await f.step(500); await f.step(500);
  assert.deepEqual(f.calls.map(call => call.profile), ['judy'], 'maintenance still opens nothing else');
  // Gated when the hint arrives (a turn in flight): maintenance opens her once it may.
  await f.connections.setComposer(null);
  canWarm = false;
  await f.connections.setComposer({scope: 'private', audience: ['panam'], call: true}); await flush();
  assert.equal(f.calls.filter(call => call.profile === 'panam').length, 0);
  canWarm = true; await f.step(500); await flush();
  assert.equal(f.connections.entries.get(connectionKey('panam', 'private')).state, 'ready', 'opened by maintenance');
  await f.connections.clear();
});

test('with a single-session plan an invitation opens the joining companion connection before she is ready', async () => {
  const f = fixture({deferWarm: () => true});
  await f.connections.setInvitations(['judy']);
  const status = await f.connections.warmInvitation('judy');
  assert.equal(status.ready, true);
  assert.deepEqual(f.calls.map(call => call.profile), ['judy'], 'the joining companion is connected, nobody else');
  assert.ok(f.live.has(connectionKey('judy', 'private')), 'her page is open when the invitation reports ready');
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).state, 'ready');
  await f.connections.clear();
});

test('with a single-session plan the invitation waits while the connection is still opening', async () => {
  const f = fixture({deferWarm: () => true});
  f.host.defer = true;
  await f.connections.setInvitations(['judy']);
  let settled = false;
  const warming = f.connections.warmInvitation('judy').then(value => { settled = true; return value; });
  await flush();
  assert.equal(settled, false, 'ready is not reported before the page is open');
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).state, 'connecting');
  f.pending[0].resolve();
  assert.equal((await warming).ready, true);
  assert.equal(f.calls.length, 1);
  await f.connections.clear();
});

test('with a single-session plan two invitations connect one after the other and probing never swaps them', async () => {
  const f = fixture({deferWarm: () => true});
  f.host.defer = true;
  await f.connections.setInvitations(['alex', 'judy']);
  const first = f.connections.warmInvitation('alex'); await flush();
  assert.equal((await f.connections.warmInvitation('judy')).gated, true, 'one page opens at a time');
  assert.equal(f.calls.length, 1);
  f.pending[0].resolve(); assert.equal((await first).ready, true);
  f.host.defer = false;
  await f.step(500); // starts are spaced 500 ms apart
  assert.equal((await f.connections.warmInvitation('judy')).ready, true);
  assert.deepEqual(f.calls.map(call => call.profile), ['alex', 'judy']);
  // Probes and maintenance after both are ready open nothing and report ready for both.
  for (let round = 0; round < 3; round++) {
    await f.step(500);
    assert.equal((await f.connections.invitationReadiness('alex')).ready, true);
    assert.equal((await f.connections.invitationReadiness('judy')).ready, true);
  }
  assert.equal(f.calls.length, 2, 'no page was reopened');
  await f.connections.clear();
});

test('with a single-session plan a failed connection never fails the invitation', async () => {
  const f = fixture({deferWarm: () => true});
  f.host.fail = true;
  await f.connections.setInvitations(['judy']);
  const status = await f.connections.warmInvitation('judy');
  assert.equal(status.ready, true, 'the first conversation connects on demand');
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).state, 'retrying');
  assert.equal((await f.connections.warmInvitation('judy')).ready, true, 'a cooling-down entry does not hold the invitation back');
  assert.equal(f.calls.length, 1);
  await f.connections.clear();
});

test('with a single-session plan a busy conversation holds the invitation until it can connect', async () => {
  let busy = true;
  const f = fixture({canWarm: () => !busy, deferWarm: () => true});
  await f.connections.setInvitations(['judy']);
  assert.equal((await f.connections.warmInvitation('judy')).gated, true);
  assert.equal(f.calls.length, 0);
  busy = false;
  assert.equal((await f.connections.warmInvitation('judy')).ready, true);
  assert.equal(f.calls.length, 1);
  await f.connections.clear();
});

// Characters another mod or a spawner created (docs/SPAWNED_CHARACTERS.md): their connection is opened when the game first lists them
// near V, so the first talk does not pay it. Three at most, one page per profile, the plan's rules on a player's own key.
test('spawned characters get a private connection above nearby ones, below the party, partners and the target', async () => {
  const f = fixture(); f.heartbeat(['alex']);
  await f.connections.setNearby(['kerry', 'viktor']);
  await f.connections.setSpawned(['judy', 'panam']);
  assert.deepEqual(f.connections.plan().map(spec => [spec.profile, spec.scope, spec.role]),
    [['alex', 'private', 'party'], ['judy', 'private', 'spawned'], ['panam', 'private', 'spawned'],
      ['kerry', 'private', 'nearby'], ['viktor', 'private', 'nearby']]);
  await f.connections.setPartners(['panam']);
  assert.deepEqual(f.connections.plan().map(spec => [spec.profile, spec.role]),
    [['alex', 'party'], ['panam', 'partner'], ['judy', 'spawned'], ['kerry', 'nearby'], ['viktor', 'nearby']], 'a partner keeps the stronger role');
  for (let at = 0; at < 6; at++) await f.step(500);
  assert.deepEqual(f.calls.map(call => call.profile).sort(), ['alex', 'judy', 'kerry', 'panam', 'viktor']);
  for (const call of f.calls) assert.equal(call.scope, 'private');
  // A spawned character is dropped when the game stops listing it: its page closes (unload what is unused).
  await f.connections.setSpawned([]);
  assert(!f.live.has(connectionKey('judy', 'private')) && f.live.has(connectionKey('alex', 'private')));
  assert.deepEqual(f.connections.diagnostic().spawned, []);
});

test('at most three spawned characters, one page per profile, and invalid lists are refused', async () => {
  assert.equal(SPAWNED_LIMIT, 3);
  const f = fixture(); f.heartbeat(['alex', 'judy']);
  await f.connections.setSpawned(['judy', 'panam', 'kerry', 'viktor', 'panam']);
  assert.deepEqual(f.connections.spawned, ['judy', 'panam', 'kerry'], 'listed three, no repeat');
  // Judy is a party member: one connection, her party role; the spawned copy adds nothing.
  assert.deepEqual(f.connections.plan().filter(spec => spec.scope === 'private').map(spec => [spec.profile, spec.role]),
    [['alex', 'party'], ['judy', 'party'], ['panam', 'spawned'], ['kerry', 'spawned']]);
  assert.throws(() => f.connections.setSpawned('judy'), /Invalid spawned profiles/);
  assert.throws(() => f.connections.setSpawned(['bad/key']), /Invalid spawned profiles/);
  const revision = f.connections.revision;
  await f.connections.setSpawned(['judy', 'panam', 'kerry']); assert.equal(f.connections.revision, revision, 'the same list is a no-op');
  for (let at = 0; at < 5; at++) await f.step(500);
  assert.equal(f.calls.filter(call => call.profile === 'judy').length, 1, 'a profile in two roles is opened once');
  // A profile no one knows is never opened.
  await f.connections.setSpawned(['stranger']);
  assert.deepEqual(f.connections.plan().filter(spec => spec.role === 'spawned'), []);
  // A stale party heartbeat clears the list with everything else.
  await f.connections.setSpawned(['panam']);
  await f.connections.clear(); assert.deepEqual(f.connections.spawned, []);
  assert.deepEqual(f.connections.plan(), []);
});

test('the spawned count follows the plan: fewer on a player key with a smaller plan, none when it holds one connection', async () => {
  let limit = 3;
  const f = fixture({spawnedLimit: () => limit}); f.heartbeat([]);
  await f.connections.setSpawned(['judy', 'panam', 'kerry']);
  const spawned = () => f.connections.plan().filter(spec => spec.role === 'spawned').map(spec => spec.profile);
  assert.equal(spawned().length, 3);
  limit = 1; assert.deepEqual(spawned(), ['judy']);
  limit = 9; assert.equal(spawned().length, 3, 'never above three');
  assert.equal(spawnedWarmLimit(), SPAWNED_LIMIT, 'the shared key');
  assert.equal(spawnedWarmLimit({singleSession: true, connectionLimit: 6}), 3, 'a confirmed paid plan');
  assert.equal(spawnedWarmLimit({singleSession: true, connectionLimit: 4}), 3);
  assert.equal(spawnedWarmLimit({singleSession: true, connectionLimit: 3}), 2);
  assert.equal(spawnedWarmLimit({singleSession: true, connectionLimit: 2}), 1);
  assert.equal(spawnedWarmLimit({singleSession: true, connectionLimit: 1}), 0, 'a free, unknown or unread plan');
  assert.equal(spawnedWarmLimit({singleSession: true}), 0);
  assert.equal(spawnedWarmLimit({singleSession: true, connectionLimit: NaN}), 0);
  assert.equal(spawnedWarmLimit({singleSession: false, textProvider: true}), 0, 'Mistral or the local AI');
  assert.equal(spawnedWarmLimit({singleSession: true, connectionLimit: 6, textProvider: true}), 0);
  const none = fixture({spawnedLimit: () => 0}); none.heartbeat([]);
  await none.connections.setSpawned(['judy']);
  assert.deepEqual(none.connections.plan(), []);
});

test('on a single-session plan with room only spawned characters are pre-opened; nothing else is, and a shared profile opens once', async () => {
  let room = true;
  const f = fixture({deferWarm: () => true, warmDeferred: () => room});
  f.heartbeat(['alex', 'judy']);
  await f.connections.setNearby(['kerry', 'viktor']);
  await f.connections.setSpawned(['judy', 'panam']);
  for (let at = 0; at < 6; at++) await f.step(500);
  // Panam (spawned only) and Judy (a party member the spawned copy shares): open. Alex and the nearby ones are not.
  assert.deepEqual(f.calls.map(call => call.profile).sort(), ['judy', 'panam']);
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).role, 'party');
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).alsoSpawned, true);
  assert(!f.live.has(connectionKey('alex', 'private')) && !f.live.has(connectionKey('kerry', 'private')));
  assert.deepEqual(await f.connections.invitationReadiness('alex'), {present: true, ready: true, busy: false, deferred: true}, 'invitations unchanged');
  // The plan loses its room: nothing new opens.
  room = false;
  await f.connections.setSpawned(['panam', 'kerry']);
  for (let at = 0; at < 4; at++) await f.step(500);
  assert.equal(f.calls.filter(call => call.profile === 'kerry').length, 0, 'no room: not opened');
  assert.equal(f.calls.length, 2);
  await f.connections.clear();
});

test('on a single-session plan without room spawned characters open nothing, as before', async () => {
  const f = fixture({deferWarm: () => true, warmDeferred: () => false});
  f.heartbeat([]); await f.connections.setSpawned(['judy']);
  for (let at = 0; at < 4; at++) await f.step(500);
  assert.equal(f.calls.length, 0);
  assert.equal(f.connections.entries.get(connectionKey('judy', 'private')).state, 'waiting', 'listed, not opened');
  await f.connections.clear();
});

// A profile that changes role (a spawned character V talks to becomes a partner; a released partner goes back to the spawned lane) must
// keep its open connection (2026-10-17 live bug: the partner role ended, the page closed, the next talk had to prepare it again). The
// three lists are applied in one plan change (setAmbient); applying them one by one reconciles in between and closes the page.
test('setAmbient validates like the three setters, ignores an unchanged set and keeps a profile that changes role', async () => {
  const f = fixture(); f.heartbeat(['alex']);
  assert.throws(() => f.connections.setAmbient({partners: 'judy'}), /Invalid conversation partners/);
  assert.throws(() => f.connections.setAmbient({spawned: ['bad/key']}), /Invalid spawned profiles/);
  assert.throws(() => f.connections.setAmbient({nearby: [1]}), /Invalid nearby profiles/);
  await f.connections.setAmbient({spawned: ['judy', 'panam'], nearby: ['kerry', 'viktor', 'misty'], partners: ['river', 'jackie', 'alex']});
  assert.deepEqual(f.connections.spawned, ['judy', 'panam']); assert.deepEqual(f.connections.nearby, ['kerry', 'viktor'], 'two nearby at most');
  assert.deepEqual(f.connections.partners, ['river', 'jackie'], 'two partners at most');
  const revision = f.connections.revision;
  await f.connections.setAmbient({spawned: ['judy', 'panam'], nearby: ['kerry', 'viktor'], partners: ['river', 'jackie']});
  assert.equal(f.connections.revision, revision, 'the same lists are a no-op');
  await f.connections.setAmbient({}); assert.deepEqual(f.connections.plan(), [{profile: 'alex', scope: 'private', role: 'party'}]);
});

test('a spawned character who becomes a partner and returns to the spawned lane keeps its connection open the whole time', async () => {
  const f = fixture(); f.heartbeat([]);
  const retained = [];
  const retain = f.host.retain;
  f.host.retain = async (configs, options) => { retained.push(configs.map(config => config.characterId).sort()); return retain(configs, options); };
  const warm = new NearbyWarm({connections: f.connections, now: f.now, prepareVoice: async () => {}});
  const document = extra => JSON.stringify({updated: f.now(), profiles: [], partners: [], spawned: [], ...extra});
  await warm.apply(document({spawned: ['judy']}));
  for (let at = 0; at < 4; at++) await f.step(500);
  const judy = connectionKey('judy', 'private');
  assert(f.live.has(judy), 'opened as spawned'); assert.equal(f.calls.length, 1);
  const before = retained.length;
  // V talks to her: the game lists her as a partner and no longer as spawned.
  await warm.apply(document({partners: ['judy'], entities: {}}));
  assert.equal(f.connections.entries.get(judy).role, 'partner');
  // The partner role ends while she stands beside V: spawned again (the same document that stops listing her as a partner).
  await warm.apply(document({spawned: ['judy']}));
  assert.equal(f.connections.entries.get(judy).role, 'spawned');
  // And again, and a move to a nearby slot and back.
  await warm.apply(document({partners: ['judy']}));
  await warm.apply(document({profiles: ['judy']}));
  await warm.apply(document({spawned: ['judy']}));
  for (let at = 0; at < 4; at++) await f.step(500);
  assert(f.live.has(judy), 'the page is still open');
  assert.equal(f.calls.length, 1, 'opened once, never again');
  assert(retained.length > before);
  for (const wanted of retained.slice(before)) assert(wanted.includes('judy'), 'a retain without her would have closed the page: ' + wanted);
  assert.equal(f.connections.entries.get(judy).state, 'ready');
  // Control: applying the same changes with the three setters one after another (no setAmbient) drops her in between.
  const g = fixture(); g.heartbeat([]);
  const seen = [];
  const keep = g.host.retain;
  g.host.retain = async (configs, options) => { seen.push(configs.map(config => config.characterId)); return keep(configs, options); };
  const sequential = new NearbyWarm({connections: {setPartners: (list, routes) => g.connections.setPartners(list, routes),
    setSpawned: list => g.connections.setSpawned(list), setNearby: (list, routes) => g.connections.setNearby(list, routes)},
    now: g.now, prepareVoice: async () => {}});
  const documentG = extra => JSON.stringify({updated: g.now(), profiles: [], partners: [], spawned: [], ...extra});
  await sequential.apply(documentG({spawned: ['judy']}));
  await sequential.apply(documentG({partners: ['judy']}));
  const mark = seen.length;
  await sequential.apply(documentG({spawned: ['judy']}));
  assert(seen.slice(mark).some(wanted => !wanted.includes('judy')), 'one by one, the page is dropped in between (what setAmbient prevents)');
  await f.connections.clear(); await g.connections.clear();
});
