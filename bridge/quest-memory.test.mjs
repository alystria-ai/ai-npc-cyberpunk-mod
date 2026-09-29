import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QuestMemoryLedger} from './quest-memory.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cyberpunk-memory-test-'));
  const path = join(directory, 'ledger.json');
  const ledgers = [];
  const load = async () => { const ledger = await QuestMemoryLedger.load({path, now: () => 10000}); ledgers.push(ledger); return ledger; };
  t.after(async () => { for (const ledger of ledgers) await ledger.close(); await rm(directory, {recursive: true, force: true}); });
  const ledger = await load();
  await ledger.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'branch-1', checkpointId: 'initial'});
  return {ledger, load, path};
}
const event = (ledger, changes = {}) => ({eventId: 'judy-decision-1', factId: 'judy.choice', kind: 'decision',
  authority: 'game-state', text: 'V helped Judy with a difficult decision.', outcome: 'helped',
  stable: true, eligibleForMemory: true, knownBy: ['judy-alvarez'], witnessedBy: ['judy-alvarez'], visibility: 'private',
  evidence: [{sourceId: 'native-facts', evidenceRefs: ['capture:1:fact:verified_choice']}],
  provenance: {packId: 'reviewed', packRevision: 1, ruleId: 'judy-choice', ruleRevision: 1},
  identity: ledger.identity, ...changes});
const proof = (ledger, checkpointId = 'saved-1') => ({kind: 'native-on-restored', branchId: ledger.identity.branchId,
  ledgerSequence: ledger.identity.ledgerSequence, checkpointId});
const save = (ledger, checkpointId) => ledger.checkpoint(proof(ledger, checkpointId));
const context = ledger => ledger.contextFor({characterKey: 'judy-alvarez'});
const REST_USER = '11111111-1111-4111-8111-111111111111';
const currentPrefix = (ledger, ledgerSequence = ledger.identity.ledgerSequence) => ({
  kind:'native-facts-current-prefix',source:'quest-facts-v1',campaignId:ledger.identity.campaignId,
  branchId:ledger.identity.branchId,branchEpoch:1,ledgerSequence,commitGeneration:2,factHead:5,
  runtimeId:'1234567890abcdef1234567890abcdef'});
const factsRestore = (ledger, ledgerSequence = ledger.identity.ledgerSequence) => ({
  version:1,kind:'native-facts-restored',source:'PlayerSystem.OnGameRestored',factSchema:1,
  campaignId:ledger.identity.campaignId,branchId:ledger.identity.branchId,branchEpoch:2,ledgerSequence,
  commitGeneration:3,bank:1,factHead:7,checkpointId:`${ledger.identity.branchId}:3:${ledgerSequence}`,
  loadGeneration:1,runtimeId:'1234567890abcdef1234567890abcdef'});

test('stable user survives restart; a prior active world is never silently rebound', async t => {
  const {ledger, load} = await fixture(t), userId = ledger.userId;
  await ledger.close(); const reopened = await load();
  assert.equal(reopened.userId, userId); assert.equal(reopened.identity, null);
  assert.equal(context(reopened).status, 'unavailable');
  assert.deepEqual(reopened.pending(), []);
});
test('unverified, mismatched-user and conflicting campaign identities fail closed', async t => {
  const {ledger} = await fixture(t);
  for (const input of [{}, {authoritative: true, campaignId: 'a', playthroughId: 'b', branchId: 'b', checkpointId: 'c'},
    {authoritative: true, userId: 'another', campaignId: 'a', branchId: 'b', checkpointId: 'c'}]) {
    assert.throws(() => ledger.bindIdentity(input));
  }
  await assert.rejects(ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'missing',
    checkpointId:'missing',resume:true,ledgerSequence:3}),{code:'RESUME_BRANCH_NOT_FOUND'});
});

