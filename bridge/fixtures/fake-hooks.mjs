// Module hooks used by register-fakes.mjs: only convai-bridge.mjs is redirected.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/bridge/convai-bridge.mjs')) {
    if (specifier === './realtime-host.mjs') return {url: new URL('./fake-realtime-host.mjs', import.meta.url).href, shortCircuit: true};
    if (specifier === './player-memory-api.mjs') return {url: new URL('./fake-memory-api.mjs', import.meta.url).href, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}
