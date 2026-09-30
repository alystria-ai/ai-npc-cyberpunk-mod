import {pcmFormat, playbackControl, PCM_LIMITS, PcmClockHistory} from './continuous-pcm-core.mjs';

const WORKLET_URL = new URL('./continuous-pcm-worklet.mjs', import.meta.url);
const empty = () => ({state: 'opening', positionSeconds: 0, playedFrames: 0, bufferedFrames: 0,
  receivedFrames: 0, underruns: 0, sampleRate: 0, channels: 0, ended: false, error: null});

export class ContinuousPcmPlayer {
  constructor({AudioContextClass = globalThis.AudioContext, AudioWorkletNodeClass = globalThis.AudioWorkletNode,
    now = () => performance.now(), setIntervalFn = (...args) => globalThis.setInterval(...args),
    clearIntervalFn = value => globalThis.clearInterval(value),
    setTimeoutFn = (...args) => globalThis.setTimeout(...args),
    clearTimeoutFn = value => globalThis.clearTimeout(value)} = {}) {
    Object.assign(this, {AudioContextClass, AudioWorkletNodeClass, now, setIntervalFn, clearIntervalFn,
      setTimeoutFn, clearTimeoutFn});
    this.pending = new Map(); this.commandId = 0; this.history = new PcmClockHistory();
    this.latest = empty(); this.submittedFrames = 0; this.heardFrames = 0;
    this.admission = {allow: false, paused: false, volume: 1, pan: 0};
    this.stopped = false; this.opened = false; this.opening = null; this.closePromise = null;
    this.whenStopped = new Promise(resolve => { this.resolveStopped = resolve; });
  }

  async open({sampleRate, channels, token} = {}) {
    if (this.opening || this.stopped) throw Error('PCM player has already been opened or stopped');
    const format = pcmFormat(sampleRate, channels);
    if (typeof token !== 'string' || !token || token.length > 256) throw Error('Invalid PCM playback owner');
    Object.assign(this, format); this.token = token; this.lastControlMs = this.now();
    this.latest = {...empty(), sampleRate, channels};
    this.opening = this.prepare();
    return this.opening;
  }

