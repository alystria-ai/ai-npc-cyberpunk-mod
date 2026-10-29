// The Google Gemini conversation provider (2026-10-30, after Mistral stopped giving free API keys to new accounts and Google's free plan answered with the owner's key).
//
// It is the Custom provider's client (bridge/mistral-client.mjs, provider 'custom': an OpenAI-style chat-completions endpoint, streaming, vision as image_url parts, a 400 with
// API_KEY_INVALID read as "key not accepted") on a second, separate CustomEndpoint (bridge/custom-endpoint.mjs): its own file, `player-gemini-endpoint.txt` in the state folder, holding the
// fixed endpoint and model id of the free plan and the player's Google AI Studio key. The Custom provider keeps its own file and stays free for any other endpoint at the same time.
//   - The route is named 'gemini' (bridge/text-provider-host.mjs customRoute), so MATURE_PROVIDERS (bridge/mature-content.mjs) has no entry for it: Mature content never goes to Gemini or any cloud provider.
//   - The prompt profile is the generic one a Custom endpoint gets (bridge/prompt-profiles.mjs, chosen by endpoint and model id).
//   - The key is bound to Google's address by CustomEndpoint (it goes nowhere else), is read from the clipboard by one press of Add (CustomControl 'preset-gemini'), and Remove deletes the key and both fixed fields.
import {resolve} from 'node:path';
import {CustomEndpoint, PRESETS, parseEndpointUrl} from './custom-endpoint.mjs';

export const GEMINI_FILE = 'player-gemini-endpoint.txt';
export const GEMINI_ENDPOINT = PRESETS.gemini.endpoint;
export const GEMINI_MODEL = PRESETS.gemini.model;
/** A route that talks to an OpenAI-style endpoint of the player's choice (the Custom provider) or to Google Gemini (the same client, its own endpoint). */
export const isCustomRoute = route => route === 'custom' || route === 'gemini';

/** The Gemini provider's endpoint, read from its file. */
export const openGeminiEndpoint = (stateDirectory, log = () => {}) => new CustomEndpoint({path: resolve(stateDirectory, GEMINI_FILE), log}).load();

/**
 * The endpoint the turns use right now: Google Gemini's while the Gemini provider is the one applied, the Custom provider's otherwise. A view that follows `provider.applied`,
 * so a switch happens at the provider's idle boundary (MistralProvider.apply) and never in the middle of a conversation. Reads of a field go to the endpoint in use.
 */
export function activeEndpoint({provider, custom, gemini}) {
  const pick = () => (provider.applied === 'gemini' ? gemini : custom);
  return new Proxy({}, {
    get(_target, name) { const target = pick(), value = target[name]; return typeof value === 'function' ? value.bind(target) : value; },
    has(_target, name) { return name in pick(); },
  });
}

/**
 * One-time moves of what earlier builds saved, run when the service starts (each is idempotent and never overwrites something the player set up):
 *   - the Google Gemini preset of the Custom page (a build of 2026-10-30) becomes the Gemini provider's key, and the Custom page is cleared of it;
 *   - a saved Mistral key (player-mistral-key.txt) with nothing in the Custom provider fills the Mistral preset of the Custom page with it, so the preset row shows it and the player can switch to Custom.
 *     The Mistral provider itself is untouched: a player who chose it keeps it (the Settings page lists it only while it is the saved choice).
 * Returns the names of the moves made.
 */
export async function migrateEarlierSetups({custom, gemini, mistralKey, log = () => {}}) {
  const done = [];
  try {
    if (custom.preset === 'gemini' && custom.key && !gemini.key) {
      const key = custom.key;
      await gemini.setUrl(parseEndpointUrl(GEMINI_ENDPOINT));
      await gemini.setModel(GEMINI_MODEL);
      await gemini.setKey(key);
      await custom.clearUrl(); await custom.clearModel(); await custom.clearKey();
      done.push('gemini-preset-to-provider');
    }
    if (typeof mistralKey === 'string' && mistralKey && !custom.address && !custom.model && !custom.key) {
      await custom.setUrl(parseEndpointUrl(PRESETS.mistral.endpoint));
      await custom.setModel(PRESETS.mistral.model);
      await custom.setKey(mistralKey);
      done.push('mistral-key-to-preset');
    }
  } catch (error) { log(`earlier setups: ${error?.code ?? error?.message ?? 'failed'}`); }
  if (done.length) log(`earlier setups moved: ${done.join(', ')}`);
  return done;
}
