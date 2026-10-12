import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync, createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseWorldSnapshot, resolveKnowledge, validateKnowledgePack} from './world-knowledge.mjs';
import {jsonPointer} from '../research/cyberpunk/scripts/build_native_pack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = resolve(root, 'research/cyberpunk/cache/game');
const read = file => JSON.parse(readFileSync(resolve(root, file), 'utf8').replace(/^\uFEFF/, ''));
const authored = read('research/cyberpunk/native-rules/aldecaldos.json');
const suffixes = ['panam-nash-assistance', 'panam-motel-room-shared', 'panam-motel-flirt',
  'farmhouse-initially-backed-panam', 'farmhouse-backed-saul', 'panam-farmhouse-flirt'];
const rules = suffixes.map(suffix => authored.rules.find(rule => rule.id === `aldecaldos.native.${suffix}`));
const pack = {...authored, rules};
const panam = 'panam-palmer', saul = 'saul-bright', mitch = 'mitch-anderson';
const observation = (value, fields = {}) => ({status: 'known', value, sourceId: 'offline-native-capture',
  evidenceRefs: ['offline:capture:1'], ...fields});
const choice = rule => rule.condition.all.find(node => node.type === 'fact');
const stage = rule => rule.condition.all.find(node => node.type === 'journal');
function snapshot(selected = rules, fields = {}) {
  return {version: 1, status: 'ready', gameVersion: '2.31', generation: 1,
    capturedAt: '2026-10-01T00:00:00.000Z', identity: {status: 'verified', userId: 'offline-user',
      playthroughId: 'offline-playthrough', branchId: 'offline-branch', checkpointId: 'offline-checkpoint'},
    audience: {channel: 'private', profileKeys: [panam]}, activeQuestKeys: [],
    facts: Object.fromEntries(selected.map(rule => [choice(rule).key, observation(choice(rule).value, {present: true})])),
    journal: Object.fromEntries(selected.map(rule => [stage(rule).key,
      observation(stage(rule).value, {revealed: true, questKey: rule.questKey})])), ...fields};
}
function resolved(input, profileKey = panam, selectedPack = pack) {
  const result = resolveKnowledge({pack: selectedPack, snapshot: input, profileKey, maxChars: 12000});
  assert.equal(result.diagnostics.status, 'ready');
  // Branch decisions are listed first under "choices", the rest under "facts"; these tests care about every entry.
  const data = JSON.parse(result.context.slice(result.context.indexOf('\n') + 1)), facts = [...(data.choices ?? []), ...data.facts];
  return {...result, facts};
}
const topics = result => result.facts.map(row => `${row.topic}/${row.outcome}`).sort();

test('the authored six additions have intact schema, exact selectors and participant boundaries', () => {
  assert(rules.every(Boolean));
  assert.equal(validateKnowledgePack(authored).ok, true);
  assert.equal(validateKnowledgePack(pack).ok, true);
  assert.equal(rules.length, 6);
  for (const rule of rules) {
    assert.equal(rule.status, 'source-verified');
    assert.equal(rule.reviewed, true);
    assert.deepEqual(rule.gameVersions, ['2.31']);
    assert.equal(rule.condition.all.length, 2);
    assert.equal(authored.journalAllowlist[stage(rule).key].questKey, rule.questKey);
    assert(!rule.audience.speakers.includes(mitch));
  }
  assert.deepEqual(rules.map(rule => choice(rule).key), ['q103_helped_panam', 'q103_slept_with_panam',
    'q103_15_rooms_flirt', 'sq004_sided_with_panam', 'sq004_saul_like', 'sq004_panam_flirted_farm']);
  assert.deepEqual(authored.journalAllowlist['aldecaldos.ghost.tunnel-cleared'].nativePath,
    'quests/main_quest/act_01/q103_warhead/tunnels/defeat_boss');
  assert.deepEqual(authored.journalAllowlist['aldecaldos.ghost.shared-room-entered'].nativePath,
    'quests/main_quest/act_01/q103_warhead/roadhouse/follow_panam_room');
});

