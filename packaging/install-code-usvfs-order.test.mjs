// install-code.mjs under Mod Organizer 2 (live check of 2026-10-28, Runtime and Scripts as two MO2 mods): the Runtime's REAL folder must be looked up before
// the stat fallbacks go in. With them in, stat sees a folder only a mod holds, so the "real" folder came back as the virtual one: the code was copied through the
// virtual file system (new files landed in Overwrite, which Node cannot stat) and the service ran from the virtual path, its children failing with
// "Cannot find module ...launcher/usvfs-compat.mjs".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const source = await readFile(resolve(fileURLToPath(new URL('.', import.meta.url)), 'runtime/install-code.mjs'), 'utf8');

test('main() resolves the Runtime\'s real folder before it installs the stat fallbacks', () => {
  const main = source.slice(source.indexOf('async function main()'));
  const resolved = main.indexOf('const runtimeApp = realFolder(virtualApp)');
  const installed = main.indexOf('installUsvfsCompat()');
  assert(resolved > 0, 'the real folder is resolved in main()');
  assert(installed > 0, 'the fallbacks are installed in main()');
  assert(resolved < installed, 'the real folder is resolved first');
  assert.equal(main.split('realFolder(virtualApp)').length - 1, 1, 'and only once');
});
