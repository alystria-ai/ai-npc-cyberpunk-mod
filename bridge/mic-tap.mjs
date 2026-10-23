// The microphone tap: ONE open microphone device whose audio is kept (pre-roll) until a turn takes it. "Instant push-to-talk" and
// "Voice activation" both need the device to be listening BEFORE the conversation connection, the recogniser or the cloud turn is
// ready, and nothing said in that time may be lost:
//
//   hold-to-talk      the game signals the key press (runtime/microphone-live.json), the tap opens the device at once and keeps every
//                     chunk. The turn's channel (the local recogniser, Mistral's transcription, Convai's relay) attaches when it is
//                     ready and is handed the kept audio first, then the live audio. The key release stops the tap on the spot.
//   voice activation  the tap listens while a conversation is possible: it keeps only the newest second or so and runs the voice
//                     activity detector (bridge/voice-activity.mjs) over each chunk. Nothing leaves the tap until a turn takes it, and
//                     the turn takes it from the detected start of speech (a little before it).
//
// Everything runs in the bridge process. The device itself is the capture page of bridge/local-stt-capture.mjs (the hidden browser). This
// module is pure bookkeeping: bytes in, bytes out, a state machine, and no I/O of its own except what `capture` does.
import {SpeechActivity} from './stt-activity.mjs';
import {VoiceActivity} from './voice-activity.mjs';

export const TAP = Object.freeze({
  chunkMs: 40,            // the capture page posts a chunk this often (a chunk waits at most this long before the bridge has it)
  maxTurnMs: 45_000,      // the longest audio a turn's tap keeps before a channel attaches (the 30 s recording cap and a slow start)
  listenKeepMs: 1_500,    // a listening tap with no speech keeps only this much (a VAD start is decided 240-330 ms after the onset)
  listenMaxMs: 8_000,     // a listening tap in the middle of speech keeps at most this much before a turn takes it
  keyLeadMs: 250,         // a key press that finds the tap already listening keeps this much audio from before the press
  speechLeadMs: 250,      // the Convai route sends audio from this long before the first speech frame (nothing earlier leaves the PC)
  speechTailMs: 300,      // ... and, when the kept audio holds no speech yet, only its newest this much
  unclaimedMs: 20_000,    // a turn's tap that no channel attached to is released
  heldGraceMs: 2_500,     // a key let go whose turn never began (no target, no service) releases the tap after this
  idleCloseMs: 600_000,   // the capture page (a small blank renderer) is closed this long after the last recording; a new one costs about half a second, which the first word of the next press would pay
  prerollMs: 300,         // a voice-activation turn starts this long before the detected onset
});

const BYTES_PER_MS = 32;   // 16 kHz mono 16-bit

const asBuffer = chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