for (const rule of rules) {
  test(`${rule.id}: positive fact plus revealed completed stage selects only this outcome`, () => {
    for (const profileKey of rule.audience.speakers) {
      const input = snapshot([rule], {audience: {channel: 'private', profileKeys: [profileKey]}});
      const result = resolved(input, profileKey);
      assert.deepEqual(topics(result), [`${rule.topic}/${rule.outcome}`]);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].provenance.ruleId, rule.id);
      assert.equal(result.events[0].eligibleForMemory, true);
      assert.deepEqual(result.events[0].evidence.map(row => row.type).sort(), ['fact', 'journal']);
    }
  });

  test(`${rule.id}: unknown, absent, zero or incomplete observations never infer an alternative`, () => {
    const factKey = choice(rule).key, journalKey = stage(rule).key;
    const original = snapshot([rule]);
    const cases = [
      ['missing fact', {facts: {}}], ['unknown fact', {facts: {[factKey]: {status: 'unknown'}}}],
      ['absent positive fact', {facts: {[factKey]: observation(1, {present: false})}}],
      ['unknown-presence positive fact', {facts: {[factKey]: observation(1, {present: 'unknown'})}}],
      ['ambiguous zero', {facts: {[factKey]: observation(0)}}],
      ['absent zero', {facts: {[factKey]: observation(0, {present: false})}}],
      ['known zero', {facts: {[factKey]: observation(0, {present: true})}}],
      ['negative value', {facts: {[factKey]: observation(-1, {present: true})}}],
      ['missing journal', {journal: {}}], ['unknown journal', {journal: {[journalKey]: {status: 'unknown'}}}],
      ['hidden journal', {journal: {[journalKey]: observation('succeeded', {revealed: false, questKey: rule.questKey})}}],
      ['active stage', {journal: {[journalKey]: observation('active', {revealed: true, questKey: rule.questKey})}}],
      ['failed stage', {journal: {[journalKey]: observation('failed', {revealed: true, questKey: rule.questKey})}}],
      ['another quest', {journal: {[journalKey]: observation('succeeded', {revealed: true, questKey: 'another-quest'})}}],
      ['another selector', {journal: {'aldecaldos.ghost.completed': observation('succeeded',
        {revealed: true, questKey: rule.questKey})}}],
    ].filter(([label]) => !(label === 'another selector' && journalKey === 'aldecaldos.ghost.completed'));
    if (choice(rule).op === 'eq') cases.push(['wrong exact positive value', {facts: {[factKey]: observation(2, {present: true})}}]);
    for (const [label, change] of cases) {
      const result = resolved({...original, ...change});
      assert.deepEqual(result.facts, [], label);
      assert.deepEqual(result.events, [], label);
      assert.doesNotMatch(result.context, /"outcome":"(?:refused|no-romance|rejected|supported-panam|supported-saul|flirted|helped|shared-room|affection-expressed)"/, label);
    }
    if (choice(rule).op === 'gte') {
      const result = resolved({...original, facts: {[factKey]: observation(2, {present: true})}});
      assert.deepEqual(topics(result), [`${rule.topic}/${rule.outcome}`]);
    }
  });
}

test('farmhouse stance contradictions are suppressed before selecting either participant or group audience', () => {
  const selected = [rules[3], rules[4]];
  for (const [profileKey, audience] of [[panam, {channel: 'private', profileKeys: [panam]}],
    [saul, {channel: 'phone', profileKeys: [saul]}],
    [panam, {channel: 'group', profileKeys: [panam, saul]}],
    [mitch, {channel: 'group', profileKeys: [panam, saul, mitch]}]]) {
    const result = resolved(snapshot(selected, {audience}), profileKey);
    assert.deepEqual(result.facts, []);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.diagnostics.conflicts[0].outcomes, ['supported-panam', 'supported-saul']);
    assert.deepEqual(result.diagnostics.exclusiveGroupConflicts[0].outcomes, ['supported-panam', 'supported-saul']);
    assert.equal(result.diagnostics.counts.conflicted, 2);
    assert.doesNotMatch(result.context, /corporate|Saul approved|Panam thanked/);
  }
});