test('stable archive user is separate from local scope and receipt destination survives a fork', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger);
  const old = ledger.pending()[0];
  const lease = await ledger.claim(old.id, {characterId:'remote-judy',restEndUserId:REST_USER});
  assert.notEqual(lease.endUserId,lease.restEndUserId);
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'child',checkpointId:'child-base',
    parentBranchId:'branch-1',forkCheckpointId:'saved-1',forkLedgerSequence:1});
  await assert.rejects(ledger.acknowledge(lease,{characterId:'remote-judy',endUserId:lease.endUserId,
    memories:[{id:'remote-record',memory:lease.text}]}),{code:'INVALID_RECEIPT'});
  const receipt=await ledger.acknowledge(lease,{characterId:'remote-judy',endUserId:REST_USER,
    memories:[{id:'remote-record',memory:lease.text}]});
  assert.equal(receipt.active,false);
  const inherited=ledger.archiveFor({characterKey:'judy-alvarez',characterId:'remote-judy',restEndUserId:REST_USER});
  assert.equal(inherited.episodes.length,1);assert.equal(inherited.episodes[0].receipts[0].memoryId,'remote-record');
  assert.equal(ledger.pending()[0].restEndUserId,undefined);
});

test('archive reads exclude abandoned future records and unauthorized group or character knowledge', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger));await save(ledger,'earlier');
  const first=ledger.pending()[0],firstLease=await ledger.claim(first.id,{characterId:'remote-judy',restEndUserId:REST_USER});
  await ledger.acknowledge(firstLease,{characterId:'remote-judy',endUserId:REST_USER,memories:[{id:'early-record',memory:firstLease.text}]});
  await ledger.observe(event(ledger,{eventId:'future-event',factId:'future.choice',text:'A decision from an abandoned future.'}));
  await save(ledger,'future');const later=ledger.pending()[0];
  const lateLease=await ledger.claim(later.id,{characterId:'remote-judy',restEndUserId:REST_USER});
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'older-load',checkpointId:'base',
    parentBranchId:'branch-1',forkCheckpointId:'earlier',forkLedgerSequence:1});
  await ledger.acknowledge(lateLease,{characterId:'remote-judy',endUserId:REST_USER,memories:[{id:'future-record',memory:lateLease.text}]});
  const query={characterKey:'judy-alvarez',restEndUserId:REST_USER};
  assert.deepEqual(ledger.archiveFor(query).episodes.map(row=>row.eventId),['judy-decision-1']);
  assert.deepEqual(ledger.archiveFor({...query,characterKey:'johnny-silverhand'}).episodes,[]);
  assert.deepEqual(ledger.archiveFor({...query,channel:'group',audience:['judy-alvarez','panam-palmer']}).episodes,[]);
  assert.deepEqual(ledger.archiveFor({...query,characterId:'wrong-remote-character'}).episodes,[]);
});

