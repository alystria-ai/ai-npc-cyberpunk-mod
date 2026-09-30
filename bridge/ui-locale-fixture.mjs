import {readFileSync} from 'node:fs';

// Existing subsystem tests keep English output while executing the real locale
// formatter/selection contract. Native detection and other dictionaries are
// covered separately; no substitute translation implementation is used here.
const source=readFileSync(new URL('../mod/ui-locale.lua',import.meta.url),'utf8');
export const uiLocaleBootstrap=`local uiLocaleFixture=(function() ${source} end)()\n`;
