// The character editor's web page (docs/CHARACTER_EDITOR.md). One HTML document with its own style and script, nothing fetched from
// anywhere else: no fonts, no images, no libraries, no analytics. The script is an ordinary function below (so it is linted and tested
// like code) that is written into the page; it builds the page with textContent only, so a bio can never inject markup.
//
// Every sentence the page shows goes through T(source, values), where the source is the English sentence. The game side (mod/character-editor.lua) translates the same
// sources with its dictionaries and hands them over when the editor is opened; a source without a translation is shown in English.

/** The browser-side program. Runs in the page, never in Node: it may use only browser globals. */
export function editorClient() {
  const boot = window.__editor;
  const send = (method, path, body, type, extra) => fetch(path, {method, headers: {'X-Editor-Token': boot.token, ...(body === undefined ? {} : {'Content-Type': type || 'application/json'}), ...(extra || {})},
    body: body === undefined ? undefined : (type ? body : JSON.stringify(body)), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'})
    .then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(Error(data.error || 'error'), {status: response.status, errors: data.errors || []});
      return data;
    });
  const api = (method, path, body) => send(method, path, body);
  let strings = {};
  const T = (source, values) => String(strings[source] ?? source).replace(/\{(\w+)\}/g, (all, name) => values && name in values ? values[name] : all);
  const h = (tag, attributes, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes || {})) {
      if (value === false || value == null) continue;
      if (name === 'class') node.className = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  };
  const $ = id => document.getElementById(id);
  const count = text => Array.from(text).length;
  const FIELDS = ['bio', 'style', 'rules', 'examples', 'memories'];
  // The Voice tab is only for the characters that can have a clip (story characters, not everyday people); its one "field" is the clip.
  const TABS = [['bio', ['bio']], ['style', ['style', 'examples']], ['rules', ['rules']], ['memories', ['memories']], ['voice', ['voice']]];
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const blankCustom = () => ({name: '', gender: '', records: [], names: [], bio: '', style: '', examples: [], memories: [] });

  // custom: the character being made or edited ({draft}); null while a shipped character is open.
  // voice: the voice part of the open character ({key, words, chosen, saved}); null when it cannot have a clip (see voiceSection).
  const model = {state: null, key: '', data: null, draft: null, custom: null, voice: null, tab: 'bio', filter: '', note: null};
  let noteTimer = 0, pickSeq = 0;

  const say = (text, bad) => {
    model.note = {text, bad: !!bad};
    const live = $('note');
    live.textContent = text; live.className = 'note ' + (bad ? 'bad' : 'good') + ' show';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { live.className = 'note'; }, bad ? 9000 : 3500);
  };
  const hush = () => { clearTimeout(noteTimer); $('note').className = 'note'; $('note').textContent = ''; };
  const problem = error => {
    const first = (error.errors || [])[0];
    if (error.status === 404) return T('That character was not found.');
    if (!first) return T('Could not save. Try again.');
    const values = {max: first.max, min: first.min, other: first.other};
    switch (first.code) {
      case 'bio-short': return T('The bio is too short. Use at least {max} characters.', values);
      case 'bio-long': return T('The bio is too long. Keep it under {max} characters.', values);
      case 'style-long': return T('The speaking style is too long. Keep it under {max} characters.', values);
      case 'rules-many': return T('Too many rules. Keep {max} or fewer.', values);
      case 'rules-long': return T('A rule is too long. Keep each one under {max} characters.', values);
      case 'examples-many': return T('Too many example lines. Keep {max} or fewer.', values);
      case 'examples-long': return T('An example line is too long. Keep each one under {max} characters.', values);
      case 'examples-total': return T('The example lines are too long together. Keep them under {max} characters in all.', values);
      case 'memories-many': return T('Too many memories. Keep {max} or fewer.', values);
      case 'memories-long': return T('A memory is too long. Keep each one under {max} characters.', values);
      case 'too-big': return T('Everything together is too long. Shorten something so it stays under {max} characters.', values);
      case 'name-empty': return T('Give the character a name.');
      case 'name-long': return T('The name is too long. Keep it under {max} characters.', values);
      case 'gender-bad': return T('Choose a gender.');
      case 'records-many': return T('Too many record names. Keep {max} or fewer.', values);
      case 'record-bad': return T('A record name can only use letters, digits, dots, dashes and underscores, for example Character.Rebecca.');
      case 'names-many': return T('Too many display names. Keep {max} or fewer.', values);
      case 'names-long': return T('A display name is too long. Keep each one under {max} characters.', values);
      case 'match-empty': return T('Add a record name or a display name, so the game can find this character.');
      case 'match-taken': return T('Another character of yours, {other}, already answers to this record or name.', values);
      case 'match-roster': return T('{other} already has a profile in the mod, and that profile always wins. Use another record or name.', values);
      case 'characters-full': return T('You have made as many characters as the editor keeps ({max}). Delete one first.', values);
      case 'clip-format': return T('That file is not a recording the voices can read. Use a WAV, MP3, OGG or FLAC file.');
      case 'clip-needs-wav': return T('This computer cannot convert that file. Save it as a WAV and try again.');
      case 'clips-full': return T('You have as many voice clips as the editor keeps ({max}). Remove one first.', values);
      case 'clip-big': return T('That file is too big for a voice clip.');
      case 'clip-rate': return T('The recording is too low in quality. Use at least {min} Hz.', values);
      case 'clip-short': return T('The clip is too short. Use at least {min} seconds.', values);
      case 'clip-long': return T('The clip is too long. Use at most {max} seconds.', values);
      case 'clip-clipped': return T('The recording is distorted. Record it again, a little quieter.');
      case 'clip-quiet': return T('The recording is too quiet to copy. Record it louder, or closer to the microphone.');
      case 'clip-silent': return T('The clip is mostly silence. Use a clip where somebody is talking most of the time.');
      case 'voice-text-short': return T('Type the words said in the clip, at least {min} characters.', values);
      case 'voice-text-long': return T('The words said in the clip are too long. Keep them under {max} characters.', values);
      default: return T('Could not save. Try again.');
    }
  };

  const customDirty = () => !!model.custom && (!model.data || !same(model.custom.draft, model.data.key ? model.data.custom : blankCustom()));
  // A file chosen and not saved, or words changed for a clip that is saved, are changes that are not saved. Words typed with no clip are not (nothing keeps them).
  const voiceDirty = () => !!model.voice && (!!model.voice.chosen || (!!model.data && !!model.data.voice && !!model.data.voice.clip && model.voice.words !== model.data.voice.transcript));
  const dirtyFields = () => {
    const text = model.custom ? (customDirty() ? ['custom'] : []) : model.data ? FIELDS.filter(field => !same(model.draft[field], model.data.values[field])) : [];
    return voiceDirty() ? [...text, 'voice'] : text;
  };
  const leave = () => !dirtyFields().length || confirm(T('You have changes that are not saved. Leave without saving?'));

  const counter = (text, max) => {
    const used = count(text), node = h('span', {class: 'count' + (used > max ? ' over' : '')}, T('{count} of {max}', {count: used, max}));
    return node;
  };

  // ---- fields. `ctx` says where a field lives: the shipped characters (draft, limits, buttons) or the player's own (the form).
  const shippedCtx = () => ({draft: model.draft, limits: model.state.limits, changed: () => refreshButtons()});
  const customCtx = () => ({draft: model.custom.draft, limits: model.state.custom.limits, changed: () => {}});
  const blockField = (field, label, help, rows, ctx = shippedCtx()) => {
    const limit = ctx.limits[field], area = h('textarea', {id: 'f-' + field, rows, spellcheck: 'true', maxlength: String(limit * 3), 'aria-describedby': 'h-' + field});
    area.value = ctx.draft[field];
    const meter = h('div', {class: 'meter'}, counter(area.value, limit));
    area.addEventListener('input', () => {
      ctx.draft[field] = area.value;
      meter.replaceChildren(counter(area.value, limit));
      ctx.changed();
    });
    return h('div', {class: 'field'}, h('label', {for: 'f-' + field}, label), h('p', {class: 'help', id: 'h-' + field}, help), area, meter);
  };
  const textField = (field, label, help, ctx) => {
    const limit = ctx.limits[field], input = h('input', {type: 'text', id: 'f-' + field, maxlength: String(limit * 3), 'aria-describedby': 'h-' + field});
    input.value = ctx.draft[field];
    const meter = h('div', {class: 'meter'}, counter(input.value, limit));
    input.addEventListener('input', () => { ctx.draft[field] = input.value; meter.replaceChildren(counter(input.value, limit)); ctx.changed(); });
    return h('div', {class: 'field'}, h('label', {for: 'f-' + field}, label), help ? h('p', {class: 'help', id: 'h-' + field}, help) : null, input, meter);
  };
  const listField = (field, label, help, addLabel, placeholder, ctx = shippedCtx(), itemKey) => {
    const limit = ctx.limits[itemKey || field.replace(/ies$/, 'y').replace(/s$/, '')] || 200, max = ctx.limits[field];
    const box = h('div', {class: 'list'});
    const draw = () => {
      box.replaceChildren(...ctx.draft[field].map((line, index) => {
        const input = h('input', {type: 'text', value: line, 'aria-label': label + ' ' + (index + 1), placeholder, maxlength: String(limit * 3)});
        const meter = h('span', {class: 'count' + (count(line) > limit ? ' over' : '')}, T('{count} of {max}', {count: count(line), max: limit}));
        input.addEventListener('input', () => {
          ctx.draft[field][index] = input.value;
          meter.textContent = T('{count} of {max}', {count: count(input.value), max: limit});
          meter.className = 'count' + (count(input.value) > limit ? ' over' : '');
          ctx.changed();
        });
        return h('div', {class: 'row'}, input, meter,
          h('button', {type: 'button', class: 'quiet', onclick: () => { ctx.draft[field].splice(index, 1); draw(); ctx.changed(); }}, T('Delete')));
      }));
      add.disabled = ctx.draft[field].length >= max;
    };
    const add = h('button', {type: 'button', class: 'secondary', onclick: () => {
      ctx.draft[field].push(''); draw(); ctx.changed();
      const inputs = box.querySelectorAll('input'); inputs[inputs.length - 1]?.focus();
    }}, addLabel);
    draw();
    return h('div', {class: 'field'}, h('h3', {}, label), h('p', {class: 'help'}, help), box, h('div', {class: 'actions'}, add));
  };

  // ---- saving and resetting
  let buttons = [];
  const refreshButtons = () => {
    if (model.custom || !model.data) return;
    const dirty = dirtyFields();
    for (const {node, fields, kind} of buttons) {
      const touched = fields.some(field => dirty.includes(field)), edited = fields.some(field => model.data.edited[field]);
      node.disabled = kind === 'save' ? !touched : !(edited || touched);
    }
    const tabDirty = new Set(TABS.filter(([, fields]) => fields.some(field => dirty.includes(field))).map(tab => tab[0]));
    for (const tab of document.querySelectorAll('[role=tab]')) tab.classList.toggle('dirty', tabDirty.has(tab.dataset.tab));
  };
  // The list on the left follows a character that was made, renamed or saved. `keepDraft`: only the memory part changed, so what
  // is typed in the form stays.
  const syncEntry = data => {
    const row = model.state.characters.find(item => item.key === data.key);
    const voice = !!(data.voice && data.voice.clip);
    if (data.group === 'custom') {
      if (row) { row.name = data.name; row.voice = voice; }
      else model.state.characters.push({key: data.key, name: data.name, group: 'custom', edited: false, voice});
    } else if (row) { row.edited = FIELDS.some(field => data.edited[field]); if (data.voice) row.voice = voice; }
  };
  // keepDraft: only the memory or voice part changed, so what is typed in the form stays. The voice part follows the character: another one (or
  // one that cannot have a clip) drops the chosen file and its blob addresses.
  const apply = (data, keepDraft) => {
    model.data = data;
    if (data.group === 'custom') {
      if (!(keepDraft && model.custom)) model.custom = {draft: clone(data.custom)};
      model.draft = null;
    } else { model.custom = null; if (!(keepDraft && model.draft)) model.draft = clone(data.values); }
    if (!data.voice || (model.voice && model.voice.key !== data.key)) dropVoice();
    if (data.voice && !model.voice) model.voice = {key: data.key, words: data.voice.transcript, chosen: null, saved: null};
    if (data.key) syncEntry(data);
    drawList(); drawMain();
  };
  const save = async fields => {
    const patch = {};
    for (const field of fields) if (!same(model.draft[field], model.data.values[field])) patch[field] = model.draft[field];
    if (!Object.keys(patch).length) return;
    try { hush(); apply(await api('PUT', '/api/character/' + encodeURIComponent(model.key), patch)); say(T('Saved.')); }
    catch (error) { say(problem(error), true); }
  };
  const reset = async (fields, everything) => {
    if (!confirm(everything ? T('Go back to the shipped text for {name}? All your changes to this character are removed.', {name: model.data.name})
      : T('Go back to the shipped text for {name}? Your changes to this part are removed.', {name: model.data.name}))) return;
    try { hush(); apply(await api('POST', '/api/character/' + encodeURIComponent(model.key) + '/reset', {fields})); say(T('Back to the shipped text.')); }
    catch (error) { say(problem(error), true); }
  };
  const actions = fields => {
    const keep = h('button', {type: 'button', class: 'primary', onclick: () => save(fields)}, T('Save'));
    const undo = h('button', {type: 'button', class: 'secondary', onclick: () => reset(fields)}, T('Reset to default'));
    buttons.push({node: keep, fields, kind: 'save'}, {node: undo, fields, kind: 'reset'});
    return h('div', {class: 'actions bar'}, keep, undo);
  };

  // ---- memories
  // What the character picked up in talks and the short summary of older ones: for the named characters and for the player's own.
  const learnedPanel = () => {
    const data = model.data, memory = data.memory, custom = data.group === 'custom';
    const after = reply => apply(reply, custom);
    const rows = memory.records.map(record => {
      const input = h('input', {type: 'text', value: record.text, 'aria-label': T('Memory'), maxlength: String(model.state.limits.record * 3)});
      return h('div', {class: 'row'}, input,
        h('button', {type: 'button', class: 'secondary', onclick: async () => {
          try { hush(); after(await api('PUT', '/api/character/' + encodeURIComponent(model.key) + '/memory/' + encodeURIComponent(record.id), {text: input.value})); say(T('Saved.')); }
          catch (error) { say(error.status === 422 ? T('A memory cannot be empty.') : problem(error), true); }
        }}, T('Save')),
        h('button', {type: 'button', class: 'quiet', onclick: async () => {
          if (!confirm(T('Delete this memory?'))) return;
          try { hush(); after(await api('DELETE', '/api/character/' + encodeURIComponent(model.key) + '/memory/' + encodeURIComponent(record.id))); say(T('Deleted.')); }
          catch (error) { say(problem(error), true); }
        }}, T('Delete')));
    });
    const picked = h('div', {class: 'field'}, h('h3', {}, T('Picked up in your talks')),
      h('p', {class: 'help'}, memory.learns ? T('Facts the character noticed while you talked. Change or delete the ones that are wrong.')
        : T('The Local AI pack finds these. It is not installed or not ready, so none are collected now.')),
      rows.length ? h('div', {class: 'list'}, rows) : h('p', {class: 'empty'}, T('Nothing yet.')));
    const area = h('textarea', {id: 'f-summary', rows: 5, maxlength: String(model.state.limits.summary * 3)});
    area.value = memory.summary;
    const meter = h('div', {class: 'meter'}, counter(area.value, model.state.limits.summary));
    area.addEventListener('input', () => meter.replaceChildren(counter(area.value, model.state.limits.summary)));
    const summary = h('div', {class: 'field'}, h('label', {for: 'f-summary'}, T('Short summary of earlier talks')),
      h('p', {class: 'help'}, T('A few sentences the character keeps about your past talks. Edit them or clear them.')), area, meter,
      h('div', {class: 'actions'},
        h('button', {type: 'button', class: 'primary', onclick: async () => {
          try { hush(); after(await api('PUT', '/api/character/' + encodeURIComponent(model.key) + '/summary', {text: area.value})); say(T('Saved.')); }
          catch (error) { say(problem(error), true); }
        }}, T('Save')),
        h('button', {type: 'button', class: 'secondary', onclick: async () => {
          if (!confirm(T('Clear the summary?'))) return;
          try { hush(); after(await api('PUT', '/api/character/' + encodeURIComponent(model.key) + '/summary', {text: ''})); say(T('Cleared.')); }
          catch (error) { say(problem(error), true); }
        }}, T('Clear'))));
    return [picked, summary];
  };
  const memoriesPanel = () => {
    const data = model.data, memory = data.memory;
    const written = [listField('memories', T('Things they always know'),
      T('Short facts you write yourself, such as a name or a promise. The character knows them in every talk.'), T('Add a memory'), T('For example: V has a sister called Lena.')),
      actions(['memories'])];
    if (!memory.available) return h('div', {}, ...written, h('p', {class: 'help'}, T('Everyday people do not keep memories of your talks.')));
    return h('div', {}, ...written, ...learnedPanel());
  };

  // ---- the characters the player makes
  const bytesText = size => size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB';
  const facingFill = async () => {
    try {
      const {facing} = await api('GET', '/api/facing');
      if (!facing) { say(T('The game did not name anyone. Face the character, then choose Settings > Edit characters > Open in the game again.'), true); return; }
      const draft = model.custom.draft;
      if (facing.record && !draft.records.includes(facing.record)) draft.records.push(facing.record);
      if (facing.name && !draft.names.some(name => name.toLowerCase() === facing.name.toLowerCase())) draft.names.push(facing.name);
      if (!draft.name.trim() && facing.name) draft.name = facing.name;
      if (!draft.gender && facing.gender) draft.gender = facing.gender;
      drawMain();
      say(T('Filled in from the character you were facing: {name}.', {name: facing.name || facing.record}));
    } catch (error) { say(problem(error), true); }
  };
  const saveCustom = async () => {
    const mine = model.custom, key = model.data.key;
    try {
      hush();
      const data = key ? await api('PUT', '/api/custom/' + encodeURIComponent(key), mine.draft) : await api('POST', '/api/custom', mine.draft);
      model.key = data.key;
      apply(data);
      say(T('Saved.'));
    } catch (error) { say(problem(error), true); }
  };
  const removeCustom = async () => {
    if (!confirm(T('Delete {name}? The character, its voice clip and what it remembers of you are removed.', {name: model.data.name || model.custom.draft.name}))) return;
    try {
      hush();
      const reply = await api('DELETE', '/api/custom/' + encodeURIComponent(model.data.key));
      model.state.characters = reply.characters; model.key = ''; model.data = null; model.custom = null; dropVoice();
      drawList(); drawMain(); say(T('Deleted.'));
    } catch (error) { say(problem(error), true); }
  };
  // ---- voice clips: the Voice tab of a story character, and the same section on a saved character of the player's own.
  // The player picks a file; the browser decodes it (any format it knows: WAV, MP3, OGG, FLAC) and sends a 16-bit mono WAV at the voices' rate, so
  // the player needs no tool. A file the browser cannot decode is sent as it is, and the service checks it. Nothing is kept until Save clip.
  // Blob addresses (the preview of the chosen file, the saved clip fetched for the player) are revoked as soon as they are replaced or the character changes.
  const freeBlob = url => { if (url) { try { URL.revokeObjectURL(url); } catch { /* already gone */ } } };
  function dropVoice() {
    if (model.voice) { freeBlob(model.voice.chosen && model.voice.chosen.preview); freeBlob(model.voice.saved); }
    model.voice = null;
  }
  const voicePath = (key, rest) => '/api/voice/' + encodeURIComponent(key) + (rest || '');
  // The words said in a clip go in a header, as base64url of their UTF-8, because the body is the audio file.
  const wordsHeader = text => {
    let binary = '';
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const ACCEPT = {wav: ['.wav', 'audio/wav', 'audio/x-wav'], mp3: ['.mp3', 'audio/mpeg'], ogg: ['.ogg', '.oga', 'audio/ogg'], flac: ['.flac', 'audio/flac', 'audio/x-flac']};
  const SENDABLE = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac', 'audio/x-flac'];
  // A 16-bit mono PCM WAV with a plain header: what the service keeps and what the preview plays.
  const wavOf = (samples, rate) => {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const tag = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
    tag(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
    return new Blob([view.buffer], {type: 'audio/wav'});
  };
  // The file as the browser hears it: mono at the voices' rate. Null when the browser cannot decode it. A clip outside `range` ([shortest, longest]
  // seconds) comes back with its length only: nothing is mixed down for a file that will be refused.
  const decodeClip = async (buffer, rate, range) => {
    try {
      const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buffer.slice(0));
      if (audio.length / audio.sampleRate < range[0] || audio.length / audio.sampleRate > range[1]) return {seconds: audio.length / audio.sampleRate};
      const mono = new Float32Array(audio.length);
      for (let channel = 0; channel < audio.numberOfChannels; channel++) {
        const data = audio.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / audio.numberOfChannels;
      }
      return {samples: mono, rate: audio.sampleRate, seconds: audio.length / audio.sampleRate};
    } catch { return null; }
  };
  const voiceSection = heading => {
    const voice = model.voice, spec = model.state.voice, key = model.data.key, own = model.data.group === 'custom';
    const box = h('div', {class: 'field voice'});
    let busy = false, save = null;
    const canSave = () => !busy && (!!voice.chosen || (!!model.data.voice.clip && voice.words !== model.data.voice.transcript));
    const refresh = () => { if (save) save.disabled = !canSave(); refreshButtons(); };

    const pickFile = async (file, input) => {
      const refuse = text => { input.value = ''; say(text, true); };
      if (file.size > spec.maxUploadBytes) { refuse(T('That file is too big for a voice clip.')); return; }
      const mine = ++pickSeq;
      let buffer;
      try { buffer = await file.arrayBuffer(); } catch { refuse(T('That file is not a recording the voices can read. Use a WAV, MP3, OGG or FLAC file.')); return; }
      const heard = await decodeClip(buffer, spec.convertRate, [spec.minSeconds, spec.maxSeconds]);
      if (mine !== pickSeq || model.voice !== voice) return;
      let chosen;
      if (heard) {
        if (heard.seconds < spec.minSeconds) { refuse(T('The clip is too short. Use at least {min} seconds.', {min: spec.minSeconds})); return; }
        if (heard.seconds > spec.maxSeconds) { refuse(T('The clip is too long. Use at most {max} seconds.', {max: spec.maxSeconds})); return; }
        const wav = wavOf(heard.samples, heard.rate);
        chosen = {name: file.name, size: file.size, body: wav, type: 'audio/wav', seconds: Math.round(heard.seconds * 10) / 10, preview: URL.createObjectURL(wav)};
      } else chosen = {name: file.name, size: file.size, body: file, type: SENDABLE.includes(file.type) ? file.type : 'application/octet-stream', seconds: null, preview: null};
      freeBlob(voice.chosen && voice.chosen.preview);
      voice.chosen = chosen;
      hush();
      draw();
    };
    const playSaved = async () => {
      try {
        const response = await fetch(voicePath(key, '/audio'), {headers: {'X-Editor-Token': boot.token}, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'});
        if (!response.ok) throw Error('audio');
        const blob = await response.blob();
        if (model.voice !== voice) return;
        freeBlob(voice.saved);
        voice.saved = URL.createObjectURL(blob);
        draw();
        const player = box.querySelector('audio.saved');
        if (player) player.play().catch(() => {});
      } catch { say(T('The saved clip could not be loaded.'), true); }
    };
    const landed = reply => {
      if (model.data && model.data.key === key) { dropVoice(); apply(reply, true); } else { syncEntry(reply); drawList(); }
    };
    const saveClip = async () => {
      if (count(voice.words) > spec.transcript) { say(T('The words said in the clip are too long. Keep them under {max} characters.', {max: spec.transcript}), true); return; }
      busy = true; refresh();
      try {
        hush();
        let reply, notes = [];
        if (voice.chosen) {
          reply = await send('PUT', voicePath(key), voice.chosen.body, voice.chosen.type, {'X-Voice-Text': wordsHeader(voice.words)});
          notes = (reply.clip && reply.clip.notes) || [];
        } else reply = await api('PUT', voicePath(key, '/text'), {text: voice.words});
        landed(reply);
        say(notes.includes('short') ? T('Saved. The clip is a little short: 10 to 18 seconds copies best.')
          : notes.includes('long') ? T('Saved. The clip is a little long: 10 to 18 seconds copies best.') : T('Saved.'));
      } catch (error) { busy = false; refresh(); say(problem(error), true); }
    };
    const removeClip = async () => {
      if (!confirm(own ? T('Remove the voice clip? The character goes back to a generic voice.') : T('Remove the voice clip? {name} goes back to the shipped voice.', {name: model.data.name}))) return;
      try { hush(); landed(await api('DELETE', voicePath(key))); say(T('Clip removed.')); }
      catch (error) { say(problem(error), true); }
    };

    function draw() {
      const info = model.data.voice, clip = info.clip;
      const input = h('input', {type: 'file', id: 'f-clip', accept: spec.formats.flatMap(format => ACCEPT[format] || []).join(',')});
      input.addEventListener('change', () => { const file = input.files && input.files[0]; if (file) pickFile(file, input); });
      const area = h('textarea', {id: 'f-voiceText', rows: 3, spellcheck: 'false', maxlength: String(spec.transcript * 3), 'aria-describedby': 'h-voiceText'});
      area.value = voice.words;
      const meter = h('div', {class: 'meter'}, counter(area.value, spec.transcript));
      area.addEventListener('input', () => { voice.words = area.value; meter.replaceChildren(counter(area.value, spec.transcript)); refresh(); });
      save = h('button', {type: 'button', class: 'primary', onclick: saveClip}, T('Save clip'));
      const chosen = voice.chosen;
      const chosenText = chosen ? (chosen.seconds !== null ? T('Chosen file: {name}, {seconds} seconds.', {name: chosen.name, seconds: chosen.seconds})
        : T('Chosen file: {name} ({size}). It is checked when you save it.', {name: chosen.name, size: bytesText(chosen.size)})) : '';
      // (replaceChildren would write the word null for a missing part, so the parts that are not there are taken out)
      box.replaceChildren(...[
        heading ? h('h3', {}, T('Voice')) : null,
        h('p', {class: 'help'}, own ? T('Optional. Pocket, OmniVoice and the Voxtral cloud voice copy a clip you add. Without one the character speaks with a generic voice that fits the gender.')
          : T('A clip you add replaces the shipped voice of this character for Pocket, OmniVoice and the Voxtral cloud voice.')),
        h('p', {class: 'help'}, T('Use {min} to {max} seconds of one person speaking clearly, with no music or other voices. {goodMin} to {goodMax} seconds copies best. WAV, MP3, OGG or FLAC.',
          {min: spec.minSeconds, max: spec.maxSeconds, goodMin: spec.goodMin, goodMax: spec.goodMax})),
        clip
          ? h('div', {}, h('p', {class: 'status', role: 'status'}, T('Saved clip: {seconds} seconds.', {seconds: clip.seconds})),
            voice.saved ? h('audio', {class: 'saved', controls: true, preload: 'metadata', 'aria-label': T('Saved clip: {seconds} seconds.', {seconds: clip.seconds})})
              : h('div', {class: 'actions'}, h('button', {type: 'button', class: 'secondary', onclick: playSaved}, T('Play saved clip'))))
          : h('p', {class: 'status', role: 'status'}, T('No clip yet.') + ' ' + (info.fallback === 'shipped' ? T('This character speaks with the shipped voice.') : T('This character speaks with a generic voice that fits the gender.'))),
        h('div', {class: 'field'}, h('label', {for: 'f-clip'}, T('Add voice clip')), input),
        chosen ? h('div', {}, h('p', {class: 'status', role: 'status'}, chosenText), chosen.preview ? h('audio', {class: 'preview', controls: true, 'aria-label': chosenText}) : null) : null,
        h('div', {class: 'field'}, h('label', {for: 'f-voiceText'}, T('Words said in the clip')),
          h('p', {class: 'help', id: 'h-voiceText'}, T('Type what the clip says, as spoken. OmniVoice needs it to copy the voice.')), area, meter),
        h('p', {class: 'help'}, T('A new or removed clip counts from the next time the game starts. Until then the character keeps the voice it has now.')),
        h('div', {class: 'actions'}, save, clip ? h('button', {type: 'button', class: 'secondary', onclick: removeClip}, T('Remove clip')) : null)].filter(node => node));
      // The sources are set as properties after the nodes exist: the page has no markup with an address in it.
      const saved = box.querySelector('audio.saved'), preview = box.querySelector('audio.preview');
      if (saved) saved.src = voice.saved;
      if (preview) preview.src = chosen.preview;
      save.disabled = !canSave();
      refreshButtons();
    }
    draw();
    return box;
  };
  const customPanel = () => {
    const ctx = customCtx(), mine = model.custom, draft = mine.draft, isNew = !model.data.key;
    const genders = [['female', T('Female')], ['male', T('Male')]];
    const gender = h('select', {id: 'f-gender', 'aria-describedby': 'h-gender'},
      h('option', {value: ''}, T('Choose a gender')), ...genders.map(([value, label]) => h('option', {value}, label)));
    gender.value = draft.gender;
    gender.addEventListener('change', () => { draft.gender = gender.value; });
    const facing = model.state.facing !== false ? h('div', {class: 'actions'}, h('button', {type: 'button', class: 'secondary', onclick: facingFill}, T('Use the character I’m facing'))) : null;
    return h('div', {},
      h('p', {class: 'help'}, T('Your own characters talk only with Mistral or Local AI. With Convai they speak as an ordinary person.')),
      textField('name', T('Name'), T('The name the character goes by. They give it when somebody asks who they are.'), ctx),
      h('div', {class: 'field'}, h('label', {for: 'f-gender'}, T('Gender')), h('p', {class: 'help', id: 'h-gender'}, T('It picks the voice when the character has no clip.')), gender),
      h('div', {class: 'field'}, h('h3', {}, T('How the game finds this character')),
        h('p', {class: 'help'}, T('The game recognises the person you talk to by a record name, a display name, or both. A record name looks like Character.Rebecca or NCA.Rebecca. Add at least one.')),
        facing,
        listField('records', T('Record names'), T('The name of the character’s record in the game files.'), T('Add a record name'), T('For example: Character.Rebecca'), ctx, 'record'),
        listField('names', T('Display names'), T('The name the game shows for the character.'), T('Add a display name'), T('For example: Rebecca'), ctx, 'displayName')),
      blockField('bio', T('Bio'), T('Who this character is, what they know and how they look. Writing it as “I am …” works best. A long bio makes replies slower, so keep it tight.'), 12, ctx),
      blockField('style', T('Speaking style'), T('How they sound: pace, attitude, favourite habits of speech.'), 5, ctx),
      listField('examples', T('Example lines'), T('Lines in their voice. They show the tone only and are never said back word for word.'), T('Add a line'), T('A line this character might say'), ctx, 'example'),
      listField('memories', T('Things they always know'), T('Short facts you write yourself, such as a name or a promise. The character knows them in every talk.'), T('Add a memory'), T('For example: V has a sister called Lena.'), ctx, 'memory'),
      isNew || !model.voice ? h('p', {class: 'help'}, T('Save the character first. Then it can have a voice clip, and it starts to remember your talks.')) : voiceSection(true),
      h('div', {class: 'actions bar'}, h('button', {type: 'button', class: 'primary', onclick: saveCustom}, T('Save')),
        isNew ? null : h('button', {type: 'button', class: 'quiet', onclick: removeCustom}, T('Delete character'))),
      isNew ? null : h('div', {}, ...learnedPanel()));
  };
  const newCharacter = () => {
    if (!leave()) return;
    model.key = ''; model.draft = null;
    model.data = {key: '', name: '', group: 'custom', custom: blankCustom(), memory: {available: false, learns: false, summary: '', records: []}, voice: null};
    model.custom = {draft: blankCustom()};
    dropVoice();
    drawList(); drawMain();
    $('main').focus({preventScroll: true});
  };

  // ---- the page
  const panel = tab => {
    buttons = [];
    if (tab === 'bio') return h('div', {}, blockField('bio', T('Bio'), T('Who this character is, what they know and how they look. A long bio makes replies slower, so keep it tight.'), 18), actions(['bio']));
    if (tab === 'style') return h('div', {}, blockField('style', T('Speaking style'), T('How they sound: pace, attitude, favourite habits of speech.'), 8),
      listField('examples', T('Example lines'), T('Lines in their voice. They show the tone only and are never said back word for word.'), T('Add a line'), T('A line this character might say')), actions(['style', 'examples']));
    if (tab === 'rules') return h('div', {}, listField('rules', T('Speaking rules'),
      T('Short rules this character always follows when talking, for example: Never swear. Answer in one sentence.'), T('Add a rule'), T('A short rule')), actions(['rules']));
    if (tab === 'voice' && model.voice) return h('div', {}, voiceSection(false));
    return memoriesPanel();
  };
  function drawMain() {
    const main = $('main');
    if (!model.data) { main.replaceChildren(h('p', {class: 'empty big'}, T('Choose a character on the left.'))); return; }
    const data = model.data;
    if (data.group === 'custom') {
      const title = data.key ? (model.custom.draft.name || data.name) : T('New character');
      main.replaceChildren(h('div', {class: 'head'}, h('h2', {}, title), h('span', {class: 'chip edited'}, T('Your character'))), h('div', {class: 'panel'}, customPanel()));
      return;
    }
    const edited = FIELDS.some(field => data.edited[field]);
    const labels = {bio: T('Bio'), style: T('Speaking style'), rules: T('Speaking rules'), memories: T('Memories'), voice: T('Voice')};
    const tabs = h('div', {role: 'tablist', class: 'tabs', 'aria-label': T('Parts of the character')}, TABS.filter(([id]) => id !== 'voice' || model.voice).map(([id]) => h('button', {
      type: 'button', role: 'tab', 'data-tab': id, id: 'tab-' + id, 'aria-selected': String(model.tab === id), class: model.tab === id ? 'on' : '',
      onclick: () => { model.tab = id; drawMain(); },
    }, labels[id])));
    main.replaceChildren(
      h('div', {class: 'head'}, h('h2', {}, data.name), h('span', {class: 'chip' + (edited ? ' edited' : '')}, edited ? T('Edited') : T('As shipped')),
        h('button', {type: 'button', class: 'quiet', disabled: !edited, onclick: () => reset(FIELDS, true)}, T('Reset everything'))),
      tabs, h('div', {role: 'tabpanel', 'aria-labelledby': 'tab-' + model.tab, class: 'panel'}, panel(model.tab)));
    refreshButtons();
  }
  function drawList() {
    const query = model.filter.trim().toLowerCase();
    const groups = [['custom', T('Your characters')], ['story', T('Story characters')], ['everyday', T('Everyday people')]];
    const nodes = [];
    for (const [group, title] of groups) {
      const rows = model.state.characters.filter(item => item.group === group && (!query || item.name.toLowerCase().includes(query)));
      if (!rows.length) continue;
      nodes.push(h('h3', {class: 'group'}, title), h('ul', {}, rows.map(item => h('li', {}, h('button', {
        type: 'button', class: 'pick' + (item.key === model.key ? ' on' : ''), 'aria-current': item.key === model.key ? 'true' : null,
        onclick: () => choose(item.key),
      }, h('span', {}, item.name), item.edited ? h('span', {class: 'dot', title: T('Edited')}) : null)))));
    }
    $('list').replaceChildren(...(nodes.length ? nodes : [h('p', {class: 'empty'}, T('No match.'))]));
  }
  async function choose(key) {
    if (key === model.key || !leave()) return;
    try {
      const data = await api('GET', '/api/character/' + encodeURIComponent(key));
      model.key = key; model.tab = 'bio'; apply(data);
      $('main').focus({preventScroll: true});
    } catch (error) { say(problem(error), true); }
  }
  const chrome = () => {
    document.title = T('Character editor');
    document.documentElement.lang = boot.language || 'en';
    $('title').textContent = T('Character editor');
    $('sub').textContent = T('Your changes work with Mistral and Local. They do not apply to Convai.');
    $('close').textContent = T('Close editor');
    $('search').placeholder = T('Search characters');
    $('search').setAttribute('aria-label', T('Search characters'));
    $('foot').textContent = T('Changes are saved on this computer and used from the next reply.');
    const make = $('new');
    make.textContent = T('New character');
    make.hidden = !model.state.custom;
    const banner = $('banner');
    if (model.state.provider === 'convai') { banner.hidden = false; banner.textContent = T('Convai is answering right now, so these changes have no effect yet. Choose Mistral or Local as the conversation provider in the settings.'); }
    else banner.hidden = true;
  };
  window.addEventListener('beforeunload', event => { if (dirtyFields().length) { event.preventDefault(); event.returnValue = ''; } });
  $('search').addEventListener('input', event => { model.filter = event.target.value; drawList(); });
  $('new').addEventListener('click', newCharacter);
  $('close').addEventListener('click', async () => {
    if (!leave()) return;
    try { await api('POST', '/api/close', {}); } catch { /* the page is closing anyway */ }
    document.body.replaceChildren(h('main', {class: 'gone'}, h('p', {}, T('The editor is closed. You can close this tab.'))));
  });
  (async () => {
    try {
      model.state = await api('GET', '/api/state');
      strings = model.state.strings || {};
      chrome(); drawList(); drawMain();
    } catch (error) {
      document.body.replaceChildren(h('main', {class: 'gone'}, h('p', {}, 'The editor could not start. Open it again from the game settings.')));
    }
  })();
}

const STYLE = `
:root{color-scheme:dark light;--bg:#0e1116;--panel:#161b22;--line:#2a313c;--text:#e6e9ee;--dim:#98a2b0;--accent:#f3e600;--accent-ink:#14130a;--cyan:#4fd6e8;--bad:#ff6b6b;--good:#6fe39a;--field:#0b0e13}
@media (prefers-color-scheme:light){:root{--bg:#f4f5f7;--panel:#fff;--line:#d5d9e0;--text:#1b1f27;--dim:#5b6573;--accent:#b8a900;--accent-ink:#fff;--cyan:#007c8c;--bad:#b3261e;--good:#17753c;--field:#fbfbfc}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;min-height:100vh}
header.top{display:flex;align-items:center;gap:16px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
header.top h1{font-size:19px;margin:0;letter-spacing:.02em}
header.top .grow{flex:1}
header.top p{margin:2px 0 0;color:var(--dim);font-size:13px}
#banner{margin:0;padding:10px 24px;background:#3a2e00;color:#ffe9a0;border-bottom:1px solid #6b5700}
@media (prefers-color-scheme:light){#banner{background:#fff4c4;color:#4d3d00;border-color:#d8c25a}}
.layout{display:grid;grid-template-columns:300px 1fr;flex:1;min-height:0}
aside{border-right:1px solid var(--line);padding:16px;overflow:auto;max-height:calc(100vh - 120px);background:var(--panel)}
aside input[type=search]{width:100%}
aside #new{width:100%;margin-bottom:12px}
#list ul{list-style:none;margin:0;padding:0}
.group{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:18px 0 6px}
.pick{width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:none;border:1px solid transparent;color:var(--text);padding:7px 10px;border-radius:6px;cursor:pointer;font:inherit}
.pick:hover{background:var(--field)}
.pick.on{border-color:var(--accent);background:var(--field)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none}
main#main{padding:24px 32px 48px;overflow:auto;max-height:calc(100vh - 120px);outline:none}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.head h2{margin:0;font-size:24px}
.head .quiet{margin-left:auto}
.chip{font-size:12px;padding:2px 10px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.chip.edited{border-color:var(--accent);color:var(--accent)}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:20px;flex-wrap:wrap}
.tabs button{background:none;border:none;border-bottom:3px solid transparent;color:var(--dim);padding:9px 14px;font:inherit;cursor:pointer}
.tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
.tabs button.dirty::after{content:" *";color:var(--accent)}
.panel{max-width:860px}
.field{margin:0 0 28px}
.field .field{margin:12px 0 0}
.field label,.field h3{display:block;font-size:16px;font-weight:600;margin:0 0 2px}
.help{color:var(--dim);margin:2px 0 8px;font-size:13.5px}
textarea,input[type=text],input[type=search],select{width:100%;background:var(--field);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:9px 11px;font:inherit}
select{width:auto;min-width:220px}
input[type=file]{width:100%;color:var(--text);font:inherit}
audio{display:block;width:100%;max-width:460px;margin:6px 0 10px}
.field p.status{margin:6px 0;font-weight:600}
textarea{resize:vertical;line-height:1.5}
textarea:focus,input:focus,select:focus,button:focus-visible{outline:2px solid var(--cyan);outline-offset:1px}
.meter{display:flex;justify-content:flex-end;margin-top:3px}
.count{font-size:12px;color:var(--dim);white-space:nowrap}
.count.over{color:var(--bad);font-weight:600}
.list{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.row{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center}
.row input{min-width:0}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.actions.bar{padding-top:16px;border-top:1px solid var(--line)}
.actions.bar + div{margin-top:28px}
button{font:inherit;border-radius:6px;padding:8px 16px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--text)}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
button.secondary:hover,button.quiet:hover{border-color:var(--cyan)}
button.quiet{background:none;color:var(--dim)}
button:disabled{opacity:.4;cursor:default}
.empty{color:var(--dim)}
.empty.big{margin-top:40px;font-size:17px}
.note{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;padding:10px 18px;border-radius:8px;background:var(--panel);border:1px solid var(--line);max-width:90vw}
.note.show{opacity:1;transform:translateX(-50%)}
.note.good{border-color:var(--good)}
.note.bad{border-color:var(--bad);color:var(--bad)}
footer{padding:10px 24px;color:var(--dim);font-size:13px;border-top:1px solid var(--line);background:var(--panel)}
.gone{padding:60px 24px;text-align:center;font-size:18px}
@media (max-width:760px){.layout{grid-template-columns:1fr}aside{max-height:240px;border-right:0;border-bottom:1px solid var(--line)}main#main{max-height:none;padding:18px 16px}.row{grid-template-columns:1fr auto auto}.row .count{display:none}}
@media (prefers-reduced-motion:reduce){.note{transition:none}}
`;

const escapeAttribute = value => String(value).replace(/[&"<>]/g, char => ({'&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;'}[char]));

/**
 * The page. `nonce` lets exactly this script and this style run (the policy allows nothing else), `token` is the one the API wants in a
 * header, `language` the interface language code the game sent.
 */
export function renderEditorPage({nonce, token, language = 'en'}) {
  const lang = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language) ? language : 'en';
  const boot = JSON.stringify({token, language: lang}).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${escapeAttribute(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Character editor</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header class="top"><div class="grow"><h1 id="title">Character editor</h1><p id="sub"></p></div><button type="button" id="close" class="secondary">Close editor</button></header>
<p id="banner" role="status" hidden></p>
<div class="layout">
<aside><button type="button" id="new" class="primary" hidden>New character</button><input type="search" id="search" autocomplete="off"><nav id="list" aria-label="Characters"></nav></aside>
<main id="main" tabindex="-1"></main>
</div>
<footer id="foot"></footer>
<div id="note" class="note" role="status" aria-live="polite"></div>
<script nonce="${nonce}">window.__editor=${boot};(${editorClient.toString()})();</script>
</body>
</html>`;
}
