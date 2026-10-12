// The Mistral text route (docs/MISTRAL.md). The host itself is shared by every text provider (bridge/text-provider-host.mjs);
// `MistralHost` is that host with only the Mistral route, built from the options the Mistral route has always taken, and
// `attachMistral` is `attachTextProvider` under its original name.
import {TextProviderHost, mistralRoute, attachTextProvider} from './text-provider-host.mjs';
import {streamChat, DEFAULT_MODELS} from './mistral-client.mjs';
import {PersonaBook, LIMITS} from './mistral-prompt.mjs';

export class MistralHost extends TextProviderHost {
  /**
   * provider    MistralProvider (the key and the provider state)
   * memory      MistralMemory or MemoryStore
   * personas    PersonaBook
   * model       () => model id or list of ids, best first
   * transformReply   the bridge's cleanReply (Natural speech, Expressive emotions)
   * chat        the request function (streamChat; replaced in tests)
   */
  constructor({provider, memory, personas = new PersonaBook(), model = () => DEFAULT_MODELS, transformReply = result => result,
    chat = streamChat, now = () => performance.now(), log = () => {}, limits = LIMITS, endpoint, onFailure, onSuccess, gapMs = 1100,
    cacheScope = '', gate, routes = {}, resolveProfile, idleRetryMs} = {}) {
    if (!provider) throw Error('Mistral provider required');
    super({provider, memory, personas, transformReply, now, log, limits, gate, resolveProfile, idleRetryMs,
      routes: {mistral: mistralRoute({provider, model, chat, endpoint, gapMs, onFailure, onSuccess, cacheScope, now}), ...routes}});
  }
}

export const attachMistral = attachTextProvider;
export {TextProviderHost, attachTextProvider};