// The audio since the tap opened, by stream position (bytes since the first chunk), oldest dropped past `maxMs`.
export class PreRollBuffer {
  constructor({maxMs = TAP.maxTurnMs} = {}) {
    this.maxBytes = Math.round(maxMs * BYTES_PER_MS);
    this.chunks = [];
    this.startByte = 0;     // stream position of the first kept byte
    this.endByte = 0;       // stream position after the last byte
  }
  get startMs() { return this.startByte / BYTES_PER_MS; }
  get streamMs() { return this.endByte / BYTES_PER_MS; }
  get keptMs() { return (this.endByte - this.startByte) / BYTES_PER_MS; }
  push(chunk) {
    const bytes = asBuffer(chunk);
    if (!bytes.length) return;
    this.chunks.push(bytes); this.endByte += bytes.length;
    while (this.endByte - this.startByte > this.maxBytes && this.chunks.length > 1) {
      this.startByte += this.chunks.shift().length;
    }
  }
  // Drops whole chunks that end before stream position `ms` (a listening tap keeps only the newest part).
  trimTo(ms) {
    const target = Math.max(0, Math.round(ms * BYTES_PER_MS));
    while (this.chunks.length > 1 && this.startByte + this.chunks[0].length <= target) this.startByte += this.chunks.shift().length;
  }
  // The kept audio from stream position `ms` on, in pieces of at most `pieceBytes` (so a long wait never becomes one huge message).
  pieces(ms = 0, pieceBytes = 6400) {
    const from = Math.max(this.startByte, Math.round(ms * BYTES_PER_MS) & ~1);
    const out = [];
    let at = this.startByte;
    for (const chunk of this.chunks) {
      const end = at + chunk.length;
      if (end > from) {
        let part = from > at ? chunk.subarray(from - at) : chunk;
        for (let i = 0; i < part.length; i += pieceBytes) out.push(Buffer.from(part.subarray(i, Math.min(part.length, i + pieceBytes))));
      }
      at = end;
    }
    return out;
  }
  // Where audio for a cloud transcription should start: `leadMs` before the first frame of speech the kept audio holds, or, with no speech in it,
  // only its newest `tailMs`. Never earlier than what is kept. The same speech test as the recogniser's gate (bridge/stt-activity.mjs).
  speechStartMs(leadMs = TAP.speechLeadMs, tailMs = TAP.speechTailMs) {
    const activity = new SpeechActivity();
    for (const chunk of this.chunks) activity.push(chunk);
    if (!activity.heardSpeech) return Math.max(this.startMs, this.streamMs - tailMs);
    const first = activity.firstSpeechFrame;
    return Math.max(this.startMs, this.startMs + first * 30 - leadMs);
  }
  clear() { this.chunks = []; this.startByte = this.endByte; }
}

const cancelled = () => Object.assign(Error('The microphone was released before it opened'), {code: 'TAP_RELEASED'});

export class MicTap {
  // capture: {begin(onChunk, {chunkMs}) -> info, end(), abort(), close?()} (LocalSttCapture).
  // onVad(status): {seq, phase: 'speech'|'ended', onsetMs?, endMs?} for each start or end the detector decided.
  // onRelease(): the tap is closed again (the bridge reopens it for listening when the game still wants that).
  constructor({capture, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, makeVad = () => new VoiceActivity(),
      onVad = () => {}, onRelease = () => {}, limits = {}} = {}) {
    Object.assign(this, {capture, now, setTimer, clearTimer, log, makeVad, onVad, onRelease});
    this.limits = {...TAP, ...limits};
    this.state = 'closed';          // closed | opening | open | ended (the device is released, the kept audio waits for its channel)
    this.generation = 0;
    this.chain = Promise.resolve(); // capture.begin / end / abort run one at a time
    this.vadSeq = 0;
    this.warmWanted = false;        // the device is to be kept open (read from nowhere) between recordings
    this.timers = {};
    this._reset();
  }

  _reset() {
    this.owner = null; this.holdId = null; this.mode = null; this.vadTurn = false;
    this.ring = null; this.sink = null; this.info = null; this.ready = null; this.vad = null;
    this.bytes = 0; this.startMs = 0; this.openedAt = 0; this.stopping = null; this.vadState = null;
  }

  _cancelTimers() { for (const name of Object.keys(this.timers)) { this.clearTimer(this.timers[name]); delete this.timers[name]; } }
  _timer(name, ms, fn) {
    this.clearTimer(this.timers[name]);
    const timer = this.setTimer(fn, ms);
    timer?.unref?.();
    this.timers[name] = timer;
  }
  _run(fn) { const next = this.chain.then(fn, fn); this.chain = next.catch(() => {}); return next; }

  isOwner(owner) { return this.state !== 'closed' && owner !== null && owner !== undefined && owner === this.owner; }
  get listening() { return this.state !== 'closed' && this.mode === 'listen'; }
  get streamMs() { return this.bytes / BYTES_PER_MS; }
  get vadStatus() { return this.vadState; }

