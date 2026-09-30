// Convai PCM playback has its own lifetime. Omni's phrase/file producer never
// enters this adapter. The game admits the exact actor before any sound starts.
import {randomUUID} from 'node:crypto';
import {buildProviderFacialTimeline} from './facial-timeline.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const quiet = () => ({allow: false, paused: true, volume: 0, pan: 0});

export class ConvaiContinuousSpeech {
  constructor({input, profile, current, signal, readControl, writeState, writeReply,
    onPublished = async () => {}, onStarted = async () => {}, onGenerated = async () => {},
    now = Date.now, token = randomUUID()}) {
    this.input = input; this.profile = profile; this.current = current; this.signal = signal;
    this.readControl = readControl; this.writeState = writeState; this.writeReply = writeReply;
    this.onPublished = onPublished; this.onStarted = onStarted; this.onGenerated = onGenerated;
    this.now = now; this.token = token;
    this.receivedFrames = 0; this.position = 0; this.controlSequence = -1;
    this.published = false; this.started = false; this.generated = false; this.ended = false;
  }

  get options() { return {token: this.token, onFrame: snapshot => this.frame(snapshot)}; }

  matches(value) {
    return value?.version === 1 && value.id === this.token
      && value.requestId === this.input.requestId && value.entity === this.input.entity
      && value.generation === this.input.generation;
  }

  async valid() { return !this.signal?.aborted && await this.current() && !this.signal?.aborted; }

  async control() {
    let value;
    try { value = JSON.parse(await this.readControl()); } catch { /* In-place Lua write: bounded last good lease. */ }
    if (!await this.valid()) throw Error('Continuous speech owner changed');
    const now = this.now();
    if (this.matches(value) && integer(value.sequence) && value.sequence > this.controlSequence
      && finite(value.updated) && now - value.updated >= -1500 && now - value.updated <= 2000
      && typeof value.allow === 'boolean' && typeof value.paused === 'boolean'
      && finite(value.volume) && value.volume >= 0 && value.volume <= 1
      && finite(value.pan) && Math.abs(value.pan) <= 1) {
      this.controlSequence = value.sequence; this.controlAt = now;
      this.lastControl = {allow: value.allow, paused: value.paused, volume: value.volume, pan: value.pan};
      // An explicit stop is terminal. Distance or a later stale file cannot
      // reopen a retired actor's stream.
      if (!value.allow) this.retired = true;
    }
    if (this.retired) throw Error('Continuous speech was stopped by the game');
    const age = this.controlAt === undefined ? now - this.publishedAt : now - this.controlAt;
    if (age > (this.controlAt === undefined ? 5000 : 2000)) throw Error('Continuous speech game lease expired');
    return this.lastControl && age <= 400 ? {...this.lastControl} : quiet();
  }