test('provider paraphrases are stored as receipts but never promoted into trusted recall text', async t => {
  const {ledger} = await fixture(t);await ledger.observe(event(ledger));await save(ledger);
  const lease=await ledger.claim(ledger.pending()[0].id,{characterId:'remote-judy',restEndUserId:REST_USER});
  await ledger.acknowledge(lease,{characterId:'remote-judy',endUserId:REST_USER,
    memories:[{id:'merged-memory',memory:lease.text+' The provider merged an unrelated later event.'}]});
  assert.equal(ledger.status().outbox.acknowledged,1);
  assert.deepEqual(ledger.archiveFor({characterKey:'judy-alvarez',restEndUserId:REST_USER}).episodes,[]);
});
test('events stage immediately but timers, serialization and arbitrary checkpoint calls cannot promote', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger));
  assert.equal(context(ledger).episodes.length, 1);
  assert.equal(context(ledger).episodes[0].checkpointed, false);
  assert.deepEqual(ledger.pending(), []);
  for (const receipt of ['saved-1', {kind: 'after-save', checkpointId: 'saved-1', branchId: 'branch-1', ledgerSequence: 1},
    {kind: 'native-on-restored', checkpointId: 'saved-1', branchId: 'other', ledgerSequence: 1}]) {
    await assert.rejects(ledger.checkpoint(receipt), {code: 'CHECKPOINT_NOT_PROVEN'});
  }
  assert.deepEqual(ledger.pending(), []);
  await save(ledger);
  assert.equal(context(ledger).episodes[0].checkpointed, true);
  assert.equal(ledger.pending().length, 1);
});
test('dedupe ignores capture timing, object key order and physical copies', async t => {
  const {ledger} = await fixture(t);
  const first = await ledger.observe(event(ledger));
  const duplicate = await ledger.observe(event(ledger, {eventId: 'copy-2-event', entity: '999ULL',
    snapshot: {generation: 2}, provenance: {ruleRevision: 1, ruleId: 'judy-choice', packRevision: 1, packId: 'reviewed'},
    evidence: [{sourceId: 'native-facts', evidenceRefs: ['capture:2:fact:verified_choice']}]}));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.episodeId, first.episodeId);
  assert.equal(duplicate.ledgerSequence, 1); assert.equal(ledger.status().episodes, 1);
  await assert.rejects(ledger.observe(event(ledger, {text: 'A contradictory meaning.'})), {code: 'EVENT_ID_CONFLICT'});
});
test('unbound recovery receipt proves the exact persisted append intent and rejects changed evidence', async t => {
  const {ledger, load} = await fixture(t), intent = event(ledger);
  const appended = await ledger.observe(intent);
  await ledger.close(); const reopened = await load();
  const receipt = reopened.receiptFor({campaignId: 'campaign-1', branchId: 'branch-1', eventId: intent.eventId, event: intent});
  assert.equal(receipt.episodeId, appended.episodeId); assert.equal(receipt.ledgerSequence, 1);
  assert.equal(receipt.isTail, true); assert.equal(receipt.inherited, false); assert.equal(receipt.payloadMatches, true);
  assert.equal(reopened.identity, null);
  const changed = reopened.receiptFor({campaignId: 'campaign-1', branchId: 'branch-1', eventId: intent.eventId,
    event: {...intent, evidence: [{sourceId: 'different-proof'}]}});
  assert.equal(changed.payloadMatches, false);
  assert.equal(reopened.receiptFor({campaignId: 'campaign-1', branchId: 'branch-1', eventId: 'absent'}), null);
  const stored = reopened.readEvent({campaignId:'campaign-1',branchId:'branch-1',eventId:intent.eventId});
  stored.event.text='caller mutated copy';
  assert.equal(reopened.readEvent({campaignId:'campaign-1',branchId:'branch-1',eventId:intent.eventId}).event.text,intent.text);
});
test('untrusted research, unstable facts and unplayed conversations are rejected', async t => {
  const {ledger} = await fixture(t);
  for (const change of [{stable: false}, {authority: 'wiki'}, {evidence: []}, {provenance: undefined},
    {kind: 'shared-experience', authority: 'delivered-conversation', delivery: {requestId: 'chat-1', state: 'partial'}},
    {knownBy: ['judy-alvarez'], witnessedBy: ['panam-palmer']}]) {
    await assert.rejects(ledger.observe(event(ledger, change)));
  }
  assert.equal(ledger.status().episodes, 0);
});
test('private and group-safe projections use separate namespaces and canonical listeners', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger));
  await ledger.observe(event(ledger, {eventId: 'public-1', factId: 'shared.milestone', text: 'The group completed a shared task.',
    visibility: 'group-safe', knownBy: ['judy-alvarez', 'panam-palmer'], witnessedBy: ['judy-alvarez', 'panam-palmer']}));
  await ledger.registerGroup(['panam-palmer', 'judy-alvarez']);
  await save(ledger);
  const privateContext = context(ledger), phone = ledger.contextFor({characterKey: 'judy-alvarez', channel: 'phone'});
  const group = ledger.contextFor({characterKey: 'judy-alvarez', channel: 'group', audience: ['judy-alvarez', 'panam-palmer']});
  assert.equal(privateContext.episodes.length, 2); assert.equal(group.episodes.length, 1);
  assert.equal(privateContext.endUserId, phone.endUserId); assert.notEqual(privateContext.endUserId, group.endUserId);
  assert.equal(ledger.contextFor({characterKey: 'panam-palmer'}).episodes.length, 1);
  assert.equal(ledger.contextFor({characterKey: 'johnny-silverhand'}).episodes.length, 0);
  assert.equal(ledger.pending().length, 5);
});

