// Convai PCM playback has its own lifetime. Omni's phrase/file producer never
// enters this adapter. The game admits the exact actor before any sound starts.
import {randomUUID} from 'node:crypto';
import {buildProviderFacialTimeline} from './facial-timeline.mjs';
import {attachExpressionTrack} from './expression-timeline.mjs';
import {ownedExpressionReceipt} from './companion-expressions.mjs';
import {decodeAnalysisPcm} from './analysis-pcm.mjs';
import {JALI_LEAD_SECONDS} from './jali-face.mjs';
import {displayText} from './natural-speech.mjs';
import {captionCues, cueSignature} from './caption-cues.mjs';
import {activeMakeupDb} from './dialogue-level.mjs';
import {audioDelayMs} from './audio-delay.mjs';

const SHARING_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const quiet = () => ({allow: false, paused: true, volume: 0, pan: 0});
// The game must refresh playback control within this window or the stream stops.
// Test harnesses that run the real bridge beside dozens of other processes may
// lengthen it (never shorten it) so a starved simulated game is not mistaken for
// a dead one. Production leaves the variable unset; the exact 2 s / 5 s limits
// are covered by convai-continuous-speech.test.mjs with an injected clock.
const requestedLease = Number(process.env.CYBERPUNK_CONVAI_TEST_LEASE_MS);
const LEASE_MS = Number.isFinite(requestedLease) && requestedLease > 2000 ? requestedLease : 2000;
const FIRST_LEASE_MS = Math.max(5000, LEASE_MS);

export class ConvaiContinuousSpeech {
  // writeFace + faceFile(): when the game's adapter advertises it (speech-state
  // continuousFaceFile), the facial timeline goes to its own file, written only
  // when it changes; the state file carries faceRevision. The game then decodes
  // ~100 KB a few times per utterance instead of on every 40 ms state poll.
  constructor({input, profile, current, signal, readControl, writeState, writeReply, writeFace, faceFile,
    onPublished = async () => {}, onStarted = async () => {}, onGenerated = async () => {}, onTimeline = () => {},
    // onAudio(): once, the first renderer state that holds audio was accepted (the turn's latency record).
    onAudio = () => {},
    // hold(): true while this turn is a look-ahead that must keep buffering and
    // publish nothing. onText(text, userText): the complete reply text is known.
    hold = () => false, onHeld = () => {}, onText = () => {},
    // leaseWake(): a promise that resolves when the game's lease file is replaced (bridge/file-wake.mjs), so the host's clock poll that
    // is waiting for the first lease runs at once instead of after its 40 ms sleep (docs/LATENCY_2026-10-13.md, 4.2).
    leaseWake,
    now = Date.now, token = randomUUID(), faceBuilder, jaliFace, planExpression}) {
    this.leaseWake = leaseWake;
    this.planExpression = planExpression; this.onTimeline = onTimeline;
    this.input = input; this.profile = profile; this.current = current; this.signal = signal;
    this.readControl = readControl; this.writeState = writeState; this.writeReply = writeReply;
    this.writeFace = writeFace; this.faceFile = faceFile; this.faceRevision = 0; this.faceWritten = 0;
    this.onPublished = onPublished; this.onStarted = onStarted; this.onGenerated = onGenerated; this.onAudio = onAudio; this.audioSeen = false;
    this.hold = hold; this.onHeld = onHeld; this.onText = onText; this.textAnnounced = false;
    this.woken = new Promise(resolve => { this.resolveWake = resolve; });
    this.faceBuilder = faceBuilder || ((snapshot, input, jali) => buildProviderFacialTimeline(snapshot, input, jali));
    // Optional game-trained model on an analysis copy of the same PCM. The
    // track layout is fixed for the whole stream; provider poses remain the
    // fallback wherever the model has no coverage, and its expressions stay.
    this.jaliFace = jaliFace; this.pcmFrames = 0;
    signal?.addEventListener('abort', () => this.dropModel(), {once: true});
    this.now = now; this.token = token;
    this.receivedFrames = 0; this.position = 0; this.controlSequence = -1;
    this.published = false; this.started = false; this.generated = false; this.ended = false;
  }

  get options() {
    return {token: this.token, onFrame: snapshot => this.frame(snapshot), pcmCursor: () => this.pcmCursor(),
      // A held look-ahead turn only buffers: the host may poll it less often.
      pollMs: () => this.hold() ? 120 : undefined,
      // Held: until the game submits the turn. Admitted but no lease read yet: until the game writes its lease. Afterwards the 40 ms poll
      // alone carries the stream (a wake on every lease refresh would only add polls).
      wake: () => this.hold() ? this.woken : this.controlAt === undefined ? this.leaseWake?.() : undefined};
  }

