import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {QuestMemoryLedger} from './quest-memory.mjs';
import {parseWorldSnapshot, resolveKnowledge, validateKnowledgePack} from './world-knowledge.mjs';

const MAX_BYTES = 256 * 1024;
const FACT_STORAGE = 'quest-facts-v1', MAX_FACT_COMMIT = 1073741823;
const FACT_RECORD_KEYS = ['schema', 'bank', 'campaignId', 'branchId', 'branchEpoch', 'ledgerSequence', 'commitGeneration'];
const REST_POLICY = 'explicit-rest-anonymous-live-v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const clone = value => structuredClone(value);
const token = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value);
const integer = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
const opaque = () => randomBytes(16).toString('hex');
const AMBIENT = new Set(['resident-male', 'resident-female']);
const ACTIVITY_KINDS = new Set(['submitted-input', 'generated-reply', 'delivered-reply', 'cancelled-turn']);
const RETAINED_TEXT_CHARS = 1200;
const MAX_ACTIVITY_TEXT_CHARS = 16000;
const unavailable = reason => ({status: 'unavailable', authoritative: false, reason});
const error = code => Object.assign(new Error(`Knowledge service: ${code}`), {code});
const cursor = value => ({campaignId: value.campaignId, branchId: value.branchId,
  branchEpoch: value.branchEpoch, ledgerSequence: value.ledgerSequence});
const sameCursor = (a, b) => ['campaignId', 'branchId', 'branchEpoch', 'ledgerSequence'].every(key => a?.[key] === b?.[key]);
const isFacts = value => value?.storage === FACT_STORAGE;
const sameWorld = (a, b) => a?.activationId === b?.activationId && a?.generation === b?.generation
  && (a?.runtimeId ?? null) === (b?.runtimeId ?? null) && isFacts(a) === isFacts(b);
const sameHead = (a, b) => !isFacts(a) || (isFacts(b) && a.factHead === b.factHead);
const sameAuthority = (a, b) => sameWorld(a, b) && sameCursor(a, b)
  && sameHead(a, b)
  && (b?.schema === undefined || a?.schema === b.schema)
  && (b?.resolved === undefined || a?.resolved === b.resolved);
const expected = value => ({generation: value.generation, revision: value.revision, activationId: value.activationId,
  ...(isFacts(value) ? {runtimeId: value.runtimeId, factHead: value.factHead} : {})});
const worldToken = value => isFacts(value)
  ? `${value.generation}:${value.runtimeId}:${value.activationId}:${value.branchId}`
  : `${value.generation}:${value.activationId}:${value.branchId}`;
const factRecord = value => Object.fromEntries(FACT_RECORD_KEYS.map(key => [key, value?.[key]]));
const sameFactRecord = (a, b) => FACT_RECORD_KEYS.every(key => a?.[key] === b?.[key]);
const validFactRecord = value => value?.schema === 1 && [0, 1].includes(value.bank)
  && token(value.campaignId) && token(value.branchId) && integer(value.branchEpoch) && value.branchEpoch > 0
  && integer(value.ledgerSequence) && integer(value.commitGeneration) && value.commitGeneration > 0
  && value.commitGeneration <= MAX_FACT_COMMIT;
const resumeInput = (value, sequence = value.ledgerSequence) => ({authoritative: true, resume: true,
  campaignId: value.campaignId, branchId: value.branchId, checkpointId: value.checkpointId, ledgerSequence: sequence});