test('one private end user is shared across Judy and Johnny while their records remain character scoped',async t=>{
  const {ledger}=await fixture(t);
  await ledger.observe(event(ledger));
  await ledger.observe(event(ledger,{eventId:'johnny-event',factId:'johnny.choice',text:'V made a decision known to Johnny.',
    characterKey:'johnny-silverhand',knownBy:['johnny-silverhand'],witnessedBy:['johnny-silverhand']}));
  await save(ledger);
  const judy=ledger.contextFor({characterKey:'judy-alvarez'}),johnny=ledger.contextFor({characterKey:'johnny-silverhand'});
  assert.equal(judy.endUserId,johnny.endUserId);assert.equal(judy.episodes.length,1);assert.equal(johnny.episodes.length,1);
  assert.notEqual(judy.episodes[0].text,johnny.episodes[0].text);
  const entries=ledger.pending();assert.equal(entries.length,2);assert.equal(new Set(entries.map(e=>e.endUserId)).size,1);
  assert.notEqual(entries[0].id,entries[1].id);assert.notEqual(entries[0].characterKey,entries[1].characterKey);
});
test('different exact groups cannot retrieve another group namespace or unauthorized episodes', async t => {
  const {ledger} = await fixture(t);
  const pair = ['judy-alvarez', 'panam-palmer'], other = ['judy-alvarez', 'johnny-silverhand'];
  await ledger.observe(event(ledger, {visibility: 'group-safe', audience: pair}));
  await ledger.registerGroup(pair); await ledger.registerGroup(other); await save(ledger);
  const first = ledger.contextFor({characterKey: 'judy-alvarez', channel: 'group', audience: pair});
  const reversed = ledger.contextFor({characterKey: 'judy-alvarez', channel: 'group', audience: [...pair].reverse()});
  const second = ledger.contextFor({characterKey: 'judy-alvarez', channel: 'group', audience: other});
  assert.equal(first.endUserId, reversed.endUserId); assert.notEqual(first.endUserId, second.endUserId);
  assert.equal(first.episodes.length, 1); assert.equal(second.episodes.length, 0);
  assert.throws(() => ledger.contextFor({characterKey: 'judy-alvarez', channel: 'group'}), {code: 'INVALID_AUDIENCE'});
  assert.equal(ledger.pending().filter(row => row.channel === 'group').length, 1);
});
test('same-activation resume needs exact native cursor; transport intent advances cursor without becoming a memory', async t => {
  const {ledger, load} = await fixture(t);
  await ledger.recordActivity({activityId: 'intent-1', requestId: 'request-1', characterKey: 'judy-alvarez',
    kind: 'submitted-input', identity: ledger.identity});
  assert.equal(ledger.identity.ledgerSequence, 1); assert.deepEqual(context(ledger).episodes, []);
  await ledger.close(); const resumed = await load();
  await assert.rejects(resumed.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'branch-1',
    checkpointId: 'initial', resume: true, ledgerSequence: 0}), {code: 'RESUME_CURSOR_MISMATCH'});
  await resumed.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'branch-1',
    checkpointId: 'serialized-but-unproven', resume: true, ledgerSequence: 1});
  await save(resumed); assert.deepEqual(resumed.pending(), []);
  assert.equal(resumed.inspectBranch('campaign-1', 'branch-1').ledgerSequence, 1);
});
test('explicit non-promotable facts remain local even after a restored checkpoint', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger, {eligibleForMemory: false})); await save(ledger);
  assert.equal(context(ledger).episodes.length, 1); assert.deepEqual(ledger.pending(), []);
});
test('fork copies only proven ancestor prefix and resets native local sequence', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger, 'save-a');
  const oldNamespace = ledger.identity.endUserId;
  await ledger.observe(event(ledger, {eventId: 'later-choice', factId: 'later.choice', text: 'A future decision happened.'}));
  await save(ledger, 'save-b');
  await assert.rejects(ledger.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'branch-1', checkpointId: 'save-a'}), {code: 'BRANCH_REQUIRED'});
  await ledger.bindIdentity({status: 'verified', playthroughId: 'campaign-1', branchId: 'branch-fork', checkpointId: 'fork-base',
    parentBranchId: 'branch-1', forkCheckpointId: 'save-a', forkLedgerSequence: 1});
  assert.equal(context(ledger).episodes.length, 1); assert.equal(ledger.identity.ledgerSequence, 0);
  assert.notEqual(ledger.identity.endUserId, oldNamespace); assert.equal(ledger.pending().length, 1);
  await ledger.observe(event(ledger, {eventId: 'fork-choice', factId: 'fork.choice', text: 'A different decision followed.'}));
  assert.equal(ledger.identity.ledgerSequence, 1);
});
test('first OnRestored receipt can prove an unsaved-to-ledger parent prefix before fork', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger));
  await ledger.observe(event(ledger, {eventId: 'unsaved-future', factId: 'future.choice', text: 'This choice was not saved.'}));
  await ledger.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'restored-fork', checkpointId: 'fork-base',
    parentBranchId: 'branch-1', forkCheckpointId: 'restored-save', forkLedgerSequence: 1,
    restoredProof: {kind: 'native-on-restored', branchId: 'branch-1', ledgerSequence: 1, checkpointId: 'restored-save'}});
  assert.equal(context(ledger).episodes.length, 1); assert.equal(ledger.pending().length, 1);
});
test('a fork without a proven parent checkpoint is rejected', async t => {
  const {ledger} = await fixture(t);
  await assert.rejects(ledger.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'fork', checkpointId: 'base',
    parentBranchId: 'branch-1', forkCheckpointId: 'initial'}), {code: 'CHECKPOINT_NOT_PROVEN'});
});