  // Opens the device for `owner` (a request id), or takes over what is already open:
  //   - the same owner: nothing changes
  //   - the key's hold id (`opts.holdId`, opened by hold()): the request takes the tap over with everything kept so far
  //   - a listening tap: the turn takes it, from `opts.sinceMs` (a voice-activation start: the detected onset minus its pre-roll) or from
  //     keyLeadMs before now (a key press)
  // Returns the promise of the device info ({device, ...}); it rejects when the device cannot open.
  open(owner, opts = {}) {
    const {holdId = null, listen = false, vad = false, sinceMs} = opts;
    if (this.state !== 'closed') {
      if (owner === this.owner) return this.ready;
      if (holdId && holdId === this.holdId) { this.owner = owner; this._claimTimer(); return this.ready; }
      if (this.mode === 'listen' && !listen && this.state !== 'ended') {
        this.mode = 'turn'; this.owner = owner; this.holdId = holdId; this.vadTurn = vad === true;
        if (!this.vadTurn) this.vad = null;
        this.ring.maxBytes = Math.round(this.limits.maxTurnMs * BYTES_PER_MS);
        this.startMs = Number.isFinite(sinceMs) ? Math.max(0, sinceMs) : Math.max(0, this.streamMs - this.limits.keyLeadMs);
        this._claimTimer();
        this.log('microphone tap taken over from listening, audio from ' + Math.round(this.startMs) + ' ms of ' + Math.round(this.streamMs));
        return this.ready;
      }
      this._drop('replaced');
    }
    const generation = ++this.generation;
    this._cancelTimers();
    this.owner = owner; this.holdId = holdId; this.mode = listen ? 'listen' : 'turn'; this.vadTurn = vad === true;
    this.ring = new PreRollBuffer({maxMs: listen ? this.limits.listenMaxMs : this.limits.maxTurnMs});
    this.sink = null; this.info = null; this.bytes = 0; this.startMs = 0; this.stopping = null; this.vadState = null;
    this.vad = listen || vad ? this.makeVad() : null;
    this.state = 'opening';
    const began = this.now();
    this.openedAt = began;
    this.ready = this._run(() => {
      if (generation !== this.generation) throw cancelled();
      return this.capture.begin(chunk => this._chunk(generation, chunk), {chunkMs: this.limits.chunkMs});
    }).then(info => {
      if (generation !== this.generation) throw cancelled();
      this.info = info; if (this.state === 'opening') this.state = 'open';
      this.log('microphone tap open for ' + (listen ? 'listening' : 'a turn') + ' in ' + (this.now() - began) + ' ms');
      return info;
    }, error => {
      if (generation === this.generation) { this._cancelTimers(); this.state = 'closed'; this._reset(); this.generation++; }
      throw error;
    });
    this.ready.catch(() => {});
    if (!listen) this._claimTimer();
    return this.ready;
  }

  _claimTimer() {
    this._timer('claim', this.limits.unclaimedMs, () => { if (!this.sink && this.state !== 'closed') this.release(this.owner, 'unclaimed'); });
  }

  // Keeps the device open between recordings (the capture page's `warm`): a key press then starts at once instead of waiting for the device to open,
  // which takes 0.4 s idle and up to about 2 s in a running game. Nothing is read from a warm device. `warm(false)` lets it go once no recording uses it.
  warm(on = true) {
    this.warmWanted = on === true;
    if (typeof this.capture.warm !== 'function') return Promise.resolve(null);
    if (!this.warmWanted) {
      if (this.state === 'closed') return this._run(() => this.capture.cool()).catch(() => {});
      return Promise.resolve(null);   // in use: it is cooled when the recording releases it
    }
    this.clearTimer(this.timers.idle); delete this.timers.idle;
    const began = this.now();
    return this._run(() => this.capture.warm({chunkMs: this.limits.chunkMs})).then(info => {
      this.log('microphone kept open, reading nothing' + (info?.device ? ' (' + String(info.device).slice(0, 80) + ')' : '') + ', opened in ' + (this.now() - began) + ' ms');
      return info;
    }, error => { this.log('the microphone could not be kept open: ' + String(error?.message ?? error).slice(0, 120)); return null; });
  }

