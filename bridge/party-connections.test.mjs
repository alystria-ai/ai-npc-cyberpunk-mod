import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PartyConnections, parsePartyConnections, connectionKey, CONNECTION_LIMIT} from './party-connections.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const flush = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
const profiles = ['alex', 'judy', 'panam', 'kerry', 'viktor', 'misty', 'river', 'jackie'];
// Characters beyond the eight warm private connections (the party has no size limit).
const extraProfiles = ['evelyn', 'claire', 'wakako', 'rogue', 'takemura', 'saul', 'goro', 'hanako'];
const everyone = [...profiles, ...extraProfiles];
function fixture({canWarm = () => true} = {}) {
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
  const connections = new PartyConnections({host, now: () => time, canWarm,
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