test('motel sharing and flirting are independent compatible facets; neither implies sex or romance', () => {
  const both = resolved(snapshot([rules[1], rules[2]]));
  assert.deepEqual(topics(both), ['panam.motel-flirt/flirted', 'panam.motel-room/shared-room']);
  assert.deepEqual(both.diagnostics.conflicts, []);
  const roomOnly = resolved(snapshot([rules[1]]));
  assert.deepEqual(topics(roomOnly), ['panam.motel-room/shared-room']);
  assert.doesNotMatch(roomOnly.context, /"outcome":"flirted"/);
  assert.match(roomOnly.facts[0].text, /separate twin beds/);
  assert.match(roomOnly.facts[0].text, /not a sexual encounter or a confirmed romance/);
});

test('Panam private/phone knowledge is withheld from groups and every other clan member', () => {
  const selected = [rules[0], rules[1], rules[2], rules[5]];
  for (const channel of ['private', 'phone']) {
    const result = resolved(snapshot(selected, {audience: {channel, profileKeys: [panam]}}));
    assert.equal(result.facts.length, 4);
    for (const profileKey of authored.profileKeys.filter(key => key !== panam)) {
      const denied = resolved(snapshot(selected, {audience: {channel, profileKeys: [profileKey]}}), profileKey);
      assert.deepEqual(denied.facts, []);
      assert.deepEqual(denied.events, []);
    }
  }
  for (const profileKeys of [[panam], [panam, saul], [panam, mitch]]) {
    const result = resolved(snapshot(selected, {audience: {channel: 'group', profileKeys}}));
    assert.deepEqual(result.facts, []);
    assert.deepEqual(result.events, []);
    assert.doesNotMatch(result.context, /Nash|twin beds|flirtatious|overture/);
  }
});

test('farmhouse policy discussion permits its participants only, including the full listening group', () => {
  for (const rule of [rules[3], rules[4]]) {
    for (const profileKey of [panam, saul]) {
      const result = resolved(snapshot([rule], {audience: {channel: 'group', profileKeys: [panam, saul]}}), profileKey);
      assert.deepEqual(topics(result), [`${rule.topic}/${rule.outcome}`]);
      for (const outsider of authored.profileKeys.filter(key => ![panam, saul].includes(key))) {
        const denied = resolved(snapshot([rule], {audience: {channel: 'group', profileKeys: [panam, saul, outsider]}}), profileKey);
        assert.deepEqual(denied.facts, []);
        assert.deepEqual(denied.events, []);
      }
    }
    for (const profileKey of [mitch, 'dakota-smith']) {
      const denied = resolved(snapshot([rule], {audience: {channel: 'private', profileKeys: [profileKey]}}), profileKey);
      assert.deepEqual(denied.facts, []);
    }
  }
});

test('current capture is isolated across reloads and unknown identity cannot create memory candidates', () => {
  for (const rule of rules) {
    const initial = snapshot([rule]);
    assert.equal(resolved(initial).events.length, 1);
    for (const identity of [{status: 'unknown'}, {status: 'session-only'}]) {
      const result = resolved({...initial, identity});
      assert.deepEqual(topics(result), [`${rule.topic}/${rule.outcome}`]);
      assert.deepEqual(result.events, []);
      assert.equal(result.diagnostics.memory.candidates, 0);
    }
    const reloaded = {...initial, generation: 2, facts: {}, journal: {}};
    assert.deepEqual(resolved(reloaded).facts, []);
    assert.deepEqual(resolved(reloaded).events, []);
    assert.equal(parseWorldSnapshot({...initial, facts: {[choice(rule).key]: observation('1', {present: true})}}).status,
      'unavailable');
  }
});