  // The key went down before the turn's request exists: the tap listens for that request, kept under the key's id.
  hold(holdId) { return this.open('hold:' + holdId, {holdId}); }

  // The key came up. A turn that began adopts the tap by request id (open with holdId); this stops whichever owns it.
  released(holdId) {
    if (!holdId || holdId !== this.holdId || this.state === 'closed') return null;
    const stopped = this.stop(this.owner);
    // A key press that never became a turn (no target, no service): nobody attaches, so the tap goes after a short grace.
    this._timer('claim', this.limits.heldGraceMs, () => { if (!this.sink && this.state !== 'closed' && this.holdId === holdId) this.release(this.owner, 'hold ended'); });
    return stopped;
  }

  whenReady(owner) { return this.isOwner(owner) ? this.ready : Promise.reject(cancelled()); }

  _chunk(generation, chunk) {
    if (generation !== this.generation || this.state === 'closed') return;
    const bytes = asBuffer(chunk);
    this.bytes += bytes.length;
    if (this.sink) { try { this.sink(bytes); } catch { /* a consumer fault never stops the tap */ } }
    else this.ring.push(bytes);
    if (this.vad) {
      for (const event of this.vad.push(bytes)) this._vadEvent(event);
      // A quiet listening tap keeps only the newest second or so; an utterance nobody has taken yet (running, or ended a moment ago) is kept whole
      // from its onset (and the pre-roll before it) for the turn that is about to take it.
      if (this.mode === 'listen' && !this.sink) {
        const held = this.vadState ? this.vadState.onsetMs - this.limits.prerollMs - TAP.chunkMs : Infinity;
        this.ring.trimTo(Math.min(this.streamMs - this.limits.listenKeepMs, held));
      }
    }
  }

  _vadEvent(event) {
    this.vadState = event.type === 'start'
      ? {seq: ++this.vadSeq, phase: 'speech', onsetMs: event.onsetMs, detectedMs: event.detectedMs}
      : {seq: ++this.vadSeq, phase: 'ended', endMs: event.endMs, speechMs: event.speechMs, silenceMs: event.silenceMs, onsetMs: this.vadState?.onsetMs};
    this.log('voice activity ' + event.type + ' at ' + Math.round(event.type === 'start' ? event.onsetMs : event.endMs) + ' ms'
      + (event.type === 'end' ? ' (' + Math.round(event.speechMs) + ' ms of speech, quiet ' + Math.round(event.silenceMs) + ' ms)' : ''));
    try { this.onVad({...this.vadState}); } catch { /* an observer never breaks the tap */ }
  }

  // A turn's channel takes the audio: the kept audio first (pieces), then every live chunk, through `sink(Buffer)`.
  //   mode 'all'     everything since the tap's start (the local recogniser: it has its own speech gate)
  //   mode 'speech'  from `speechLeadMs` before the first speech frame (a cloud route: silence before the player spoke never leaves the PC)
  // A voice-activation turn always starts at the detected onset. Returns {ok, device, flushedMs, ended}; ok is false when `owner` does not own the tap.
  attach(owner, sink, {mode = 'all'} = {}) {
    if (!this.isOwner(owner) || typeof sink !== 'function') return {ok: false};
    let from = this.startMs;
    if (mode === 'speech' && !this.vadTurn) from = Math.max(from, this.ring.speechStartMs(this.limits.speechLeadMs, this.limits.speechTailMs));
    const pieces = this.ring.pieces(from);
    let flushed = 0;
    for (const piece of pieces) { flushed += piece.length; try { sink(piece); } catch { /* the consumer's fault */ } }
    this.ring.clear();
    this.sink = sink;
    this._cancelTimers();
    const flushedMs = Math.round(flushed / BYTES_PER_MS);
    this.log('microphone tap handed over ' + flushedMs + ' ms of kept audio (' + mode + ')' + (this.state === 'ended' ? ', recording already ended' : ''));
    return {ok: true, device: this.info?.device, flushedMs, ended: this.state === 'ended'};
  }

