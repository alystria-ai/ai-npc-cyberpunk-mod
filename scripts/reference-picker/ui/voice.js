'use strict';
// Character page: choose and compare the reference clips of one character, one simple flow per engine (Pocket, OmniVoice).
// Served at /voice/<key>; the main report links here in a new tab. Helpers live in common.js. Behind the plain wording each
// clip-count choice maps onto the picker's set ids (pocket / pocket-short / pocket-single, omni / omni-short / omni-single),
// so the action log and Apply-ReferencePicks.mjs are unchanged.

const key = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '');
const ENGINES = [
  {id: 'pocket', name: 'Pocket', about: 'Runs on the computer’s processor.', tradeoff: 'More clips cost nothing extra with Pocket.', sets: {1: 'pocket-single', 2: 'pocket-short', 3: 'pocket'}},
  {id: 'omni', name: 'OmniVoice', about: 'Runs on the graphics card.', tradeoff: 'More clips can sound more like the character, but OmniVoice then starts speaking a little later.', sets: {1: 'omni-single', 2: 'omni-short', 3: 'omni'}},
];
const LENGTHS = [
  {n: 1, label: '1 clip', detail: 'one line of up to about 9 s'},
  {n: 2, label: '2 clips', detail: 'about 10 s'},
  {n: 3, label: '3 clips', detail: 'about 18 s'},
];
const SET_INFO = {
  pocket: {n: 3, slots: ['pocket']}, 'pocket-short': {n: 2, slots: ['pockets']}, 'pocket-single': {n: 1, slots: ['pocket1']},
  omni: {n: 3, slots: ['omni16', 'omni32']}, 'omni-short': {n: 2, slots: ['omni16s', 'omni32s']}, 'omni-single': {n: 1, slots: ['omni16one', 'omni32one']},
};
const BUDGET = {1: 9, 2: 10, 3: 18};
const slotLabel = slot => slot.startsWith('pocket') ? 'Pocket' : slot.startsWith('omni16') ? 'OmniVoice, 16 steps' : 'OmniVoice, 32 steps';

const state = {card: null, line: 0, lengths: store.get('lengths', {}), autogen: store.get('autogen', true) !== false,
  poolClips: null, poolOpen: {}, pool: {}, ticks: {}, pending: false};
const lengthOf = engine => [1, 2, 3].includes(state.lengths[engine.id]) ? state.lengths[engine.id] : 3;

// ---- loading and rendering --------------------------------------------------------------------------------------------------
async function loadCard() { setCard(await api(`/api/voice/${key}?line=${state.line}`)); }
function setCard(card, force = false) { state.card = card; render(force); }
const busy = () => [...document.querySelectorAll('audio')].some(audio => !audio.paused) || !!document.activeElement?.matches?.('input[type=search], textarea, select');
function render(force = false) {
  if (!force && busy()) { state.pending = true; return; }
  state.pending = false; build();
}
for (const type of ['pause', 'ended']) document.addEventListener(type, () => { if (state.pending) setTimeout(() => render(), 0); }, true);
document.addEventListener('focusout', () => { if (state.pending) setTimeout(() => render(), 0); });

async function act(action, body = {}, message, {undo = null} = {}) {
  try {
    const card = await api(`/api/voice/${key}/${action}`, {...body, line: state.line});
    setCard(card, true);
    if (message) toast(message, {undo});
    return card;
  } catch (error) { toast(error.message, {bad: true}); return null; }
}

