// Text-derived mouth shapes for the game-trained facial model (docs/LIPSYNC_APPLICATION_2026-10-15.md, "Text visemes").
//
// The model's second stage (jali-face-text.mjs) already aligns the reply text to the audio: every 10 ms head row carries the
// phone the words say there, how far the audio's own best phone is from it (the margin) and whether the alignment still
// holds. This pass reads those decisions and strengthens four shapes the model reaches only part of the time:
//   rounding (UW OW W, weaker for AW AO UH): funnel and purse are added on the vowel, timed from the aligned phone;
//   SH CH JH ZH: funnel, as the game's own curves do;
//   M B P: the model's own closure is lifted towards full contact (its timing is kept: only its height changes);
//   F V: the model's lower-lip contact is lifted the same way, with the lip roll that goes with it.
// It only ever adds: every control is max(model, shape) or model * gain, then capped at the playback limits. It runs
// beside the model on the bridge (in the facial worker), so the game plays the timeline it already receives: no
// per-frame work there. Cost is a few multiplications per row; stats() reports it.
//
// Latency: a stream-mode phone is decided 3 rows after its row; the shape also needs LOOK rows ahead for its ramp. The
// rows are therefore released LOOK rows behind the decisions (about 30 ms of face coverage while the alignment holds;
// the first audio never waits for the face). When no text is aligned, or the alignment is given up, rows go out at once.

// Output order of the model's mouth rows (scripts/lipsync/lipsync_model.py OUTPUTS).
export const OUT = Object.freeze({jaw: 0, up: 1, dn: 2, purse: 3, funnel: 4, suckDn: 10});
// Caps = JALI_LIMITS of the output's native controls (bridge/jali-face.mjs; a test keeps the two equal).
export const CAPS = Object.freeze({jaw: .7, up: 1, dn: 1, purse: .5, funnel: .5, suckDn: .8});

// Heights are the game's own medians for the phone (game corpus, 6,584 lines; phone peaks of its authored curves):
// purse UW .25 OW .22 W .25 AW .25 AO .14 UH .11; funnel SH CH JH ZH .21; contacts 1.0; lip roll F .39 V .32.
// Purse heights are model units: the Lua writer scales the model's purse by 1.35 (mod/facial-playback.lua modelReach), so
// UW's .30 is written at about .40.
// The rounded vowels also get funnel, which the game's own curves leave at zero there, so that "oo" reads as a round
// opening from the front (the purse alone points the lips at the camera).
export const RECIPES = Object.freeze({
  UW: {kind: 'round', purse: .30, funnel: .24}, W: {kind: 'round', purse: .30, funnel: .22},
  OW: {kind: 'round', purse: .26, funnel: .20}, AW: {kind: 'round', purse: .20, funnel: .10},
  AO: {kind: 'round', purse: .18, funnel: .12}, UH: {kind: 'round', purse: .16, funnel: .10},
  SH: {kind: 'round', purse: 0, funnel: .22}, CH: {kind: 'round', purse: 0, funnel: .20},
  JH: {kind: 'round', purse: 0, funnel: .20}, ZH: {kind: 'round', purse: 0, funnel: .20},
  M: {kind: 'close'}, B: {kind: 'close'}, P: {kind: 'close'},
  F: {kind: 'tuck', roll: .35}, V: {kind: 'tuck', roll: .30},
});
export const VISEME_CONFIG = Object.freeze({
  rise: 3, fall: 3, look: 3, history: 8,
  // Multiplies the funnel heights of RECIPES (1 = the table as written). Tuned by eye on the staged companion: the game's own
  // funnel is rare, so a table height alone left "oo" reading as a small opening; at 1.4 it is a round opening.
  funnelScale: 1.4,
  // Alignment trust: the mean margin of the phone's rows, in nats. At or under .6 the phones were right 90 to 95 % of the
  // time on held-out clones; at 1.0 and above 60 to 85 %. Full trust to .6, none from 2.
  marginFull: .6, marginNone: 2,
  // The model must already be speaking where a rounded shape is added (written jaw), so a misplaced word adds nothing to a
  // closed mouth.
  jawOpen: .03, jawFull: .10,
  // Closures and tucks are lifted only where the model shows a part of one; the lift never exceeds this factor.
  minPeak: .30, maxGain: 2.5, doneAt: .97,
});

// Raise output `o` of the row at `at` to `value`, at most `limit`; never lower it.
function raise(out, at, o, value, limit) { const v = value < limit ? value : limit; if (v > out[at + o]) out[at + o] = v; }
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

export class VisemeOverlay {
  constructor({phones, outputs, config = VISEME_CONFIG}) {
    Object.assign(this, {outputs, config});
    this.recipe = Array.from(phones, name => RECIPES[name] ?? null);
    this.held = new Float32Array(0); this.base = 0; this.emitted = 0; this.total = 0;
    this.runs = []; this.open = null; this.scanned = 0; this.first = 0;
    this.ms = 0; this.counts = {round: 0, close: 0, tuck: 0}; this.changedRows = 0;
  }

