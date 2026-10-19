// A local turn whose model server stopped working while the turn was being asked (docs/LOCAL_AI.md, "When the model server stops").
//
// The route hands a request the server's address and key once, when the turn starts. A llama-server that crashes after that (a graphics driver
// fault takes it down with exit 3221226505 on some cards) leaves the request with an address nobody listens on, and a restarted server has a new
// port and a new key, so asking the same address again can never work: the first live reports (2026-10-19) failed with "could not be reached
// (ECONNREFUSED)" while the supervisor was already starting the next server, which was ready two minutes later for the next turn.
//
// survivingLoss(chat, {server, log}) wraps the route's request function: after a failure that looks like a lost server (it could not be connected to, or answered with a
// server fault, and no word of the reply had been written), it asks the supervisor (LocalLlmServer.recover) whether the server is really gone,
// waits for the new one within what is left of the turn's own time, and sends the request once more to the new address. Once per request: a server
// that dies again fails the turn with the usual explanation. Nothing runs unless a request failed that way, and nothing per frame.
// Background work (no turn deadline) never waits for a server: it only runs while one is up.
import {MistralError, MIN_ATTEMPT_MS} from './mistral-client.mjs';

/** Is this failure of a local request the kind a restarted server fixes? Not a timeout, not a refused prompt, not a reply that had begun. */
export function lostServer(error) {
  return error instanceof MistralError && error.provider === 'local' && error.kind === 'network'
    && !error.noRetry && !error.partial && !error.deadline && !error.reason && !(error.trace?.pieces > 0)
    && (!Number.isInteger(error.status) || error.status >= 500);
}

/** The error of a turn that ran out of time while the server it was waiting for started again (its own explanation, not the game's silent timeout). */
function stillRestarting(waitedMs) {
  return new MistralError('network', 'is still starting again after it stopped working', {provider: 'local', slow: true, reason: 'restarting', noRetry: true,
    trace: {headersMs: null, eventMs: null, firstTokenMs: null, events: 0, pieces: 0, reasoning: 0, progress: null, timings: null, finishReason: null, elapsedMs: Math.round(waitedMs)}});
}

export function survivingLoss(chat, {server, log = () => {}} = {}) {
  if (typeof server?.recover !== 'function') return chat;
  return async function chatThroughRestart(options) {
    try { return await chat(options); } catch (error) {
      if (!lostServer(error) || options?.signal?.aborted || !Number.isFinite(options?.deadlineAt)) throw error;
      const clock = typeof options.now === 'function' ? options.now : () => performance.now();
      const began = clock();
      const room = options.deadlineAt - began - (options.minAttemptMs ?? MIN_ATTEMPT_MS);
      if (!(room > 0)) throw error;
      const bounded = AbortSignal.timeout(Math.ceil(room));
      let handle;
      try { handle = await server.recover({signal: options.signal ? AbortSignal.any([options.signal, bounded]) : bounded}); } catch (failure) {
        if (options.signal?.aborted) throw options.signal.reason ?? failure;
        if (bounded.aborted) { log('The local AI: the model server stopped working during the turn and was not ready again in time'); throw stillRestarting(clock() - began); }
        throw failure;
      }
      if (!handle) throw error;   // the server answers: the failure was something else
      log('The local AI: the model server stopped working during the turn and was started again; asking once more');
      return chat({...options, endpoint: handle.endpoint, apiKey: handle.apiKey});
    }
  };
}
