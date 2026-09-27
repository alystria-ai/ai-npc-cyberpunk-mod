class ConvaiCapture extends AudioWorkletProcessor {
  constructor() { super(); this.data = new Float32Array(1024); this.used = 0; this.at = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      if (!this.used) this.at = currentTime + i / sampleRate;
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.data[this.used++] = value / channels.length;
      if (this.used === this.data.length) {
        this.port.postMessage({at: this.at, pcm: this.data}, [this.data.buffer]);
        this.data = new Float32Array(1024); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('convai-capture', ConvaiCapture);