  // Next analysis frame wanted from the renderer, or undefined (no model).
  pcmCursor() { return this.model && !this.model.failed && !this.modelFinished ? this.pcmFrames : undefined; }

  // The hold ended: let the host poll immediately instead of finishing its slow wait.
  wakeUp() { this.resolveWake?.(); }

  dropModel() { this.model?.close(); this.model = null; this.modelDropped = true; }

  feedModel(snapshot) {
    if (!this.jaliFace || this.modelDropped) return;
    try {
      // The reply text grows with the stream; the text path aligns what is known and the audio model covers the rest.
      if (!this.model) { this.model = this.jaliFace.begin(snapshot.sampleRate, {text: snapshot.text, textComplete: snapshot.textComplete}); this.model.onUpdate = () => { this.modelRevision = (this.modelRevision || 0) + 1; }; }
      else this.model.setText?.(snapshot.text, snapshot.textComplete);
      if (snapshot.pcm !== undefined) {
        const pcm = decodeAnalysisPcm(snapshot.pcm, this.pcmFrames);
        if (this.pcmFrames + pcm.length > snapshot.receivedFrames) throw Error('Analysis PCM exceeds the renderer');
        this.model.push(pcm); this.pcmFrames += pcm.length;
      }
      if (snapshot.sourceComplete && !this.modelFinished && this.pcmFrames === snapshot.receivedFrames) {
        this.model.finish(); this.modelFinished = true;
      }
    } catch { this.dropModel(); }
  }

