// The character editor's web page (docs/CHARACTER_EDITOR.md). One HTML document with its own style and script, nothing fetched from
// anywhere else: no fonts, no images, no libraries, no analytics. The script is an ordinary function below (so it is linted and tested
// like code) that is written into the page; it builds the page with textContent only, so a bio can never inject markup.
//
// Every sentence the page shows goes through T(source, values), where the source is the English sentence. The game side (mod/character-editor.lua) translates the same
// sources with its dictionaries and hands them over when the editor is opened; a source without a translation is shown in English.

/** The browser-side program. Runs in the page, never in Node: it may use only browser globals. */
export function editorClient() {
  const boot = window.__editor;
  const api = (method, path, body) => fetch(path, {method, headers: {'X-Editor-Token': boot.token, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'})
    .then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(Error(data.error || 'error'), {status: response.status, errors: data.errors || []});
      return data;
    });
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
  const TABS = [['bio', 'Bio', ['bio']], ['style', 'Speaking style', ['style', 'examples']], ['rules', 'Speaking rules', ['rules']], ['memories', 'Memories', ['memories']]];
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const model = {state: null, key: '', data: null, draft: null, tab: 'bio', filter: '', note: null};
  let noteTimer = 0;

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
    const values = {max: first.max};
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
      default: return T('Could not save. Try again.');
    }
  };

  const dirtyFields = () => model.data ? FIELDS.filter(field => !same(model.draft[field], model.data.values[field])) : [];
  const leave = () => !dirtyFields().length || confirm(T('You have changes that are not saved. Leave without saving?'));

  const counter = (text, max) => {
    const used = count(text), node = h('span', {class: 'count' + (used > max ? ' over' : '')}, T('{count} of {max}', {count: used, max}));
    return node;
  };

  // ---- fields
  const blockField = (field, label, help, rows) => {
    const limit = model.state.limits[field], area = h('textarea', {id: 'f-' + field, rows, spellcheck: 'true', maxlength: String(limit * 3), 'aria-describedby': 'h-' + field});
    area.value = model.draft[field];
    const meter = h('div', {class: 'meter'}, counter(area.value, limit));
    area.addEventListener('input', () => {
      model.draft[field] = area.value;
      meter.replaceChildren(counter(area.value, limit));
      refreshButtons();
    });
    return h('div', {class: 'field'}, h('label', {for: 'f-' + field}, label), h('p', {class: 'help', id: 'h-' + field}, help), area, meter);
  };
  const listField = (field, label, help, addLabel, placeholder) => {
    const limit = model.state.limits[field.replace(/ies$/, 'y').replace(/s$/, '')] || 200, max = model.state.limits[field];
    const box = h('div', {class: 'list'});
    const draw = () => {
      box.replaceChildren(...model.draft[field].map((line, index) => {
        const input = h('input', {type: 'text', value: line, 'aria-label': label + ' ' + (index + 1), placeholder, maxlength: String(limit * 3)});
        const meter = h('span', {class: 'count' + (count(line) > limit ? ' over' : '')}, T('{count} of {max}', {count: count(line), max: limit}));
        input.addEventListener('input', () => {
          model.draft[field][index] = input.value;
          meter.textContent = T('{count} of {max}', {count: count(input.value), max: limit});
          meter.className = 'count' + (count(input.value) > limit ? ' over' : '');
          refreshButtons();
        });
        return h('div', {class: 'row'}, input, meter,
          h('button', {type: 'button', class: 'quiet', onclick: () => { model.draft[field].splice(index, 1); draw(); refreshButtons(); }}, T('Delete')));
      }));
      add.disabled = model.draft[field].length >= max;
    };
    const add = h('button', {type: 'button', class: 'secondary', onclick: () => {
      model.draft[field].push(''); draw(); refreshButtons();
      const inputs = box.querySelectorAll('input'); inputs[inputs.length - 1]?.focus();
    }}, addLabel);
    draw();
    return h('div', {class: 'field'}, h('h3', {}, label), h('p', {class: 'help'}, help), box, h('div', {class: 'actions'}, add));
  };

  // ---- saving and resetting
  let buttons = [];
  const refreshButtons = () => {
    const dirty = dirtyFields();
    for (const {node, fields, kind} of buttons) {
      const touched = fields.some(field => dirty.includes(field)), edited = fields.some(field => model.data.edited[field]);
      node.disabled = kind === 'save' ? !touched : !(edited || touched);
    }
    const tabDirty = new Set(TABS.filter(([, , fields]) => fields.some(field => dirty.includes(field))).map(tab => tab[0]));
    for (const tab of document.querySelectorAll('[role=tab]')) tab.classList.toggle('dirty', tabDirty.has(tab.dataset.tab));
  };
  const apply = data => {
    model.data = data; model.draft = clone(data.values);
    const row = model.state.characters.find(item => item.key === data.key);
    if (row) row.edited = FIELDS.some(field => data.edited[field]);
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
  const memoriesPanel = () => {
    const data = model.data, memory = data.memory;
    const written = [listField('memories', T('Things they always know'),
      T('Short facts you write yourself, such as a name or a promise. The character knows them in every talk.'), T('Add a memory'), T('For example: V has a sister called Lena.')),
      actions(['memories'])];
    if (!memory.available) return h('div', {}, ...written, h('p', {class: 'help'}, T('Everyday people do not keep memories of your talks.')));
    const rows = memory.records.map(record => {
      const input = h('input', {type: 'text', value: record.text, 'aria-label': T('Memory'), maxlength: String(model.state.limits.record * 3)});
      return h('div', {class: 'row'}, input,
        h('button', {type: 'button', class: 'secondary', onclick: async () => {
          try { hush(); apply(await api('PUT', '/api/character/' + encodeURIComponent(model.key) + '/memory/' + encodeURIComponent(record.id), {text: input.value})); say(T('Saved.')); }
          catch (error) { say(error.status === 422 ? T('A memory cannot be empty.') : problem(error), true); }
        }}, T('Save')),
        h('button', {type: 'button', class: 'quiet', onclick: async () => {
          if (!confirm(T('Delete this memory?'))) return;
          try { hush(); apply(await api('DELETE', '/api/character/' + encodeURIComponent(model.key) + '/memory/' + encodeURIComponent(record.id))); say(T('Deleted.')); }
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
          try { hush(); apply(await api('PUT', '/api/character/' + encodeURIComponent(model.key) + '/summary', {text: area.value})); say(T('Saved.')); }
          catch (error) { say(problem(error), true); }
        }}, T('Save')),
        h('button', {type: 'button', class: 'secondary', onclick: async () => {
          if (!confirm(T('Clear the summary?'))) return;
          try { hush(); apply(await api('PUT', '/api/character/' + encodeURIComponent(model.key) + '/summary', {text: ''})); say(T('Cleared.')); }
          catch (error) { say(problem(error), true); }
        }}, T('Clear'))));
    return h('div', {}, ...written, picked, summary);
  };

  // ---- the page
  const panel = tab => {
    buttons = [];
    if (tab === 'bio') return h('div', {}, blockField('bio', T('Bio'), T('Who this character is, what they know and how they look. A long bio makes replies slower, so keep it tight.'), 18), actions(['bio']));
    if (tab === 'style') return h('div', {}, blockField('style', T('Speaking style'), T('How they sound: pace, attitude, favourite habits of speech.'), 8),
      listField('examples', T('Example lines'), T('Lines in their voice. They show the tone only and are never said back word for word.'), T('Add a line'), T('A line this character might say')), actions(['style', 'examples']));
    if (tab === 'rules') return h('div', {}, listField('rules', T('Speaking rules'),
      T('Short rules this character always follows when talking, for example: Never swear. Answer in one sentence.'), T('Add a rule'), T('A short rule')), actions(['rules']));
    return memoriesPanel();
  };
  function drawMain() {
    const main = $('main');
    if (!model.data) { main.replaceChildren(h('p', {class: 'empty big'}, T('Choose a character on the left.'))); return; }
    const data = model.data, edited = FIELDS.some(field => data.edited[field]);
    const tabs = h('div', {role: 'tablist', class: 'tabs', 'aria-label': T('Parts of the character')}, TABS.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', 'data-tab': id, id: 'tab-' + id, 'aria-selected': String(model.tab === id), class: model.tab === id ? 'on' : '',
      onclick: () => { model.tab = id; drawMain(); },
    }, T(label))));
    main.replaceChildren(
      h('div', {class: 'head'}, h('h2', {}, data.name), h('span', {class: 'chip' + (edited ? ' edited' : '')}, edited ? T('Edited') : T('As shipped')),
        h('button', {type: 'button', class: 'quiet', disabled: !edited, onclick: () => reset(FIELDS, true)}, T('Reset everything'))),
      tabs, h('div', {role: 'tabpanel', 'aria-labelledby': 'tab-' + model.tab, class: 'panel'}, panel(model.tab)));
    refreshButtons();
  }
  function drawList() {
    const query = model.filter.trim().toLowerCase();
    const groups = [['story', T('Story characters')], ['everyday', T('Everyday people')]];
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
    $('sub').textContent = T('Your changes work with Mistral, Groq and Local. They do not apply to Convai.');
    $('close').textContent = T('Close editor');
    $('search').placeholder = T('Search characters');
    $('search').setAttribute('aria-label', T('Search characters'));
    $('foot').textContent = T('Changes are saved on this computer and used from the next reply.');
    const banner = $('banner');
    if (model.state.provider === 'convai') { banner.hidden = false; banner.textContent = T('Convai is answering right now, so these changes have no effect yet. Choose Mistral, Groq or Local as the conversation provider in the settings.'); }
    else banner.hidden = true;
  };
  window.addEventListener('beforeunload', event => { if (dirtyFields().length) { event.preventDefault(); event.returnValue = ''; } });
  $('search').addEventListener('input', event => { model.filter = event.target.value; drawList(); });
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
.field label,.field h3{display:block;font-size:16px;font-weight:600;margin:0 0 2px}
.help{color:var(--dim);margin:2px 0 8px;font-size:13.5px}
textarea,input[type=text],input[type=search]{width:100%;background:var(--field);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:9px 11px;font:inherit}
textarea{resize:vertical;line-height:1.5}
textarea:focus,input:focus,button:focus-visible{outline:2px solid var(--cyan);outline-offset:1px}
.meter{display:flex;justify-content:flex-end;margin-top:3px}
.count{font-size:12px;color:var(--dim);white-space:nowrap}
.count.over{color:var(--bad);font-weight:600}
.list{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.row{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center}
.row input{min-width:0}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.actions.bar{padding-top:16px;border-top:1px solid var(--line)}
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
<aside><input type="search" id="search" autocomplete="off"><nav id="list" aria-label="Characters"></nav></aside>
<main id="main" tabindex="-1"></main>
</div>
<footer id="foot"></footer>
<div id="note" class="note" role="status" aria-live="polite"></div>
<script nonce="${nonce}">window.__editor=${boot};(${editorClient.toString()})();</script>
</body>
</html>`;
}