// ---- pieces -----------------------------------------------------------------------------------------------------------------
function clipList(clips) {
  return h('div', {class: 'cliplist'}, clips.map((clip, at) => h('div', {class: 'clip'},
    clip.missing ? h('div', {class: 'muted'}, `${clip.id} (missing)`) : audioEl(clip.audio, {voice: key, what: 'clip', target: clip.id}),
    h('div', {}, h('div', {}, clip.transcript),
      h('div', {class: 'meta'}, `${at + 1}. ${clip.label ?? shortId(clip.id)} · ${seconds(clip.seconds)}`,
        clip.loudness !== null && clip.loudness !== undefined && Math.abs(clip.loudness) > 3 ? h('span', {class: 'warn', title: 'Much louder or quieter than this character’s usual clips; that tends to make OmniVoice worse.'}, ` · loudness ${clip.loudness > 0 ? '+' : ''}${clip.loudness.toFixed(1)} dB`) : null)))));
}
function autogenToggle() {
  const box = h('input', {type: 'checkbox', class: 'autogen', checked: state.autogen, onchange: event => {
    state.autogen = event.target.checked; store.set('autogen', state.autogen);
    for (const other of document.querySelectorAll('input.autogen')) other.checked = state.autogen;
  }});
  return h('label', {class: 'check', title: 'Make the samples as soon as new clips are drawn or chosen'}, box, 'Generate samples automatically');
}

// What is going on for this engine, in plain words, from the render jobs of this character.
function statusText(engine) {
  const card = state.card, mine = new Set(Object.values(engine.sets).flatMap(set => SET_INFO[set].slots));
  const jobs = [card.jobs?.candidate, card.jobs?.current].filter(Boolean);
  for (const job of jobs) {
    if (job.requested && !job.requested.some(slot => mine.has(slot))) continue;
    const slots = job.slots.filter(item => mine.has(item.slot));
    if (!slots.length) { if (job.status === 'queued') return {text: 'Queued', working: true}; continue; }
    const failed = slots.find(item => item.state === 'error');
    if (failed) return {text: `Failed: ${failed.error ?? 'unknown error'}`, bad: true};
    const done = slots.filter(item => item.state === 'ready').length;
    if (job.status === 'waiting-gpu' && engine.id === 'omni') return {text: `GPU busy, waiting for it to free up (${job.waitReason ?? 'another program is using it'})`, working: true};
    if (slots.some(item => item.state === 'running')) return {text: `Generating sample ${done + 1} of ${slots.length}`, working: true};
    return {text: 'Queued', working: true};
  }
  const last = card.job;
  if (last && last.status === 'error' && last.slots.some(item => mine.has(item.slot) && item.state === 'error')) {
    return {text: `Failed: ${last.slots.find(item => mine.has(item.slot) && item.state === 'error').error ?? last.error ?? 'unknown error'}`, bad: true};
  }
  return null;
}

function sampleCell(sample, slot, isCurrent, engine) {
  if (sample?.exists) {
    const research = sample.from === 'research';
    return [audioEl(sample.url, {voice: key, what: research ? 'research' : 'sample', target: research ? sample.cond : slot, ...(isCurrent && !research ? {current: '1'} : {})}),
      research ? h('div', {class: 'meta'}, 'from the research report') : null];
  }
  const text = {queued: 'Queued', running: 'Generating…', 'gpu-busy': 'GPU busy, waiting', error: `Failed: ${sample?.error ?? 'unknown error'}`}[sample?.state]
    ?? (isCurrent ? 'No current sample' : 'Not generated yet');
  const working = ['queued', 'running', 'gpu-busy'].includes(sample?.state);
  return [h('div', {class: 'state' + (working ? ' working' : '') + (sample?.state === 'error' ? ' warn' : '')}, text),
    isCurrent && !working ? h('button', {class: 'small', onclick: () => generate(engine, 'current'), title: 'Make a sample of the current clips with this engine'}, 'Generate') : null];
}

