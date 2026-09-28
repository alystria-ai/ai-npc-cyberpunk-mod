// VoiceStudio is a separate local speech service. Convai remains the dialogue
// provider; a missing clone must never silently select another person's voice.
import {inspectWav} from './speech-audio.mjs';

const MAX_AUDIO_BYTES = 24_000_000;
const cancelled = signal => signal?.throwIfAborted();

export function validateVoiceStudioConfig(value = {}) {
  if (!['convai', 'voicestudio'].includes(value.provider || 'convai')) throw Error('Unknown speech provider');
  const url = new URL(value.baseUrl || 'http://127.0.0.1:3900');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('VoiceStudio must use a local loopback HTTP address');
  }
  const profiles = value.profiles || {};
  for (const [key, profile] of Object.entries(profiles)) {
    if (!/^[a-z0-9-]+$/.test(key) || !profile || typeof profile.id !== 'string'
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id)) throw Error('Invalid local voice profile mapping');
  }
  const timeoutMs = value.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw Error('Invalid speech timeout');
  const steps = value.steps ?? 32;
  if (!Number.isInteger(steps) || steps < 1 || steps > 128) throw Error('Invalid speech generation steps');
  return {provider: value.provider || 'convai', baseUrl: url.origin,
    engine: value.engine || 'omnivoice', profiles, timeoutMs, steps};
}

async function boundedBody(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw Error('VoiceStudio response is too large');
  const chunks = []; let size = 0;
  if (!response.body) throw Error('VoiceStudio returned an empty response');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw Error('VoiceStudio response is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class VoiceStudioClient {
  constructor(config, {fetchImpl = fetch} = {}) {
    this.config = validateVoiceStudioConfig(config);
    this.fetch = fetchImpl;
    this.tail = Promise.resolve();
  }
  get enabled() { return this.config.provider === 'voicestudio'; }
  hasProfile(key) { return Object.hasOwn(this.config.profiles, key); }

  async request(path, options = {}, signal) {
    cancelled(signal);
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const response = await this.fetch(this.config.baseUrl + path, {...options,
      redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline});
    if (!response.ok) {
      // Keep dialogue, local paths and backend tracebacks out of public errors.
      await response.body?.cancel();
      throw Error(`VoiceStudio request failed (HTTP ${response.status})`);
    }
    return response;
  }

  async health({signal} = {}) {
    const response = await this.request('/health', {}, signal);
    return JSON.parse((await boundedBody(response, 1_000_000)).toString('utf8'));
  }

  async createProfile({name, audio, transcript, language = 'English'}, {signal} = {}) {
    inspectWav(audio);
    if (!name?.trim() || !transcript?.trim()) throw Error('A voice reference needs a name and exact transcript');
    const form = new FormData();
    form.set('name', name); form.set('kind', 'clone');
    form.set('ref_audio', new Blob([audio], {type: 'audio/wav'}), 'reference.wav');
    form.set('ref_text', transcript); form.set('language', language);
    const response = await this.request('/profiles', {method: 'POST', body: form}, signal);
    const profile = JSON.parse((await boundedBody(response, 1_000_000)).toString('utf8'));
    if (typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id)) throw Error('VoiceStudio returned an invalid profile ID');
    return profile;
  }

  synthesize(key, text, {signal} = {}) {
    const queuedAt = performance.now();
    // One local inference at a time. Group preparation can overlap game
    // playback, but cannot load several GPU workers or mix speaker profiles.
    const result = this.tail.then(async () => {
      cancelled(signal);
      const profile = this.config.profiles[key];
      if (!profile) throw Error('This character has no local cloned voice yet');
      if (typeof text !== 'string' || !text.trim() || text.length > 12_000) throw Error('Invalid speech text');
      const started = performance.now(), form = new FormData();
      const fields = {text, profile_id: profile.id, engine: profile.engine || this.config.engine,
        num_step: String(this.config.steps),
        speed: '1', effect_preset: 'raw', denoise: 'false', postprocess_output: 'false',
        max_chunk_chars: '0', crossfade_ms: '0', pronounce: 'false', stream: 'false'};
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      const response = await this.request('/generate', {method: 'POST', body: form}, signal);
      const bytes = await boundedBody(response, MAX_AUDIO_BYTES);
      cancelled(signal);
      const wav = inspectWav(bytes);
      return {audio: bytes.toString('base64'), wav, timing: {
        voiceQueueMs: started - queuedAt, voiceGenerationMs: performance.now() - started,
        voiceEngine: fields.engine, voiceProvider: 'voicestudio'}, faces: [], captions: []};
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
