import {randomUUID} from 'node:crypto';
import {storeSpeech, SLOT_COUNT} from './speech-audio.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {cancelled, throwIfCancelled} from './transport-pool.mjs';

export function splitSpeechText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw Error('Invalid speech text');
  const words = text.trim().split(/\s+/), phrases = [];
  let start = 0;
  while (start < words.length) {
    const first = !phrases.length, min = first ? 6 : 12, target = first ? 12 : 22, max = first ? 22 : 34;
    let end = Math.min(words.length, start + max), lastClause;
    for (let at = start; at < end; at++) {
      const count = at - start + 1;
      if (count >= min && /[.!?。！？]["'”’)]*$/.test(words[at])) { end = at + 1; break; }
      if (count >= min && /[,;:，；：—]["'”’)]*$/.test(words[at])) {
        lastClause = at + 1;
        if (count >= target) { end = lastClause; break; }
      }
      if (count === max && lastClause) end = lastClause;
    }
    // Avoid an isolated two-word tail, which sounds like a second sentence.
    if (words.length - end < 4) end = words.length;
    phrases.push(words.slice(start, end).join(' ')); start = end;
  }
  if (phrases.length > 32) throw Error('Reply exceeds the phrase limit');
  return phrases;
}

// Eight on-demand WAV files are shared by streamed and ordinary replies.
// A lease lasts until the consumer acknowledges that exact chunk, or its
// utterance is superseded. Allocation/writes are serialized across producers.
export class SpeechSlots {
  constructor({depot, readState, store = storeSpeech}) {
    Object.assign(this, {depot, readState, store});
    this.leases = new Map(); this.tail = Promise.resolve(); this.next = 0;
  }
  locked(task) {
    const job = this.tail.then(task); this.tail = job.catch(() => {}); return job;
  }
  begin(id, current) {
    return this.locked(async () => {
      if (!await current()) throw cancelled();
      this.owner = id; this.leases.clear();
    });
  }
  write(id, index, audio, current) {
    return this.locked(async () => {
      if (id !== this.owner || !await current()) throw cancelled();
      const state = await this.readState();
      for (const [slot, lease] of this.leases) {
        if (state.streamId === id && state.completedChunk >= lease.index) this.leases.delete(slot);
      }
      let slot;
      for (let n = 0; n < SLOT_COUNT; n++) {
        const candidate = (this.next + n) % SLOT_COUNT;
        if (!this.leases.has(candidate) && !(state.requestId && state.slot === candidate)) { slot = candidate; break; }
      }
      if (slot === undefined) throw Error('All speech slots are still in use');
      this.leases.set(slot, {id, index}); this.next = (slot + 1) % SLOT_COUNT;
      const stored = await this.store(audio, this.depot, slot);
      if (id !== this.owner || !await current()) throw cancelled();
      return stored;
    });
  }
}

export class SpeechStream {
  constructor({input, phrases, steps, slots, readState, writeManifest, synthesize, current,
    signal, now = Date.now, wait = ms => new Promise(done => setTimeout(done, ms))}) {
    Object.assign(this, {input, phrases, steps, slots, readState, writeManifest, synthesize, current, signal, now, wait});
    this.manifest = {version: 1, streamId: randomUUID(), requestId: input.requestId,
      generation: input.generation, entity: input.entity, total: phrases.length, complete: false, chunks: []};
    this.started = now(); this.totalDuration = 0; this.accepted = false;
  }
  async assertCurrent() {
    throwIfCancelled(this.signal);
    if (!await this.current()) throw cancelled();
  }
  async publish() {
    await this.assertCurrent();
    await this.writeManifest({...this.manifest, updated: this.now()});
  }
  async append(result) {
    await this.assertCurrent();
    const index = this.manifest.chunks.length + 1;
    const audio = await this.slots.write(this.manifest.streamId, index, result.audio, this.current);
    this.totalDuration += audio.duration;
    if (this.totalDuration > 120) throw Error('Speech exceeded two minutes');
    let face;
    try { face = buildFacialTimeline(result, this.input); } catch { /* Voice can continue without face data. */ }
    const chunk = {index, text: this.phrases[index - 1], audio, face, timing: result.timing, readyAt: this.now()};
    this.manifest.chunks.push(chunk);
    this.manifest.complete = index === this.phrases.length;
    await this.publish();
    return chunk;
  }
  async begin(first) {
    await this.slots.begin(this.manifest.streamId, this.current);
    return this.append(first);
  }
  async room() {
    let waitingSince = this.now();
    for (;;) {
      await this.assertCurrent();
      const state = await this.readState(), matching = state.streamId === this.manifest.streamId;
      const fresh = Number.isFinite(state.updated) && this.now() - state.updated < 7000;
      if (matching && fresh) {
        this.accepted = true;
        if (!state.requestId || !['starting', 'playing', 'buffering'].includes(state.state)) throw cancelled('Speech playback ended');
        if (!Number.isInteger(state.completedChunk) || state.completedChunk < 0
            || state.completedChunk > this.manifest.chunks.length) throw Error('Invalid speech acknowledgement');
        // One playing chunk and at most two ready chunks. A long pause cannot
        // consume every slot or let synthesis run to the end of a long reply.
        if (this.manifest.chunks.length - state.completedChunk < 3) return;
        if (state.paused) waitingSince = this.now();
      } else if (this.accepted && !fresh) throw cancelled('Speech consumer disappeared');
      else if (!this.accepted && this.manifest.chunks.length < 2) return;
      if (this.now() - waitingSince > 45000) throw Error('Speech consumer did not advance');
      await this.wait(75);
    }
  }
  async finish() {
    try {
      while (!this.manifest.complete) {
        await this.room();
        const index = this.manifest.chunks.length;
        const result = await this.synthesize(this.phrases[index], {signal: this.signal, steps: this.steps});
        await this.assertCurrent();
        await this.append(result);
      }
    } catch (error) {
      if (this.signal?.aborted || !await this.current() || error.name === 'AbortError') return;
      // The first phrase was already heard. Preserve it and explicitly finish
      // the partial stream instead of replacing reply.json with an error turn.
      this.manifest.complete = true;
      this.manifest.error = 'The rest of the voice reply could not be prepared.';
      await this.publish();
      this.error = error.message;
    }
  }
  descriptor() {
    return {version: 1, id: this.manifest.streamId, total: this.phrases.length,
      firstText: this.phrases[0]};
  }
}
