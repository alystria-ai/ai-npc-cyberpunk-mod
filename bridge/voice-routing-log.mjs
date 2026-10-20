import {appendFile, readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

// One line per spoken reply saying which voice was asked for, which one actually spoke, and why they differ.
// Routing facts only: no conversation text, no session IDs, no audio. The Convai character the turn went to is named
// (provider key and character ID, so a multilingual twin is visible); the support report hashes
// character IDs like every other ID. The line goes to the bridge log and to a
// small rolling file (runtime/voice-routing.log, the last ROUTING_LOG_MAX_LINES lines) that the support report includes.
// `fallback=` names why the cloud voice cannot be asked at all (no key, a limit, a refused key: the Convai cloud voice or a written reply
// speaks, never a local voice); an earlier timeout or network
// failure is `cloudLast=` (a reply is never switched to another voice partway: see docs/CLOUD_VOICE_VOXTRAL.md).
//
//   2026-10-08 14:03:21 profile=resident-male name="NC Resident" requested="Pocket · Performance"
//     used="Convai cloud (Julia (Expressive Young-Adult American Female))" ref=- fallback="no local reference for this profile"
//
// Everything here is cheap: the facts are read from objects the bridge already holds, and the file append is queued off
// the speech path.

export const ROUTING_LOG_NAME = 'voice-routing.log';
export const ROUTING_LOG_MAX_LINES = 500;
const REFERENCE_ROOT = 'runtime/voice-references/';
// The player's own clip for a character (docs/CHARACTER_EDITOR.md): reported as the set `player`, never by its file name or transcript.
const PLAYER_ROOT = 'runtime/player-voices/';
const PLAYER_SET = 'player';

/** The set a reference path belongs to: `player` for the player's own clip, else the folder under runtime/voice-references. */
function setOf(path) {
  if (path.startsWith(PLAYER_ROOT)) return PLAYER_SET;
  const set = path.startsWith(REFERENCE_ROOT) ? path.slice(REFERENCE_ROOT.length).split('/').slice(0, -1).join('/') : '';
  return set || path.split('/').at(-2) || 'reference';
}
// Matches the Settings menu (mod/manager.lua OMNI_LABELS).
const OMNI_TIERS = {'16:short': 'Balanced', '16:long': 'Quality', '32:short': 'High Quality', '32:long': 'Ultra Quality'};

// Matches the Settings menu (mod/manager.lua voiceLabel).
const CLOUD_LABELS = {voxtral: 'Mistral cloud voice (Voxtral)'};
const CLOUD_NAMES = {voxtral: 'Mistral cloud voice'};

/** The voice choice as the player reads it in Settings: "Pocket · Performance", "OmniVoice · Quality", "Convai · Cloud voice". */
export function requestedLabel(provider, steps, reference) {
  if (provider === 'pocket') return 'Pocket · Performance';
  if (provider === 'convai') return 'Convai · Cloud voice';
  return `OmniVoice · ${OMNI_TIERS[`${steps === 32 ? 32 : 16}:${reference === 'short' ? 'short' : 'long'}`]}`;
}

const secondsOf = entry => [entry?.pick?.seconds, entry?.multiref?.seconds, entry?.seconds]
  .find(value => typeof value === 'number' && Number.isFinite(value));

/**
 * The reference a local voice key speaks with: its set (the folder under runtime/voice-references) and, when the
 * voice configuration recorded it, the seconds of audio. `sources` is the raw voice configuration per backend
 * ({pocket, omni: {short, long}}); a missing source only drops the seconds.
 */
export function referenceOf(voice, backend, key, sources = {}) {
  const registry = backend === 'omni' ? voice.omniVariants?.[voice.omniReference]?.registry : voice.registries?.[backend];
  const entry = registry?.profiles?.[key];
  if (!entry?.reference) return null;
  const path = String(entry.reference);
  const raw = backend === 'omni' ? sources.omni?.[voice.omniReference] : sources.pocket;
  const set = setOf(path), seconds = set === PLAYER_SET ? undefined : secondsOf(raw?.voices?.[key]);
  return {set, ...(seconds === undefined ? {} : {seconds})};
}

/**
 * The reference the Mistral cloud voice (Voxtral) clones a voice key from: the first of the OmniVoice long set, the short set and
 * the Pocket set that lists one, as bridge/voxtral-voice.mjs picks it (clips extracted for the character, its last resort, are not
 * listed in any set: null).
 */
export function cloudReferenceOf(voice, key, sources = {}) {
  const sets = [[voice.omniVariants?.long?.registry, sources.omni?.long], [voice.omniVariants?.short?.registry, sources.omni?.short],
    [voice.registries?.pocket, sources.pocket]];
  for (const [registry, raw] of sets) {
    const entry = registry?.profiles?.[key];
    if (!entry?.reference) continue;
    const path = String(entry.reference);
    // A player's own clip has no recorded length here (the entry in `raw` may still be the shipped voice's).
    const set = setOf(path), seconds = set === PLAYER_SET ? undefined : secondsOf(raw?.voices?.[key]);
    return {set, ...(seconds === undefined ? {} : {seconds})};
  }
  return null;
}

/**
 * Why the voice that spoke is not the one chosen in Settings; null when they agree. Pure over the voice selection's
 * state. `plan` is the turn plan (bridge/multilingual.mjs planTurnVoice), `engine` the voice that actually speaks:
 * 'pocket' | 'omni' | 'convai' | 'none' (written reply only). A failed local voice is 'none' with its reason here, never 'convai'.
 */
export function fallbackReason(voice, profile, {plan, engine} = {}) {
  const requested = voice.requestedProvider;
  const multilingualWhy = plan?.reason === 'english-only-voice'
    ? 'Multilingual non-English reply: Pocket speaks English only'
    : plan?.reason === 'voice-language-unsupported' ? 'Multilingual non-English reply: the Voxtral voice does not speak this language' : null;
  // A written reply because the chosen local voice cannot run (or has no clip for this character) is explained by the checks below; any other
  // written reply is a language the chosen voice does not speak.
  if (engine === 'none' && plan?.reason !== 'local-voice-unavailable') return multilingualWhy ?? 'Multilingual non-English reply: this voice speaks English only';
  if (engine === requested) {
    // Same voice, but the tier committed lags the choice (applied at the next conversation boundary).
    if (engine === 'omni' && (voice.omniSteps !== voice.requestedOmniSteps
        || voice.omniReference !== voice.requestedOmniReference)) return 'OmniVoice tier change pending';
    return null;
  }
  if (requested === 'convai') return null;
  if (multilingualWhy) return multilingualWhy;
  if (requested === 'omni') {
    if (voice.omniPack?.installed === false) return 'Omni pack missing';
    // A failed or timed-out Omni is loaded again in the background (VoiceSelection.omniRetry); the speaker is the
    // fallback only until that finishes.
    if (voice.failedBackends?.has('omni')) return voice.omniRetry ? 'Omni still loading (retrying in the background)' : 'Omni worker unavailable';
    if (!voice.omniVariants?.[voice.omniReference]?.configured) return 'Omni not configured';
  }
  if (voice.failedBackends?.has(requested)) {
    // A failed Pocket is loaded again by the poll (VoiceSelection.pocketRetry) until it gives up.
    if (requested === 'pocket' && voice.pocketRetry) return 'Pocket still loading (retrying in the background)';
    return `${requested === 'omni' ? 'Omni' : 'Pocket'} worker unavailable`;
  }
  // The chosen backend is not the one routing (the change is waiting for a quiet moment, or it was never set up).
  if (voice.provider !== voice.resolvedProvider) return 'voice change pending';
  if (!voice.configuredByBackend?.[requested]) return `${requested === 'omni' ? 'Omni' : 'Pocket'} not configured`;
  const status = voice.registries?.[requested]?.status?.(profile);
  if (status === 'unprepared' || status === 'missing') return 'no local reference for this profile';
  if (status === 'unavailable') return 'local reference unavailable for this profile';
  if (status === 'ready') return 'local reference not verified by the worker';
  return 'local voice cannot serve this profile';
}

const text = value => String(value ?? '').replace(/[\u0000-\u001f\u007f"]/g, ' ').replace(/\s+/g, ' ').trim();
const quote = value => `"${text(value)}"`;

/**
 * Builds the facts of one reply's routing. No dialogue text.
 *   voice: the VoiceSelection; input/profile: the turn and its roster entry;
 *   plan: the turn plan; reply: {engine, language}; voiceKey: the local voice that speaks (a variant key or the profile);
 *   sources: raw voice configurations (for reference seconds); lipText: true/false when known, else undefined;
 *   reason: a fallback reason the caller knows better than the routing state (a worker error mid-reply).
 */
export function describeVoiceRoute({voice, input, profile, plan, reply, voiceKey, sources, lipText, reason, character,
  now = Date.now}) {
  const engine = reply?.engine ?? plan?.engine ?? 'convai';
  const key = input?.profileKey ?? profile?.key ?? '?';
  const local = engine === 'pocket' || engine === 'omni';
  // The cloud voice (Voxtral) uses Pocket's route and packet format but no local model: chosen, it is what the player asked
  // for and it speaks. With no key the turn goes to the Convai cloud voice (engine 'convai'); in a limit or refused-key cool-down the
  // reply is written only (no local voice stands in), and the reason is logged.
  const cloud = voice.cloudActive === true && voice.requestedProvider === 'pocket';
  // Only a state that stops the cloud voice from being asked at all (no key, a limit, a refused key) is a reason here: the line
  // is written before the reply is voiced, so a timeout on the previous reply would be a stale claim (`cloudLast` carries it instead).
  const cloudWhy = cloud && (engine === 'pocket' || engine === 'convai') ? ('cloudBlocked' in voice ? voice.cloudBlocked : voice.cloudFallback) : null;
  const cloudLast = cloud && engine === 'pocket' && !cloudWhy ? voice.cloudLast ?? null : null;
  const cloudKind = 'voxtral', CLOUD_LABEL = CLOUD_LABELS[cloudKind];
  const record = {time: now(), profile: key, name: profile?.name ?? input?.name ?? '?',
    requested: cloud ? CLOUD_LABEL : requestedLabel(voice.requestedProvider, voice.requestedOmniSteps, voice.requestedOmniReference),
    engine, voiceKey: local ? (voiceKey ?? key) : undefined,
    // The cloud voice clones from its own pick of the reference sets, not from the Pocket one whose route it uses.
    reference: !local ? null : cloud && engine === 'pocket' ? (cloudWhy ? null : cloudReferenceOf(voice, voiceKey ?? key, sources))
      : referenceOf(voice, engine, voiceKey ?? key, sources),
    fallback: reason ?? (cloudWhy ? `${CLOUD_NAMES[cloudKind]} ${cloudWhy.reason === 'no-key' ? 'has no key' : 'fell back (' + cloudWhy.reason + ')'}` : null)
      ?? fallbackReason(voice, key, {plan, engine})};
  if (cloudLast) record.cloudLast = cloudLast;
  if (engine === 'omni') record.used = `OmniVoice ${voice.omniSteps} ${voice.omniReference}`;
  else if (engine === 'pocket') record.used = cloud ? (cloudWhy ? 'none (written reply only)' : CLOUD_LABEL) : 'Pocket';
  else if (engine === 'none') record.used = 'none (written reply only)';
  else record.used = `Convai cloud (${profile?.voiceName ?? 'character voice'})`;
  // The language of a reply that is not English (an English turn adds nothing to the line).
  const language = reply?.language ?? plan?.language;
  if (language && language !== 'en') record.language = language;
  if (typeof lipText === 'boolean') record.lipText = lipText;
  if (character?.id) record.character = {key: character.key, id: character.id};
  return record;
}

const pad = number => String(number).padStart(2, '0');
function stamp(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One line, key=value, fixed order. */
export function formatVoiceRoute(record) {
  const voiceKey = record.voiceKey && record.voiceKey !== record.profile ? ` voice=${record.voiceKey}` : '';
  const reference = record.reference
    ? `${record.reference.set}${record.reference.seconds === undefined ? '' : ` ${record.reference.seconds}s`}` : '-';
  const parts = [stamp(record.time), `profile=${record.profile}${voiceKey}`, `name=${quote(record.name)}`,
    `requested=${quote(record.requested)}`, `used=${quote(record.used)}`, `ref=${record.reference ? quote(reference) : '-'}`];
  if (record.character) parts.push(`character=${text(record.character.key) || '-'}`, `characterId=${text(record.character.id)}`);
  if (record.language !== undefined) parts.push(`lang=${text(record.language) || '-'}`);
  if (record.lipText !== undefined) parts.push(`lipText=${record.lipText ? 'yes' : 'no'}`);
  if (record.fallback) parts.push(`fallback=${quote(record.fallback)}`);
  if (record.cloudLast) parts.push(`cloudLast=${text(record.cloudLast)}`);
  return parts.join(' ');
}

/**
 * Appends lines to a rolling file and echoes them to a logger. Writes are queued, never awaited by the caller, and
 * never throw; the file is cut back to the last `maxLines` lines every so often rather than on every append.
 */
export class VoiceRoutingLog {
  constructor({path, maxLines = ROUTING_LOG_MAX_LINES, echo = line => process.stderr.write(`[VoiceRouting] ${line}\n`)} = {}) {
    this.path = path; this.maxLines = maxLines; this.echo = echo;
    this.queue = Promise.resolve(); this.count = null;
  }
  record(record) {
    const line = formatVoiceRoute(record);
    try { this.echo?.(line); } catch {}
    this.queue = this.queue.catch(() => {}).then(() => this.append(line)).catch(() => {});
    return line;
  }
  async append(line) {
    if (!this.path) return;
    await mkdir(dirname(this.path), {recursive: true});
    if (this.count === null) {
      this.count = (await readFile(this.path, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    }
    await appendFile(this.path, `${line}\n`, 'utf8');
    this.count++;
    // Trim in batches: 10% over the limit costs one rewrite per ~50 replies.
    if (this.count > this.maxLines + Math.ceil(this.maxLines / 10)) {
      const lines = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean).slice(-this.maxLines);
      await writeFile(this.path, `${lines.join('\n')}\n`, 'utf8');
      this.count = lines.length;
    }
  }
  /** Resolves when everything queued so far is on disk (tests, shutdown). */
  flush() { return this.queue; }
}