// Exact native-source checks are an explicit development gate. Offline resolver
// scenarios above remain runnable on a fresh checkout without private game assets.
const nativeSourceGate = process.env.CYBERPUNK_NATIVE_SOURCE_CHECK === '1';
test('new Aldecaldos evidence remains bound to exact winning native binaries, JSON bytes and typed pointers',
  {skip: !nativeSourceGate}, () => {
    const manifests = ['inventory.json', 'localization/inventory.json',
      ...readdirSync(resolve(cache, 'scene-evidence')).filter(name => /^[a-z0-9-]+$/.test(name))
        .map(name => `scene-evidence/${name}/inventory.json`)
        .filter(file => existsSync(resolve(cache, file)))];
    const assets = new Map();
    for (const file of manifests) {
      const inventory = JSON.parse(readFileSync(resolve(cache, file), 'utf8'));
      const prefix = file === 'inventory.json' ? '' : file.slice(0, -'inventory.json'.length);
      for (const row of inventory.assets.filter(row => row.winner)) {
        assets.set(prefix + row.jsonPath, {...row, rawPath: prefix + row.rawPath});
      }
    }
    const documents = new Map(); let pointers = 0;
    for (const evidence of authored.evidence.filter(row => row.id.startsWith('al-native.oct01-'))) {
      for (const reference of [evidence.native, ...(evidence.nativeRefs ?? [])]) {
        const asset = assets.get(reference.jsonPath);
        assert(asset, `${evidence.id}: exact winning resource`);
        assert.equal(reference.assetSha256, asset.assetSha256);
        assert.match(reference.jsonSha256, /^[a-f0-9]{64}$/);
        if (!documents.has(reference.jsonPath)) {
          const raw = readFileSync(resolve(cache, asset.rawPath));
          const jsonRaw = readFileSync(resolve(cache, reference.jsonPath));
          documents.set(reference.jsonPath, {rawSha: createHash('sha256').update(raw).digest('hex'),
            jsonSha: createHash('sha256').update(jsonRaw).digest('hex'),
            json: JSON.parse(jsonRaw.toString('utf8').replace(/^\uFEFF/, ''))});
        }
        const document = documents.get(reference.jsonPath);
        assert.equal(document.rawSha, reference.assetSha256, evidence.id);
        assert.equal(document.jsonSha, reference.jsonSha256, evidence.id);
        const value = jsonPointer(document.json, reference.jsonPointer);
        if (reference.expectedType) assert.equal(value.$type, reference.expectedType, evidence.id);
        if (Object.hasOwn(reference, 'expectedValue')) assert.deepEqual(value, reference.expectedValue, evidence.id);
        for (const [pointer, expected] of Object.entries(reference.expected ?? {})) {
          assert.deepEqual(jsonPointer(value, pointer), expected, `${evidence.id}${pointer}`);
        }
        pointers += 1;
      }
    }
    assert.equal(documents.size, 18);
    assert.equal(pointers, 281);
    for (const [key, selector] of Object.entries(authored.journalAllowlist)) {
      const evidence = selector.evidenceRefs.map(id => authored.evidence.find(row => row.id === id))
        .find(row => row.id.startsWith('al-native.oct01-aldecaldos-'));
      if (!evidence) continue;
      const reference = evidence.native, document = documents.get(reference.jsonPath).json;
      const parts = reference.jsonPointer.split('/entries/');
      const hierarchy = parts.map((_, index) => jsonPointer(document, parts.slice(0, index + 1).join('/entries/')))
        .map(row => row.id).filter(Boolean).join('/');
      assert.equal(hierarchy, selector.nativePath, key);
      assert.equal(jsonPointer(document, reference.jsonPointer).$type, selector.nativeClass, key);
    }
  });

