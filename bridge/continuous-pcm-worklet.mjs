import {ContinuousPcmCore} from './continuous-pcm-core.mjs';

class ConvaiContinuousPcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.core = new ContinuousPcmCore({...options.processorOptions, nowMs: currentTime * 1000});
    this.token = options.processorOptions.token;
    this.history = []; this.lastReport = -1; this.done = false;
    this.port.onmessage = ({data}) => {
      if (!data || data.token !== this.token || !Number.isSafeInteger(data.id)) return;
      try {
        if (this.done) throw Error('PCM stream is closed');
        switch (data.type) {
          case 'ready': break;
          case 'append': this.core.append(new Uint8Array(data.bytes), data.offsetFrames); break;
          case 'control': this.core.control(data.value, currentTime * 1000); break;
          case 'hold': this.core.hold(); break;
          case 'end': this.core.end(data.totalFrames); break;
          case 'stop': this.core.stop(); this.done = true; break;
          default: throw Error('Unknown PCM command');
        }
        this.report(data.id);
      } catch (error) {
        this.core.stop(); this.done = true;
        this.port.postMessage({type: 'failure', token: this.token, id: data.id,
          error: error.message || 'PCM renderer failed'});
      }
    };
  }
  report(id) {
    const history = this.history; this.history = [];
    this.port.postMessage({type: 'state', token: this.token, id, snapshot: this.core.snapshot(), history});
    this.lastReport = currentTime;
  }
  process(inputs, outputs) {
    if (this.done) return false;
    const segment = this.core.render(outputs[0], currentTime);
    this.history.push(segment.start, segment.end, segment.from, segment.to, segment.advancingEnd);
    if (currentTime - this.lastReport >= .02 || this.core.error) this.report();
    if (this.core.error) this.done = true;
    return !this.done;
  }
}

registerProcessor('convai-continuous-pcm', ConvaiContinuousPcm);