  jaliState(duration) {
    if (!this.jaliFace) return undefined;
    const frames = this.model && !this.model.failed ? this.model.frames : null;
    const covered = frames ? Math.min(duration, frames.coveredSeconds()) : 0;
    if (frames && this.modelStart === undefined && covered > this.position + JALI_LEAD_SECONDS) this.modelStart = this.position;
    return {frames, covered, start: this.modelStart ?? Infinity, position: this.position};
  }

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
      && finite(value.updated) && now - value.updated >= -1500 && now - value.updated <= LEASE_MS
      && typeof value.allow === 'boolean' && typeof value.paused === 'boolean'
      && finite(value.volume) && value.volume >= 0 && value.volume <= 1
      && finite(value.pan) && Math.abs(value.pan) <= 1) {
      this.controlSequence = value.sequence; this.controlAt = now;
      this.lastControl = {allow: value.allow, paused: value.paused, volume: value.volume, pan: value.pan};
      // Dialogue level (docs/DIALOGUE_LEVEL.md): the speaker distance the game
      // measured for this lease, when it sent one, drives the air low-pass.
      if (finite(value.distance) && value.distance >= 0 && value.distance <= 1000) this.lastControl.distance = value.distance;
      // An explicit stop is terminal. Distance or a later stale file cannot
      // reopen a retired actor's stream.
      if (!value.allow) this.retired = true;
    }
    if (this.retired) throw Error('Continuous speech was stopped by the game');
    const age = this.controlAt === undefined ? now - this.publishedAt : now - this.controlAt;
    if (age > (this.controlAt === undefined ? FIRST_LEASE_MS : LEASE_MS)) throw Error('Continuous speech game lease expired');
    // The bridge's makeup gain rides along; 0 (matching off) is the unity path.
    // The Lip sync delay (Bluetooth) rides along only when set, as delayMs.
    const delayMs = audioDelayMs();
    return this.lastControl && age <= 400 ? {...this.lastControl, makeupDb: activeMakeupDb(), ...(delayMs ? {delayMs} : {})} : quiet();
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
    // Natural speech: voice tags never reach a subtitle (a local voice's text arrives clean; this covers the rest).
    const shown = displayText(snapshot.text, snapshot.textComplete);
    if (shown !== snapshot.text) snapshot = {...snapshot, text: shown};
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
    if (!this.audioSeen) { this.audioSeen = true; try { this.onAudio(); } catch {} }
    // A device timestamp may be quantized by one render quantum. Never move
    // the native face/subtitle clock backwards when that estimate changes.
    this.position = Math.max(this.position, Math.min(duration, snapshot.positionSeconds));
    // A look-ahead turn only buffers: the renderer receives the quiet control, so
    // nothing is audible, and no state, reply or receipt is published until the
    // game has submitted this exact turn. The facial model keeps analysing.
    if (this.hold()) { this.feedModel(snapshot); this.onHeld(duration, snapshot.textComplete); return quiet(); }
    // Admission needs validated PCM and reply text, not a 400 ms prefix: the
    // renderer itself withholds sound until 400 ms is buffered (or EOF). The
    // game's lease round trip therefore overlaps buffering instead of following it.
    if (!this.published && !snapshot.text.trim()) return quiet();
    // F9 must pass the recognized microphone prompt to later speakers. Wait for
    // the owned transcript before admitting its first reply; never use the
    // placeholder "[Microphone]" or invent text after audio has already played.
    const transcriptRequired = this.input.source === 'microphone' && this.input.group?.index === 1;
    if (!this.published && transcriptRequired && !snapshot.userText?.trim()) {
      if (snapshot.sourceComplete && snapshot.textComplete) throw Error('Group voice transcript unavailable');
      return quiet();
    }

    // The next group speaker's turn is prepared from this complete text. Announce
    // it before the state that carries it is committed, so the game cannot
    // publish a prediction for a source the bridge has not yet recorded.
    if (!this.textAnnounced && snapshot.textComplete && snapshot.text.trim()) {
      this.textAnnounced = true; this.onText(snapshot.text, snapshot.userText);
    }
    this.feedModel(snapshot);
    const jali = this.jaliState(duration);
    const faceKey = `${snapshot.faces?.length || 0}:${snapshot.receivedFrames}:${snapshot.sourceComplete}:${snapshot.face?.revision || 0}`
      + (jali ? `:${this.modelRevision || 0}:${jali.start}:${jali.position >= jali.start && jali.position < jali.covered}` : '')
      + (this.planExpression ? `:x${snapshot.text.length}:${snapshot.textComplete}:${snapshot.expressionSignal?.emotion ?? ''}` : '');
    if (faceKey !== this.faceKey) {
      const {pcm: _pcm, ...view} = snapshot;
      this.face = this.faceBuilder({...view, duration, complete: snapshot.sourceComplete}, this.input, jali);
      // Expression track from the reply text, aligned to the audio received so
      // far (pauses in the mouth timeline, else a duration estimate). Optional:
      // a failure leaves the reply-level cue and the mouth exactly as they were.
      if (this.planExpression && this.face) {
        let plan;
        try { plan = this.planExpression(snapshot.text, snapshot.expressionSignal); } catch { /* optional */ }
        if (plan) this.face = attachExpressionTrack(this.face, plan,
          {complete: snapshot.sourceComplete, decay: snapshot.sourceComplete && snapshot.textComplete});
      }
      this.faceKey = faceKey; this.faceRevision++;
    }
    // Decided once, before the first state write, and fixed for this stream.
    if (this.splitFace === undefined) {
      // faceFile() answers true (a plain document), 'segments' (the segmented layout of
      // bridge/continuous-face-file.mjs, which the game decodes by changed segment) or false.
      let supported = false, segments = false;
      if (this.writeFace && this.faceFile) try {
        const mode = await this.faceFile();
        supported = mode === true || mode === 'segments'; segments = mode === 'segments';
      } catch { supported = false; }
      this.splitFace = supported; this.faceSegments = segments;
    }
    let faceField = {face: this.face};
    // The first publication does not wait for the face file (docs/LATENCY_2026-10-13.md, 4.3): the game cannot use a face before it has
    // the reply, so the state and the reply go out together and the face file follows at once; the state carries its revision from the
    // next poll on, and the lease (the sound) is not granted before that poll, so no sound starts without its face.
    const first = !this.published;
    if (this.splitFace) {
      if (!first) await this.commitFace();
      faceField = this.faceWritten ? {faceRevision: this.faceWritten} : {};
    }
    const document = {version: 1, id: this.token, requestId: this.input.requestId,
      generation: this.input.generation, entity: this.input.entity, updated: this.now(),
      state: snapshot.state, position: this.position, bufferedDuration: duration,
      text: snapshot.text, textComplete: snapshot.textComplete, complete: snapshot.sourceComplete,
      ended: snapshot.ended, underruns: snapshot.underruns, ...faceField};
    // Subtitle timing: cue spans aligned to this same audio (bridge/caption-cues.mjs).
    const captions = this.captionsFor(snapshot, duration);
    if (captions) document.captions = captions;
    const expression = ownedExpressionReceipt(snapshot.expressionSignal, this.input);
    if (expression) document.expression = expression;
    // The state is committed and the owner is checked before the reply is written (a cancel or a failed state write never admits audio),
    // so the two stay in sequence.
    const stateCommitted = await this.commit(this.writeState, document, snapshot.ended);
    if (stateCommitted === false) throw Error('Continuous speech state could not be committed');
    if (!await this.valid()) throw Error('Continuous speech owner changed');
    // A file the game was reading at that instant: publish on the next poll.
    if (stateCommitted === null) return this.published ? this.control() : quiet();
    if (first) {
      const reply = {requestId: this.input.requestId, generation: this.input.generation,
        entity: this.input.entity, profile: this.profile.key, text: snapshot.text,
        ...(snapshot.userText ? {userText: snapshot.userText} : {}),
        continuous: {version: 1, id: this.token}, updated: this.now()};
      const replyCommitted = await this.commit(this.writeReply, reply, false);
      if (replyCommitted === null) return quiet();
      if (!replyCommitted) throw Error('Continuous speech admission could not be committed');
      this.published = true; this.publishedAt = this.now();
      await this.onPublished({publishedAt: this.publishedAt, initialBufferedSeconds: duration});
      // The face file follows the reply at once; the state carries its revision from the next poll on.
      if (this.splitFace) await this.commitFace();
    }
    if (!this.started && this.position > 0) {
      this.started = true;
      await this.onStarted({continuousPlaybackFirstObservedAt: this.now(),
        continuousPlaybackPositionSeconds: this.position,
        continuousPlaybackStartEstimateAt: this.now() - this.position * 1000});
    }
    if (!this.generated && snapshot.textComplete && snapshot.sourceComplete) {
      await this.onGenerated(snapshot.text); this.generated = true;
      this.reportTimeline(snapshot);
    }
    this.last = document;
    if (snapshot.ended) { this.ended = true; this.model?.close(); return quiet(); }
    if (!await this.valid()) throw Error('Continuous speech owner changed');
    return this.control();
  }

  // Writes the facial timeline file when its revision changed (the state then carries `faceRevision`).
  async commitFace() {
    if (!this.face || this.faceWritten === this.faceRevision) return;
    const owner = {version: 1, id: this.token, requestId: this.input.requestId,
      generation: this.input.generation, entity: this.input.entity};
    const committed = await this.commit(value => this.writeFace(value, {segments: this.faceSegments === true}),
      {...owner, revision: this.faceRevision, face: this.face}, false);
    if (committed === false) throw Error('Continuous speech face could not be committed');
    // null: the game was reading the old file; the next poll writes again.
    if (committed !== null) this.faceWritten = this.faceRevision;
  }

  // Once per reply, when its text and audio source are both complete: the plan and face this stream ends with (the
  // planner caches by text, so this is the plan the last poll already used). Diagnostic only; never throws.
  reportTimeline(snapshot) {
    try {
      const plan = this.planExpression?.(snapshot.text, snapshot.expressionSignal);
      this.onTimeline({text: snapshot.text, plan, face: this.face, signal: snapshot.expressionSignal});
    } catch { /* the timeline is optional */ }
  }

  // Audio-aligned subtitle cues for the published text. Recomputed when the
  // text, audio or mouth timeline changes; the revision grows only when the
  // cues themselves change, so the game re-paginates only then.
  captionsFor(snapshot, duration) {
    const key = `${this.faceRevision}:${duration}:${snapshot.sourceComplete}:${snapshot.textComplete}:${snapshot.text}`;
    if (key === this.captionKey) return this.captions;
    this.captionKey = key;
    let next;
    try {
      next = captionCues(snapshot.text, {face: this.face, duration, complete: snapshot.sourceComplete && snapshot.textComplete});
    } catch { next = undefined; }
    const signature = cueSignature(next);
    if (signature !== this.captionSignature) { this.captionSignature = signature; this.captionRevision = (this.captionRevision || 0) + 1; }
    this.captions = next ? {...next, revision: this.captionRevision} : undefined;
    return this.captions;
  }

  // The game reads these files on its own cadence. On Windows a read in progress
  // (or a scanner holding the new file) makes the atomic rename fail with a
  // sharing error even after its short retries; the live bridge log shows this
  // for another polled file. One missed publication is harmless (the game
  // tolerates two seconds between state updates); failing the whole utterance
  // and its warm page is not. Returns null for a skipped publication. The final
  // drained state is retried instead, because no later poll would carry it.
  async commit(write, value, final) {
    for (let attempt = 0; ; attempt++) {
      try {
        const committed = await write(value);
        this.sharingFailures = 0;
        return committed;
      } catch (error) {
        this.sharingFailures = (this.sharingFailures || 0) + 1;
        if (!SHARING_ERRORS.has(error?.code) || this.sharingFailures > 20) throw error;
        if (!final || attempt >= 10) return final ? Promise.reject(error) : null;
        await new Promise(done => setTimeout(done, 25));
        if (!await this.valid()) throw Error('Continuous speech owner changed');
      }
    }
  }

  async fail() {
    this.dropModel();
    if (!this.published || !await this.valid()) return;
    await this.writeState({...this.last, version: 1, id: this.token,
      requestId: this.input.requestId, generation: this.input.generation, entity: this.input.entity,
      updated: this.now(), state: 'error', error: 'The voice stream stopped.', ended: false});
  }
}