test('native scene sockets establish assistance and distinct policy choices without kill or gesture inference',
  {skip: !nativeSourceGate}, () => {
    const native = file => JSON.parse(readFileSync(resolve(cache, file), 'utf8')).Data.RootChunk;
    const nodes = scene => new Map(scene.sceneGraph.Data.graph.map(row => [row.Data.nodeId.id, row.Data]));
    const targets = (node, name, ordinal = 0) => node.outputSockets
      .filter(socket => socket.stamp.name === name && socket.stamp.ordinal === ordinal)
      .flatMap(socket => socket.destinations.map(destination => destination.nodeId.id));
    const nash = nodes(native('scene-evidence/aldecaldos-oct01-nash/raw/base/base/quest/main_quests/part1/q103/scenes/q103_11_tunnel_drive.scene.json'));
    assert(targets(nash.get(68), 0).includes(58));
    assert.deepEqual(targets(nash.get(58), 2), [101]);
    assert.deepEqual(nash.get(101).questNode.Data.type.Data,
      {$type: 'questSetVar_NodeType', factName: 'q103_helped_panam', setExactValue: 0, value: 1});
    assert.deepEqual(targets(nash.get(101), 0), [2]);
    const combat = native('raw/base/base/quest/main_quests/part1/q103/phases/q103_04a_tunnels_combat.questphase.json');
    for (const id of [545, 546]) {
      const condition = combat.graph.Data.nodes.find(row => row.Data.id === id).Data.condition.Data.type.Data;
      assert.equal(condition.$type, 'questCharacterKilled_ConditionType');
      assert.deepEqual([condition.killed, condition.defeated, condition.unconscious], [1, 1, 1]);
    }
    const farm = nodes(native('scene-evidence/aldecaldos-oct01/raw/base/base/quest/side_quests/sq004/scenes/sq004_08_farm.scene.json'));
    assert.deepEqual(targets(farm.get(1682), 0, 0), [807]); // Initial Saul stance.
    assert.deepEqual(targets(farm.get(1682), 0, 1), [805]); // Initial Panam stance.
    assert.deepEqual(targets(farm.get(805), 2), [1990]);
    assert(targets(farm.get(1990), 0).includes(812)); // A later explanation may retract it.
    assert.deepEqual(targets(farm.get(812), 0, 3), [813]);
    for (const [ordinal, section] of [[0, 817], [1, 818], [2, 819]]) {
      assert.deepEqual(targets(farm.get(811), 0, ordinal), [section]);
      assert.deepEqual(targets(farm.get(section), 2), [822]);
    }
    assert.deepEqual(targets(farm.get(811), 0, 3), [813]); // Saul retraction bypasses approval.
    assert.deepEqual(targets(farm.get(822), 0), [823]);
    assert.equal(farm.get(823).questNode.Data.type.Data.factName, 'sq004_saul_like');
    for (const ordinal of [0, 1]) assert(targets(farm.get(932), 0, ordinal).includes(2657));
    assert(!targets(farm.get(932), 0, 2).includes(2657));
    assert.equal(farm.get(2657).questNode.Data.type.Data.factName, 'sq004_panam_flirted_farm');
  });

test('shipped base plus EP1 resource closure excludes the two indexed test presets without claiming exhaustive debug execution',
  {skip: !nativeSourceGate}, () => {
    const ep1 = JSON.parse(readFileSync(resolve(cache,
      'scene-evidence/phantom-oct01-release/raw/ep1/ep1/quest/ep1.gamedef.json'), 'utf8')).Data.RootChunk;
    const roots = ep1.mainQuests.filter(row => row.Data.additionalContent === 0)
      .map(row => row.Data.questFile.DepotPath.$value);
    assert.deepEqual(roots, ['base\\quest\\cyberpunk2077.quest', 'ep1\\quest\\ep1.quest']);
    const references = new Map();
    for (const line of readFileSync(resolve(cache, 'index/resources.jsonl'), 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (!references.has(row.source.depotPath)) references.set(row.source.depotPath, new Set());
      references.get(row.source.depotPath).add(row.depotPath);
    }
    const reached = new Set(), queue = [...roots];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (reached.has(current)) continue;
      reached.add(current);
      for (const next of references.get(current) ?? []) if (!reached.has(next)) queue.push(next);
    }
    assert(reached.has('base\\quest\\main_quests\\part1\\q103\\q103.questphase'));
    assert(reached.has('base\\quest\\side_quests\\sq004\\sq004_riders_on_the_storm.questphase'));
    assert(!reached.has('base\\quest\\main_quests\\part1\\q103\\test\\q103_chicken_test.questphase'));
    assert(!reached.has('base\\quest\\side_quests\\sq004\\sq004_riders_quest.quest'));
    // This external scene IS referenced. Its unexported execution may contain
    // other debug writers; resource closure alone cannot establish their absence.
    assert(reached.has('base\\quest\\test\\cp77_chicken_test.scene'));
  });