test('current fact tuple inherits only its local prefix into an unverified fresh namespace',async t=>{
  const {ledger,load}=await fixture(t);
  await ledger.observe(event(ledger));await save(ledger,'real-save');
  await ledger.observe(event(ledger,{eventId:'later',factId:'later.choice',text:'An unproven later choice.'}));
  const parentNamespace=ledger.identity.endUserId;
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'current-child',checkpointId:'current-base',
    parentBranchId:'branch-1',forkCheckpointId:'live-prefix',forkLedgerSequence:1,currentPrefixProof:currentPrefix(ledger,1)});
  assert.equal(context(ledger).episodes.length,1);assert.equal(context(ledger).episodes[0].checkpointed,false);
  assert.equal(ledger.identity.ledgerSequence,0);assert.notEqual(ledger.identity.endUserId,parentNamespace);
  assert.deepEqual(ledger.pending(),[]);
  assert.equal(ledger.inspectBranch('campaign-1','branch-1').checkpoints.find(c=>c.checkpointId==='real-save').verified,true);
  assert.equal(ledger.inspectBranch('campaign-1','current-child').checkpoints[0].verified,false);
  await ledger.close();const reopened=await load();
  await reopened.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'current-child',checkpointId:'current-base',
    resume:true,ledgerSequence:0});assert.deepEqual(reopened.pending(),[]);
});

test('unverified inherited prefix cannot be exported or used as a restored fork',async t=>{
  const {ledger}=await fixture(t);await ledger.observe(event(ledger));
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'current-child',checkpointId:'current-base',
    parentBranchId:'branch-1',forkCheckpointId:'live-prefix',forkLedgerSequence:1,currentPrefixProof:currentPrefix(ledger)});
  await ledger.registerGroup(['judy-alvarez','panam-palmer']);assert.deepEqual(ledger.pending(),[]);
  await assert.rejects(ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'fake-restored-child',
    checkpointId:'base',parentBranchId:'current-child',forkCheckpointId:'current-base'}),{code:'CHECKPOINT_NOT_PROVEN'});
  await assert.rejects(ledger.checkpoint({...currentPrefix(ledger),checkpointId:'pretend-save'}),{code:'CHECKPOINT_NOT_PROVEN'});
});

test('current prefix proof requires an exact bounded fact tuple and cannot rebind an existing child',async t=>{
  const {ledger}=await fixture(t);await ledger.observe(event(ledger));
  const base={authoritative:true,campaignId:'campaign-1',branchId:'current-child',checkpointId:'current-base',
    parentBranchId:'branch-1',forkCheckpointId:'live-prefix',forkLedgerSequence:1,currentPrefixProof:currentPrefix(ledger)};
  for(const changed of [{source:'after-save'},{runtimeId:'invalid'},{branchId:'wrong'},{campaignId:'wrong'},
    {branchEpoch:0},{ledgerSequence:2},{commitGeneration:0},{factHead:6},{factHead:2147483648}]){
    await assert.rejects(ledger.bindIdentity({...base,currentPrefixProof:{...base.currentPrefixProof,...changed}}),{code:'INVALID_CURRENT_PREFIX_PROOF'});
  }
  assert.throws(()=>ledger.bindIdentity({...base,restoredProof:proof(ledger)}),{code:'INVALID_CURRENT_PREFIX_PROOF'});
  assert.throws(()=>ledger.bindIdentity({...base,resume:true,ledgerSequence:0}),{code:'INVALID_CURRENT_PREFIX_PROOF'});
  await ledger.bindIdentity(base);
  await assert.rejects(ledger.bindIdentity(base),{code:'CURRENT_PREFIX_REQUIRES_NEW_BRANCH'});
});

