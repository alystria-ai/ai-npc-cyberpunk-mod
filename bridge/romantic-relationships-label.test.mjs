// 30 Oct live test: two settings were both called "Relationships". The Companion Manager home keeps "Relationships" (the bond page), and the Settings button and its page
// that choose who speaks as a partner are "Romantic relationships", in the English source and in every language file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const OLD = 'Puts every setting on Settings, Relationships, Dynamic info and Key bindings back to its default. Press the button twice to confirm.';

test('the English source names the Settings button, its page and the restore-defaults sentence Romantic relationships, and the home page stays Relationships', () => {
  const ui = read('../mod/manager-ui.lua');
  assert(ui.includes("action('relationships', 'Romantic relationships', 'Open',"));
  assert(ui.includes("category('relationships', 'Romantic relationships', rows)"));
  assert(ui.includes("{'bonds', 'Relationships'}") && ui.includes("category('bonds', 'Relationships', rows,"));
  const mcm = read('../mod/mcm-host.lua');
  assert(mcm.includes('Settings, Romantic relationships, Dynamic info and Key bindings') && !mcm.includes(OLD));
});

test('every language file has the new name, the home page name and the new restore-defaults sentence, and none keeps the old sentence', () => {
  const files = readdirSync(new URL('../mod/locales/', import.meta.url)).filter(name => name.endsWith('.lua'));
  assert.equal(files.length, 15, 'fifteen language files beside the English source');
  for (const name of files) {
    const text = read(`../mod/locales/${name}`);
    const entry = key => { const line = text.split(String.fromCharCode(10)).find(row => row.trim().startsWith(`["${key}"] = "`)); return line?.slice(line.indexOf('] = "') + 5, line.lastIndexOf('"')); };
    const romantic = entry('Romantic relationships'), home = entry('Relationships');
    assert(romantic && romantic !== 'Romantic relationships', `${name}: translated`);
    assert(home && romantic !== home, `${name}: the two names differ`);
    assert(!text.includes(`["${OLD}"]`), `${name}: old sentence key is gone`);
    assert(text.includes(`["${OLD.replace('Settings, Relationships,', 'Settings, Romantic relationships,')}"]`), `${name}: new sentence key`);
    assert(!romantic.includes(';'), `${name}: no semicolon`);
  }
});

test('the catalogue lists the new name', () => {
  const catalogue = JSON.parse(read('../localization/en.json'));
  assert(JSON.stringify(catalogue).includes('"Romantic relationships"'));
});