  async prepare() {
    try {
      if (!this.AudioContextClass || !this.AudioWorkletNodeClass) throw Error('Continuous browser audio is unavailable');
      this.context = new this.AudioContextClass({sampleRate: this.sampleRate, latencyHint: 'interactive'});
      if (this.context.sampleRate !== this.sampleRate) throw Error('Audio device cannot preserve the source sample rate');
      await this.startupStep(this.context.audioWorklet.addModule(WORKLET_URL.href));
      if (this.stopped) throw Error('PCM player was stopped during startup');
      this.node = new this.AudioWorkletNodeClass(this.context, 'convai-continuous-pcm', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [this.channels],
        processorOptions: {sampleRate: this.sampleRate, channels: this.channels, token: this.token},
      });
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.panner = this.context.createStereoPanner(); this.panner.pan.value = 0;
      this.node.port.onmessage = event => this.receive(event.data);
      this.node.onprocessorerror = () => this.fail('Continuous audio processor failed');
      this.context.onstatechange = () => {
        if (this.opened && !this.stopped && this.context.state !== 'running')
          this.fail('Audio output is no longer running');
      };
      this.context.addEventListener?.('sinkchange', () => {
        if (this.opened && !this.stopped) this.fail('Audio output device changed');
      });
      this.node.connect(this.panner); this.panner.connect(this.gain); this.gain.connect(this.context.destination);
      await this.startupStep(this.context.resume());
      await this.command('ready');
      if (this.stopped) throw Error('PCM player was stopped during startup');
      if (this.context.state !== 'running') throw Error('Audio output could not start');
      this.opened = true; this.lastControlMs = this.now();
      this.timer = this.setIntervalFn(() => this.check(), 50);
      return this.snapshot();
    } catch (error) {
      this.fail(error.message || 'Continuous audio startup failed');
      await this.closePromise;
      throw error;
    }
  }

  async startupStep(task) {
    let timer;
    try {
      return await Promise.race([task,
        this.whenStopped.then(() => { throw Error('PCM player was stopped during startup'); }),
        new Promise((resolve, reject) => { timer = this.setTimeoutFn(() => reject(Error('Audio output startup timed out')), 5000); })]);
    } finally { this.clearTimeoutFn(timer); }
  }

  command(type, fields = {}, transfer = []) {
    if (this.stopped || !this.node) return Promise.reject(Error(this.latest.error || 'PCM player is closed'));
    const id = ++this.commandId;
    return new Promise((resolve, reject) => {
      if (this.pending.size >= 128) { reject(Error('PCM command queue is full')); this.fail('PCM command queue is full'); return; }
      const timer = this.setTimeoutFn(() => this.fail('PCM renderer did not acknowledge its command'), 2000);
      this.pending.set(id, {resolve, reject, timer});
      try { this.node.port.postMessage({type, token: this.token, id, ...fields}, transfer); }
      catch (error) { this.pending.delete(id); this.clearTimeoutFn(timer); reject(error); this.fail('PCM command could not reach the renderer'); }
    });
  }

  receive(message) {
    if (this.stopped || !message || message.token !== this.token) return;
    if (message.type === 'failure') {
      if (message.clockDiagnostic) this.latest = {...this.latest, clockDiagnostic: message.clockDiagnostic};
      this.fail(message.error || 'PCM renderer failed'); return;
    }
    if (message.type !== 'state') return;
    try {
      const s = message.snapshot;
      if (!s || s.sampleRate !== this.sampleRate || s.channels !== this.channels
          || !Number.isSafeInteger(s.playedFrames) || s.playedFrames < this.latest.playedFrames
          || !Number.isSafeInteger(s.receivedFrames) || s.receivedFrames < this.latest.receivedFrames
          || !Number.isSafeInteger(s.bufferedFrames) || s.bufferedFrames < 0
          || s.playedFrames > s.receivedFrames || s.receivedFrames > this.maxFrames
          || !Array.isArray(message.history) || message.history.length % 5)
        throw Error('Invalid PCM renderer state');
      for (let i = 0; i < message.history.length; i += 5)
        this.history.push(...message.history.slice(i, i + 5));
      this.latest = {...s, positionSeconds: this.heardFrames / this.sampleRate, ended: false};
      if (s.error) { this.fail(s.error); return; }
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); this.clearTimeoutFn(pending.timer); pending.resolve(this.latest); }
    } catch (error) {
      if (error.clockDiagnostic) this.latest = {...this.latest, clockDiagnostic: error.clockDiagnostic};
      this.fail(error.message || 'PCM clock failed');
    }
  }

  append(bytes, offsetFrames) {
    try {
      if (!this.opened || this.stopped || this.ending) throw Error('PCM player cannot accept audio');
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength % this.align
          || !Number.isSafeInteger(offsetFrames) || offsetFrames !== this.submittedFrames)
        throw Error('PCM append is malformed or out of order');
      const count = bytes.byteLength / this.align;
      if (this.submittedFrames + count > this.maxFrames) throw Error('PCM utterance exceeds its limit');
      // Own a copy before returning, even if the caller immediately reuses its
      // provider packet buffer. The ACK follows the worklet's ring copy.
      const owned = bytes.slice(); this.submittedFrames += count;
      return this.command('append', {offsetFrames, bytes: owned.buffer}, [owned.buffer]);
    } catch (error) { this.fail(error.message); return Promise.reject(error); }
  }

  control(value) {
    try {
      if (!this.opened || this.stopped) throw Error('PCM player is not open');
      if (this.now() - this.lastControlMs >= PCM_LIMITS.expireAfterMs) throw Error('Playback admission expired');
      this.admission = playbackControl(value); this.lastControlMs = this.now();
      this.holdSent = false;
      this.applyGain();
      void this.command('control', {value: this.admission}).catch(error => {
        if (!this.stopped) this.fail(error.message);
      });
    } catch (error) { this.fail(error.message); throw error; }
  }

  end(totalFrames) {
    try {
      if (!this.opened || this.stopped || !Number.isSafeInteger(totalFrames)
          || totalFrames < 1 || totalFrames !== this.submittedFrames) throw Error('Invalid PCM end sample count');
      this.ending = true;
      return this.command('end', {totalFrames});
    } catch (error) { this.fail(error.message); return Promise.reject(error); }
  }

  applyGain() {
    if (!this.context || !this.gain) return;
    // Admission/pausing is enforced by the source reader in the worklet. Muting
    // a separate node before that reader receives its pause would silently
    // discard a few consumed samples. Already-rendered device audio can drain.
    const volume = this.stopped ? 0 : this.admission.volume;
    if (this.appliedVolume !== volume) {
      this.gain.gain.setValueAtTime(volume, this.context.currentTime); this.appliedVolume = volume;
    }
    if (this.appliedPan !== this.admission.pan) {
      this.panner.pan.setValueAtTime(this.admission.pan, this.context.currentTime); this.appliedPan = this.admission.pan;
    }
  }

  outputTime() {
    const context = this.context;
    if (!context) return 0;
    const stamp = context.getOutputTimestamp?.();
    if (Number.isFinite(stamp?.contextTime) && stamp.contextTime > 0
        && Number.isFinite(stamp.performanceTime) && stamp.performanceTime >= 0) {
      const age = Math.max(0, Math.min(.1, (this.now() - stamp.performanceTime) / 1000));
      return Math.max(0, Math.min(context.currentTime, stamp.contextTime + age));
    }
    const latency = Math.max(0, context.baseLatency || 0) + Math.max(0, context.outputLatency || 0);
    // Be conservative before the device supplies its first correlated clock.
    return Math.max(0, context.currentTime - latency - 128 / this.sampleRate);
  }

  snapshot() {
    if (!this.stopped && this.opened) {
      try {
        this.heardFrames = Math.max(this.heardFrames, Math.min(this.latest.playedFrames, this.history.at(this.outputTime())));
        if (this.latest.state === 'drained' && this.ending && this.heardFrames >= this.submittedFrames - .001) {
          this.heardFrames = this.submittedFrames;
          this.latest = {...this.latest, state: 'ended', ended: true};
          void this.teardown();
        }
      } catch { this.fail('Audio output clock is unavailable'); }
    }
    return {...this.latest, state: this.latest.state === 'drained' ? 'draining' : this.latest.state,
      positionSeconds: this.sampleRate ? this.heardFrames / this.sampleRate : 0};
  }

  check() {
    if (this.stopped) return;
    if (this.now() - this.lastControlMs >= PCM_LIMITS.expireAfterMs && this.latest.state !== 'drained') {
      this.fail('Playback admission expired'); return;
    }
    try {
      if (!this.holdSent && this.now() - this.lastControlMs >= PCM_LIMITS.holdAfterMs) {
        this.holdSent = true;
        void this.command('hold').catch(error => { if (!this.stopped) this.fail(error.message); });
      }
      this.snapshot();
    }
    catch { this.fail('Audio output control failed'); }
  }

  fail(message) {
    if (this.stopped) return;
    this.latest = {...this.latest, state: 'error', error: message || 'Continuous PCM playback failed', ended: false};
    void this.teardown();
  }

  stop(reason = 'stopped') {
    if (!this.stopped) this.latest = {...this.latest, state: 'stopped', ended: false};
    return this.teardown();
  }

  teardown() {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; this.latest = {...this.latest, bufferedFrames: 0};
    this.resolveStopped(); this.clearIntervalFn(this.timer);
    for (const pending of this.pending.values()) {
      this.clearTimeoutFn(pending.timer); pending.reject(Error(this.latest.error || 'PCM playback ended'));
    }
    this.pending.clear();
    try { this.node?.port.postMessage({type: 'stop', token: this.token, id: ++this.commandId}); } catch {}
    try { this.node?.disconnect(); } catch {}
    try { this.panner?.disconnect(); } catch {}
    try { this.gain?.disconnect(); } catch {}
    try { this.node?.port.close(); } catch {}
    this.closePromise = Promise.resolve().then(async () => {
      try { if (this.context && this.context.state !== 'closed') await this.context.close(); } catch {}
    });
    return this.closePromise;
  }
}
