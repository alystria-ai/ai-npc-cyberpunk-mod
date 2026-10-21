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
// A lost graphics device (Vulkan ErrorDeviceLost, 2026-10-20: an RX 580 failed seven turns in a row) is not a dead server: llama-server stays alive and its /health answers, so the
// health check would send the old address back. Those failures go to LocalLlmServer.noteDeviceLost (restart the first time, step down a model size the second).
// Background work (no turn deadline) never waits for a server: it only runs while one is up.
import {MistralError, MIN_ATTEMPT_MS} from './mistral-client.mjs';
import {DEVICE_FAULT, INVALID_BATCH} from './local-llm-server.mjs';

/** Is this failure of a local request the kind a restarted server fixes? Not a timeout, not a refused prompt, not a reply that had begun. */
export function lostServer(error) {
  return error instanceof MistralError && error.provider === 'local' && error.kind === 'network'
    && !error.noRetry && !error.partial && !error.deadline && !error.reason && !(error.trace?.pieces > 0)
    && (!Number.isInteger(error.status) || error.status >= 500);
}

/** Does a failed request's text say the graphics device was lost (Vulkan ErrorDeviceLost) or ran out of memory (ErrorOutOfDeviceMemory, reports 5920501457 and 0f5d6496)? The server stays alive and healthy then,
 *  so only a forced restart helps (LocalLlmServer.noteDeviceLost). */
export function deviceLost(error) {
  try { return DEVICE_FAULT.test(String(error?.message ?? '') + ' ' + String(error?.providerText ?? '')); } catch { return false; }
}

/** "Invalid input batch" (report 8696ffb2): what a server answers after such a fault, HTTP 500 at once. Only the supervisor can tell it from a bad request (it counts repeats and reads the server's own log). */
export function invalidBatch(error) {
  try { return INVALID_BATCH.test(String(error?.message ?? '') + ' ' + String(error?.providerText ?? '')); } catch { return false; }
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
      // A lost graphics device: the server answers /health, so it is told (restart, or a smaller model the second time) and recover() skips its health check.
      const lost = deviceLost(error), batch = !lost && invalidBatch(error);
      const noteLoss = what => { if (lost) try { void Promise.resolve(server.noteDeviceLost?.(what)).catch(() => {}); } catch { /* the note never fails a turn */ } };
      if (!lostServer(error) || options?.signal?.aborted || !Number.isFinite(options?.deadlineAt)) { noteLoss('a reply that could not go on'); throw error; }
      const clock = typeof options.now === 'function' ? options.now : () => performance.now();
      const began = clock();
      const room = options.deadlineAt - began - (options.minAttemptMs ?? MIN_ATTEMPT_MS);
      if (!(room > 0)) { noteLoss('a turn with no time left to ask again'); throw error; }
      const bounded = AbortSignal.timeout(Math.ceil(room));
      let handle;
      try { handle = await server.recover({signal: options.signal ? AbortSignal.any([options.signal, bounded]) : bounded, deviceLost: lost, ...(batch ? {invalidBatch: true} : {})}); } catch (failure) {
        if (options.signal?.aborted) throw options.signal.reason ?? failure;
        if (bounded.aborted) { log('The local AI: the model server stopped working during the turn and was not ready again in time'); throw stillRestarting(clock() - began); }
        throw failure;
      }
      if (!handle) throw error;   // the server answers: the failure was something else
      log('The local AI: the model server stopped working during the turn and was started again; asking once more');
      try { return await chat({...options, endpoint: handle.endpoint, apiKey: handle.apiKey}); } catch (again) {
        // The device was lost again on the new server: the second loss steps the model down now, not at the next turn's failure. This turn fails with its own explanation.
        if (deviceLost(again)) { try { void Promise.resolve(server.noteDeviceLost?.('the second try of a turn')).catch(() => {}); } catch { /* best effort */ } }
        throw again;
      }
    }
  };
}
