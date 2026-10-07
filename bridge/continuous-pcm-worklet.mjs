import {ContinuousPcmCore, PcmQuantumClock} from './continuous-pcm-core.mjs';

class ConvaiContinuousPcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.clock = new PcmQuantumClock(options.processorOptions.sampleRate);
    this.core = new ContinuousPcmCore({...options.processorOptions,
      nowMs: this.clock.controlTime(currentFrame) * 1000});
    this.token = options.processorOptions.token;
    this.history = []; this.lastReport = -1; this.done = false;
    this.port.onmessage = ({data}) => {
      if (!data || data.token !== this.token || !Number.isSafeInteger(data.id)) return;
      try {
        if (this.done) throw Error('PCM stream is closed');
        switch (data.type) {
          case 'ready': break;
          case 'append': this.core.append(new Uint8Array(data.bytes), data.offsetFrames); break;
          case 'arm': this.core.arm(this.clock.controlTime(currentFrame) * 1000); break;
          case 'control': this.core.control(data.value, this.clock.controlTime(currentFrame) * 1000); break;
          case 'hold': this.core.hold(); break;
          case 'end': this.core.end(data.totalFrames); break;
          case 'stop': this.core.stop(); this.done = true; break;
          default: throw Error('Unknown PCM command');
        }
        this.report(data.id);
      } catch (error) {
        this.fail(error, data.id);
      }
    };
  }
  report(id) {
    const history = this.history; this.history = [];
    this.port.postMessage({type: 'state', token: this.token, id,
      snapshot: {...this.core.snapshot(), ...this.clock.snapshot()}, history});
    this.lastReport = this.clock.controlTime(currentFrame);
  }
  fail(error, id) {
    this.core.stop(); this.done = true;
    this.port.postMessage({type: 'failure', token: this.token, id,
      error: error.message || 'PCM renderer failed', clockDiagnostic: error.clockDiagnostic});
  }
  process(inputs, outputs) {
    if (this.done) return false;
    try {
      const time = this.clock.next(currentFrame, outputs[0]?.[0]?.length ?? 0);
      const segment = this.core.render(outputs[0], time);
      this.history.push(segment.start, segment.end, segment.from, segment.to, segment.advancingEnd);
      if (time - this.lastReport >= .02 || this.core.error) this.report();
      if (this.core.error) this.done = true;
    } catch (error) {
      for (const channel of outputs[0] ?? []) channel.fill(0);
      this.fail(error);
    }
    return !this.done;
  }
}

registerProcessor('convai-continuous-pcm', ConvaiContinuousPcm);
