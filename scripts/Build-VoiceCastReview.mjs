/**
 * Assemble an offline audition index from the immutable original-PCM receipts.
 * This is a read-only consumer of casting work. It never promotes a voice,
 * changes runtime configuration, infers listening approval, or runs a model.
 *
 * node scripts/Build-VoiceCastReview.mjs [--project <root>]
 *
 * Cast lanes may still be writing. An incomplete/changed input is quarantined
 * for this snapshot, then picked up on the next run. Every playback URL needs
 * a contained real file, a matching WAV hash and matching immutable receipt.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JSON_LIMIT = 64 * 1024 * 1024;
const WAV_LIMIT = 32 * 1024 * 1024;
const SERIALIZER = '7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738';
const DEFAULT_INVENTORY = 'runtime/voice-cast-inventory-20261001';
const DEFAULT_AUDITIONS = 'runtime/voice-cast/auditions/full-cast-20261001/results.json';
export const AUDITION_TEXT = "Good to see you. Let's take this one step at a time.";
const ACCEPTED_KEYS = new Set(['johnny-silverhand', 'judy-alvarez', 'panam-palmer']);
const PROPOSAL_NAMES = [
  'selection-review.json', 'profile-proposals.json', 'selection.json',
  'source-review.json', 'candidate-decisions.json', 'qualification.json',
  'coverage-and-quality.json', 'candidate-review.json', 'shortlist-provisional.json',
];

const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const within = (file, root) => file === root || (!path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const boundedText = (value, max = 6000) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function relativeName(value) {
  check(boundedText(value, 1600) && value.length > 0, 'Missing or invalid contained file path');
  const result = slash(value);
  check(!path.isAbsolute(value) && !result.startsWith('/') && !/^[a-z]+:/i.test(result), 'Absolute or URL file path rejected');
  check(result.split('/').every(part => part && part !== '.' && part !== '..'), 'Path traversal rejected');
  return result;
}

function pointerAt(object, pointer) {
  check(typeof pointer === 'string' && pointer.startsWith('/') && pointer.length < 2000, 'Invalid native JSON pointer');
  return pointer.slice(1).split('/').reduce((item, part) => {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    check(!['__proto__', 'prototype', 'constructor'].includes(key), 'Unsafe JSON pointer key');
    check(item !== null && typeof item === 'object' && Object.hasOwn(item, key), 'Missing native JSON pointer');
    return item[key];
  }, object);
}

const nativeValue = value => value && typeof value === 'object' && Object.hasOwn(value, '$value') ? value.$value : value;
const normalized = value => String(value).toLowerCase().replace(/[\W_]/g, '');

/** Wrapper-compatible identity projection v1. Prompt prose is not attribution.
 * Array order and exact strings remain significant; profile presentation order
 * does not. JSON key order below matches Python sort_keys=True exactly.
 */