// ---- actions ----------------------------------------------------------------------------------------------------------------
function view(engine) {
  const card = state.card, n = lengthOf(engine), set = engine.sets[n];
  const current = card.current?.[set] ?? null, candidate = card.sets[set], kept = card.kept[set];
  return {n, set, slots: SET_INFO[set].slots, current, candidate, kept, hasNew: !!candidate && (!current || current.hasNew)};
}
async function generate(engine, target) {
  const v = view(engine), samples = target === 'current' ? v.current?.samples : state.card.samples;
  const every = v.slots.every(slot => samples?.[slot]?.exists && samples[slot].from !== 'research');
  await act('regenerate', {slots: v.slots, target, force: every}, 'Generating samples');
}
async function tryDifferent(engine) {
  const v = view(engine);
  const card = await act('reroll', {set: v.set}, null);
  if (!card) return;
  toast('New clips drawn');
  if (state.autogen) await act('regenerate', {slots: v.slots, target: 'candidate', force: false}, null);
}
function useThese(engine) {
  const v = view(engine), label = `${engine.name}, ${LENGTHS.find(item => item.n === v.n).label.toLowerCase()}`;
  const previous = v.current?.source === 'kept' ? v.current.ids : null;
  return act('keep', {engine: v.set, note: noteBox?.value}, `Using the new clips for ${label}`,
    {undo: () => previous ? act('keep', {engine: v.set, clips: previous}, 'Back to the earlier clips') : act('unkeep', {engine: v.set}, 'Back to the clips from before')});
}
const keepCurrent = engine => act('dismiss', {set: view(engine).set}, 'Keeping the current clips; the new clips will not be drawn again');

