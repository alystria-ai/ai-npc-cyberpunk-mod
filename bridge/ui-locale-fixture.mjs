import {readFileSync} from 'node:fs';

// Existing subsystem tests keep English output while executing the real locale
// formatter/selection contract. Native detection and other dictionaries are
// covered separately; no substitute translation implementation is used here.
const source=readFileSync(new URL('../mod/ui-locale.lua',import.meta.url),'utf8');
// CET module environments have no _G, so neither do these tests: code that reads
// it must fail here, not in the game.
export const uiLocaleBootstrap=`local uiLocaleFixture=(function() ${source} end)()\n_G = nil\n`;