  stats() {
    return {ms: Math.round(this.ms * 100) / 100, segments: {...this.counts}, rowsChanged: this.changedRows};
  }

  // Turn the aligner's new decisions into runs of one phone (`[s, e)` head rows, `trust` from the margins).
  scan(aligner) {
    const {labels, codes, margins} = aligner, end = labels.length, {marginFull, marginNone} = this.config;
    const close = run => {
      const mean = run.marginSum / (run.e - run.s), trust = smooth((marginNone - mean) / (marginNone - marginFull));
      run.trust = trust; run.closed = true;
      if (run.e - run.s >= 2 && trust > 0) { this.runs.push(run); this.counts[run.recipe.kind]++; }
    };
    for (let j = this.scanned; j < end; j++) {
      const recipe = codes[j] === 1 ? this.recipe[labels[j]] : null, open = this.open;
      if (open && recipe === open.recipe && labels[j] === open.label) { open.e = j + 1; open.marginSum += margins[j]; continue; }
      if (open) { close(open); this.open = null; }
      if (recipe) this.open = {recipe, label: labels[j], s: j, e: j + 1, marginSum: margins[j], closed: false, trust: 0};
    }
    this.scanned = end;
  }

  // The open run is used from its second row; its trust is that of the rows seen so far.
  active(run) { return run.closed || (run.e - run.s >= 2 && this.trustOf(run) > 0); }
  trustOf(run) {
    if (run.closed) return run.trust;
    const {marginFull, marginNone} = this.config;
    return smooth((marginNone - run.marginSum / (run.e - run.s)) / (marginNone - marginFull));
  }

  // 0 outside [s - rise, e + fall], 1 from s to e - 1, raised-cosine ramps between.
  shape(run, r) {
    const {rise, fall} = this.config, e = run.closed ? run.e : Infinity;
    if (r < run.s) return r < run.s - rise ? 0 : smooth((r - (run.s - rise) + 1) / (rise + 1));
    if (r < e) return 1;
    return r >= e + fall ? 0 : smooth((e + fall - r) / (fall + 1));
  }

  // Highest model contact (`column`, or the lower of `column` and `other`) over the rows a run can cover; history rows are
  // kept for this. A closed run whose rows have all arrived is measured once.
  peak(run, column, other = -1) {
    if (run.peak !== undefined) return run.peak;
    const {rise, fall} = this.config, O = this.outputs, held = this.held, lo = Math.max(this.base, run.s - rise);
    const end = (run.closed ? run.e : this.scanned) + fall, hi = Math.min(this.total - 1, end);
    let top = 0;
    for (let r = lo; r <= hi; r++) {
      const at = (r - this.base) * O, v = other < 0 ? held[at + column] : Math.min(held[at + column], held[at + other]);
      if (v > top) top = v;
    }
    if (run.closed && hi === end && lo === run.s - rise) run.peak = top;
    return top;
  }

  // Append `rows` (the model's output, `count` rows) and return the rows that can leave now, shapes added.
  run(rows, aligner, {final = false} = {}) {
    const started = performance.now(), O = this.outputs, count = rows.length / O;
    if (count) {
      const joined = new Float32Array(this.held.length + rows.length);
      joined.set(this.held); joined.set(rows, this.held.length); this.held = joined; this.total += count;
    }
    if (aligner) {
      if (final && aligner.delta !== null && aligner.labels.length < this.total) aligner.finish();
      this.scan(aligner);
      if (final && this.open) { this.open.e = Math.max(this.open.e, this.scanned); this.runs.push(this.finalise(this.open)); this.open = null; }
    }
    const decided = aligner ? aligner.labels.length : 0;
    // Hold the rows only while the alignment is live and has decisions to wait for.
    const waiting = aligner && !aligner.lost && !final;
    const limit = waiting ? Math.max(this.emitted, Math.min(this.total, decided - this.config.look)) : this.total;
    const out = new Float32Array(Math.max(0, limit - this.emitted) * O);
    for (let r = this.emitted; r < limit; r++) this.row(r, out, (r - this.emitted) * O);
    this.emitted = limit;
    this.trim();
    this.ms += performance.now() - started;
    return out;
  }

  finalise(run) {
    const {marginFull, marginNone} = this.config;
    run.closed = true; run.trust = smooth((marginNone - run.marginSum / (run.e - run.s)) / (marginNone - marginFull));
    if (run.e - run.s >= 2 && run.trust > 0) this.counts[run.recipe.kind]++; else run.trust = 0;
    return run;
  }

