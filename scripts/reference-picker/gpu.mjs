// "Is something else holding the GPU?" for the render queue. Reads nvidia-smi only; never starts GPU work.
import {execFile} from 'node:child_process';

export class GpuMonitor {
  // busyFraction: busy when more than this share of VRAM is in use by anything; minFreeMiB: or when less than this is free
  // (OmniVoice FP16 needs roughly 3.5 GB plus headroom).
  constructor({busyFraction = 0.6, minFreeMiB = 4500, ttlMs = 4000, run = execFile} = {}) {
    Object.assign(this, {busyFraction, minFreeMiB, ttlMs, run});
    this.cached = null; this.at = 0;
  }
  read() {
    return new Promise(done => this.run('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], {timeout: 5000}, (error, out) => {
      if (error) return done(null);
      const [used, total] = String(out).trim().split('\n')[0].split(',').map(Number);
      done(Number.isFinite(used) && Number.isFinite(total) && total > 0 ? {usedMiB: used, totalMiB: total} : null);
    }));
  }
  // ownResident: our own OmniVoice worker already holds its share, so more renders do not need new room.
  async status({ownResident = false} = {}) {
    if (!this.cached || Date.now() - this.at > this.ttlMs) { this.cached = await this.read(); this.at = Date.now(); }
    const reading = this.cached;
    if (!reading) return {known: false, busy: false, reason: 'no GPU reading (nvidia-smi unavailable)'};
    const {usedMiB, totalMiB} = reading, free = totalMiB - usedMiB;
    const busy = !ownResident && (usedMiB / totalMiB > this.busyFraction || free < this.minFreeMiB);
    return {known: true, busy, usedMiB, totalMiB, ownResident,
      reason: busy ? `GPU busy: ${(usedMiB / 1024).toFixed(1)} of ${(totalMiB / 1024).toFixed(1)} GB in use by another process` : null};
  }
}