export function identityProjection(rows) {
  check(Array.isArray(rows) && rows.length > 0, 'Canonical identity roster must be a nonempty list');
  const seen = new Set();
  return rows.map(row => {
    check(row && typeof row === 'object' && KEY.test(row.key ?? '') && row.key.length <= 128 && !seen.has(row.key), 'Canonical identity key is malformed or duplicated');
    check(boundedText(row.name, 200) && row.name.trim(), 'Canonical identity name is missing');
    seen.add(row.key);
    const list = field => {
      const values = row[field] ?? [];
      check(Array.isArray(values) && values.every(value => boundedText(value, 1600) && value.length > 0), 'Canonical identity aliases/records must be explicit string lists');
      return [...values];
    };
    return { aliases: list('aliases'), key: row.key, name: row.name, records: list('records') };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

export function identitySha256(rows) {
  return hash(Buffer.from(JSON.stringify(identityProjection(rows)), 'utf8'));
}

export function escapeMarkdown(value) {
  return String(value).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]()#+.!|<>]/g, '\\$&');
}

function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return BigInt((crc ^ 0xffffffff) >>> 0);
}

function canonicalRecord(value, character, expected) {
  check(value?.$type === 'TweakDBID' && character.records?.includes(expected), 'Unqualified canonical record');
  const actual = nativeValue(value);
  if (value.$storage === 'string') check(actual === expected, 'Native canonical record string mismatch');
  else {
    check(value.$storage === 'uint64' && /^\d+$/.test(String(actual)), 'Unsupported native record encoding');
    const id = (BigInt(Buffer.byteLength(expected)) << 32n) | crc32(expected);
    check(BigInt(actual) === id && id > 0n, 'Native canonical record ID mismatch');
  }
}

function verifyIdentity(proof, actorData, actor, character, document, scene) {
  check(proof?.canonicalKey === character.key, 'Native identity canonical key mismatch');
  if (proof.kind === 'exact_actor') {
    const aliases = [character.name, ...(character.aliases ?? [])].map(normalized);
    check(aliases.includes(normalized(actor.name)), 'Native actor is not a canonical roster alias');
  } else if (proof.kind === 'reviewed_actor_alias') {
    check(proof.actorName === actor.name && boundedText(proof.reviewer, 400) && proof.reviewer.trim() && boundedText(proof.reason) && proof.reason.trim(), 'Native alias review is incomplete');
    check(!/(^|[ _-])(civ|civilian|generic|crowd|gang|npc|vendor|barman)([ _-]|$)/i.test(actor.name), 'Shared actors need native acquisition proof');
  } else if (proof.kind === 'direct_actor_record') {
    const suffix = { spawnDespawn: 'spawnDespawnParams/specRecordId', findInContext: 'findActorInContextParams/specRecordId' }[actorData.acquisitionPlan];
    check(suffix && proof.recordPointer === `${actor.pointer}/${suffix}`, 'Direct record does not belong to actor active acquisition');
    canonicalRecord(pointerAt(document, proof.recordPointer), character, proof.canonicalRecord);
  } else if (proof.kind === 'quest_acquisition') {
    check(proof.resourcePath === scene.jsonPath && proof.resourceSha256 === scene.jsonSha256, 'Acquisition must use the bound native scene');
    const object = pointerAt(document, proof.acquisitionPointer);
    check(['scnActorDef', 'questSpawnEntityNodeDefinition', 'questActorRegistrationNodeDefinition', 'communitySpawnEntry'].includes(object?.$type), 'Unsupported acquisition binding type');
    check([proof.recordPointer, proof.actorPointer].every(value => typeof value === 'string' && value.startsWith(`${proof.acquisitionPointer}/`)), 'Acquisition pointers must bind the same native object');
    const record = pointerAt(document, proof.recordPointer);
    if (record?.$type === 'TweakDBID') canonicalRecord(record, character, proof.recordValue);
    else check(record === proof.recordValue && character.records?.includes(record), 'Acquisition canonical record mismatch');
    const link = pointerAt(document, proof.actorPointer);
    check(nativeValue(link?.actorName ?? link) === actor.name, 'Acquisition does not link this native actor');
  } else throw new Error('Unsupported native identity proof; coordinator review remains');
}

class SnapshotReader {
  constructor(root) { this.root = root; this.cache = new Map(); this.snapshots = new Map(); }
  async file(value, allowedRoot, limit = JSON_LIMIT) {
    const relative = relativeName(value);
    const full = path.resolve(this.root, ...relative.split('/'));
    const allowed = path.resolve(this.root, ...relativeName(allowedRoot).split('/'));
    check(within(full, allowed), 'File outside assigned evidence area');
    const real = await fs.realpath(full);
    // Reject junctions/symlinks even when their target happens to be contained.
    check(real.toLowerCase() === full.toLowerCase() && within(real, this.root), 'Linked evidence path rejected');
    if (this.cache.has(relative)) return this.cache.get(relative);
    const before = await fs.stat(real);
    check(before.isFile() && before.size > 0 && before.size <= limit, 'Evidence file exceeds bound');
    const bytes = await fs.readFile(real);
    const after = await fs.stat(real);
    check(before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.length === before.size, 'Evidence changed during snapshot');
    const item = { relative, full: real, bytes, sha256: hash(bytes), sha1: hash(bytes, 'sha1') };
    this.cache.set(relative, item);
    this.snapshots.set(relative, { path: relative, sha256: item.sha256, bytes: bytes.length, mtimeMs: after.mtimeMs });
    return item;
  }
  async json(value, allowedRoot) {
    const item = await this.file(value, allowedRoot);
    if (!item.json) item.json = JSON.parse(item.bytes.toString('utf8').replace(/^\uFEFF/, ''));
    return item;
  }
  async optional(value, allowedRoot) {
    try { return await this.json(value, allowedRoot); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async checked(value, expected, allowedRoot, limit = JSON_LIMIT) {
    check(SHA256.test(expected ?? ''), 'Missing SHA-256');
    const item = await this.file(value, allowedRoot, limit);
    check(item.sha256 === expected, 'Evidence SHA-256 mismatch');
    return item;
  }
  async unchanged() {
    const updates = [];
    for (const item of this.snapshots.values()) {
      const full = path.resolve(this.root, ...item.path.split('/'));
      check((await fs.realpath(full)).toLowerCase() === full.toLowerCase(), 'Evidence path changed into a link during capture');
      const stat = await fs.stat(full);
      const mutableProgress = /^runtime\/voice-cast\/[^/]+\/[^/]+\.json$/.test(item.path);
      if (!mutableProgress) check(hash(await fs.readFile(full)) === item.sha256, 'Immutable input hash changed during capture');
      if (stat.size !== item.bytes || stat.mtimeMs !== item.mtimeMs) {
        // Casting manifests and proposal files are live progress snapshots;
        // their old bytes still form a coherent captured lane version. Original
        // candidates, source resources and canonical inputs must be immutable.
        if (mutableProgress) updates.push(item.path);
        else throw new Error('Immutable input changed before aggregate completed; rerun for a consistent snapshot');
      }
    }
    return updates;
  }
}

/** Read RIFF chunk sizes and PCM frame count rather than trusting a duration hint. */
export function pcmInfo(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE', 'Not a RIFF WAVE');
  check(bytes.readUInt32LE(4) + 8 === bytes.length, 'RIFF size mismatch');
  let format; let dataBytes; let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', cursor, cursor + 4);
    const length = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    check(start + length <= bytes.length, 'WAV chunk exceeds file');
    if (kind === 'fmt ') {
      check(!format && length >= 16, 'Duplicate or malformed WAV format');
      format = { code: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), blockAlign: bytes.readUInt16LE(start + 12), bitsPerSample: bytes.readUInt16LE(start + 14) };
    }
    if (kind === 'data') { check(dataBytes === undefined, 'Duplicate WAV data'); dataBytes = length; }
    cursor = start + length + (length & 1);
  }
  check(cursor === bytes.length && format && dataBytes > 0, 'Incomplete WAV chunks');
  check(format.code === 1 && [1, 2].includes(format.channels) && format.bitsPerSample === 16 && format.sampleRate >= 8000 && format.sampleRate <= 96000, 'Expected original 16-bit mono/stereo PCM');
  check(format.blockAlign === format.channels * 2 && format.byteRate === format.sampleRate * format.blockAlign && dataBytes % format.blockAlign === 0, 'Invalid PCM frame geometry');
  const frames = dataBytes / format.blockAlign;
  const durationSeconds = frames / format.sampleRate;
  check(durationSeconds > 0 && durationSeconds <= 30, 'Reference duration exceeds audition bound');
  return { channels: format.channels, sampleRate: format.sampleRate, bitsPerSample: format.bitsPerSample, frames, durationSeconds, bytes: bytes.length };
}

function playbackHref(relative, outputRelative) {
  return slash(path.relative(outputRelative, relative)).split('/').map(part => part === '..' ? part : encodeURIComponent(part)).join('/');
}

async function validateSource(reader, receipt, rosterHash, character) {
  const proof = receipt.provenance;
  check(proof?.rosterSha256 === rosterHash && proof.locale === 'en_us', 'Receipt roster or locale mismatch');
  const { nativeActor: actor, nativeLine: line, subtitle, audio } = proof;
  check(actor?.identityProof?.canonicalKey === receipt.key && proof.identity?.key === receipt.key, 'Receipt canonical identity mismatch');
  const scene = actor?.scene;
  check(scene && SHA1.test(scene.entrySha1 ?? '') && boundedText(scene.depotPath, 1600), 'Incomplete scene archive receipt');
  const evidenceArea = value => slash(value ?? '').startsWith('research/cyberpunk/cache/game/') ? 'research/cyberpunk/cache/game' : 'runtime/voice-cast';
  const raw = await reader.checked(scene.rawPath, scene.rawSha256, evidenceArea(scene.rawPath));
  const serialized = await reader.json(scene.jsonPath, evidenceArea(scene.jsonPath));
  check(serialized.sha256 === scene.jsonSha256, 'Native scene JSON hash mismatch');
  check(raw.sha1 === scene.entrySha1, 'Native scene archive-entry SHA-1 mismatch');
  const attestation = actor.serializationVerification;
  check(attestation?.verified === true && attestation.toolSha256 === SERIALIZER && attestation.rawSha256 === raw.sha256 && attestation.cachedJsonSha256 === serialized.sha256 && SHA256.test(attestation.dataSha256 ?? ''), 'Missing bound native serialization attestation');
  const actorData = pointerAt(serialized.json, actor.pointer);
  const lineData = pointerAt(serialized.json, line.pointer);
  const eventData = pointerAt(serialized.json, line.event?.pointer);
  check(String(actorData.actorId?.id) === actor.id && nativeValue(actorData.actorName) === actor.name && String((actorData.voicetagId ?? actorData.voiceTagId)?.id) === actor.voicetagId, 'Native actor pointer mismatch');
  check(same(actor.identityProof, proof.identity.proof), 'Canonical identity receipt mismatch');
  verifyIdentity(actor.identityProof, actorData, actor, character, serialized.json, scene);
  check(String(lineData.itemId?.id) === line.itemId && String(lineData.speaker?.id) === actor.id && line.speakerId === actor.id && String(lineData.locstringId?.ruid) === receipt.stringId && line.locstringId === receipt.stringId, 'Native speaker/line pointer mismatch');
  check(eventData.$type === 'scnDialogLineEvent' && String(eventData.screenplayLineId?.id) === line.itemId && same(eventData.voParams, line.event.voParams), 'Native dialogue event mismatch');
  check(subtitle?.locale === 'en_us' && subtitle.transcript === receipt.transcript && subtitle.transcriptSha256 === receipt.transcriptSha256 && Array.isArray(subtitle.sources) && subtitle.sources.length > 0, 'Subtitle receipt mismatch');
  const descriptor = pointerAt(serialized.json, subtitle.descriptorPointer);
  const payload = pointerAt(serialized.json, subtitle.payloadPointer);
  check(nativeValue(descriptor.localeId) === 'en_us' && String(descriptor.locstringId?.ruid) === receipt.stringId && Number(descriptor.vpeIndex) === subtitle.vpeIndex && String(descriptor.variantId?.ruid ?? descriptor.variantId) === subtitle.variantId && String(payload.variantId?.ruid ?? payload.variantId) === subtitle.variantId && payload.content === receipt.transcript, 'Native English subtitle payload mismatch');
  for (const source of subtitle.sources) {
    check(source.sha1Verified === true && SHA1.test(source.archiveEntrySha1 ?? '') && SHA256.test(source.sha256 ?? '') && source.variants?.[subtitle.variant] === receipt.transcript, 'Installed subtitle resource receipt mismatch');
    const relative = `research/cyberpunk/cache/game/localization/${relativeName(source.indexedSource?.rawPath)}`;
    const subtitleBytes = await reader.checked(relative, source.sha256, 'research/cyberpunk/cache/game/localization');
    check(subtitleBytes.sha1 === source.archiveEntrySha1, 'Installed subtitle source SHA-1 mismatch');
  }
  check(audio?.wavPath === receipt.reference && audio.sha1Verified === true && SHA1.test(audio.archiveEntrySha1 ?? ''), 'Source audio receipt incomplete');
  const wem = await reader.checked(audio.wemPath, audio.sha256, `runtime/voice-cast/${receipt.lane ?? receipt.reference.split('/')[2]}`);
  check(wem.sha1 === audio.archiveEntrySha1 && wem.bytes.toString('ascii', 0, 4) === 'RIFF', 'Original WEM receipt mismatch');
  const match = audio.depotPath?.match(/_([fm])_([a-f0-9]+)\.wem$/i);
  check(match && BigInt(`0x${match[2]}`).toString() === receipt.stringId && ({ f: 'female', m: 'male' }[match[1].toLowerCase()]) === audio.genderVariant && ({ female: 'femaleVariant', male: 'maleVariant' }[audio.genderVariant]) === subtitle.variant, 'Native line / WEM / gender variant mismatch');
  return { actor: actor.name, scene: scene.depotPath, audio: audio.depotPath, gameVersion: proof.gameVersion, locale: proof.locale, processing: 'Original decoded PCM; no additional processing', verification: 'Bound source files, actor/line/English subtitle/WEM receipts rechecked. Installed archives were not re-extracted by this report.' };
}

async function verifyCandidate(reader, row, lane, rosterHash, outputRelative, character) {
  const result = { key: row.key, reference: null, playback: null, role: 'candidate', sourceVerified: false, listeningVerified: false, approved: false, errors: [] };
  try {
    check(row?.status === 'decoded_verified' && row.attributionVerified === true && row.transcriptAgreement === true, 'Candidate is not a decoded, attributed receipt');
    check(KEY.test(row.key ?? '') && row.key.length <= 128 && /^\d+$/.test(row.stringId ?? '') && boundedText(row.transcript) && row.transcript.length > 0, 'Invalid candidate metadata');
    const area = `runtime/voice-cast/${lane}`;
    const relative = relativeName(row.reference);
    check(relative.startsWith(`${area}/${row.key}/`) && relative.endsWith('/reference.wav'), 'Candidate file outside its profile');
    const receiptFile = await reader.json(`${path.posix.dirname(relative)}/receipt.json`, area);
    const receipt = receiptFile.json;
    for (const field of ['key', 'stringId', 'reference', 'sha256', 'transcript', 'transcriptSha256', 'status']) check(receipt[field] === row[field], 'Manifest/immutable receipt mismatch');
    check(receipt.attributionVerified === true && receipt.transcriptAgreement === true, 'Immutable attribution receipt is incomplete');
    check(SHA256.test(row.transcriptSha256 ?? '') && hash(Buffer.from(row.transcript, 'utf8')) === row.transcriptSha256, 'Transcript SHA-256 mismatch');
    const textFile = await reader.file(`${path.posix.dirname(relative)}/transcript.txt`, area);
    const transcriptFileText = textFile.bytes.toString('utf8').replace(/\r?\n$/, '');
    check(transcriptFileText === row.transcript && hash(Buffer.from(transcriptFileText, 'utf8')) === row.transcriptSha256, 'Transcript file differs from exact native text');
    const wave = await reader.checked(relative, row.sha256, area, WAV_LIMIT);
    const pcm = pcmInfo(wave.bytes);
    const quality = receipt.provenance?.quality;
    check(quality?.originalPcm === true && quality.sha256 === wave.sha256 && ['channels', 'sampleRate', 'bitsPerSample', 'frames'].every(key => quality[key] === pcm[key]), 'Original PCM receipt mismatch');
    const source = await validateSource(reader, receipt, rosterHash, character);
    Object.assign(result, { reference: relative, playback: playbackHref(relative, outputRelative), transcript: row.transcript, sha256: wave.sha256, transcriptSha256: row.transcriptSha256, receiptSha256: receiptFile.sha256, stringId: row.stringId, pcm, source, sourceVerified: true });
    // This builder has no mechanism to upgrade an unapproved listening verdict.
    result.listeningStatus = receipt.listeningVerified === true ? 'Declared by prior review; aggregate does not promote' : 'Pending original-audio listening';
  } catch (error) { result.errors.push(error.message); }
  return result;
}

function proposalEntries(json) {
  const rows = [];
  for (const field of ['characters', 'profiles', 'speakers', 'availability', 'selections', 'references', 'candidates']) {
    if (Array.isArray(json[field])) rows.push(...json[field]);
  }
  return rows;
}

function collectProposal(row, profile) {
  if (!row || row.key !== profile.key) return;
  const add = (value, role) => {
    if (!value) return;
    const object = typeof value === 'string' ? { reference: value } : value;
    const id = object.stringId ?? object.sourceStringId;
    const matches = profile.candidates.filter(candidate => candidate.sourceVerified && (object.reference ? candidate.reference === slash(object.reference) : id ? candidate.stringId === String(id) : false));
    if (matches.length !== 1) return;
    const candidate = matches[0];
    if (candidate.role === 'candidate') candidate.role = role;
    if (!profile.provisional[role]) profile.provisional[role] = candidate.reference;
  };
  for (const [field, role] of Object.entries({ primary: 'primary', alternate: 'alternate', primaryCandidate: 'primary', alternateCandidate: 'alternate', proposedPrimary: 'primary', proposedAlternate: 'alternate' })) add(row[field], role);
  add(row.provisionalPrimaryId && { stringId: row.provisionalPrimaryId }, 'primary');
  add(row.provisionalAlternateId && { stringId: row.provisionalAlternateId }, 'alternate');
  const roleOf = item => /alternate|\balt\b/.test(item.proposedRole ?? item.provisionalRole ?? item.selectionHint ?? item.role ?? '') ? 'alternate' : /primary/.test(item.proposedRole ?? item.provisionalRole ?? item.selectionHint ?? item.role ?? '') ? 'primary' : null;
  const role = roleOf(row);
  if (role) add(row, role);
  if (Array.isArray(row.references)) for (const item of row.references) { const role = roleOf(item); if (role) add(item, role); }
  if (!profile.candidates.some(candidate => candidate.sourceVerified) && boundedText(row.reason, 1500)) profile.gapReason = row.reason;
}

async function acceptedReference(reader, character, outputRelative, config) {
  const result = { key: character.key, reference: null, playback: null, role: 'accepted existing', sourceVerified: false, listeningVerified: false, approved: false, errors: [] };
  try {
    const original = character.acceptedConfiguration;
    const selected = config === undefined ? original : config?.voices?.[character.key];
    check(original && selected?.reference === original.reference && selected.sha256 === original.sha256 && selected.transcript === original.transcript, 'Accepted reference configuration changed; preserve existing descriptor');
    check(boundedText(selected.transcript) && selected.transcript.length > 0, 'Accepted reference transcript invalid');
    const wave = await reader.checked(selected.reference, selected.sha256, 'runtime/voice-references', WAV_LIMIT);
    Object.assign(result, { reference: selected.reference, playback: playbackHref(selected.reference, outputRelative), transcript: selected.transcript, sha256: wave.sha256, transcriptSha256: hash(Buffer.from(selected.transcript)), pcm: pcmInfo(wave.bytes), acceptedReference: true, listeningStatus: 'Previously accepted by user; unchanged reference', source: { verification: 'Existing accepted WAV hash and descriptor rechecked; fresh wider-cast source attribution is not claimed.', processing: 'Existing accepted reference preserved' } });
  } catch (error) { result.errors.push(error.message); }
  return result;
}

/** Match Generate-VoiceCastAuditions.py without treating selection as approval. */
function chosenReference(profile) {
  const accepted = profile.candidates.filter(candidate => candidate.acceptedReference && candidate.playback && !candidate.errors.length);
  if (profile.status === 'accepted') { check(accepted.length === 1, 'Accepted audition reference is ambiguous'); return accepted[0]; }
  const candidates = profile.candidates.filter(candidate => candidate.sourceVerified && candidate.playback && !candidate.errors.length);
  check(candidates.length > 0 && candidates.length <= 6, 'No bounded source-qualified original reference');
  if (profile.provisional.primary) {
    const matches = candidates.filter(candidate => candidate.reference === profile.provisional.primary);
    check(matches.length === 1, 'Current provisional primary is not an exact source-qualified reference');
    return matches[0];
  }
  return [...candidates].sort((left, right) => Math.abs(left.pcm.durationSeconds - 6) - Math.abs(right.pcm.durationSeconds - 6) || (left.reference < right.reference ? -1 : left.reference > right.reference ? 1 : 0))[0];
}

async function addGeneratedAuditions(reader, profiles, requestedRun, outputRelative, identityFingerprint, warnings) {
  const requested = requestedRun !== undefined;
  const run = relativeName(requestedRun ?? DEFAULT_AUDITIONS);
  check(/^runtime\/voice-cast\/auditions\/[a-z0-9]+(?:-[a-z0-9]+)*\/results\.json$/.test(run), 'Audition input must be one exact results.json in a contained named run');
  const directory = path.posix.dirname(run);
  const summary = { status: 'missing', results: run, verifiedSamples: 0, quarantinedSamples: 0, generatedWavBytes: 0, sourceQualified: false, listeningVerified: false, approved: false, benchmark: false, warning: 'Source-qualified audition only; listening pending, not a benchmark, no runtime promotion.' };
  let file;
  try {
    file = await reader.optional(run, directory);
    if (!file) { if (requested) warnings.push({ lane: 'auditions', issue: 'Requested audition run is missing; no generated links emitted.' }); return summary; }
    const report = file.json;
    check(report.version === 1 && report.kind === 'generated-voice-auditions' && report.state === 'complete' && report.workerExited === true, 'Audition run is incomplete or worker exit is unconfirmed');
    check(report.sampleText === AUDITION_TEXT && [16, 32].includes(report.steps) && report.listeningVerified === false && report.approved === false, 'Audition run text, quality setting or approval boundary mismatch');
    check(report.identitySha256 === undefined || report.identitySha256 === identityFingerprint, 'Audition canonical identity fingerprint mismatch');
    check(Array.isArray(report.renders) && report.renders.length > 0 && report.renders.length <= profiles.length, 'Invalid bounded audition render list');
    const seen = new Set();
    for (const row of report.renders) { check(KEY.test(row?.key ?? '') && !seen.has(row.key), 'Invalid or duplicate audition profile key'); seen.add(row.key); }
    summary.status = 'complete'; summary.resultsSha256 = file.sha256;
    summary.sampleText = report.sampleText; summary.steps = report.steps;
    for (const row of report.renders) {
      const comparison = { sourceQualified: false, listeningVerified: false, approved: false, benchmark: false, playback: null, errors: [] };
      const profile = profiles.find(profile => profile.key === row.key);
      try {
        check(profile, 'Generated sample key is not a currently registered character');
        check(row.status === 'generated' && row.listeningVerified === false && row.approved === false, 'Generated sample is failed, partial or falsely approved');
        check(row.sample === `${row.key}.wav`, 'Generated sample filename does not match the run/profile');
        const chosen = chosenReference(profile);
        check(row.referenceSha256 === chosen.sha256 && row.transcriptSha256 === chosen.transcriptSha256, 'Generated comparison reference or transcript hash differs from the current chosen original');
        const reference = `${directory}/${relativeName(row.sample)}`;
        const wave = await reader.checked(reference, row.sha256, directory, WAV_LIMIT);
        const pcm = pcmInfo(wave.bytes);
        check(Number.isFinite(row.durationSeconds) && Math.abs(row.durationSeconds - pcm.durationSeconds) <= 1e-6, 'Generated sample duration receipt differs from actual PCM');
        Object.assign(comparison, { key: row.key, reference, sha256: wave.sha256, playback: playbackHref(reference, outputRelative), pcm, sourceReference: chosen.reference, referenceSha256: chosen.sha256, transcriptSha256: chosen.transcriptSha256, sampleText: report.sampleText, steps: report.steps, sourceQualified: true });
        summary.verifiedSamples++; summary.generatedWavBytes += pcm.bytes;
      } catch (error) { comparison.errors.push(error.message); summary.quarantinedSamples++; }
      if (profile) profile.generatedComparison = comparison;
      else warnings.push({ lane: 'auditions', issue: 'A generated sample had an unknown registered key; playback withheld.' });
    }
    summary.sourceQualified = summary.verifiedSamples > 0;
  } catch (error) {
    summary.status = 'invalid'; summary.quarantinedSamples = file?.json?.renders?.length ?? 0;
    warnings.push({ lane: 'auditions', issue: `${error.message}; no generated links emitted.` });
  }
  return summary;
}

export async function buildVoiceCastReview({ projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), inventoryDirectory = DEFAULT_INVENTORY, outputDirectory = 'runtime/voice-cast/review', auditionRun, now = new Date().toISOString() } = {}) {
  const root = await fs.realpath(projectRoot);
  const reader = new SnapshotReader(root);
  const inventoryArea = relativeName(inventoryDirectory);
  const outputRelative = relativeName(outputDirectory);
  check(outputRelative === 'runtime/voice-cast/review', 'Aggregate output must remain in its owned review directory');
  const rosterFile = await reader.json(`${inventoryArea}/cast-roster-inventory.json`, inventoryArea);
  const lanesFile = await reader.json(`${inventoryArea}/casting-lanes.json`, inventoryArea);
  const roster = rosterFile.json; const lanes = lanesFile.json;
  const rosterHash = roster.summary?.rosterSha256;
  check(SHA256.test(rosterHash ?? '') && Array.isArray(roster.characters) && roster.characters.length > 0 && roster.characters.length <= 1000, 'Invalid canonical roster');
  const currentRosterFile = await reader.json('characters/roster.json', 'characters');
  const historicalIdentities = identityProjection(roster.characters);
  const currentIdentities = identityProjection(currentRosterFile.json);
  check(same(historicalIdentities, currentIdentities), 'Inventory canonical identity differs from the current production roster');
  const identityFingerprint = identitySha256(currentRosterFile.json);
  check(roster.summary.identitySha256 === undefined || roster.summary.identitySha256 === identityFingerprint, 'Inventory canonical identity fingerprint mismatch');
  const rosterValidation = { identityProjectionVersion: 1, identitySha256: identityFingerprint, historicalRosterSha256: rosterHash, currentRosterSha256: currentRosterFile.sha256, fullRosterHashChanged: rosterHash !== currentRosterFile.sha256, canonicalIdentityVerified: true };
  check(Array.isArray(lanes.lanes) && lanes.profiles === roster.characters.length && roster.summary.profiles === lanes.profiles, 'Roster/lane count mismatch');
  const byKey = new Map(); const laneByKey = new Map(); const seenLanes = new Set();
  for (const character of roster.characters) {
    check(KEY.test(character.key ?? '') && character.key.length <= 128 && !byKey.has(character.key) && boundedText(character.name, 200), 'Invalid or duplicate roster profile');
    byKey.set(character.key, character);
  }
  for (const lane of lanes.lanes) {
    check(KEY.test(lane.name ?? '') && !seenLanes.has(lane.name) && Array.isArray(lane.keys), 'Invalid or duplicate lane');
    seenLanes.add(lane.name);
    check(lane.researchOutput === `runtime/voice-cast/${lane.name}`, 'Lane output path mismatch');
    for (const key of lane.keys) { check(byKey.has(key) && !laneByKey.has(key), 'Unknown or duplicate lane profile'); laneByKey.set(key, lane.name); }
  }
  check(laneByKey.size === byKey.size, 'Every roster profile needs exactly one lane');
  const warnings = []; const profiles = [];
  const configFile = await reader.optional('runtime/local-voices.json', 'runtime');
  // Only the three accepted descriptors are ever copied from this config.
  const config = configFile?.json;
  for (const lane of lanes.lanes) {
    let manifest;
    try {
      const item = await reader.optional(`${lane.researchOutput}/manifest.json`, lane.researchOutput);
      if (item) {
        check(item.json.lane === lane.name && item.json.rosterSha256 === rosterHash && Array.isArray(item.json.candidates), 'Lane manifest identity mismatch');
        check(item.json.identitySha256 === undefined || item.json.identitySha256 === identityFingerprint, 'Lane canonical identity fingerprint mismatch');
        check(item.json.historicalRosterSha256 === undefined || item.json.historicalRosterSha256 === rosterHash, 'Lane historical roster fingerprint mismatch');
        check(item.json.candidates.every(row => lane.keys.includes(row.key)), 'Lane manifest contains foreign profiles');
        manifest = item.json;
      }
    } catch (error) { warnings.push({ lane: lane.name, issue: error.message }); }
    const proposals = [];
    for (const name of PROPOSAL_NAMES) {
      try { const item = await reader.optional(`${lane.researchOutput}/${name}`, lane.researchOutput); if (item) proposals.push(...proposalEntries(item.json)); }
      catch (error) { warnings.push({ lane: lane.name, issue: `${name}: ${error.message}` }); }
    }
    for (const key of lane.keys) {
      const character = byKey.get(key);
      const profile = { key, name: character.name, lane: lane.name, status: 'unprepared', gapReason: 'No attributed decoded original reference has been completed yet.', provisional: {}, candidates: [] };
      if (lane.name === 'accepted-existing' && ACCEPTED_KEYS.has(key)) {
        const candidate = await acceptedReference(reader, character, outputRelative, config);
        profile.candidates.push(candidate);
        profile.status = candidate.acceptedReference ? 'accepted' : 'unprepared';
        profile.gapReason = candidate.acceptedReference ? null : 'Accepted reference failed preservation checks; do not replace it.';
      } else {
        const rows = manifest?.candidates.filter(row => row.key === key) ?? [];
        const unique = new Map();
        for (const row of rows) {
          const identity = `${row.reference}\0${row.sha256}`;
          if (!unique.has(identity)) unique.set(identity, row);
        }
        if (unique.size > 6) { warnings.push({ lane: lane.name, issue: `${key}: more than six candidate references; lane snapshot quarantined for this profile` }); }
        else for (const row of unique.values()) profile.candidates.push(await verifyCandidate(reader, row, lane.name, rosterHash, outputRelative, character));
        if (profile.candidates.some(candidate => candidate.sourceVerified)) { profile.status = 'listening_pending'; profile.gapReason = null; }
        if (key === 'resident-male' || key === 'resident-female') { profile.status = 'unavailable'; profile.gapReason = 'Crowd template has no unique canonical named voice. Keep Convai until an explicit generic voice policy exists.'; }
        for (const row of proposals) collectProposal(row, profile);
      }
      profiles.push(profile);
    }
  }
  const auditionSummary = await addGeneratedAuditions(reader, profiles, auditionRun, outputRelative, identityFingerprint, warnings);
  for (const changed of await reader.unchanged()) warnings.push({ lane: changed.split('/')[2], issue: 'Lane progress updated during capture; this report uses the captured version. Rerun to include its newest candidates.' });
  const candidates = profiles.flatMap(profile => profile.candidates);
  const counts = { profiles: profiles.length, lanes: lanes.lanes.length, acceptedProfiles: profiles.filter(profile => profile.status === 'accepted').length, profilesWithVerifiedCandidates: profiles.filter(profile => profile.status === 'listening_pending').length, verifiedOriginalCandidates: candidates.filter(candidate => candidate.sourceVerified).length, playableOriginalReferences: candidates.filter(candidate => candidate.playback).length, quarantinedCandidates: candidates.filter(candidate => candidate.errors.length).length, unpreparedProfiles: profiles.filter(profile => profile.status === 'unprepared').length, unavailableProfiles: profiles.filter(profile => profile.status === 'unavailable').length, newProfilesPromoted: 0, newListeningApprovals: 0, generatedComparisonSamples: auditionSummary.verifiedSamples, quarantinedGeneratedSamples: auditionSummary.quarantinedSamples, generatedWavBytes: auditionSummary.generatedWavBytes, originalWavBytes: candidates.filter(candidate => candidate.playback).reduce((total, candidate) => total + candidate.pcm.bytes, 0) };
  const inventory = { schemaVersion: 1, generatedAt: now, scope: 'Current registered character profiles; original game recordings and optional existing generated comparisons for offline audition. This builder performs no synthesis, training, configuration changes or new listening approvals.', sharedModel: { name: 'OmniVoice', modelsPerCharacter: 0, sharedModelInstances: 1, conditioning: 'One short attributed recording and exact transcript per character; bounded cache, not separate neural weights.' }, rosterSha256: rosterHash, rosterSha256Meaning: 'Historical full roster fingerprint retained by source collection receipts; use currentRosterSha256 for the current source file.', ...rosterValidation, counts, auditions: auditionSummary, verificationBoundary: 'The aggregate rechecks local immutable receipt/source/WAV hashes and native line joins. A decoded waveform or clean metadata is not a listening verdict. Source archive receipts originate in the bounded casting extractor; this report does not re-extract archives.', warnings, profiles, inputSnapshots: [...reader.snapshots.values()].map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) };
  return { inventory, html: renderHtml(inventory), markdown: renderMarkdown(inventory) };
}