test('real facts restore can later seal only the proven prefix of an unverified child',async t=>{
  const {ledger}=await fixture(t);await ledger.observe(event(ledger));
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'current-child',checkpointId:'current-base',
    parentBranchId:'branch-1',forkCheckpointId:'live-prefix',forkLedgerSequence:1,currentPrefixProof:currentPrefix(ledger)});
  assert.deepEqual(ledger.pending(),[]);
  await ledger.observe(event(ledger,{eventId:'unsaved-child-future',factId:'future.choice',text:'This later child event was not saved.'}));
  const restoredProof=factsRestore(ledger,0);
  await ledger.bindIdentity({authoritative:true,campaignId:'campaign-1',branchId:'actual-restored-child',checkpointId:'new-base',
    parentBranchId:'current-child',forkCheckpointId:restoredProof.checkpointId,forkLedgerSequence:0,restoredProof});
  assert.equal(context(ledger).episodes.length,1);assert.equal(context(ledger).episodes[0].checkpointed,true);
  assert.equal(ledger.pending().length,1);assert.equal(ledger.identity.ledgerSequence,0);
  assert.equal(ledger.inspectBranch('campaign-1','branch-1').checkpoints[0].verified,false);
});

test('facts restore proof rejects forged source, missing tuple fields and mislabeled legacy evidence',async t=>{
  const {ledger}=await fixture(t);await ledger.observe(event(ledger));const valid=factsRestore(ledger);
  for(const changed of [{source:'BeforeSave'},{version:2},{factSchema:2},{campaignId:'wrong'},
    {runtimeId:'0'.repeat(32)},{loadGeneration:0},{branchEpoch:0},{commitGeneration:0},
    {bank:undefined},{bank:2},{factHead:8},{checkpointId:'not-derived'},{kind:'native-on-restored'}]){
    await assert.rejects(ledger.checkpoint({...valid,...changed}),{code:'CHECKPOINT_NOT_PROVEN'});
  }
  assert.deepEqual(ledger.pending(),[]);await ledger.checkpoint(valid);
  assert.equal(ledger.pending().length,1);
});
test('late response is recorded only in abandoned namespace and cannot become a new-branch memory', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger, 'save-a');
  const entry = ledger.pending()[0], lease = await ledger.claim(entry.id, {characterId: 'remote-judy'});
  await ledger.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'branch-fork', checkpointId: 'base',
    parentBranchId: 'branch-1', forkCheckpointId: 'save-a'});
  const receipt = await ledger.acknowledge(lease, {characterId: lease.characterId, endUserId: lease.endUserId,
    memories: [{id: 'remote-memory', memory: lease.text}]});
  assert.equal(receipt.active, false);
  const fresh = ledger.pending(); assert.equal(fresh.length, 1); assert.notEqual(fresh[0].endUserId, lease.endUserId);
  assert.equal(fresh[0].state, 'pending');
});
test('ambiguous writes require positive reconciliation and never retry on an empty scan', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger);
  const entry = ledger.pending()[0], lease = await ledger.claim(entry.id, {characterId: 'remote-judy'});
  await ledger.fail(lease, {ambiguous: true, code: 'timeout'});
  assert.deepEqual(ledger.pending(), []);
  const scope = {characterId: lease.characterId, endUserId: lease.endUserId};
  const empty = await ledger.reconcile(entry.id, {...scope, memories: [], complete: true});
  assert.equal(empty.state, 'uncertain'); assert.equal(empty.retryAllowed, false);
  await assert.rejects(ledger.retryRejected(entry.id), {code: 'RETRY_NOT_ALLOWED'});
  const matched = await ledger.reconcile(entry.id, {...scope, memories: [{id: 'one', memory: `  ${lease.text}  `}], complete: false});
  assert.equal(matched.state, 'acknowledged');
});
test('a definitive rejection can be explicitly retried, with a bounded attempt count', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger);
  const entry = ledger.pending()[0];
  for (let i = 1; i <= 3; i++) {
    const lease = await ledger.claim(entry.id, {characterId: 'remote-judy'});
    assert.equal(lease.attempts, i);
    await ledger.fail(lease, {ambiguous: false, code: 'HTTP_401'});
    if (i < 3) await ledger.retryRejected(entry.id);
  }
  await assert.rejects(ledger.retryRejected(entry.id), {code: 'RETRY_NOT_ALLOWED'});
});
test('remote receipts require exact pair and attempt identity', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger);
  const lease = await ledger.claim(ledger.pending()[0].id, {characterId: 'remote-judy'});
  await assert.rejects(ledger.acknowledge(lease, {characterId: 'another', endUserId: lease.endUserId,
    memories: [{id: 'one', memory: lease.text}]}), {code: 'INVALID_RECEIPT'});
  await assert.rejects(ledger.fail({...lease, attemptId: 'old'}), {code: 'STALE_REMOTE_RECEIPT'});
});
test('restart converts an interrupted submission to uncertain without replaying its POST', async t => {
  const {ledger, load} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger);
  await ledger.claim(ledger.pending()[0].id, {characterId: 'remote-judy'});
  await ledger.close(); const reopened = await load();
  await reopened.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'branch-1', checkpointId: 'saved-1'});
  assert.deepEqual(reopened.pending(), []);
  assert.equal(reopened.pending({includeUncertain: true})[0].state, 'uncertain');
});
test('checkpoint and event leases exclude stale queued world work', async t => {
  const {ledger} = await fixture(t), stale = event(ledger);
  const switched = ledger.bindIdentity({authoritative: true, campaignId: 'campaign-2', branchId: 'other', checkpointId: 'base'});
  const queued = ledger.observe(stale);
  await switched; await assert.rejects(queued, {code: 'STALE_LEASE'});
  await assert.rejects(ledger.observe(stale), {code: 'STALE_EVENT_IDENTITY'});
});
test('checksummed backup recovery preserves user and changes remote namespace to avoid future contamination', async t => {
  const {ledger, load, path} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger, 'saved-1');
  const previousUser = ledger.userId, namespace = ledger.identity.endUserId;
  await ledger.observe(event(ledger, {eventId: 'future', factId: 'future', text: 'A newer unsaved choice.'}));
  await ledger.close(); await writeFile(path, '{corrupt');
  const recovered = await load(); assert.equal(recovered.recovered, true); assert.equal(recovered.userId, previousUser);
  await recovered.bindIdentity({authoritative: true, campaignId: 'campaign-1', branchId: 'branch-1', checkpointId: 'saved-1'});
  assert.notEqual(recovered.identity.endUserId, namespace); assert.equal(context(recovered).episodes.length, 1);
  assert.ok(recovered.pending().every(row => row.endUserId !== namespace));
});
test('unrecoverable corruption never creates a new user identity silently', async t => {
  const {ledger, load, path} = await fixture(t);
  await ledger.close(); await writeFile(path, 'broken'); await writeFile(path + '.bak', 'also broken');
  await assert.rejects(load(), {code: 'CORRUPT_LEDGER'});
});
test('a second live writer is refused and close releases the lock', async t => {
  const {ledger, load} = await fixture(t);
  await assert.rejects(load(), {code: 'LEDGER_LOCKED'});
  await ledger.close(); const next = await load(); assert.equal(next.userId, ledger.userId);
});
test('failed atomic commit does not advance visible state or durable native cursor', async t => {
  const {ledger, path} = await fixture(t), before = await readFile(path);
  await rm(path); await mkdir(path);
  await assert.rejects(ledger.observe(event(ledger)));
  assert.equal(ledger.identity.ledgerSequence, 0); assert.equal(context(ledger).episodes.length, 0);
  await rm(path, {recursive: true}); await writeFile(path, before);
});
test('superseded current context is hidden without silently deleting provider records', async t => {
  const {ledger} = await fixture(t);
  await ledger.observe(event(ledger)); await save(ledger, 'saved-1');
  const previouslyPending = ledger.pending()[0];
  await ledger.observe(event(ledger, {eventId: 'corrected', factId: 'judy.choice', outcome: 'corrected',
    text: 'The verified outcome was corrected.', supersedes: ['judy-decision-1']}));
  assert.equal(context(ledger).episodes.length, 1); assert.match(context(ledger).episodes[0].text, /corrected/);
  assert.deepEqual(ledger.pending(), []);
  await assert.rejects(ledger.claim(previouslyPending.id, {characterId: 'remote-judy'}), {code: 'ENTRY_NOT_PENDING'});
});