  detach(owner) { if (this.isOwner(owner)) this.sink = null; }

  // The recording ends now: the device is released and its last block flushed into the kept audio (or the live sink). The audio
  // stays for a channel that has not attached yet. Idempotent.
  stop(owner) {
    if (!this.isOwner(owner)) return Promise.resolve();
    if (this.stopping) return this.stopping;
    const generation = this.generation, wasOpening = this.state === 'opening';
    this.stopping = this._run(async () => {
      try { await this.ready; } catch { return; }
      if (generation !== this.generation) return;
      await this.capture.end();
    }).then(() => { if (generation === this.generation && this.state !== 'closed') this.state = 'ended'; },
      error => { this.log('microphone tap stop failed: ' + String(error?.message ?? error).slice(0, 120)); if (generation === this.generation && this.state !== 'closed') this.state = 'ended'; });
    if (wasOpening || this.state === 'open') { /* a chunk that arrives while ending still counts: the generation stays */ }
    return this.stopping;
  }

  // The tap is given up: the device is closed (if it still is open), kept audio and the detector are dropped.
  release(owner, reason = 'released') {
    if (this.state === 'closed') return Promise.resolve();
    if (owner !== undefined && owner !== null && owner !== this.owner) return Promise.resolve();
    return this._drop(reason);
  }

  _drop(reason) {
    const needsAbort = this.state !== 'ended';
    const previous = this.owner;
    this.generation++;
    this._cancelTimers();
    this.state = 'closed'; this._reset();
    const aborting = needsAbort ? this._run(() => this.capture.abort()).catch(() => {}) : Promise.resolve();
    this.log('microphone tap released (' + reason + ')' + (previous ? '' : ''));
    // A device that is not kept open is let go with its recording; the capture page (a renderer process) leaves after a while without one.
    if (!this.warmWanted && this.capture.warmed && typeof this.capture.cool === 'function') void this._run(() => this.capture.cool()).catch(() => {});
    if (typeof this.capture.close === 'function') this._timer('idle', this.limits.idleCloseMs, () => { if (this.state === 'closed' && !this.warmWanted) void Promise.resolve(this.capture.close()).catch(() => {}); });
    try { this.onRelease(reason); } catch { /* an observer never breaks the tap */ }
    return aborting;
  }

  // For the adapter of the local recogniser's own idle release: closes the capture page only while the tap is not in use.
  closeIfIdle() {
    if (this.state !== 'closed') return Promise.resolve();
    return Promise.resolve(this.capture.close?.()).catch(() => {});
  }
}

// What createLocalSttChannel (bridge/local-stt-capture.mjs) sees as its `capture`: begin / end / abort over the tap, so the local
// recogniser and Mistral's transcription take the pre-rolled audio without any change of their own. A channel whose tap was not
// opened ahead (an add-on voice key, a bridge that never saw the key's hold signal) simply opens it here: the old behaviour.
export class TapCapture {
  constructor({tap}) { this.tap = tap; this.owner = null; }
  async begin(onChunk, {requestId} = {}) {
    const owner = requestId ?? this.owner ?? ('local:' + this.tap.now());
    this.owner = owner;
    if (!this.tap.isOwner(owner)) this.tap.open(owner);
    const info = await this.tap.whenReady(owner);
    const attached = this.tap.attach(owner, onChunk, {mode: 'all'});
    if (!attached.ok) throw Error('The microphone was released before it opened');
    return info;
  }
  async end() { await this.tap.stop(this.owner); }
  async abort() { await this.tap.release(this.owner, 'channel closed'); }
  // The recogniser's own idle release must not close the page: the tap keeps it warm for the next key press (and closes it itself, idleCloseMs).
  close() { return Promise.resolve(); }
}