  async frame(snapshot) {
    if (!await this.valid()) throw Error('Continuous speech owner changed');
    if (!snapshot || snapshot.version !== 1 || snapshot.token !== this.token) throw Error('Continuous speech token mismatch');
    if (this.ended) return quiet();
    if (snapshot.error) throw Error('Continuous speech renderer failed');
    // The host also polls while the service is thinking. No audio device or
    // actor is admitted until there is validated PCM and nonempty reply text.
    if (!snapshot.sampleRate || !snapshot.receivedFrames) return quiet();
    const duration = snapshot.receivedFrames / snapshot.sampleRate;
    if (!integer(snapshot.sampleRate) || snapshot.sampleRate < 8000 || snapshot.sampleRate > 96000
      || ![1, 2].includes(snapshot.channels) || !integer(snapshot.receivedFrames)
      || duration <= 0 || duration > 120 || snapshot.receivedFrames < this.receivedFrames
      || !finite(snapshot.positionSeconds) || snapshot.positionSeconds < 0 || snapshot.positionSeconds > duration + .025
      || typeof snapshot.text !== 'string' || snapshot.text.length > 12000
      || typeof snapshot.textComplete !== 'boolean' || typeof snapshot.sourceComplete !== 'boolean'
      || typeof snapshot.ended !== 'boolean' || !integer(snapshot.underruns)
      || typeof snapshot.state !== 'string' || snapshot.state.length > 50) throw Error('Invalid continuous speech state');
    if (this.sampleRate && (snapshot.sampleRate !== this.sampleRate || snapshot.channels !== this.channels))
      throw Error('Continuous speech format changed');
    if (this.sourceComplete && (!snapshot.sourceComplete || snapshot.receivedFrames !== this.receivedFrames))
      throw Error('Completed continuous speech changed');
    if (snapshot.userText !== undefined && (typeof snapshot.userText !== 'string'
      || snapshot.userText.length > 1200 || /[\u0000-\u001f\u007f]/.test(snapshot.userText)))
      throw Error('Invalid continuous speech transcript');
    if (snapshot.ended && (!snapshot.sourceComplete || !snapshot.textComplete
      || duration - snapshot.positionSeconds > .025)) throw Error('Continuous speech ended before audible drain');
    this.sampleRate = snapshot.sampleRate; this.channels = snapshot.channels;
    this.receivedFrames = snapshot.receivedFrames; this.sourceComplete = snapshot.sourceComplete;
    // A device timestamp may be quantized by one render quantum. Never move
    // the native face/subtitle clock backwards when that estimate changes.
    this.position = Math.max(this.position, Math.min(duration, snapshot.positionSeconds));
    if (!this.published && (!snapshot.text.trim() || (duration < .4 && !snapshot.sourceComplete))) return quiet();
    // F9 must pass the recognized microphone prompt to later speakers. Wait for
    // the owned transcript before admitting its first reply; never use the
    // placeholder "[Microphone]" or invent text after audio has already played.
    const transcriptRequired = this.input.source === 'microphone' && this.input.group?.index === 1;
    if (!this.published && transcriptRequired && !snapshot.userText?.trim()) {
      if (snapshot.sourceComplete && snapshot.textComplete) throw Error('Group voice transcript unavailable');
      return quiet();
    }

    const faceKey = `${snapshot.faces?.length || 0}:${snapshot.receivedFrames}:${snapshot.sourceComplete}`;
    if (faceKey !== this.faceKey) {
      this.face = buildProviderFacialTimeline({...snapshot, duration, complete: snapshot.sourceComplete}, this.input);
      this.faceKey = faceKey;
    }
    const document = {version: 1, id: this.token, requestId: this.input.requestId,
      generation: this.input.generation, entity: this.input.entity, updated: this.now(),
      state: snapshot.state, position: this.position, bufferedDuration: duration,
      text: snapshot.text, textComplete: snapshot.textComplete, complete: snapshot.sourceComplete,
      ended: snapshot.ended, underruns: snapshot.underruns, face: this.face};
    if (!await this.writeState(document)) throw Error('Continuous speech state could not be committed');
    if (!await this.valid()) throw Error('Continuous speech owner changed');
    if (!this.published) {
      const reply = {requestId: this.input.requestId, generation: this.input.generation,
        entity: this.input.entity, profile: this.profile.key, text: snapshot.text,
        ...(snapshot.userText ? {userText: snapshot.userText} : {}),
        continuous: {version: 1, id: this.token}, updated: this.now()};
      if (!await this.writeReply(reply)) throw Error('Continuous speech admission could not be committed');
      this.published = true; this.publishedAt = this.now();
      await this.onPublished({publishedAt: this.publishedAt, initialBufferedSeconds: duration});
    }
    if (!this.started && this.position > 0) {
      this.started = true;
      await this.onStarted({continuousPlaybackFirstObservedAt: this.now(),
        continuousPlaybackPositionSeconds: this.position,
        continuousPlaybackStartEstimateAt: this.now() - this.position * 1000});
    }
    if (!this.generated && snapshot.textComplete && snapshot.sourceComplete) {
      await this.onGenerated(snapshot.text); this.generated = true;
    }
    this.last = document;
    if (snapshot.ended) { this.ended = true; return quiet(); }
    if (!await this.valid()) throw Error('Continuous speech owner changed');
    return this.control();
  }

  async fail() {
    if (!this.published || !await this.valid()) return;
    await this.writeState({...this.last, version: 1, id: this.token,
      requestId: this.input.requestId, generation: this.input.generation, entity: this.input.entity,
      updated: this.now(), state: 'error', error: 'The voice stream stopped.', ended: false});
  }
}