test('normal act1 and farmhouse execution uses their production sockets and succeeded journal inputs',
  {skip: !nativeSourceGate}, async () => {
    const paths = ['base\\quest\\main_quests\\part1\\act_1.questphase',
      'base\\quest\\main_quests\\part1\\q103\\q103.questphase',
      'base\\quest\\side_quests\\sq004\\phases\\sq004_05_farm.questphase'];
    const graphs = new Map(paths.map(path => [path, new Set()]));
    const encoded = paths.map(path => JSON.stringify(path).slice(1, -1));
    // The complete edge index is large. Stream it rather than retaining game
    // graph exports in a single string, and exclude nested reused node IDs.
    for await (const line of createInterface({input: createReadStream(resolve(cache, 'index/edges.jsonl')),
      crlfDelay: Infinity})) {
      if (!encoded.some(path => line.includes(path))) continue;
      const row = JSON.parse(line);
      if (!graphs.has(row.source.depotPath)
        || !/^\/Data\/RootChunk\/graph\/Data\/nodes\/\d+\/Data$/.test(row.from?.node?.jsonPointer ?? '')
        || !/^\/Data\/RootChunk\/graph\/Data\/nodes\/\d+\/Data$/.test(row.to?.node?.jsonPointer ?? '')) continue;
      graphs.get(row.source.depotPath).add(JSON.stringify([row.from.node.id, row.from.socket,
        row.to.node.id, row.to.socket]));
    }
    const expect = (path, ...edges) => {
      for (const edge of edges) assert(graphs.get(path).has(JSON.stringify(edge)), `${path}: ${edge.join(' -> ')}`);
    };
    expect(paths[0], [2, 'Out1', 167, 'In1'], [167, 'Out1', 158, 'In1'], [158, 'Out1', 15, 'In1']);
    expect(paths[1], [30, 'Out', 57, 'In'], [57, 'Out', 32, 'In1'], [32, 'Out1', 33, 'In1'],
      [34, 'go_tunnel', 35, 'In1'], [34, 'go_roadhouse', 36, 'In1'], [35, 'Out1', 36, 'from_tunnels']);
    expect(paths[2], [259, 'Out', 6, 'sq004_08_main_in'],
      [245, 'sq004_09_morning_after_out', 246, 'Succeeded']);
  });

test('indexed fact writers contain exactly the six scene receipts and two isolated presets, with no reset',
  {skip: !nativeSourceGate}, () => {
    const selectedFacts = new Set(rules.map(rule => choice(rule).key));
    const indexes = [resolve(cache, 'index/facts.jsonl')];
    for (const folder of readdirSync(resolve(cache, 'scene-evidence'))) {
      const index = resolve(cache, 'scene-evidence', folder, 'index/facts.jsonl');
      if (existsSync(index)) indexes.push(index);
    }
    const found = new Map();
    for (const index of indexes) for (const line of readFileSync(index, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (selectedFacts.has(row.factName) && row.role === 'assignment') {
        const key = `${row.source.depotPath}:${row.jsonPointer}`;
        if (!found.has(key)) found.set(key, row);
        else assert.deepEqual([row.value, row.setExactValue],
          [found.get(key).value, found.get(key).setExactValue], 'Duplicate export writer semantics must agree');
      }
    }
    assert.equal(found.size, 8);
    const counts = new Map();
    for (const row of found.values()) {
      assert.equal(row.value, 1);
      assert([0, 1].includes(row.setExactValue));
      counts.set(row.factName, (counts.get(row.factName) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries([...counts].sort()), {
      q103_15_rooms_flirt: 1, q103_helped_panam: 2, q103_slept_with_panam: 2,
      sq004_panam_flirted_farm: 1, sq004_saul_like: 1, sq004_sided_with_panam: 1,
    });
  });
