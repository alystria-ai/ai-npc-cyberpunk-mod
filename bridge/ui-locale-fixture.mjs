import {readFileSync} from 'node:fs';

// Existing subsystem tests keep English output while executing the real locale
// formatter/selection contract. Native detection and other dictionaries are
// covered separately; no substitute translation implementation is used here.
const source=readFileSync(new URL('../mod/ui-locale.lua',import.meta.url),'utf8');
// The notice gate (mod/notices.lua) is a plain module that publishes the convaiNotices global,
// like the game does before any notice is shown. Tests configure Developer mode through
// convaiNotices.configure or the options they hand to the module under test.
const noticesSource=readFileSync(new URL('../mod/notices.lua',import.meta.url),'utf8');
// CET module environments have no _G, so neither do these tests: code that reads
// it must fail here, not in the game.
export const uiLocaleBootstrap=`local uiLocaleFixture=(function() ${source} end)()\nlocal noticesFixture=(function() ${noticesSource} end)()\n_G = nil\n`;