// ---- hand-picking -----------------------------------------------------------------------------------------------------------
function poolTable(engine, v, clips) {
  const set = v.set, count = SET_INFO[set].n, budget = BUDGET[count];
  const ps = state.pool[set] ??= {sort: 'typical', filter: '', source: 'all', limit: 150};
  const candidateKey = (v.candidate?.ids ?? []).join('|');
  if (state.ticks[set]?.from !== candidateKey) state.ticks[set] = {from: candidateKey, ids: new Set(v.candidate?.ids ?? [])};
  const selected = state.ticks[set].ids;
  const status = h('div', {class: 'total'}), body = h('tbody'), useButton = h('button', {class: 'primary', disabled: true});
  const sorter = {typical: (a, b) => (b.ty ?? -1) - (a.ty ?? -1), longest: (a, b) => b.d - a.d, shortest: (a, b) => a.d - b.d,
    words: (a, b) => b.t.length - a.t.length, loud: (a, b) => Math.abs(a.rel ?? 99) - Math.abs(b.rel ?? 99)};
  const total = () => [...selected].reduce((sum, id) => sum + (clips.find(clip => clip.id === id)?.d ?? 0), 0) + Math.max(0, selected.size - 1) * 0.4;
  function update() {
    const used = total(), over = used > budget + 1e-6;
    status.textContent = selected.size ? `${selected.size} clip${selected.size === 1 ? '' : 's'} ticked, ${seconds(used)} of ${budget} s${over ? ' (too long)' : ''}`
      : count === 1 ? 'Tick one clip.' : `Tick up to ${count} clips.`;
    useButton.disabled = !selected.size || over;
    useButton.textContent = 'Try the ticked clips';
    for (const box of body.querySelectorAll('input[type=checkbox]')) box.disabled = count > 1 && !box.checked && selected.size >= count;
  }
  function rows() {
    const needle = ps.filter.toLowerCase();
    const fromSource = clip => ps.source === 'all' || (ps.source === 'new') === (clip.s === 'expanded');
    const list = clips.filter(clip => fromSource(clip) && (!needle || clip.t.toLowerCase().includes(needle) || clip.id.includes(needle))).sort(sorter[ps.sort]);
    body.replaceChildren(...list.slice(0, ps.limit).map(clip => h('tr', {},
      h('td', {}, h('input', {type: 'checkbox', checked: selected.has(clip.id), 'aria-label': `Tick ${shortId(clip.id)}`, onchange: event => {
        if (event.target.checked) { if (count === 1) selected.clear(); selected.add(clip.id); } else selected.delete(clip.id);
        if (count === 1) rows(); else update();
      }})),
      h('td', {}, audioEl(clip.audio, {voice: key, what: 'clip', target: clip.id})),
      h('td', {}, seconds(clip.d)),
      h('td', {title: 'How typical of this character (0-100)'}, clip.ty == null ? '' : Math.round(clip.ty)),
      h('td', {class: clip.rel != null && Math.abs(clip.rel) > 3 ? 'warn' : ''}, clip.rel == null ? '' : `${clip.rel > 0 ? '+' : ''}${clip.rel.toFixed(1)}`),
      h('td', {}, clip.label ? [h('strong', {}, clip.label), ' · '] : null, clip.t, h('div', {class: 'meta'}, shortId(clip.id) + (clip.s === 'expanded' ? ' · added from the game files' : '') + (clip.k ? ` · ${clip.k}-processed` : ''))))));
    if (list.length > ps.limit) body.append(h('tr', {}, h('td', {colspan: 6}, h('button', {class: 'small', onclick: () => { ps.limit += 300; rows(); }}, `Show more (${list.length - ps.limit} left)`))));
    update();
  }
  useButton.onclick = async () => {
    const ok = await act('set', {set, clips: [...selected]}, 'New clips chosen');
    if (ok && state.autogen) await act('regenerate', {slots: v.slots, target: 'candidate', force: false}, null);
  };
  const sortSelect = h('select', {'aria-label': 'Sort', value: ps.sort, onchange: event => { ps.sort = event.target.value; rows(); }},
    h('option', {value: 'typical'}, 'Most typical first'), h('option', {value: 'loud'}, 'Closest to usual loudness'), h('option', {value: 'longest'}, 'Longest first'),
    h('option', {value: 'shortest'}, 'Shortest first'), h('option', {value: 'words'}, 'Longest text first'));
  sortSelect.value = ps.sort;
  const search = h('input', {type: 'search', placeholder: 'Search the text', 'aria-label': 'Search the text', value: ps.filter, oninput: event => { ps.filter = event.target.value; ps.limit = 150; rows(); }});
  const sourceSelect = h('select', {'aria-label': 'Which clips', value: ps.source, onchange: event => { ps.source = event.target.value; ps.limit = 150; rows(); }},
    h('option', {value: 'all'}, 'All clips'), h('option', {value: 'new'}, 'Only the newly added clips'), h('option', {value: 'old'}, 'Only the original clips'));
  sourceSelect.value = ps.source;
  rows();
  return h('div', {}, h('div', {class: 'row', style: 'margin:8px 0'}, sourceSelect, sortSelect, search, useButton), status,
    h('div', {class: 'pool-wrap'}, h('table', {class: 'pool'}, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Play'), h('th', {}, 'Length'), h('th', {title: 'How typical of this character'}, 'Typical'),
      h('th', {title: 'Loudness compared with this character’s usual clips (dB)'}, 'Loudness'), h('th', {}, 'Text'))), body)),
    h('div', {class: 'meta', style: 'margin-top:6px'}, 'The two game lines used for the samples are not in this list. Typical means how close a clip is to this character’s average voice.'));
}
function handPick(engine, v) {
  const details = h('details', {open: !!state.poolOpen[v.set]}, h('summary', {}, `Choose clips myself${state.card.poolSize ? ` (${state.card.poolSize} to pick from)` : ''}`));
  let shown = false;
  const show = async () => {
    if (shown) return;
    shown = true;
    try {
      state.poolClips ??= (await api(`/api/pool/${key}`)).clips;
      fill(details, h('summary', {}, `Choose clips myself (${state.card.poolSize} to pick from)`), poolTable(engine, v, state.poolClips));
    } catch (error) { toast(error.message, {bad: true}); }
  };
  details.addEventListener('toggle', () => { state.poolOpen[v.set] = details.open; if (details.open && !details.querySelector('table')) show(); });
  if (details.open) show();
  return details;
}