export function renderHtml(inventory) {
  const { counts } = inventory;
  const statuses = { accepted: 'Accepted existing reference', listening_pending: 'Original audio ready for listening', unprepared: 'Unprepared — Convai fallback', unavailable: 'No unique canonical voice — Convai fallback' };
  const original = candidate => candidate.playback ? `<audio controls preload="none" src="${escapeHtml(candidate.playback)}"></audio><p class="transcript">${escapeHtml(candidate.transcript)}</p><p class="meta">${candidate.pcm.durationSeconds.toFixed(3)} s · ${candidate.pcm.sampleRate} Hz · ${candidate.pcm.channels} channel${candidate.pcm.channels === 1 ? '' : 's'} · original 16-bit PCM<br>${escapeHtml(candidate.listeningStatus)}<br>${escapeHtml(candidate.source.verification)}</p>${candidate.source.scene ? `<details><summary>Source and hash</summary><p>${escapeHtml(candidate.source.actor)} · ${escapeHtml(candidate.source.gameVersion)} · ${escapeHtml(candidate.source.locale)}</p><p>${escapeHtml(candidate.source.scene)}</p><p>${escapeHtml(candidate.source.audio)}</p><code>${escapeHtml(candidate.sha256)}</code></details>` : ''}` : `<p class="warning">Playback withheld: ${escapeHtml(candidate.errors.join('; '))}</p>`;
  const cards = inventory.profiles.map(profile => {
    const comparison = profile.generatedComparison;
    let comparisonHtml = ''; let comparedReference;
    if (comparison?.playback) {
      comparedReference = comparison.sourceReference;
      const source = profile.candidates.find(candidate => candidate.reference === comparedReference);
      comparisonHtml = `<article class="comparison"><div><h3>Original reference used for this audition</h3>${original(source)}</div><div><h3>Generated OmniVoice comparison</h3><audio controls preload="none" src="${escapeHtml(comparison.playback)}"></audio><p class="transcript">${escapeHtml(comparison.sampleText)}</p><p class="meta">${comparison.pcm.durationSeconds.toFixed(3)} s · ${comparison.pcm.sampleRate} Hz · ${comparison.steps} steps<br>Source-qualified audition; listening pending.<br>Not a benchmark. No approval or runtime promotion.</p><details><summary>Generated sample hash</summary><code>${escapeHtml(comparison.sha256)}</code></details></div></article>`;
    } else if (comparison) comparisonHtml = `<article><h3>Generated comparison unavailable</h3><p class="warning">Playback withheld: ${escapeHtml(comparison.errors.join('; '))}</p></article>`;
    const candidates = profile.candidates.filter(candidate => candidate.reference !== comparedReference).map(candidate => `<article><h3>${escapeHtml(candidate.role === 'candidate' ? 'Additional candidate' : candidate.role === 'accepted existing' ? 'Accepted existing' : `Provisional ${candidate.role}`)}</h3>${original(candidate)}</article>`).join('');
    return `<section class="profile" id="${escapeHtml(profile.key)}"><h2>${escapeHtml(profile.name)}</h2><p class="meta">${escapeHtml(profile.lane)} · ${escapeHtml(statuses[profile.status])}</p>${profile.gapReason ? `<p>${escapeHtml(profile.gapReason)}</p>` : ''}${comparisonHtml}${candidates}</section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; media-src 'self' file:; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Cyberpunk original voice reference review</title><style>
:root { color-scheme: dark; font-family: system-ui,sans-serif; background:#101217; color:#e9edf3; } body { max-width:1050px; margin:auto; padding:32px 22px; line-height:1.55; } h1 { margin-bottom:6px; } h2 { font-size:1.35rem; margin:0; } h3 { font-size:1rem; } a { color:#8dd7ef; } .meta { color:#adb8c9; font-size:.88rem; } .summary { background:#1c2330; padding:20px; border-radius:10px; } .toc { display:flex; flex-wrap:wrap; gap:6px 18px; margin:24px 0; } .profile { margin:24px 0; padding:22px; background:#171b23; border:1px solid #343d4d; border-radius:10px; } article { border-top:1px solid #343d4d; margin-top:15px; padding-top:4px; } audio { width:min(100%,580px); } .transcript { font-size:1.08rem; max-width:820px; } details p,code { overflow-wrap:anywhere; } .warning { color:#ffd195; } footer { margin-top:32px; } .comparison { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:28px; } @media(max-width:700px) { .comparison { grid-template-columns:1fr; } }
</style></head><body><h1>Character voice reference comparisons</h1><p class="meta">Snapshot ${escapeHtml(inventory.generatedAt)} · ${counts.profiles} registered profiles · ${counts.lanes} lanes</p><div class="summary"><strong>${counts.acceptedProfiles} accepted references preserved. ${counts.profilesWithVerifiedCandidates} additional characters have ${counts.verifiedOriginalCandidates} verified original clips.</strong><p>${counts.generatedComparisonSamples ?? 0} verified generated comparisons are paired with their source references. Source-qualified auditions, listening pending; not benchmark results and no runtime promotion.</p><p>${counts.unpreparedProfiles} unprepared and ${counts.unavailableProfiles} unavailable profiles keep Convai. ${counts.quarantinedCandidates} originals and ${counts.quarantinedGeneratedSamples ?? 0} comparisons have playback withheld.</p><p>One shared OmniVoice model; each voice is a short recording plus transcript and cached conditioning. Original players contain unchanged game audio; generated players are clearly labeled. Provisional primary/alternate choices are suggestions to audition, not promoted runtime voices.</p><p>Listen for identity, clarity, background voices, complete words and the intended performance. Metadata and a waveform cannot establish those qualities. No new listening approval is inferred here.</p></div><nav class="toc" aria-label="Characters">${inventory.profiles.map(profile => `<a href="#${escapeHtml(profile.key)}">${escapeHtml(profile.name)}</a>`).join('')}</nav>${inventory.warnings.length ? `<details><summary>Snapshot warnings (${inventory.warnings.length})</summary><ul>${inventory.warnings.map(warning => `<li>${escapeHtml(warning.lane)}: ${escapeHtml(warning.issue)}</li>`).join('')}</ul></details>` : ''}${cards}<footer><p>${escapeHtml(inventory.verificationBoundary)}</p><p>This audition file does not alter the game, voice settings or conversation memory. Rebuild with <code>node scripts/Build-VoiceCastReview.mjs</code> after casting lanes finish.</p></footer></body></html>`;
}

export function renderMarkdown(inventory) {
  const c = inventory.counts;
  const rows = [...new Set(inventory.profiles.map(profile => profile.lane))].map(lane => {
    const profiles = inventory.profiles.filter(profile => profile.lane === lane);
    return `| ${lane} | ${profiles.length} | ${profiles.filter(p => p.status === 'accepted').length} | ${profiles.filter(p => p.status === 'listening_pending').length} | ${profiles.flatMap(p => p.candidates).filter(candidate => candidate.sourceVerified).length} | ${profiles.filter(p => p.generatedComparison?.playback).length} | ${profiles.filter(p => p.status === 'unprepared').length} | ${profiles.filter(p => p.status === 'unavailable').length} |`;
  });
  const gaps = inventory.profiles.filter(profile => ['unprepared', 'unavailable'].includes(profile.status)).map(profile => `- **${escapeMarkdown(profile.name)}** (${profile.key}): ${escapeMarkdown(profile.gapReason)}`);
  return `# Wider-cast voice preparation status

Generated from current local lane receipts at ${inventory.generatedAt}. Rebuild with
\`node scripts/Build-VoiceCastReview.mjs\`; this document is a snapshot, not a
declaration that incomplete casting work is finished.
An existing generated run can be selected explicitly with
\`--auditions runtime/voice-cast/auditions/<run-name>/results.json\`.
The default local October 1 run is optional; a checkout without it still builds
the original-reference review.

## Current evidence

- ${c.profiles} registered profiles across ${c.lanes} lanes.
- ${c.acceptedProfiles} accepted Johnny/Judy/Panam references preserved and hash-checked.
- ${c.profilesWithVerifiedCandidates} additional profiles have ${c.verifiedOriginalCandidates} attributed, decoded original clips available for listening.
- ${c.unpreparedProfiles} unprepared profiles and ${c.unavailableProfiles} profiles without a unique canonical cast voice retain Convai.
- ${c.quarantinedCandidates} candidates failed aggregate verification; their playback links are withheld.
- ${c.generatedComparisonSamples} generated comparison samples match their current chosen original reference and exact transcript hashes. ${c.quarantinedGeneratedSamples} comparison links are withheld.
- ${c.newListeningApprovals} new listening approvals and ${c.newProfilesPromoted} new runtime promotions were made by the aggregate.
- Playable original WAVs total ${(c.originalWavBytes / 1024 / 1024).toFixed(2)} MiB. This is candidate audition storage, not a per-character model size.
- Verified generated audition WAVs total ${(c.generatedWavBytes / 1024 / 1024).toFixed(2)} MiB.

| Lane | Profiles | Accepted | With verified candidates | Original clips | Generated comparisons | Unprepared | Unavailable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join('\n')}

## Audition artifact and verification

Open [the offline audition index](../runtime/voice-cast/review/index.html).
The companion [machine-readable inventory](../runtime/voice-cast/review/inventory.json)
lists all current profiles, exact transcripts, verified WAV format/duration,
source receipts, provisional primary/alternate selections and explicit gaps.
Generated comparisons are paired beside their chosen originals, clearly labeled
as source-qualified auditions with listening pending. These are not benchmark
results, listening acceptance or runtime promotions. Generation timing fields are
intentionally excluded from this comparison report.
Both artifacts are ignored local research outputs; this tracked document contains
only preparation status.

Identity projection v${inventory.identityProjectionVersion} preserves exact keys,
names, aliases and native record strings. Biography or speaking-style edits may
change the complete roster file without changing speaker identity. The historical
collection fingerprint is retained separately from the current source fingerprint:

- Historical roster SHA-256: \`${inventory.historicalRosterSha256}\`
- Current roster SHA-256: \`${inventory.currentRosterSha256}\`
- Canonical identity SHA-256: \`${inventory.identitySha256}\`
- Full source changed: ${inventory.fullRosterHashChanged ? 'yes; canonical identity remains exactly verified' : 'no'}.

${inventory.verificationBoundary}

The original PCM is linked without gain, EQ, denoising, resampling, trimming or
concatenation. No synthesis, GPU job, cloud call, game/save change or configuration
write is performed by the aggregate. A candidate remains pending until an actual
audible review qualifies intelligibility, identity, overlap and delivery. This is
not an approval gate for unrelated knowledge or runtime work.

## Shared model and remaining work

All characters use one pinned OmniVoice model. A profile contributes a short
attributed reference, its exact text and bounded cached conditioning; it does not
add a separately trained model. The three accepted references are preserved.

1. Finish missing native identity/acquisition joins and targeted scene discovery.
2. Listen to original primary/alternate candidates; choose canonical clean speech
   or explicitly documented canonical processed speech (for example, Smasher).
3. Promote only qualified immutable reference descriptors through the coordinator's
   registry; preserve Convai fallback for unprepared/unavailable profiles.
4. Listen to the existing generated comparisons, then perform any additional
   bounded conditioning checks through the single shared worker, without writing
   synthetic dialogue into conversation memory.
5. Rebuild this report after any lane or selection changes.

## Current gaps

${gaps.length ? gaps.join('\n') : 'No source preparation gaps remain; audible review and controlled promotion still remain.'}
${inventory.warnings.length ? `\n## Snapshot warnings\n\n${inventory.warnings.map(w => `- ${escapeMarkdown(w.lane)}: ${escapeMarkdown(w.issue)}`).join('\n')}\n` : ''}`;
}

async function atomicWrite(target, contents) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, contents, { flag: 'wx' }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function writeVoiceCastReview(options = {}) {
  const projectRoot = await fs.realpath(options.projectRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const output = path.join(projectRoot, 'runtime', 'voice-cast', 'review');
  const docs = path.join(projectRoot, 'docs');
  for (const directory of [output, docs]) {
    // Validate/create one component at a time. Recursive mkdir through an
    // existing junction would already have modified an external directory.
    let current = projectRoot;
    for (const component of path.relative(projectRoot, directory).split(path.sep)) {
      current = path.join(current, component);
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      check((await fs.realpath(current)).toLowerCase() === current.toLowerCase() && (await fs.lstat(current)).isDirectory(), 'Linked output directory rejected');
    }
  }
  const result = await buildVoiceCastReview({ ...options, projectRoot });
  await atomicWrite(path.join(output, 'inventory.json'), `${JSON.stringify(result.inventory, null, 2)}\n`);
  await atomicWrite(path.join(output, 'index.html'), result.html);
  await atomicWrite(path.join(docs, 'VOICE_CAST_STATUS.md'), result.markdown);
  return result.inventory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let at = 0; at < args.length; at += 2) {
      const property = { '--project': 'projectRoot', '--auditions': 'auditionRun' }[args[at]];
      check(property && args[at + 1] && !Object.hasOwn(options, property), 'Usage: node scripts/Build-VoiceCastReview.mjs [--project <root>] [--auditions <contained-run/results.json>]');
      options[property] = args[at + 1];
    }
    const inventory = await writeVoiceCastReview(options);
    process.stdout.write(`${JSON.stringify({ counts: inventory.counts, warnings: inventory.warnings.length, index: 'runtime/voice-cast/review/index.html', status: 'docs/VOICE_CAST_STATUS.md' }, null, 2)}\n`);
  } catch (error) { process.stderr.write(`Voice cast review failed: ${error.message}\n`); process.exitCode = 1; }
}
