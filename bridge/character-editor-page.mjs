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
  // ---- icons. Lucide (lucide.dev, ISC licence, see THIRD_PARTY_NOTICES.md): only the few shapes the page uses, written out here so nothing is fetched. The markup is
  // parsed once with DOMParser (never written into the page as markup), and every use is a copy of the parsed node.
  const ICONS = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
    undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    alertCircle: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
    fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    listChecks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
    shirt: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  };
  const iconNodes = {};
  // The SVG namespace is a name for the kind of markup, not an address anything is fetched from (it is built here so the page has no web address written in it).
  const SVG_NAMESPACE = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
  const icon = name => {
    if (!iconNodes[name]) {
      const parsed = new DOMParser().parseFromString('<svg xmlns="' + SVG_NAMESPACE + '" viewBox="0 0 24 24">' + ICONS[name] + '</svg>', 'image/svg+xml');
      iconNodes[name] = document.importNode(parsed.documentElement, true);
    }
    const node = iconNodes[name].cloneNode(true);
    node.setAttribute('class', 'icon');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    return node;
  };
  // A button with an icon in front of its words (the words stay the button's name for the screen reader).
  const withIcon = (name, text) => [icon(name), h('span', {class: 'lbl'}, text)];
  const count = text => Array.from(text).length;
  const FIELDS = ['bio', 'style', 'rules', 'examples', 'memories'];
  // The Voice tab is only for the characters that can have a clip (story characters, not everyday people); its one "field" is the clip.
  // The Look and moves tab is for the named characters (clothes, gestures, idle moves, seating, reactions, reply length); its one "field" is the set of choices.
  const TABS = [['bio', ['bio']], ['style', ['style', 'examples']], ['rules', ['rules']], ['memories', ['memories']], ['voice', ['voice']], ['look', ['look']]];
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const blankCustom = () => ({name: '', gender: '', records: [], names: [], bio: '', style: '', examples: [], memories: [] });

  // custom: the character being made or edited ({draft}); null while a shipped character is open.
  // voice: the voice part of the open character ({key, words, chosen, saved}); null when it cannot have a clip (see voiceSection).
  // world: the world rules page ({draft: {worldRules}}) while it is open, else null; it belongs to no character, so `data` is null then.
  // prompting: the Prompting page (the options, the open one and its draft) while it is open, else null; it belongs to no character either.
  // look: the Look and moves choices of the open character ({key, draft}); null when it has none (everyday people, V's voices, a character not saved yet).
  // The picker: `chip` is the role filter ('all', a role, or 'edited'), `recent` the keys saved in this session (newest first), `facing` the key of the character V was facing.
  const model = {state: null, key: '', data: null, draft: null, custom: null, voice: null, look: null, world: null, prompting: null, tab: 'bio', filter: '', note: null, chip: 'all', recent: [], facing: ''};
  let noteTimer = 0, pickSeq = 0;

  // The toast: a short message that stays a few seconds (a problem a little longer) and can be dismissed. #note keeps the message as its only text.
  const say = (text, bad) => {
    model.note = {text, bad: !!bad};
    const live = $('note');
    live.replaceChildren(icon(bad ? 'alertCircle' : 'checkCircle'), h('span', {class: 'msg'}, text),
      h('button', {type: 'button', class: 'dismiss', 'aria-label': T('Close'), title: T('Close'), onclick: () => hush()}, icon('x')));
    live.className = 'note ' + (bad ? 'bad' : 'good') + ' show';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { live.className = 'note'; }, bad ? 9000 : 3500);
  };
  const hush = () => { clearTimeout(noteTimer); $('note').className = 'note'; $('note').replaceChildren(); };
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
      case 'world-rules-long': return T('The world rules are too long. Keep them under {max} characters.', values);
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
      case 'outfit-bad': return T('That look is not one of this character’s.');
      case 'option-bad': return T('That choice is not available.');
      case 'options-full': return T('The editor keeps choices for {max} characters. Reset one first.', values);
      default: return T('Could not save. Try again.');
    }
  };

  const customDirty = () => !!model.custom && (!model.data || !same(model.custom.draft, model.data.key ? model.data.custom : blankCustom()));
  // V's two voice rows: the server names them in English, the page shows them in the player's language.
  const vName = (key, name) => key === 'v-male' ? T('V (male voice)') : key === 'v-female' ? T('V (female voice)') : name;
  // A file chosen and not saved, or words changed for a clip that is saved, are changes that are not saved. Words typed with no clip are not (nothing keeps them).
  const voiceDirty = () => !!model.voice && (!!model.voice.chosen || (!!model.data && !!model.data.voice && !!model.data.voice.clip && model.voice.words !== model.data.voice.transcript));
  const worldDirty = () => !!model.world && model.world.draft.worldRules !== model.state.worldRules.text;
  const lookDirty = () => !!model.look && !!model.data && !!model.data.options && !same(model.look.draft, lookDraft(model.data.options.values));
  const dirtyFields = () => {
    if (model.world) return worldDirty() ? ['world'] : [];
    if (model.prompting) return promptingDirty() ? ['prompting'] : [];
    const text = model.custom ? (customDirty() ? ['custom'] : []) : model.data && model.draft ? FIELDS.filter(field => !same(model.draft[field], model.data.values[field])) : [];
    return [...text, ...(voiceDirty() ? ['voice'] : []), ...(lookDirty() ? ['look'] : [])];
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
          h('button', {type: 'button', class: 'quiet icon-btn', 'aria-label': T('Delete'), title: T('Delete'), onclick: () => { ctx.draft[field].splice(index, 1); draw(); ctx.changed(); }}, icon('trash')));
      }));
      add.disabled = ctx.draft[field].length >= max;
    };
    const add = h('button', {type: 'button', class: 'secondary', onclick: () => {
      ctx.draft[field].push(''); draw(); ctx.changed();
      const inputs = box.querySelectorAll('input'); inputs[inputs.length - 1]?.focus();
    }}, withIcon('plus', addLabel));
    draw();
    return h('div', {class: 'field'}, h('h3', {}, label), h('p', {class: 'help'}, help), box, h('div', {class: 'actions'}, add));
  };

  // ---- saving and resetting
  let buttons = [], flags = [];
  // "Unsaved changes" beside the Save button: shown while anything on the open page differs from what is saved. It follows every key press and choice on the page.
  const updateFlag = (node, dirty) => {
    if ((node.dataset.dirty === '1') === dirty) return;
    node.dataset.dirty = dirty ? '1' : '0';
    node.className = 'state' + (dirty ? ' dirty' : '');
    node.replaceChildren(...(dirty ? [icon('pencil'), h('span', {}, T('Unsaved changes'))] : []));
  };
  const refreshFlags = () => { if (!flags.length) return; const dirty = dirtyFields().length > 0; for (const node of flags) updateFlag(node, dirty); };
  const flag = () => { const node = h('span', {class: 'state', role: 'status', 'data-dirty': '0'}); flags.push(node); updateFlag(node, dirtyFields().length > 0); return node; };
  // The characters saved in this page, newest first: the picker offers them at the top.
  const markRecent = key => { if (key) model.recent = [key, ...model.recent.filter(item => item !== key)].slice(0, 12); };
  const refreshButtons = () => {
    if (model.custom || !model.data || model.data.voiceOnly) return;
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
    if (data.voiceOnly) { if (row) row.voice = voice; return; }
    if (data.group === 'custom') {
      if (row) { row.name = data.name; row.voice = voice; }
      else model.state.characters.push({key: data.key, name: data.name, group: 'custom', edited: false, voice});
    } else if (row) { row.edited = FIELDS.some(field => data.edited[field]); if (data.voice) row.voice = voice; }
  };
  // keepDraft: only the memory or voice part changed, so what is typed in the form stays. The voice part follows the character: another one (or
  // one that cannot have a clip) drops the chosen file and its blob addresses.
  const apply = (data, keepDraft) => {
    model.data = data; model.world = null; model.prompting = null;
    if (data.voiceOnly) data.name = vName(data.key, data.name);
    if (data.voiceOnly) { model.custom = null; model.draft = null; }
    else if (data.group === 'custom') {
      if (!(keepDraft && model.custom)) model.custom = {draft: clone(data.custom)};
      model.draft = null;
    } else { model.custom = null; if (!(keepDraft && model.draft)) model.draft = clone(data.values); }
    // The Look and moves choices follow the character; they are kept (unsaved edits included) only while the same character is shown again.
    if (!data.options) model.look = null;
    else if (!(keepDraft && model.look && model.look.key === data.key)) model.look = {key: data.key, draft: lookDraft(data.options.values)};
    if (!data.voice || (model.voice && model.voice.key !== data.key)) dropVoice();
    if (data.voice && !model.voice) model.voice = {key: data.key, words: data.voice.transcript, chosen: null, saved: null};
    if (data.key) syncEntry(data);
    drawList(); drawMain();
  };
  const save = async fields => {
    const patch = {};
    for (const field of fields) if (!same(model.draft[field], model.data.values[field])) patch[field] = model.draft[field];
    if (!Object.keys(patch).length) return;
    try { hush(); apply(await api('PUT', '/api/character/' + encodeURIComponent(model.key), patch)); markRecent(model.key); say(T('Saved.')); }
    catch (error) { say(problem(error), true); }
  };
  const reset = async (fields, everything) => {
    if (!confirm(everything ? T('Go back to the shipped text for {name}? All your changes to this character are removed.', {name: model.data.name})
      : T('Go back to the shipped text for {name}? Your changes to this part are removed.', {name: model.data.name}))) return;
    try { hush(); apply(await api('POST', '/api/character/' + encodeURIComponent(model.key) + '/reset', {fields})); say(T('Back to the shipped text.')); }
    catch (error) { say(problem(error), true); }
  };
  const actions = fields => {
    const keep = h('button', {type: 'button', class: 'primary', onclick: () => save(fields)}, withIcon('save', T('Save')));
    const undo = h('button', {type: 'button', class: 'secondary', onclick: () => reset(fields)}, withIcon('undo', T('Reset to default')));
    buttons.push({node: keep, fields, kind: 'save'}, {node: undo, fields, kind: 'reset'});
    return h('div', {class: 'actions bar'}, keep, undo, flag());
  };

  // ---- memories
  // What the character picked up in talks and the short summary of older ones: for the named characters and for the player's own.
  const learnedPanel = () => {
    const data = model.data, memory = data.memory, custom = data.group === 'custom';
    const after = reply => apply(reply, custom);
    const rows = memory.records.map(record => {
      const input = h('input', {type: 'text', value: record.text, 'aria-label': T('Memory'), maxlength: String(model.state.limits.record * 3)});
      return h('div', {class: 'row memory'}, input,
        h('button', {type: 'button', class: 'secondary', onclick: async () => {
          try { hush(); after(await api('PUT', '/api/character/' + encodeURIComponent(model.key) + '/memory/' + encodeURIComponent(record.id), {text: input.value})); say(T('Saved.')); }
          catch (error) { say(error.status === 422 ? T('A memory cannot be empty.') : problem(error), true); }
        }}, T('Save')),
        h('button', {type: 'button', class: 'quiet icon-btn', 'aria-label': T('Delete'), title: T('Delete'), onclick: async () => {
          if (!confirm(T('Delete this memory?'))) return;
          try { hush(); after(await api('DELETE', '/api/character/' + encodeURIComponent(model.key) + '/memory/' + encodeURIComponent(record.id))); say(T('Deleted.')); }
          catch (error) { say(problem(error), true); }
        }}, icon('trash')));
    });
    const picked = h('div', {class: 'field'}, h('h3', {}, T('Picked up in your talks')),
      h('p', {class: 'help'}, memory.learns ? T('Facts the character noticed while you talked. Change or delete the ones that are wrong.')
        : T('The Local AI pack finds these. It is not installed or not ready, so none are collected now.')),
      rows.length ? h('div', {class: 'list'}, rows) : h('p', {class: 'empty'}, icon('info'), h('span', {}, T('Nothing yet.'))));
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
      markRecent(data.key);
      say(T('Saved.'));
    } catch (error) { say(problem(error), true); }
  };
  const removeCustom = async () => {
    if (!confirm(T('Delete {name}? The character, its voice clip and what it remembers of you are removed.', {name: model.data.name || model.custom.draft.name}))) return;
    try {
      hush();
      const reply = await api('DELETE', '/api/custom/' + encodeURIComponent(model.data.key));
      model.state.characters = reply.characters; model.key = ''; model.data = null; model.custom = null; model.look = null; dropVoice();
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
      markRecent(key);
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
      if (!confirm(model.data.voiceOnly ? T('Remove the voice clip? V goes back to the voice of your installed V voice mod, or the shipped V voice.')
        : own ? T('Remove the voice clip? The character goes back to a generic voice.') : T('Remove the voice clip? {name} goes back to the shipped voice.', {name: model.data.name}))) return;
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
      save = h('button', {type: 'button', class: 'primary', onclick: saveClip}, withIcon('save', T('Save clip')));
      const chosen = voice.chosen;
      const chosenText = chosen ? (chosen.seconds !== null ? T('Chosen file: {name}, {seconds} seconds.', {name: chosen.name, seconds: chosen.seconds})
        : T('Chosen file: {name} ({size}). It is checked when you save it.', {name: chosen.name, size: bytesText(chosen.size)})) : '';
      // (replaceChildren would write the word null for a missing part, so the parts that are not there are taken out)
      box.replaceChildren(...[
        heading ? h('h3', {}, T('Voice')) : null,
        h('p', {class: 'help'}, model.data.voiceOnly ? T('Used for V’s typed lines: Pocket, OmniVoice and the Voxtral cloud voice copy it.')
          : own ? T('Optional. Pocket, OmniVoice and the Voxtral cloud voice copy a clip you add. Without one the character speaks with a generic voice that fits the gender.')
          : T('A clip you add replaces the shipped voice of this character for Pocket, OmniVoice and the Voxtral cloud voice.')),
        h('p', {class: 'help'}, T('Use {min} to {max} seconds of one person speaking clearly, with no music or other voices. {goodMin} to {goodMax} seconds copies best. WAV, MP3, OGG or FLAC.',
          {min: spec.minSeconds, max: spec.maxSeconds, goodMin: spec.goodMin, goodMax: spec.goodMax})),
        clip
          ? h('div', {}, h('p', {class: 'status', role: 'status'}, T('Saved clip: {seconds} seconds.', {seconds: clip.seconds})),
            voice.saved ? h('audio', {class: 'saved', controls: true, preload: 'metadata', 'aria-label': T('Saved clip: {seconds} seconds.', {seconds: clip.seconds})})
              : h('div', {class: 'actions'}, h('button', {type: 'button', class: 'secondary', onclick: playSaved}, withIcon('play', T('Play saved clip')))))
          : h('p', {class: 'status', role: 'status'}, T('No clip yet.') + ' ' + (info.fallback === 'v' ? T('V speaks with the voice of your installed V voice mod, or the shipped V voice.')
          : info.fallback === 'shipped' ? T('This character speaks with the shipped voice.') : T('This character speaks with a generic voice that fits the gender.'))),
        h('div', {class: 'field'}, h('label', {for: 'f-clip'}, T('Add voice clip')), input),
        chosen ? h('div', {}, h('p', {class: 'status', role: 'status'}, chosenText), chosen.preview ? h('audio', {class: 'preview', controls: true, 'aria-label': chosenText}) : null) : null,
        h('div', {class: 'field'}, h('label', {for: 'f-voiceText'}, T('Words said in the clip')),
          h('p', {class: 'help', id: 'h-voiceText'}, T('Type what the clip says, as spoken. OmniVoice needs it to copy the voice.')), area, meter),
        h('p', {class: 'help'}, T('A new or removed clip counts from the next line this character speaks, once the current reply is over. Nothing needs restarting.')),
        h('div', {class: 'actions'}, save, clip ? h('button', {type: 'button', class: 'secondary', onclick: removeClip}, withIcon('trash', T('Remove clip'))) : null)].filter(node => node));
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
  // ---- Look and moves: the clothes, gestures, idle moves, seating, reactions and reply length of one character. The saved choices hold only what differs from today's
  // behaviour; the draft has a value for every control ('' is the default of a list, true the default of a box).
  const lookDraft = values => ({outfit: values.outfit || '', talk: values.talk || '', nods: values.nods !== false, idle: values.idle || '',
    sit: values.sit !== false, react: values.react !== false, length: values.length || ''});
  // The English labels of the looks come from the service; the translated sentences are looked up here so the page and the game's list stay in step.
  const outfitLabel = text => ({
    'Usual look': T('Usual look'), 'Home clothes: tank top, boxer shorts, flip-flops': T('Home clothes: tank top, boxer shorts, flip-flops'),
    'No jacket': T('No jacket'), 'No jacket and harness': T('No jacket and harness'), 'Home clothes: shirt and trousers': T('Home clothes: shirt and trousers'),
    'Home clothes: tank top and trousers': T('Home clothes: tank top and trousers'), 'Hooded jacket': T('Hooded jacket'),
    'Home clothes: t-shirt and trousers': T('Home clothes: t-shirt and trousers'), 'Collar down': T('Collar down'), 'Valentino look': T('Valentino look'),
    'Suit': T('Suit'), 'Club night, no jacket': T('Club night, no jacket'), 'Solo look': T('Solo look'), 'Date night': T('Date night'), 'T-shirt': T('T-shirt'),
    'Vest': T('Vest'), 'Paradise look': T('Paradise look'), 'Bartender': T('Bartender'), 'Dress without the fur coat': T('Dress without the fur coat'),
    'Trench coat': T('Trench coat'), 'Without the coat': T('Without the coat'), 'CEO look with coat': T('CEO look with coat'), 'CEO look': T('CEO look'),
    'Pyjamas': T('Pyjamas'),
  })[text] || text;
  const lookPatch = (draft, saved) => {
    const was = lookDraft(saved), patch = {};
    const put = (field, value, normal) => { if (draft[field] !== was[field]) patch[field] = draft[field] === normal ? null : value; };
    put('outfit', draft.outfit, ''); put('talk', draft.talk, ''); put('nods', false, true); put('idle', draft.idle, '');
    put('sit', false, true); put('react', false, true); put('length', draft.length, '');
    return patch;
  };
  const lookSection = () => {
    const look = model.look, spec = model.state.options, data = model.data, key = data.key, outfits = data.options.outfits;
    const box = h('div', {class: 'field look'});
    let save = null, undo = null;
    const refresh = () => {
      const dirty = lookDirty(), stored = Object.keys(data.options.values).length > 0;
      if (save) save.disabled = !dirty;
      if (undo) undo.disabled = !stored && !dirty;
      refreshButtons();
    };
    const choice = (field, label, help, options) => {
      const select = h('select', {id: 'f-look-' + field, 'aria-describedby': 'h-look-' + field}, options.map(([value, text]) => h('option', {value}, text)));
      select.value = look.draft[field];
      select.addEventListener('change', () => { look.draft[field] = select.value; refresh(); });
      return h('div', {class: 'field'}, h('label', {for: 'f-look-' + field}, label), h('p', {class: 'help', id: 'h-look-' + field}, help), select);
    };
    const toggle = (field, label, help) => {
      const input = h('input', {type: 'checkbox', id: 'f-look-' + field, 'aria-describedby': 'h-look-' + field});
      input.checked = look.draft[field];
      input.addEventListener('change', () => { look.draft[field] = input.checked; refresh(); });
      return h('div', {class: 'field'}, h('div', {class: 'check'}, input, h('label', {for: 'f-look-' + field}, label)), h('p', {class: 'help', id: 'h-look-' + field}, help));
    };
    const saveLook = async () => {
      const patch = lookPatch(look.draft, data.options.values);
      if (!Object.keys(patch).length) return;
      try { hush(); model.look = null; apply(await api('PUT', '/api/character/' + encodeURIComponent(key) + '/options', patch), true); markRecent(key); say(T('Saved.')); }
      catch (error) { model.look = look; say(problem(error), true); }
    };
    const resetLook = async () => {
      if (!confirm(T('Go back to the usual look and moves for {name}? Your choices on this part are removed.', {name: data.name || key}))) return;
      try { hush(); model.look = null; apply(await api('POST', '/api/character/' + encodeURIComponent(key) + '/options/reset', {}), true); say(T('Back to the usual look and moves.')); }
      catch (error) { model.look = look; say(problem(error), true); }
    };
    save = h('button', {type: 'button', class: 'primary', onclick: saveLook}, withIcon('save', T('Save')));
    undo = h('button', {type: 'button', class: 'secondary', onclick: resetLook}, withIcon('undo', T('Reset to default')));
    const words = spec.words;
    box.replaceChildren(
      h('p', {class: 'help'}, T('Choices for how this character looks and moves. They work with every conversation option, Convai included, except the reply length.')),
      outfits
        ? choice('outfit', T('Outfit'), T('Automatic follows the “Companions change outfits” setting in the game: day and night looks, now and then a change, and casual clothes at home. A look you pick is worn all the time. Only your own companions and residents are dressed, and they change while nobody is looking. Characters the game places are never changed.'),
          [['', T('Automatic')], ...outfits.looks.map(item => [item.name, outfitLabel(item.label)])])
        : h('div', {class: 'field'}, h('h3', {}, T('Outfit')), h('p', {class: 'help'}, T('This character has only one look in the game files, so there is no outfit to choose.'))),
      choice('talk', T('Talking gestures'), T('How the hands move while they speak a longer reply.'),
        [['', T('Normal')], ['calm', T('Calm: smaller gestures, not as often')], ['lively', T('Lively: bigger gestures, more often')], ['none', T('None: the hands stay at rest')]]),
      toggle('nods', T('Nod while you talk to them'), T('A small nod now and then while you speak.')),
      choice('idle', T('Idle moves'), T('What they do now and then while they stand beside you.'),
        [['', T('Normal')], ['plain', T('Plain stances only, no props like a cup or a cigarette')], ['none', T('None: they keep the stance they have')]]),
      toggle('sit', T('Sit down and take a place'), T('Takes a seat beside you when you sit, and a seat or a spot in your flat at home. Switched off, they stay on their feet beside you.')),
      toggle('react', T('Comment on fights and loot'), T('Switched off, they say nothing about fights or about what you pick up.')),
      choice('length', T('Reply length'), T('The longest reply, in words. Works with Google Gemini, Local AI and Custom, not Convai.'),
        [['', T('Normal')], ['short', T('Shorter: up to about {words} words', {words: words.short})], ['brief', T('Very short: up to about {words} words', {words: words.brief})]]),
      h('p', {class: 'help'}, T('A saved choice counts within a few seconds. Clothes change when nobody is looking.')),
      h('div', {class: 'actions bar'}, save, undo, flag()));
    refresh();
    return box;
  };
  const customPanel = () => {
    const ctx = customCtx(), mine = model.custom, draft = mine.draft, isNew = !model.data.key;
    const genders = [['female', T('Female')], ['male', T('Male')]];
    const gender = h('select', {id: 'f-gender', 'aria-describedby': 'h-gender'},
      h('option', {value: ''}, T('Choose a gender')), ...genders.map(([value, label]) => h('option', {value}, label)));
    gender.value = draft.gender;
    gender.addEventListener('change', () => { draft.gender = gender.value; });
    const facing = model.state.facing !== false ? h('div', {class: 'actions'}, h('button', {type: 'button', class: 'secondary', onclick: facingFill}, withIcon('crosshair', T('Use the character I’m facing')))) : null;
    return h('div', {},
      h('p', {class: 'help'}, T('Your own characters talk only with Google Gemini, Local AI or Custom. With Convai they speak as an ordinary person.')),
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
      !isNew && model.look ? h('div', {class: 'field'}, h('h3', {}, T('Look and moves')), lookSection()) : null,
      h('div', {class: 'actions bar'}, h('button', {type: 'button', class: 'primary', onclick: saveCustom}, withIcon('save', T('Save'))),
        isNew ? null : h('button', {type: 'button', class: 'quiet danger', onclick: removeCustom}, withIcon('trash', T('Delete character'))), flag()),
      isNew ? null : h('div', {}, ...learnedPanel()));
  };
  const newCharacter = () => {
    if (!leave()) return;
    model.key = ''; model.draft = null; model.look = null; model.world = null; clearTimeout(model.prompting?.timer); model.prompting = null;
    model.data = {key: '', name: '', group: 'custom', custom: blankCustom(), memory: {available: false, learns: false, summary: '', records: []}, voice: null};
    model.custom = {draft: blankCustom()};
    dropVoice();
    closePicker(false); drawMain();
    $('main').focus({preventScroll: true});
  };

  // ---- the world rules: one text for the whole world, in every character's talks. Saved at once (the next reply already uses it).
  const worldPanel = () => {
    const spec = model.state.worldRules, world = model.world, limit = spec.limit;
    const area = h('textarea', {id: 'f-worldRules', rows: 10, spellcheck: 'true', maxlength: String(limit * 3), 'aria-label': T('World rules'), 'aria-describedby': 'h-worldRules',
      placeholder: T('For example: Nobody in Night City knows V’s name unless V tells them. Everyone speaks casually.')});
    area.value = world.draft.worldRules;
    const meter = h('div', {class: 'meter'}, counter(area.value, limit));
    const keep = h('button', {type: 'button', class: 'primary', onclick: async () => {
      try { hush(); const reply = await api('PUT', '/api/world-rules', {text: world.draft.worldRules}); model.state.worldRules = reply; world.draft.worldRules = reply.text; drawMain(); say(T('Saved.')); }
      catch (error) { say(problem(error), true); }
    }}, withIcon('save', T('Save')));
    const back = h('button', {type: 'button', class: 'secondary', onclick: () => { world.draft.worldRules = spec.text; drawMain(); }}, withIcon('undo', T('Revert changes')));
    const wipe = h('button', {type: 'button', class: 'quiet danger', onclick: async () => {
      if (!confirm(T('Clear the world rules?'))) return;
      try { hush(); const reply = await api('DELETE', '/api/world-rules'); model.state.worldRules = reply; world.draft.worldRules = reply.text; drawMain(); say(T('Cleared.')); }
      catch (error) { say(problem(error), true); }
    }}, withIcon('trash', T('Clear')));
    const refresh = () => { const dirty = worldDirty(); keep.disabled = !dirty || count(world.draft.worldRules) > limit; back.disabled = !dirty; wipe.disabled = !spec.text && !world.draft.worldRules; };
    area.addEventListener('input', () => { world.draft.worldRules = area.value; meter.replaceChildren(counter(area.value, limit)); refresh(); });
    refresh();
    return h('div', {},
      h('div', {class: 'field'},
        h('p', {class: 'help', id: 'h-worldRules'}, T('Rules for the whole world, used for every character in every talk: face to face, phone and group chats. Write facts and style, for example how people talk or what nobody knows. They never replace the mod’s own rules.')),
        area, meter),
      h('p', {class: 'help'}, T('Applies to every provider: Local AI, Mistral and Custom in the character prompt, and Convai through its dynamic info.')),
      h('div', {class: 'actions bar'}, keep, back, wipe, flag()),
      // Content packs (add-ons, bridge/addon-content.mjs): their rules come after the player's, read-only here. The player turns a pack off in the game's settings.
      ...(spec.packs || []).length ? [h('p', {class: 'help'}, T('Content packs add rules after yours. You cannot edit them here: turn a pack off under Settings > Content packs in the game.')),
        ...spec.packs.map((pack, index) => h('div', {class: 'field'}, h('label', {for: 'f-pack-' + index}, T('From the content pack {name}', {name: pack.name})),
          h('textarea', {id: 'f-pack-' + index, rows: Math.min(10, pack.rules.length + 1), readonly: true}, pack.rules.join('\n'))))] : []);
  };
  const openWorld = () => {
    if (model.world || !leave()) return;
    model.key = ''; model.data = null; model.draft = null; model.custom = null; model.look = null; dropVoice(); clearTimeout(model.prompting?.timer); model.prompting = null;
    model.world = {draft: {worldRules: model.state.worldRules.text}};
    closePicker(false); drawMain();
    $('main').focus({preventScroll: true});
  };

  // ---- prompting: how each conversation option (Mistral, Local AI Lite and Standard, the same with Mature content on, and the player's Custom models) is told to answer.
  // The server (bridge/prompting-editor.mjs) keeps the shipped default, the player's change and the effective profile of each option. The page edits a draft of the effective
  // profile (numbers as the text of their boxes) and sends only what differs from the saved one; the preview asks the server to render the draft, so what is shown is what the
  // prompt builder would write. Nothing is stored until Save.
  // The sampling boxes that have an Off box (not sent while off), and the value a box starts with when Off is cleared and nothing was shipped.
  const OPTIONAL_SAMPLING = ['topP', 'topK', 'minP', 'repeatPenalty', 'presencePenalty', 'frequencyPenalty'];
  const PROMPT_START = {topP: 0.9, topK: 40, minP: 0.05, repeatPenalty: 1.1, presencePenalty: 0, frequencyPenalty: 0};
  const numText = value => (value === null || value === undefined ? '' : String(value));
  const numOf = text => { const value = String(text).trim(); return value === '' ? null : Number(value); };
  const ruleOut = rule => ({id: rule.id, text: rule.text, ...(rule.talk && rule.talk.trim() ? {talk: rule.talk} : {}), ...(rule.mature && rule.mature.trim() ? {mature: rule.mature} : {})});
  const toDraft = eff => ({
    rules: eff.rules.map(rule => ({id: rule.id, text: rule.text, talk: rule.talk || '', mature: rule.mature || ''})),
    examples: [...eff.examples], stop: [...eff.stop],
    intro: {...eff.intro}, closing: {...eff.closing}, labels: {...eff.labels}, layout: {...eff.layout},
    sampling: {temperature: numText(eff.sampling.temperature), maxTokens: numText(eff.sampling.maxTokens), extra: eff.sampling.extra ? JSON.stringify(eff.sampling.extra, null, 2) : '',
      ...Object.fromEntries(OPTIONAL_SAMPLING.flatMap(key => [[key, numText(eff.sampling[key])], [key + 'Off', eff.sampling[key] === null]]))},
    limits: {persona: numText(eff.limits.persona), turns: numText(eff.limits.turns)},
    matureLayer: {...eff.matureLayer},
  });
  // The change the draft makes to the saved profile `eff`, in the shape the server takes: whole lists, and only the sub-fields of an object that differ.
  const patchOf = (draft, eff) => {
    const patch = {};
    const rules = draft.rules.map(ruleOut);
    if (!same(rules, eff.rules.map(ruleOut))) patch.rules = rules;
    if (!same(draft.examples, eff.examples)) patch.examples = [...draft.examples];
    if (!same(draft.stop, eff.stop)) patch.stop = [...draft.stop];
    for (const field of ['intro', 'closing', 'labels', 'layout', 'matureLayer']) {
      const out = {};
      for (const key of Object.keys(draft[field])) if (!same(draft[field][key], eff[field][key])) out[key] = draft[field][key];
      if (Object.keys(out).length) patch[field] = out;
    }
    const sampling = {};
    for (const key of ['temperature', 'maxTokens']) { const value = numOf(draft.sampling[key]); if (!same(value, eff.sampling[key])) sampling[key] = value; }
    for (const key of OPTIONAL_SAMPLING) {
      if (draft.sampling[key + 'Off']) { if (eff.sampling[key] !== null) sampling[key] = 'off'; } else { const value = numOf(draft.sampling[key]); if (!same(value, eff.sampling[key])) sampling[key] = value; }
    }
    // The advanced parameters go as the JSON they are; text that is not JSON goes as text, and the server says what is wrong with it. Empty text, or {}, is none.
    const typed = draft.sampling.extra.trim();
    let extra = null;
    if (typed) { try { extra = JSON.parse(typed); } catch { extra = typed; } }
    if (extra !== null && typeof extra === 'object' && !Array.isArray(extra) && !Object.keys(extra).length) extra = null;
    if (!same(extra, eff.sampling.extra)) sampling.extra = extra;
    if (Object.keys(sampling).length) patch.sampling = sampling;
    const limits = {};
    for (const key of ['persona', 'turns']) { const value = numOf(draft.limits[key]); if (!same(value, eff.limits[key])) limits[key] = value; }
    if (Object.keys(limits).length) patch.limits = limits;
    return patch;
  };
  const promptingDirty = () => !!model.prompting && !!model.prompting.data && Object.keys(patchOf(model.prompting.draft, model.prompting.data.effective)).length > 0;
  const profileName = row => (row.provider === 'custom' ? T('Custom: {model} at {host}', {model: row.models || '', host: row.host || ''})
    : {mistral: T('Mistral'), 'local-lite': T('Local AI, Lite'), 'local-standard': T('Local AI, Standard'), 'mature-lite': T('Local AI, Lite, Mature on'), 'mature-standard': T('Local AI, Standard, Mature on')}[row.id] || row.label);
  const labelNames = () => ({rules: T('Heading of the output rules'), examples: T('Heading of the example replies'), formatNotes: T('Heading of the format notes'), world: T('Heading of the world and quest context'),
    remember: T('Heading of what the character remembers'), rightNow: T('Heading of the right-now facts'), youNow: T('Heading of the character’s own right-now facts'),
    thisTurn: T('Heading of the notes for this turn'), things: T('Heading of the things remembered about V')});
  const fieldNames = () => ({'intro.named': T('Opening line for a named character'), 'intro.ambient': T('Opening line for an ordinary person'),
    'closing.text': T('Closing line'), 'closing.talk': T('Closing line for a speaker with a reply length of its own'),
    'sampling.temperature': T('Temperature'), 'sampling.topP': T('Top P'), 'sampling.topK': T('Top K'), 'sampling.minP': T('Min P'), 'sampling.repeatPenalty': T('Repeat penalty'),
    'sampling.presencePenalty': T('Presence penalty'), 'sampling.frequencyPenalty': T('Frequency penalty'), 'sampling.maxTokens': T('Longest reply (in tokens)'), 'sampling.extra': T('Advanced parameters (JSON)'),
    'limits.persona': T('Longest character description, in characters'), 'limits.turns': T('Earlier turns kept'), 'layout.youNow': T('Right-now sentence'), 'layout.volatile': T('Notes for this turn'),
    ...Object.fromEntries(Object.entries(labelNames()).map(([key, name]) => ['labels.' + key, name])), ...matureNames()});
  // The parts of the Mature layer: four lines have a version for models that allow explicit sex and one for models that keep it suggestive.
  const MATURE_LINES = ['speech', 'words', 'romance', 'closing'];
  const matureNames = () => ({
    ...Object.fromEntries(Object.entries({speech: T('Speech line'), words: T('Word bank'), romance: T('Romance line'), closing: T('Closing clause')}).flatMap(([key, part]) => [
      ['matureLayer.' + key + 'Full', T('{part}, for models that allow explicit sex', {part})], ['matureLayer.' + key + 'Suggestive', T('{part}, for models that keep sex suggestive', {part})]])),
    'matureLayer.tone': T('Tone line'), 'matureLayer.use': T('Partner paragraph: affection and desire'), 'matureLayer.limits': T('Partner paragraph: nothing invented')});
  const errorKey = item => item.field + (item.index !== undefined ? '#' + item.index : '') + (item.key ? ':' + item.key : '');
  // One problem as a sentence in the player's language. A problem about one box says which box.
  const EXTRA_EXAMPLE = '{"typical_p": 0.9, "mirostat": 2}';
  const promptingText = item => {
    const values = {max: item.max, min: item.min, n: (item.index || 0) + 1};
    let text;
    switch (item.code) {
      case 'unknown-profile': return T('That prompting option was not found.');
      case 'rules-few': text = T('Keep at least one rule.'); break;
      case 'rules-many': text = T('Too many rules. Keep {max} or fewer.', values); break;
      case 'rule-empty': text = T('Rule {n} is empty. Write the rule or delete it.', values); break;
      case 'rule-long': text = T('Rule {n} is too long. Keep each one under {max} characters.', values); break;
      case 'rules-total': text = T('The rules are too long together. Keep them under {max} characters in all.', values); break;
      case 'examples-many': text = T('Too many example lines. Keep {max} or fewer.', values); break;
      case 'examples-long': text = T('An example line is too long. Keep each one under {max} characters.', values); break;
      case 'examples-total': text = T('The example lines are too long together. Keep them under {max} characters in all.', values); break;
      case 'intro-long': case 'closing-long': case 'labels-long': case 'matureLayer-long': text = T('This text is too long. Keep it under {max} characters.', values); break;
      case 'empty': text = T('This text cannot be empty.'); break;
      case 'out-of-range': text = T('Use a number from {min} to {max}.', values); break;
      case 'no-mature-layer': text = T('This option does not get the Mature layer.'); break;
      case 'not-for-mistral': text = T('Mistral does not take this setting.'); break;
      case 'extra-json': text = T('That is not valid JSON.'); break;
      case 'extra-type': text = T('This must be a JSON object, for example {example}.', {example: EXTRA_EXAMPLE}); break;
      case 'extra-big': text = T('This text is too long. Keep it under {max} characters.', values); break;
      case 'extra-many': text = T('Too many keys. Keep {max} or fewer.', values); break;
      case 'extra-name': text = T('“{name}” is not a usable key name. Use letters, digits and underscores.', {name: item.name}); break;
      case 'extra-box': text = T('“{name}” has its own setting in this form. Use that instead.', {name: item.name}); break;
      case 'extra-length': text = T('Use the Longest reply box for the length of a reply, not “{name}”.', {name: item.name}); break;
      case 'extra-reserved': text = T('“{name}” is set by the mod and cannot be changed here.', {name: item.name}); break;
      case 'extra-value': text = T('“{name}” needs a number, a text, true or false, or a list of those.', {name: item.name}); break;
      case 'stop-many': text = T('Too many stop texts. Keep {max} or fewer.', values); break;
      case 'stop-long': text = T('A stop text is too long. Keep each one under {max} characters.', values); break;
      default: return T('Could not save. Try again.');
    }
    const name = item.key ? fieldNames()[item.field + '.' + item.key] : '';
    return name ? T('{field}: {message}', {field: name, message: text}) : text;
  };
  const promptingProblem = error => (error.status === 404 ? T('That prompting option was not found.') : error.errors && error.errors[0] ? promptingText(error.errors[0]) : T('Could not save. Try again.'));
  const promptPath = (id, rest) => '/api/prompting/' + encodeURIComponent(id) + (rest || '');

  const promptingPanel = () => {
    const p = model.prompting, data = p.data;
    const row = p.profiles.find(item => item.id === p.id);
    const badges = item => [item.active ? h('span', {class: 'chip edited'}, T('In use now')) : null, item.changed ? h('span', {class: 'chip edited'}, T('Edited')) : null];
    const pickers = rows => h('div', {class: 'profiles'}, rows.map(item => h('button', {type: 'button', class: 'pick profile' + (item.id === p.id ? ' on' : ''), 'aria-current': item.id === p.id ? 'true' : null,
      onclick: () => choosePrompting(item.id)}, h('span', {}, profileName(item)), badges(item))));
    const builtIn = p.profiles.filter(item => item.provider !== 'custom'), custom = p.profiles.filter(item => item.provider === 'custom');
    const top = h('div', {},
      h('p', {class: 'help'}, T('How each conversation option is told to answer. Every option has its own prompting. A change counts from the next reply, and nothing needs restarting.')),
      h('p', {class: 'help'}, T('The facts the characters get from the game and a short list of safety filters cannot be edited here. Convai’s prompting lives on Convai’s side.')),
      h('h3', {class: 'group'}, T('Mistral and Local AI')), pickers(builtIn),
      h('p', {class: 'help'}, T('Lite and Standard are the two Local AI model sizes. “Mature on” is used while Mature content is on.')),
      h('h3', {class: 'group'}, T('Your Custom models and APIs')),
      custom.length ? pickers(custom) : h('p', {class: 'empty'}, T('A Custom model appears here once you choose Custom as the conversation provider and set a model.')));
    if (!data) return top;
    p.ui = {errs: {}, top: h('div', {class: 'errs', role: 'alert'}), preview: h('div', {class: 'previewbody'}), save: null, revert: null, totals: null};
    const heading = h('div', {class: 'head'}, h('h2', {}, profileName(row)), badges(row),
      h('button', {type: 'button', class: 'quiet', disabled: !Object.keys(data.override).length, onclick: () => resetPrompting()}, withIcon('undo', T('Reset everything'))));
    // Content packs (add-ons, bridge/addon-content.mjs) that change this profile: the effective profile below already has their wording; the player's changes stay on top of it.
    const packNote = data.packs && data.packs.length ? h('p', {class: 'help'}, T('Content packs that change this prompt: {names}. Your own changes stay on top of theirs, and Reset to default goes back to the pack’s wording.', {names: data.packs.join(', ')})) : null;
    return h('div', {}, top, h('hr'), heading, packNote, p.ui.top, h('div', {class: 'pcols'}, h('div', {class: 'pedit'}, ...promptingSections(), promptingBar()), promptingPreview()));
  };

  const promptingChanged = () => {
    const p = model.prompting, dirty = promptingDirty();
    if (p.ui.save) p.ui.save.disabled = !dirty;
    if (p.ui.revert) p.ui.revert.disabled = !dirty;
    if (p.ui.totals) p.ui.totals();
    schedulePreview();
  };
  const promptingBar = () => {
    const p = model.prompting;
    p.ui.save = h('button', {type: 'button', class: 'primary', onclick: savePrompting}, withIcon('save', T('Save')));
    p.ui.revert = h('button', {type: 'button', class: 'secondary', onclick: revertPrompting}, withIcon('undo', T('Revert changes')));
    p.ui.save.disabled = p.ui.revert.disabled = !promptingDirty();
    return h('div', {class: 'actions bar sticky'}, p.ui.save, p.ui.revert, flag());
  };
  const section = (field, title, help, ...children) => {
    const p = model.prompting;
    const errs = h('div', {class: 'errs', role: 'alert'});
    p.ui.errs[field] = errs;
    const undo = h('button', {type: 'button', class: 'quiet', disabled: !(field in p.data.override), onclick: () => resetPrompting(field)}, withIcon('undo', T('Reset to default')));
    return h('section', {class: 'psec', 'data-field': field}, h('div', {class: 'phead'}, h('h3', {}, title), undo), help ? h('p', {class: 'help'}, help) : null, ...children, errs);
  };
  const textBox = (id, label, value, max, mark, set, rows = 3) => {
    const area = h('textarea', {id, rows, spellcheck: 'true', maxlength: String(max * 3), 'data-err': mark});
    area.value = value;
    const meter = h('div', {class: 'meter'}, counter(value, max));
    area.addEventListener('input', () => { set(area.value); meter.replaceChildren(counter(area.value, max)); promptingChanged(); });
    return h('div', {class: 'field'}, h('label', {for: id}, label), area, meter);
  };
  const numberBox = (id, label, value, [low, high], mark, set, {integer = false, hint = null, disabled = false} = {}) => {
    const input = h('input', {type: 'number', id, min: String(low), max: String(high), step: integer ? '1' : 'any', inputmode: integer ? 'numeric' : 'decimal', 'data-err': mark, 'aria-describedby': id + '-h'});
    input.value = value; input.disabled = disabled;
    input.addEventListener('input', () => { set(input.value); promptingChanged(); });
    return {input, node: h('div', {class: 'field num'}, h('label', {for: id}, label), input,
      h('p', {class: 'help', id: id + '-h'}, T('From {min} to {max}.', {min: low, max: high}) + (hint ? ' ' + hint : '')))};
  };
  const shippedText = value => T('Shipped: {value}', {value});

  // The rules: numbered, in order. Each has its text and two other versions (for a speaker with a reply length of its own, and for Mature content).
  const rulesField = () => {
    const p = model.prompting, d = p.draft, L = model.state.prompting.limits;
    const mistral = p.profiles.find(item => item.id === p.id).provider === 'mistral';
    const box = h('div', {class: 'list rules'}), total = h('div', {class: 'meter'});
    const sum = () => d.rules.reduce((all, rule) => all + count(rule.text) + count(rule.talk) + count(rule.mature), 0);
    const updateTotal = () => total.replaceChildren(h('span', {class: 'count' + (sum() > L.rulesTotal ? ' over' : '')}, T('{count} of {max}', {count: sum(), max: L.rulesTotal})));
    p.ui.totals = updateTotal;
    const draw = () => {
      box.replaceChildren(...d.rules.map((rule, index) => {
        const n = index + 1;
        const field = (key, label, rows) => {
          const area = h('textarea', {rows, spellcheck: 'true', maxlength: String(L.ruleText * 3), 'aria-label': label, 'data-err': key === 'text' ? 'rules#' + index : null});
          area.value = rule[key];
          const meter = h('span', {class: 'count' + (count(area.value) > L.ruleText ? ' over' : '')}, T('{count} of {max}', {count: count(area.value), max: L.ruleText}));
          area.addEventListener('input', () => {
            rule[key] = area.value;
            meter.textContent = T('{count} of {max}', {count: count(area.value), max: L.ruleText});
            meter.className = 'count' + (count(area.value) > L.ruleText ? ' over' : '');
            promptingChanged();
          });
          return {area, meter};
        };
        const body = field('text', T('Rule {n}', {n}), 3), talk = field('talk', T('Rule {n}, for a speaker with a reply length of its own', {n}), 2), mature = field('mature', T('Rule {n}, for Mature content', {n}), 2);
        const move = by => () => { const [item] = d.rules.splice(index, 1); d.rules.splice(index + by, 0, item); draw(); promptingChanged(); };
        return h('div', {class: 'rule'},
          h('div', {class: 'rulehead'}, h('strong', {}, T('Rule {n}', {n})), h('span', {class: 'grow'}), body.meter,
            h('button', {type: 'button', class: 'quiet icon-btn', disabled: index === 0, 'aria-label': T('Move rule {n} up', {n}), title: T('Move up'), onclick: move(-1)}, icon('arrowUp')),
            h('button', {type: 'button', class: 'quiet icon-btn', disabled: index === d.rules.length - 1, 'aria-label': T('Move rule {n} down', {n}), title: T('Move down'), onclick: move(1)}, icon('arrowDown')),
            h('button', {type: 'button', class: 'quiet icon-btn', 'aria-label': T('Delete rule {n}', {n}), title: T('Delete'), onclick: () => { d.rules.splice(index, 1); draw(); promptingChanged(); }}, icon('trash'))),
          body.area,
          h('details', {class: 'variants', open: !!(rule.talk || rule.mature)}, h('summary', {}, T('Other versions of this rule')),
            h('p', {class: 'help'}, T('Leave a version empty to use the rule text.')),
            h('div', {class: 'sub'}, h('span', {}, T('For a speaker with a reply length of its own')), talk.meter, talk.area),
            mistral && !rule.mature ? null : h('div', {class: 'sub'}, h('span', {}, T('For Mature content')), mature.meter, mature.area)));
      }));
      add.disabled = d.rules.length >= L.rules;
      updateTotal();
    };
    const add = h('button', {type: 'button', class: 'secondary', onclick: () => {
      const taken = new Set(d.rules.map(rule => rule.id));
      let number = d.rules.length + 1;
      while (taken.has('own-' + number)) number++;
      d.rules.push({id: 'own-' + number, text: '', talk: '', mature: ''});
      draw(); promptingChanged();
      [...box.querySelectorAll('.rule')].pop()?.querySelector('textarea')?.focus();
    }}, withIcon('plus', T('Add a rule')));
    draw();
    return [box, total, h('div', {class: 'actions'}, add)];
  };
  // A list of short texts (example replies, stop texts): one box each, added and deleted.
  const linesField = (key, addLabel, placeholder, maxCount, maxEach, rows, aria) => {
    const d = model.prompting.draft;
    const box = h('div', {class: 'list'});
    const draw = () => {
      box.replaceChildren(...d[key].map((line, index) => {
        const attributes = {'aria-label': aria(index + 1), placeholder, maxlength: String(maxEach * 3), 'data-err': key + '#' + index};
        const input = rows > 1 ? h('textarea', {rows, ...attributes}) : h('input', {type: 'text', ...attributes});
        input.value = line;
        const meter = h('span', {class: 'count' + (count(line) > maxEach ? ' over' : '')}, T('{count} of {max}', {count: count(line), max: maxEach}));
        input.addEventListener('input', () => {
          d[key][index] = input.value;
          meter.textContent = T('{count} of {max}', {count: count(input.value), max: maxEach});
          meter.className = 'count' + (count(input.value) > maxEach ? ' over' : '');
          promptingChanged();
        });
        return h('div', {class: 'row' + (rows > 1 ? ' tall' : '')}, input, meter, h('button', {type: 'button', class: 'quiet icon-btn', 'aria-label': T('Delete'), title: T('Delete'), onclick: () => { d[key].splice(index, 1); draw(); promptingChanged(); }}, icon('trash')));
      }));
      add.disabled = d[key].length >= maxCount;
    };
    const add = h('button', {type: 'button', class: 'secondary', onclick: () => {
      d[key].push(''); draw(); promptingChanged();
      const fields = box.querySelectorAll('input,textarea'); fields[fields.length - 1]?.focus();
    }}, withIcon('plus', addLabel));
    draw();
    return [box, h('div', {class: 'actions'}, add)];
  };

  const promptingSections = () => {
    const p = model.prompting, d = p.draft, L = model.state.prompting.limits, shipped = p.data.default;
    const names = fieldNames(), tokens = {name: '{name}', words: '{words}'};
    const sampling = () => {
      const make = (key, label, range, options) => numberBox('p-sampling-' + key, label, d.sampling[key], range, 'sampling:' + key, value => { d.sampling[key] = value; }, options);
      // The optional boxes (Top P, Top K, Min P and the penalties) are not sent to the model while they are off.
      const optional = (key, label, range, more = {}) => {
        const box = make(key, label, range, {...more, hint: shipped.sampling[key] === null ? T('Shipped: off') : shippedText(shipped.sampling[key]), disabled: d.sampling[key + 'Off']});
        const off = h('input', {type: 'checkbox', id: 'p-sampling-' + key + '-off'});
        off.checked = d.sampling[key + 'Off'];
        off.addEventListener('change', () => {
          d.sampling[key + 'Off'] = off.checked;
          if (!off.checked && box.input.value === '') { d.sampling[key] = String(shipped.sampling[key] ?? PROMPT_START[key]); box.input.value = d.sampling[key]; }
          box.input.disabled = off.checked;
          promptingChanged();
        });
        return h('div', {class: 'numrow'}, box.node, h('label', {class: 'check', for: 'p-sampling-' + key + '-off'}, off, h('span', {}, T('Off'))));
      };
      // Mistral's API takes neither Top K and Min P nor extra fields (it refuses an unknown one), so those are left out for it, with a note.
      const mistral = p.profiles.find(item => item.id === p.id).provider === 'mistral';
      const advanced = () => {
        const node = textBox('p-sampling-extra', names['sampling.extra'], d.sampling.extra, L.extra, 'sampling:extra', value => { d.sampling.extra = value; }, 5);
        node.classList.add('json');
        return [h('p', {class: 'help'}, T('Extra settings added to every reply, written as a JSON object, for example {example}. Use it for samplers that have no box above. A setting that has its own box above is refused. If a server refuses a setting, it is left out and the reply still comes.', {example: EXTRA_EXAMPLE})), node];
      };
      return [h('div', {class: 'numrow'}, make('temperature', names['sampling.temperature'], L.temperature, {hint: shippedText(shipped.sampling.temperature)}).node),
        optional('topP', names['sampling.topP'], L.topP), mistral ? null : optional('topK', names['sampling.topK'], L.topK, {integer: true}), mistral ? null : optional('minP', names['sampling.minP'], L.minP),
        optional('repeatPenalty', names['sampling.repeatPenalty'], L.repeatPenalty), optional('presencePenalty', names['sampling.presencePenalty'], L.presencePenalty),
        optional('frequencyPenalty', names['sampling.frequencyPenalty'], L.frequencyPenalty),
        h('div', {class: 'numrow'}, make('maxTokens', names['sampling.maxTokens'], L.maxTokens, {integer: true, hint: shippedText(shipped.sampling.maxTokens)}).node),
        ...(mistral ? [h('p', {class: 'help'}, T('Mistral takes only the settings shown here. Top K, Min P and the advanced JSON are for Local AI and Custom models.'))] : advanced())];
    };
    const limits = () => ['persona', 'turns'].map(key => numberBox('p-limits-' + key, names['limits.' + key], d.limits[key], L[key], 'limits:' + key, value => { d.limits[key] = value; },
      {integer: true, hint: shipped.limits[key] === null ? T('Shipped: the mod’s own limit') : shippedText(shipped.limits[key])}).node);
    const layout = () => {
      const check = h('input', {type: 'checkbox', id: 'p-layout-youNow', 'data-err': 'layout:youNow'});
      check.checked = d.layout.youNow;
      check.addEventListener('change', () => { d.layout.youNow = check.checked; promptingChanged(); });
      const select = h('select', {id: 'p-layout-volatile', 'data-err': 'layout:volatile'}, h('option', {value: 'before'}, T('before V’s words')), h('option', {value: 'after'}, T('after V’s words')));
      select.value = d.layout.volatile;
      select.addEventListener('change', () => { d.layout.volatile = select.value; promptingChanged(); });
      return [h('label', {class: 'check', for: 'p-layout-youNow'}, check, h('span', {}, T('Repeat the “where you are” sentence right before V’s words'))),
        h('div', {class: 'field'}, h('label', {for: 'p-layout-volatile'}, T('The notes for this turn go')), select)];
    };
    const headings = () => Object.entries(labelNames()).map(([key, label]) => {
      const input = h('input', {type: 'text', id: 'p-labels-' + key, maxlength: String(L.label * 3), 'data-err': 'labels:' + key});
      input.value = d.labels[key];
      input.addEventListener('input', () => { d.labels[key] = input.value; promptingChanged(); });
      return h('div', {class: 'field'}, h('label', {for: 'p-labels-' + key}, label), input);
    });
    // The Mature layer's wording: on the Mature options and the Custom ones (the options whose turns get the layer while Mature content is on).
    const mature = () => {
      const row = p.profiles.find(item => item.id === p.id);
      if (!(row.id.startsWith('mature-') || row.provider === 'custom')) return null;
      const box = key => textBox('p-mature-' + key, names['matureLayer.' + key], d.matureLayer[key], L.matureText, 'matureLayer:' + key, value => { d.matureLayer[key] = value; });
      const keys = [...MATURE_LINES.flatMap(key => [key + 'Full', key + 'Suggestive']), 'tone', 'use', 'limits'];
      return section('matureLayer', T('Mature layer'), T('The wording added while Mature content is on. The mod picks the explicit or the suggestive version of a line from what the loaded model allows, so edit the version your model uses. An emptied box leaves that line out. The adults-only line and the hard limits are always added last and cannot be edited.'), ...keys.map(box));
    };
    return [
      section('rules', T('Output rules'), T('The numbered rules the model reads before every reply. Use {name} for the character’s name and {words} for the reply length of a speaker that has one.', tokens), ...rulesField()),
      section('examples', T('Example replies'), T('Replies shown to the model after the rules. A small model may copy them word for word, so add none, or keep them short and plain.'),
        ...linesField('examples', T('Add an example reply'), T('An example reply'), L.examples, L.example, 1, n => T('Example reply {n}', {n}))),
      section('intro', T('Opening line'), T('The first line of the character text. Use {name} for the character’s name.', tokens),
        textBox('p-intro-named', names['intro.named'], d.intro.named, L.intro, 'intro:named', value => { d.intro.named = value; }),
        textBox('p-intro-ambient', names['intro.ambient'], d.intro.ambient, L.intro, 'intro:ambient', value => { d.intro.ambient = value; })),
      section('closing', T('Closing line'), T('The last thing the model reads before it answers. Use {name} for the character’s name and {words} for the reply length. The Mature setting adds its own clause after it.', tokens),
        textBox('p-closing-text', names['closing.text'], d.closing.text, L.closing, 'closing:text', value => { d.closing.text = value; }),
        textBox('p-closing-talk', names['closing.talk'], d.closing.talk, L.closing, 'closing:talk', value => { d.closing.talk = value; })),
      section('labels', T('Section headings'), T('The headings that mark each part of the prompt. Change the wording, not the order.'), ...headings()),
      section('layout', T('Layout'), T('Where some notes go in the prompt.'), ...layout()),
      section('sampling', T('Sampling'), T('How freely the model words its reply. Leave a box empty to use the shipped value.'), ...sampling()),
      section('limits', T('Length limits'), T('Shorten what the model reads, which makes replies faster. The mod’s own limits still apply, so these can only make things shorter.'), ...limits()),
      section('stop', T('Stop texts'), T('A reply ends when the model writes one of these. Line breaks count. Up to {max}.', {max: L.stops}),
        ...linesField('stop', T('Add a stop text'), T('A text that ends the reply'), L.stops, L.stop, 2, n => T('Stop text {n}', {n}))),
      mature()];
  };

  // The preview: the rules, the example replies and the closing line as the prompt builder writes them for a sample speaker.
  const promptingPreview = () => {
    const p = model.prompting, spec = model.state.prompting, s = p.sample;
    const name = h('input', {type: 'text', id: 'p-sample-name', maxlength: String(spec.previewName * 3)});
    name.value = s.name;
    name.addEventListener('input', () => { s.name = name.value; schedulePreview(); });
    const mature = h('input', {type: 'checkbox', id: 'p-sample-mature'});
    mature.checked = s.mature;
    mature.addEventListener('change', () => { s.mature = mature.checked; schedulePreview(); });
    const words = h('input', {type: 'number', id: 'p-sample-words', min: String(spec.previewWords[0]), max: String(spec.previewWords[1]), step: '1', inputmode: 'numeric'});
    words.value = String(s.words); words.disabled = !s.talk;
    words.addEventListener('input', () => { const value = Number(words.value); if (Number.isInteger(value) && value >= spec.previewWords[0] && value <= spec.previewWords[1]) { s.words = value; schedulePreview(); } });
    const talk = h('input', {type: 'checkbox', id: 'p-sample-talk'});
    talk.checked = s.talk;
    talk.addEventListener('change', () => { s.talk = talk.checked; words.disabled = !talk.checked; schedulePreview(); });
    schedulePreview(true);
    return h('aside', {class: 'ppreview', 'aria-label': T('Preview')}, h('h3', {}, T('Preview')),
      h('p', {class: 'help'}, T('The prompt text as the model would read it for a sample character. It follows your edits as you type, before you save.')),
      h('div', {class: 'field'}, h('label', {for: 'p-sample-name'}, T('Sample character name')), name),
      h('label', {class: 'check', for: 'p-sample-talk'}, talk, h('span', {}, T('A speaker with a reply length of its own'))),
      h('div', {class: 'field'}, h('label', {for: 'p-sample-words'}, T('Reply length in words')), words),
      h('label', {class: 'check', for: 'p-sample-mature'}, mature, h('span', {}, T('Mature content is on'))),
      p.ui.preview);
  };
  const drawPreview = () => {
    const p = model.prompting, shown = p.preview;
    if (!shown) { p.ui.preview.replaceChildren(); return; }
    const block = (title, text, empty) => [h('h4', {}, title), text ? h('pre', {}, text) : h('p', {class: 'empty'}, empty)];
    p.ui.preview.replaceChildren(...[p.stale ? h('p', {class: 'help stale', role: 'status'}, T('The preview waits until the problems in the form are fixed.')) : null,
      ...block(T('Output rules'), shown.rules, ''), ...block(T('Example replies'), shown.examples, T('No example replies.')), ...block(T('Closing line'), shown.closing, T('No closing line.')),
      ...(shown.mature ? [...block(T('Mature layer and closing line, for models that allow explicit sex'), shown.mature.full, ''), ...block(T('Mature layer and closing line, for models that keep sex suggestive'), shown.mature.suggestive, '')] : [])].filter(node => node));
  };
  // The unsaved edits are rendered by the server a moment after the last key press (and an older answer never replaces a newer one). The same answer carries the problems found
  // in the form, which are shown at once in the sections they belong to.
  function schedulePreview(now) {
    const p = model.prompting;
    if (!p || !p.data) return;
    clearTimeout(p.timer);
    const run = async () => {
      const seq = ++p.seq, id = p.id;
      try {
        const reply = await api('POST', promptPath(id, '/preview'), {name: p.sample.name, talkWords: p.sample.talk ? p.sample.words : 0, mature: p.sample.mature, patch: patchOf(p.draft, p.data.effective)});
        if (model.prompting !== p || p.id !== id || seq !== p.seq) return;
        if (reply.ok) { p.preview = reply; p.stale = false; showPromptingErrors([]); } else { p.stale = true; showPromptingErrors(reply.errors); }
        drawPreview();
      } catch (error) { if (model.prompting === p && seq === p.seq) say(promptingProblem(error), true); }
    };
    if (now) void run(); else p.timer = setTimeout(run, 300);
  }
  function showPromptingErrors(list) {
    const p = model.prompting;
    p.errors = list;
    for (const [field, node] of Object.entries(p.ui.errs)) node.replaceChildren(...list.filter(item => item.field === field).map(item => h('p', {class: 'err'}, promptingText(item))));
    p.ui.top.replaceChildren(...list.filter(item => !(item.field in p.ui.errs)).map(item => h('p', {class: 'err'}, promptingText(item))));
    const keys = new Set(list.map(errorKey));
    for (const node of $('main').querySelectorAll('[data-err]')) { if (keys.has(node.dataset.err)) node.setAttribute('aria-invalid', 'true'); else node.removeAttribute('aria-invalid'); }
  }

  const keepScroll = draw => { const top = window.scrollY; draw(); window.scrollTo(0, top); };
  // A reply of the server about the open option: remember it and draw again. `only`: the one field whose draft is replaced (a reset of one part), the other edits stay.
  const promptingLanded = (data, only) => {
    const p = model.prompting, fresh = toDraft(data.effective);
    p.data = data;
    p.draft = only ? {...p.draft, [only]: fresh[only]} : fresh;
    const row = p.profiles.find(item => item.id === data.id);
    if (row) { row.changed = Object.keys(data.override).length > 0; row.active = data.active; }
    p.errors = []; p.preview = null; p.stale = false;
    keepScroll(drawMain);
  };
  async function savePrompting() {
    const p = model.prompting, patch = patchOf(p.draft, p.data.effective);
    if (!Object.keys(patch).length) return;
    try { hush(); promptingLanded(await api('PUT', promptPath(p.id), patch)); say(T('Saved.')); }
    catch (error) {
      if (error.status === 422 && model.prompting === p) showPromptingErrors(error.errors || []);
      say(promptingProblem(error), true);
    }
  }
  function revertPrompting() {
    const p = model.prompting;
    p.draft = toDraft(p.data.effective); p.errors = []; p.stale = false;
    keepScroll(drawMain);
  }
  async function resetPrompting(field) {
    const p = model.prompting, name = profileName(p.profiles.find(item => item.id === p.id));
    if (!confirm(field ? T('Go back to the shipped prompting for {name}? Your changes to this part are removed.', {name}) : T('Go back to the shipped prompting for {name}? All your changes to it are removed.', {name}))) return;
    try { hush(); promptingLanded(await api('POST', promptPath(p.id, '/reset'), field ? {field} : {}), field); say(T('Back to the shipped prompting.')); }
    catch (error) { say(promptingProblem(error), true); }
  }
  async function choosePrompting(id) {
    const p = model.prompting;
    if (!p || id === p.id || !leave()) return;
    try {
      const data = await api('GET', promptPath(id));
      clearTimeout(p.timer); p.seq++;
      p.id = id;
      p.sample.mature = id.startsWith('mature');
      promptingLanded(data);
    } catch (error) { say(promptingProblem(error), true); }
  }
  const openPrompting = async () => {
    if (model.prompting || !leave()) return;
    try {
      const {profiles} = await api('GET', '/api/prompting');
      const first = profiles.find(item => item.active) || profiles[0];
      if (!first) return;
      const data = await api('GET', promptPath(first.id));
      model.key = ''; model.data = null; model.draft = null; model.custom = null; model.look = null; model.world = null; dropVoice();
      model.prompting = {profiles, id: first.id, data, draft: toDraft(data.effective), errors: [], preview: null, stale: false, seq: 0, timer: 0, ui: null,
        sample: {name: 'Judy', talk: false, words: 30, mature: first.id.startsWith('mature')}};
      closePicker(false); drawMain();
      $('main').focus({preventScroll: true});
    } catch (error) { say(promptingProblem(error), true); }
  };

  // ---- the page
  const TAB_ICONS = {bio: 'fileText', style: 'message', rules: 'listChecks', memories: 'bookmark', voice: 'mic', look: 'shirt'};
  const panel = tab => {
    buttons = [];
    if (tab === 'bio') return h('div', {}, blockField('bio', T('Bio'), T('Who this character is, what they know and how they look. A long bio makes replies slower, so keep it tight.'), 18), actions(['bio']));
    if (tab === 'style') return h('div', {}, blockField('style', T('Speaking style'), T('How they sound: pace, attitude, favourite habits of speech.'), 8),
      listField('examples', T('Example lines'), T('Lines in their voice. They show the tone only and are never said back word for word.'), T('Add a line'), T('A line this character might say')), actions(['style', 'examples']));
    if (tab === 'rules') return h('div', {}, listField('rules', T('Speaking rules'),
      T('Short rules this character always follows when talking, for example: Never swear. Answer in one sentence.'), T('Add a rule'), T('A short rule')), actions(['rules']));
    if (tab === 'voice' && model.voice) return h('div', {}, voiceSection(false));
    if (tab === 'look' && model.look) return h('div', {}, lookSection());
    return memoriesPanel();
  };

  // ---- who is who: the role of a character (the server names it for the shipped ones), and the little badge that stands for them
  const ROLES = ['own', 'romance', 'companion', 'story', 'side', 'minor', 'v'];
  const ROLE_ICONS = {own: 'userPlus', romance: 'heart', companion: 'users', story: 'book', side: 'user', minor: 'user', v: 'mic'};
  const roleOf = item => item.group === 'custom' ? 'own' : item.group === 'v' ? 'v' : ROLES.includes(item.role) ? item.role : item.group === 'story' ? 'story' : 'side';
  const roleTitles = () => ({own: T('Your characters'), romance: T('Romances'), companion: T('Companions'), story: T('Story'), side: T('Side characters'), minor: T('Minor characters'), v: T('V’s voice')});
  const roleNames = () => ({own: T('Your character'), romance: T('Romance'), companion: T('Companion'), story: T('Story character'), side: T('Side character'), minor: T('Minor character'), v: T('V’s voice')});
  const initialsOf = item => {
    if (item.group === 'v') return 'V';
    const words = String(item.name || item.key || '?').replace(/[()]/g, ' ').split(/[\s._-]+/).filter(Boolean);
    const first = Array.from(words[0] || '?')[0], last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
    return (first + last).toUpperCase();
  };
  const toneOf = key => { let sum = 0; for (const letter of String(key)) sum = (sum * 31 + letter.charCodeAt(0)) >>> 0; return sum % 6; };
  const avatar = (item, big) => h('span', {class: 'avatar tone-' + toneOf(item.key) + (big ? ' big' : ''), 'aria-hidden': 'true'}, initialsOf(item));
  const norm = text => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ---- the picker: a panel with search, filter chips and a compact list. It opens under the top bar (the button with the open character's name, or / or Ctrl+K), and
  // stays open on the page while no character is chosen yet.
  const isIdle = () => !model.data && !model.world && !model.prompting;
  const pickerIsPopover = () => !$('picker').hidden && !$('picker').classList.contains('docked');
  const pickItem = item => {
    const role = roleOf(item), here = item.key === model.key;
    return h('button', {type: 'button', class: 'pick' + (here ? ' on' : ''), 'aria-current': here ? 'true' : null, 'data-key': item.key, onclick: () => pickKey(item.key)},
      avatar(item), h('span', {class: 'text'}, h('span', {class: 'name'}, item.name), h('span', {class: 'sub'}, roleNames()[role])),
      h('span', {class: 'marks'},
        item.voice ? h('span', {class: 'mark voice', role: 'img', 'aria-label': T('Custom voice'), title: T('Custom voice')}, icon('mic')) : null,
        item.edited ? h('span', {class: 'mark edited', role: 'img', 'aria-label': T('Edited'), title: T('Edited')}, icon('pencil')) : null));
  };
  function drawList() {
    const picker = $('picker');
    if (picker.hidden) return;
    const all = model.state.characters, query = norm(model.filter.trim());
    // The minor characters (the cast sweep's 575 ordinary people, docs/CAST_SWEEP.md) have their own chip. They stay out of All and of the other chips until the search
    // box has text, so the list is not endless, and a search still finds them.
    const isMinor = item => roleOf(item) === 'minor';
    const counts = {all: all.filter(item => !isMinor(item)).length, edited: all.filter(item => item.edited).length};
    for (const item of all) counts[roleOf(item)] = (counts[roleOf(item)] || 0) + 1;
    const titles = roleTitles();
    const chips = [['all', T('All'), null], ['romance', titles.romance, 'heart'], ['companion', titles.companion, 'users'], ['story', titles.story, 'book'], ['side', titles.side, 'user'],
      ['minor', titles.minor, 'user'], ['own', titles.own, 'userPlus'], ['edited', T('Edited'), 'pencil']].filter(([id]) => id === 'all' || counts[id]);
    if (!chips.some(([id]) => id === model.chip)) model.chip = 'all';
    $('chips').replaceChildren(...chips.map(([id, text, glyph]) => h('button', {type: 'button', class: 'fchip' + (model.chip === id ? ' on' : ''), 'aria-pressed': String(model.chip === id), 'data-chip': id,
      onclick: () => { model.chip = id; drawList(); $('chips').querySelector('[data-chip="' + id + '"]')?.focus(); }},
      glyph ? icon(glyph) : null, h('span', {}, text), h('span', {class: 'n'}, String(counts[id])))));
    const shown = all.filter(item => (model.chip === 'all' ? (query || !isMinor(item)) : model.chip === 'edited' ? item.edited : roleOf(item) === model.chip) && (!query || norm(item.name).includes(query)));
    const nodes = [];
    const section = (title, glyph, rows, extra) => nodes.push(h('section', {class: 'sect' + (extra ? ' ' + extra : '')}, h('h3', {class: 'group'}, glyph ? icon(glyph) : null, h('span', {}, title), h('span', {class: 'n'}, String(rows.length))),
      h('div', {class: 'grid'}, rows.map(pickItem))));
    if (!query && model.chip === 'all') {
      const facing = all.find(item => item.key === model.facing);
      if (facing) section(T('In front of you'), 'crosshair', [facing], 'quick');
      const seen = [...model.recent, ...all.filter(item => item.edited).map(item => item.key)];
      const recent = [...new Set(seen)].map(key => all.find(item => item.key === key)).filter(item => item && (item.edited || model.recent.includes(item.key))).slice(0, 6);
      if (recent.length) section(T('Recently edited'), 'clock', recent, 'quick');
    }
    for (const role of ROLES) {
      const rows = shown.filter(item => roleOf(item) === role);
      if (rows.length) section(titles[role], ROLE_ICONS[role], rows);
    }
    $('list').replaceChildren(...(shown.length ? nodes : [h('p', {class: 'empty'}, icon('search'), h('span', {}, T('No match.')))]));
    $('resultcount').textContent = T('{count} of {max}', {count: shown.length, max: query || model.chip === 'minor' ? all.length : counts.all});
    $('clear').hidden = !model.filter;
  }
  function syncPicker() {
    const picker = $('picker'), idle = isIdle();
    if (idle) {
      picker.hidden = false; picker.classList.add('docked'); $('scrim').hidden = true; $('who').setAttribute('aria-expanded', 'false');
      drawList();
    } else if (picker.classList.contains('docked')) {
      picker.hidden = true; picker.classList.remove('docked');
    }
    $('main').hidden = idle;
  }
  function openPicker() {
    if (!model.state) return;
    if (isIdle()) { $('search').focus(); return; }
    if (pickerIsPopover()) { $('search').focus(); return; }
    $('picker').hidden = false; $('scrim').hidden = false; $('who').setAttribute('aria-expanded', 'true');
    drawList();
    $('list').querySelector('.pick.on')?.scrollIntoView({block: 'nearest'});
    $('search').focus(); $('search').select();
  }
  function closePicker(restoreFocus) {
    if (!pickerIsPopover()) return;
    $('picker').hidden = true; $('scrim').hidden = true; $('who').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('who').focus();
  }
  async function pickKey(key) {
    closePicker(false);
    model.filter = ''; $('search').value = '';   // the next time the picker opens it starts fresh
    await choose(key);
  }
  // Arrow keys inside the picker: Down and Up move to the row below or above in the grid, Left and Right to the neighbour, and Up from the first row goes back to the search box.
  const moveFocus = (from, direction) => {
    const items = [...$('list').querySelectorAll('button.pick')], at = items.indexOf(from);
    if (at < 0) return;
    if (direction === 'right') { items[Math.min(items.length - 1, at + 1)].focus(); return; }
    if (direction === 'left') { if (at > 0) items[at - 1].focus(); return; }
    const top = from.offsetTop, left = from.offsetLeft, down = direction === 'down';
    const pool = down ? items.slice(at + 1) : items.slice(0, at).reverse();
    const rowTop = pool.find(item => down ? item.offsetTop > top : item.offsetTop < top)?.offsetTop;
    if (rowTop === undefined) { if (!down) $('search').focus(); return; }
    const row = pool.filter(item => item.offsetTop === rowTop);
    row.sort((a, b) => Math.abs(a.offsetLeft - left) - Math.abs(b.offsetLeft - left))[0].focus();
  };
  const onPickerKey = event => {
    if (event.key === 'Escape' && pickerIsPopover()) { event.preventDefault(); closePicker(true); return; }
    const onItem = event.target.matches && event.target.matches('button.pick');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.target === $('search')) { if (event.key === 'ArrowDown') { const first = $('list').querySelector('button.pick'); if (first) { event.preventDefault(); first.focus(); } } return; }
      if (onItem) { event.preventDefault(); moveFocus(event.target, event.key === 'ArrowDown' ? 'down' : 'up'); }
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && onItem) { event.preventDefault(); moveFocus(event.target, event.key === 'ArrowRight' ? 'right' : 'left'); }
    else if (event.key === 'Enter' && event.target === $('search')) { const first = $('list').querySelector('button.pick'); if (first) { event.preventDefault(); first.click(); } }
  };
  // The top bar's button: who is open now (or what page), and the way to the picker.
  function drawWho() {
    const who = $('who'), data = model.data;
    const entry = data && (model.state.characters.find(item => item.key === data.key) || data);
    // (The world rules and the prompting are pages of their own: the button then offers the way back to the characters.)
    const body = data ? [avatar(entry), h('span', {class: 'name'}, data.group === 'custom' && model.custom ? (model.custom.draft.name || data.name || T('New character')) : data.name || T('New character'))]
      : [icon('users'), h('span', {class: 'name dim'}, T('Choose a character'))];
    who.replaceChildren(h('span', {class: 'sr'}, T('Characters') + ': '), ...body, icon('chevronDown'));
    $('world').classList.toggle('on', !!model.world);
    $('prompting').classList.toggle('on', !!model.prompting);
    $('world').setAttribute('aria-current', model.world ? 'page' : 'false');
    $('prompting').setAttribute('aria-current', model.prompting ? 'page' : 'false');
  }
  const headOf = (entry, title, badges, ...actions) => h('div', {class: 'head'}, avatar(entry, true), h('div', {class: 'titles'}, h('h2', {}, title), h('div', {class: 'badges'}, ...badges)), ...actions);
  const roleBadge = role => h('span', {class: 'badge role-' + role}, icon(ROLE_ICONS[role]), h('span', {}, roleNames()[role]));
  const pageHead = (glyph, title, ...badges) => h('div', {class: 'head'}, h('span', {class: 'avatar big tile', 'aria-hidden': 'true'}, icon(glyph)), h('div', {class: 'titles'}, h('h2', {}, title), h('div', {class: 'badges'}, ...badges)));
  function drawMain() {
    flags = [];
    paintMain();
    drawWho();
    syncPicker();
  }
  function paintMain() {
    const main = $('main');
    drawBanner();
    if (model.prompting) { main.replaceChildren(pageHead('sliders', T('Prompting')), h('div', {class: 'panel wide'}, promptingPanel())); return; }
    if (model.world) { main.replaceChildren(pageHead('globe', T('World rules'), model.state.worldRules.text ? h('span', {class: 'chip edited'}, T('Edited')) : null), h('div', {class: 'panel'}, worldPanel())); return; }
    if (!model.data) { main.replaceChildren(); return; }
    const data = model.data, entry = model.state.characters.find(item => item.key === data.key) || data;
    if (data.group === 'custom') {
      const title = data.key ? (model.custom.draft.name || data.name) : T('New character');
      main.replaceChildren(headOf(entry, title, [h('span', {class: 'chip edited'}, T('Your character')), entry.voice ? h('span', {class: 'badge'}, icon('mic'), h('span', {}, T('Custom voice'))) : null]), h('div', {class: 'panel'}, customPanel()));
      return;
    }
    if (data.voiceOnly) {
      main.replaceChildren(headOf(entry, data.name, [roleBadge('v'), entry.voice ? h('span', {class: 'badge'}, icon('mic'), h('span', {}, T('Custom voice'))) : null]), h('div', {class: 'panel'}, model.voice ? voiceSection(false) : null));
      return;
    }
    const edited = FIELDS.some(field => data.edited[field]);
    const labels = {bio: T('Bio'), style: T('Speaking style'), rules: T('Speaking rules'), memories: T('Memories'), voice: T('Voice'), look: T('Look and moves')};
    const shownTabs = TABS.filter(([id]) => (id !== 'voice' || model.voice) && (id !== 'look' || model.look)).map(([id]) => id);
    const tabs = h('div', {role: 'tablist', class: 'tabs', 'aria-label': T('Parts of the character')}, shownTabs.map(id => h('button', {
      type: 'button', role: 'tab', 'data-tab': id, id: 'tab-' + id, 'aria-selected': String(model.tab === id), 'aria-controls': 'tabpanel', tabindex: model.tab === id ? '0' : '-1', class: model.tab === id ? 'on' : '',
      onclick: () => { model.tab = id; drawMain(); },
    }, icon(TAB_ICONS[id]), h('span', {}, labels[id]))));
    tabs.addEventListener('keydown', event => {
      const at = shownTabs.indexOf(model.tab), next = {ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: shownTabs.length - 1}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      model.tab = shownTabs[(next + shownTabs.length) % shownTabs.length]; drawMain(); $('tab-' + model.tab)?.focus();
    });
    main.replaceChildren(
      headOf(entry, data.name, [roleBadge(roleOf(entry)), entry.voice ? h('span', {class: 'badge'}, icon('mic'), h('span', {}, T('Custom voice'))) : null, h('span', {class: 'chip' + (edited ? ' edited' : '')}, edited ? T('Edited') : T('As shipped'))],
        h('button', {type: 'button', class: 'quiet', disabled: !edited, onclick: () => reset(FIELDS, true)}, withIcon('undo', T('Reset everything')))),
      tabs, h('div', {role: 'tabpanel', id: 'tabpanel', 'aria-labelledby': 'tab-' + model.tab, class: 'panel'}, panel(model.tab)));
    refreshButtons();
  }
  async function choose(key) {
    if (key === model.key || !leave()) return;
    try {
      const data = await api('GET', '/api/character/' + encodeURIComponent(key));
      model.key = key; model.tab = 'bio'; apply(data);
      $('main').focus({preventScroll: true});
      window.scrollTo(0, 0);
    } catch (error) { say(problem(error), true); }
  }
  const chrome = () => {
    document.title = T('Character editor');
    document.documentElement.lang = boot.language || 'en';
    $('title').textContent = T('Character editor');
    $('sub').replaceChildren(icon('info'), h('span', {}, T('Your changes work with Google Gemini, Local AI and Custom. They do not apply to Convai.')));
    $('close').replaceChildren(...withIcon('power', T('Close editor')));
    $('logo').replaceChildren(icon('users'));
    $('searchicon').replaceChildren(icon('search'));
    $('clear').replaceChildren(icon('x'));
    $('search').placeholder = T('Search characters');
    $('search').setAttribute('aria-label', T('Search characters'));
    $('picker').setAttribute('aria-label', T('Characters'));
    $('clear').setAttribute('aria-label', T('Clear search')); $('clear').title = T('Clear search');
    $('chips').setAttribute('aria-label', T('Characters'));
    $('pickerhead').replaceChildren(icon('users'), h('span', {}, T('Choose a character to start editing.')));
    $('foot').textContent = T('Changes are saved on this computer and used from the next reply.');
    for (const [id, glyph, text] of [['new', 'userPlus', T('New character')], ['world', 'globe', T('World rules')], ['prompting', 'sliders', T('Prompting')], ['close', 'power', T('Close editor')]]) {
      const node = $(id);
      node.replaceChildren(...withIcon(glyph, text)); node.title = text;
    }
    $('new').hidden = !model.state.custom;
    $('world').hidden = !model.state.worldRules;
    $('prompting').hidden = !model.state.prompting;
    drawBanner();
  };
  // The warning that Convai is answering. Not on the world rules page: Convai gets those as context, and that page says so.
  function drawBanner() {
    const banner = $('banner');
    // The Look and moves tab has its own sentence about Convai (most of its choices work with it), so the warning about the text edits is left out there.
    if (model.state.provider === 'convai' && !model.world && !(model.tab === 'look' && model.look)) { banner.hidden = false; banner.replaceChildren(icon('alert'), document.createTextNode(T('Convai is answering right now, so these changes have no effect yet. Choose Google Gemini, Local AI or Custom as the conversation provider in the settings.'))); }
    else banner.hidden = true;
  }
  window.addEventListener('beforeunload', event => { if (dirtyFields().length) { event.preventDefault(); event.returnValue = ''; } });
  // The unsaved-changes marks follow every key press, choice and click on the page (the handlers of the controls have already run when these are called).
  for (const type of ['input', 'change', 'click']) document.addEventListener(type, refreshFlags);
  $('search').addEventListener('input', event => { model.filter = event.target.value; drawList(); });
  $('clear').addEventListener('click', () => { model.filter = ''; $('search').value = ''; drawList(); $('search').focus(); });
  $('picker').addEventListener('keydown', onPickerKey);
  $('picker').addEventListener('focusout', event => { if (pickerIsPopover() && event.relatedTarget && !$('picker').contains(event.relatedTarget) && event.relatedTarget !== $('who')) closePicker(false); });
  $('scrim').addEventListener('click', () => closePicker(true));
  $('who').addEventListener('click', () => { if (pickerIsPopover()) closePicker(true); else openPicker(); });
  document.addEventListener('keydown', event => {
    const typing = event.target.matches && event.target.matches('input,textarea,select,[contenteditable]');
    if (((event.key === '/' && !typing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) && !event.altKey && model.state && $('picker')) { event.preventDefault(); openPicker(); }
  });
  $('new').addEventListener('click', newCharacter);
  $('world').addEventListener('click', openWorld);
  $('prompting').addEventListener('click', openPrompting);
  $('close').addEventListener('click', async () => {
    if (!leave()) return;
    try { await api('POST', '/api/close', {}); } catch { /* the page is closing anyway */ }
    document.body.replaceChildren(h('main', {class: 'gone', id: 'gone'}, icon('power'), h('p', {}, T('The editor is closed. You can close this tab.'))));
  });
  (async () => {
    try {
      model.state = await api('GET', '/api/state');
      strings = model.state.strings || {};
      for (const item of model.state.characters) if (item.voiceOnly) item.name = vName(item.key, item.name);
      chrome(); drawMain();
    } catch (error) {
      document.body.replaceChildren(h('main', {class: 'gone'}, h('p', {}, 'The editor could not start. Open it again from the game settings.')));
      return;
    }
    // The character V was facing when the editor was opened (the game says it by name): the picker offers it at the top. Nothing breaks when there is none.
    try {
      const {facing} = await api('GET', '/api/facing');
      const name = facing && norm(facing.name || '');
      const found = name && model.state.characters.find(item => item.group !== 'custom' && item.group !== 'v' && norm(item.name) === name);
      if (found) { model.facing = found.key; drawList(); }
    } catch { /* the page works without it */ }
  })();
}


// The look: one refined dark theme (and a light one for light systems) with a single accent, a 4-point spacing scale, a small type scale and soft elevation. No inline styles are used
// anywhere (the page policy allows this one style element only), so everything the script needs from the look is a class.
const STYLE = `
:root{color-scheme:dark light;--bar-h:56px;
--bg:#0c0e11;--surface:#14181d;--surface-2:#1a1f26;--field:#0e1115;--line:#242a33;--line-2:#303844;--hover:rgba(255,255,255,.055);
--text:#e9ecf0;--text-2:#aeb7c3;--text-3:#8893a1;
--accent:#f0d440;--accent-ink:#171407;--accent-text:#f0d440;--accent-soft:rgba(240,212,64,.11);--accent-line:rgba(240,212,64,.42);--ring:#f0d440;
--bad:#ff8a84;--bad-soft:rgba(255,138,132,.12);--good:#74dca0;
--bar-bg:rgba(12,14,17,.86);--float-bg:rgba(26,31,38,.94);--scrim:rgba(4,6,9,.55);
--warn-bg:rgba(240,212,64,.10);--warn-text:#f1e4a6;--warn-line:rgba(240,212,64,.34);
--shadow-1:0 1px 2px rgba(0,0,0,.35);--shadow-2:0 18px 44px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.4);
--r-sm:8px;--r-md:12px;--r-lg:16px;--t:140ms;--ease:cubic-bezier(.2,.7,.2,1);
--tone-0-bg:#243246;--tone-0-fg:#a4bde0;--tone-1-bg:#223a37;--tone-1-fg:#9fd6c8;--tone-2-bg:#35294a;--tone-2-fg:#c9aee6;
--tone-3-bg:#40352a;--tone-3-fg:#e0c39e;--tone-4-bg:#3d2a31;--tone-4-fg:#e3adba;--tone-5-bg:#2b3138;--tone-5-fg:#bcc4cf}
@media (prefers-color-scheme:light){:root{--bg:#f2f3f5;--surface:#fff;--surface-2:#f6f7f9;--field:#fbfbfc;--line:#e1e4e9;--line-2:#cdd2da;--hover:rgba(15,20,30,.055);
--text:#14181f;--text-2:#455062;--text-3:#5c6777;
--accent:#f0d440;--accent-ink:#171407;--accent-text:#745a00;--accent-soft:rgba(160,125,0,.11);--accent-line:rgba(130,100,0,.5);--ring:#6b5300;
--bad:#b3261e;--bad-soft:rgba(179,38,30,.09);--good:#17753c;
--bar-bg:rgba(242,243,245,.88);--float-bg:rgba(255,255,255,.96);--scrim:rgba(20,26,36,.34);
--warn-bg:#fff4c4;--warn-text:#4d3d00;--warn-line:#d8c25a;
--shadow-1:0 1px 2px rgba(20,28,40,.12);--shadow-2:0 18px 44px rgba(20,28,40,.2),0 2px 8px rgba(20,28,40,.12);
--tone-0-bg:#dce7f6;--tone-0-fg:#2c4a74;--tone-1-bg:#d6eee8;--tone-1-fg:#1d5a4d;--tone-2-bg:#e8defa;--tone-2-fg:#4d3178;
--tone-3-bg:#f3e6d2;--tone-3-fg:#6b4a1c;--tone-4-bg:#f7dfe5;--tone-4-fg:#7a2f43;--tone-5-bg:#e3e7ec;--tone-5-fg:#3d4756}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;min-height:100vh;-webkit-font-smoothing:antialiased}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.icon{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}

/* top bar */
header.top{position:sticky;top:0;z-index:30;height:var(--bar-h);display:flex;align-items:center;gap:12px;padding:0 20px;background:var(--bar-bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;flex:none}
.logo{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--accent);color:var(--accent-ink)}
.logo .icon{width:17px;height:17px}
header.top h1{font-size:15px;font-weight:650;margin:0;letter-spacing:.01em;white-space:nowrap}
.who{flex:1 1 auto;max-width:400px;min-width:0;height:38px;justify-content:flex-start;padding:0 10px 0 6px;background:var(--surface);border-color:var(--line-2);border-radius:10px;font-size:14px}
.who .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}
.who .name.dim{color:var(--text-2);font-weight:400;padding-left:4px}
.who>.sr+.icon{margin-left:6px}
.who>.icon:last-child{margin-left:auto;color:var(--text-3);transition:transform var(--t) var(--ease)}
.who[aria-expanded=true]{border-color:var(--accent-line)}
.who[aria-expanded=true]>.icon:last-child{transform:rotate(180deg)}
.tools{margin-left:auto;display:flex;gap:8px;flex:none}
.tools button.on{border-color:var(--accent-line);background:var(--accent-soft)}
.tools button[hidden]{display:none}

/* buttons */
button{font:inherit;font-size:13.5px;line-height:1;height:36px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:var(--r-sm);cursor:pointer;
border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);transition:background var(--t),border-color var(--t),color var(--t),transform 80ms,filter var(--t)}
button:hover:not(:disabled){background:var(--hover);border-color:var(--text-3)}
button:active:not(:disabled){transform:translateY(1px)}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:650}
button.primary:hover:not(:disabled){background:var(--accent);border-color:var(--accent);filter:brightness(1.08)}
button.quiet{background:transparent;border-color:transparent;color:var(--text-2)}
button.quiet:hover:not(:disabled){background:var(--hover);border-color:transparent;color:var(--text)}
button.quiet.danger:hover:not(:disabled){background:var(--bad-soft);color:var(--bad)}
button.icon-btn{width:34px;padding:0}
button:disabled{opacity:.42;cursor:not-allowed}

/* page */
.shell{width:100%;max-width:1080px;margin:0 auto;padding:20px 24px 72px;flex:1}
#sub{display:flex;gap:8px;align-items:flex-start;margin:0 0 16px;color:var(--text-2);font-size:13px}
#sub .icon{width:15px;height:15px;margin-top:2px;color:var(--text-3)}
#banner{display:flex;gap:10px;align-items:center;margin:0;padding:10px 24px;background:var(--warn-bg);color:var(--warn-text);border-bottom:1px solid var(--warn-line);font-size:13.5px}
#banner[hidden]{display:none}
main#main{outline:none}
main#main[hidden]{display:none}
footer{padding:14px 24px;color:var(--text-3);font-size:12.5px;border-top:1px solid var(--line);text-align:center}
.gone{display:grid;place-items:center;gap:12px;padding:96px 24px;text-align:center;font-size:17px;color:var(--text-2)}
.gone .icon{width:32px;height:32px;color:var(--text-3)}

/* the picker */
.scrim{position:fixed;inset:var(--bar-h) 0 0 0;z-index:35;background:var(--scrim);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}
.scrim[hidden],.picker[hidden]{display:none}
.picker{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r-lg);overflow:hidden}
.picker:not(.docked){position:fixed;z-index:40;top:calc(var(--bar-h) + 12px);left:50%;transform:translateX(-50%);width:min(780px,calc(100vw - 24px));max-height:calc(100vh - var(--bar-h) - 28px);
box-shadow:var(--shadow-2);animation:pop 150ms var(--ease)}
@keyframes pop{from{opacity:0;transform:translate(-50%,-6px)}}
.picker.docked{box-shadow:var(--shadow-1);margin:4px 0 8px}
.picker-head{display:none;align-items:center;gap:10px;margin:0;padding:22px 22px 4px;font-size:19px;font-weight:650}
.picker-head .icon{width:20px;height:20px;color:var(--accent-text)}
.picker.docked .picker-head{display:flex}
.searchbox{display:flex;align-items:center;gap:10px;padding:0 10px 0 16px;margin:12px 14px 10px;height:44px;background:var(--field);border:1px solid var(--line-2);border-radius:var(--r-md);transition:border-color var(--t),box-shadow var(--t)}
.searchbox:focus-within{border-color:var(--ring);box-shadow:0 0 0 3px var(--accent-soft)}
#searchicon{display:grid;place-items:center;color:var(--text-3)}
#searchicon .icon{width:18px;height:18px}
.searchbox input[type=search]{flex:1;min-width:0;height:100%;padding:0;border:0;border-radius:0;background:transparent;font-size:15px;color:var(--text);outline:none;box-shadow:none}
.searchbox input::-webkit-search-cancel-button{display:none}
.searchbox button{width:28px;height:28px;padding:0;flex:none}
.searchbox button[hidden]{display:none}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 12px;border-bottom:1px solid var(--line)}
.fchip{height:30px;padding:0 11px;gap:6px;font-size:12.5px;border-radius:99px;background:transparent;border-color:var(--line-2);color:var(--text-2)}
.fchip .icon{width:13px;height:13px}
.fchip .n{font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums}
.fchip.on{background:var(--accent-soft);border-color:var(--accent-line);color:var(--text)}
.fchip.on .icon{color:var(--accent-text)}
.results{overflow:auto;padding:4px 8px 10px;min-height:140px;max-height:min(56vh,540px);flex:1 1 auto;position:relative}
.picker.docked .results{max-height:min(62vh,640px)}
.sect{margin-top:4px}
h3.group{display:flex;align-items:center;gap:8px;margin:14px 8px 6px;font-size:11.5px;font-weight:650;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3)}
h3.group .icon{width:13px;height:13px}
h3.group .n{font-weight:500;letter-spacing:0}
.sect.quick h3.group .icon{color:var(--accent-text)}
.panel h3.group{margin:18px 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:2px 6px}
.pick{width:100%;min-height:44px;height:auto;padding:5px 8px;justify-content:flex-start;gap:10px;text-align:left;background:transparent;border-color:transparent;border-radius:10px;font-size:14px;color:var(--text)}
.pick .text{display:flex;flex-direction:column;gap:2px;min-width:0;line-height:1.2}
.pick .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick .sub{font-size:11.5px;color:var(--text-3)}
.sect:not(.quick) .pick .sub{display:none}
.pick.on{background:var(--accent-soft);border-color:var(--accent-line)}
.marks{margin-left:auto;display:flex;gap:6px;flex:none;color:var(--text-3)}
.mark{display:inline-flex}
.mark .icon{width:13px;height:13px}
.mark.edited{color:var(--accent-text)}
.picker-foot{display:flex;justify-content:flex-end;padding:8px 16px;border-top:1px solid var(--line);font-size:12px;color:var(--text-3);font-variant-numeric:tabular-nums}
.results .empty{margin:16px 8px}

/* avatars and badges */
.avatar{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:9px;font-size:11.5px;font-weight:650;letter-spacing:.02em;background:var(--tone-5-bg);color:var(--tone-5-fg)}
.avatar.big{width:56px;height:56px;border-radius:15px;font-size:19px}
.tone-0{background:var(--tone-0-bg);color:var(--tone-0-fg)}.tone-1{background:var(--tone-1-bg);color:var(--tone-1-fg)}.tone-2{background:var(--tone-2-bg);color:var(--tone-2-fg)}
.tone-3{background:var(--tone-3-bg);color:var(--tone-3-fg)}.tone-4{background:var(--tone-4-bg);color:var(--tone-4-fg)}.tone-5{background:var(--tone-5-bg);color:var(--tone-5-fg)}
.avatar.tile{background:var(--accent-soft);color:var(--accent-text);border:1px solid var(--accent-line)}
.avatar.big .icon{width:24px;height:24px}
.who .avatar{width:26px;height:26px;border-radius:8px;font-size:10.5px}
.head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:4px 0 18px}
.head .titles{min-width:0;flex:1 1 220px}
.head h2{margin:0;font-size:25px;line-height:1.2;font-weight:650;letter-spacing:-.005em;overflow-wrap:anywhere}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.badges:empty{display:none}
.badge,.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1;padding:5px 10px;border-radius:99px;border:1px solid var(--line-2);color:var(--text-2);background:transparent}
.badge{background:var(--surface-2)}
.badge .icon{width:12px;height:12px}
.chip.edited{border-color:var(--accent-line);color:var(--accent-text);background:var(--accent-soft)}
.head>button.quiet{margin-left:auto}

/* tabs */
.tabs{position:sticky;top:var(--bar-h);z-index:20;display:flex;gap:2px;margin:0 0 20px;overflow-x:auto;background:var(--bg);border-bottom:1px solid var(--line);scrollbar-width:thin}
.tabs button{height:44px;border-radius:0;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--text-2);padding:0 14px;white-space:nowrap;font-size:14px}
.tabs button:hover:not(:disabled){background:var(--hover);color:var(--text);border-color:transparent;border-bottom-color:var(--line-2)}
.tabs button.on{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.tabs button.on .icon{color:var(--accent-text)}
.tabs button.dirty::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);margin-left:2px}

/* forms */
.panel{max-width:860px}
.panel.wide{max-width:none}
.panel>div>.field,.panel>.field,.panel>div>div>.field{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:20px 22px;margin:0 0 16px;box-shadow:var(--shadow-1)}
.field{margin:0 0 24px}
.field .field{margin:16px 0 0}
.field label,.field h3{display:block;font-size:15px;font-weight:600;margin:0 0 2px}
.help{color:var(--text-2);margin:2px 0 10px;font-size:13px;max-width:72ch}
textarea,input[type=text],input[type=number],input[type=search],select{width:100%;background:var(--field);color:var(--text);border:1px solid var(--line-2);border-radius:var(--r-sm);padding:9px 12px;font:inherit;font-size:14.5px;transition:border-color var(--t),box-shadow var(--t)}
textarea:hover,input[type=text]:hover,input[type=number]:hover,select:hover{border-color:var(--text-3)}
textarea:focus,input[type=text]:focus,input[type=number]:focus,select:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px var(--accent-soft)}
textarea::placeholder,input::placeholder{color:var(--text-3)}
textarea{resize:vertical;line-height:1.55}
select{width:auto;min-width:240px;max-width:100%}
input[type=checkbox]{accent-color:var(--accent);width:18px;height:18px;margin:0;flex:none}
input[type=file]{width:100%;color:var(--text);font:inherit;font-size:13.5px}
input[type=file]::file-selector-button{font:inherit;font-size:13px;height:32px;padding:0 12px;margin-right:12px;border-radius:var(--r-sm);border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);cursor:pointer}
audio{display:block;width:100%;max-width:460px;margin:8px 0 10px}
.field p.status{margin:8px 0;font-weight:600}
.field .check{display:flex;align-items:center;gap:10px}
.field .check label{margin:0;font-weight:500}
label.check{display:flex;gap:10px;align-items:center;margin:6px 0 10px;cursor:pointer}
.meter{display:flex;justify-content:flex-end;margin-top:4px}
.count{font-size:12px;color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums}
.count.over{color:var(--bad);font-weight:650}
.list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center}
.row.tall{align-items:start}
.row input,.row textarea{min-width:0}
.empty{display:flex;align-items:center;gap:10px;margin:8px 0;padding:14px 16px;color:var(--text-2);border:1px dashed var(--line-2);border-radius:var(--r-md);font-size:13.5px}
.empty .icon{color:var(--text-3)}

/* the save bar */
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px}
.actions.bar{position:sticky;bottom:12px;z-index:15;margin:24px 0 0;padding:10px 12px;background:var(--float-bg);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--line-2);border-radius:var(--r-md);box-shadow:var(--shadow-2)}
.actions.bar+div{margin-top:28px}
.state{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:550;color:var(--accent-text)}
.state .icon{width:13px;height:13px}
.state:empty{display:none}

/* toast */
.note{position:fixed;z-index:60;top:calc(var(--bar-h) + 12px);right:20px;display:flex;align-items:center;gap:10px;max-width:min(460px,calc(100vw - 24px));padding:10px 8px 10px 14px;border-radius:var(--r-md);
background:var(--float-bg);border:1px solid var(--line-2);box-shadow:var(--shadow-2);opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-8px);
transition:opacity 160ms var(--ease),transform 160ms var(--ease),visibility 0s linear 160ms}
.note.show{opacity:1;visibility:visible;pointer-events:auto;transform:none;transition-delay:0s}
.note .msg{font-size:14px;line-height:1.4}
.note.good .icon{color:var(--good)}
.note.bad{border-color:var(--bad)}
.note.bad .icon{color:var(--bad)}
.note .dismiss{width:28px;height:28px;padding:0;flex:none;border-color:transparent;background:transparent;color:var(--text-3)}

/* prompting */
.profiles{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 12px}
.profiles .pick.profile{width:auto;min-height:36px;height:36px;padding:0 14px;gap:8px;border-color:var(--line-2);background:var(--surface-2);font-size:13.5px}
.profiles .pick.profile.on{border-color:var(--accent-line);background:var(--accent-soft)}
.profiles .chip{padding:3px 8px;font-size:11px}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.pcols{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
.psec{margin:0 0 16px;padding:18px 22px 20px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-1)}
.phead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:2px}
.phead h3{margin:0;font-size:16px;font-weight:600}
.phead .quiet{margin-left:auto;height:32px}
.rule{border:1px solid var(--line);border-radius:var(--r-md);padding:12px 14px;background:var(--field)}
.rulehead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.rulehead .grow{flex:1}
.rulehead button{height:30px}
.rulehead button.icon-btn{width:30px}
.rule textarea{background:var(--surface)}
.variants{margin-top:10px}
.variants summary{cursor:pointer;color:var(--text-2);font-size:13px;padding:2px 0}
.variants .sub{margin-top:8px;display:flex;flex-direction:column;gap:3px}
.variants .sub .count{align-self:flex-end}
.numrow{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.field.num{margin:0 0 14px;max-width:340px;flex:1 1 220px}
.field.num input[type=number]{width:100%}
.numrow label.check{margin-top:28px}
.errs:empty{display:none}
.err{margin:6px 0 0;color:var(--bad);font-size:13px}
[aria-invalid=true]{border-color:var(--bad)!important}
.ppreview{border:1px solid var(--line);border-radius:var(--r-md);padding:16px 18px;background:var(--surface);box-shadow:var(--shadow-1)}
.ppreview h3{margin:0 0 4px;font-size:16px}
.ppreview h4{margin:16px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3)}
.json textarea{font:13px/1.45 ui-monospace,Consolas,monospace}
.ppreview pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.45 ui-monospace,Consolas,monospace;background:var(--field);border:1px solid var(--line);border-radius:var(--r-sm);padding:10px 12px}
.ppreview .stale{color:var(--bad)}
.ppreview .field{margin:0 0 10px}
@media (min-width:1100px){.pcols{grid-template-columns:minmax(0,1fr) minmax(300px,420px)}.ppreview{position:sticky;top:calc(var(--bar-h) + 16px);max-height:calc(100vh - var(--bar-h) - 40px);overflow:auto}}

/* narrower windows */
@media (max-width:980px){.appbtn .lbl{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.tools button{width:36px;padding:0}.who{max-width:none}}
@media (max-width:640px){
header.top{padding:0 10px;gap:8px}
.brand h1{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tools{gap:4px}
.shell{padding:14px 12px 64px}
#banner{padding:10px 12px}
.picker:not(.docked){left:8px;right:8px;width:auto;transform:none;animation:none;max-height:calc(100vh - var(--bar-h) - 20px)}
.picker-head{padding:18px 16px 2px;font-size:17px}
.grid{grid-template-columns:1fr}
.head{gap:12px}
.head h2{font-size:21px}
.avatar.big{width:46px;height:46px;border-radius:13px;font-size:16px}
.panel>div>.field,.panel>.field,.psec{padding:16px 14px}
.row{grid-template-columns:minmax(0,1fr) auto}
.row .count{display:none}
.row.memory{grid-template-columns:minmax(0,1fr) auto auto}
.actions.bar{bottom:8px;margin-top:20px}
.state{margin-left:0;width:100%}
.profiles .pick.profile{width:100%;justify-content:space-between}
.rulehead .count{display:inline}
.note{left:12px;right:12px;max-width:none}
select{min-width:0;width:100%}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
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
<header class="top">
<div class="brand"><span class="logo" id="logo"></span><h1 id="title">Character editor</h1></div>
<button type="button" id="who" class="who" aria-haspopup="dialog" aria-expanded="false" aria-controls="picker"></button>
<div class="tools"><button type="button" id="new" class="primary appbtn" hidden>New character</button><button type="button" id="world" class="secondary appbtn" hidden>World rules</button><button type="button" id="prompting" class="secondary appbtn" hidden>Prompting</button><button type="button" id="close" class="quiet appbtn">Close editor</button></div>
</header>
<div id="scrim" class="scrim" hidden></div>
<p id="banner" role="status" hidden></p>
<div class="shell">
<p id="sub"></p>
<section id="picker" class="picker" role="dialog" aria-label="Characters" hidden>
<p id="pickerhead" class="picker-head"></p>
<div class="searchbox"><span id="searchicon" class="sr-icon"></span><input type="search" id="search" autocomplete="off" spellcheck="false"><button type="button" id="clear" class="quiet" hidden></button></div>
<div id="chips" class="chips" role="group"></div>
<div id="list" class="results"></div>
<div class="picker-foot"><span id="resultcount"></span></div>
</section>
<main id="main" tabindex="-1" hidden></main>
</div>
<footer id="foot"></footer>
<div id="note" class="note" role="status" aria-live="polite"></div>
<script nonce="${nonce}">window.__editor=${boot};(${editorClient.toString()})();</script>
</body>
</html>`;
}