// The clip search's winner for this engine and clip count (card.autobest, from runtime/autobest-sets.json), loaded with the
// ordinary "set" action so it can be auditioned against the current clips like any hand-picked set.
function autoBest(engine, v) {
  const found = state.card.autobest?.[v.set];
  if (!found) return null;
  const same = v.candidate?.ids.join('|') === found.ids.join('|'), inUse = v.current?.ids.join('|') === found.ids.join('|');
  const score = `speaker similarity ${found.ecapa.toFixed(3)}${found.ecapaSe != null ? ` ±${found.ecapaSe.toFixed(3)}` : ''}${found.today != null ? `, today's single clip ${found.today.toFixed(3)}` : ''}${found.pls != null ? `, PLS ${found.pls}` : ''}`;
  return h('div', {class: 'row', style: 'margin-top:8px'},
    h('button', {disabled: same || inUse, onclick: async () => {
      const ok = await act('set', {set: v.set, clips: found.ids}, 'Auto-best clips loaded');
      if (ok && state.autogen) await act('regenerate', {slots: v.slots, target: 'candidate', force: false}, null);
    }, title: 'Load the clips the automatic search found best for this choice; use the buttons below to compare them with the current clips'},
    inUse ? 'Auto-best is in use' : same ? 'Auto-best loaded' : 'Load Auto-best'),
    h('span', {class: 'muted'}, `${found.ids.length} clip${found.ids.length === 1 ? '' : 's'}, ${seconds(found.seconds)}; ${score}`));
}

