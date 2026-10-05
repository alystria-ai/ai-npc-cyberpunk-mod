// Engines that render short tones instead of speech, for trying the page and its queue without touching the CPU
// models or the GPU (node scripts/Reference-Picker.mjs --fake-render). Reference audio is built for real; only the
// speech synthesis is faked.
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {encodeWav} from './audio.mjs';
import {Engines} from './engines.mjs';

const tone = (seconds, pitch) => encodeWav(Float32Array.from({length: Math.round(seconds * 24000)},
  (_, at) => Math.sin(2 * Math.PI * pitch * at / 24000) * 0.25 * Math.min(1, at / 2400, (seconds * 24000 - at) / 2400)), 24000);

export class FakeEngines extends Engines {
  constructor(options) { super({...options, delayMs: undefined}); this.delayMs = options.delayMs ?? 900; }
  async put(path, pitch) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(`${path}.part`, tone(1.6, pitch)); await rename(`${path}.part`, path);
  }
  async runPocket(items, {onItem = () => {}} = {}) {
    this.state.pocket = 'rendering';
    try {
      for (const item of items) {
        await new Promise(done => setTimeout(done, this.delayMs));
        await this.put(item.out, 220);
        await onItem(item, {seconds: 1.6, tookMs: this.delayMs});
      }
    } finally { this.state.pocket = 'idle'; }
  }
  async renderOmni(item) {
    this.state.omni = 'rendering';
    try { await new Promise(done => setTimeout(done, this.delayMs * 1.5)); await this.put(item.out, item.steps === 16 ? 330 : 440); }
    finally { this.state.omni = 'idle'; }
    return {seconds: 1.6, tookMs: this.delayMs * 1.5};
  }
  async close() {}
}