  // Row r of the model, with the shapes added into `out` at `at`.
  row(r, out, at) {
    const O = this.outputs, from = (r - this.base) * O, held = this.held, cfg = this.config, {rise, fall, minPeak, maxGain, doneAt} = cfg;
    out.set(held.subarray(from, from + O), at);
    const speaking = smooth((held[from + OUT.jaw] - cfg.jawOpen) / (cfg.jawFull - cfg.jawOpen));
    let funnel = 0, purse = 0, gainClose = 1, gainDn = 1, roll = 0, k = this.first;
    const runs = this.runs, count = runs.length + (this.open ? 1 : 0);
    for (; k < count; k++) {
      const run = k < runs.length ? runs[k] : this.open;
      if (run.s - rise > r) break;
      if (run.closed ? r >= run.e + fall : !this.active(run)) continue;
      const w = this.shape(run, r);
      if (w <= 0) continue;
      const trust = this.trustOf(run), kind = run.recipe.kind;
      if (kind === 'round') {
        const g = w * trust * speaking;
        if (run.recipe.funnel * g * cfg.funnelScale > funnel) funnel = run.recipe.funnel * g * cfg.funnelScale;
        if (run.recipe.purse * g > purse) purse = run.recipe.purse * g;
      } else if (kind === 'close') {
        const top = this.peak(run, OUT.up, OUT.dn);
        if (top >= minPeak && top < doneAt) gainClose = Math.max(gainClose, 1 + (Math.min(maxGain, 1 / top) - 1) * w * trust);
      } else {
        const top = this.peak(run, OUT.dn);
        if (top >= minPeak && top < doneAt) gainDn = Math.max(gainDn, 1 + (Math.min(maxGain, 1 / top) - 1) * w * trust);
        if (top >= minPeak) roll = Math.max(roll, run.recipe.roll * w * trust);
      }
    }
    // Only ever up: a control is raised to the shape (or by the gain), never lowered, and never past its playback cap
    // unless the model itself already was.
    if (funnel > 0) raise(out, at, OUT.funnel, funnel, CAPS.funnel);
    if (purse > 0) raise(out, at, OUT.purse, purse, CAPS.purse);
    if (roll > 0) raise(out, at, OUT.suckDn, roll, CAPS.suckDn);
    if (gainClose > 1) { raise(out, at, OUT.up, held[from + OUT.up] * gainClose, CAPS.up); raise(out, at, OUT.dn, held[from + OUT.dn] * gainClose, CAPS.dn); }
    if (gainDn > 1) raise(out, at, OUT.dn, held[from + OUT.dn] * gainDn, CAPS.dn);
    if (funnel > 0 || purse > 0 || roll > 0 || gainClose > 1 || gainDn > 1) this.changedRows++;
  }

  // Every row not yet released, unchanged: the model's own output, for a failure or an ended text path.
  release() {
    const O = this.outputs, rows = this.held.slice((this.emitted - this.base) * O, (this.total - this.base) * O);
    this.emitted = this.total; this.held = new Float32Array(0); this.base = this.total; this.runs = []; this.open = null; this.first = 0;
    return rows;
  }

  // Drop rows (keeping `history`) and runs that can no longer touch a row to come.
  trim() {
    const O = this.outputs, keepFrom = Math.max(this.base, this.emitted - this.config.history);
    if (keepFrom > this.base) { this.held = this.held.slice((keepFrom - this.base) * O); this.base = keepFrom; }
    const {fall} = this.config;
    while (this.first < this.runs.length && this.runs[this.first].e + fall + 1 < this.emitted) this.first++;
    if (this.first > 64) { this.runs.splice(0, this.first); this.first = 0; }
  }
}

// Runs a short synthetic reply through a throwaway overlay so the first real reply does not pay for compiling this code
// (a cold 6 s reply cost about 5 ms; a warm one about 1 ms). Called once when the facial worker starts.
export function warmVisemes(phones, outputs) {
  const overlay = new VisemeOverlay({phones, outputs}), names = ['UW', 'M', 'F', 'OW', 'B', 'SH', 'V', 'W'];
  const labels = [], codes = [], margins = [];
  for (let n = 0; n < 8; n++) for (let r = 0; r < 12; r++) { labels.push(Math.max(0, phones.indexOf(names[n]))); codes.push(1); margins.push(.1); }
  const aligner = {labels: [], codes: [], margins: [], lost: false, delta: null, finish() {}};
  const rows = new Float32Array(12 * outputs);
  for (let r = 0; r < 12; r++) { rows[r * outputs + OUT.jaw] = .2; rows[r * outputs + OUT.up] = rows[r * outputs + OUT.dn] = .5; }
  for (let at = 0; at < labels.length; at += 12) {
    for (let r = 0; r < 12; r++) { aligner.labels.push(labels[at + r]); aligner.codes.push(1); aligner.margins.push(.1); }
    overlay.run(rows, aligner);
  }
  overlay.run(new Float32Array(0), aligner, {final: true});
}