async function defaultRead(path) {
  try { return await readFile(path, 'utf8'); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}
async function atomicWrite(path, raw) {
  await mkdir(dirname(path), {recursive: true});
  const temp = `${path}.${opaque()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx'); await file.writeFile(raw, 'utf8'); await file.sync(); await file.close(); file = null;
    await rename(temp, path);
  } finally { await file?.close(); await unlink(temp).catch(() => {}); }
}
function decode(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw error('INVALID_IPC');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw error('INVALID_IPC');
  return value;
}
function nativeState(value) {
  const n = value?.inspection;
  if (!n || n.status !== 'inspected' || typeof n.ready !== 'boolean' || typeof n.saving !== 'boolean'
      || typeof n.faulted !== 'boolean' || typeof n.resolved !== 'boolean' || typeof n.restored !== 'boolean'
      || !integer(n.generation) || n.generation < 1 || !integer(n.revision)
      || !(n.activationId === '' || token(n.activationId)) || ![0, 1].includes(n.schema)) return null;
  if (n.schema === 1 && (!token(n.campaignId) || !token(n.branchId) || !integer(n.branchEpoch)
      || n.branchEpoch < 1 || !integer(n.ledgerSequence))) return null;
  if (n.storage !== undefined && n.storage !== FACT_STORAGE) return null;
  if (isFacts(n) && (!token(n.runtimeId) || !integer(n.factHead)
      || !['live-origin-unverified', 'native-restored'].includes(n.origin)
      || !Array.isArray(n.banks) || n.banks.length !== 2
      || (n.schema === 1 && (!validFactRecord(n) || n.factHead !== n.commitGeneration * 2 + n.bank)))) return null;
  return n;
}
function proofFor(n) {
  const proof = n.restoredProof;
  if (isFacts(n)) return proof?.version === 1 && proof.kind === 'native-facts-restored' && proof.source === 'PlayerSystem.OnGameRestored'
    && proof.campaignId === n.campaignId && proof.branchId === n.branchId && proof.branchEpoch === n.branchEpoch
    && proof.ledgerSequence === n.ledgerSequence && proof.commitGeneration === n.commitGeneration
    && proof.runtimeId === n.runtimeId && proof.loadGeneration === n.generation && proof.factSchema === 1
    && proof.bank === n.bank && proof.factHead === n.factHead
    && proof.checkpointId === `${n.branchId}:${n.commitGeneration}:${n.ledgerSequence}` ? clone(proof) : null;
  return proof?.kind === 'native-on-restored' && proof.branchId === n.branchId
    && proof.ledgerSequence === n.ledgerSequence && integer(proof.ledgerSequence)
    && typeof proof.checkpointId === 'string'
    && new RegExp(`^${n.branchId}:[1-9][0-9]*:${n.ledgerSequence}$`).test(proof.checkpointId) ? clone(proof) : null;
}
function audienceFor(profile, channel = 'private', audience) {
  const members = audience?.profileKeys ?? audience ?? [profile];
  if (!['private', 'phone', 'group'].includes(channel) || !Array.isArray(members) || !members.length || members.length > 8
      || members.some(key => typeof key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(key))
      || !members.includes(profile) || new Set(members).size !== members.length
      || (channel !== 'group' && (members.length !== 1 || members[0] !== profile))) throw error('INVALID_AUDIENCE');
  return [...members].sort();
}
function activityId(identity, requestId, profile, channel, audience, kind) {
  return 'activity-' + createHash('sha256').update(JSON.stringify([identity.userId, identity.campaignId,
    identity.branchId, requestId, profile, channel, audience, kind])).digest('hex');
}
function activityMetadata(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('INVALID_ACTIVITY_METADATA');
  const allowed = new Set(['source', 'code', 'durationMs', 'chunkCount', 'completedChunks', 'totalChunks', 'providerTurnId']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw error('INVALID_ACTIVITY_METADATA');
  for (const item of Object.values(value)) {
    if (!(typeof item === 'string' && item.length <= 160 && !/[\u0000-\u001f]/u.test(item))
        && !(typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 2147483647)) throw error('INVALID_ACTIVITY_METADATA');
  }
  return clone(value);
}
function stagedText(value, field) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ACTIVITY_TEXT_CHARS
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw error('INVALID_CONVERSATION_TEXT');
  const sha256 = createHash('sha256').update(value, 'utf8').digest('hex');
  // Keep complete originals or a hash only. A truncated sentence must never be
  // promoted as though it were the exchange that the player actually heard.
  return {field, sha256, retained: value.length <= RETAINED_TEXT_CHARS,
    ...(value.length <= RETAINED_TEXT_CHARS ? {text: value} : {reason: 'conversation-text-too-long'})};
}
function stageContent(row, field) {
  const content = row?.event?.evidence?.[0]?.content;
  return content?.field === field ? content : null;
}
function deliveryReceipt(value, requestId, channel) {
  const continuous = channel !== 'phone' && value?.source === 'continuous-playback';
  const source = channel === 'phone' ? 'phone-ui' : continuous ? 'continuous-playback' : 'native-playback';
  const state = channel === 'phone' ? 'accepted' : 'completed';
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.source !== source
      || value.state !== state || value.requestId !== requestId
      || (value.cancelled !== undefined && value.cancelled !== false) || (value.partial !== undefined && value.partial !== false)
      // The browser renderer owns one continuous utterance. EOF alone is not a
      // delivery receipt: its caller must wait for the consumed playback cursor.
      || continuous && (value.backend !== 'browser-pcm' || value.totalChunks !== 1 || value.completedChunks !== 1)) {
    throw error('DELIVERY_NOT_CONFIRMED');
  }
  const chunks = value.totalChunks !== undefined || value.completedChunks !== undefined;
  if (chunks && (!Number.isSafeInteger(value.totalChunks) || value.totalChunks < 1 || value.totalChunks > 10000
      || value.completedChunks !== value.totalChunks)) throw error('DELIVERY_NOT_CONFIRMED');
  if (value.replyHash !== undefined && (typeof value.replyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.replyHash))) {
    throw error('DELIVERED_TEXT_MISMATCH');
  }
  return {source, state, requestId, cancelled: false, partial: false,
    ...(continuous ? {backend: value.backend} : {}),
    ...(value.replyHash !== undefined ? {replyHash: value.replyHash} : {}),
    ...(chunks ? {totalChunks: value.totalChunks, completedChunks: value.completedChunks} : {})};
}
function conversationEpisode({submitted, generated, delivered, profileKey, members, channel}) {
  const user = stageContent(submitted, 'userText'), reply = stageContent(generated, 'replyText');
  if (reply && delivered.replyHash !== reply.sha256) throw error('DELIVERED_TEXT_MISMATCH');
  if (delivered.replyHash && !reply) throw error('GENERATION_NOT_RECORDED');
  if (!user || !reply) return {reason: 'complete-conversation-text-unavailable'};
  if (!user.retained || !reply.retained) return {reason: 'conversation-text-too-long'};
  const text = `Conversation record (quoted statements, not verified game facts): V said ${JSON.stringify(user.text)}; `
    + `${profileKey} replied ${JSON.stringify(reply.text)}.`;
  if (text.normalize('NFC').replace(/\s+/gu, ' ').trim().length > 3000) return {reason: 'conversation-text-too-long'};
  return {text, knownBy: delivered.witnessedBy ?? [profileKey], witnessedBy: delivered.witnessedBy ?? [profileKey],
    audience: members, visibility: channel === 'group' ? 'group-safe' : 'private',
    userHash: user.sha256, replyHash: reply.sha256};
}

/** Native IPC and durable ledger coordinator. No provider or browser calls. */
export class KnowledgeService {
  static async open(options = {}) {
    const validation = validateKnowledgePack(options.pack);
    if (!validation.ok) throw error('INVALID_REVIEWED_PACK');
    const service = new KnowledgeService(options);
    if (!service.ledger) {
      try { service.ledger = await QuestMemoryLedger.load({path: options.ledgerPath, now: service.now}); }
      catch (cause) { service.failure = cause.code ?? 'LEDGER_UNAVAILABLE'; }
    }
    try {
      const raw = await service.io.read(service.journalPath);
      if (raw !== null && raw !== undefined) {
        service.journal = decode(raw);
        if (service.journal.kind !== 'knowledge-activation') throw error('INVALID_ACTIVATION_RECORD');
      }
    } catch (cause) { service.failure = cause.code ?? 'ACTIVATION_RECORD_UNAVAILABLE'; }
    await service._loadRestPool().catch(cause => { service.restPoolReason = cause.code ?? 'REST_POOL_UNAVAILABLE'; });
    return service;
  }
  constructor({runtimeDir, pack, ledger, now = Date.now, io = {}, heartbeatMs = 5000,
    commandTimeoutMs = 3000, cloudQualified = false, factIdentityEnabled = false, restMemoryEnabled = false} = {}) {
    if (typeof runtimeDir !== 'string' || typeof now !== 'function' || heartbeatMs < 500 || heartbeatMs > 10000
        || commandTimeoutMs < 100 || commandTimeoutMs > 10000) throw error('INVALID_CONFIGURATION');
    this.runtimeDir = resolve(runtimeDir); this.pack = clone(pack); this.ledger = ledger; this.now = now;
    this.io = {read: io.read ?? defaultRead, write: io.write ?? atomicWrite, wait: io.wait ?? sleep};
    this.statePath = resolve(this.runtimeDir, 'knowledge-state.json');
    this.commandPath = resolve(this.runtimeDir, 'knowledge-command.json');
    this.bindingPath = resolve(this.runtimeDir, 'knowledge-binding.json');
    this.journalPath = resolve(this.runtimeDir, 'knowledge-activation.json');
    this.factIndexPath = resolve(this.runtimeDir, 'knowledge-fact-index.json');
    this.factCommitsDir = resolve(this.runtimeDir, 'knowledge-fact-commits');
    this.restPoolPath = resolve(this.runtimeDir, 'knowledge-provider-users.json');
    this.restPoolReceiptPath = resolve(this.runtimeDir, 'knowledge-provider-users-allocation.json');
    this.restMemoryEnabled = restMemoryEnabled === true; this.restPoolReason = 'rest-memory-disabled';
    this.factIdentityEnabled = factIdentityEnabled === true;
    this.heartbeatMs = heartbeatMs; this.commandTimeoutMs = commandTimeoutMs; this.cloudQualified = cloudQualified === true;
    this.journal = {version: 1, kind: 'knowledge-activation'};
    this.epoch = 0; this.cancelSerial = 0; this.reason = 'not-refreshed'; this.chain = Promise.resolve(); this.closed = false;
  }
  _enqueue(work) {
    const result = this.chain.then(() => {
      if (this.closed) throw error('CLOSED');
      this.operationCancelSerial = this.cancelSerial; return work();
    });
    this.chain = result.catch(() => {}); return result;
  }
  async _save() { await this.io.write(this.journalPath, JSON.stringify(this.journal)); }
  _validRestPool(value) {
    return value?.version === 1 && value.kind === 'knowledge-provider-users' && value.policy === REST_POLICY
      && value.localUserId === this.ledger?.userId && uuid(value.localUserId)
      && Array.isArray(value.slots) && value.slots.length >= 1 && value.slots.length <= 3
      && value.slots.every(uuid) && new Set(value.slots).size === value.slots.length
      && Number.isInteger(value.activeSlot) && value.activeSlot >= 0 && value.activeSlot < value.slots.length;
  }
  async _loadRestPool() {
    this.restPool = null;
    if (!this.restMemoryEnabled) { this.restPoolReason = 'rest-memory-disabled'; return null; }
    if (!this.ledger?.userId) throw error('REST_POOL_USER_UNAVAILABLE');
    const [raw, receiptRaw] = await Promise.all([this.io.read(this.restPoolPath), this.io.read(this.restPoolReceiptPath)]);
    const pool = raw == null ? null : decode(raw), receipt = receiptRaw == null ? null : decode(receiptRaw);
    if (pool && !this._validRestPool(pool) || receipt && !this._validRestPool(receipt)) throw error('INVALID_REST_POOL');
    if (pool && receipt && JSON.stringify(pool) !== JSON.stringify(receipt)) throw error('REST_POOL_RECEIPT_MISMATCH');
    if (pool && !receipt) throw error('REST_POOL_ALLOCATION_RECEIPT_MISSING');
    if (!pool && receipt) await this.io.write(this.restPoolPath, JSON.stringify(receipt));
    this.restPool = clone(pool ?? receipt);
    if (this.restPool) this.restPoolPreviouslyObserved = true;
    this.restPoolReason = this.restPool ? 'ready' : 'rest-pool-not-initialized';
    return this.restPool;
  }
  initializeRestPool({allowNewAllocation = false} = {}) {
    return this._enqueue(async () => {
      if (!this.restMemoryEnabled) throw error('REST_MEMORY_DISABLED');
      if (await this._loadRestPool()) return this.restPoolStatus();
      if (this.restPoolPreviouslyObserved) throw error('REST_POOL_LOST_RESTORE_REQUIRED');
      if (allowNewAllocation !== true) throw error('REST_POOL_NEW_ALLOCATION_NOT_AUTHORIZED');
      const pool = {version: 1, kind: 'knowledge-provider-users', policy: REST_POLICY,
        localUserId: this.ledger.userId, slots: [randomUUID()], activeSlot: 0};
      // Explicit initialization only. The immutable allocation receipt is the
      // first durable write, so a publication failure recovers the SAME UUID.
      await this.io.write(this.restPoolReceiptPath, JSON.stringify(pool));
      await this.io.write(this.restPoolPath, JSON.stringify(pool));
      this.restPool = pool; this.restPoolPreviouslyObserved = true; this.restPoolReason = 'ready';
      return this.restPoolStatus();
    });
  }
  restPoolStatus() {
    return {policy: REST_POLICY, enabled: this.restMemoryEnabled, ready: !!this.restPool,
      limit: 3, allocated: this.restPool?.slots.length ?? 0, reason: this.restPoolReason};
  }
  async _publishBinding() {
    const identity = this.saveIdentity;
    await this.io.write(this.bindingPath, JSON.stringify({version: 1,
      status: identity.status === 'verified' ? 'ready' : 'unavailable', publishedAt: this.now(), identity}));
  }
  async _factCommit(generation) {
    if (!integer(generation) || generation < 1 || generation > MAX_FACT_COMMIT) throw error('INVALID_FACT_COMMIT');
    const raw = await this.io.read(resolve(this.factCommitsDir, `${generation}.json`));
    if (raw === null || raw === undefined) throw error('FACT_COMMIT_NOT_PREPARED');
    const entry = decode(raw);
    if (entry.kind !== 'knowledge-fact-commit' || !validFactRecord(entry.record)
        || entry.record.commitGeneration !== generation || !integer(entry.expectedHead)) throw error('INVALID_FACT_COMMIT');
    return entry;
  }
  async _confirmedFactRecords(n, prepared) {
    if (!isFacts(n)) return [];
    const records = new Map();
    for (let bank = 0; bank < 2; bank++) {
      const value = n.banks[bank];
      if (!value || value.bank !== bank || typeof value.empty !== 'boolean') throw error('INVALID_FACT_BANK');
      if (value.empty) continue;
      const generation = value.valid ? value.record?.commitGeneration : value.raw?.generation;
      const entry = await this._factCommit(generation);
      if (value.valid && (!sameFactRecord(value.record, entry.record) || value.record.bank !== bank)) throw error('FACT_REGISTRY_MISMATCH');
      // A partial inactive bank never authorizes a cursor. The driver may only
      // repair an exact previous->prepared write prefix, supplied separately.
      if (!value.valid && n.factHead !== 0 && n.factHead % 2 === bank) throw error('INVALID_ACTIVE_FACT_BANK');
      records.set(generation, entry.record);
    }
    if (n.schema === 1 && !sameFactRecord(records.get(n.commitGeneration), n)) throw error('FACT_REGISTRY_MISMATCH');
    if (n.restoredCandidate) {
      // The immutable boundary receipt can outlive both rotating banks. Keep
      // its exact registry record confirmed without manufacturing a proof from
      // the candidate: only the driver's real callback can expose that proof.
      if (!validFactRecord(n.restoredCandidate) || n.restoredCandidate.campaignId !== n.campaignId) throw error('INVALID_RESTORED_FACT_CANDIDATE');
      const restored = await this._factCommit(n.restoredCandidate.commitGeneration);
      if (!sameFactRecord(restored.record, n.restoredCandidate)) throw error('FACT_REGISTRY_MISMATCH');
      records.set(restored.record.commitGeneration, restored.record);
    }
    if (prepared) {
      const entry = await this._factCommit(prepared.commitGeneration);
      if (!sameFactRecord(entry.record, prepared)) throw error('FACT_REGISTRY_MISMATCH');
      records.set(prepared.commitGeneration, entry.record);
      if (validFactRecord(entry.previousBank)) {
        const previous = await this._factCommit(entry.previousBank.commitGeneration);
        if (!sameFactRecord(previous.record, entry.previousBank)) throw error('FACT_REGISTRY_MISMATCH');
        records.set(previous.record.commitGeneration, previous.record);
      }
    }
    return [...records.values()].map(factRecord);
  }
  async _prepareFactCommit(kind, fields, n) {
    if (fields.preparedRecord) {
      const saved = await this._factCommit(fields.preparedRecord.commitGeneration);
      if (!sameFactRecord(saved.record, fields.preparedRecord) || saved.expectedHead !== n.factHead) throw error('FACT_REGISTRY_MISMATCH');
      return saved;
    }
    const raw = await this.io.read(this.factIndexPath);
    let highWater = 0;
    if (raw !== null && raw !== undefined) {
      const index = decode(raw);
      if (index.kind !== 'knowledge-fact-index' || !integer(index.highWater) || index.highWater > MAX_FACT_COMMIT) throw error('INVALID_FACT_INDEX');
      highWater = index.highWater;
    } else if (n.schema !== 0 || n.banks.some(bank => !bank.empty)) throw error('FACT_INDEX_UNAVAILABLE');
    const used = Math.max(n.commitGeneration ?? 0, ...n.banks.map(bank => bank.record?.commitGeneration ?? bank.raw?.generation ?? 0));
    if (highWater < used || highWater >= MAX_FACT_COMMIT) throw error('FACT_GENERATION_UNAVAILABLE');
    const commitGeneration = highWater + 1, bank = n.schema === 0 ? 0 : 1 - n.bank;
    const record = {schema: 1, bank, commitGeneration,
      campaignId: kind === 'seed' ? fields.campaignId : n.campaignId,
      branchId: kind === 'advance' ? n.branchId : fields.branchId,
      branchEpoch: kind === 'seed' ? 1 : kind === 'fork' ? fields.branchEpoch : n.branchEpoch,
      ledgerSequence: kind === 'advance' ? fields.ledgerSequence : 0};
    if (!validFactRecord(record)) throw error('INVALID_FACT_COMMIT');
    const destination = n.banks[bank];
    if (!destination.empty && !destination.valid) throw error('FACT_BANK_RECOVERY_REQUIRED');
    const previousBank = destination.empty ? {bank, empty: true} : factRecord(destination.record);
    const path = resolve(this.factCommitsDir, `${commitGeneration}.json`);
    const existing = await this.io.read(path);
    if (existing !== null && existing !== undefined) throw error('FACT_GENERATION_REUSE');
    // Consume the generation durably before preparing it. Failed/abandoned
    // attempts leave permanent gaps; rollback never reuses their generation.
    await this.io.write(this.factIndexPath, JSON.stringify({version: 1, kind: 'knowledge-fact-index', highWater: commitGeneration}));
    const entry = {version: 1, kind: 'knowledge-fact-commit', record, previousBank, expectedHead: n.factHead};
    await this.io.write(path, JSON.stringify(entry));
    return entry;
  }
  _fresh() {
    const age = this.now() - (this.state?.publishedAt ?? -Infinity);
    return Number.isFinite(age) && age >= -1000 && age <= this.heartbeatMs;
  }
  async _read() {
    let value;
    try { value = decode(await this.io.read(this.statePath)); }
    catch (cause) { this.state = null; throw cause; }
    this.state = value;
    if (!this._fresh()) throw error('HEARTBEAT_EXPIRED');
    if (value.status !== 'ready') throw error('NATIVE_UNAVAILABLE');
    const n = nativeState(value);
    if (!n || !n.ready || n.faulted || n.saving) throw error(n?.saving ? 'SAVE_IN_PROGRESS' : 'NATIVE_UNAVAILABLE');
    if (isFacts(n) && !this.factIdentityEnabled) throw error('FACT_IDENTITY_DISABLED');
    return n;
  }
  async _readReady(reference) {
    const started = this.now(), cancelSerial = this.operationCancelSerial;
    let paused = false, original = reference ? clone(reference) : null;
    for (let attempt = 0; attempt <= 40; attempt++) {
      if (this.closed || cancelSerial !== this.cancelSerial) throw error('CANCELLED');
      try {
        const observed = await this._read();
        if (paused && !sameAuthority(observed, original)) throw error('NATIVE_ACTIVATION_CHANGED');
        return observed;
      } catch (cause) {
        if (cause.code !== 'SAVE_IN_PROGRESS') throw cause;
        const observed = nativeState(this.state);
        original ??= clone(reference === null ? observed : this.binding ?? observed);
        if (!sameAuthority(observed, original)) throw error('NATIVE_ACTIVATION_CHANGED');
        paused = true;
        if (attempt >= 40 || this.now() - started >= 1000) throw error('SAVE_PAUSE_TIMEOUT');
        await this.io.wait(25);
      }
    }
    throw error('SAVE_PAUSE_TIMEOUT');
  }
  async _unbind(reason) {
    if (this.binding) this.epoch++;
    this.binding = null; this.reason = reason;
    if (this.ledger?.identity) await this.ledger.unbind();
    await this.io.write(this.bindingPath, JSON.stringify({version: 1, status: 'unavailable',
      publishedAt: this.now(), reason, identity: unavailable(reason)})).catch(() => {});
  }
  _post(command, n) {
    if (n.generation !== command.expected.generation || n.activationId !== command.activationId
        || n.revision <= command.expected.revision || (command.expected.runtimeId ?? null) !== (n.runtimeId ?? null)) return false;
    if (isFacts(command) !== isFacts(n)) return false;
    if (isFacts(n)) {
      if (['seed', 'fork', 'advance'].includes(command.kind)) {
        if (!sameFactRecord(n, command.preparedRecord)
            || n.factHead !== command.preparedRecord.commitGeneration * 2 + command.preparedRecord.bank) return false;
      } else if (n.factHead !== command.expected.factHead) return false;
    }
    if (command.kind === 'claim') return !n.resolved && sameCursor(n, command.before);
    if (!n.resolved) return false;
    if (command.kind === 'seed') return n.campaignId === command.campaignId && n.branchId === command.branchId
      && n.branchEpoch === 1 && n.ledgerSequence === 0;
    if (command.kind === 'fork') return n.campaignId === command.before.campaignId && n.branchId === command.branchId
      && n.branchEpoch === command.branchEpoch && n.ledgerSequence === 0;
    return sameCursor(n, {...command.before, ledgerSequence: command.kind === 'advance' ? command.ledgerSequence : command.before.ledgerSequence});
  }
  async _issue(kind, fields, n, activationId, saveRetry = false) {
    const cancelSerial = this.operationCancelSerial;
    if (cancelSerial !== this.cancelSerial) throw error('CANCELLED');
    // BeforeSave/AfterSave advance revision without changing the acknowledged
    // world/cursor. Wait for that exact save to finish, then use its fresh CAS.
    const ready = await this._readReady(n);
    if (!sameAuthority(ready, n)) throw error('NATIVE_ACTIVATION_CHANGED');
    n = ready;
    if (isFacts(n)) {
      fields = {...fields};
      if (['seed', 'fork', 'advance'].includes(kind)) {
        const entry = await this._prepareFactCommit(kind, fields, n);
        fields.preparedRecord = entry.record; fields.previousBank = entry.previousBank;
        if (kind === 'advance' && this.journal.append) {
          Object.assign(this.journal.append, {preparedRecord: entry.record, previousBank: entry.previousBank});
        }
      }
      fields.confirmedRecords = await this._confirmedFactRecords(n, fields.preparedRecord);
    }
    const command = {version: 1, id: opaque(), activationId, kind, expected: expected(n),
      ...(isFacts(n) ? {storage: FACT_STORAGE} : {}),
      ...fields, issuedAt: this.now(), expiresAt: this.now() + this.commandTimeoutMs,
      worldGeneration: this.state.worldGeneration, before: cursor(n)};
    this.journal.pending = command;
    await this._save(); // Persist intent before publishing a possibly accepted CAS.
    if (cancelSerial !== this.cancelSerial) throw error('CANCELLED');
    await this.io.write(this.commandPath, JSON.stringify(command));
    const started = this.now();
    for (let attempt = 0; attempt < Math.ceil(this.commandTimeoutMs / 25) + 2; attempt++) {
      if (this.closed) throw error('CLOSED');
      if (cancelSerial !== this.cancelSerial) throw error('CANCELLED');
      const observed = await this._readReady(null);
      if (this._post(command, observed)) {
        delete this.journal.pending; await this._save(); return observed;
      }
      if (observed.generation !== n.generation || (observed.activationId !== n.activationId && observed.activationId !== activationId)) {
        throw error('NATIVE_ACTIVATION_CHANGED');
      }
      if ((observed.runtimeId ?? null) !== (n.runtimeId ?? null)) throw error('NATIVE_ACTIVATION_CHANGED');
      if (this.state.ack?.id === command.id && this.state.ack.ok === false) {
        // A save can start in the tiny interval after publication. Its rejected
        // command is safe to retry once only after the exact pre-state survives.
        if (!saveRetry && observed.revision > n.revision && sameAuthority(observed, n)) {
          return this._issue(kind, fields, observed, activationId, true);
        }
        throw error('NATIVE_CAS_REJECTED');
      }
      if (this.now() - started >= this.commandTimeoutMs) break;
      await this.io.wait(25);
    }
    throw error('NATIVE_COMMAND_TIMEOUT');
  }
  async _recoverPending(n) {
    const command = this.journal.pending;
    if (!command) return n;
    if (this._post(command, n)) { delete this.journal.pending; await this._save(); return n; }
    if (isFacts(n) && !n.resolved && command.expected.runtimeId === n.runtimeId
        && command.expected.generation === n.generation && command.activationId === n.activationId
        && validFactRecord(command.preparedRecord) && sameFactRecord(n, command.preparedRecord)
        && n.factHead === command.preparedRecord.commitGeneration * 2 + command.preparedRecord.bank) {
      if (command.kind === 'advance') {
        const intent = this.journal.append, info = this.ledger.branchInfo(command.before);
        if (!intent || info?.ledgerSequence !== n.ledgerSequence || intent.fromSequence !== command.before.ledgerSequence) throw error('UNPROVEN_PENDING_APPEND');
        const receipt = this.ledger.receiptFor({...command.before, eventId: intent.event.eventId, event: intent.event});
        if (!receipt?.isTail || receipt.inherited || !receipt.payloadMatches || receipt.ledgerSequence !== n.ledgerSequence) throw error('UNPROVEN_PENDING_APPEND');
      } else {
        const target = this.journal.preparation?.activation, info = target && this.ledger.branchInfo(target);
        if (!target || !sameCursor(n, target) || info?.ledgerSequence !== 0) throw error('UNPROVEN_PENDING_FACT_COMMIT');
      }
      return this._issue('resume', {preparedRecord: command.preparedRecord}, n, command.activationId);
    }
    if (n.generation !== command.expected.generation || (n.activationId !== command.expected.activationId
        && n.activationId !== command.activationId) || !sameCursor(n, command.before)
        || (n.runtimeId ?? null) !== (command.expected.runtimeId ?? null)
        || (isFacts(n) && n.factHead !== command.expected.factHead)) {
      // A real load/new activation abandons this intention. Its durable suffix
      // stays on the old branch and can never be inherited without restore proof.
      this.journal = {version: 1, kind: 'knowledge-activation'}; await this._save(); return n;
    }
    if (command.kind === 'advance') {
      const info = this.ledger.branchInfo(command.before);
      if (info?.ledgerSequence !== command.ledgerSequence || !this.journal.append) throw error('UNPROVEN_PENDING_APPEND');
      const intent = this.journal.append;
      const receipt = this.ledger.receiptFor({...command.before, eventId: intent.event.eventId, event: intent.event});
      if (intent.fromSequence !== command.before.ledgerSequence || !receipt?.isTail || receipt.inherited
          || !receipt.payloadMatches || receipt.ledgerSequence !== command.ledgerSequence) throw error('UNPROVEN_PENDING_APPEND');
      if (isFacts(n) && !n.resolved) {
        // An interrupted inactive-bank write does not change the selected
        // cursor. Revalidate that old cursor before retrying the exact prepared
        // commit; its immutable record also remains in the append journal if
        // the process stops between this resume and the subsequent write.
        n = await this._issue('resume', {}, n, command.activationId);
      }
    }
    const fields = {};
    for (const key of ['campaignId', 'branchId', 'branchEpoch', 'ledgerSequence', 'preparedRecord', 'previousBank']) if (command[key] !== undefined) fields[key] = command[key];
    return this._issue(command.kind, fields, n, command.activationId);
  }
  async _prepare(n) {
    const activationId = opaque(), branchId = opaque();
    const base = {activationId, generation: n.generation, campaignId: n.schema === 0 ? opaque() : n.campaignId,
      branchId, branchEpoch: n.schema === 0 ? 1 : n.branchEpoch + 1,
      ledgerSequence: 0, checkpointId: `live-${branchId}`,
      ...(isFacts(n) ? {storage: FACT_STORAGE, runtimeId: n.runtimeId} : {})};
    const input = {authoritative: true, campaignId: base.campaignId, branchId, checkpointId: base.checkpointId};
    const proof = !isFacts(n) && n.schema === 1 && n.restored ? proofFor(n) : null;
    if (proof) {
      const parent = this.ledger.branchInfo({campaignId: n.campaignId, branchId: n.branchId});
      if (!parent || parent.ledgerSequence < proof.ledgerSequence) throw error('RESTORED_PREFIX_UNAVAILABLE');
      Object.assign(input, {parentBranchId: n.branchId, forkCheckpointId: proof.checkpointId,
        forkLedgerSequence: proof.ledgerSequence, restoredProof: proof});
    }
    if (isFacts(n) && n.schema === 1) {
      const parent = this.ledger.branchInfo(n);
      if (!parent || parent.ledgerSequence < n.ledgerSequence) throw error('CURRENT_FACT_PREFIX_UNAVAILABLE');
    }
    this.journal = {version: 1, kind: 'knowledge-activation', preparation: {
      operation: n.schema === 0 ? 'seed' : 'fork', activation: base, input,
      ...(isFacts(n) && n.schema === 1 ? {factPrefix: {...factRecord(n), factHead: n.factHead}, factsPrefixPending: true} : {}),
      restoredProof: proof, isolationReason: n.schema === 1 && !proof ? 'no-proven-restored-prefix' : undefined}};
    await this._save();
    return this._issue('claim', {}, n, activationId);
  }
  async _finishPreparation(n) {
    const plan = this.journal.preparation, target = plan.activation;
    if (!sameWorld(n, target)) throw error('PREPARATION_WORLD_CHANGED');
    if (plan.factsPrefixPending) {
      if (!sameFactRecord(n, plan.factPrefix) || n.factHead !== plan.factPrefix.factHead) throw error('FACT_PREFIX_CHANGED');
      const restoredProof = proofFor(n), checkpointId = `${n.branchId}:${n.commitGeneration}:${n.ledgerSequence}`;
      const currentPrefixProof = {kind: 'native-facts-current-prefix', source: FACT_STORAGE,
        campaignId: n.campaignId, branchId: n.branchId, branchEpoch: n.branchEpoch, ledgerSequence: n.ledgerSequence,
        commitGeneration: n.commitGeneration, factHead: n.factHead, runtimeId: n.runtimeId};
      Object.assign(plan.input, {parentBranchId: n.branchId, forkCheckpointId: checkpointId,
        forkLedgerSequence: n.ledgerSequence, ...(restoredProof ? {restoredProof} : {currentPrefixProof})});
      plan.restoredProof = restoredProof; plan.currentPrefixProof = restoredProof ? undefined : currentPrefixProof;
      plan.factsPrefixPending = false;
      await this._save(); // Claim readback, never bootstrap, selects actual restore authority.
    }
    const exists = this.ledger.branchInfo(target);
    await this.ledger.bindIdentity(exists ? resumeInput(target, 0) : plan.input);
    if (!(n.resolved && sameCursor(n, target))) {
      n = await this._issue(plan.operation, plan.operation === 'seed'
        ? {campaignId: target.campaignId, branchId: target.branchId}
        : {branchId: target.branchId, branchEpoch: target.branchEpoch}, n, target.activationId);
    }
    this.journal.binding = {...target, restoredProof: plan.restoredProof,
      ...(isFacts(n) ? {factHead: n.factHead, commitGeneration: n.commitGeneration} : {})};
    delete this.journal.preparation; await this._save();
    return n;
  }
  async _recoverAppend(n) {
    const intent = this.journal.append;
    if (!intent) return n;
    const saved = this.journal.binding;
    if (!saved || !sameWorld(n, saved) || n.campaignId !== saved.campaignId || n.branchId !== saved.branchId) {
      throw error('APPEND_WORLD_CHANGED');
    }
    const info = this.ledger.branchInfo(saved);
    if (!info || info.ledgerSequence < intent.fromSequence || info.ledgerSequence > intent.fromSequence + 1) throw error('ORPHAN_LEDGER_TAIL');
    // The exact durable write-ahead event is replayable/idempotent. An unrelated
    // extra operation is never accepted as the pending native cursor.
    if (info.ledgerSequence > intent.fromSequence) {
      const receipt = this.ledger.receiptFor({campaignId: saved.campaignId, branchId: saved.branchId,
        eventId: intent.event.eventId, event: intent.event});
      if (!receipt?.isTail || receipt.inherited || !receipt.payloadMatches
          || receipt.ledgerSequence !== info.ledgerSequence) throw error('UNPROVEN_PENDING_APPEND');
    }
    await this.ledger.bindIdentity(resumeInput(saved, info.ledgerSequence));
    const result = await this.ledger.observe(intent.event);
    if (result.ledgerSequence !== intent.fromSequence && result.ledgerSequence !== intent.fromSequence + 1) throw error('ORPHAN_LEDGER_TAIL');
    if (n.ledgerSequence < result.ledgerSequence) {
      if (n.ledgerSequence !== intent.fromSequence) throw error('APPEND_CURSOR_MISMATCH');
      const fields = {ledgerSequence: result.ledgerSequence};
      if (isFacts(n) && intent.preparedRecord) {
        fields.preparedRecord = intent.preparedRecord; fields.previousBank = intent.previousBank;
      }
      n = await this._issue('advance', fields, n, saved.activationId);
    }
    if (n.ledgerSequence !== result.ledgerSequence) throw error('APPEND_CURSOR_MISMATCH');
    this.journal.binding.ledgerSequence = result.ledgerSequence;
    if (isFacts(n)) Object.assign(this.journal.binding, {factHead: n.factHead, commitGeneration: n.commitGeneration});
    delete this.journal.append; await this._save();
    return n;
  }
  async _refresh() {
    try {
      if (this.failure || !this.ledger) throw error(this.failure ?? 'LEDGER_UNAVAILABLE');
      let n = await this._readReady();
      if (isFacts(n)) await this._confirmedFactRecords(n);
      n = await this._recoverPending(n);
      let saved = this.journal.binding;
      const prepared = this.journal.preparation;
      if (prepared && !sameWorld(n, prepared.activation)) {
        if (n.activationId === '' || n.generation !== prepared.activation.generation
            || (n.runtimeId ?? null) !== (prepared.activation.runtimeId ?? null)) {
          this.journal = {version: 1, kind: 'knowledge-activation'}; await this._save();
        } else throw error('PREPARATION_LEASE_MISMATCH');
      }
      if (!this.journal.preparation && (!saved || !sameWorld(n, saved)
          || n.campaignId !== saved.campaignId || n.branchId !== saved.branchId || n.branchEpoch !== saved.branchEpoch)) {
        await this._unbind('native-activation-changed'); n = await this._prepare(n);
      }
      if (this.journal.preparation) n = await this._finishPreparation(n);
      n = await this._recoverAppend(n);
      saved = this.journal.binding;
      if (!saved || !sameWorld(n, saved) || !sameCursor(n, saved) || !sameHead(n, saved)) throw error('NATIVE_CURSOR_MISMATCH');
      const info = this.ledger.branchInfo(saved);
      if (!info || info.ledgerSequence !== n.ledgerSequence) throw error('ORPHAN_LEDGER_TAIL');
      if (!this.binding || !this.ledger.identity || !sameWorld(this.binding, saved)) {
        await this.ledger.bindIdentity(resumeInput(saved, n.ledgerSequence));
      }
      if (!n.resolved) n = await this._issue('resume', {}, n, saved.activationId);
      if (this.state.identity?.status !== 'available' || this.state.identity?.authoritative !== true
          || !sameWorld(this.state.identity, saved) || !sameCursor(this.state.identity, saved)) throw error('NATIVE_READBACK_UNAVAILABLE');
      if (!sameHead(this.state.identity, saved)) throw error('NATIVE_READBACK_UNAVAILABLE');
      if (this.operationCancelSerial !== this.cancelSerial) throw error('CANCELLED');
      this.binding = clone(saved); this.reason = 'available';
      await this._publishBinding();
      return this.saveIdentity;
    } catch (cause) {
      if (cause.code === 'SAVE_PAUSE_TIMEOUT' && !this.journal.pending && !this.journal.append) {
        // The same fresh native activation is still saving. Withhold routes
        // without throwing away its ledger lease or manufacturing a new world.
        this.reason = 'save-in-progress'; return unavailable(this.reason);
      }
      await this._unbind(cause.code ?? 'COORDINATION_FAILED'); return this.saveIdentity;
    }
  }
  refresh() { return this._enqueue(() => this._refresh()); }
  get saveIdentity() {
    if (!this.binding || !this._fresh() || this.closed || this.journal.pending || this.journal.append) return unavailable(this.reason);
    const native = nativeState(this.state);
    if (this.state.status === 'ready' && native?.ready && native.saving && !native.faulted
        && sameAuthority(native, this.binding)) return unavailable('save-in-progress');
    if (this.state.status !== 'ready' || !native?.ready || native.saving || native.faulted || !native.resolved
        || !sameWorld(native, this.binding) || !sameCursor(native, this.binding) || !sameHead(native, this.binding)
        || this.state.identity?.status !== 'available' || this.state.identity.authoritative !== true) return unavailable('NATIVE_READBACK_UNAVAILABLE');
    const local = this.ledger.identity;
    if (!local || local.branchId !== this.binding.branchId || local.ledgerSequence !== this.binding.ledgerSequence) return unavailable('LEDGER_NOT_BOUND');
    return {...clone(local), authoritative: true, localUserId: local.userId, generation: this.binding.generation,
      activationId: this.binding.activationId, branchEpoch: this.binding.branchEpoch,
      confidence: this.state.identity?.confidence ?? 'native-live',
      restoredProof: clone(this.binding.restoredProof), worldGeneration: this.state.worldGeneration ?? this.binding.generation,
      ...(isFacts(this.binding) ? {storage: FACT_STORAGE, runtimeId: this.binding.runtimeId,
        factHead: this.binding.factHead, commitGeneration: this.binding.commitGeneration} : {}),
      worldToken: worldToken(this.binding)};
  }
  guard() {
    const id = this.saveIdentity;
    return id.status === 'verified' ? {epoch: this.epoch, generation: id.generation,
      activationId: id.activationId, branchId: id.branchId, worldGeneration: id.worldGeneration,
      userId: id.userId, remoteGeneration: id.remoteGeneration,
      ...(isFacts(id) ? {storage: FACT_STORAGE, runtimeId: id.runtimeId} : {})} : null;
  }
  isCurrent(guard) {
    const current = this.guard();
    return !!guard && !!current && Object.keys(current).every(key => current[key] === guard[key]);
  }
  async current(guard) { await this.refresh(); return this.isCurrent(guard); }
  sessionIdentity(profile, channel = 'private', audience) {
    const members = audienceFor(profile, channel, audience), id = this.saveIdentity;
    if (id.status !== 'verified' || members.some(key => AMBIENT.has(key))) return null;
    const context = this.ledger.contextFor({characterKey: profile, channel, audience: members});
    return {userId: id.userId, campaignId: id.campaignId, playthroughId: id.playthroughId, branchId: id.branchId,
      profileKey: profile, channel, audience: members, localScopeId: context.endUserId, guard: this.guard(),
      providerPolicy: REST_POLICY,
      restEndUserId: this.restMemoryEnabled && this.restPool?.localUserId === id.userId
        ? this.restPool.slots[this.restPool.activeSlot] : null};
  }
  configFor(profile, channel = 'private', audience) {
    audienceFor(profile, channel, audience);
    // Local branches and exact group audiences may have unlimited local scopes.
    // They must never allocate provider users: the product limit is three IDs
    // per local user, reused across characters and restored saves. The separate
    // REST pool archives explicit memories; live SDK sessions stay anonymous.
    return null;
  }
  async _append(event, n) {
    const fromSequence = n.ledgerSequence;
    this.journal.append = {fromSequence, event: clone(event)};
    await this._save(); // Write-ahead intent makes a one-operation orphan recoverable.
    const receipt = await this.ledger.observe(event); // Durable commit must finish first.
    if (receipt.ledgerSequence !== fromSequence && receipt.ledgerSequence !== fromSequence + 1) throw error('APPEND_CURSOR_MISMATCH');
    if (receipt.ledgerSequence > fromSequence) n = await this._issue('advance', {ledgerSequence: receipt.ledgerSequence}, n, this.binding.activationId);
    this.journal.binding.ledgerSequence = receipt.ledgerSequence;
    if (isFacts(n)) Object.assign(this.journal.binding, {factHead: n.factHead, commitGeneration: n.commitGeneration});
    delete this.journal.append; await this._save();
    this.binding = clone(this.journal.binding);
    await this._publishBinding();
    return {native: n, receipt};
  }
  project(input = {}) {
    return this._enqueue(async () => {
      await this._refresh();
      let snapshot = parseWorldSnapshot(input.snapshot);
      const channel = input.channel ?? snapshot.audience?.channel ?? 'private';
      const members = audienceFor(input.profileKey, channel, input.audience ?? snapshot.audience?.profileKeys);
      const capturedAt = Date.parse(snapshot.capturedAt), age = this.now() - capturedAt;
      if (snapshot.status !== 'ready' || snapshot.generation !== input.generation || !Number.isFinite(age)
          || age < -1000 || age > this.heartbeatMs
          || snapshot.audience.channel !== channel || JSON.stringify([...snapshot.audience.profileKeys].sort()) !== JSON.stringify(members)) {
        snapshot = {version: 1, status: 'unavailable'};
      }
      const identity = this.saveIdentity, guard = this.guard();
      const ambient = members.some(key => AMBIENT.has(key));
      if (identity.status === 'verified' && snapshot.status === 'ready' && snapshot.generation !== identity.worldGeneration) {
        snapshot = {version: 1, status: 'unavailable'};
      }
      const boundCapture = !ambient && identity.status === 'verified' && snapshot.worldToken === identity.worldToken;
      if (identity.status === 'verified' && snapshot.worldToken && snapshot.worldToken !== identity.worldToken) snapshot = {version: 1, status: 'unavailable'};
      snapshot = {...snapshot, identity: boundCapture ? clone(identity) : {status: 'unknown'}};
      const result = resolveKnowledge({pack: this.pack, snapshot, profileKey: input.profileKey, query: input.query, maxChars: input.maxChars});
      const recorded = [];
      let recordError, stale = false;
      try {
        if (guard && boundCapture && snapshot.status === 'ready') {
          if (channel === 'group') await this.ledger.registerGroup(members);
          let n = await this._readReady();
          if (!sameWorld(n, this.binding) || !sameCursor(n, this.binding)) throw error('STALE_PROJECTION');
          for (const event of result.events) {
            const observed = await this._append({...event, audience: members}, n);
            n = observed.native; recorded.push(observed.receipt);
          }
          if (!this.isCurrent(guard)) throw error('STALE_PROJECTION');
        }
      } catch (cause) {
        recordError = cause.code ?? 'DURABLE_APPEND_FAILED';
        // A disk failure may leave the current capture useful. A world or
        // cancellation failure may not: verify the original world again rather
        // than classifying an error string as proof that the capture is current.
        try {
          const observed = await this._readReady(identity);
          stale = !guard || guard.epoch !== this.epoch || !sameWorld(observed, identity)
            || observed.branchId !== identity.branchId || observed.campaignId !== identity.campaignId;
        } catch { stale = true; }
        await this._unbind(recordError);
      }
      // Do not release context captured before a load just because its ledger
      // write finished later. Append failures alone still permit current facts.
      return {knowledgeContext: stale ? '' : result.context, eventsRecorded: recorded, diagnostics: result.diagnostics,
        recordError, saveIdentity: this.saveIdentity, guard: !stale && boundCapture && snapshot.status === 'ready' ? this.guard() : null,
        memoryReason: ambient ? 'ambient-identity-unavailable' : !boundCapture ? 'capture-identity-unavailable' : this.reason,
        remoteConfig: !stale && boundCapture ? this.configFor(input.profileKey, channel, members) : null,
        cloudEligible: !stale && boundCapture && this.cloudQualified && this.pendingCloud().length > 0};
    });
  }
  recordActivity(input = {}) {
    // Freeze the caller's request and route before the queued async operation.
    // The caller must not replace its guard with a freshly obtained one later.
    let frozen;
    try { frozen = clone(input); } catch { return Promise.resolve({status: 'unavailable', reason: 'INVALID_ACTIVITY',
      guard: null, cursor: null, remoteConfig: null, sendAllowed: false}); }
    return this._enqueue(async () => {
      try {
        const {requestId, profileKey, kind, guard} = frozen, channel = frozen.channel ?? 'private';
        if (!ACTIVITY_KINDS.has(kind) || typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(requestId)) {
          throw error('INVALID_ACTIVITY');
        }
        const members = audienceFor(profileKey, channel, frozen.audience);
        if (members.some(key => AMBIENT.has(key))) throw error('ambient-identity-unavailable');
        if (members.some(key => !this.pack.profileKeys.includes(key))) throw error('INVALID_AUDIENCE');
        const metadata = activityMetadata(frozen.metadata);
        if ((frozen.userText !== undefined && kind !== 'submitted-input')
            || (frozen.replyText !== undefined && kind !== 'generated-reply')) throw error('INVALID_ACTIVITY_TEXT_STAGE');
        const content = kind === 'submitted-input' ? stagedText(frozen.userText, 'userText')
          : kind === 'generated-reply' ? stagedText(frozen.replyText, 'replyText') : null;
        const delivered = kind === 'delivered-reply' ? deliveryReceipt(frozen.delivery, requestId, channel) : null;
        if (delivered && (metadata.totalChunks !== undefined || metadata.completedChunks !== undefined)
            && (metadata.totalChunks !== delivered.totalChunks || metadata.completedChunks !== delivered.completedChunks)) throw error('DELIVERY_NOT_CONFIRMED');
        if (delivered && frozen.delivery.witnessedBy !== undefined) {
          const witnesses = frozen.delivery.witnessedBy;
          if (!Array.isArray(witnesses) || !witnesses.includes(profileKey) || witnesses.length > members.length
              || new Set(witnesses).size !== witnesses.length || witnesses.some(key => !members.includes(key))) throw error('INVALID_DELIVERY_AUDIENCE');
          delivered.witnessedBy = [...witnesses].sort();
        }
        if (kind !== 'delivered-reply' && frozen.delivery !== undefined) throw error('INVALID_ACTIVITY');
        await this._refresh();
        if (!this.isCurrent(guard)) throw error('STALE_ACTIVITY');
        const identity = this.saveIdentity;
        const find = stage => this.ledger.readEvent({campaignId: identity.campaignId, branchId: identity.branchId,
          eventId: activityId(identity, requestId, profileKey, channel, members, stage)});
        const submitted = find('submitted-input'), generated = find('generated-reply'),
          cancelled = find('cancelled-turn'), completed = find('delivered-reply');
        if (kind !== 'submitted-input' && !submitted) throw error('SUBMISSION_NOT_RECORDED');
        if (cancelled && kind !== 'cancelled-turn') throw error('TURN_ALREADY_CANCELLED');
        if (completed && kind !== 'delivered-reply') throw error('TURN_ALREADY_DELIVERED');
        const conversation = delivered ? conversationEpisode({submitted, generated, delivered, profileKey, members, channel}) : null;
        const event = {eventId: activityId(identity, requestId, profileKey, channel, members, kind), factId: requestId,
          kind: 'transport-activity', authority: 'transport-event', text: `Conversation activity: ${kind}.`,
          stable: true, eligibleForMemory: false, knownBy: [profileKey], witnessedBy: [], audience: members,
          visibility: 'private', identity: clone(identity), outcome: kind,
          provenance: {producer: 'conversation-transport', requestId, activityKind: kind, channel, audience: members,
            ...(content ? {contentHash: content.sha256} : {})},
          evidence: [{metadata, ...(content ? {content} : {}), ...(delivered ? {delivery: delivered} : {})}]};
        if (conversation?.text) {
          Object.assign(event, {kind: 'shared-experience', authority: 'delivered-conversation', eligibleForMemory: true,
            text: conversation.text, knownBy: conversation.knownBy, witnessedBy: conversation.witnessedBy,
            visibility: conversation.visibility,
            delivery: {requestId, state: 'played', source: delivered.source, replyHash: conversation.replyHash,
              ...(delivered.backend ? {backend: delivered.backend} : {})}});
          Object.assign(event.provenance, {producer: 'delivered-conversation', speakerKey: profileKey,
            statementAuthority: 'quoted-conversation-only', userHash: conversation.userHash, replyHash: conversation.replyHash});
          event.evidence[0].stages = {submittedEventId: submitted.event.eventId, generatedEventId: generated.event.eventId};
          if (channel === 'group') await this.ledger.registerGroup(members);
        }
        const prior = this.ledger.receiptFor({campaignId: identity.campaignId, branchId: identity.branchId,
          eventId: event.eventId, event});
        if (prior && !prior.payloadMatches) throw error('ACTIVITY_ID_CONFLICT');
        const n = await this._readReady(identity);
        if (!sameWorld(n, identity) || !sameCursor(n, this.binding) || !this.isCurrent(guard)) throw error('STALE_ACTIVITY');
        const result = await this._append(event, n);
        if (!this.isCurrent(guard)) throw error('STALE_ACTIVITY');
        return {status: 'recorded', kind, requestId, receipt: result.receipt, guard: this.guard(),
          cursor: cursor(result.native), ledgerSequence: result.native.ledgerSequence, saveIdentity: this.saveIdentity,
          userHash: kind === 'submitted-input' ? content?.sha256 ?? null : stageContent(submitted, 'userText')?.sha256 ?? null,
          replyHash: kind === 'generated-reply' ? content?.sha256 ?? null : stageContent(generated, 'replyText')?.sha256 ?? null,
          conversationMemoryRecorded: !!conversation?.text,
          memoryReason: conversation ? (conversation.text ? 'delivered-conversation-recorded' : conversation.reason)
            : content ? (content.retained ? 'text-staged-not-delivered' : 'conversation-text-too-long') : 'conversation-text-not-provided',
          sendAllowed: kind === 'submitted-input' && !result.receipt.duplicate,
          remoteConfig: kind !== 'cancelled-turn' ? this.configFor(profileKey, channel, members) : null};
      } catch (cause) {
        const reason = cause.code ?? 'ACTIVITY_RECORDING_FAILED';
        // Invalid/stale caller data must not revoke an otherwise valid current
        // party's identity. An unfinished durable transaction must revoke it.
        if (this.journal.append || this.journal.pending) await this._unbind(reason);
        return {status: 'unavailable', reason, guard: null, cursor: null, remoteConfig: null, sendAllowed: false};
      }
    });
  }
  pendingCloud(options = {}) {
    if (!this.cloudQualified || !this.restMemoryEnabled || !this.restPool || !this.guard()) return [];
    const restEndUserId = this.restPool.slots[this.restPool.activeSlot];
    return this.ledger.pending(options).filter(entry => !entry.restEndUserId || entry.restEndUserId === restEndUserId).map(entry => ({...entry,
      // entry.endUserId remains a LOCAL ledger scope for lease accounting only.
      restEndUserId, providerPolicy: REST_POLICY, guard: this.guard()}));
  }
  cancel(reason = 'cancelled') {
    this.cancelSerial++; this.epoch++; this.binding = null; this.reason = reason;
    return this._enqueue(() => this._unbind(reason));
  }
  status() { return {version: 1, reason: this.reason, bound: this.saveIdentity.status === 'verified',
    saveIdentity: this.saveIdentity, pending: this.journal.pending?.kind ?? null, appendPending: !!this.journal.append,
    cloudQualified: this.cloudQualified && this.restMemoryEnabled && !!this.restPool,
    providerIdentityPolicy: REST_POLICY, providerIdLimit: 3, liveProviderIdentityEnabled: false, restPool: this.restPoolStatus(),
    factIdentityEnabled: this.factIdentityEnabled, ledger: this.ledger?.status()}; }
  async close() {
    this.closed = true; this.cancelSerial++; this.epoch++; this.binding = null; await this.chain;
    await this.io.write(this.bindingPath, JSON.stringify({version: 1, status: 'unavailable', publishedAt: this.now(),
      reason: 'closed', identity: unavailable('closed')})).catch(() => {});
    await this.ledger?.close();
  }
}
