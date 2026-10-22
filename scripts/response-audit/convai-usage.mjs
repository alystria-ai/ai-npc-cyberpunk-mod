// Read-only: the Convai account's usage counters (interactions and long-term-memory end users), to show an anonymous audit run changed neither the end-user list nor LTM.
// Prints counters only, never the key.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseKeyText} from '../../bridge/convai-key.mjs';
import {mainCheckout} from './lib.mjs';
const key = parseKeyText(await readFile(resolve(mainCheckout, 'runtime/convai-key.txt'), 'utf8'));
const response = await fetch('https://api.convai.com/user/user-api-usage', {method: 'POST', headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': key}, body: '{}'});
const usage = (await response.json())?.usage ?? {};
const pick = {};
for (const [name, value] of Object.entries(usage)) if (typeof value === 'number' || /end_users|interaction/i.test(name)) pick[name] = value;
console.log(JSON.stringify({status: response.status, at: new Date().toISOString(), counters: pick, cycleStart: usage.usage_cycle?.cycle_start}));