// ---- one engine -------------------------------------------------------------------------------------------------------------
function engineSection(engine) {
  const card = state.card, v = view(engine), status = statusText(engine), working = !!status?.working;
  const length = LENGTHS.find(item => item.n === v.n);
  const sourceText = !v.current ? 'There are no clips for this choice yet. Use “Try different clips” or “Choose clips myself” to get some.'
    : v.current.source === 'kept' ? `Clips you kept${v.kept?.ts ? ` on ${timeOf(v.kept.ts)}` : ''}` : v.current.source === 'proposed' ? 'Clips proposed by the research agent' : 'Today’s single reference clip';
  const candidateSlots = card.samples;
  const compareRows = v.slots.map(slot => h('tr', {}, h('th', {scope: 'row'}, slotLabel(slot)), h('td', {}, sampleCell(v.current?.samples?.[slot], slot, true, engine)),
    v.hasNew ? h('td', {}, sampleCell(candidateSlots[slot], slot, false, engine)) : null));
  const newMissing = v.hasNew && v.slots.some(slot => !candidateSlots[slot]?.exists);
  const noClips = !v.current && !v.candidate;
  return h('section', {class: 'engine', 'aria-labelledby': `h-${engine.id}`},
    h('h2', {id: `h-${engine.id}`}, engine.name, ' ', h('span', {class: 'muted'}, engine.about)),
    h('fieldset', {class: 'lengths'}, h('legend', {}, 'How many clips?'),
      LENGTHS.map(item => h('label', {class: 'radio'}, h('input', {type: 'radio', name: `len-${engine.id}`, checked: item.n === v.n,
        onchange: () => { state.lengths[engine.id] = item.n; store.set('lengths', state.lengths); render(true); }}), ` ${item.label}, ${item.detail}`)),
      h('div', {class: 'meta'}, engine.tradeoff)),
    h('div', {class: 'step'}, h('h3', {}, '1. Current clips'), h('div', {class: 'meta'}, sourceText), v.current ? clipList(v.current.clips) : null),
    h('div', {class: 'step'}, h('h3', {}, '2. Try different clips'),
      h('div', {class: 'row'}, h('button', {disabled: !card.poolSize || working, onclick: () => tryDifferent(engine),
        title: card.poolSize ? 'Draw a different set of whole clips from this character’s clips' : 'This character has no spare clips'}, 'Try different clips'),
        autogenToggle()),
      autoBest(engine, v),
      v.hasNew ? [h('div', {class: 'meta', style: 'margin-top:8px'}, 'New clips (not kept yet)'), clipList(v.candidate.clips)]
        : !noClips ? h('div', {class: 'meta', style: 'margin-top:6px'}, 'No new clips yet.') : null,
      h('div', {style: 'margin-top:8px'}, handPick(engine, v))),
    h('div', {class: 'step'}, h('h3', {}, '3. Generate samples'),
      h('div', {class: 'row'},
        h('button', {class: 'primary', disabled: working || (!v.candidate && !v.current), onclick: () => generate(engine, v.candidate ? 'candidate' : 'current'),
          title: `Make samples of the ${v.hasNew ? 'new' : 'current'} clips with ${engine.name}`}, v.hasNew ? 'Generate samples of the new clips' : 'Generate samples of the current clips'),
        status ? h('span', {class: status.bad ? 'warn' : 'muted'}, status.text) : h('span', {class: 'muted'}, newMissing ? 'The new clips have no samples yet.' : '')),
      h('div', {class: 'meta', style: 'margin-top:4px'}, 'Every sample says the same line; switch lines with the buttons at the top.')),
    h('div', {class: 'step'}, h('h3', {}, '4. Compare'),
      h('table', {class: 'compare'}, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Current clips'), v.hasNew ? h('th', {}, 'New clips') : null)), h('tbody', {}, compareRows))),
    h('div', {class: 'step'}, h('h3', {}, '5. Decide'),
      v.hasNew ? h('div', {class: 'row'},
        h('button', {class: 'primary', disabled: working, onclick: () => useThese(engine), title: 'Keep the new clips for this choice; this is logged and used when the picks are applied'}, 'Use these clips'),
        h('button', {onclick: () => keepCurrent(engine), title: 'Turn the new clips down and go back to the current ones'}, 'Keep current'))
        : h('div', {class: 'row'}, h('span', {class: 'muted'}, 'These are the clips in use for this choice. Try different clips to compare.'),
          v.kept ? h('button', {class: 'small', onclick: () => act('unkeep', {engine: v.set}, 'Your kept clips were undone', {undo: () => act('keep', {engine: v.set, clips: v.kept.clips.map(clip => clip.id)}, 'Kept again')}),
            title: 'Undo the clips you kept for this choice'}, 'Undo my kept clips') : null)));
}

// ---- page -----------------------------------------------------------------------------------------------------------------
let noteBox = null;
function build() {
  const card = state.card;
  document.title = `${card.name} · reference clips`;
  const lines = card.lines;
  noteBox = h('textarea', {placeholder: 'Optional note about this character (saved with “Use these clips”)', value: card.note ?? ''});
  fill($('#head'),
    h('a', {href: '/', class: 'back'}, '← Voice report'), h('h1', {}, card.name),
    lines.length ? h('div', {class: 'row'}, h('span', {class: 'muted'}, 'Line'), lines.map(line => h('button', {class: 'small' + (line.index === card.line ? ' primary' : ''), 'aria-pressed': String(line.index === card.line),
      onclick: async () => { state.line = line.index; try { await loadCard(); } catch (error) { toast(error.message, {bad: true}); } }}, String(line.index + 1)))) : null,
    lines[card.line] ? h('div', {class: 'row'}, h('span', {class: 'vline'}, `“${lines[card.line].text}”`), audioEl(lines[card.line].audio)) : h('span', {class: 'muted'}, 'This character has no game line yet.'));
  fill($('#page'), ENGINES.map(engineSection),
    h('div', {class: 'block'}, h('h3', {}, 'Note'), noteBox, h('div', {class: 'row', style: 'margin-top:6px'}, h('button', {class: 'small', onclick: () => act('note', {note: noteBox.value}, 'Note saved')}, 'Save note'))));
}

(async () => {
  if (!key) { fill($('#page'), h('p', {}, 'Open a character from the voice report.')); return; }
  try { await loadCard(); } catch (error) { fill($('#page'), h('p', {class: 'warn'}, error.message), h('p', {}, h('a', {href: '/'}, '← Voice report'))); return; }
  setInterval(() => {
    const card = state.card;
    if (document.hidden || !card || !(card.jobs?.candidate || card.jobs?.current)) return;
    loadCard().catch(() => {});
  }, 1500);
  // Coming back to this tab: pick up anything that changed meanwhile (for example samples that finished).
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCard().catch(() => {}); });
})();
