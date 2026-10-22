// The providers the audit can reach, each through the bridge's own route object so the prompt, the clamps, the retries and the cleaning are the live ones.
//   mistral   mistralRoute + the owner's key through MistralProvider.load() (the bridge's own key loading)
//   local     the real LocalLlmServer (bridge/local-llm-server.mjs) started on the installed Local AI pack, driven by localRoute (prompt budget, compact persona)
//   custom    customRoute pointed at the same llama-server through its OpenAI-compatible endpoint (what a player running LM Studio or KoboldCpp gets)
//   convai    RealtimeHost, text only (no voice). The characters have long-term memory, so every scenario uses its own throwaway `probe-<uuid>` end user (run.mjs); the owner's real memory users are never used
// The key is read in memory only; nothing here prints it.
import {readFile, mkdir, copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {MistralProvider, parseMistralKey} from '../../bridge/mistral-key.mjs';
import {mistralRoute, localRoute, customRoute} from '../../bridge/text-provider-host.mjs';
import {mistralScheduler} from '../../bridge/mistral-rate.mjs';
import {streamChat} from '../../bridge/mistral-client.mjs';
import {mainCheckout, dataDir, project} from './lib.mjs';

const APP = process.env.AUDIT_GAME_APP || 'E:/SteamLibrary/steamapps/common/Cyberpunk 2077/red4ext/plugins/AiNpcCyberpunkMod/app';

/** Wraps a chat function so every request of a turn is recorded: the exact messages sent, the reply text, the usage counts and the time. */
export function recorder(chat = streamChat) {
  const requests = [];
  const wrapped = async options => {
    const at = Date.now(), entry = {messages: options.messages, maxTokens: options.maxTokens, temperature: options.temperature, model: options.model, startedAt: at};
    requests.push(entry);
    try {
      const result = await chat(options);
      Object.assign(entry, {ms: Date.now() - at, text: result.text, finishReason: result.finishReason, usage: result.usage ?? null, answeredBy: result.model,
        firstTokenMs: result.trace?.firstTokenMs ?? null, timings: result.trace?.timings ?? null});
      return result;
    } catch (error) { entry.ms = Date.now() - at; entry.error = String(error?.message ?? error).slice(0, 200); throw error; }
  };
  return {chat: wrapped, requests};
}

export async function mistralProvider() {
  const provider = new MistralProvider({keyPath: resolve(mainCheckout, 'runtime/player-mistral-key.txt')});
  await provider.load();
  if (!provider.key) throw Error('no Mistral key found through the bridge key loader');
  provider.applied = 'mistral';
  return {provider, routeFor: (model, chat) => ({mistral: mistralRoute({provider, model: () => [model], scheduler: mistralScheduler, cacheScope: 'response-audit', chat})}), name: 'mistral'};
}

let llama = null;
/** Starts the installed Local AI model (one at a time) and returns the server. `pin`: 'lite' (Bonsai 2 4B) or a model id. */
export async function startLocal({pin = 'lite', mature = false, log = () => {}} = {}) {
  const {detectLocalAiPack} = await import('../../bridge/local-ai-pack.mjs');
  const {LocalLlmServer} = await import('../../bridge/local-llm-server.mjs');
  const pack = detectLocalAiPack({project: APP});
  const {detectMaturePack} = await import('../../bridge/mature-pack.mjs');
  const found = detectMaturePack({project: APP});
  const matureModels = found.installed ? found.models : [];
  if (!pack.installed) throw Error(`Local AI pack not usable: missing ${pack.missing.join(', ')}`);
  await mkdir(dataDir, {recursive: true});
  llama = new LocalLlmServer({pack, warmup: false, stateFile: resolve(dataDir, 'local-ai-state.audit.json'), log,
    selection: () => ({pin, matureOn: mature, matureModels: mature || String(pin).startsWith('mature:') ? matureModels : [], customModels: []})});
  const handle = await llama.ensure();
  return {server: llama, handle, status: llama.status()};
}
export async function stopLocal() {
  if (!llama) return;
  try { await llama.stop(); } catch { /* best effort */ }
  llama = null;
}

export function localProvider(server) {
  const provider = new MistralProvider({});
  provider.key = null; provider.applied = 'local';
  return {provider, routeFor: (_model, chat) => ({local: localRoute({server, provider, chat})}), name: 'local'};
}

/** Custom provider pointed at the running llama-server (OpenAI-compatible). */
export async function customProvider(server) {
  const handle = await server.ensure();
  const origin = new URL(handle.endpoint).origin;
  const custom = {ready: true, local: true, origin, chatUrl: handle.endpoint, model: handle.requestModel ?? handle.model ?? 'local', key: handle.apiKey, extraHeaders: undefined, reasoning: undefined, noThinking: undefined};
  const provider = new MistralProvider({custom: null});
  provider.key = null; provider.applied = 'custom';
  return {provider, routeFor: (_model, chat) => ({custom: customRoute({provider, custom, chat})}), name: 'custom', describe: {origin: custom.origin, model: custom.model}};
}

/** Convai text-only host, anonymous. Returns {host, ids, key}. The key never leaves this module. */
export async function convaiSetup() {
  process.env.CYBERPUNK_CONVAI_MUTE_BROWSER = '1';
  // The prebuilt browser client lives in the main checkout's ignored runtime/; the three PCM modules are beside the bridge. They must sit in one folder (docs: executable and prebuilt asset overrides).
  const assets = resolve(dataDir, 'convai-client-assets');
  await mkdir(assets, {recursive: true});
  await copyFile(resolve(mainCheckout, 'runtime/realtime-client.js'), resolve(assets, 'realtime-client.js'));
  for (const name of ['continuous-pcm-player.mjs', 'continuous-pcm-core.mjs', 'continuous-pcm-worklet.mjs', 'local-pcm-client.mjs']) await copyFile(resolve(project, 'bridge', name), resolve(assets, name));
  process.env.CYBERPUNK_CONVAI_CLIENT_ASSETS = assets;
  const {RealtimeHost} = await import('../../bridge/realtime-host.mjs');
  const {parseKeyText} = await import('../../bridge/convai-key.mjs');
  const key = parseKeyText(await readFile(resolve(mainCheckout, 'runtime/convai-key.txt'), 'utf8'));
  if (!key) throw Error('no Convai key found');
  const ids = JSON.parse(await readFile(resolve(mainCheckout, 'runtime/characters.json'), 'utf8'));
  const twins = JSON.parse(await readFile(resolve(mainCheckout, 'runtime/multilingual-profiles.json'), 'utf8')).characters ?? {};
  const delivered = [];
  const host = new RealtimeHost({log: () => {}, onCompanionAction: message => { delivered.push(message); return true; }});
  return {host, ids, twins, key, delivered};
}
